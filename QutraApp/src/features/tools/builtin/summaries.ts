import type { BuiltinKey, BuiltinTranslate } from "./i18n";
import type {
  Connection,
  HttpReport,
  MetadataReport,
  OsvReport,
  RdapReport,
  TlsReport,
} from "@/lib/builtinTools";
import type { KeyRecord } from "./KeyboardTool";

/* A built-in tool's result as plain text: what Copy puts on the clipboard
   and what Save keeps as evidence in an investigation. Pure, so the text is
   tested once for every place it goes. Words come from the catalogs; values
   (names, headers, versions) stay as the tool read them. */

export type Translate = BuiltinTranslate;

const own = <T,>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** A word from the catalog when there is one, else the code as it came. */
export function wordOr(t: Translate, prefix: string, code: string, known: readonly string[]): string {
  return known.includes(code) ? t(`${prefix}.${code}` as BuiltinKey) : code;
}

export const RDAP_ROLES = ["registrant", "technical", "administrative", "abuse", "registrar", "billing", "sponsor", "noc"] as const;
export const RDAP_EVENTS = ["registration", "last_changed", "expiration", "transfer", "reregistration", "last_update_of_rdap_database"] as const;
export const TLS_TRUST = ["expired", "not_yet_valid", "unknown_issuer", "name_mismatch", "bad_signature", "revoked", "bad_encoding", "invalid_purpose", "untrusted"] as const;
export const TLS_WARNINGS = ["name_mismatch", "expired", "expires_soon", "self_signed", "sha1_signature", "weak_key", "no_tls13"] as const;
export const HTTP_CHECKS = ["https", "hsts", "csp", "frame", "nosniff", "referrer", "permissions", "coop", "coep", "corp", "cors", "cache", "server"] as const;
export const HTTP_NOTES = [
  "missing", "plainHttp", "noMaxAge", "disabled", "shortMaxAge", "includeSubDomains", "preload",
  "reportOnly", "noScriptSrc", "unsafeInline", "unsafeEval", "wideSources", "noObjectSrc", "noBaseUri",
  "noFrameAncestors", "anyAncestor", "byCsp", "oddValue", "leaky", "missingDefault", "notShared",
  "reflectsOrigin", "withCredentials", "anyOrigin", "nullOrigin", "oneOrigin", "noStore",
  "publicWithCookies", "cacheable", "missingWithCookies", "silent", "versionDisclosed", "productNamed",
] as const;
export const COOKIE_ISSUES = ["noSecure", "noHttpOnly", "noSameSite", "sameSiteNoneInsecure", "badHostPrefix", "badSecurePrefix"] as const;
export const META_FLAGS = [
  "javascript", "js", "openAction", "autoAction", "launch", "embeddedFile", "uri", "submitForm",
  "acroForm", "xfa", "richMedia", "encrypt", "objStm", "macros", "externalLinks",
] as const;
export const CONN_STATES = ["listen", "established", "time_wait", "close_wait", "syn_sent", "syn_received", "fin_wait1", "fin_wait2", "closing", "last_ack", "closed", "bound"] as const;
export const SEVERITIES = ["critical", "high", "moderate", "medium", "low"] as const;

export const eventSlug = (action: string) => action.trim().toLowerCase().replace(/\s+/g, "_");

/** The document fields people ask about first, by their own names. */
export const FIELD_LABELS: Record<string, BuiltinKey> = {
  Title: "builtin.meta.field.title",
  "dc:title": "builtin.meta.field.title",
  Author: "builtin.meta.field.author",
  "dc:creator": "builtin.meta.field.author",
  "meta:initial-creator": "builtin.meta.field.author",
  Subject: "builtin.meta.field.subject",
  "dc:subject": "builtin.meta.field.subject",
  Keywords: "builtin.meta.field.keywords",
  "cp:keywords": "builtin.meta.field.keywords",
  "pdf:Keywords": "builtin.meta.field.keywords",
  Creator: "builtin.meta.field.creatorTool",
  "xmp:CreatorTool": "builtin.meta.field.creatorTool",
  "meta:generator": "builtin.meta.field.creatorTool",
  Application: "builtin.meta.field.creatorTool",
  Producer: "builtin.meta.field.producer",
  "pdf:Producer": "builtin.meta.field.producer",
  CreationDate: "builtin.meta.field.created",
  "xmp:CreateDate": "builtin.meta.field.created",
  "dcterms:created": "builtin.meta.field.created",
  "meta:creation-date": "builtin.meta.field.created",
  ModDate: "builtin.meta.field.modified",
  "xmp:ModifyDate": "builtin.meta.field.modified",
  "dcterms:modified": "builtin.meta.field.modified",
  "dc:date": "builtin.meta.field.modified",
  "cp:lastModifiedBy": "builtin.meta.field.lastModifiedBy",
  Company: "builtin.meta.field.company",
  Manager: "builtin.meta.field.manager",
  "cp:revision": "builtin.meta.field.revision",
  TotalTime: "builtin.meta.field.editingTime",
  Template: "builtin.meta.field.template",
  Version: "builtin.meta.field.version",
};

