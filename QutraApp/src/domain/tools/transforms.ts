/* Built-in offline tool logic (Private Lab). All pure, local, deterministic,
   and unit-tested — no network, no subprocess. Covers the encoding studio,
   JWT inspector, entropy/file-signature inspector, and regex safety. */

/* ---------- Encoding studio (tool 3 / CyberChef-style tool 1) ---------- */

export type Encoding = "base64" | "hex" | "url" | "rot13" | "binary" | "reverse";

export function encode(input: string, kind: Encoding): string {
  switch (kind) {
    case "base64":
      return btoa(unescape(encodeURIComponent(input)));
    case "hex":
      return Array.from(new TextEncoder().encode(input))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    case "url":
      return encodeURIComponent(input);
    case "rot13":
      return input.replace(/[a-z]/gi, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      });
    case "binary":
      return Array.from(new TextEncoder().encode(input))
        .map((b) => b.toString(2).padStart(8, "0"))
        .join(" ");
    case "reverse":
      return [...input].reverse().join("");
  }
}

export function decode(input: string, kind: Encoding): string {
  switch (kind) {
    case "base64":
      return decodeURIComponent(escape(atob(input.trim())));
    case "hex": {
      const clean = input.replace(/\s+/g, "");
      const bytes = clean.match(/.{1,2}/g) ?? [];
      return new TextDecoder().decode(Uint8Array.from(bytes.map((h) => parseInt(h, 16))));
    }
    case "url":
      return decodeURIComponent(input);
    case "rot13":
      return encode(input, "rot13"); // rot13 is its own inverse
    case "binary": {
      const bits = input.trim().split(/\s+/);
      return new TextDecoder().decode(Uint8Array.from(bits.map((b) => parseInt(b, 2))));
    }
    case "reverse":
      return [...input].reverse().join("");
  }
}

/* ---------- JWT inspector (tool 4) — decode only, never verifies remotely --- */

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signaturePresent: boolean;
  expiresAt: number | null;
  isExpired: boolean | null;
}

function b64urlToJson(seg: string): Record<string, unknown> {
  const pad = seg.length % 4 === 0 ? "" : "=".repeat(4 - (seg.length % 4));
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return JSON.parse(decodeURIComponent(escape(atob(b64)))) as Record<string, unknown>;
}

/** Parse a JWT locally. Throws on malformed input; never sends it anywhere. */
export function inspectJwt(token: string, now = Date.now()): JwtParts {
  const parts = token.trim().split(".");
  if (parts.length < 2) throw new Error("malformed_jwt");
  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);
  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null;
  return {
    header,
    payload,
    signaturePresent: parts.length === 3 && parts[2].length > 0,
    expiresAt: exp,
    isExpired: exp === null ? null : exp < now,
  };
}

/* ---------- Entropy + file signature (tool 8) ---------- */

/** Shannon entropy in bits/byte (0..8). High values suggest compression/encryption. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const freq = new Array(256).fill(0);
  for (const b of bytes) freq[b]++;
  let h = 0;
  for (const f of freq) {
    if (f === 0) continue;
    const p = f / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

interface Signature {
  mime: string;
  ext: string;
  magic: number[];
}
const SIGNATURES: Signature[] = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: "application/zip", ext: "zip", magic: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/gzip", ext: "gz", magic: [0x1f, 0x8b] },
  { mime: "application/x-msdownload", ext: "exe", magic: [0x4d, 0x5a] },
  { mime: "application/x-elf", ext: "elf", magic: [0x7f, 0x45, 0x4c, 0x46] },
];

export interface FileSignatureResult {
  mime: string | null;
  ext: string | null;
  extensionMismatch: boolean;
}

/** Detect a file type from magic bytes and flag an extension mismatch. */
export function detectFileSignature(
  bytes: Uint8Array,
  declaredExt?: string,
): FileSignatureResult {
  for (const sig of SIGNATURES) {
    if (sig.magic.every((b, i) => bytes[i] === b)) {
      const ext = declaredExt?.toLowerCase().replace(/^\./, "");
      const mismatch = ext !== undefined && ext !== sig.ext && !(ext === "jpeg" && sig.ext === "jpg");
      return { mime: sig.mime, ext: sig.ext, extensionMismatch: mismatch };
    }
  }
  return { mime: null, ext: null, extensionMismatch: false };
}

/* ---------- Regex laboratory (tool 6) — ReDoS heuristic + bounded test ------ */

/** Heuristic: flag nested quantifiers / overlapping alternation that can cause
 *  catastrophic backtracking. Not a proof — a warning. */
export function looksCatastrophic(pattern: string): boolean {
  // (a+)+, (a*)*, (a|a)*, (.*)* style nesting.
  return /(?:\([^)]*[+*][^)]*\)\s*[+*])|(?:\(([^)|]+)\|\1\)[+*])/.test(pattern);
}

export interface RegexTestResult {
  ok: boolean;
  matches: string[];
  warning: boolean;
  /** Why it did not compile; the UI words this in the user's language. */
  error?: "invalidPattern" | "invalidFlags";
  /** The engine's own message, English, for diagnostics only; never shown. */
  detail?: string;
}

/** Compile + run a user regex against sample text with a match cap. */
export function testRegex(pattern: string, flags: string, sample: string): RegexTestResult {
  const warning = looksCatastrophic(pattern);
  const allFlags = flags.includes("g") ? flags : flags + "g";
  try {
    new RegExp("", allFlags);
  } catch (e) {
    return { ok: false, matches: [], warning, error: "invalidFlags", detail: String((e as Error).message) };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, allFlags);
  } catch (e) {
    return { ok: false, matches: [], warning, error: "invalidPattern", detail: String((e as Error).message) };
  }
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(sample)) !== null && guard < 1000) {
    matches.push(m[0]);
    if (m.index === re.lastIndex) re.lastIndex++;
    guard++;
  }
  return { ok: true, matches, warning };
}
