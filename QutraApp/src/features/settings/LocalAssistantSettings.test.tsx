import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { localAssistant } from "@/lib/localAssistant/client";
import { LocalAssistantSettings } from "./LocalAssistantSettings";

/* The agent is opt-in and default off, and the
   `assistantAutoApproveReads` preference has its own control.
   These tests exercise the two Settings toggles. */

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn().mockResolvedValue({ status: "unknown", models: [] }),
      listModels: vi.fn().mockResolvedValue({ status: "unknown", models: [] }),
      streamChat: vi.fn(),
      approveTool: vi.fn(),
    },
  };
});

function seedDb(overrides: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, ...overrides });
  setDbForTesting(db);
  return db;
}

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
  // Only the console spy some cases install; the module mocks stay.
  if (vi.isMockFunction(console.error)) vi.mocked(console.error).mockRestore();
});

/** Press Clear, then confirm it in the dialog that asks. */
async function clearHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("local-assistant-clear-history"));
  const dialog = await screen.findByRole("dialog", { name: "Clear every conversation?" });
  await user.click(within(dialog).getByRole("button", { name: "Clear conversation" }));
}

describe("LocalAssistantSettings still probes health as before", () => {
  it("does not probe on mount", () => {
    seedDb();
    render(<LocalAssistantSettings />);

    expect(localAssistant.checkHealth).not.toHaveBeenCalled();
  });
});

