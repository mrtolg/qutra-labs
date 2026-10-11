import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { EvidenceSchema, FindingSchema } from "@/domain/findings";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ensureLocaleLoaded } from "@/lib/i18n";
import { EvidenceInspector, FindingInspector } from "./inspectors";

/* The details of one finding or one evidence record: what is typed into them
   belongs to that record, and what they write is in the user's language. */

const T = 1_760_000_000_000;

const finding = (id: string, title: string) =>
  FindingSchema.parse({
    id,
    engagementId: "eng_1",
    title,
    severity: "low",
    status: "new",
    fingerprint: `manual:${id}`,
    firstSeen: T,
    lastSeen: T,
    history: [{ at: T, to: "new" }],
    createdAt: T,
    updatedAt: T,
  });

function seed(locale: "en" | "tr" = "en") {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ locale });
  setDbForTesting(db);
  db.collection("findings").bulkPut([finding("fnd_a", "Open SSH"), finding("fnd_b", "Weak TLS")]);
  return db;
}

const wrap = (id: string) => (
  <MemoryRouter>
    <FindingInspector id={id} />
  </MemoryRouter>
);

beforeAll(async () => {
  await ensureLocaleLoaded("tr");
});

afterEach(() => {
  vi.restoreAllMocks();
  setDbForTesting(null);
});

describe("FindingInspector", () => {
  beforeEach(() => seed());

  it("starts over on another finding: its tab and the text typed for the first", async () => {
    const user = userEvent.setup();
    const view = render(wrap("fnd_a"));
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    await user.type(screen.getByRole("textbox", { name: "Add text evidence" }), "banner grab for A");

    view.rerender(wrap("fnd_b"));

    expect(screen.getByRole("heading", { name: "Weak TLS" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByRole("textbox", { name: "Add text evidence" })).toHaveValue("");
    expect(getDb().collection("evidence").getAll()).toEqual([]);
  });

  it("adds the text once, however fast the button is clicked", async () => {
    const user = userEvent.setup();
    render(wrap("fnd_a"));
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    await user.type(screen.getByRole("textbox", { name: "Add text evidence" }), "banner grab");
    const add = screen.getByRole("button", { name: "Add evidence" });

    await user.dblClick(add);

    await waitFor(() => expect(getDb().collection("evidence").getAll()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Add text evidence" })).toHaveValue(""),
    );
    expect(getDb().collection("evidence").getAll()).toHaveLength(1);
  });
});

describe("EvidenceInspector", () => {
  it("records a removal as an ordinary activity event in the app's language", async () => {
    const db = seed("tr");
    db.collection("evidence").put(
      EvidenceSchema.parse({
        id: "ev_1",
        findingId: "fnd_a",
        engagementId: "eng_1",
        title: "nmap çıktısı",
        content: "22/tcp open ssh",
        capturedAt: T,
        createdAt: T,
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<EvidenceInspector id="ev_1" />);

    await user.click(screen.getByRole("button", { name: "Kanıtı sil" }));

    expect(db.collection("evidence").getAll()).toEqual([]);
    const [event] = db.collection("events").getAll();
    expect(event).toMatchObject({ type: "app_activity", label: "Kanıt kaldırıldı: nmap çıktısı" });
  });
});
