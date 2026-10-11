import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { useLabRuntime } from "@/state/labRuntime";
import { ToolGuidesView } from "./ToolGuidesView";
import { getPrivateLabCopy } from "./toolGuidesData";

/**
 * The guide catalog shows a tool as registered only when the user bound an
 * installation to it (data contracts §6). A registered program whose name happens
 * to be "nmap" is not thereby the Nmap guide's installation.
 */

const copy = getPrivateLabCopy("en");
const NMAP_INSTALL = "tool-6c0d2f9a-1e7b-4c35-8a92-d4b1f03e7c58";

const nmap: NativeToolInstallation = {
  id: NMAP_INSTALL,
  displayName: "nmap",
  runner: "executable",
  canonicalPath: "\\\\?\\C:\\Program Files (x86)\\Nmap\\nmap.exe",
  sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
  sizeBytes: 2_977_792,
  version: "7.95.0.0",
  publisher: "Insecure.Com LLC",
  signatureState: "valid",
  category: "network",
  riskTier: "medium",
  docUrl: "https://nmap.org/book/man.html",
  tags: ["nmap"],
  workingDir: "\\\\?\\C:\\Program Files (x86)\\Nmap",
  enabled: true,
  changedSinceVerify: false,
  createdAt: 1_790_800_000_000,
  updatedAt: 1_790_800_000_000,
  lastVerifiedAt: 1_790_800_000_000,
};

function mount(bound: boolean) {
  const db = new Database(new MemoryStorageAdapter());
  if (bound) {
    db.collection("installationBindings").put({
      id: NMAP_INSTALL,
      catalogId: "nmap",
      installationId: NMAP_INSTALL,
      confirmedAt: 1_790_800_100_000,
    });
  }
  setDbForTesting(db);
  useLabRuntime.setState({ installations: [nmap], runs: [] });
  render(
    <MemoryRouter>
      <ToolGuidesView tab="catalog" />
    </MemoryRouter>,
  );
}

function rowsNamed(name: string) {
  return screen
    .getAllByRole("row")
    .filter((row) => within(row).queryByText(name, { selector: "strong" }));
}

beforeAll(() => {
  // jsdom has no element scrolling; the inspector scrolls to top on select.
  Element.prototype.scrollTo ??= () => {};
});

afterEach(() => {
  useLabRuntime.setState({ installations: [] });
  setDbForTesting(null);
});

describe("ToolGuidesView registration status", () => {
  it("shows the guide as registered through its binding", () => {
    mount(true);
    const [row] = rowsNamed("Nmap");
    expect(within(row).getByText(copy.verifiedNative)).toBeInTheDocument();
    // The bound installation is not listed a second time on its own.
    expect(rowsNamed("nmap")).toHaveLength(0);
  });

  it("does not infer the binding from the program's name", () => {
    mount(false);
    const [guide] = rowsNamed("Nmap");
    expect(within(guide).getByText(copy.notRegistered)).toBeInTheDocument();
    // The program is still listed, as itself.
    expect(rowsNamed("nmap")).toHaveLength(1);
  });
});
