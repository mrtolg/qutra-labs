-- Lockstep marker with app migration v4 (Knowledge Pages).
-- Pages (block-editor documents) are stored as the `pages` collection in the
-- generic `records(collection, id, data)` table, so no structural change is
-- required. This marker keeps the native migration version aligned with the
-- application schema version.
UPDATE kv SET value = value WHERE key = 'meta';
