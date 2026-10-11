import type { MessageKey } from "./en";
import type { Locale } from "./locales";

/**
 * Qutra Labs product termbase.
 *
 * Only concepts that still exist in the simplified product belong here.
 * `termbase.test.ts` enforces approved translations and protected brand names.
 */
export const TERMBASE_VERSION = 2;

export interface TermEntry {
  concept: string;
  definition: string;
  context: string;
  approved: Partial<Record<Locale, string>>;
  keys?: MessageKey[];
}

export const DO_NOT_TRANSLATE: string[] = [
  "Qutra Labs",
  "GitHub",
  "JWT",
  "Regex",
  "Nmap",
  "CVE",
  "CWE",
  "CVSS",
  "SARIF",
  "MITRE ATT&CK",
];

export const DISALLOWED_TR: string[] = [
  "Parçacık Kasası",
  "İçgörüler",
  "Yeni parçacık",
  // Spec 2026-10-07 D2: an engagement is an "inceleme".
  "güvenlik çalışması",
  "Güvenlik çalışması",
  "Güvenlik Çalışmaları",
];

export const TERMBASE: TermEntry[] = [
  {
    concept: "Home",
    definition: "The operations home surface.",
    context: "Primary navigation and home route.",
    approved: { tr: "Ana Sayfa" },
    keys: ["nav.overview"],
  },
  {
    concept: "Project",
    definition: "A project and context container (internal id: workspace). One name, never \"çalışma alanı\".",
    context: "Primary navigation, plural.",
    approved: { tr: "Projeler" },
    keys: ["nav.workspaces"],
  },
  {
    concept: "Investigation",
    definition:
      "The main object: the targets, files, runs, evidence and findings of one inquiry (internal id: engagement). Spec 2026-10-07 D2.",
    context: "Primary navigation, plural; the noun everywhere else.",
    approved: { tr: "İncelemeler" },
    keys: ["topbar.lab", "nav.securityLab"],
  },
  {
    concept: "Session",
    definition: "A focused working session.",
    context: "Primary navigation, plural.",
    approved: { tr: "Oturumlar" },
    keys: ["nav.sessions"],
  },
  {
    concept: "Task",
    definition: "A unit of work.",
    context: "Primary navigation, plural.",
    approved: { tr: "Görevler" },
    keys: ["nav.tasks"],
  },
];
