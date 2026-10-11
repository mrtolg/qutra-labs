import { describe, expect, it } from "vitest";
import { parseSarif } from "./sarif";
import { parseNmapXml } from "./nmap";
import { ParseError } from "./types";

/* Synthetic fixtures only — no real secrets or unauthorized target data. */

const SARIF_FIXTURE = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "semgrep",
          rules: [
            {
              id: "rules.sql-injection",
              name: "SQL Injection",
              fullDescription: { text: "User input flows into a SQL query." },
              helpUri: "https://example.test/sql",
              defaultConfiguration: { level: "error" },
              properties: { tags: ["security", "external/cwe/cwe-89"] },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "rules.sql-injection",
          message: { text: "Tainted input reaches query" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db.ts" },
                region: { startLine: 42 },
              },
            },
          ],
        },
        {
          ruleId: "rules.weak-hash",
          level: "note",
          message: { text: "MD5 used" },
        },
      ],
    },
  ],
});

describe("parseSarif", () => {
  it("maps levels to severity and extracts rule/target/cwe", () => {
    const res = parseSarif(SARIF_FIXTURE);
    expect(res.parser).toBe("sarif");
    expect(res.meta.tool).toBe("semgrep");
    expect(res.findings).toHaveLength(2);

    const sqli = res.findings[0];
    expect(sqli.severity).toBe("high"); // error → high
    expect(sqli.title).toBe("SQL Injection");
    expect(sqli.ruleId).toBe("rules.sql-injection");
    expect(sqli.affectedTargets).toEqual(["src/db.ts:42"]);
    expect(sqli.cwe).toContain("CWE-89");
    expect(sqli.references).toEqual(["https://example.test/sql"]);

    expect(res.findings[1].severity).toBe("low"); // note → low
  });

  it("rejects non-JSON and documents without runs", () => {
    expect(() => parseSarif("not json")).toThrow(ParseError);
    expect(() => parseSarif(JSON.stringify({ version: "2.1.0" }))).toThrow(ParseError);
  });
});

const NMAP_FIXTURE = `<?xml version="1.0"?>
<nmaprun scanner="nmap" args="nmap -sV 10.0.0.5" version="7.94">
  <host>
    <address addr="10.0.0.5" addrtype="ipv4"/>
    <ports>
      <port protocol="tcp" portid="22">
        <state state="open"/>
        <service name="ssh" product="OpenSSH" version="9.6"/>
      </port>
      <port protocol="tcp" portid="80">
        <state state="open"/>
        <service name="http"/>
      </port>
      <port protocol="tcp" portid="3306">
        <state state="closed"/>
        <service name="mysql"/>
      </port>
    </ports>
  </host>
</nmaprun>`;

describe("parseNmapXml", () => {
  it("emits an informational finding per open port only", () => {
    const res = parseNmapXml(NMAP_FIXTURE);
    expect(res.parser).toBe("nmap");
    expect(res.meta.args).toContain("nmap -sV");
    expect(res.findings).toHaveLength(2); // closed port skipped

    const ssh = res.findings.find((f) => f.location === "22/tcp");
    expect(ssh?.severity).toBe("info");
    expect(ssh?.affectedTargets).toEqual(["10.0.0.5"]);
    expect(ssh?.title).toContain("22/tcp");
    expect(ssh?.description).toContain("OpenSSH");
  });

  it("rejects malformed XML and non-nmap documents", () => {
    expect(() => parseNmapXml("<a><b></a>")).toThrow(ParseError);
    expect(() => parseNmapXml("<other></other>")).toThrow(ParseError);
  });
});
