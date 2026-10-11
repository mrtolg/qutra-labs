import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* The local list comes from Qutra's own engine (ADR 0016), through
   `listLocalModels`: what Rust found on disk, runnable now or after its
   one-time copy. A model the engine cannot run is not offered. */
vi.mock("@/lib/localEngine/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localEngine/client")>();
  const base = { source: "ollama", sizeBytes: 1, tools: true, prepared: false };
  return {
    ...actual,
    localEngine: {
      available: vi.fn().mockReturnValue(true),
      models: vi.fn().mockResolvedValue({
        ollamaStore: true,
        freeBytes: 1,
        models: [
          { ...base, id: "gemma4:26b", name: "gemma4:26b", architecture: "gemma4", state: "needs_prepare", writeBytes: 1 },
          { ...base, id: "qwen2.5:7b", name: "qwen2.5:7b", architecture: "qwen2", state: "ready" },
          { ...base, id: "odd:1b", name: "odd:1b", architecture: "odd", state: "unsupported", unsupportedArchitecture: "odd" },
        ],
      }),
    },
  };
});

import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { createConversation } from "@/lib/db/conversations";
import { useUi } from "@/state/ui";
import JarvisSettings from "./JarvisSettings";
import { useJarvisUi } from "./jarvisUi";

/* Qutra's own settings on the Qutra page. The browser
   build is what runs here, so the cloud cards say they are desktop-only. */

let db: Database;
beforeEach(() => {
  db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, ollamaModel: "qwen2.5:7b", aiProvider: "ollama" });
  setDbForTesting(db);
  useUi.setState({ toasts: [] });
});
afterEach(() => {
  setDbForTesting(null);
  useJarvisUi.setState({ settings: null });
});

function open(section: Parameters<ReturnType<typeof useJarvisUi.getState>["openSettings"]>[0]) {
  useJarvisUi.setState({ settings: section ?? "personal" });
  return render(<JarvisSettings />);
}

describe("JarvisSettings", () => {
  it("saves what Qutra should know and how to answer, and shows what goes along", async () => {
    open("personal");
    await userEvent.type(screen.getByLabelText("What should Qutra know about you?"), "I test web apps.");
    await userEvent.type(screen.getByLabelText("How should Qutra answer?"), "Commands first.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(db.prefs.get()).toMatchObject({ jarvisAboutYou: "I test web apps.", jarvisInstructions: "Commands first." });

    await userEvent.click(screen.getByRole("radio", { name: /Concise/ }));
    expect(db.prefs.get().jarvisResponseStyle).toBe("concise");

    await userEvent.click(screen.getByText("Show what goes to Qutra"));
    expect(screen.getByText(/I test web apps\./, { selector: "pre" })).toBeInTheDocument();
  });

  // Much typing: slow when the whole suite runs at once, hence the time.
  it("adds, edits and deletes memories, asks before deleting, and turns memory off", async () => {
    open("memory");
    expect(screen.getByText(/Qutra remembers nothing yet/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Something for Qutra to remember"), "Lab network 10.10.0.0/24{Enter}");
    expect(await screen.findByText("Lab network 10.10.0.0/24")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit: Lab network 10.10.0.0/24" }));
    const field = screen.getByLabelText("Memory text");
    await userEvent.clear(field);
    await userEvent.type(field, "Lab network 10.20.0.0/24");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(db.collection("jarvisMemories").getAll()[0]!.text).toBe("Lab network 10.20.0.0/24"));

    await userEvent.click(screen.getByRole("button", { name: "Delete: Lab network 10.20.0.0/24" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this memory?" });
    expect(db.collection("jarvisMemories").getAll()).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(db.collection("jarvisMemories").getAll()).toHaveLength(0));

    await userEvent.click(screen.getByRole("switch", { name: /Use memory/ }));
    expect(db.prefs.get().jarvisMemoryEnabled).toBe(false);
  }, 20_000);

  it("sets the default model from the local list, and offers to clear the open conversation's own", async () => {
    await createConversation(db, { model: { provider: "local", model: "gemma4:26b" }, now: 1 });
    open("model");
    const local = await screen.findByRole("radiogroup", { name: "On this computer" });
    expect(within(local).getByRole("radio", { name: /qwen2\.5:7b/ })).toBeChecked();
    expect(within(local).queryByRole("radio", { name: /odd:1b/ })).toBeNull();
    await userEvent.click(within(local).getByRole("radio", { name: /gemma4:26b/ }));
    expect(db.prefs.get()).toMatchObject({ aiProvider: "ollama", ollamaModel: "gemma4:26b" });

    expect(screen.getByText("The open conversation uses its own model: gemma4:26b.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(db.collection("conversations").getAll()[0]!.model).toBeUndefined());
    expect(screen.getByText("Cloud connections work in the desktop app.")).toBeInTheDocument();
  });

  it("archives every conversation only after a confirmation, then starts a new one", async () => {
    const first = await createConversation(db, { now: 1 });
    const second = await createConversation(db, { now: 2 });
    open("data");
    await userEvent.click(screen.getByRole("button", { name: "Archive 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive 2 conversations?" });
    expect(db.collection("conversations").getAll().some((c) => c.archivedAt)).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive all conversations" }));
    const all = () => db.collection("conversations").getAll();
    await waitFor(() => expect(all()).toHaveLength(3));
    expect([first.id, second.id].every((id) => all().find((c) => c.id === id)?.archivedAt)).toBe(true);
    expect(all().find((c) => c.id !== first.id && c.id !== second.id)?.archivedAt).toBeUndefined();
  });

  it("moves between sections and closes", async () => {
    open("personal");
    await userEvent.click(screen.getByRole("button", { name: "Cloud keys" }));
    expect(useJarvisUi.getState().settings).toBe("keys");
    expect(await screen.findByText(/Windows Credential Manager/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useJarvisUi.getState().settings).toBeNull();
  });
});
