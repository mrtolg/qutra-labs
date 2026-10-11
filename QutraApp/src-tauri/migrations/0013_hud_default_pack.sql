-- Application migration v13 remaps stored appearance packId "contextos"
-- to "hud" so existing profiles pick up the new default console. The
-- TypeScript migration runner performs the document rewrite; Catppuccin
-- and high-contrast choices are left alone. No SQL table changes.
SELECT 1;