describe("the endpoint row shows only what Rust selected",() => {
  const checkHealth = vi.mocked(localAssistant.checkHealth);

  it("says there is no address before the engine runs, and ignores an old stored one", () => {
    // Left by the Ollama-era version: Rust now starts the engine on a free
    // port of its own choosing, so a stored address is neither shown nor read.
    seedDb({ ollamaBaseUrl: "http://example.com:11434" });
    render(<LocalAssistantSettings />);

    const row = screen.getByTestId("local-assistant-endpoint");
    expect(row).toHaveTextContent(/none yet/i);
    expect(row).toHaveTextContent(/free port on 127\.0\.0\.1/);
    expect(row).not.toHaveTextContent(/example\.com|11434|11435/);
    expect(screen.queryByTestId("local-assistant-endpoint-stale")).toBeNull();
  });

  it("shows the origin Rust reported after a probe", async () => {
    seedDb();
    checkHealth.mockResolvedValueOnce({
      status: "ready",
      models: ["qwen2.5:14b"],
      endpoint: "http://127.0.0.1:11435",
      selectedModel: "qwen2.5:14b",
    });
    const user = userEvent.setup();
    render(<LocalAssistantSettings />);

    await user.click(screen.getByTestId("local-assistant-test-connection"));

    expect(await screen.findByTestId("local-assistant-endpoint")).toHaveTextContent(
      /^http:\/\/127\.0\.0\.1:11435$/,
    );
  });

  it("goes back to no address when a later check finds the engine stopped", async () => {
    seedDb();
    checkHealth
      .mockResolvedValueOnce({
        status: "ready",
        models: ["qwen2.5:14b"],
        endpoint: "http://127.0.0.1:50123",
        selectedModel: "qwen2.5:14b",
      })
      // Stopped after its idle minutes: the model is still ready on disk,
      // but nothing listens, so Rust reports no address.
      .mockResolvedValueOnce({ status: "ready", models: ["qwen2.5:14b"], selectedModel: "qwen2.5:14b" });
    const user = userEvent.setup();
    render(<LocalAssistantSettings />);

    await user.click(screen.getByTestId("local-assistant-test-connection"));
    await waitFor(() =>
      expect(screen.getByTestId("local-assistant-endpoint")).toHaveTextContent("50123"),
    );
    await user.click(screen.getByTestId("local-assistant-test-connection"));

    await waitFor(() =>
      expect(screen.getByTestId("local-assistant-endpoint")).toHaveTextContent(/none yet/i),
    );
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it("says no address is contacted while the assistant is off", () => {
    seedDb({ localAssistantEnabled: false });
    render(<LocalAssistantSettings />);

    const row = screen.getByTestId("local-assistant-endpoint");
    expect(row).toHaveTextContent(/off/i);
    // "Qutra tries …" would describe traffic that does not happen while off.
    expect(row).not.toHaveTextContent(/tries/i);
  });

  it("drops a probed endpoint once the assistant is turned off", async () => {
    const db = seedDb();
    checkHealth.mockResolvedValueOnce({
      status: "ready",
      models: ["qwen2.5:14b"],
      endpoint: "http://127.0.0.1:11435",
      selectedModel: "qwen2.5:14b",
    });
    const user = userEvent.setup();
    render(<LocalAssistantSettings />);
    await user.click(screen.getByTestId("local-assistant-test-connection"));
    await waitFor(() =>
      expect(screen.getByTestId("local-assistant-endpoint")).toHaveTextContent("11435"),
    );

    act(() => db.prefs.set({ localAssistantEnabled: false }));

    expect(screen.getByTestId("local-assistant-endpoint")).not.toHaveTextContent("11435");
  });

  it("marks a reported endpoint as the last check's answer, not a live fact", async () => {
    seedDb();
    checkHealth.mockResolvedValueOnce({
      status: "ready",
      models: ["qwen2.5:14b"],
      endpoint: "http://127.0.0.1:11434",
      selectedModel: "qwen2.5:14b",
    });
    const user = userEvent.setup();
    render(<LocalAssistantSettings />);

    await user.click(screen.getByTestId("local-assistant-test-connection"));

    // A later turn may bind elsewhere; each answer in the chat says where it went.
    expect(await screen.findByTestId("local-assistant-endpoint-when")).toHaveTextContent(
      /last check/i,
    );
  });
});

describe("clearing chat history from Settings",() => {
  /** A disk that refuses durable writes while `failing`, keeping what it had. */
  function failingDb() {
    const storage = new MemoryStorageAdapter();
    let failing = false;
    storage.flush = () =>
      failing ? Promise.reject(new Error("disk full")) : Promise.resolve();
    const db = new Database(storage);
    db.prefs.set({ localAssistantEnabled: true });
    db.collection("conversations").put({
      id: "conv_mbx1q2r3a1b2c3d4",
      title: "private scan notes",
      workspaceId: null,
      engagementId: null,
      origin: "chat",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      eraseRevision: 0,
      messages: [
        {
          id: "msg_mbx1q2r30001",
          role: "user",
          content: "private scan notes",
          createdAt: 1,
          requestId: "0f4d1a52-6c1e-4c51-8f0e-3d2b7a9c4e11",
        },
        {
          id: "msg_mbx1q2r30002",
          role: "assistant",
          content: "noted",
          createdAt: 1,
          requestId: "0f4d1a52-6c1e-4c51-8f0e-3d2b7a9c4e11",
        },
      ],
    });
    setDbForTesting(db);
    const reopened = () => new Database(storage).collection("conversations").getAll();
    return {
      fail: () => {
        failing = true;
      },
      recover: () => {
        failing = false;
      },
      reopened,
    };
  }

  it("says the history is still stored when the erase does not reach disk", async () => {
    const disk = failingDb();
    const user = userEvent.setup();
    render(<LocalAssistantSettings />);

    disk.fail();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await clearHistory(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chat history was not cleared. 2 messages are still stored on this machine.",
    );
    expect(disk.reopened().map((c) => [c.title, c.messages.length])).toEqual([
      ["private scan notes", 2],
    ]);
  });

  it("erases everything on Retry", async () => {
    const disk = failingDb();
    const user = userEvent.setup();
    render(<LocalAssistantSettings />);

    disk.fail();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await clearHistory(user);
    await screen.findByRole("alert");
    disk.recover();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(disk.reopened()).toEqual([]);
    expect(screen.getByTestId("local-assistant-clear-history")).toBeDisabled();
  });
});
