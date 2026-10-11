-- Application migration v14 moves the single assistant transcript
-- (preferences.localAssistantHistory) into one document of the new
-- `conversations` collection. The TypeScript migration runner commits the
-- conversation, the retired preference and the version marker in one
-- transaction; conversations are ordinary rows in `records`, so no SQL
-- table changes.
SELECT 1;
