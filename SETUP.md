# Backend setup (VPS)

Order: **1) Backend (ye zip) → 2) Frontend (Cloudflare Pages, doosra zip) → 3) Admin login.**

## 0. Kya chahiye

- Ek VPS (Ubuntu 22.04+ / Debian 12), 1 vCPU / 1 GB chalega. **Bandwidth main cost hai**: har played byte VPS se guzarta hai (4K ≈ 5-10 MB/s per viewer).
- Ek domain/subdomain jo VPS ke IP par point kare, jaise `api.example.com` (A record). **Cloudflare proxy (orange cloud) OFF rakho, "DNS only" (grey cloud)**: video traffic proxy karna Cloudflare free plan ki terms ke khilaf ja sakta hai, aur client IP galat aayega.
- Frontend ke liye domain jaise `watch.example.com` (Cloudflare Pages). **Dono ek hi parent domain (`example.com`) ke neeche rakho**: admin login cookie tabhi sabse safe chalti hai.
- Telegram ka `api_id` / `api_hash`: https://my.telegram.org → API development tools → app banao.
- Ek Telegram account jo channel ka member ho (admin rights zaroori nahi).

## 1. Secrets banao

Linux/Mac/Windows, kahin bhi (Node installed ho):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # SESSION_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # TG_SERVICE_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # PLAYBACK_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # PASSWORD_PEPPER
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"   # SETUP_TOKEN
```

## 2. VPS par deploy (Docker, recommended)

```bash
# Docker install (agar nahi hai):  curl -fsSL https://get.docker.com | sh
unzip telestream-backend.zip && cd telestream-backend
cp .env.example .env
nano .env            # har value bharo (API_DOMAIN, API_PUBLIC_URL, APP_ORIGIN, TG_*, secrets)
docker compose up -d --build
docker compose logs -f api telegram-service
```

- Firewall me **80 aur 443** kholo (Caddy HTTPS certificate apne aap leta hai). Telegram service bahar publish nahi hoti.
- Test: `https://api.example.com/api/health` → `{"ok":true,...}`.
- `.env` me `APP_ORIGIN` bilkul frontend ka origin hona chahiye (`https://watch.example.com`, end me `/` nahi). Frontend abhi deploy na hua ho tab bhi pehle se likh do.
- Pehli baar `npm install` se `package-lock.json` banta hai; Docker build ke andar ye hota hai. Agar reproducible builds chahiye to repo me lockfile commit karo.

### Docker ke bina (systemd)

Node 22.13+ install karo, repo `/opt/telestream` me rakho, `npm install --omit=dev`, phir `deploy/telestream-tg.service` aur `deploy/telestream-api.service` ko `/etc/systemd/system/` me copy karo. Env files `/etc/telestream/tg.env` aur `/etc/telestream/api.env` me (mode 600) rakho (variables ke naam `apps/*/.env.example` me hain, API ke liye `TRUST_PROXY=true`, `HOST=127.0.0.1`, `DATABASE_FILE=/var/lib/telestream/telestream.db`). HTTPS ke liye `deploy/Caddyfile.host`.

## 3. Frontend deploy karo

Doosre zip ka `SETUP.md` follow karo (Cloudflare Pages). Wahan `VITE_API_BASE=https://api.example.com` dena hai.

## 4. Pehla run

1. `https://watch.example.com/admin` kholo → `SETUP_TOKEN` se admin user banao (password 12+ chars).
2. **Telegram** tab: phone number → login code → (agar hai to) 2-step password.
3. Channel daalo (`@username` ya `-100…` id) → permission box tick karke import confirm karo.
4. **Videos** tab me har video par **Copy link** dabao: `https://watch.example.com/v/<unique id>`. Ye link kisi ko bhi do: sirf video play hoga.
5. Setup ke baad `.env` se `SETUP_TOKEN` hata do aur `docker compose up -d` dobara chalao.

## 5. Update / backup

```bash
git pull   # ya naya zip extract karo
docker compose up -d --build        # migrations apne aap apply hote hain
```

Backup (SQLite DB + Telegram session alag volumes me hain):

```bash
docker run --rm -v telestream_api-data:/d -v "$PWD":/b alpine tar czf /b/api-data.tgz -C /d .
docker run --rm -v telestream_tg-data:/d  -v "$PWD":/b alpine tar czf /b/tg-data.tgz  -C /d .
```
`SESSION_ENCRYPTION_KEY` ko session file se alag, safe jagah rakho.

## 6. Local me chalana (Windows / Linux)

Node 22.13+ chahiye.

```bash
npm install
copy apps\telegram-service\.env.example apps\telegram-service\.env      # Linux: cp
copy apps\server\.env.example apps\server\.env
# dono .env bharo. TG_SERVICE_SECRET dono me SAME hona chahiye.
npm run dev:tg      # terminal 1  (port 8788)
npm run dev:api     # terminal 2  (port 8787)
```
Phir frontend folder me `npm install && npm run dev` (port 5173). Frontend `/api` ko apne aap `127.0.0.1:8787` par bhejta hai, `.env` me `APP_ORIGIN=http://localhost:5173` hi rakho.

Tests: `npm test` · Typecheck: `npm run typecheck`.

## Zaroori baatein

- **Download roka nahi ja sakta, sirf mushkil kiya gaya hai** (docs/LIMITATIONS.md). Link time-limited hai, Save-As/embedding/hot-linking blocked hai, lekin jab tak link valid hai tab tak koi tool video bytes utha sakta hai.
- Sirf wahi channel index karo jiska content tumhara hai ya jiski permission hai. Telegram ki Terms of Service tumhari zimmedari hai.
