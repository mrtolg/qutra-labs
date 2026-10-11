import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting } from "@/lib/bridge";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import type { AuthorizationScope, Engagement } from "@/domain/lab";
import { formFor } from "@/domain/tools/toolForms";
import { ToolFormRunner } from "./ToolFormRunner";

const run = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toolForms", () => ({ toolFormRuns: { run, output: vi.fn() } }));

const nmap: NativeToolInstallation = {
  id: "tool-nmap",
  displayName: "Nmap",
  runner: "executable",
  canonicalPath: "C:\\Program Files (x86)\\Nmap\\nmap.exe",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  version: "7.99",
  publisher: "",
  signatureState: "valid",
  category: "network",
  riskTier: "medium",
  docUrl: "",
  tags: [],
  workingDir: "C:\\Program Files (x86)\\Nmap",
  enabled: true,
  changedSinceVerify: false,
  createdAt: 1,
  updatedAt: 1,
  lastVerifiedAt: 1,
};

const engagement = { id: "eng-1", title: "Lab", scopeId: "scope-1" } as Engagement;
const scope: AuthorizationScope = {
  id: "scope-1",
  engagementId: "eng-1",
  ownerLabel: "",
  description: "",
  allowedTargets: ["203.0.113.0/24"],
  excludedTargets: [],
  authorizationRef: "",
  testerAck: true,
  notes: "",
  revision: 4,
  demo: false,
  createdAt: 1,
  updatedAt: 1,
};

function renderRunner(state: "ready" | "disabled" = "ready") {
  const onStarted = vi.fn();
  render(
    <ToolFormRunner
      installation={nmap}
      form={formFor(nmap)!}
      state={state}
      engagement={engagement}
      scope={scope}
      targets={[]}
      onStarted={onStarted}
    />,
  );
  return onStarted;
}

beforeEach(() => {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true, locale: "en" });
  setDbForTesting(db);
  run.mockReset();
  run.mockResolvedValue({ run: { id: "run-1", state: "running" }, outputName: null });
});

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
});

describe("a tool's run form", () => {
  it("sends the form, the preset and the values with a scope decision about that target, never flags", async () => {
    const user = userEvent.setup();
    const onStarted = renderRunner();
    await user.click(screen.getByRole("radio", { name: "Chosen ports" }));
    await user.type(screen.getByLabelText("Target"), "203.0.113.5");
    await user.clear(screen.getByLabelText("Ports"));
    await user.type(screen.getByLabelText("Ports"), "22,443");
    expect(screen.getByText(/Nmap checks ports/)).toHaveTextContent("22,443");
    await user.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const request = run.mock.calls[0]![0];
    expect(request).toEqual({
      installationId: "tool-nmap",
      formId: "nmap",
      presetId: "ports",
      engagementId: "eng-1",
      targetId: undefined,
      values: { target: "203.0.113.5", ports: "22,443" },
      scope: expect.objectContaining({
        scopeId: "scope-1",
        scopeRevision: 4,
        target: "203.0.113.5",
        allowed: true,
        reason: "allowed_in_scope",
      }),
    });
    expect(JSON.stringify(request)).not.toMatch(/-sT|-oX|argv/);
    expect(onStarted).toHaveBeenCalled();
  });

  it("does not run a target outside the scope, and says so before the click", async () => {
    const user = userEvent.setup();
    renderRunner();
    await user.type(screen.getByLabelText("Target"), "198.51.100.7");
    expect(screen.getByTestId("wb-scope-verdict")).toHaveClass("is-blocked");
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a value that could pass for a flag", async () => {
    const user = userEvent.setup();
    renderRunner();
    await user.type(screen.getByLabelText("Target"), "-iL list.txt");
    await user.tab();
    // Under the field, and as the reason the run is held.
    expect(screen.getAllByText("Target is not valid.").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".wb-field__note.is-error")).toHaveTextContent("Target is not valid.");
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("does not run a disabled program", () => {
    renderRunner("disabled");
    expect(screen.getByText("This tool is disabled. Turn it on under Status.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });
});
