import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/runtime";
import type { Observation } from "@/lib/analysis";

/* The app's own built-in tools: their work happens in Rust
   (src-tauri/src/builtin_tools/). The page names a request id, the target the
   user typed and that target's scope decision; files are picked in a dialog
   Rust opens, so nothing here names a path. Every command rejects with a
   short code the panels word (see builtinErrorKey). */

export interface MetadataReport {
  name: string;
  bytes: number;
  modifiedMs: number | null;
  kind: string;
  sha256: string;
  observations: Observation[];
  tags: string[];
  fields: { source: "pdf" | "office" | "odf" | "xmp"; key: string; value: string }[];
  flags: { key: string; count: number }[];
  gps: { lat: number; lon: number } | null;
  limited: boolean;
}

export interface Connection {
  protocol: "tcp" | "udp";
  family: 4 | 6;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  pid: number;
  process: string;
}

export interface ConnectionSnapshot {
  connections: Connection[];
  takenAt: number;
  supported: boolean;
}

export interface RdapEntity {
  handle: string;
  roles: string[];
  name: string;
  kind: string;
  emails: string[];
  country: string;
}

export interface RdapReport {
  kind: "ip" | "domain" | "autnum";
  query: string;
  servers: string[];
  handle: string;
  name: string;
  status: string[];
  events: { action: string; date: string }[];
  entities: RdapEntity[];
  range: string;
  cidrs: string[];
  networkType: string;
  country: string;
  parent: string;
  asnRange: string;
  nameservers: string[];
  dnssec: boolean | null;
  port43: string;
  remarks: string[];
}

export interface CertInfo {
  subject: string;
  subjectCn: string;
  issuer: string;
  issuerCn: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  notBeforeMs: number;
  notAfterMs: number;
  san: string[];
  signature: string;
  key: string;
  keyBits: number;
  isCa: boolean;
  selfSigned: boolean;
  sha256: string;
  unreadable: boolean;
}

export interface TlsReport {
  host: string;
  port: number;
  address: string;
  protocol: string;
  cipher: string;
  alpn: string | null;
  trusted: boolean;
  trustError: string | null;
  nameMatches: boolean;
  protocols: { version: string; supported: boolean; cipher: string | null }[];
  chain: CertInfo[];
  daysLeft: number | null;
  warnings: string[];
  checkedAt: number;
}

export type CheckLevel = "pass" | "warn" | "fail" | "info";

export interface HttpCheck {
  id: string;
  level: CheckLevel;
  value: string | null;
  notes: string[];
}

export interface HttpCookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  domain: string | null;
  path: string | null;
  persistent: boolean;
  issues: string[];
}

export interface HttpReport {
  requested: string;
  finalUrl: string;
  status: number;
  hops: { url: string; status: number; location: string | null }[];
  /** A redirect not followed: where it pointed and why. */
  stopped: [string, "otherHost" | "tooMany" | "badLocation"] | null;
  headers: [string, string][];
  checks: HttpCheck[];
  cookies: HttpCookie[];
  cspDirectives: [string, string][];
  counts: Record<CheckLevel, number>;
  checkedAt: number;
}

export interface Package {
  ecosystem: string;
  name: string;
  version: string;
}

export interface PickedManifests {
  token: string;
  files: { name: string; format: string; packages: number; skipped: number; error: string | null }[];
  packages: Package[];
  ecosystems: Record<string, number>;
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: string;
  cvss: string | null;
  score: number | null;
  published: string;
  fixed: Record<string, string[]>;
  url: string;
}

export interface OsvReport {
  checked: number;
  findings: { package: Package; ids: string[] }[];
  advisories: Advisory[];
  advisoriesCut: boolean;
  checkedAt: number;
}

/** The scope decision a network tool sends with its target; Rust checks it
    again (`check_scope`). `scopeId` is empty when no investigation's scope
    applies and the target is local. */
export interface ScopeAttestation {
  scopeId: string;
  scopeRevision: number;
  target: string;
  allowed: boolean;
  reason: string;
  decidedAt: number;
  expiresAt?: number;
}

type FixtureValue = unknown | { error: string } | ((args: Record<string, unknown>) => unknown);

declare global {
  interface Window {
    /** Dev builds only: canned answers for the browser e2e harness, which has
        no Rust side. Never read in a production build. */
    __QUTRA_BUILTIN_FIXTURES__?: Record<string, FixtureValue>;
  }
}

function fixtures(): Record<string, FixtureValue> | undefined {
  if (!import.meta.env.DEV || typeof window === "undefined") return undefined;
  return window.__QUTRA_BUILTIN_FIXTURES__;
}

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauriRuntime()) return invoke<T>(command, args);
  const canned = fixtures();
  if (canned && command in canned) {
    const value = canned[command];
    const answer = typeof value === "function" ? await (value as (a: Record<string, unknown>) => unknown)(args) : value;
    if (answer && typeof answer === "object" && "error" in answer) {
      throw (answer as { error: string }).error;
    }
    return answer as T;
  }
  throw "desktop_only";
}

let counter = 0;

/** A request id the page can cancel by. */
export function newRequestId(tool: string): string {
  counter += 1;
  return `${tool}-${Date.now().toString(36)}-${counter}`;
}

export const builtinTools = {
  /** The desktop app runs them; the browser build only shows the forms. */
  available: (): boolean => isTauriRuntime() || fixtures() !== undefined,
  metadataPick: (title: string) => call<MetadataReport | null>("builtin_metadata_pick", { title }),
  connections: () => call<ConnectionSnapshot>("builtin_connections"),
  rdap: (requestId: string, target: string, scope: ScopeAttestation) =>
    call<RdapReport>("builtin_rdap", { requestId, target, scope }),
  tls: (requestId: string, target: string, scope: ScopeAttestation) =>
    call<TlsReport>("builtin_tls", { requestId, target, scope }),
  http: (requestId: string, target: string, scope: ScopeAttestation) =>
    call<HttpReport>("builtin_http", { requestId, target, scope }),
  depsPick: (title: string) => call<PickedManifests | null>("builtin_deps_pick", { title }),
  depsCheck: (requestId: string, token: string) =>
    call<OsvReport>("builtin_deps_check", { requestId, token }),
  cancel: (requestId: string) => call<boolean>("builtin_cancel", { requestId }).catch(() => false),
};

/** The codes Rust rejects with, each with its own sentence. */
const KNOWN_ERRORS = new Set([
  "desktop_only",
  "consent_required",
  "cancelled",
  "timeout",
  "target_empty",
  "target_invalid",
  "target_credentials",
  "scope_blocked",
  "scope_required",
  "scope_stale",
  "scope_expired",
  "scope_target_mismatch",
  "scope_invalid",
  "dns_failed",
  "connect_failed",
  "tls_untrusted",
  "tls_incompatible",
  "tls_handshake_failed",
  "tls_closed",
  "tls_not_tls",
  "not_found",
  "rate_limited",
  "server_error",
  "bad_answer",
  "answer_too_large",
  "rdap_bad_redirect",
  "rdap_too_many_redirects",
  "request_busy",
  "manifests_gone",
  "no_packages",
  "read_failed",
  "file_dialog_failed",
]);

/** The catalog key that words a rejection; unknown codes get a general one. */
export function builtinErrorKey(error: unknown): string {
  const code = typeof error === "string" ? error : "";
  // Private Lab's own guard uses its own code.
  const normal = code === "private_tools_consent_required" ? "consent_required" : code;
  return KNOWN_ERRORS.has(normal) ? `builtin.error.${normal}` : "builtin.error.unknown";
}
