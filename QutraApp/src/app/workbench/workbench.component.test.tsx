import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { TopBar } from "@/app/TopBar";
import { ResizeHandle } from "./ResizeHandle";
import { Workbench } from "./Workbench";
import { useUi } from "@/state/ui";

function seedDb() {
  const db = new Database(new MemoryStorageAdapter());
  setDbForTesting(db);
  return db;
}

function renderAt(ui: React.ReactNode, path = "/overview") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<>{ui}</>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useUi.setState({ paletteOpen: false });
});

/* Shell resilience. The boundary used to wrap only <Outlet/>, so a throw
   anywhere in the chrome unmounted the whole tree and left a blank window with
   no route out. These prove each region now fails in isolation. */
describe("shell region error boundaries", () => {
  function Boom(): never {
    throw new Error("region exploded");
  }

  it("contains a crashing region and offers recovery", () => {
    seedDb();
    // React logs the caught error; silence it so the run stays readable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderAt(
        <>
          <ErrorBoundary variant="panel">
            <Boom />
          </ErrorBoundary>
          <TopBar />
        </>,
      );

      // The crash is reported...
      expect(screen.getByTestId("shell-region-error")).toBeTruthy();
      // ...and, critically, the rest of the shell still rendered, so the user
      // can navigate away from the broken region.
      expect(screen.getByRole("navigation", { name: "Surfaces" })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("recovers the region when Try again is pressed", async () => {
    seedDb();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let shouldThrow = true;
      function Flaky() {
        if (shouldThrow) throw new Error("transient");
        return <p>recovered</p>;
      }

      renderAt(
        <ErrorBoundary variant="panel">
          <Flaky />
        </ErrorBoundary>,
      );
      expect(screen.getByTestId("shell-region-error")).toBeTruthy();

      shouldThrow = false;
      await userEvent.click(screen.getByRole("button", { name: /try again/i }));

      expect(screen.getByText("recovered")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

/* Layout persistence cost. A drag emits a pointermove per frame; each one used
   to write the whole Preferences blob, which on desktop is a serialized SQLite
   write. The value the user meant to set once could queue hundreds of writes. */
describe("resize persistence", () => {
  /* The gesture contract is asserted on ResizeHandle itself rather than by
     dragging the sidebar, because jsdom's pointer events carry no coordinates
     (`e.clientX` is undefined), so a simulated drag cannot produce a real
     delta. What matters is *when* persistence runs, and that is fully
     observable: moving must never commit, releasing must commit exactly once. */
  it("commits once when the gesture ends, never while moving", () => {
    seedDb();
    const onResize = vi.fn();
    const onCommit = vi.fn();

    render(
      <ResizeHandle
        orientation="x"
        ariaLabel="Resize sidebar"
        value={240}
        min={200}
        max={360}
        onResize={onResize}
        onCommit={onCommit}
      />,
    );
    const handle = screen.getByRole("separator", { name: /resize sidebar/i });
    handle.setPointerCapture = () => {};
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = () => {};

    fireEvent.pointerDown(handle, { pointerId: 1 });
    for (let i = 0; i < 8; i++) fireEvent.pointerMove(handle, { pointerId: 1 });

    expect(onCommit, "a drag in progress must not persist").not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("persists immediately for a keyboard adjustment", () => {
    seedDb();
    const onCommit = vi.fn();
    render(
      <ResizeHandle
        orientation="x"
        ariaLabel="Resize inspector"
        value={320}
        min={280}
        max={520}
        onResize={() => {}}
        onCommit={onCommit}
      />,
    );
    const handle = screen.getByRole("separator", { name: /resize inspector/i });

    // A key press is one deliberate adjustment with no gesture end to wait for.
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

/* At 1100 px and below the context panel overlays the surface
   behind a backdrop. What the backdrop covers is inert, so Tab cannot reach a
   control hidden behind the panel. (The side rail it also covered is gone.) */
describe("context panel overlay", () => {
  function renderWorkbench(width: number) {
    window.innerWidth = width;
    const db = seedDb();
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route path="*" element={<Workbench />} />
        </Routes>
      </MemoryRouter>,
    );
    return db;
  }
  const covered = () => document.getElementById("main")!.closest("[inert]");

  it("makes the surface inert while it overlays it", () => {
    const db = renderWorkbench(1100);
    expect(covered()).toBeNull();
    act(() => db.prefs.set({ contextPanelOpen: true }));
    expect(screen.getByRole("complementary", { name: "Context" })).toHaveAttribute(
      "data-mode",
      "overlay",
    );
    expect(covered()).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Context" }).closest("[inert]")).toBeNull();
    act(() => db.prefs.set({ contextPanelOpen: false }));
    expect(covered()).toBeNull();
  });

  it("leaves the surface live when it pushes it on a wide window", () => {
    const db = renderWorkbench(1440);
    act(() => db.prefs.set({ contextPanelOpen: true }));
    expect(screen.getByRole("complementary", { name: "Context" })).toHaveAttribute(
      "data-mode",
      "push",
    );
    expect(covered()).toBeNull();
  });
});

describe("skip-link target", () => {
  it("makes #main programmatically focusable", () => {
    seedDb();
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route path="*" element={<Workbench />} />
        </Routes>
      </MemoryRouter>,
    );
    const main = document.getElementById("main");
    expect(main).not.toBeNull();
    expect(main).toHaveAttribute("tabindex", "-1");
  });
});
