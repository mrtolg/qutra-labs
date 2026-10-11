import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvidenceSchema } from "@/domain/findings";
import { analysis } from "@/lib/analysis";
import { externalTools } from "@/lib/externalTools";
import { sha256Hex } from "@/lib/hash";
import { EvidenceOrigin } from "./EvidenceOrigin";

/* A piece of evidence says where it came from, and the raw output
   of a built-in analysis is checked again against the hash kept with it. */

vi.mock("@/lib/analysis", () => ({
  analysis: { available: () => true, output: vi.fn() },
}));
vi.mock("@/lib/externalTools", () => ({
  externalTools: { available: () => true, output: vi.fn() },
}));

const RUN = "ana-00000000-0000-4000-8000-000000000001";
const RAW = "entropy.file 7.91\n";

const observation = (sha256: string) =>
  EvidenceSchema.parse({
    id: "ev_obs",
    engagementId: "eng_1",
    runId: RUN,
    fileId: "file_1",
    kind: "observation",
    observationIds: [`${RUN}:0`],
    title: "Entropy: 7.91",
    source: "analysis:entropy",
    rawRef: { relPath: `analysis/${RUN}/output.txt`, sha256 },
    capturedAt: 1_760_000_000_000,
    createdAt: 1,
  });

// A braced body: a hook that returns the mock would have it called as a teardown.
beforeEach(() => {
  vi.mocked(analysis.output).mockReset();
  vi.mocked(externalTools.output).mockReset();
});

