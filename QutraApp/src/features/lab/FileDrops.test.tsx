import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { FILES_DRAG_EVENT, FILES_DROPPED_EVENT } from "@/lib/investigationFiles";
import { createEngagement } from "@/services/appService";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { useUi } from "@/state/ui";
import { FileDrops } from "./FileDrops";

/* A drop on the window goes to the investigation the Lab shows. */

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderDrops() {
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <FileDrops />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function emit(name: string, payload: unknown) {
  await waitFor(() => expect(handlers.has(name)).toBe(true));
  await act(async () => {
    handlers.get(name)!({ payload });
  });
}

const toastKeys = () => useUi.getState().toasts.map((toast) => toast.messageKey);

beforeEach(() => {
  invoke.mockReset();
  handlers.clear();
  useInvestigationFiles.setState({ byEngagement: {}, loadState: {}, dropTarget: null, dragOver: false });
  useUi.setState({ toasts: [] });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
});

describe("file drops", () => {
  it("shows the drop outline while files are dragged over the window", async () => {
    renderDrops();

    await emit(FILES_DRAG_EVENT, { over: true });
    expect(useInvestigationFiles.getState().dragOver).toBe(true);
    await emit(FILES_DRAG_EVENT, { over: false });
    expect(useInvestigationFiles.getState().dragOver).toBe(false);
  });

  it("adds a drop to the investigation the Lab shows, and Show opens the file", async () => {
    useInvestigationFiles.setState({ dropTarget: "eng_1" });
    invoke.mockResolvedValueOnce([
      {
        outcome: "added",
        file: {
          id: "file_1",
          engagementId: "eng_1",
          relPath: "files/photo.jpg",
          name: "photo.jpg",
          originalName: "photo.jpg",
          bytes: 3,
          sha256: "a".repeat(64),
          sha1: "b".repeat(40),
          md5: "c".repeat(32),
          kind: "jpeg",
          sample: false,
          source: "dropped",
          addedAt: 1,
          missing: false,
          readOnly: true,
        },
      },
    ]);
    renderDrops();

    await emit(FILES_DROPPED_EVENT, { token: "tok-1", names: ["photo.jpg"] });

    expect(invoke).toHaveBeenCalledWith("investigation_files_add_dropped", {
      token: "tok-1",
      engagementId: "eng_1",
    });
    await waitFor(() => expect(toastKeys()).toEqual(["lab.files.added"]));
    act(() => useUi.getState().toasts[0].onAction?.());
    const where = new URL(`http://x${screen.getByTestId("where").textContent}`);
    expect(where.pathname).toBe("/lab");
    expect(Object.fromEntries(where.searchParams)).toEqual({
      e: "eng_1",
      view: "targets",
      item: "file:file_1",
    });
  });

  it("names the investigation the files went into", async () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    const id = createEngagement("Home lab");
    useInvestigationFiles.setState({ dropTarget: id });
    invoke.mockResolvedValueOnce([
      {
        outcome: "added",
        file: {
          id: "file_1",
          engagementId: id,
          relPath: "files/photo.jpg",
          name: "photo.jpg",
          originalName: "photo.jpg",
          bytes: 3,
          sha256: "a".repeat(64),
          sha1: "b".repeat(40),
          md5: "c".repeat(32),
          kind: "jpeg",
          sample: false,
          source: "dropped",
          addedAt: 1,
          missing: false,
          readOnly: true,
        },
      },
    ]);
    renderDrops();

    await emit(FILES_DROPPED_EVENT, { token: "tok-1", names: ["photo.jpg"] });

    await waitFor(() => expect(toastKeys()).toEqual(["lab.files.addedTo"]));
    expect(useUi.getState().toasts[0].params).toEqual({ count: 1, name: "Home lab" });
    expect(getDb().collection("engagements").get(id)?.title).toBe("Home lab");
  });

  it("says where to drop files when no investigation is open", async () => {
    renderDrops();

    await emit(FILES_DROPPED_EVENT, { token: "tok-1", names: ["photo.jpg"] });

    expect(toastKeys()).toEqual(["lab.files.dropElsewhere"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks for the folder when the investigation has none", async () => {
    useInvestigationFiles.setState({ dropTarget: "eng_1" });
    invoke.mockRejectedValueOnce("no_engagement_folder");
    renderDrops();

    await emit(FILES_DROPPED_EVENT, { token: "tok-1", names: ["photo.jpg"] });

    await waitFor(() => expect(toastKeys()).toEqual(["lab.files.needFolderToast"]));
  });

  it("says a drop could not be added when Rust refuses it", async () => {
    useInvestigationFiles.setState({ dropTarget: "eng_1" });
    invoke.mockRejectedValueOnce("unknown_drop_token");
    renderDrops();

    await emit(FILES_DROPPED_EVENT, { token: "tok-1", names: ["photo.jpg"] });

    await waitFor(() => expect(toastKeys()).toEqual(["lab.files.dropFailed"]));
  });

  it("listens for nothing in the browser build", () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    renderDrops();

    expect(handlers.size).toBe(0);
  });
});
