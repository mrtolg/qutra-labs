-- Lockstep marker with app migration v2 (carriedOverCount on tasks).
-- In the document store the zod boundary backfills the default when a
-- pre-v2 task document is parsed; no structural change is required.
UPDATE kv SET value = value WHERE key = 'meta';
