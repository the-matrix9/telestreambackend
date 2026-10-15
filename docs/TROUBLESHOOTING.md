# Troubleshooting

| Symptom | Fix |
|---|---|
| Video sirf "loading" dikhata hai; logs me `Cannot cast Document to any kind of InputFileLocation` | Purane build ka bug (GramJS ko bare `Document` diya ja raha tha). Is version me fix hai: update karke restart karo. |
| Player me "Playback stopped" | `docker compose logs api telegram-service` dekho. `telegram_service_unreachable` = service down; `not_connected` = admin → Telegram me dobara login. |
| `/api/stream` `403 playback_only` | Request kisi doosri site/embed se ya address bar se aayi. Frontend ka origin `APP_ORIGIN` me hona chahiye (preview deployments ke liye comma se aur origins add karo). |
| `403 invalid_playback_token` | Link expire ho gaya ya galat id. Page reload karo; player normally khud naya link leta hai. |
| `/admin` login: "Untrusted origin" | `APP_ORIGIN` browser ke origin se bilkul match kare (https, host, port, no trailing `/`). |
| Admin login ho jata hai par turant logout | Frontend aur API alag *site* par hain: ek parent domain use karo, ya `COOKIE_SAMESITE=none` (HTTPS zaroori). |
| Admin me thumbnails nahi aate | Upar wali cookie wali wajah. Thumbnails admin cookie se load hote hain. |
| Sab users ka rate limit ek saath lag raha | `TRUST_PROXY=true` hona chahiye (Docker compose me hai) aur API ko proxy ke peeche hona chahiye. |
| `Invalid server configuration` | `.env` ke naam wale fields dekho; error me list aati hai. |
| `Invalid telegram-service configuration: TG_API_ID...` | `.env` me abhi placeholder values hain. |
| Seeking slow | Har seek Telegram se naya download hai (~0.5-2 s). MP4 ko `+faststart` ke saath re-mux karo. |
| 4K stutter | Viewer ka internet / VPS bandwidth / codec (HEVC). `MAX_CONCURRENT_STREAMS` kam rakho. |
| Telegram login: `FLOOD_WAIT` | Telegram ki real wait hai; jaldi retry karne se badhti hai. |
