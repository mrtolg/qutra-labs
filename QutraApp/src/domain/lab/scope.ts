import type { AuthorizationScope, TargetKind } from "../lab";

/* ============================================================
   Authorization scope enforcement (safety-critical, pure).

   A network/web tool run is only permitted when its target is
   authorized. Local files, loopback and private-network targets
   are the easiest to authorize; a public target requires an
   explicit matching allow entry. Excluded targets always lose.
   Every decision is deterministic and unit-tested; the native
   layer must not launch a run this module blocks.
   ============================================================ */

export type NetworkLocation =
  | "loopback"
  | "private"
  | "public"
  | "local"
  | "unknown";

export interface NormalizedTarget {
  raw: string;
  normalized: string;
  kind: TargetKind;
  location: NetworkLocation;
  /** Host portion used for matching (no scheme, no port). */
  host: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function looksLikeFile(s: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(s) || // C:\ or C:/
    s.startsWith("\\\\") || // UNC
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("~") ||
    s.startsWith("file:")
  );
}

/** The machine a network path names (`\\host\share`, `//host/share`,
    `file://host/…`), or null for a path on this machine. A tool given such
    a path reaches that machine, so it is classified as that host. */
function networkPathHost(s: string): string | null {
  const m = /^(?:\\\\|\/\/|file:\/\/)([^\\/]*)/i.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase();
  // `\\?\C:\…` and `\\.\pipe\…` are this machine's device paths;
  // `file:///C:/…` names no host.
  const fileUrl = s.toLowerCase().startsWith("file:");
  if (host === "" || host === "?" || host === "." || (fileUrl && host === "localhost")) {
    return null;
  }
  return host;
}

/** Local blocks, smallest prefix first: an address or range inside one is
    loopback or private. */
const LOCAL_BLOCKS: { cidr: string; prefix: number; location: "loopback" | "private" }[] = [
  { cidr: "127.0.0.0/8", prefix: 8, location: "loopback" },
  { cidr: "10.0.0.0/8", prefix: 8, location: "private" },
  { cidr: "172.16.0.0/12", prefix: 12, location: "private" },
  { cidr: "192.168.0.0/16", prefix: 16, location: "private" },
  { cidr: "169.254.0.0/16", prefix: 16, location: "private" },
];

/** Where the addresses `base/prefix` lead: loopback or private only when the
    whole range lies inside one local block, so `10.0.0.0/0` (every IPv4
    address) is public. A single address is `/32`. */
function classifyIpv4Range(base: string, prefix: number): NetworkLocation {
  const n = ipv4ToInt(base);
  const block = LOCAL_BLOCKS.find((b) => prefix >= b.prefix && ipv4InCidr(n, b.cidr));
  return block ? block.location : "public";
}

function classifyIpv4(ip: string): NetworkLocation {
  return classifyIpv4Range(ip, 32);
}

/** A host named in a network path, classified like a target host. */
function classifyHost(host: string): NetworkLocation {
  if (host === "localhost") return "loopback";
  if (isIpv4(host)) return classifyIpv4(host);
  // Unresolved hostname → treated as public (conservative: needs scope).
  return "public";
}

