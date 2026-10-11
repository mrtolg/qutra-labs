import { beforeAll, describe, expect, it } from "vitest";
import { ensureLocaleLoaded } from "@/lib/i18n";
import { ensureBuiltinLocale, translateBuiltin, type AnyKey } from "./i18n";
import { builtinErrorKey } from "@/lib/builtinTools";
import type { OsvReport, RdapReport } from "@/lib/builtinTools";
import { exportName } from "./shared";
import { connectionsText, fieldLabel, osvText, rdapText, wordOr, HTTP_NOTES } from "./summaries";

/* The text a result becomes when it is copied or kept as evidence. */

const t = (key: AnyKey, params?: Record<string, string | number>) => translateBuiltin("tr", key, params);

beforeAll(async () => {
  await ensureLocaleLoaded("tr");
  await ensureBuiltinLocale("tr");
});

describe("result text", () => {
  it("words known codes and keeps unknown ones as they came", () => {
    expect(wordOr(t, "builtin.http.note", "plainHttp", HTTP_NOTES)).toBe(t("builtin.http.note.plainHttp"));
    expect(wordOr(t, "builtin.http.note", "__proto__", HTTP_NOTES)).toBe("__proto__");
    expect(fieldLabel(t, "dc:creator")).toBe(t("builtin.meta.field.author"));
    expect(fieldLabel(t, "toString")).toBe("toString");
    expect(fieldLabel(t, "xmpMM:DocumentID")).toBe("xmpMM:DocumentID");
  });

  it("writes an RDAP record with its holder, roles and history", () => {
    const report: RdapReport = {
      kind: "ip",
      query: "8.8.8.8",
      servers: ["rdap.org", "rdap.arin.net"],
      handle: "NET-8-8-8-0-2",
      name: "GOGL",
      status: ["active"],
      events: [{ action: "registration", date: "2023-12-28T17:24:33-05:00" }],
      entities: [{ handle: "GOGL", roles: ["registrant"], name: "Google LLC", kind: "org", emails: [], country: "" }],
      range: "8.8.8.0 – 8.8.8.255",
      cidrs: ["8.8.8.0/24"],
      networkType: "DIRECT ALLOCATION",
      country: "",
      parent: "NET-8-0-0-0-2",
      asnRange: "",
      nameservers: [],
      dnssec: null,
      port43: "whois.arin.net",
      remarks: [],
    };
    const text = rdapText(t, report);
    expect(text).toContain("RDAP · 8.8.8.8");
    expect(text).toContain("rdap.org -> rdap.arin.net");
    expect(text).toContain(`${t("builtin.rdap.role.registrant")}: Google LLC · GOGL`);
    expect(text).toContain(`${t("builtin.rdap.event.registration")}: 2023-12-28`);
    expect(text).not.toContain("DNSSEC");
  });

  it("lists each affected package with its advisories and fix", () => {
    const report: OsvReport = {
      checked: 3,
      findings: [{ package: { ecosystem: "npm", name: "lodash", version: "4.17.15" }, ids: ["GHSA-1", "GHSA-2"] }],
      advisories: [
        { id: "GHSA-1", aliases: ["CVE-2021-23337"], summary: "Command Injection", severity: "high", cvss: null, score: 7.2, published: "", fixed: { lodash: ["4.17.21"] }, url: "" },
      ],
      advisoriesCut: false,
      checkedAt: 0,
    };
    const text = osvText(t, report);
    expect(text).toContain("npm lodash@4.17.15");
    expect(text).toContain(`GHSA-1 [${t("builtin.deps.sev.high")}] (CVE-2021-23337) Command Injection — ${t("builtin.deps.fixedIn", { versions: "4.17.21" })}`);
    expect(text).toContain("  GHSA-2");
    expect(osvText(t, { ...report, findings: [] })).toContain(t("builtin.deps.clean"));
  });

  it("writes connections one per line, IPv6 in brackets", () => {
    expect(
      connectionsText([
        { protocol: "tcp", family: 6, localAddress: "::1", localPort: 5432, remoteAddress: "", remotePort: 0, state: "listen", pid: 88, process: "postgres.exe" },
        { protocol: "tcp", family: 4, localAddress: "10.0.0.5", localPort: 50000, remoteAddress: "1.2.3.4", remotePort: 443, state: "established", pid: 9, process: "" },
      ]),
    ).toBe("TCP [::1]:5432 listen pid=88 postgres.exe\nTCP 10.0.0.5:50000 -> 1.2.3.4:443 established pid=9");
  });

  it("names an export after the tool, the target and the day", () => {
    expect(exportName("tls", "https://App.Example.com:443/x", Date.parse("2026-10-10T12:00:00Z"))).toBe(
      "qutra-tls-app.example.com-443-x-2026-10-10.json",
    );
    expect(exportName("conns", "", Date.parse("2026-10-10T12:00:00Z"))).toBe("qutra-conns-2026-10-10.json");
  });

  it("words every rejection, Private Lab's own code included", () => {
    expect(builtinErrorKey("scope_blocked")).toBe("builtin.error.scope_blocked");
    expect(builtinErrorKey("private_tools_consent_required")).toBe("builtin.error.consent_required");
    expect(builtinErrorKey("something new")).toBe("builtin.error.unknown");
    expect(builtinErrorKey(new Error("x"))).toBe("builtin.error.unknown");
  });
});
