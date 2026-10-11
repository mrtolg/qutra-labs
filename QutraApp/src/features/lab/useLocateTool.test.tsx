import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import type { NativeLocatedCandidate, NativeToolInstallation } from "@/lib/bridge/types";
import { useLabRuntime } from "@/state/labRuntime";
import { ensureLocaleLoaded } from "@/lib/i18n";
import { toolLogos } from "@/lib/toolLogos";
import { useFetchedLogos } from "@/features/tools/logos/fetchedLogos";
import { useLocateTool, type LocatePreset } from "./useLocateTool";

/* Locate is one flow for the Lab's tool library and the tool launcher. From
   a launcher tile the review starts with that tile's program: its name, a
   category to begin with, and the binding the user picked the tile for. The
   user still confirms all of it. */

const LOCATED: NativeLocatedCandidate = {
  token: "cand-3b1f07c2-9d4e-4a8b-b6f1-52e0c9a7d813",
  candidate: {
    canonicalPath: "\\\\?\\C:\\Program Files\\ZAP\\Zed Attack Proxy\\zap.exe",
    fileName: "zap.exe",
    sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
    sizeBytes: 2_977_792,
    version: "2.15.0",
    publisher: "ZAP",
    signatureState: "valid",
  },
  workingDir: "\\\\?\\C:\\Program Files\\ZAP\\Zed Attack Proxy",
};

const SAVED: NativeToolInstallation = {
  id: "tool-f47e2b90-58c1-4d6a-a3e7-1c9d05b8f2aa",
  displayName: "OWASP ZAP",
  runner: "executable",
  canonicalPath: LOCATED.candidate.canonicalPath,
  sha256: LOCATED.candidate.sha256,
  sizeBytes: LOCATED.candidate.sizeBytes,
  version: LOCATED.candidate.version,
  publisher: LOCATED.candidate.publisher,
  signatureState: "valid",
  category: "web",
  riskTier: "low",
  docUrl: "",
  tags: [],
  workingDir: LOCATED.workingDir,
  enabled: true,
  changedSinceVerify: false,
  createdAt: 1_790_800_000_000,
  updatedAt: 1_790_800_000_000,
  lastVerifiedAt: 1_790_800_000_000,
};

const ZAP: LocatePreset = { catalogId: "zap", name: "OWASP ZAP", category: "web" };

function Harness({ preset }: { preset?: LocatePreset }) {
  const [error, setError] = useState("");
  const locator = useLocateTool({ onError: setError });
  return (
    <>
      <button type="button" onClick={() => void locator.locate(preset)}>
        Locate
      </button>
      <output data-testid="error">{error}</output>
      {locator.dialog}
    </>
  );
}

function mount(preset?: LocatePreset, locale: "en" | "tr" = "en") {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ privateToolsEnabled: true, locale });
  setDbForTesting(db);
  const register = vi.fn().mockResolvedValue(SAVED);
  setBridgeForTesting({
    mode: "tauri",
    toolSupervisor: {
      available: () => true,
      locateCandidate: vi.fn().mockResolvedValue(LOCATED),
      register,
    },
  } as unknown as DesktopBridge);
  useLabRuntime.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
  render(<Harness preset={preset} />);
  return register;
}

const realRefresh = useLabRuntime.getState().refresh;

// The Turkish case needs its catalog; without this it passed only when an
// earlier file in the same worker had loaded it.
beforeAll(async () => {
  await ensureLocaleLoaded("tr");
});

afterEach(() => {
  useLabRuntime.setState({ refresh: realRefresh });
  useFetchedLogos.setState({ byId: {}, pending: {} });
  setDbForTesting(null);
  resetBridgeForTesting();
  vi.restoreAllMocks();
});

describe("useLocateTool", () => {
  it("starts the review with the program the user picked a tile for", async () => {
    const register = mount(ZAP);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Locate" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("OWASP ZAP");
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("web");

    await user.click(screen.getByRole("button", { name: "Confirm and add" }));
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(register.mock.calls[0]![0]).toMatchObject({
      candidateToken: LOCATED.token,
      displayName: "OWASP ZAP",
      category: "web",
      confirmed: true,
    });
    expect(getDb().collection("installationBindings").getAll()).toEqual([
      expect.objectContaining({ installationId: SAVED.id, catalogId: "zap" }),
    ]);
  });

  it("offers category and risk choices in the user's language", async () => {
    mount(undefined, "tr");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Locate" }));
    await screen.findByRole("option", { name: "Ağ güvenliği" });
    expect(screen.getByRole("option", { name: "Orta" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "network" })).toBeNull();
    expect(screen.queryByRole("option", { name: "medium" })).toBeNull();
  });

  it("keeps the tile's official page as the documentation address", async () => {
    const fetch = vi.spyOn(toolLogos, "fetch");
    const register = mount({ ...ZAP, docUrl: "https://www.zaproxy.org/download/" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Locate" }));
    expect(await screen.findByRole("textbox", { name: "Documentation URL" })).toHaveValue(
      "https://www.zaproxy.org/download/",
    );
    // ZAP's logo ships with the app: nothing to fetch, nothing to announce.
    expect(screen.queryByTestId("register-logo-note")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm and add" }));
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says where a program's logo will come from and asks for it once after the click", async () => {
    const docUrl = "https://github.com/robertdavidgraham/masscan";
    const fetch = vi.spyOn(toolLogos, "fetch").mockResolvedValue({
      installationId: SAVED.id,
      state: "none",
      dataUrl: null,
      source: null,
      plate: null,
    });
    const register = mount({ catalogId: "masscan", name: "Masscan", category: "network", docUrl });
    register.mockResolvedValue({ ...SAVED, displayName: "Masscan", docUrl });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Locate" }));
    expect(await screen.findByTestId("register-logo-note")).toHaveTextContent(
      "Its official logo will be downloaded once from github.com.",
    );
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm and add" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(SAVED.id));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches no logo while the setting is off", async () => {
    const docUrl = "https://github.com/robertdavidgraham/masscan";
    const fetch = vi.spyOn(toolLogos, "fetch");
    const register = mount({ catalogId: "masscan", name: "Masscan", category: "network", docUrl });
    register.mockResolvedValue({ ...SAVED, displayName: "Masscan", docUrl });
    getDb().prefs.set({ toolLogoFetch: false });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Locate" }));
    await screen.findByRole("textbox", { name: "Documentation URL" });
    expect(screen.queryByTestId("register-logo-note")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm and add" }));
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(fetch).not.toHaveBeenCalled();
  });
});
