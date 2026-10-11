import type { ExclusionRule } from "./types";

/* ============================================================
   Privacy engine: conservative local secret detection,
   clipboard classification, exclusion matching, retention.
   Detection is deliberately conservative and documented as
   imperfect in the UI.
   ============================================================ */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // API secret keys (OpenAI-style)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM keys
  // \b fails on non-ASCII letters (ş), so anchor on start/whitespace instead
  /(?:^|[\s"'({[])(password|passwd|pwd|parola|şifre)\s*[:=]\s*\S+/i,
  /\b(secret|token|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-/+]{12,}/i,
];

export function looksLikeSecret(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  // Long single-token high-entropy strings
  if (
    /^[A-Za-z0-9+/_=-]{32,}$/.test(trimmed) &&
    !/^[a-z]+$/i.test(trimmed) &&
    !/^\d+$/.test(trimmed)
  ) {
    const unique = new Set(trimmed).size;
    if (unique > 14) return true;
  }
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function matchesExclusion(
  value: string,
  rules: ExclusionRule[],
): ExclusionRule | undefined {
  const lower = value.toLowerCase();
  return rules.find((rule) => {
    const v = rule.value.toLowerCase();
    switch (rule.kind) {
      case "app":
      case "domain":
        return lower.includes(v);
      case "path":
        return lower.startsWith(v) || lower.includes(v);
      case "pattern":
        try {
          return new RegExp(rule.value, "i").test(value);
        } catch {
          return false;
        }
      default:
        return false;
    }
  });
}

/** Redact obvious secrets and user paths for diagnostics export. */
export function redactForDiagnostics(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[REDACTED]");
  }
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "C:\\Users\\[user]");
  return out;
}
