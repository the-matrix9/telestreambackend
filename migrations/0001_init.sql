-- TeleStream core schema (Cloudflare D1 / SQLite)
-- Timestamps are unix seconds (INTEGER). No video bytes and no Telegram secrets live here.

CREATE TABLE admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                       -- pbkdf2$<iterations>$<salt>$<hash>
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER
);

-- Server-side admin sessions. Only a SHA-256 of the cookie token is stored.
CREATE TABLE admin_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

CREATE TABLE telegram_accounts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_label               TEXT NOT NULL,
  -- Opaque pointer to the AES-256-GCM encrypted session held by telegram-service
  -- (e.g. "vault:default"). The session string and encryption key are NEVER stored in D1.
  encrypted_session_reference TEXT,
  status                      TEXT NOT NULL DEFAULT 'disconnected'
                              CHECK (status IN ('disconnected','awaiting_code','awaiting_password','connected','error')),
  created_at                  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE channels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_channel_id TEXT NOT NULL UNIQUE,
  telegram_account_id INTEGER REFERENCES telegram_accounts(id) ON DELETE SET NULL,
  title               TEXT,
  username            TEXT,
  sync_status         TEXT NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle','pending','syncing','error')),
  import_confirmed    INTEGER NOT NULL DEFAULT 0,
  last_synced_at      INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE videos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id           INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  telegram_message_id  INTEGER NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  tags                 TEXT NOT NULL DEFAULT '',     -- space separated, lower-case, from #hashtags
  duration_seconds     INTEGER NOT NULL DEFAULT 0,
  file_size_bytes      INTEGER NOT NULL DEFAULT 0,
  mime_type            TEXT NOT NULL DEFAULT 'video/mp4',
  width                INTEGER,
  height               INTEGER,
  thumbnail_reference  TEXT,                         -- 'tg' when a Telegram thumbnail exists, else NULL
  published_at         INTEGER NOT NULL,
  indexed_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  availability_status  TEXT NOT NULL DEFAULT 'available'
                       CHECK (availability_status IN ('available','unavailable','deleted','unsupported')),
  UNIQUE (channel_id, telegram_message_id)
);
CREATE INDEX idx_videos_listing   ON videos(availability_status, published_at DESC, id DESC);
CREATE INDEX idx_videos_channel   ON videos(channel_id, published_at DESC, id DESC);
CREATE INDEX idx_videos_duration  ON videos(duration_seconds);

CREATE TABLE sync_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  job_type         TEXT NOT NULL CHECK (job_type IN ('initial','incremental','resync','verify','reindex')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  cursor           TEXT,                      -- history: lowest message id processed; verify: last video id checked
  floor_message_id INTEGER NOT NULL DEFAULT 0,-- incremental: stop once message ids <= this
  target_video_id  INTEGER,                   -- reindex: single video
  processed_count  INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at       INTEGER,
  heartbeat_at     INTEGER,
  completed_at     INTEGER
);
CREATE INDEX idx_sync_jobs_status  ON sync_jobs(status, id);
CREATE INDEX idx_sync_jobs_channel ON sync_jobs(channel_id, id DESC);

CREATE TABLE watch_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id       TEXT NOT NULL,
  video_id         INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (visitor_id, video_id)
);
CREATE INDEX idx_watch_visitor ON watch_history(visitor_id, updated_at DESC);
CREATE INDEX idx_watch_video   ON watch_history(video_id, updated_at DESC);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  ip         TEXT,
  metadata   TEXT,                             -- JSON, already redacted
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- Fixed-window counters used for sensitive limits (admin login).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

INSERT INTO app_settings (key, value) VALUES ('watch_history_enabled', 'true');
