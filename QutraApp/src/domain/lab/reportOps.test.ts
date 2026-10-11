import { describe, expect, it } from "vitest";
import {
  buildMarkdownReport,
  createReportRecord,
  reportDownloadName,
} from "./reportOps";
import { EngagementSchema } from "@/domain/lab";
import { EvidenceSchema, FindingSchema } from "@/domain/findings";
import { sha256Hex } from "@/lib/hash";

const T = 1_700_000_000_000;

const engagement = EngagementSchema.parse({
  id: "eng-1",
  title: "Training Lab",
  purpose: "training_lab",
  status: "active",
  scopeId: "sc-1",
  createdAt: T,
  updatedAt: T,
});

describe("buildMarkdownReport", () => {
  it("includes severity summary, finding detail and evidence", () => {
    const findings = [
      FindingSchema.parse({
        id: "f-1",
        engagementId: "eng-1",
        title: "Open SSH",
        fingerprint: "fp-1",
        severity: "high",
        status: "confirmed",
        sourceTool: "nmap",
        affectedTargets: ["127.0.0.1"],
        impact: "Exposure of service banner.",
        remediation: "Restrict the service.",
        evidenceIds: ["ev-1"],
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    ];
    const evidence = [
      EvidenceSchema.parse({
        id: "ev-1",
        findingId: "f-1",
        engagementId: "eng-1",
        kind: "output",
        title: "nmap snippet",
        content: "22/tcp open ssh",
        capturedAt: T,
        source: "run:r1",
        createdAt: T,
      }),
    ];
    const md = buildMarkdownReport({
      engagement,
      findings,
      evidence,
      now: T,
      executiveSummary: "One high finding.",
    });
    expect(md).toContain("# Training Lab — report");
    expect(md).toContain("**high:** 1");
    expect(md).toContain("### Open SSH");
    expect(md).toContain("22/tcp open ssh");
    expect(md).toContain("Restrict the service.");
  });

  it("omits evidence marked exclude-from-report", () => {
    const findings = [
      FindingSchema.parse({
        id: "f-2",
        title: "X",
        fingerprint: "fp-2",
        evidenceIds: ["ev-2"],
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    ];
    const evidence = [
      EvidenceSchema.parse({
        id: "ev-2",
        findingId: "f-2",
        kind: "text",
        title: "secret note",
        content: "should not appear",
        capturedAt: T,
        includeInReport: false,
        createdAt: T,
      }),
    ];
    const md = buildMarkdownReport({ engagement, findings, evidence, now: T });
    expect(md).not.toContain("should not appear");
  });

  it("names sensitive evidence without its content", () => {
    const findings = [
      FindingSchema.parse({
        id: "f-3",
        title: "Location",
        fingerprint: "fp-3",
        evidenceIds: ["ev-3"],
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    ];
    const evidence = [
      EvidenceSchema.parse({
        id: "ev-3",
        findingId: "f-3",
        kind: "observation",
        title: "Location",
        content: "Location: 41.008200, 28.978400",
        sensitivity: "sensitive",
        capturedAt: T,
        createdAt: T,
      }),
    ];
    const md = buildMarkdownReport({ engagement, findings, evidence, now: T });
    expect(md).toContain("- Location (observation) — _content withheld: sensitive_");
    expect(md).not.toContain("41.008200");
    // Shown only when asked for.
    expect(
      buildMarkdownReport({ engagement, findings, evidence, now: T, withholdSensitive: false }),
    ).toContain("41.008200");
  });
});

/** The report's lines outside fenced code blocks. */
function outsideFences(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    if (fence) {
      if (line === fence) fence = null;
      continue;
    }
    const open = /^(`{3,})$/.exec(line);
    if (open) fence = open[1]!;
    else out.push(line);
  }
  return out.join("\n");
}

describe("tool text in the report", () => {
  const hostile = "![x](http://e/p.png) <img src=http://e/p.png> [a](http://e)";
  const md = buildMarkdownReport({
    engagement,
    findings: [
      FindingSchema.parse({
        id: "f-h",
        title: `Bad\n# H ${hostile}`,
        fingerprint: "fp-h",
        description: `line one\n# not a heading\n- not a list\n1. not a list\n${hostile}`,
        affectedTargets: [hostile],
        evidenceIds: ["ev-h"],
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    ],
    evidence: [
      EvidenceSchema.parse({
        id: "ev-h",
        findingId: "f-h",
        kind: "output",
        title: hostile,
        content: "before\n```\n![x](http://e/p.png)\n```\nafter",
        sha256: "ab".repeat(32),
        capturedAt: T,
        createdAt: T,
      }),
    ],
    now: T,
  });
  const outside = outsideFences(md);

  it("adds no image, HTML or link outside a fence", () => {
    expect(outside).not.toMatch(/<img/i);
    expect(outside).not.toMatch(/(^|[^\\])!?\[[^\]]*\]\(/m);
    expect(outside).toContain("&lt;img src=http://e/p.png&gt;");
  });

  it("keeps a title to one heading line", () => {
    expect(md).toMatch(/^### Bad # H !\\\[x\\\]/m);
    expect(md).not.toMatch(/^# H/m);
  });

  it("starts no heading or list from a description line, and keeps its line breaks", () => {
    expect(md).toContain("line one  \n\\# not a heading  \n\\- not a list  \n1\\. not a list  \n");
  });

  it("ends the list before the description", () => {
    expect(md).toMatch(/- \*\*Targets:\*\* [^\n]*\n\nline one {2}\n/);
  });

  it("keeps a fence closed against backticks in the evidence", () => {
    expect(md).toContain("````\nbefore\n```\n![x](http://e/p.png)\n```\nafter\n````");
  });

  it("names each evidence row's hash", () => {
    expect(md).toContain("(output) · SHA-256 abababababab…");
  });

  const described = (description: string) =>
    outsideFences(
      buildMarkdownReport({
        engagement,
        findings: [
          FindingSchema.parse({
            id: "f-d",
            title: "T",
            fingerprint: "fp-d",
            description,
            firstSeen: T,
            lastSeen: T,
            createdAt: T,
            updatedAt: T,
          }),
        ],
        evidence: [],
        now: T,
      }),
    );

  it("treats a lone CR as a line break, not a way past the escapes", () => {
    const out = described("ok\r# Fake heading\r- x");
    expect(out).not.toMatch(/^# Fake/m);
    expect(out).not.toMatch(/^- x/m);
    expect(out).toContain("\\# Fake heading");
  });

  it("opens no tilde fence, table, emphasis or entity from tool text", () => {
    const out = described("~~~\n| a | b |\n|---|---|\n__proto__ *x* &lt;script&gt;");
    expect(out).toContain("\\~\\~\\~");
    expect(out).toContain("\\| a \\| b \\|");
    expect(out).toContain("\\_\\_proto\\_\\_ \\*x\\* &amp;lt;script&amp;gt;");
  });

  it("does not print the hash of withheld evidence", () => {
    const withheld = buildMarkdownReport({
      engagement,
      findings: [
        FindingSchema.parse({
          id: "f-s",
          title: "Location",
          fingerprint: "fp-s",
          evidenceIds: ["ev-s"],
          firstSeen: T,
          lastSeen: T,
          createdAt: T,
          updatedAt: T,
        }),
      ],
      evidence: [
        EvidenceSchema.parse({
          id: "ev-s",
          findingId: "f-s",
          kind: "observation",
          title: "Location",
          content: "41.008200, 28.978400",
          sha256: "cd".repeat(32),
          sensitivity: "sensitive",
          capturedAt: T,
          createdAt: T,
        }),
      ],
      now: T,
    });
    expect(withheld).not.toContain("cdcdcdcdcdcd");
  });
});

describe("createReportRecord", () => {
  it("stores provenance metadata, body and sha256 for included findings", async () => {
    const findings = [
      FindingSchema.parse({
        id: "f-9",
        title: "A",
        fingerprint: "fp-9",
        firstSeen: T,
        lastSeen: T,
        createdAt: T,
        updatedAt: T,
      }),
    ];
    const markdown = buildMarkdownReport({
      engagement,
      findings,
      evidence: [],
      now: T,
    });
    const report = await createReportRecord(
      {
        engagement,
        findings,
        evidence: [],
        now: T,
      },
      markdown,
    );
    expect(report.engagementId).toBe("eng-1");
    expect(report.format).toBe("markdown");
    expect(report.includedFindingIds).toEqual(["f-9"]);
    expect(report.generatedAt).toBe(T);
    expect(report.body).toContain("# Training Lab — report");
    expect(report.sha256).toHaveLength(64);
    expect(report.sha256).toBe(await sha256Hex(markdown));
  });
});

describe("reportDownloadName", () => {
  it("slugifies the engagement title", () => {
    expect(reportDownloadName("My Lab!", T)).toMatch(
      /^contextos-report-my-lab-\d{4}-\d{2}-\d{2}\.md$/,
    );
  });
});
