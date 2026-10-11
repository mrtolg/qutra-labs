import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngagementSchema } from "@/domain/lab";
import type { AnalysisRun } from "@/lib/analysis";
import type { NativeToolRun } from "@/lib/bridge/types";
import { translate, type MessageKey } from "@/lib/i18n";
import type { InvestigationFile } from "@/lib/investigationFiles";

/* What the summary gathers from the app's own commands. The
   block may go to a cloud assistant after consent, so a program's run
   reaches it through its observations only. */

const T = 1_760_000_000_000;
const t = (key: MessageKey, params?: Record<string, string | number>) => translate("en", key, params);

const mocks = vi.hoisted(() => ({
  filesList: vi.fn(),
  analysisList: vi.fn(),
  toolsAvailable: vi.fn(),
  toolsRuns: vi.fn(),
}));

vi.mock("@/lib/investigationFiles", async (original) => ({
  ...(await original<typeof import("@/lib/investigationFiles")>()),
  investigationFiles: { available: () => true, list: mocks.filesList },
}));
vi.mock("@/lib/analysis", async (original) => ({
  ...(await original<typeof import("@/lib/analysis")>()),
  analysis: { available: () => true, list: mocks.analysisList },
}));
vi.mock("@/lib/externalTools", () => ({
  externalTools: { available: mocks.toolsAvailable, runs: mocks.toolsRuns },
}));

const engagement = EngagementSchema.parse({
  id: "eng-1",
  title: "Home Lab",
  status: "active",
  createdAt: T,
  updatedAt: T,
});

vi.mock("@/lib/db/database", () => ({
  getDb: () => ({
    collection: (name: string) => ({
      get: (id: string) => (name === "engagements" && id === "eng-1" ? engagement : undefined),
      getAll: () => [],
    }),
  }),
}));

import { useLabRuntime } from "@/state/labRuntime";
import { loadInvestigationSummary } from "./investigationSummary";

const photo: InvestigationFile = {
  id: "f2",
  engagementId: "eng-1",
  relPath: "files/IMG_0042.jpg",
  name: "IMG_0042.jpg",
  originalName: "IMG_0042.jpg",
  bytes: 10,
  sha256: "ab".repeat(32),
  sha1: "cd".repeat(20),
  md5: "ef".repeat(16),
  kind: "jpeg",
  sample: false,
  source: "picked",
  addedAt: T,
  missing: false,
  readOnly: true,
};

const external: AnalysisRun = {
  id: "run-00000000-0000-4000-8000-000000000009",
  kind: "external",
  engagementId: "eng-1",
  fileId: "f2",
  analyzer: "exiftool",
  state: "finished",
  startedAt: T,
  endedAt: T,
  trigger: { by: "user" },
  fileSha256: "ab".repeat(32),
  limited: false,
  observations: [
    { id: "x1", key: "exiftool.gps", value: "41.008200, 28.978400", group: "interesting" },
    { id: "x2", key: "exiftool.software", value: "Photoshop 25", group: "interesting" },
  ],
  outputs: [],
};

const copy = "C:\\Users\\bob\\AppData\\Roaming\\qutra\\files\\copy-9f2c.jpg";
const ledger = (overrides: Partial<NativeToolRun>): NativeToolRun =>
  ({
    id: "r",
    engagementId: "eng-1",
    state: "succeeded",
    commandPreview: "",
    argv: [],
    stdoutTail: "",
    stderrTail: "",
    ...overrides,
  }) as NativeToolRun;

beforeEach(() => {
  mocks.filesList.mockReset().mockResolvedValue([photo]);
  mocks.analysisList.mockReset().mockResolvedValue([]);
  mocks.toolsAvailable.mockReset().mockReturnValue(true);
  mocks.toolsRuns.mockReset().mockResolvedValue([external]);
  useLabRuntime.setState({
    runs: [
      ledger({ id: "old", commandPreview: "nmap -sV 192.168.1.10" }),
      ledger({
        id: "described",
        descriptorId: "exiftool",
        commandPreview: `ExifTool -json ${copy}`,
        argv: ["-json", copy],
        stdoutTail: `STDOUT-TAIL ${copy}`,
        stderrTail: `STDERR-TAIL ${copy}`,
      }),
      ledger({ id: "elsewhere", engagementId: "eng-2", commandPreview: "whois other.example" }),
    ],
  });
});

describe("the summary of an investigation, as the app gathers it", () => {
  it("tells an outside program's observations, and its run only as a finding of the file", async () => {
    const text = (await loadInvestigationSummary("eng-1", t, "en"))!;
    expect(mocks.toolsRuns).toHaveBeenCalledWith("eng-1");
    expect(text).toContain("- IMG_0042.jpg (JPEG image) · Metadata (ExifTool) · Location; Software: Photoshop 25");
    // The old Tools tab's command is told, as before; the program's own run is not.
    expect(text).toContain("- nmap -sV 192.168.1.10 · Succeeded");
    expect(text).not.toMatch(/-json|copy-9f2c|AppData|Roaming|STDOUT-TAIL|STDERR-TAIL|whois|41\.0082/);
  });

  it("says nothing of them without Private Lab, or in the browser build", async () => {
    // The built-in steps are still told; only the programs' runs are missing.
    mocks.analysisList.mockResolvedValue([
      { ...external, id: "ana-1", kind: "builtin", analyzer: "image", observations: [{ id: "i1", key: "image.camera", value: "Canon", group: "interesting" }] },
    ]);
    mocks.toolsRuns.mockRejectedValue("private_tools_consent_required");
    const refused = (await loadInvestigationSummary("eng-1", t, "en"))!;
    expect(refused).toContain("- IMG_0042.jpg (JPEG image) · Photo metadata · Camera: Canon");
    expect(refused).not.toContain("ExifTool");

    mocks.toolsRuns.mockClear();
    mocks.toolsAvailable.mockReturnValue(false);
    const browser = (await loadInvestigationSummary("eng-1", t, "en"))!;
    expect(mocks.toolsRuns).not.toHaveBeenCalled();
    expect(browser).toContain("- IMG_0042.jpg (JPEG image) · Photo metadata · Camera: Canon");
    expect(browser).not.toContain("ExifTool");
  });

  it("is null when the investigation is gone", async () => {
    await expect(loadInvestigationSummary("eng-9", t, "en")).resolves.toBeNull();
  });
});