function ipv4InCidr(ipInt: number, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  if (!isIpv4(base)) return false;
  const prefix = Number(prefixStr);
  if (!(prefix >= 0 && prefix <= 32)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

/** Extract the host from a URL/host[:port]/target string. */
function extractHost(s: string): string {
  let host = s;
  const scheme = host.indexOf("://");
  if (scheme >= 0) host = host.slice(scheme + 3);
  // strip path/query
  host = host.split(/[/?#]/)[0];
  // strip userinfo
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  // strip port (but keep IPv6 brackets intact)
  if (!host.startsWith("[")) host = host.split(":")[0];
  return host;
}

/** Normalize and classify a raw target string. Never throws. */
export function normalizeTarget(raw: string): NormalizedTarget {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (looksLikeFile(trimmed)) {
    const remote = networkPathHost(trimmed);
    if (remote !== null) {
      return { raw, normalized: trimmed, kind: "file", location: classifyHost(remote), host: remote };
    }
    return { raw, normalized: trimmed, kind: "file", location: "local", host: "" };
  }

  // CIDR
  if (/\/\d{1,2}$/.test(lower) && isIpv4(lower.split("/")[0])) {
    const [base, prefixText] = lower.split("/");
    const prefix = Number(prefixText);
    if (prefix > 32) {
      return { raw, normalized: lower, kind: "unknown", location: "unknown", host: base };
    }
    return { raw, normalized: lower, kind: "cidr", location: classifyIpv4Range(base, prefix), host: base };
  }

  const isUrl = lower.includes("://");
  const host = extractHost(lower);

  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return { raw, normalized: lower, kind: isUrl ? "url" : "hostname", location: "loopback", host };
  }

  if (isIpv4(host)) {
    return { raw, normalized: lower, kind: isUrl ? "url" : "ip", location: classifyIpv4(host), host };
  }

  if (host) {
    // Unresolved hostname → treated as public (conservative: needs scope).
    return { raw, normalized: lower, kind: isUrl ? "url" : "hostname", location: "public", host };
  }

  return { raw, normalized: lower, kind: "unknown", location: "unknown", host };
}

/** Does a normalized target match one allow/exclude pattern? */
export function targetMatchesPattern(t: NormalizedTarget, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (t.normalized === p) return true;

  // CIDR pattern vs an IP target
  if (/\/\d{1,2}$/.test(p) && (t.kind === "ip" || t.kind === "url") && isIpv4(t.host)) {
    return ipv4InCidr(ipv4ToInt(t.host), p);
  }

  // Wildcard domain: *.example.com
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return t.host.endsWith(suffix) && t.host !== suffix.slice(1);
  }

  // Bare domain matches itself and any subdomain (example.com → app.example.com)
  const patternHost = extractHost(p);
  if (patternHost && (t.host === patternHost || t.host.endsWith(`.${patternHost}`))) {
    return true;
  }

  return false;
}

export type ScopeDecisionReason =
  | "allowed_local"
  | "allowed_in_scope"
  | "excluded"
  | "out_of_scope"
  | "scope_expired"
  | "outside_window"
  | "no_acknowledgment"
  | "no_scope";

export interface ScopeDecision {
  allowed: boolean;
  reason: ScopeDecisionReason;
  target: NormalizedTarget;
  scopeRevision?: number;
}

/**
 * Decide whether a target may be launched under a scope. Order:
 *   1. exclusion always blocks;
 *   2. scope must be acknowledged, unexpired and within its window;
 *   3. explicit allow match permits (even public);
 *   4. loopback/private/file are permitted without an explicit entry;
 *   5. everything else (notably public) is out of scope.
 */
export function evaluateTarget(
  raw: string,
  scope: AuthorizationScope | undefined,
  now: number = Date.now(),
): ScopeDecision {
  const target = normalizeTarget(raw);

  if (!scope) {
    // Without a scope, only inherently-local targets may run.
    if (target.location === "loopback" || target.location === "private" || target.location === "local") {
      return { allowed: true, reason: "allowed_local", target };
    }
    return { allowed: false, reason: "no_scope", target };
  }

  if (scope.excludedTargets.some((p) => targetMatchesPattern(target, p))) {
    return { allowed: false, reason: "excluded", target, scopeRevision: scope.revision };
  }
  const closed = scopeClosedReason(scope, now);
  if (closed) {
    return { allowed: false, reason: closed, target, scopeRevision: scope.revision };
  }

  // Local targets (loopback/private/file) are the easiest to authorize and are
  // permitted once exclusion/expiry/window pass — an engagement-wide
  // acknowledgment is only required before reaching out to non-local targets.
  if (target.location === "loopback" || target.location === "private" || target.location === "local") {
    return { allowed: true, reason: "allowed_local", target, scopeRevision: scope.revision };
  }

  if (!scope.testerAck) {
    return { allowed: false, reason: "no_acknowledgment", target, scopeRevision: scope.revision };
  }

  if (scope.allowedTargets.some((p) => targetMatchesPattern(target, p))) {
    return { allowed: true, reason: "allowed_in_scope", target, scopeRevision: scope.revision };
  }

  return { allowed: false, reason: "out_of_scope", target, scopeRevision: scope.revision };
}

/** Why a scope admits no target at `now`, or null while it is open. */
function scopeClosedReason(
  scope: AuthorizationScope,
  now: number,
): "scope_expired" | "outside_window" | null {
  if (scope.expiresAt !== undefined && now > scope.expiresAt) return "scope_expired";
  if (
    (scope.windowStart !== undefined && now < scope.windowStart) ||
    (scope.windowEnd !== undefined && now > scope.windowEnd)
  ) {
    return "outside_window";
  }
  return null;
}

/* ---------- What a scope reaches (for the scope strip) ---------- */

export type ScopeReach =
  /** Nothing: there is no scope (the tool panel refuses before asking
      evaluateTarget), or it has expired or is outside its window. */
  | { kind: "none"; reason: "no_scope" | "scope_expired" | "outside_window" }
  /** Local and private addresses only; `unconfirmed` are the listed targets
      that wait for the tester's acknowledgment. */
  | { kind: "local"; unconfirmed: string[] }
  /** The listed targets, plus local and private addresses. */
  | { kind: "listed"; allowed: string[] };

/**
 * What tools that need a scope may reach under it now, by evaluateTarget's
 * own rules, so the scope strip never claims more or less than the gate
 * does. Exclusions only narrow it and are left out.
 */
export function scopeReach(
  scope: AuthorizationScope | undefined,
  now: number = Date.now(),
): ScopeReach {
  if (!scope) return { kind: "none", reason: "no_scope" };
  const closed = scopeClosedReason(scope, now);
  if (closed) return { kind: "none", reason: closed };
  if (!scope.testerAck) return { kind: "local", unconfirmed: scope.allowedTargets };
  if (scope.allowedTargets.length === 0) return { kind: "local", unconfirmed: [] };
  return { kind: "listed", allowed: scope.allowedTargets };
}

/* ---------- Engagement-level scope status (for the Lab header) ---------- */

export type ScopeStatus =
  | "not_configured"
  | "acknowledgement_required"
  | "validated"
  | "target_out_of_scope";

export interface EngagementScopeStatus {
  status: ScopeStatus;
  /** How many recorded targets currently evaluate out of scope. */
  outOfScopeCount: number;
}

function isScopeConfigured(scope: AuthorizationScope | undefined): scope is AuthorizationScope {
  return (
    !!scope &&
    (scope.testerAck ||
      scope.allowedTargets.length > 0 ||
      scope.excludedTargets.length > 0 ||
      scope.authorizationRef.trim().length > 0)
  );
}

/**
 * Summarize the authorization posture of an engagement from its scope and the
 * targets recorded against it. Drives the persistent Lab context header and
 * gates whether tools may run.
 */
export function engagementScopeStatus(
  scope: AuthorizationScope | undefined,
  targets: { raw: string }[],
  now: number = Date.now(),
): EngagementScopeStatus {
  if (!isScopeConfigured(scope)) {
    return { status: "not_configured", outOfScopeCount: 0 };
  }
  const decisions = targets.map((t) => evaluateTarget(t.raw, scope, now));
  if (decisions.some((d) => d.reason === "no_acknowledgment")) {
    return { status: "acknowledgement_required", outOfScopeCount: 0 };
  }
  const outOfScopeCount = decisions.filter((d) => !d.allowed).length;
  if (outOfScopeCount > 0) {
    return { status: "target_out_of_scope", outOfScopeCount };
  }
  if (!scope.testerAck && targets.length === 0) {
    return { status: "acknowledgement_required", outOfScopeCount: 0 };
  }
  return { status: "validated", outOfScopeCount: 0 };
}
