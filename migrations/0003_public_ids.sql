-- Opaque public ids: the player link is /v/<public_id>, never a sequential number.
-- 12 random bytes (96 bits) as 24 hex chars; unguessable and meaningless.
ALTER TABLE videos ADD COLUMN public_id TEXT;
UPDATE videos SET public_id = lower(hex(randomblob(12))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX idx_videos_public_id ON videos(public_id);

-- Every future insert (sync) gets one automatically; no application code has to remember to.
CREATE TRIGGER trg_videos_public_id AFTER INSERT ON videos WHEN NEW.public_id IS NULL
BEGIN
  UPDATE videos SET public_id = lower(hex(randomblob(12))) WHERE id = NEW.id;
END;
