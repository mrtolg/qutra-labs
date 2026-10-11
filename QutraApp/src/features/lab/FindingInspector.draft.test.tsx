import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { EvidenceSchema, FindingSchema } from "@/domain/findings";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { FindingInspector } from "./inspectors";

/* A finding without evidence is a draft; it says so and
   cannot be confirmed until evidence points at it. */

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  getDb()
    .collection("findings")
    .put(
      FindingSchema.parse({
        id: "fnd_1",
        engagementId: "eng_1",
        title: "Open port",
        severity: "low",
        status: "new",
        fingerprint: "manual:fnd_1",
        firstSeen: 1,
        lastSeen: 1,
        history: [{ at: 1, to: "new" }],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
});

afterEach(() => setDbForTesting(null));

const option = (value: string) =>
  within(screen.getByLabelText("Status"))
    .getAllByRole("option")
    .find((o) => (o as HTMLOptionElement).value === value) as HTMLOptionElement;

describe("a draft finding", () => {
  it("cannot be confirmed until evidence points at it", async () => {
    render(
      <MemoryRouter>
        <FindingInspector id="fnd_1" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Draft · no evidence")).toBeInTheDocument();
    expect(screen.getByText("Add evidence before confirming it.")).toBeInTheDocument();
    expect(option("confirmed").disabled).toBe(true);
    expect(option("false_positive").disabled).toBe(false);

    act(() => {
      getDb()
        .collection("evidence")
        .put(
          EvidenceSchema.parse({
            id: "ev_1",
            findingId: "fnd_1",
            title: "Output",
            capturedAt: 2,
            createdAt: 2,
          }),
        );
    });

    expect(screen.queryByText("Draft · no evidence")).toBeNull();
    expect(option("confirmed").disabled).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText("Status"), "confirmed");
    const finding = getDb().collection("findings").get("fnd_1")!;
    expect(finding.status).toBe("confirmed");
    expect(finding.history.at(-1)).toMatchObject({ from: "new", to: "confirmed" });
  });
});

describe("the last evidence of a confirmed finding", () => {
  beforeEach(() => {
    const db = getDb();
    db.collection("findings").put({
      ...db.collection("findings").get("fnd_1")!,
      status: "confirmed",
      evidenceIds: ["ev_1"],
    });
    db.collection("findings").put(
      FindingSchema.parse({
        ...db.collection("findings").get("fnd_1")!,
        id: "fnd_2",
        title: "Weak TLS",
        status: "new",
        fingerprint: "manual:fnd_2",
        evidenceIds: ["ev_2"],
      }),
    );
    for (const [id, findingId] of [["ev_1", "fnd_1"], ["ev_2", "fnd_2"], ["ev_3", undefined]]) {
      db.collection("evidence").put(
        EvidenceSchema.parse({ id, findingId, engagementId: "eng_1", title: `Row ${id}`, capturedAt: 2, createdAt: 2 }),
      );
    }
  });

  it("asks before it goes, and the finding goes back to new", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(
      <MemoryRouter>
        <FindingInspector id="fnd_1" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Evidence" }));

    await userEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(ask).toHaveBeenLastCalledWith(expect.stringContaining("last evidence of “Open port”"));
    expect(getDb().collection("evidence").get("ev_1")!.findingId).toBe("fnd_1");

    await userEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(getDb().collection("evidence").get("ev_1")!.findingId).toBeUndefined();
    const finding = getDb().collection("findings").get("fnd_1")!;
    expect(finding.status).toBe("new");
    expect(finding.history.at(-1)).toMatchObject({ from: "confirmed", to: "new", note: "evidence_removed" });
    ask.mockRestore();
  });

  it("lists evidence of another finding apart, as a move", async () => {
    render(
      <MemoryRouter>
        <FindingInspector id="fnd_1" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Evidence" }));

    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual([
      "Not attached to a finding",
      "From another finding (moves here)",
    ]);
    expect(within(groups[0]!).getByRole("option", { name: "Row ev_3" })).toBeInTheDocument();
    expect(within(groups[1]!).getByRole("option", { name: "Row ev_2" })).toBeInTheDocument();
  });
});
