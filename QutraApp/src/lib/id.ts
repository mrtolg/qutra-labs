/** Stable, sortable-enough unique IDs without an external dependency. */
export function createId(prefix = ""): string {
  const time = Date.now().toString(36);
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}
