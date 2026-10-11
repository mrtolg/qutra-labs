import { describe, expect, it } from "vitest";
import { EngagementSchema } from "@/domain/lab";
import { EvidenceSchema, FindingSchema } from "@/domain/findings";
import { buildMarkdownReport } from "@/domain/lab/reportOps";
import { ensureLocaleLoaded, translate, type MessageKey } from "@/lib/i18n";
import {
  DEFAULT_REPORT_OPTIONS,
  buildEngagementReport,
  maskForReport,
  reportWords,
  selectReportFindings,
} from "./reportBuild";

/* The report as the Rapor view builds it. */

const T = 1_760_000_000_000;

const engagement = EngagementSchema.parse({
  id: "eng-1",
  title: "Home Lab",
  purpose: "training_lab",
  status: "active",
  scopeId: "sc-1",
  createdAt: T,
  updatedAt: T,
});

const finding = FindingSchema.parse({
  id: "f-1",
  engagementId: "eng-1",
  title: "Open SSH",
  fingerprint: "fp-1",
  severity: "high",
  status: "confirmed",
  confidence: "high",
  impact: "Banner exposure.",
  evidenceIds: ["ev-1"],
  firstSeen: T,
  lastSeen: T,
  createdAt: T,
  updatedAt: T,
});

const evidence = EvidenceSchema.parse({
  id: "ev-1",
  findingId: "f-1",
  engagementId: "eng-1",
  kind: "output",
  title: "nmap",
  content: "22/tcp open ssh",
  capturedAt: T,
  createdAt: T,
});

describe("report words", () => {
  it("writes the headings and labels in the app's language", async () => {
    await ensureLocaleLoaded("tr");
    const t = (key: MessageKey, params?: Record<string, string | number>) =>
      translate("tr", key, params);
    const md = buildMarkdownReport({
      engagement,
      findings: [finding],
      evidence: [evidence],
      now: T,
      words: reportWords(t),
    });
    expect(md).toContain("# Home Lab — inceleme raporu");
    expect(md).toContain("## Yönetici özeti");
    expect(md).toContain("Home Lab incelemesinde 1 bulgu var.");
    expect(md).toContain("- **Yüksek:** 1");
    expect(md).toContain("- **Önem:** Yüksek");
    expect(md).toContain("- **Durum:** Teyit edildi");
    expect(md).toContain("- **Güven:** Yüksek");
    expect(md).toContain("**Etki**");
    expect(md).toContain("**Kanıtlar**");
    expect(md).not.toMatch(/Severity|Status|Findings|Evidence|Generated/);
  });
});

const english = reportWords((key, params) => translate("en", key, params));
const draft = FindingSchema.parse({ ...finding, id: "f-2", fingerprint: "fp-2", title: "Draft one", status: "new", evidenceIds: [] });
const dismissed = (["false_positive", "duplicate", "out_of_scope"] as const).map((status, i) =>
  FindingSchema.parse({ ...finding, id: `f-d${i}`, fingerprint: `fp-d${i}`, title: `Dismissed ${i}`, status, evidenceIds: [`ev-d${i}`] }),
);
const dismissedEvidence = dismissed.map((f, i) =>
  EvidenceSchema.parse({ ...evidence, id: `ev-d${i}`, findingId: f.id }),
);
const ids = (list: { id: string }[]) => list.map((f) => f.id);

describe("what a report holds", () => {
  const all = [finding, draft, ...dismissed];
  const rows = [evidence, ...dismissedEvidence];

  it("leaves out drafts and dismissed findings by default", () => {
    const picked = selectReportFindings(all, rows, DEFAULT_REPORT_OPTIONS);
    expect(ids(picked.included)).toEqual(["f-1"]);
    expect(picked).toMatchObject({ drafts: 1, dismissed: 3 });
  });

  it("brings dismissed findings back when asked, but never a draft",() => {
    const picked = selectReportFindings(all, rows, { ...DEFAULT_REPORT_OPTIONS, includeDismissed: true });
    expect(ids(picked.included)).toEqual(["f-1", "f-d0", "f-d1", "f-d2"]);
    expect(picked.drafts).toBe(1);
  });
});

