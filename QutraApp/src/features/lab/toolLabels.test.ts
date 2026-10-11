import { describe, expect, it } from "vitest";
import { TOOL_CATALOG } from "./toolCatalog";
import { telemetryLabel } from "./telemetryTerms";
import { displayPath, formatBytes } from "./toolLabels";

describe("displayPath", () => {
  it("drops the verbatim prefix Windows hands back", () => {
    expect(displayPath("\\\\?\\C:\\Tools\\nmap.exe")).toBe("C:\\Tools\\nmap.exe");
    expect(displayPath("\\\\?\\UNC\\server\\share\\x.exe")).toBe("\\\\server\\share\\x.exe");
    expect(displayPath("C:\\Tools\\nmap.exe")).toBe("C:\\Tools\\nmap.exe");
  });
});

describe("formatBytes", () => {
  it("reads in the largest whole unit, in the reader's number format", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(239_616, "en")).toBe("234 KB");
    expect(formatBytes(2_977_792, "tr")).toBe("2,8 MB");
  });
});

// Protocol, file-format and product tokens a reader sees as they are.
const KEEP = new Set(["HTTP", "DNS", "SBOM", "PCAP", "SARIF", "EVE JSON", "conn.log", "dns.log", "http.log"]);

// Words that are written the same way in English and in that language.
const SAME_AS_ENGLISH: Record<"es" | "fr" | "it", readonly string[]> = {
  es: ["handles", "hashes", "proxy"],
  fr: ["agents", "handles", "imports", "proxy", "sections"],
  it: ["file", "proxy", "timeline"],
};

const catalogTerms = [...new Set(TOOL_CATALOG.flatMap((tool) => tool.telemetry))];

describe("evidence kinds", () => {
  it("has a Turkish word for every kind the catalog names", () => {
    const missing = catalogTerms.filter(
      (term) => !KEEP.has(term) && telemetryLabel(term, "tr") === term,
    );
    expect(missing).toEqual([]);
  });

  it.each(["de", "es", "fr", "it"] as const)(
    "has a word in %s for every kind the catalog names",
    (locale) => {
      const allowed = locale === "de" ? [] : SAME_AS_ENGLISH[locale];
      const missing = catalogTerms.filter(
        (term) =>
          !KEEP.has(term) &&
          !allowed.includes(term) &&
          telemetryLabel(term, locale) === term,
      );
      expect(missing).toEqual([]);
    },
  );

  it("translates by language and leaves English and unknown terms alone", () => {
    expect(telemetryLabel("process tree", "tr")).toBe("süreç ağacı");
    expect(telemetryLabel("process tree", "de")).toBe("Prozessbaum");
    expect(telemetryLabel("process tree", "es")).toBe("árbol de procesos");
    expect(telemetryLabel("process tree", "fr")).toBe("arborescence des processus");
    expect(telemetryLabel("process tree", "it")).toBe("albero dei processi");
    expect(telemetryLabel("process tree", "en")).toBe("process tree");
    expect(telemetryLabel("conn.log", "de")).toBe("conn.log");
    expect(telemetryLabel("not a known term", "fr")).toBe("not a known term");
  });
});
