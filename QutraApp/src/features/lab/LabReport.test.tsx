import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const write = vi.hoisted(() => vi.fn(async () => "ok"));
vi.mock("@/lib/engagementFolders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/engagementFolders")>()),
  engagementFolders: {
    available: () => true,
    get: async () => ({ path: "C:\\Investigations\\Home Lab" }),
    write,
  },
}));
vi.mock("@/lib/time", () => ({ now: () => 1_760_000_000_000 }));

import { EvidenceSchema, FindingSchema } from "@/domain/findings";
import { EngagementSchema } from "@/domain/lab";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { LabReport } from "./LabReport";

/* The Rapor view chooses what the report holds and masks, and
   the saved file is the text its preview shows. */

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
const base = {
  engagementId: "eng-1",
  severity: "high",
  firstSeen: T,
  lastSeen: T,
  createdAt: T,
  updatedAt: T,
} as const;

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  const db = getDb();
  db.collection("findings").bulkPut([
    FindingSchema.parse({ ...base, id: "f-1", title: "Open SSH", status: "confirmed", fingerprint: "fp-1", evidenceIds: ["ev-1"] }),
    FindingSchema.parse({ ...base, id: "f-2", title: "Draft one", status: "new", fingerprint: "fp-2" }),
    FindingSchema.parse({ ...base, id: "f-3", title: "FP one", status: "false_positive", fingerprint: "fp-3", evidenceIds: ["ev-3"] }),
  ]);
  db.collection("evidence").bulkPut([
    EvidenceSchema.parse({ id: "ev-1", findingId: "f-1", engagementId: "eng-1", title: "nmap", content: "22/tcp open ssh", capturedAt: T, createdAt: T }),
    EvidenceSchema.parse({ id: "ev-3", findingId: "f-3", engagementId: "eng-1", title: "nikto", capturedAt: T, createdAt: T }),
  ]);
});

afterEach(() => {
  write.mockClear();
  setDbForTesting(null);
});

const preview = () => screen.getByTestId("lab-report-preview").textContent ?? "";

describe("Rapor", () => {
  it("holds findings that stand by default, and never a draft", async () => {
    render(<LabReport engagement={engagement} targets={[]} />);

    expect(preview()).toContain("### Open SSH");
    expect(preview()).not.toMatch(/Draft one|FP one/);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("The report holds 1 finding(s).");
    expect(status).toHaveTextContent("Left out: 1 draft(s) without evidence, 1 dismissed.");
    expect(screen.getByRole("group", { name: "What the report holds" })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Include false positives, duplicates and out-of-scope findings" }),
    );
    expect(preview()).toContain("### FP one");
    expect(preview()).not.toContain("Draft one");
    expect(status).toHaveTextContent("The report holds 2 finding(s).");
  });

  it("masks private details by default, and warns when masking is off", async () => {
    getDb()
      .collection("evidence")
      .put({ ...getDb().collection("evidence").get("ev-1")!, content: "saved to C:\\Users\\bob\\scan.txt" });
    render(<LabReport engagement={engagement} targets={[]} />);

    const mask = screen.getByRole("checkbox", { name: "Mask locations, folder paths and sensitive evidence" });
    expect(mask).toBeChecked();
    expect(preview()).toContain("saved to …\\scan.txt");
    expect(screen.getByRole("status")).toHaveTextContent("Masked: 1 folder path(s).");

    await userEvent.click(mask);
    expect(preview()).toContain("C:\\Users\\bob\\scan.txt");
    expect(screen.getByText(/will be shown in full/)).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("Masked");
  });

  it("saves the text its preview shows, with the findings it holds", async () => {
    render(<LabReport engagement={engagement} targets={[]} />);

    await userEvent.click(screen.getByRole("button", { name: "Export Markdown" }));

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const [engagementId, , contents] = write.mock.calls[0] as unknown as [string, string, string];
    expect(engagementId).toBe("eng-1");
    expect(contents).toBe(preview());
    const [record] = getDb().collection("reports").getAll();
    expect(record).toMatchObject({ includedFindingIds: ["f-1"], title: "Home Lab — report" });
  });
});
