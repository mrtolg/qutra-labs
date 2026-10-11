import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/enablePrivateLab", () => ({ grantPrivateLab: vi.fn() }));

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import type { AnalysisRun, Observation } from "@/lib/analysis";
import type { NativeToolRun } from "@/lib/bridge/types";
import { grantPrivateLab } from "@/lib/enablePrivateLab";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { FileAnalysis } from "./FileAnalysis";

/* Önerilen analiz under a file's card. Rust is mocked at
   `invoke`; nothing reads or runs a file. */

const FILE: InvestigationFile = {
  id: "file_1",
  engagementId: "eng_1",
  relPath: "files/invoice.pdf.sample",
  name: "invoice.pdf.sample",
  originalName: "invoice.pdf",
  bytes: 4096,
  sha256: "ab".repeat(32),
  sha1: "cd".repeat(20),
  md5: "ef".repeat(16),
  kind: "pe",
  sample: true,
  source: "picked",
  addedAt: 1,
  missing: false,
  readOnly: true,
};

const PHOTO: InvestigationFile = {
  ...FILE,
  id: "file_2",
  name: "photo.jpg",
  originalName: "photo.jpg",
  kind: "jpeg",
  sample: false,
};
const RULES: InvestigationFile = {
  ...FILE,
  id: "file_rules",
  name: "rules.yar",
  originalName: "rules.yar",
  kind: "text",
  sample: false,
};

const ANALYZERS = [
  ["identify", []],
  ["pe", ["pe"]],
  ["image", ["jpeg", "png"]],
  ["strings", []],
  ["entropy", []],
  ["signatures", []],
].map(([id, accepts]) => ({
  id,
  category: "content",
  accepts,
  risk: "read_only",
  execution: "builtin",
}));

let serial = 0;
function run(analyzer: string, overrides: Partial<AnalysisRun> = {}): AnalysisRun {
  serial += 1;
  return {
    id: `ana-${analyzer}-${serial}`,
    kind: "builtin",
    engagementId: "eng_1",
    fileId: "file_1",
    analyzer,
    state: "finished",
    startedAt: serial,
    endedAt: serial,
    trigger: { by: "user" },
    fileSha256: FILE.sha256,
    limited: false,
    observations: [],
    outputs: [{ name: "output.txt", relPath: "analysis/x/output.txt", sha256: "00", bytes: 1 }],
    ...overrides,
  };
}

const obs = (key: string, value: string | number, group: Observation["group"], extra: Partial<Observation> = {}): Observation => ({
  id: `${key}:${serial}`,
  key,
  value,
  group,
  ...extra,
});

/** What each analyzer finds in the sample. */
const FINDS: Record<string, () => AnalysisRun> = {
  identify: () =>
    run("identify", {
      observations: [
        obs("identify.kind", "pe", "summary"),
        obs("identify.mismatch", "pdf", "interesting", { hint: "disguisedExecutable" }),
      ],
    }),
  strings: () =>
    run("strings", {
      limited: true,
      observations: [
        obs("strings.count", 1234, "summary"),
        obs("strings.urls", 7, "interesting", {
          items: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4", "https://a.example/5", "https://a.example/6", "https://a.example/7"],
        }),
      ],
    }),
  entropy: () =>
    run("entropy", {
      observations: [
        obs("entropy.file", 7.91, "summary"),
        obs("entropy.high", 7.91, "interesting", { hint: "packed" }),
      ],
    }),
  signatures: () => run("signatures", { observations: [obs("signatures.count", 0, "summary")] }),
  image: () => run("image"),
  pe: () =>
    run("pe", {
      observations: [
        obs("pe.signed", "no", "summary"),
        obs("pe.riskyImports", 2, "interesting", {
          hint: "riskyImports",
          items: ["VirtualAllocEx", "WriteProcessMemory"],
        }),
      ],
    }),
};

const tool = (id: string, status = "ready") => ({
  id,
  name: id === "exiftool" ? "ExifTool" : "YARA",
  catalogId: id,
  category: "dfir",
  accepts: id === "yara" ? [] : ["jpeg", "pe"],
  risk: "read_only",
  execution: "external",
  executables: [`${id}.exe`],
  installUrl: `https://example.invalid/${id}`,
  needsRules: id === "yara",
  status,
});

function nativeRun(toolId: string, fileId: string, extra: Partial<NativeToolRun> = {}): NativeToolRun {
  serial += 1;
  return {
    id: `run-${toolId}-${serial}`,
    requestId: "external-1",
    profileId: `external-${toolId}`,
    installationId: "tool-1",
    engagementId: "eng_1",
    state: "succeeded",
    argv: [],
    commandPreview: "",
    terminationReason: "completed",
    workingDir: "",
    artifactDir: "",
    stdoutTail: "",
    stderrTail: "",
    bytesOut: 5,
    bytesErr: 0,
    truncated: false,
    blockedReason: "",
    artifacts: [],
    kind: "external",
    trigger: { by: "user" },
    subject: { fileId, fileSha256: "ab".repeat(32) },
    descriptorId: toolId,
    outputs: [{ name: "stdout.log", relPath: `runs/${toolId}/stdout.log`, sha256: "00", bytes: 5 }],
    observations:
      toolId === "exiftool"
        ? [
            obs("exiftool.camera", "Canon EOS R6", "summary"),
            obs("exiftool.gps", "41.008200, 28.978400", "interesting", { hint: "gpsLocation" }),
          ]
        : [],
    createdAt: serial,
    updatedAt: serial,
    startedAt: serial,
    endedAt: serial,
    ...extra,
  };
}

