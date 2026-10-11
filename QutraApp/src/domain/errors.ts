/* Error Atlas domain logic: fingerprinting + similarity. */

/** Normalize an error message into a stable fingerprint. */
export function fingerprintError(text: string): string {
  const normalized = text
    .toLowerCase()
    // strip file paths
    .replace(/[a-z]:\\[^\s:)]+/g, "<path>")
    .replace(/\/[\w./-]+/g, "<path>")
    // strip line/column numbers
    .replace(/:\d+(:\d+)?/g, ":<n>")
    .replace(/line \d+/g, "line <n>")
    // strip hex + long numbers + uuids
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b\d{4,}\b/g, "<num>")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return `fp_${Math.abs(hash).toString(36)}`;
}

/** Token-set similarity in [0,1] for "similar errors" suggestions. */
export function errorSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9ğüşöçı ]+/gi, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  ta.forEach((tok) => {
    if (tb.has(tok)) overlap++;
  });
  return overlap / Math.max(ta.size, tb.size);
}
