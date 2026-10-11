-- Application migration v12 archives retired module records (notes, pages,
-- clipboard, inbox, errors, snippets, links, savedViews) into the kv key
-- `retired_scope_archive_v12` via the TypeScript migration runner, then
-- deletes those collection rows from `records` and the archive-related
-- preference fields. No SQL table is dropped here; the document store
-- remains the source of truth and SqliteAdapter.persistRemove clears both
-- `records` and `kv` for a given key so orphans cannot reappear on boot.
SELECT 1;
