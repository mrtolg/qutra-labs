/* The Settings sections, in page order. Kept out of SettingsPage so the
   command palette can list every section without loading the lazy page. */
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "languageRegion",
  "shortcuts",
  "capture",
  "privacy",
  "permissions",
  "ai",
  "storage",
  "importExport",
  "notifications",
  "advanced",
  "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
