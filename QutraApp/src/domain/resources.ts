/**
 * Windows paths are case-insensitive and accept both slash styles. Keep the
 * original value for display, but compare a canonical identity.
 */
export function windowsPathIdentity(path: string): string {
  const normalized = path.trim().replace(/\//g, "\\");
  const withoutTrailingSeparators = /^[a-z]:\\$/i.test(normalized)
    ? normalized
    : normalized.replace(/\\+$/, "");
  return withoutTrailingSeparators.toLocaleLowerCase("en-US");
}
