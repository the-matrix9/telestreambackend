# TeleStream backend

Telegram channel ke videos ko browser me **sirf play** karne ke liye backend. Ye VPS par chalta hai.

```
Browser (Cloudflare Pages)  ──►  API (VPS, Node + SQLite)  ──►  Telegram service (VPS, MTProto)  ──►  Telegram
      /v/<unique id>              time-limited stream URL            video bytes stream hote hain
```

- **Public side par kuch nahi dikhta**: na title, na description, na thumbnail, na list/search. Har video ka ek random unique id (24 hex chars) hota hai: `https://watch.example.com/v/9f3a1c07b2d84e5a60c1d3f2`.
- **Download button / link nahi**. Stream URL sirf **video ki length ka 2 guna** time valid rehta hai (90 min ka video → 3 ghante), phir player apne aap naya URL le leta hai.
- **4K tak**: file jis quality me Telegram par hai wahi stream hoti hai (koi re-encode nahi).
- Admin panel (`/admin`, frontend ke saath aata hai) se Telegram connect, channel import, aur har video ka player link copy.

**Setup ke liye `SETUP.md` padho.** Frontend alag zip me hai (`telestream-frontend`).

| Folder | Kaam |
|---|---|
| `apps/server` | VPS par API ka Node host (SQLite DB, background sync, HTTP server) |
| `apps/api` | API ka code (Hono): `/api/play/:id`, `/api/stream/:id`, admin routes |
| `apps/telegram-service` | Telegram login + video bytes download/stream (GramJS) |
| `packages/shared` | Shared types, signing, range parsing |
| `migrations` | Database schema (apne aap apply hota hai) |
| `deploy` | Dockerfile, Caddy, systemd files |
| `tests` | Integration tests (`npm test`) |

Docs: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/LIMITATIONS.md`, `docs/TROUBLESHOOTING.md`.