/** A fake Rust side; returns the analyzers it was asked to run, in order. */
function rust(
  opts: {
    runs?: AnalysisRun[];
    refuse?: Record<string, string>;
    tools?: () => ReturnType<typeof tool>[];
    toolRuns?: () => NativeToolRun[];
    blocked?: Record<string, string>;
    /** Codes the outside programs' `external_tool_run` rejects with. */
    reject?: Record<string, string>;
    /** What `tool_run_output` does, by log name; a string rejects. */
    output?: (name: string) => string | Promise<string>;
  } = {},
) {
  const asked: string[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "analysis_analyzers":
        return ANALYZERS;
      case "analysis_list":
        return opts.runs ?? [];
      case "analysis_run": {
        const analyzer = String(args.analyzer);
        asked.push(analyzer);
        if (opts.refuse?.[analyzer]) throw opts.refuse[analyzer];
        return FINDS[analyzer]!();
      }
      case "analysis_output":
        return `raw output of ${String(args.runId)}`;
      case "external_tools_list":
        return opts.tools?.() ?? [];
      case "external_tool_runs":
        return opts.toolRuns?.() ?? [];
      case "external_tool_run": {
        const id = String(args.tool);
        asked.push(id);
        if (opts.reject?.[id]) throw opts.reject[id];
        const reason = opts.blocked?.[id];
        return nativeRun(
          id,
          String(args.fileId),
          reason ? { state: "blocked", blockedReason: reason, terminationReason: reason } : {},
        );
      }
      case "tool_run_output":
        if (opts.output) return opts.output(String(args.name));
        return `tool output of ${String(args.runId)}`;
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
  return asked;
}

const runSuggested = () => screen.getByRole("button", { name: "Run suggested" });
/** Buttons stay focusable while busy: aria-disabled, never disabled. */
const ready = (button: HTMLElement) => expect(button).not.toHaveAttribute("aria-disabled");
const held = (button: HTMLElement) => expect(button).toHaveAttribute("aria-disabled", "true");

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  invoke.mockReset();
  vi.mocked(grantPrivateLab).mockReset();
  useInvestigationFiles.setState({ byEngagement: {} });
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("Önerilen analiz", () => {
  it("runs the suggested steps in order and shows what they found in layers", async () => {
    const asked = rust();
    render(<FileAnalysis file={FILE} />);

    expect(screen.getByText("Done · when added")).toBeInTheDocument();
    await waitFor(() => ready(runSuggested()));
    expect(screen.getAllByText("Next")).toHaveLength(5);
    await userEvent.click(runSuggested());

    await waitFor(() =>
      expect(asked).toEqual(["identify", "pe", "strings", "entropy", "signatures"]),
    );
    const summary = await screen.findByText("Summary");
    expect(summary).toBeInTheDocument();
    expect(screen.getByText("Windows program (PE)")).toBeInTheDocument();
    expect(screen.getAllByText("7.91").length).toBeGreaterThan(0);
    expect(screen.getByText("A program named like a .pdf file.")).toBeInTheDocument();
    expect(
      screen.getByText("Close to random: the content may be packed or encrypted."),
    ).toBeInTheDocument();
    // Five examples, the other two folded away.
    expect(screen.getByText("https://a.example/5")).toBeVisible();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    expect(screen.getByText(/Stopped at a size or time limit/)).toBeInTheDocument();
    // The program header: a yes/no in words, and what its imports can do.
    expect(screen.getByText("Signed").nextElementSibling).toHaveTextContent("No");
    expect(
      screen.getByText("It can write into other programs, download files or watch the keyboard."),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^Done · /)).toHaveLength(6);
    expect(screen.getByRole("status")).toHaveTextContent("Embedded files: done.");
    held(runSuggested());
  });

  it("keeps the keyboard on a step's button while it runs and after", async () => {
    rust();
    render(<FileAnalysis file={FILE} />);
    const button = await screen.findByRole("button", { name: "Run: Strings" });
    await waitFor(() => ready(button));

    button.focus();
    await userEvent.keyboard("{Enter}");

    const again = await screen.findByRole("button", { name: "Run again: Strings" });
    expect(again).toBe(button);
    expect(again).toHaveFocus();
  });

  it("stops at a refused step and says why", async () => {
    const asked = rust({ refuse: { strings: "file_changed" } });
    render(<FileAnalysis file={FILE} />);
    await waitFor(() => ready(runSuggested()));

    await userEvent.click(runSuggested());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The copy has changed since it was added, so it was not analysed.",
    );
    expect(asked).toEqual(["identify", "pe", "strings"]);
  });

  it("says a step failed and offers to run it again", async () => {
    rust({ runs: [run("identify", { state: "failed", error: "read_failed", outputs: [] })] });
    render(<FileAnalysis file={FILE} />);

    expect(await screen.findByText("Failed · The analysis did not finish.")).toBeInTheDocument();
    ready(screen.getByRole("button", { name: "Run again: Type and extension" }));
  });

  it("keeps a flagged observation as evidence, then makes it a finding, keeping the keyboard", async () => {
    const entropy = FINDS.entropy!();
    rust({ runs: [entropy] });
    render(<FileAnalysis file={FILE} />);

    const keep = await screen.findByRole("button", { name: "Keep as evidence: Entropy" });
    keep.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(getDb().collection("evidence").getAll()).toHaveLength(1));
    const kept = getDb().collection("evidence").getAll()[0]!;
    expect(kept).toMatchObject({
      kind: "observation",
      runId: entropy.id,
      fileId: "file_1",
      observationIds: [entropy.observations[1]!.id],
      rawRef: { relPath: "analysis/x/output.txt", sha256: "00" },
    });
    // The exact value and why it stands out, not only the page's rounding.
    expect(kept.content).toContain("entropy.high = 7.91");
    expect(kept.content).toContain("Close to random: the content may be packed or encrypted.");
    const keptButton = await screen.findByRole("button", { name: "Kept as evidence: Entropy" });
    expect(keptButton).toBe(keep);
    expect(keptButton).toHaveFocus();
    held(keptButton);

    const make = screen.getByRole("button", { name: "Make a finding: Entropy" });
    make.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(getDb().collection("findings").getAll()).toHaveLength(1));
    const finding = getDb().collection("findings").getAll()[0]!;
    // The kept evidence is linked, not copied: one row, now the finding's.
    expect(finding).toMatchObject({
      sourceRunId: entropy.id,
      evidenceIds: [kept.id],
      description: "Close to random: the content may be packed or encrypted.",
    });
    expect(getDb().collection("evidence").getAll()).toHaveLength(1);
    expect(getDb().collection("evidence").getAll()[0]!.findingId).toBe(finding.id);
    const linked = await screen.findByRole("button", { name: "Evidence of a finding: Entropy" });
    expect(linked).toHaveFocus();
    expect(screen.queryByRole("button", { name: /^Make a finding/ })).toBeNull();
  });

  it("makes a finding straight from an observation, with its own evidence", async () => {
    const identify = FINDS.identify!();
    rust({ runs: [identify] });
    render(<FileAnalysis file={FILE} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Make a finding: Extension does not match" }),
    );

    await waitFor(() => expect(getDb().collection("evidence").getAll()).toHaveLength(1));
    const finding = getDb().collection("findings").getAll()[0]!;
    const item = getDb().collection("evidence").getAll()[0]!;
    expect(item).toMatchObject({
      kind: "observation",
      findingId: finding.id,
      observationIds: [identify.observations[1]!.id],
    });
    expect(finding).toMatchObject({
      title: "Extension does not match: .pdf",
      description: "A program named like a .pdf file.",
      evidenceIds: [item.id],
      sourceRunId: identify.id,
      affectedTargets: ["invoice.pdf.sample"],
    });
  });

  it("still shows a fact as kept after its step ran again", async () => {
    const before = FINDS.entropy!();
    const again = FINDS.entropy!();
    const { evidenceFromObservation } = await import("./observationEvidence");
    getDb()
      .collection("evidence")
      .put(
        await evidenceFromObservation({
          run: before,
          observation: before.observations[1]!,
          label: "Entropy",
          shown: "7.91",
          now: 1,
        }),
      );
    rust({ runs: [again] });
    render(<FileAnalysis file={FILE} />);

    expect(await screen.findByRole("button", { name: "Kept as evidence: Entropy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make a finding: Entropy" })).toBeInTheDocument();
  });

  it("says so when an observation cannot be kept", async () => {
    rust({ runs: [FINDS.entropy!()] });
    const { useUi } = await import("@/state/ui");
    vi.spyOn(getDb().collection("evidence"), "put").mockImplementation(() => {
      throw new Error("disk");
    });
    render(<FileAnalysis file={FILE} />);

    await userEvent.click(await screen.findByRole("button", { name: "Keep as evidence: Entropy" }));

    await waitFor(() =>
      expect(useUi.getState().toasts.at(-1)).toMatchObject({
        kind: "danger",
        messageKey: "lab.analysis.pinFailed",
      }),
    );
    expect(screen.getByRole("button", { name: "Keep as evidence: Entropy" })).toBeInTheDocument();
  });

  it("shows file text as text, even a name an object has", async () => {
    rust({
      runs: [
        run("identify", {
          observations: [
            obs("pe.signed", "__proto__", "summary"),
            obs("image.software", "constructor", "summary"),
            obs("pe.invalid", "notPe", "summary"),
          ],
        }),
      ],
    });
    render(<FileAnalysis file={FILE} />);

    expect(await screen.findByText("__proto__")).toBeInTheDocument();
    expect(screen.getByText("constructor")).toBeInTheDocument();
    expect(screen.getByText("Not a program header")).toBeInTheDocument();
  });

  it("reads each step's raw output when the layer opens", async () => {
    const identify = FINDS.identify!();
    rust({ runs: [identify] });
    render(<FileAnalysis file={FILE} />);
    const toggle = await screen.findByText("Show raw output");
    expect(invoke).not.toHaveBeenCalledWith("analysis_output", expect.anything());

    const details = toggle.closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    const raw = await screen.findByText(`raw output of ${identify.id}`);
    expect(within(raw.closest("section")!).getByText("Type and extension")).toBeInTheDocument();
  });

  it("does not analyse a copy that is gone from the folder", async () => {
    rust();
    render(<FileAnalysis file={{ ...FILE, missing: true }} />);

    expect(
      await screen.findByText(
        "The copy is not in the folder, so it cannot be analysed. Add the file again.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Run: / })).toHaveLength(5));
    held(runSuggested());
    for (const button of screen.getAllByRole("button", { name: /^Run: / })) {
      held(button);
    }
    await userEvent.click(screen.getByRole("button", { name: "Run: Strings" }));
    await userEvent.click(runSuggested());
    expect(invoke).not.toHaveBeenCalledWith("analysis_run", expect.anything());
  });

  it("says built-in analysis needs the desktop app in the browser build", () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    render(<FileAnalysis file={FILE} />);

    expect(screen.getByText("Built-in analysis works in the desktop app.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("outside programs in Önerilen analiz", () => {
  it("runs ExifTool after the photo step and shows what it read", async () => {
    const asked = rust({ tools: () => [tool("exiftool")] });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));
    await userEvent.click(runSuggested());
    await waitFor(() => expect(asked).toEqual(["identify", "image", "exiftool", "signatures"]));
    expect(await screen.findByText("Canon EOS R6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep as evidence: Location" })).toBeInTheDocument();
    // The page names the tool and the file by id and sends nothing else.
    expect(invoke).toHaveBeenCalledWith("external_tool_run", {
      engagementId: "eng_1",
      fileId: "file_2",
      tool: "exiftool",
      rulesFileId: undefined,
    });
  });

  it("says Install for a program that is not registered and offers to find it or fetch it", async () => {
    const openUrl = vi.fn().mockResolvedValue({ ok: true, simulated: false });
    setBridgeForTesting({ mode: "tauri", openUrl } as unknown as DesktopBridge);
    const asked = rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);

    expect(await screen.findByText("Install")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Locate…: Metadata (ExifTool)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download page: Metadata (ExifTool)" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.invalid/exiftool");

    await waitFor(() => ready(runSuggested()));
    await userEvent.click(runSuggested());
    await waitFor(() => expect(asked).toEqual(["identify", "image", "signatures"]));
  });

  it("asks for Private Lab first, and looks again once it is on", async () => {
    let consented = false;
    rust({ tools: () => [tool("exiftool", consented ? "ready" : "needs_consent")] });
    vi.mocked(grantPrivateLab).mockImplementation(async () => {
      consented = true;
      return "granted";
    });
    render(<FileAnalysis file={PHOTO} />);

    expect(await screen.findByText("Private Lab needed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enable Private Lab: Metadata (ExifTool)" }));
    await waitFor(() => expect(screen.queryByText("Private Lab needed")).toBeNull());
  });

  it("runs YARA with the rules file kept in the investigation, and asks for one when there is none", async () => {
    rust({ tools: () => [tool("yara")] });
    useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE] } });
    render(<FileAnalysis file={FILE} />);
    expect(await screen.findByText("Rules file needed")).toBeInTheDocument();

    act(() => useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE, RULES] } }));
    await userEvent.click(await screen.findByRole("button", { name: "Run: YARA rules" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("external_tool_run", {
        engagementId: "eng_1",
        fileId: "file_1",
        tool: "yara",
        rulesFileId: "file_rules",
      }),
    );
  });

  it("says why a program was refused", async () => {
    rust({ tools: () => [tool("exiftool")], blocked: { exiftool: "tool_identity_changed" } });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));
    await userEvent.click(screen.getByRole("button", { name: "Run: Metadata (ExifTool)" }));
    expect(
      await screen.findByText("Failed · The tool changed since you added it. Check it under Registered tools."),
    ).toBeInTheDocument();
  });

  it("looks again at a run that was still going when the page opened", async () => {
    let calls = 0;
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => {
        calls += 1;
        return [nativeRun("exiftool", "file_2", calls === 1 ? { state: "running", endedAt: undefined } : {})];
      },
    });
    render(<FileAnalysis file={PHOTO} />);
    expect(await screen.findByText("Running…")).toBeInTheDocument();
    expect(await screen.findByText(/^Done · /, undefined, { timeout: 4000 })).toBeInTheDocument();
  });
});

