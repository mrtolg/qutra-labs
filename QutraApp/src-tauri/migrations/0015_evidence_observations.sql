-- Application migration v15 lets evidence point at an observation of a
-- built-in analysis (a new kind and optional fields). Evidence rows are
-- ordinary rows in `records` and none is rewritten, so no SQL table changes;
-- the version only keeps the two runners in step.
SELECT 1;
