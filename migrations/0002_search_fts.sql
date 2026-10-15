-- Full-text search over title, description and tags (SQLite FTS5, supported by D1).
-- External-content table: the index stores no copy of the text, triggers keep it in sync.

CREATE VIRTUAL TABLE videos_fts USING fts5(
  title, description, tags,
  content='videos', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER videos_ai AFTER INSERT ON videos BEGIN
  INSERT INTO videos_fts(rowid, title, description, tags) VALUES (new.id, new.title, new.description, new.tags);
END;

CREATE TRIGGER videos_ad AFTER DELETE ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, title, description, tags) VALUES ('delete', old.id, old.title, old.description, old.tags);
END;

CREATE TRIGGER videos_au AFTER UPDATE OF title, description, tags ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, title, description, tags) VALUES ('delete', old.id, old.title, old.description, old.tags);
  INSERT INTO videos_fts(rowid, title, description, tags) VALUES (new.id, new.title, new.description, new.tags);
END;