/** Every code Rust can send the page has words of its own, and a code the
    page does not know never reaches the screen as it came. */
describe("outside programs: what each refusal says", () => {
  const TOOL_CHANGED = "The tool changed since you added it. Check it under Registered tools.";
  const TOOL_GONE =
    "The program is no longer where you registered it. Register it again under Registered tools.";
  const NOT_DELIVERED = "The tool did not receive the file. Run it again.";
  const NOT_STARTED = "The program could not be started. Check that it still opens, then try again.";
  const ELEVATION =
    "The program asks for administrator rights, and Qutra Labs does not run programs that way. Use a version that does not need them.";
  const TOO_BUSY = "Other scans are using every place for running tools. Try again when one ends.";
  const GENERIC = "The analysis did not finish.";
  const APP_RESTARTED = "Qutra Labs closed while this scan was running. Run it again.";

  const REFUSED: Array<[string, string]> = [
    ["unknown_tool", "The tool is not registered."],
    ["tool_not_installed", "The tool is not registered."],
    ["tool_identity_changed", TOOL_CHANGED],
    ["tool_disabled", "The tool is turned off."],
    ["private_tools_consent_required", "Private Lab is off."],
    ["unknown_file", "This file is not in the investigation any more. Add it again."],
    ["tool_not_for_kind", "This tool does not read this kind of file."],
    ["file_too_large", "The file is too large for this tool."],
    ["unknown_rules_file", "The rules file is not in this investigation. Choose another one."],
    ["rules_required", "Choose a rules file (.yar) kept in this investigation."],
    ["rules_not_text", "Choose a rules file (.yar) kept in this investigation."],
    ["rules_too_large", "The rules file is too large (over 16 MB). Split it or remove some rules."],
    [
      "rules_include_not_allowed",
      "The rules file imports another file (include). Merge the rules into one file.",
    ],
    [
      "input_too_large",
      "The file's location is too long for this tool. Use a shorter file or investigation name.",
    ],
    [
      "run_ledger_read_only",
      "Scans cannot be recorded right now. Restart Qutra Labs; if this stays, update it.",
    ],
    [
      "run_ledger_backup_failed",
      "The scan history could not be backed up first, so the scan did not start. Check the free disk space and try again.",
    ],
    ["spawn_failed", NOT_STARTED],
    ["elevation_required", ELEVATION],
    ["input_not_delivered", NOT_DELIVERED],
    [
      "run_wait_timeout",
      "The scan did not report back in time; it may still be running. Look again in a moment.",
    ],
    ["external_tool_failed", "The scan stopped unexpectedly. Try again."],
    ["concurrency_limit_reached", TOO_BUSY],
    ["file_changed", "The copy has changed since it was added, so it was not analysed."],
    ["file_missing", "The copy is not in the folder any more."],
    ["no_engagement_folder", "This investigation has no folder."],
    ["invalid_argument", GENERIC],
    ["io:C:\\Users\\samil\\case\\photo.jpg could not be read", GENERIC],
  ];

  it.each(REFUSED)("%s, when the call is refused", async (code, words) => {
    rust({ tools: () => [tool("exiftool")], reject: { exiftool: code } });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));

    await userEvent.click(screen.getByRole("button", { name: "Run: Metadata (ExifTool)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    // A code the page has no words for is never shown as it came.
    if (words === GENERIC) expect(screen.getByRole("alert")).not.toHaveTextContent(code);
  });

  /** What a run row can carry: Rust's own word for how it ended. */
  const BLOCKED = (code: string): Partial<NativeToolRun> => ({
    state: "blocked",
    blockedReason: code,
    terminationReason: code,
  });
  const FAILED = (code: string): Partial<NativeToolRun> => ({ state: "failed", terminationReason: code });

  const ENDED: Array<[string, Partial<NativeToolRun>, string]> = [
    ["tool_path_missing", BLOCKED("tool_path_missing"), TOOL_GONE],
    ["tool_identity_changed", BLOCKED("tool_identity_changed"), TOOL_CHANGED],
    ["tool_disabled", BLOCKED("tool_disabled"), "The tool is turned off."],
    ["concurrency_limit_reached", BLOCKED("concurrency_limit_reached"), TOO_BUSY],
    ["exclusive_run_active", BLOCKED("exclusive_run_active"), TOO_BUSY],
    ["consent_revoked", BLOCKED("consent_revoked"), "Private Lab is off."],
    ["tool_not_registered", BLOCKED("tool_not_registered"), "The tool is not registered."],
    ["timeout", { state: "timed_out", terminationReason: "timeout" }, "The tool took too long and was stopped."],
    ["non_zero_exit", FAILED("non_zero_exit"), "The tool reported an error."],
    ["output_unreadable", FAILED("output_unreadable"), "The tool's output could not be read."],
    ["input_not_delivered", FAILED("input_not_delivered"), NOT_DELIVERED],
    ["spawn_failed", FAILED("spawn_failed"), NOT_STARTED],
    ["elevation_required", FAILED("elevation_required"), ELEVATION],
    ["user_cancelled", { state: "cancelled", terminationReason: "user_cancelled" }, "The scan was stopped."],
    ["emergency_stop", { state: "cancelled", terminationReason: "emergency_stop" }, "The scan was stopped."],
    ["app_restarted", { state: "orphaned", terminationReason: "app_restarted" }, APP_RESTARTED],
    ["io_error:permission_denied", BLOCKED("io_error:permission_denied"), GENERIC],
  ];

  it.each(ENDED)("%s, when a run ended with it", async (_code, ending, words) => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [nativeRun("exiftool", "file_2", { ...ending, observations: [] })],
    });
    render(<FileAnalysis file={PHOTO} />);

    expect(await screen.findByText(`Failed · ${words}`)).toBeInTheDocument();
  });

  it("gives a blocked run the same words whether it came back or was read from the list", async () => {
    rust({ tools: () => [tool("exiftool")], blocked: { exiftool: "tool_disabled" } });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));

    await userEvent.click(screen.getByRole("button", { name: "Run: Metadata (ExifTool)" }));

    expect(await screen.findByText("Failed · The tool is turned off.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("looks again after a refusal, so a scan that may still be going shows as running", async () => {
    let calls = 0;
    rust({
      tools: () => [tool("exiftool")],
      reject: { exiftool: "run_wait_timeout" },
      toolRuns: () => {
        calls += 1;
        return calls === 1 ? [] : [nativeRun("exiftool", "file_2", { state: "running", endedAt: undefined })];
      },
    });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));

    await userEvent.click(screen.getByRole("button", { name: "Run: Metadata (ExifTool)" }));

    expect(await screen.findByText("Running…")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("it may still be running");
  });
});

