import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { useUi } from "@/state/ui";
import { TopBar } from "./TopBar";
import { useShortcuts } from "./useShortcuts";

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

/** The app's one key handler, which AppShell mounts beside the bar. */
function Shortcuts() {
  useShortcuts();
  return null;
}

function renderAt(path: string) {
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TopBar />
              <Shortcuts />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const surfaces = () => screen.getByRole("navigation", { name: "Surfaces" });

beforeEach(() => {
  useUi.setState({
    paletteOpen: false,
    settingsSection: null,
    lastSettingsSection: "general",
  });
});

describe("TopBar", () => {
  it("names the product and takes the mark home", () => {
    renderAt("/lab");
    fireEvent.click(screen.getByRole("button", { name: "Qutra Labs — Home" }));
    expect(where()).toBe("/overview");
  });

  it("offers the five areas, Home first: it is the only navigation bar", () => {
    renderAt("/overview");
    const names = within(surfaces())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["Home", "Investigations", "Tools", "Qutra", "Terminal"]);
  });

  it.each([
    ["Home", "/overview"],
    ["Investigations", "/lab"],
    ["Tools", "/tools"],
    ["Qutra", "/jarvis"],
    ["Terminal", "/terminal"],
  ])("clicking %s opens %s", (name, path) => {
    renderAt("/files");
    fireEvent.click(within(surfaces()).getByRole("button", { name }));
    expect(where()).toBe(path);
  });

  it.each([
    ["/overview", "Home"],
    ["/workspaces", "Home"],
    ["/files", "Home"],
    ["/github", "Home"],
    ["/sessions/focus", "Home"],
    ["/lab", "Investigations"],
    ["/tools", "Tools"],
    ["/jarvis", "Qutra"],
    ["/terminal", "Terminal"],
  ])("on %s marks %s as the current page", (path, name) => {
    renderAt(path);
    const current = within(surfaces())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(current.map((b) => b.textContent)).toEqual([name]);
  });

  it.each([
    ["1", "/lab"],
    ["2", "/tools"],
    ["3", "/jarvis"],
    ["4", "/terminal"],
  ])("Ctrl+%s opens %s", (key, path) => {
    renderAt("/overview");
    fireEvent.keyDown(window, { key, ctrlKey: true });
    expect(where()).toBe(path);
  });

  it("switches surfaces even when the focused element swallows the key", () => {
    renderAt("/overview");
    // A focused xterm cancels the keys it handles; Ctrl+digits are among them.
    const terminal = document.createElement("textarea");
    terminal.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.appendChild(terminal);
    fireEvent.keyDown(terminal, { key: "1", ctrlKey: true });
    expect(where()).toBe("/lab");
    terminal.remove();
  });

  it("leaves Ctrl+digit alone while a modal dialog is open", () => {
    renderAt("/overview");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(where()).toBe("/overview");
    dialog.remove();
  });

  it("ignores Ctrl+Shift and Alt combinations", () => {
    renderAt("/overview");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "1", ctrlKey: true, altKey: true });
    expect(where()).toBe("/overview");
  });

  it("opens the palette from Search and shows its shortcut", () => {
    renderAt("/overview");
    const search = screen.getByRole("button", { name: "Search" });
    expect(search).toHaveAttribute("aria-keyshortcuts", "Control+K");
    expect(within(search).getByText("Ctrl K")).toBeInTheDocument();
    fireEvent.click(search);
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("opens Settings from the gear over the current surface", () => {
    renderAt("/lab");
    const gear = screen.getByRole("button", { name: "Settings" });
    expect(gear).toHaveAttribute("aria-keyshortcuts", "Control+Comma");
    fireEvent.click(gear);
    expect(useUi.getState().settingsSection).toBe("general");
    expect(where()).toBe("/lab");
  });
});
