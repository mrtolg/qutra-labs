import {
  assertParseSize,
  ParseError,
  type ImportedFinding,
  type ParseResult,
} from "./types";

/* Nmap XML importer (nmap.org/book/output-formats-xml-output.html). Each open
   port becomes an informational finding on its host. Uses the platform DOM
   parser (available in the Tauri webview and the jsdom test environment). */

export const NMAP_PARSER_VERSION = "1.0.0";

export function parseNmapXml(xml: string): ParseResult {
  assertParseSize(xml);
  if (typeof DOMParser === "undefined") {
    throw new ParseError("no DOM parser available in this runtime", "no_dom_parser");
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new ParseError("input is not well-formed XML", "bad_xml");
  }
  const run = doc.querySelector("nmaprun");
  if (!run) throw new ParseError("not an Nmap XML document", "not_nmap");

  const meta: Record<string, string> = { tool: "nmap" };
  const args = run.getAttribute("args");
  if (args) meta.args = args;
  const version = run.getAttribute("version");
  if (version) meta.version = version;

  const findings: ImportedFinding[] = [];
  const warnings: string[] = [];
  let rejected = 0;

  for (const host of Array.from(doc.querySelectorAll("host"))) {
    // Prefer the IPv4/IPv6 address; fall back to a hostname.
    const addrEl =
      host.querySelector('address[addrtype="ipv4"]') ??
      host.querySelector('address[addrtype="ipv6"]') ??
      host.querySelector("address");
    const address =
      addrEl?.getAttribute("addr") ??
      host.querySelector("hostname")?.getAttribute("name") ??
      "";
    if (!address) {
      rejected++;
      continue;
    }

    for (const port of Array.from(host.querySelectorAll("port"))) {
      const state = port.querySelector("state")?.getAttribute("state");
      if (state !== "open") continue;
      const portid = port.getAttribute("portid") ?? "";
      const proto = port.getAttribute("protocol") ?? "tcp";
      const svc = port.querySelector("service");
      const name = svc?.getAttribute("name") ?? "";
      const product = svc?.getAttribute("product") ?? "";
      const ver = svc?.getAttribute("version") ?? "";
      const detail = [product, ver].filter(Boolean).join(" ");
      findings.push({
        title: `Open port ${portid}/${proto}${name ? ` (${name})` : ""}`,
        description: detail
          ? `${name || "service"} — ${detail}`
          : name || "open service",
        severity: "info",
        ruleId: `nmap-open-port`,
        affectedTargets: [address],
        location: `${portid}/${proto}`,
      });
    }
  }

  return {
    parser: "nmap",
    parserVersion: NMAP_PARSER_VERSION,
    findings,
    warnings,
    rejected,
    meta,
  };
}
