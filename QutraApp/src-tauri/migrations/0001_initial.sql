-- ContextOS desktop storage (SQLite, Tauri SQL plugin).
--
-- Architecture (ADR 0002): a validated document store. Every record is a
-- zod-validated JSON document in `records`, keyed by (collection, id).
-- Preferences and schema metadata live in `kv`. Notes get an FTS5 mirror
-- maintained by triggers over the JSON payload. Multi-row workflows are
-- flushed inside transactions by the frontend write queue.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,             -- zod-validated JSON document
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(collection, updated_at);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Full-text search over note documents.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body);

CREATE TRIGGER IF NOT EXISTS records_notes_ai
AFTER INSERT ON records WHEN new.collection = 'notes'
BEGIN
  INSERT INTO notes_fts(id, title, body)
  VALUES (
    new.id,
    json_extract(new.data, '$.title'),
    json_extract(new.data, '$.body')
  );
END;

CREATE TRIGGER IF NOT EXISTS records_notes_ad
AFTER DELETE ON records WHEN old.collection = 'notes'
BEGIN
  DELETE FROM notes_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS records_notes_au
AFTER UPDATE ON records WHEN new.collection = 'notes'
BEGIN
  DELETE FROM notes_fts WHERE id = old.id;
  INSERT INTO notes_fts(id, title, body)
  VALUES (
    new.id,
    json_extract(new.data, '$.title'),
    json_extract(new.data, '$.body')
  );
END;
