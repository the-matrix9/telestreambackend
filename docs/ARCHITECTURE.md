# Architecture

```
Browser ── https://watch.example.com (Cloudflare Pages: static React app)
   │  GET  /api/play/:publicId     → { streamUrl, expiresAt, durationSeconds }
   │  GET  /api/stream/:publicId?t=<token>   (Range requests, video bytes)
   ▼
API  (apps/server → apps/api, Node + SQLite on the VPS)
   │  HMAC-signed requests (x-ts-timestamp, x-ts-signature)
   ▼
Telegram service (apps/telegram-service, Node on the same VPS)  ──MTProto──►  Telegram
```

## Public surface (what a visitor can learn)

Only two endpoints exist for visitors:

1. `GET /api/play/:publicId` returns the stream URL, its expiry and the duration. `publicId` is 96 random bits (hex), created by a database trigger on insert (`migrations/0003_public_ids.sql`). Numeric database ids are never an address.
2. `GET|HEAD /api/stream/:publicId?t=…` serves bytes. The token is `{vid, exp}` signed with `PLAYBACK_SECRET`. **Lifetime = 2 × the video's duration** (minimum 120 s; 4 h if Telegram reported no duration). Unknown ids, bad tokens and expired tokens all answer the same `403`, so ids cannot be probed.

There is no listing, search, trending, details, thumbnail or watch-history endpoint for visitors. Thumbnails exist only under `/api/admin/…` (session cookie).

## Streaming path

1. The player asks `/api/play/:id`, gets a URL and sets it as the `<video>` source.
2. The browser sends `Range` requests. The API checks the token, rate limits (900 requests/min and 6 concurrent streams per IP), then proxies a signed request to the Telegram service.
3. The service builds an RFC 9110 range response (200/206/416, ≤ `MAX_RANGE_BYTES` per response) and reads 512 KiB chunks from Telegram with **one chunk of read-ahead**, so a chunk is fetched while the previous one is sent to the viewer.
4. If Telegram invalidates the file reference mid-download (`FILE_REFERENCE_EXPIRED`), the service re-fetches the message and resumes at the same byte.
5. When the link lapses (long pause), the next range request gets `403`; the player requests a new URL and resumes at the same position.

## Database

SQLite file (`DATABASE_FILE`) via Node's built-in `node:sqlite`, wrapped by a small D1-compatible adapter (`apps/server/src/sqlite-d1.ts`). Migrations in `/migrations` are applied at start-up and recorded in `_migrations`. Metadata only: no video bytes, no Telegram session, no API hash. The encrypted Telegram session lives in the Telegram service's data volume.

## Background work

`apps/server` runs the former cron tick every minute: advance sync jobs, enqueue incremental syncs every 5 minutes, purge old rows daily.

## Why a separate Telegram service

MTProto needs a long-lived TCP connection and in-memory auth state. Only that process ever holds Telegram credentials. All GramJS code is in `apps/telegram-service/src/gramjs.ts` behind a `TelegramGateway` interface.
