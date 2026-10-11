import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { appendTurn, createConversation } from "@/lib/db/conversations";
import { createFolder } from "@/lib/db/jarvis";
import { useUi } from "@/state/ui";
import { JarvisHistory } from "./JarvisHistory";

/* The vertical history on the Qutra page. */

async function talk(db: Database, content: string, now: number, extra: Parameters<typeof createConversation>[1] = {}) {
  const c = await createConversation(db, { now, ...extra });
  await appendTurn(db, {
    conversationId: c.id,
    expectedEraseRevision: 0,
    requestId: `r-${now}`,
    messages: [
      { role: "user", content },
      { role: "assistant", content: `answer about ${content}` },
    ],
    now,
  });
  return c;
}

let db: Database;
beforeEach(() => {
  db = new Database(new MemoryStorageAdapter());
  setDbForTesting(db);
  useUi.setState({ toasts: [] });
});
afterEach(() => {
  setDbForTesting(null);
  vi.restoreAllMocks();
});

const list = () => within(screen.getByRole("navigation", { name: "Conversations" }));
const doc = (id: string) => db.collection("conversations").get(id)!;

async function menuOf(title: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
  return screen.getByRole("menu");
}

describe("JarvisHistory", () => {
  it("lists conversations by day, opens one, and finds them by their words", async () => {
    const now = Date.now();
    const old = await talk(db, "Recon planning", now - 3 * 24 * 3600_000);
    await talk(db, "Gitleaks report", now);
    render(<JarvisHistory />);

    expect(list().getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(list().getByRole("heading", { name: "Previous 7 days" })).toBeInTheDocument();
    // The newest is the one open.
    expect(list().getByRole("button", { name: /^Gitleaks report/ })).toHaveAttribute("aria-current", "page");

    await userEvent.click(list().getByRole("button", { name: /^Recon planning/ }));
    await waitFor(() => expect(doc(old.id).lastOpenedAt).toBeGreaterThan(now - 3 * 24 * 3600_000));

    await userEvent.type(screen.getByRole("searchbox", { name: "Search conversations" }), "about recon");
    expect(list().getByRole("heading", { name: "Results · 1" })).toBeInTheDocument();
    expect(list().getByText(/answer about Recon planning/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(list().queryByRole("heading", { name: /Results/ })).toBeNull();
  });

  it("creates a folder, files a conversation from its menu, and shows the count", async () => {
    const c = await talk(db, "Client A scope", Date.now());
    render(<JarvisHistory />);

    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Folder name" }), "Client A{Enter}");
    const folder = await screen.findByRole("button", { name: /Client A\s*0/ });
    expect(folder).toBeInTheDocument();

    const menu = await menuOf("Client A scope");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to folder" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Client A" }));
    await waitFor(() => expect(doc(c.id).folderId).toBe(db.collection("conversationFolders").getAll()[0]!.id));
    expect(await screen.findByRole("button", { name: /Client A\s*1/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("group", { name: "Client A" })).getByRole("button", { name: /^Client A scope/ })).toBeInTheDocument();
  });

  it("files a conversation by dragging it onto a folder", async () => {
    const c = await talk(db, "Drag me", Date.now());
    const f = (await createFolder(db, "Target", 1))!;
    render(<JarvisHistory />);
    const row = list().getByRole("button", { name: /^Drag me/ });
    const folderEl = screen.getByRole("button", { name: /^Target/ }).closest("[data-drop-folder]")!;
    // jsdom has no layout: say which element is under the pointer.
    document.elementFromPoint = vi.fn(() => folderEl);
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 60 });
    expect(folderEl).toHaveClass("is-over");
    fireEvent.pointerUp(window, { clientX: 40, clientY: 60 });
    await waitFor(() => expect(doc(c.id).folderId).toBe(f.id));
  });

  it("pins, renames and archives with an undo", async () => {
    const c = await talk(db, "Notes", Date.now());
    render(<JarvisHistory />);

    await userEvent.click(within(await menuOf("Notes")).getByRole("menuitem", { name: "Pin to top" }));
    expect(await screen.findByRole("heading", { name: "Pinned" })).toBeInTheDocument();

    await userEvent.click(within(await menuOf("Notes")).getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Conversation name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Keşif notları{Enter}");
    await waitFor(() => expect(doc(c.id).title).toBe("Keşif notları"));

    await userEvent.click(within(await menuOf("Keşif notları")).getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(doc(c.id).archivedAt).toBeDefined());
    const toast = useUi.getState().toasts.at(-1)!;
    expect(toast.messageKey).toBe("jarvis.history.archived");
    toast.onAction?.();
    await waitFor(() => expect(doc(c.id).archivedAt).toBeUndefined());
  });

  it("keeps archived conversations in the archive, and deletes one only after a confirmation", async () => {
    const c = await talk(db, "Old case", Date.now());
    await talk(db, "Current", Date.now() + 1);
    const { setArchived } = await import("@/lib/db/conversations");
    await setArchived(db, c.id, true);
    render(<JarvisHistory />);
    expect(list().queryByRole("button", { name: /^Old case/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Archive\s*1/ }));
    expect(list().getByRole("button", { name: /^Old case/ })).toBeInTheDocument();
    await userEvent.click(within(await menuOf("Old case")).getByRole("menuitem", { name: "Delete" }));
    expect(db.collection("conversations").get(c.id)).toBeDefined();
    const dialog = await screen.findByRole("dialog", { name: "Delete “Old case”?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(db.collection("conversations").get(c.id)).toBeUndefined());

    await userEvent.click(screen.getByRole("button", { name: "Back to history" }));
    expect(list().getByRole("button", { name: /^Current/ })).toBeInTheDocument();
  });

  it("says what to do when there is nothing yet", () => {
    render(<JarvisHistory />);
    expect(screen.getByText("No conversations yet. Ask Qutra something to start one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a folder to group conversations" })).toBeInTheDocument();
  });
});

describe("JarvisHistory and the open conversation", () => {
  it("starts a new conversation when the open one is archived", async () => {
    const c = await talk(db, "Open one", Date.now());
    render(<JarvisHistory />);
    await userEvent.click(within(await menuOf("Open one")).getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(db.collection("conversations").getAll()).toHaveLength(2));
    const fresh = db.collection("conversations").getAll().find((x) => x.id !== c.id)!;
    expect(fresh.messages).toEqual([]);
    expect(fresh.lastOpenedAt).toBeGreaterThanOrEqual(doc(c.id).lastOpenedAt);
  });
});