describe("outside programs: the install and check rows", () => {
  it("tells ExifTool's download name and YARA's minimum version", async () => {
    rust({ tools: () => [tool("exiftool", "not_installed"), tool("yara", "not_installed")] });
    render(<FileAnalysis file={FILE} />);

    expect(
      await screen.findByText("The download calls it exiftool(-k).exe. Rename it to exiftool.exe first."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("YARA must be version 4.2 or newer; Qutra Labs uses an option older versions lack."),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/is a separate program. Install it, then locate/)).toHaveLength(2);
  });

  it("asks to check a tool that was turned off or changed, and offers no run", async () => {
    rust({ tools: () => [tool("exiftool", "changed"), tool("yara", "disabled")] });
    useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE, RULES] } });
    render(<FileAnalysis file={FILE} />);

    expect(await screen.findAllByText("Check the tool")).toHaveLength(2);
    expect(screen.getAllByText(/turned off or has changed since you added it/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Run: (Metadata|YARA)/ })).toBeNull();
  });

  describe("a failed run says why, and what to fix first", () => {
    const failed = (toolId: string, fileId: string, code = "non_zero_exit") =>
      nativeRun(toolId, fileId, { state: "failed", terminationReason: code, observations: [] });

    it("offers to install a program that is gone, beside the reason the run failed", async () => {
      rust({
        tools: () => [tool("exiftool", "not_installed")],
        toolRuns: () => [failed("exiftool", "file_2", "tool_path_missing")],
      });
      render(<FileAnalysis file={PHOTO} />);

      expect(
        await screen.findByText(
          "Failed · The program is no longer where you registered it. Register it again under Registered tools.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Locate…: Metadata (ExifTool)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download page: Metadata (ExifTool)" })).toBeInTheDocument();
      expect(screen.getByText(/is a separate program. Install it, then locate exiftool.exe/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Run again: Metadata (ExifTool)" })).toBeNull();
    });

    it("offers Private Lab for a run that failed while it was off", async () => {
      rust({
        tools: () => [tool("exiftool", "needs_consent")],
        toolRuns: () => [failed("exiftool", "file_2", "consent_revoked")],
      });
      render(<FileAnalysis file={PHOTO} />);

      expect(await screen.findByText("Failed · Private Lab is off.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enable Private Lab: Metadata (ExifTool)" })).toBeInTheDocument();
      expect(screen.getByText("Programs outside Qutra Labs run only while Private Lab is on.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Run again: Metadata (ExifTool)" })).toBeNull();
    });

    it("asks for a rules file when YARA failed and none is kept", async () => {
      rust({ tools: () => [tool("yara")], toolRuns: () => [failed("yara", "file_1")] });
      useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE] } });
      render(<FileAnalysis file={FILE} />);

      expect(await screen.findByText("Failed · The tool reported an error.")).toBeInTheDocument();
      expect(screen.getByText(/Add a \.yar file to this investigation/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Run again: YARA rules/ })).toBeNull();
    });

    it("asks to check a tool that changed, beside the reason", async () => {
      rust({
        tools: () => [tool("exiftool", "changed")],
        toolRuns: () => [failed("exiftool", "file_2", "tool_identity_changed")],
      });
      render(<FileAnalysis file={PHOTO} />);

      expect(
        await screen.findByText(
          "Failed · The tool changed since you added it. Check it under Registered tools.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/turned off or has changed since you added it/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Run again: Metadata (ExifTool)" })).toBeNull();
    });

    it("keeps a finished result and says what to fix when its program is gone since", async () => {
      rust({
        tools: () => [tool("exiftool", "not_installed")],
        toolRuns: () => [nativeRun("exiftool", "file_2")],
      });
      render(<FileAnalysis file={PHOTO} />);

      expect(await screen.findByText(/^Done · /)).toBeInTheDocument();
      expect(screen.getByText("Canon EOS R6")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Locate…: Metadata (ExifTool)" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Run again: Metadata (ExifTool)" })).toBeNull();
    });

    it("adds nothing when the program is ready: the run can simply be run again", async () => {
      rust({ tools: () => [tool("exiftool")], toolRuns: () => [failed("exiftool", "file_2")] });
      render(<FileAnalysis file={PHOTO} />);

      expect(await screen.findByText("Failed · The tool reported an error.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Run again: Metadata (ExifTool)" })).toBeInTheDocument();
      expect(screen.queryByText(/is a separate program/)).toBeNull();
      expect(screen.queryByText(/turned off or has changed/)).toBeNull();
    });
  });

  it("opens the form that locates a program", async () => {
    const locateCandidate = vi.fn().mockResolvedValue(null);
    setBridgeForTesting({ mode: "tauri", toolSupervisor: { locateCandidate } } as unknown as DesktopBridge);
    rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);

    await userEvent.click(await screen.findByRole("button", { name: "Locate…: Metadata (ExifTool)" }));

    expect(locateCandidate).toHaveBeenCalledTimes(1);
  });

  const LOCATE_FAILED: Array<[string, string]> = [
    ["picker_unavailable", "The file picker could not open. Try again."],
    ["locate_dialog_failed", "The file picker could not open. Try again."],
    ["tool_already_registered", "This program is already registered. Check it under Registered tools."],
    ["registry_read_only", "The list of programs cannot be changed right now. Restart Qutra Labs; if this stays, update it."],
    ["unsupported_tool_type", "Only Windows programs (.exe files) can be added."],
    ["invalid_tool_filename", "That is not a usable program file. Choose the program's .exe file."],
    ["tool_path_not_file", "That is not a usable program file. Choose the program's .exe file."],
    ["invalid_tool_path", "That is not a usable program file. Choose the program's .exe file."],
    ["something_new", "The program could not be added. Try locating it again."],
    ["io:C:\\Users\\samil\\tool.exe is locked", "The program could not be added. Try locating it again."],
  ];

  it.each(LOCATE_FAILED)("says why locating a program failed: %s", async (code, words) => {
    const locateCandidate = vi.fn().mockRejectedValue(code);
    setBridgeForTesting({ mode: "tauri", toolSupervisor: { locateCandidate } } as unknown as DesktopBridge);
    rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);

    await userEvent.click(await screen.findByRole("button", { name: "Locate…: Metadata (ExifTool)" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    // A code is never shown as it came.
    expect(alert).not.toHaveTextContent(code);
  });

  it("keeps the words the locate flow gave when the reviewed pick can no longer be added", async () => {
    const located = {
      token: "cand-1",
      candidate: {
        canonicalPath: "C:\\Tools\\exiftool.exe",
        fileName: "exiftool.exe",
        sha256: "9f".repeat(32),
        sizeBytes: 10,
        version: "12.9",
        publisher: "",
        signatureState: "unsigned",
      },
      workingDir: "C:\\Tools",
    };
    const toolSupervisor = {
      locateCandidate: vi.fn().mockResolvedValue(located),
      register: vi.fn().mockRejectedValue("candidate_changed"),
    };
    setBridgeForTesting({ mode: "tauri", toolSupervisor } as unknown as DesktopBridge);
    rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);

    await userEvent.click(await screen.findByRole("button", { name: "Locate…: Metadata (ExifTool)" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm and add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file changed, or its review expired. Locate it again.",
    );
  });

  it("says so when the download page cannot be opened", async () => {
    const openUrl = vi.fn().mockResolvedValue({ ok: false, simulated: false });
    setBridgeForTesting({ mode: "tauri", openUrl } as unknown as DesktopBridge);
    rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);

    await userEvent.click(await screen.findByRole("button", { name: "Download page: Metadata (ExifTool)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The download page could not be opened: https://example.invalid/exiftool",
    );
  });

  it("says so when opening the download page is refused", async () => {
    const openUrl = vi.fn().mockRejectedValue("blocked");
    setBridgeForTesting({ mode: "tauri", openUrl } as unknown as DesktopBridge);
    rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);

    await userEvent.click(await screen.findByRole("button", { name: "Download page: Metadata (ExifTool)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The download page could not be opened");
  });

  it("clears that line when the page opens the next time", async () => {
    const openUrl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, simulated: false })
      .mockResolvedValue({ ok: true, simulated: false });
    setBridgeForTesting({ mode: "tauri", openUrl } as unknown as DesktopBridge);
    rust({ tools: () => [tool("exiftool", "not_installed")] });
    render(<FileAnalysis file={PHOTO} />);
    const download = await screen.findByRole("button", { name: "Download page: Metadata (ExifTool)" });

    await userEvent.click(download);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(download);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("lets the user choose among several rules files", async () => {
    const MORE: InvestigationFile = { ...RULES, id: "file_more", name: "more.yar", originalName: "more.yar" };
    rust({ tools: () => [tool("yara")] });
    useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE, RULES, MORE] } });
    render(<FileAnalysis file={FILE} />);

    await userEvent.selectOptions(await screen.findByRole("combobox"), "file_more");
    await userEvent.click(screen.getByRole("button", { name: "Run: YARA rules" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("external_tool_run", {
        engagementId: "eng_1",
        fileId: "file_1",
        tool: "yara",
        rulesFileId: "file_more",
      }),
    );
  });
});

describe("outside programs: what the results say about themselves", () => {
  const yaraRun = (extra: Partial<NativeToolRun> = {}) =>
    nativeRun("yara", "file_1", {
      observations: [obs("yara.rulesFile", "rules.yar", "summary"), obs("yara.count", 2, "summary")],
      ...extra,
    });

  it("says a cut output may hide results, naming the tool", async () => {
    rust({ tools: () => [tool("yara")], toolRuns: () => [yaraRun({ truncated: true })] });
    useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE, RULES] } });
    render(<FileAnalysis file={FILE} />);

    expect(
      await screen.findByText("YARA rules: The output was cut; the results may be incomplete."),
    ).toBeInTheDocument();
    // Not the built-in steps' note about a file that was read only in part.
    expect(screen.queryByText(/Stopped at a size or time limit/)).toBeNull();
  });

  it("says nothing of the kind when the output was whole", async () => {
    rust({ tools: () => [tool("yara")], toolRuns: () => [yaraRun()] });
    useInvestigationFiles.setState({ byEngagement: { eng_1: [FILE, RULES] } });
    render(<FileAnalysis file={FILE} />);

    expect(await screen.findByText("Matching rules")).toBeInTheDocument();
    expect(screen.queryByText(/The output was cut/)).toBeNull();
  });

  it("shows an error fact beside other facts as a warning, not as no result", async () => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [
        nativeRun("exiftool", "file_2", {
          state: "failed",
          terminationReason: "non_zero_exit",
          observations: [
            obs("exiftool.type", "JPEG", "summary"),
            obs("exiftool.error", "Truncated JPEG", "summary"),
          ],
        }),
      ],
    });
    render(<FileAnalysis file={PHOTO} />);

    const error = await screen.findByText("Truncated JPEG");
    expect(error.closest("div")).toHaveClass("is-warn");
    expect(screen.getByText("JPEG").closest("div")).not.toHaveClass("is-warn");
    expect(
      screen.getByText(
        "Metadata (ExifTool) reported an error but still read part of the file; the results may be incomplete.",
      ),
    ).toBeInTheDocument();
  });

  it("does not call a lone error fact a partial result", async () => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [
        nativeRun("exiftool", "file_2", {
          state: "failed",
          terminationReason: "non_zero_exit",
          observations: [obs("exiftool.error", "File is empty", "summary")],
        }),
      ],
    });
    render(<FileAnalysis file={PHOTO} />);

    expect((await screen.findByText("File is empty")).closest("div")).toHaveClass("is-warn");
    expect(screen.queryByText(/but still read part of the file/)).toBeNull();
  });

  it("keeps a flagged fact of a program as evidence, with the program as its source", async () => {
    rust({ tools: () => [tool("exiftool")], toolRuns: () => [nativeRun("exiftool", "file_2")] });
    render(<FileAnalysis file={PHOTO} />);

    await userEvent.click(await screen.findByRole("button", { name: "Keep as evidence: Location" }));

    await waitFor(() => expect(getDb().collection("evidence").getAll()).toHaveLength(1));
    expect(getDb().collection("evidence").getAll()[0]).toMatchObject({
      source: "tool:exiftool",
      sensitivity: "sensitive",
      title: "Location",
      fileId: "file_2",
      rawRef: { relPath: "runs/exiftool/stdout.log", sha256: "00" },
    });
  });
});

