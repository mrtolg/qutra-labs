/* Private Tools Host — subprocess supervision policy (pure).
   This is the security boundary for external tools: a reviewed executable
   allowlist, fixed subcommands, validated argument ARRAYS (never shell
   strings), target-scope checks, and redaction. The actual spawn happens in a
   separate narrow native boundary that enforces these same rules; this module
   is the single source of truth and is exhaustively unit-tested.
   See docs/decisions/0007-private-lab.md. */

export interface ToolManifest {
  id: string;
  /** Reviewed executable base name (resolved against an allowlist natively). */
  executable: string;
  /** Fixed set of permitted subcommands. */
  subcommands: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  /** True if this tool may touch the network (needs an authorized target). */
  network: boolean;
}

/** Reviewed executables the host may ever launch. Anything else is refused. */
export const ALLOWED_EXECUTABLES = new Set([
  "nmap",
  "tshark",
  "dig",
  "semgrep",
  "gitleaks",
  "trivy",
  "nikto",
  "nuclei",
  "yara",
  "vol", // volatility
  "zeek",
  "suricata",
]);

// Shell metacharacters that must never appear in an argument (defence in depth
// even though we always pass an argv array, never a shell string).
const SHELL_META = /[;&|`$><\n\r(){}]|\$\(|&&|\|\|/;

export interface InvocationSpec {
  executable: string;
  args: string[];
}

export type InvocationResult =
  | { ok: true; spec: InvocationSpec }
  | { ok: false; reason: string };

/** Reject path traversal and absolute escapes in a file argument. */
export function isSafeRelativePath(p: string): boolean {
  if (p.includes("\0")) return false;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return false; // absolute (win or posix)
  const parts = p.split(/[\\/]+/);
  let depth = 0;
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth--;
      if (depth < 0) return false; // escapes the base
    } else depth++;
  }
  return true;
}

/**
 * A network target is in scope only when it is loopback or a private/lab range,
 * OR the caller has recorded explicit authorization for a public target.
 */
export function isAuthorizedTarget(host: string, explicitConsent = false): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".test")) return true;
  return explicitConsent;
}

export interface InvocationRequest {
  subcommand: string;
  args: string[];
  target?: string;
  explicitConsent?: boolean;
}

/**
 * Validate a requested invocation against its manifest. Returns a concrete
 * argv spec or an honest refusal reason. Never builds a shell string.
 */
export function validateInvocation(
  manifest: ToolManifest,
  req: InvocationRequest,
): InvocationResult {
  if (!ALLOWED_EXECUTABLES.has(manifest.executable)) {
    return { ok: false, reason: "executable_not_allowlisted" };
  }
  if (!manifest.subcommands.includes(req.subcommand)) {
    return { ok: false, reason: "subcommand_not_permitted" };
  }
  for (const arg of req.args) {
    if (typeof arg !== "string" || arg.length > 2048) {
      return { ok: false, reason: "invalid_argument" };
    }
    if (SHELL_META.test(arg)) {
      return { ok: false, reason: "argument_rejected_metacharacter" };
    }
    // A file-ish argument must not traverse out of the working area.
    if ((arg.includes("/") || arg.includes("\\")) && !isSafeRelativePath(arg)) {
      return { ok: false, reason: "path_traversal_rejected" };
    }
  }
  if (manifest.network) {
    if (!req.target) return { ok: false, reason: "target_required" };
    if (!isAuthorizedTarget(req.target, req.explicitConsent)) {
      return { ok: false, reason: "target_not_authorized" };
    }
  }
  return { ok: true, spec: { executable: manifest.executable, args: [req.subcommand, ...req.args] } };
}

/* ---------- Redaction (audit log + results) ---------- */

/** Strip tokens, emails and user home paths from any tool output/audit line. */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/([Cc]:\\Users\\|\/home\/|\/Users\/)[^\\/\s]+/g, "$1[REDACTED_USER]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED_HASH]");
}

export interface AuditEntry {
  id: string;
  at: number;
  toolId: string;
  action: string;
  scope: string;
  classification: "observed" | "inferred" | "imported" | "simulated";
  detail: string;
}

/** Build a redacted audit entry. Detail is always passed through redaction. */
export function buildAuditEntry(
  e: Omit<AuditEntry, "detail"> & { detail: string },
): AuditEntry {
  return { ...e, detail: redactSensitive(e.detail) };
}
