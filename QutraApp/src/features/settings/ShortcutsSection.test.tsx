import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ShortcutsSection } from "./ShortcutsSection";

/* Settings › Shortcuts: more shortcuts, each one can be
   changed by recording keys, and a conflict asks before it replaces. */

let storage: MemoryStorageAdapter;

beforeEach(() => {
  storage = new MemoryStorageAdapter();
  setDbForTesting(new Database(storage));
});

afterEach(() => {
  setDbForTesting(null);
});

const keysOf = (name: RegExp) => screen.getByRole("button", { name });

async function record(name: RegExp, init: KeyboardEventInit & { code: string }) {
  const button = keysOf(name);
  fireEvent.click(button);
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: /press the new key combination/ }), init);
  });
}

describe("Settings › Shortcuts", () => {
  it("lists the shortcuts by group", () => {
    render(<ShortcutsSection />);
    for (const group of ["Navigation", "Jarvis", "Investigations", "Terminal", "General"]) {
      expect(screen.getByRole("group", { name: new RegExp(`^${group}`) })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(30);
    const general = screen.getByRole("group", { name: /^General/ });
    expect(within(general).getByText("Command palette")).toBeInTheDocument();
  });

  it("finds a shortcut by its name or its keys", () => {
    render(<ShortcutsSection />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search shortcuts" }), {
      target: { value: "ctrl+shift+t" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("New terminal")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search shortcuts" }), {
      target: { value: "nothing like this" },
    });
    expect(screen.getByText(/No shortcut matches/)).toBeInTheDocument();
  });

  it("records a new combination and stores it", async () => {
    render(<ShortcutsSection />);
    await record(/^Command palette: Ctrl\+K/, { key: "p", code: "KeyP", ctrlKey: true, shiftKey: true });
    expect(getDb().prefs.get().shortcutBindings).toEqual({ palette: "Ctrl+Shift+P" });
    expect(keysOf(/^Command palette: Ctrl\+Shift\+P/)).toBeInTheDocument();
    // A reload reads it back.
    expect(new Database(storage).prefs.get().shortcutBindings).toEqual({ palette: "Ctrl+Shift+P" });
  });

  it("asks before taking a combination another shortcut uses", async () => {
    render(<ShortcutsSection />);
    await record(/^Open Home: Alt\+Home/, { key: "k", code: "KeyK", ctrlKey: true });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Ctrl+K is used by “Command palette”");
    expect(getDb().prefs.get().shortcutBindings).toEqual({});

    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Replace" }));
    });
    expect(getDb().prefs.get().shortcutBindings).toEqual({ "go.home": "Ctrl+K", palette: null });
    expect(keysOf(/^Command palette: none/)).toBeInTheDocument();
  });

  it("keeps the old binding when the user cancels a conflict", async () => {
    render(<ShortcutsSection />);
    await record(/^Open Home: Alt\+Home/, { key: "k", code: "KeyK", ctrlKey: true });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Cancel" }));
    expect(getDb().prefs.get().shortcutBindings).toEqual({});
    expect(keysOf(/^Open Home: Alt\+Home/)).toBeInTheDocument();
  });

  it("warns before taking a combination text editing needs", async () => {
    render(<ShortcutsSection />);
    await record(/^Command palette: Ctrl\+K/, { key: "c", code: "KeyC", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(/Ctrl\+C copies, pastes/);
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Assign anyway" })).toBeInTheDocument();
  });

  it("refuses a combination Windows keeps and keeps listening", async () => {
    render(<ShortcutsSection />);
    await record(/^Command palette: Ctrl\+K/, { key: "F4", code: "F4", altKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Alt+F4 can't be assigned");
    expect(screen.getByRole("button", { name: /press the new key combination/ })).toBeInTheDocument();
    expect(getDb().prefs.get().shortcutBindings).toEqual({});
  });

  it("stops recording on Escape without changing anything", async () => {
    render(<ShortcutsSection />);
    await record(/^Command palette: Ctrl\+K/, { key: "Escape", code: "Escape" });
    expect(keysOf(/^Command palette: Ctrl\+K/)).toBeInTheDocument();
    expect(getDb().prefs.get().shortcutBindings).toEqual({});
  });

  it("removes a binding, resets one and resets all", async () => {
    render(<ShortcutsSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove the shortcut for Settings" }));
    });
    expect(getDb().prefs.get().shortcutBindings).toEqual({ settings: null });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset the shortcut for Settings" }));
    });
    expect(getDb().prefs.get().shortcutBindings).toEqual({});

    await record(/^Command palette: Ctrl\+K/, { key: "p", code: "KeyP", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reset 1 changed shortcuts");
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Reset" }));
    });
    expect(getDb().prefs.get().shortcutBindings).toEqual({});
  });
});