describe("EvidenceOrigin", () => {
  it("names the built-in analysis step an observation came from", () => {
    render(<EvidenceOrigin evidence={observation("0".repeat(64))} />);
    expect(screen.getByText(/^Built-in analysis · Entropy · /)).toBeInTheDocument();
  });

  it("opens the raw output and says it is the one kept with the evidence", async () => {
    vi.mocked(analysis.output).mockResolvedValue(RAW);
    render(<EvidenceOrigin evidence={observation(await sha256Hex(RAW))} />);

    await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

    expect(
      await screen.findByText("The raw output is the one kept with this evidence."),
    ).toBeInTheDocument();
    expect(analysis.output).toHaveBeenCalledWith(RUN);
    expect(screen.getByText("entropy.file 7.91")).toBeInTheDocument();
    const hide = screen.getByRole("button", { name: "Hide the raw output" });
    expect(hide).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(hide);
    expect(screen.queryByText("entropy.file 7.91")).toBeNull();
  });

  it("says so when the raw output changed after the evidence was kept", async () => {
    vi.mocked(analysis.output).mockResolvedValue(`${RAW}edited\n`);
    render(<EvidenceOrigin evidence={observation(await sha256Hex(RAW))} />);

    await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

    expect(
      await screen.findByText("The raw output has changed since this evidence was kept."),
    ).toBeInTheDocument();
    expect(screen.queryByText("The raw output is the one kept with this evidence.")).toBeNull();
  });

  it("says when no hash was kept to compare with", async () => {
    vi.mocked(analysis.output).mockResolvedValue(RAW);
    render(<EvidenceOrigin evidence={{ ...observation("0".repeat(64)), rawRef: undefined }} />);

    await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

    expect(
      await screen.findByText("No hash was kept with this evidence, so it cannot be compared."),
    ).toBeInTheDocument();
    expect(screen.getByText("entropy.file 7.91")).toBeInTheDocument();
  });

  it("says so when the raw output cannot be read", async () => {
    vi.mocked(analysis.output).mockRejectedValue("output_missing");
    render(<EvidenceOrigin evidence={observation(await sha256Hex(RAW))} />);

    await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

    expect(await screen.findByText("The raw output could not be read.")).toBeInTheDocument();
  });

  describe("the log of an outside tool's run", () => {
    const RUN_ID = "run-00000000-0000-4000-8000-000000000009";
    const RAW = '[{"File:FileType":"JPEG"}]\n';
    const fromTool = async (overrides: Record<string, unknown> = {}) =>
      EvidenceSchema.parse({
        id: "ev_tool",
        engagementId: "eng_1",
        runId: RUN_ID,
        fileId: "file_1",
        kind: "observation",
        observationIds: [`${RUN_ID}:0`],
        title: "Camera: Canon",
        source: "tool:exiftool",
        rawRef: { relPath: `runs/${RUN_ID}/stdout.log`, sha256: await sha256Hex(RAW) },
        capturedAt: 1_760_000_000_000,
        createdAt: 1,
        ...overrides,
      });

    it("opens the log of a tool's run and checks it against the hash kept with the evidence", async () => {
      vi.mocked(externalTools.output).mockResolvedValue(RAW);
      render(<EvidenceOrigin evidence={await fromTool()} />);
      expect(screen.getByText(/^Outside tool · Metadata \(ExifTool\) · /)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));
      expect(await screen.findByText("The raw output is the one kept with this evidence.")).toBeInTheDocument();
      expect(externalTools.output).toHaveBeenCalledWith(RUN_ID);
      expect(analysis.output).not.toHaveBeenCalled();
    });

    it("says so when the log changed since the evidence was kept", async () => {
      vi.mocked(externalTools.output).mockResolvedValue(`${RAW}edited\n`);
      render(<EvidenceOrigin evidence={await fromTool()} />);

      await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

      expect(
        await screen.findByText("The raw output has changed since this evidence was kept."),
      ).toBeInTheDocument();
    });

    it("does not show a log that no longer matches the hash Rust kept, and says why", async () => {
      vi.mocked(externalTools.output).mockRejectedValue("output_changed");
      render(<EvidenceOrigin evidence={await fromTool()} />);

      await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

      expect(
        await screen.findByText(
          "The saved output was changed after the scan (its hash no longer matches), so it is not shown.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("The raw output could not be read.")).toBeNull();
      expect(document.querySelector("pre")).toBeNull();
    });

    it("says Private Lab is off when that is why the log was refused", async () => {
      vi.mocked(externalTools.output).mockRejectedValue("private_tools_consent_required");
      render(<EvidenceOrigin evidence={await fromTool()} />);

      await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

      expect(await screen.findByText("Private Lab is off.")).toBeInTheDocument();
    });

    it("says the log could not be read for any other reason", async () => {
      vi.mocked(externalTools.output).mockRejectedValue("output_missing");
      render(<EvidenceOrigin evidence={await fromTool()} />);

      await userEvent.click(screen.getByRole("button", { name: "Open the raw output" }));

      expect(await screen.findByText("The raw output could not be read.")).toBeInTheDocument();
    });

    it("offers no log when the browser build has no programs", async () => {
      const available = vi.spyOn(externalTools, "available").mockReturnValue(false);
      render(<EvidenceOrigin evidence={await fromTool()} />);

      expect(screen.getByText(/^Outside tool · /)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open the raw output" })).toBeNull();
      available.mockRestore();
    });
  });

  it("names a scan output and a note added by hand, with nothing to open", () => {
    const base = { engagementId: "eng_1", capturedAt: 1_760_000_000_000, createdAt: 1 };
    const { rerender } = render(
      <EvidenceOrigin
        evidence={EvidenceSchema.parse({
          ...base,
          id: "ev_out",
          kind: "output",
          runId: "run_1",
          title: "nmap -sV 10.0.0.1",
          source: "run:run_1",
        })}
      />,
    );
    expect(screen.getByText(/^Scan output · /)).toBeInTheDocument();

    rerender(
      <EvidenceOrigin
        evidence={EvidenceSchema.parse({ ...base, id: "ev_imp", kind: "file", title: "scan.sarif", source: "import:sarif" })}
      />,
    );
    expect(screen.getByText(/^Imported scan · /)).toBeInTheDocument();

    rerender(
      <EvidenceOrigin
        evidence={EvidenceSchema.parse({ ...base, id: "ev_txt", title: "Note", source: "manual" })}
      />,
    );
    expect(screen.getByText("Added by hand")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
