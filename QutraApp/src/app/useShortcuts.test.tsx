import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { useUi } from "@/state/ui";
import { useShortcuts } from "./useShortcuts";

/* The one key handler reads its bindings from the registry: a binding
   changed in Settings works at once, and the old one stops working. */

let path = "";

function Host() {
  useShortcuts();
  const location = useLocation();
  path = `${location.pathname}${location.search}`;
  return (
    <div>
      <input aria-label="field" />
      <div className="xterm">
        <textarea aria-label="terminal input" />
      </div>
      <div role="textbox" aria-readonly="true" tabIndex={0} aria-label="key well" data-holds-keys="" />
    </div>
  );
}

function mount(at = "/overview") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Host />
    </MemoryRouter>,
  );
}

const key = (init: KeyboardEventInit & { code: string }, target: Window | Element = window) =>
  act(() => {
    fireEvent.keyDown(target, init);
  });

beforeEach(() => {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useUi.setState({ paletteOpen: false, settingsSection: null });
});

afterEach(() => {
  setDbForTesting(null);
  document.querySelectorAll("dialog").forEach((d) => d.remove());
});

describe("useShortcuts", () => {
  it("opens the areas with their default keys", () => {
    mount();
    key({ key: "1", code: "Digit1", ctrlKey: true });
    expect(path).toBe("/lab");
    key({ key: "4", code: "Digit4", ctrlKey: true });
    expect(path).toBe("/terminal");
    key({ key: "Home", code: "Home", altKey: true });
    expect(path).toBe("/overview");
  });

  it("opens the palette and Settings", () => {
    mount();
    key({ key: "k", code: "KeyK", ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(true);
    key({ key: ",", code: "Comma", ctrlKey: true });
    expect(useUi.getState().settingsSection).not.toBeNull();
  });

  it("follows a binding changed in Settings at once", async () => {
    mount();
    await act(async () => {
      await getDb().prefs.setDurable({ shortcutBindings: { palette: "Ctrl+Shift+P" } });
    });
    key({ key: "k", code: "KeyK", ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(false);
    key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("goes to an investigation's section and keeps the investigation", () => {
    mount("/lab?e=E1&view=overview");
    key({ key: "5", code: "Digit5", altKey: true });
    expect(path).toBe("/lab?e=E1&view=findings");
    key({ key: "PageDown", code: "PageDown", ctrlKey: true });
    expect(path).toBe("/lab?e=E1&view=report");
  });

  it("leaves a plain Ctrl+letter to the shell in the terminal", () => {
    const view = mount();
    const terminal = view.getByLabelText("terminal input");
    key({ key: "k", code: "KeyK", ctrlKey: true }, terminal);
    expect(useUi.getState().paletteOpen).toBe(false);
    key({ key: "2", code: "Digit2", ctrlKey: true }, terminal);
    expect(path).toBe("/tools");
  });

  it("leaves a pane that holds keys all but the area switches and the context panel", () => {
    const view = mount();
    const well = view.getByLabelText("key well");
    key({ key: "k", code: "KeyK", ctrlKey: true }, well);
    expect(useUi.getState().paletteOpen).toBe(false);
    key({ key: ",", code: "Comma", ctrlKey: true }, well);
    expect(useUi.getState().settingsSection).toBeNull();
    const panelOpen = getDb().prefs.get().contextPanelOpen;
    key({ key: "b", code: "KeyB", ctrlKey: true }, well);
    expect(getDb().prefs.get().contextPanelOpen).toBe(!panelOpen);
    key({ key: "2", code: "Digit2", ctrlKey: true }, well);
    expect(path).toBe("/tools");
  });

  it("stays out of the way while a modal is open", () => {
    mount();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    key({ key: "1", code: "Digit1", ctrlKey: true });
    expect(path).toBe("/overview");
  });
});
