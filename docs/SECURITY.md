# Security

## Secrets

| Secret | Where | Notes |
|---|---|---|
| `TG_API_ID` / `TG_API_HASH` | Telegram service env | Never logged or returned by any endpoint. |
| `SESSION_ENCRYPTION_KEY` | Telegram service env | Keep it apart from the session file. |
| Telegram session | `tg-data` volume, AES-256-GCM, mode 0600 | The database only stores the label `vault:default`. |
| `TG_SERVICE_SECRET` | API + Telegram service | HMAC key for API → service calls. The service is not published to the internet. |
| `PLAYBACK_SECRET` | API | Signs stream links. Rotating it makes open players fetch a new link automatically. |
| `PASSWORD_PEPPER` | API | Mixed into admin password hashes. Losing it locks admins out. |
| `SETUP_TOKEN` | API | Only for creating the first admin; remove it afterwards. |

Logs redact any field whose name matches `secret|token|password|code|hash|session|authorization|cookie|phone|key`.

## Admin

- PBKDF2-HMAC-SHA256 (100k iterations) + pepper; server-side sessions (only the SHA-256 of the cookie token is stored); CSRF header + trusted `Origin` on unsafe methods; DB-backed login rate limits.
- Cookie: `__Host-ts_admin; HttpOnly; Secure; SameSite=Strict` over HTTPS. This needs the frontend and API on the **same site** (e.g. `watch.example.com` and `api.example.com`). If the frontend runs on `*.pages.dev`, set `COOKIE_SAMESITE=none` (still `Secure`, `HttpOnly`; CSRF protection relies on the token and Origin check).

## Stream links

- Signed, bound to one video, expire after 2× its duration. `Cache-Control: private, no-store`, `Content-Disposition: inline`.
- Rejected when the request is a top-level navigation or embed (`Sec-Fetch-Dest: document|iframe|embed|object`) or when a `Referer` from an origin outside `APP_ORIGIN` is present.
- The API resolves the real client IP once in `apps/server` (`TRUST_PROXY` / `TRUST_CLOUDFLARE`), so rate limits and the 6-streams-per-IP cap cannot be bypassed with spoofed headers.

## Rotation / revocation

- **Sign out everywhere**: Admin header.
- **Disconnect Telegram**: Telegram tab → Disconnect (also logs the session out at Telegram and deletes the vault file).
- **Rotate `SESSION_ENCRYPTION_KEY`**:
  ```bash
  SESSION_ENCRYPTION_KEY=<old> SESSION_ENCRYPTION_KEY_NEW=$(openssl rand -base64 32) \
    npm run rotate-key -w @telestream/telegram-service
  ```
  then set the new value and restart.
- **Rotate `TG_SERVICE_SECRET`**: change on both sides together.
- **Rotate `PASSWORD_PEPPER`**: invalidates all admin passwords; clear `admin_users` and run setup again.

Treat the VPS as sensitive: anyone with its disk and environment has the Telegram session.
