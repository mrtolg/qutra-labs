import { describe, expect, it } from "vitest";
import type { AnalysisRun, AnalyzerDescriptor } from "@/lib/analysis";
import { isRulesFile, latestRuns, planSteps, suggestedToRun } from "./analysisPlan";

/* Which built-in steps a file gets, in which order, and what
   "Önerilenleri çalıştır" runs. */

const descriptor = (id: string, accepts: string[] = []): AnalyzerDescriptor => ({
  id,
  category: "content",
  accepts,
  risk: "read_only",
  execution: "builtin",
});
const ALL = ["identify", "strings", "entropy", "signatures"].map((id) => descriptor(id));

const run = (overrides: Partial<AnalysisRun>): AnalysisRun => ({
  id: "ana-1",
  kind: "builtin",
  engagementId: "eng_1",
  fileId: "file_1",
  analyzer: "identify",
  state: "finished",
  startedAt: 1,
  endedAt: 2,
  trigger: { by: "user" },
  fileSha256: "ab",
  limited: false,
  observations: [],
  outputs: [],
  ...overrides,
});

const view = (kind: string, runs: AnalysisRun[] = [], running: string | null = null) =>
  planSteps(kind, ALL, runs, "file_1", running).map((s) => `${s.analyzer}:${s.state}`);

describe("the suggested analysis of a file", () => {
  it("runs everything on a program, in order", () => {
    expect(view("pe")).toEqual([
      "identify:queued",
      "strings:queued",
      "entropy:queued",
      "signatures:queued",
    ]);
    // A kind this version does not know is read as an unknown binary.
    expect(view("future-kind")).toEqual(view("binary"));
  });

  it("suggests less for a picture and offers the rest", () => {
    expect(view("jpeg")).toEqual([
      "identify:queued",
      "signatures:queued",
      "strings:optional",
      "entropy:optional",
    ]);
  });

  it("takes each step's state from its newest run on this file", () => {
    const runs = [
      run({ analyzer: "identify", state: "failed", startedAt: 1 }),
      run({ analyzer: "identify", state: "finished", startedAt: 5 }),
      run({ analyzer: "strings", state: "failed", startedAt: 3 }),
      run({ analyzer: "entropy", fileId: "file_2" }),
    ];
    expect(view("pe", runs, "signatures")).toEqual([
      "identify:done",
      "strings:failed",
      "entropy:queued",
      "signatures:running",
    ]);
    expect(latestRuns(runs, "file_1").get("identify")?.startedAt).toBe(5);
  });

  it("runs only the suggested steps not run yet", () => {
    const steps = planSteps("jpeg", ALL, [run({ analyzer: "identify" })], "file_1", null);
    expect(suggestedToRun(steps).map((s) => s.analyzer)).toEqual(["signatures"]);
  });

  it("reads a program's header and a photo's metadata where Rust offers them", () => {
    const offered = [...ALL, descriptor("pe", ["pe"]), descriptor("image", ["jpeg", "png"])];
    const steps = (kind: string) =>
      planSteps(kind, offered, [], "file_1", null).map((s) => s.analyzer);
    expect(steps("pe")).toEqual(["identify", "pe", "strings", "entropy", "signatures"]);
    expect(steps("binary")).toEqual(["identify", "strings", "entropy", "signatures"]);
    expect(steps("jpeg")).toEqual(["identify", "image", "signatures", "strings", "entropy"]);
    expect(steps("gif")).toEqual(["identify", "signatures", "strings", "entropy"]);
  });

  it("leaves out what Rust does not offer for the kind", () => {
    const offered = [descriptor("identify"), descriptor("strings", ["text"])];
    expect(planSteps("pe", offered, [], "file_1", null).map((s) => s.analyzer)).toEqual([
      "identify",
    ]);
  });
});

const external = (id: string, status: string, needsRules = false, accepts: string[] = []) => ({
  id,
  accepts,
  external: { status: status as never, needsRules },
});