export function fieldLabel(t: Translate, key: string): string {
  const label = own(FIELD_LABELS, key);
  return label ? t(label) : key;
}

const line = (label: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "" : `${label}: ${value}\n`;

export function keyEventsText(events: readonly KeyRecord[]): string {
  return [...events]
    .reverse()
    .map((e) => `${e.at}ms ${e.type} key=${JSON.stringify(e.key)} code=${e.code} location=${e.location}${e.repeat ? " repeat" : ""}${e.modifiers.length ? ` [${e.modifiers.join("+")}]` : ""}`)
    .join("\n");
}

export function metadataText(t: Translate, report: MetadataReport, observationLine: (o: MetadataReport["observations"][number]) => string): string {
  let out = `${t("tools.item.metadata.name")} · ${report.name}\n`;
  out += line("SHA-256", report.sha256);
  out += line(t("builtin.meta.size"), report.bytes);
  for (const o of report.observations) out += `${observationLine(o)}\n`;
  if (report.gps) out += line(t("builtin.meta.gps"), `${report.gps.lat.toFixed(6)}, ${report.gps.lon.toFixed(6)}`);
  for (const f of report.fields) out += line(`${f.source.toUpperCase()} ${fieldLabel(t, f.key)} (${f.key})`, f.value);
  for (const f of report.flags) out += line(wordOr(t, "builtin.meta.flag", f.key, META_FLAGS), f.count);
  if (report.tags.length) out += `\n${t("builtin.meta.tags")}:\n${report.tags.map((tag) => `  ${tag}`).join("\n")}\n`;
  if (report.limited) out += `${t("builtin.meta.limited")}\n`;
  return out.trimEnd();
}

export function connectionsText(rows: readonly Connection[]): string {
  return rows
    .map((c) => {
      const local = `${c.family === 6 ? `[${c.localAddress}]` : c.localAddress}:${c.localPort}`;
      const remote = c.remoteAddress ? ` -> ${c.family === 6 ? `[${c.remoteAddress}]` : c.remoteAddress}:${c.remotePort}` : "";
      return `${c.protocol.toUpperCase()} ${local}${remote} ${c.state} pid=${c.pid} ${c.process}`.trimEnd();
    })
    .join("\n");
}

export function rdapText(t: Translate, report: RdapReport): string {
  let out = `RDAP · ${report.query}\n`;
  out += line(t("builtin.rdap.servedBy"), report.servers.join(" -> "));
  out += line(t("builtin.rdap.handle"), report.handle);
  out += line(t("builtin.rdap.name"), report.name);
  out += line(t("builtin.rdap.range"), report.range);
  out += line("CIDR", report.cidrs.join(", "));
  out += line(t("builtin.rdap.asnRange"), report.asnRange);
  out += line(t("builtin.rdap.type"), report.networkType);
  out += line(t("builtin.rdap.country"), report.country);
  out += line(t("builtin.rdap.status"), report.status.join(", "));
  out += line(t("builtin.rdap.nameservers"), report.nameservers.join(", "));
  if (report.dnssec !== null) out += line("DNSSEC", report.dnssec ? t("builtin.yes") : t("builtin.no"));
  for (const e of report.events) out += line(wordOr(t, "builtin.rdap.event", eventSlug(e.action), RDAP_EVENTS), e.date);
  for (const e of report.entities) {
    const roles = e.roles.map((r) => wordOr(t, "builtin.rdap.role", r, RDAP_ROLES)).join(", ");
    out += `${roles}: ${[e.name, e.handle, e.emails.join(", "), e.country].filter(Boolean).join(" · ")}\n`;
  }
  return out.trimEnd();
}

export function tlsText(t: Translate, report: TlsReport): string {
  let out = `TLS · ${report.host}:${report.port} (${report.address})\n`;
  out += line(t("builtin.tls.protocol"), report.protocol);
  out += line(t("builtin.tls.cipher"), report.cipher);
  out += line("ALPN", report.alpn);
  out += line(
    t("builtin.tls.trust"),
    report.trusted ? t("builtin.tls.trust.ok") : wordOr(t, "builtin.tls.trust", report.trustError ?? "untrusted", TLS_TRUST),
  );
  out += line(t("builtin.tls.daysLeft"), report.daysLeft);
  for (const p of report.protocols) {
    out += line(p.version, p.supported ? `${t("builtin.tls.supported")}${p.cipher ? ` · ${p.cipher}` : ""}` : t("builtin.tls.notSupported"));
  }
  for (const w of report.warnings.filter((w) => !w.startsWith("untrusted:"))) {
    out += `! ${wordOr(t, "builtin.tls.warn", w, TLS_WARNINGS)}\n`;
  }
  report.chain.forEach((cert, i) => {
    out += `\n#${i + 1} ${cert.subject}\n`;
    out += line(`  ${t("builtin.tls.issuer")}`, cert.issuer);
    out += line(`  ${t("builtin.tls.validity")}`, `${cert.notBefore} -> ${cert.notAfter}`);
    out += line("  SAN", cert.san.join(", "));
    out += line(`  ${t("builtin.tls.key")}`, `${cert.key}${cert.keyBits ? ` ${cert.keyBits}` : ""} · ${cert.signature}`);
    out += line("  SHA-256", cert.sha256);
  });
  return out.trimEnd();
}

export function httpText(t: Translate, report: HttpReport): string {
  let out = `HTTP · ${report.finalUrl} (${report.status})\n`;
  if (report.hops.length > 1) out += line(t("builtin.http.redirects"), report.hops.map((h) => `${h.status} ${h.url}`).join(" -> "));
  if (report.stopped) out += line(t("builtin.http.stopped"), report.stopped[0]);
  for (const c of report.checks) {
    const notes = c.notes.map((n) => wordOr(t, "builtin.http.note", n, HTTP_NOTES)).join(" ");
    out += `[${t(`builtin.level.${c.level}` as BuiltinKey)}] ${wordOr(t, "builtin.http.check", c.id, HTTP_CHECKS)}${c.value ? ` = ${c.value}` : ""}${notes ? ` — ${notes}` : ""}\n`;
  }
  for (const cookie of report.cookies) {
    const issues = cookie.issues.map((i) => wordOr(t, "builtin.http.cookie", i, COOKIE_ISSUES)).join(", ");
    out += `${t("builtin.http.cookieLabel")} ${cookie.name}${issues ? `: ${issues}` : ""}\n`;
  }
  return out.trimEnd();
}

export function osvText(t: Translate, report: OsvReport): string {
  const byId = new Map(report.advisories.map((a) => [a.id, a]));
  let out = `OSV · ${t("builtin.deps.checkedCount", { count: report.checked })}\n`;
  for (const f of report.findings) {
    out += `\n${f.package.ecosystem} ${f.package.name}@${f.package.version}\n`;
    for (const id of f.ids) {
      const a = byId.get(id);
      const sev = a?.severity ? ` [${wordOr(t, "builtin.deps.sev", a.severity, SEVERITIES)}]` : "";
      const cves = a?.aliases.filter((x) => x.startsWith("CVE-")).join(", ");
      const fixed = a?.fixed[f.package.name]?.join(", ");
      out += `  ${id}${sev}${cves ? ` (${cves})` : ""}${a?.summary ? ` ${a.summary}` : ""}${fixed ? ` — ${t("builtin.deps.fixedIn", { versions: fixed })}` : ""}\n`;
    }
  }
  if (report.findings.length === 0) out += `${t("builtin.deps.clean")}\n`;
  return out.trimEnd();
}