describe("masking", () => {
  const masks = (text: string) => maskForReport(text, "[hidden]");

  it("hides coordinates and the folders of a path, keeping its last part", () => {
    const masked = masks(
      "at 41.008200, 28.978400 in C:\\Users\\Jane Doe\\Desktop\\x.exe and \\\\srv\\share\\dir\\y.txt; v 1.2, 3.4",
    );
    expect(masked.text).toBe("at [hidden] in …\\x.exe and …\\y.txt; v 1.2, 3.4");
    expect(masked).toMatchObject({ locations: 1, paths: 2 });
  });

  it("hides JSON-escaped and forward-slash paths and home folders", () => {
    const masked = masks('"C:\\\\Users\\\\bob\\\\a.txt" file:///C:/Users/bob/b.txt /home/bob/c.txt');
    expect(masked.text).toBe('"…\\a.txt" file:///…/b.txt …/c.txt');
    expect(masked.paths).toBe(3);
  });

  it("keeps the words around a path, and two paths on a line apart", () => {
    expect(masks("Copies C:\\Windows\\cmd.exe to D:\\tmp\\cmd.exe").text).toBe(
      "Copies …\\cmd.exe to …\\cmd.exe",
    );
    expect(masks("C:\\x\\a.exe signed; see CI/CD").text).toBe("…\\a.exe signed; see CI/CD");
  });

  it("keeps an apostrophe inside a folder name, so none of the name is left", () => {
    expect(masks("C:\\Users\\O'Brien\\Desktop\\case.pcap").text).toBe("…\\case.pcap");
    expect(masks('"C:\\\\Users\\\\O\'Brien\\\\Desktop\\\\case.pcap"').text).toBe('"…\\case.pcap"');
    expect(masks("/home/o'brien/case.pcap").text).toBe("…/case.pcap");
    // A quote around a path still ends it.
    expect(masks("open 'C:\\x\\a.exe' now").text).toBe("open '…\\a.exe' now");
  });

  it("hides a user's folder even when it ends the path", () => {
    expect(masks("profile C:\\Users\\bob").text).toBe("profile …\\…");
    expect(masks("HOME=/home/bob").text).toBe("HOME=…/…");
    // A URL's path is not a folder on this machine.
    expect(masks("https://api.example/Users/42/orders").text).toBe("https://api.example/Users/42/orders");
  });

  it("hides the other ways a location is written", () => {
    for (const text of [
      "41.0082° N, 28.9784° E",
      "GPS Position : 41 deg 0' 29.52\" N, 28 deg 58' 42.24\" E",
      '{"lat": 41.0082, "lon": 28.9784}',
      "GPS Latitude : 41.0082",
    ]) {
      const masked = masks(text);
      expect(masked.text, text).not.toMatch(/41|28\.9784|28 deg/);
      expect(masked.locations, text).toBeGreaterThan(0);
    }
    // Out of range for a latitude: not a location.
    expect(masks("ratio 123.4567, 200.1234").text).toBe("ratio 123.4567, 200.1234");
  });

  it("masks the report by default and says what it masked", () => {
    const photo = FindingSchema.parse({
      ...finding,
      id: "f-p",
      fingerprint: "fp-p",
      title: "Saved in C:\\Users\\bob\\Pictures\\IMG.jpg",
      description: "Taken at 41.008200, 28.978400.",
      evidenceIds: ["ev-p", "ev-s"],
    });
    const rows = [
      EvidenceSchema.parse({ ...evidence, id: "ev-p", findingId: "f-p", content: "path C:\\Users\\bob\\x.txt" }),
      EvidenceSchema.parse({ ...evidence, id: "ev-s", findingId: "f-p", title: "Location", content: "41.0082, 28.9784", sensitivity: "sensitive" }),
    ];
    const build = (mask: boolean) =>
      buildEngagementReport({
        engagement,
        findings: [photo],
        evidence: rows,
        options: { ...DEFAULT_REPORT_OPTIONS, mask },
        words: english,
        now: T,
      });

    const masked = build(true);
    expect(masked.markdown).not.toMatch(/bob|41\.0082/);
    expect(masked.markdown).toContain("### Saved in …\\\\IMG.jpg");
    expect(masked.markdown).toContain("Taken at \\[location hidden\\].");
    expect(masked.masked).toEqual({ locations: 1, paths: 2, sensitive: 1 });

    const open = build(false);
    expect(open.markdown).toContain("C:\\\\Users\\\\bob\\\\Pictures\\\\IMG.jpg");
    expect(open.markdown).toContain("41.0082, 28.9784");
    expect(open.masked).toEqual({ locations: 0, paths: 0, sensitive: 0 });
  });
});
