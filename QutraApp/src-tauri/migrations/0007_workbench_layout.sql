-- Lockstep marker with app migration v7 (workbench shell layout preferences).
-- The workbench mode, per-mode last route and panel sizes are additive fields
-- on the Preferences JSON blob stored in `kv`, upgraded transparently by the
-- zod defaults on read. No structural change is required. This marker keeps the
-- native migration version aligned with the application schema version.
UPDATE kv SET value = value WHERE key = 'meta';
