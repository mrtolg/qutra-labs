-- Lockstep marker with app migration v8.
-- Evidence and finding documents live in the generic records table. The
-- application migration normalizes their JSON relationship fields after the
-- SQLite adapter loads them, so no SQL table change is required here.
UPDATE kv SET value = value WHERE key = 'meta';
