-- Lockstep marker with app migration v3 (Context Object Graph).
-- The typed relationship graph is stored as the `links` collection in the
-- generic `records(collection, id, data)` table, so no structural change is
-- required. This marker keeps the native migration version aligned with the
-- application schema version.
UPDATE kv SET value = value WHERE key = 'meta';
