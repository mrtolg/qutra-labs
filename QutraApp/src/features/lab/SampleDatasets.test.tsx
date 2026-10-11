import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { sampleData } from "@/lib/sampleData";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { ToolGuidesView } from "./ToolGuidesView";

const file: InvestigationFile = {
  id: "file-864d1497-8b11-42f8-9687-e758a6dc6d21", engagementId: "inv-1",
  name: "ornek-web-erisim-gunlugu.log", originalName: "ornek-web-erisim-gunlugu.log",
  relPath: "files/ornek-web-erisim-gunlugu.log", kind: "text", bytes: 1600,
  sha256: "a".repeat(64), sha1: "b".repeat(40), md5: "c".repeat(32),
  sample: false, source: "sample", addedAt: 1791640000000, missing: false, readOnly: true,
};

function mount(native = true, route = "/tools?view=datasets&e=inv-1") {
  const db = new Database(new MemoryStorageAdapter());
  db.collection("engagements").put({
    id: "inv-1", title: "Test investigation", purpose: "other", status: "active",
    clientLabel: "", contacts: [], notes: "", tags: [], demo: false,
    createdAt: 1791640000000, updatedAt: 1791640000000,
  });
  setDbForTesting(db);
  vi.spyOn(sampleData, "available").mockReturnValue(native);
  render(<MemoryRouter initialEntries={[route]}><ToolGuidesView tab="datasets" /></MemoryRouter>);
  return db;
}

afterEach(() => {
  vi.restoreAllMocks();
  useInvestigationFiles.setState({ byEngagement: {}, loadState: {} });
});

describe("Sample datasets", () => {
  it("creates a file in the selected investigation and shows a tangible result", async () => {
    const generate = vi.spyOn(sampleData, "generate").mockResolvedValue([{ outcome: "added", file }]);
    const db = mount();
    await userEvent.click(screen.getAllByRole("button", { name: "Create sample file" })[0]);
    expect(generate).toHaveBeenCalledWith("inv-1", ["web-log"]);
    const results = await screen.findByRole("region", { name: "Created files" });
    expect(within(results).getByText(file.name)).toBeVisible();
    expect(within(results).getByText("Added")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open investigation files" })).toHaveAttribute("href", "/lab?e=inv-1&view=targets");
    expect(useInvestigationFiles.getState().byEngagement["inv-1"]).toEqual([file]);
    expect(db.collection("tasks").getAll()).toHaveLength(0);
  });

  it("explains browser unavailability and does not claim success", () => {
    mount(false);
    expect(screen.getByText(/Sample files are created in the desktop app/)).toBeVisible();
    for (const button of screen.getAllByRole("button", { name: "Create sample file" })) expect(button).toBeDisabled();
  });

  it("requires an investigation before creating files", () => {
    mount(true, "/tools?view=datasets");
    expect(screen.getByRole("combobox", { name: "Investigation" })).toHaveValue("");
    for (const button of screen.getAllByRole("button", { name: "Create sample file" })) expect(button).toBeDisabled();
  });

  it("shows duplicates and partial failures without discarding the successful file", async () => {
    vi.spyOn(sampleData, "generate").mockResolvedValue([
      { outcome: "duplicate", file },
      { outcome: "failed", originalName: "ornek-fotograf.jpg", reason: "sample_write_failed" },
    ]);
    mount();
    await userEvent.click(screen.getAllByRole("button", { name: "Create sample file" })[0]);
    expect(await screen.findByText("Already present")).toBeVisible();
    expect(screen.getByText("ornek-fotograf.jpg")).toBeVisible();
    expect(screen.getByText("Could not create this file. Try again.")).toBeVisible();
  });

  it("explains a missing folder and leaves a way to create it", async () => {
    vi.spyOn(sampleData, "generate").mockRejectedValue("no_engagement_folder");
    mount();
    await userEvent.click(screen.getAllByRole("button", { name: "Create sample file" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Create this investigation’s folder from Targets and files, then try again.");
    expect(screen.getByRole("link", { name: "Open investigation files" })).toBeVisible();
    expect(screen.queryByText("Added")).not.toBeInTheDocument();
  });
});