describe("outside programs: the ledger is read again where it can have changed", () => {
  const listCalls = () => invoke.mock.calls.filter(([command]) => command === "external_tools_list").length;

  it("reads the tools again after a run that came back blocked, so the row says what to fix", async () => {
    let lists = 0;
    rust({
      tools: () => [tool("exiftool", (lists += 1) === 1 ? "ready" : "changed")],
      blocked: { exiftool: "tool_identity_changed" },
    });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));

    await userEvent.click(screen.getByRole("button", { name: "Run: Metadata (ExifTool)" }));

    expect(await screen.findByText(/turned off or has changed since you added it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again: Metadata (ExifTool)" })).toBeNull();
  });

  it("does not read them again after a run that finished", async () => {
    rust({ tools: () => [tool("exiftool")] });
    render(<FileAnalysis file={PHOTO} />);
    await waitFor(() => ready(runSuggested()));
    expect(listCalls()).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Run: Metadata (ExifTool)" }));

    expect(await screen.findByText("Canon EOS R6")).toBeInTheDocument();
    expect(listCalls()).toBe(1);
  });

  it("does not read the logs again each time it looks at a run that is still going", async () => {
    let ledger = 0;
    rust({
      tools: () => [tool("exiftool"), tool("yara")],
      toolRuns: () => {
        ledger += 1;
        return [
          nativeRun("exiftool", "file_2", {
            id: "run-exiftool-fixed",
            outputs: [
              { name: "stdout.log", relPath: "runs/x/stdout.log", sha256: "00", bytes: 5 },
              { name: "stderr.log", relPath: "runs/x/stderr.log", sha256: "11", bytes: 3 },
            ],
          }),
          nativeRun("yara", "file_2", { state: "running", endedAt: undefined }),
        ];
      },
      output: (name) => `text of ${name}`,
    });
    render(<FileAnalysis file={PHOTO} />);
    const details = (await screen.findByText("Show raw output")).closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("text of stderr.log")).toBeInTheDocument();
    const reads = () => invoke.mock.calls.filter(([command]) => command === "tool_run_output").length;
    expect(reads()).toBe(2);

    // Two more looks at the ledger, each with new objects for the same run.
    await waitFor(() => expect(ledger).toBeGreaterThanOrEqual(3), { timeout: 6000 });

    expect(reads()).toBe(2);
    expect(screen.getByText("text of stdout.log")).toBeInTheDocument();
  }, 10_000);
});