describe("outside programs among the steps", () => {
  const offers = (status: string) => [
    ...ALL,
    descriptor("image", ["jpeg", "png"]),
    external("exiftool", status, false, ["jpeg", "pe"]),
  ];
  const view2 = (status: string, runs: AnalysisRun[] = [], rules = true) =>
    planSteps("jpeg", offers(status), runs, "file_1", null, rules).map((s) => `${s.analyzer}:${s.state}`);

  it("puts ExifTool after the photo step, and each reason it cannot run into its state", () => {
    expect(view2("ready")).toEqual([
      "identify:queued",
      "image:queued",
      "exiftool:queued",
      "signatures:queued",
      "strings:optional",
      "entropy:optional",
    ]);
    expect(view2("not_installed")[2]).toBe("exiftool:install");
    expect(view2("needs_consent")[2]).toBe("exiftool:consent");
    expect(view2("disabled")[2]).toBe("exiftool:check");
    expect(view2("changed")[2]).toBe("exiftool:check");
  });

  it("runs only the ready ones, and lets a finished run stand even when the program is gone", () => {
    const steps = planSteps("jpeg", offers("not_installed"), [], "file_1", null);
    expect(suggestedToRun(steps).map((s) => s.analyzer)).toEqual(["identify", "image", "signatures"]);
    const done = run({ analyzer: "exiftool", kind: "external", id: "run-1" });
    const again = planSteps("jpeg", offers("not_installed"), [done], "file_1", null).find((s) => s.analyzer === "exiftool")!;
    expect(again.state).toBe("done");
    expect(again.canRun).toBe(false);
    // A run still going when the page opened shows as running.
    const going = run({ analyzer: "exiftool", kind: "external", state: "running" });
    expect(planSteps("jpeg", offers("ready"), [going], "file_1", null)[2]!.state).toBe("running");
  });

  it("asks YARA for a rules file, and only .yar and .yara text files are rules", () => {
    const yara = [...ALL, external("yara", "ready", true)];
    const state = (rules: boolean) => planSteps("pe", yara, [], "file_1", null, rules).find((s) => s.analyzer === "yara")?.state;
    expect(state(false)).toBe("rules");
    expect(state(true)).toBe("queued");
    const file = (kind: string, originalName: string) => ({ kind, originalName });
    expect(isRulesFile(file("text", "Rules.YAR"))).toBe(true);
    expect(isRulesFile(file("text", "x.yara"))).toBe(true);
    expect(isRulesFile(file("text", "notes.txt"))).toBe(false);
    expect(isRulesFile(file("binary", "x.yar"))).toBe(false);
  });

  it("starts a step only when the program is ready and, for YARA, rules are there", () => {
    const yara = [...ALL, external("yara", "ready", true)];
    const can = (status: string, rules: boolean) =>
      planSteps("pe", [...ALL, external("yara", status, true)], [], "file_1", null, rules).find(
        (s) => s.analyzer === "yara",
      )!;
    expect(can("ready", true).canRun).toBe(true);
    expect(can("ready", false).canRun).toBe(false);
    expect(can("needs_consent", true).canRun).toBe(false);
    expect(can("changed", true).canRun).toBe(false);
    // A built-in step has no outside program in the way.
    expect(planSteps("pe", yara, [], "file_1", null).find((s) => s.analyzer === "identify")!.canRun).toBe(true);
    // The step keeps what the page needs to show why it cannot start.
    expect(can("not_installed", true).external).toEqual({ status: "not_installed", needsRules: true });
    expect(planSteps("pe", yara, [], "file_1", null)[0]!).not.toHaveProperty("external");
  });

  it("puts each program where its kind needs it", () => {
    const everything = [
      ...ALL,
      descriptor("pe", ["pe"]),
      descriptor("image", ["jpeg", "png"]),
      external("exiftool", "ready", false, ["jpeg", "png", "pdf", "office", "zip", "pe"]),
      external("yara", "ready", true),
      external("capinfos", "ready", false, ["pcap", "pcapng"]),
    ];
    const order = (kind: string) =>
      planSteps(kind, everything, [], "file_1", null).map(
        (s) => `${s.analyzer}${s.suggested ? "" : "?"}`,
      );
    // A program: YARA is suggested, ExifTool is on request.
    expect(order("pe")).toEqual(["identify", "pe", "strings", "entropy", "signatures", "yara", "exiftool?"]);
    // A capture is read by capinfos alone, so a program-only step never shows.
    expect(order("pcap")).toEqual(["identify", "capinfos", "strings?", "entropy?", "signatures?"]);
    expect(order("pdf")).toEqual(["identify", "signatures", "exiftool", "strings", "entropy?", "yara?"]);
    expect(order("office")).toEqual(["identify", "signatures", "exiftool", "entropy?", "strings?", "yara?"]);
    expect(order("zip")).toEqual(["identify", "signatures", "entropy?", "strings?", "exiftool?", "yara?"]);
  });

  it("does not ask a rules file of a step that needs none", () => {
    const steps = planSteps("jpeg", offers("ready"), [], "file_1", null, false);
    expect(steps.find((s) => s.analyzer === "exiftool")!.state).toBe("queued");
    expect(steps.find((s) => s.analyzer === "exiftool")!.canRun).toBe(true);
  });
});