describe("outside programs: the raw output", () => {
  const twoLogs = () =>
    nativeRun("exiftool", "file_2", {
      outputs: [
        { name: "stdout.log", relPath: "runs/x/stdout.log", sha256: "00", bytes: 5 },
        { name: "stderr.log", relPath: "runs/x/stderr.log", sha256: "11", bytes: 3 },
      ],
    });
  const open = async () => {
    const details = (await screen.findByText("Show raw output")).closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
  };

  it("reads what the program printed and what it said, each under its own heading", async () => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [twoLogs()],
      output: (name) => `text of ${name}`,
    });
    render(<FileAnalysis file={PHOTO} />);
    await open();

    expect(await screen.findByText("text of stdout.log")).toBeInTheDocument();
    expect(screen.getByText("text of stderr.log")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("Messages from the tool")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("tool_run_output", expect.objectContaining({ name: "stderr.log" }));
  });

  it("leaves out a log with nothing in it, and says so when there is none left", async () => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [
        nativeRun("exiftool", "file_2", {
          outputs: [{ name: "stdout.log", relPath: "runs/x/stdout.log", sha256: "00", bytes: 0 }],
        }),
      ],
    });
    render(<FileAnalysis file={PHOTO} />);
    await open();

    expect(await screen.findByText("The tool printed nothing.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("tool_run_output", expect.anything());
  });

  it("does not show an output that no longer matches its hash", async () => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [twoLogs()],
      output: (name) => (name === "stdout.log" ? Promise.reject("output_changed") : "text of stderr.log"),
    });
    render(<FileAnalysis file={PHOTO} />);
    await open();

    expect(
      await screen.findByText(
        "The saved output was changed after the scan (its hash no longer matches), so it is not shown.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("text of stderr.log")).toBeNull();
    expect(screen.queryByText("The raw output could not be read.")).toBeNull();
  });

  it("says the output could not be read for any other reason", async () => {
    rust({
      tools: () => [tool("exiftool")],
      toolRuns: () => [twoLogs()],
      output: () => Promise.reject("output_missing"),
    });
    render(<FileAnalysis file={PHOTO} />);
    await open();

    expect(await screen.findByText("The raw output could not be read.")).toBeInTheDocument();
  });
});
