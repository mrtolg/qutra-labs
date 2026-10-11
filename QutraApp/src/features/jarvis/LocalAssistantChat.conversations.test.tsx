import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { clearAllConversations, openConversation } from "@/lib/db/conversations";
import { localAssistant } from "@/lib/localAssistant/client";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* At the chat: the transcript is a conversation document, and an erase
   made anywhere wins over a turn that was already under way. */

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn().mockResolvedValue({ status: "ready", models: [] }),
      listModels: vi.fn().mockResolvedValue({ status: "unavailable", models: [] }),
      streamChat: vi.fn(),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

/** The transcript: a conversation's first question is also its title. */
const transcript = () => within(screen.getByRole("log"));

const streamChat = vi.mocked(localAssistant.streamChat);

Element.prototype.scrollTo = vi.fn();

type StreamOptions = { signal?: AbortSignal; requestId?: string };

function armStreamChat() {
  let options!: StreamOptions;
  let settle!: (value: string) => void;
  streamChat.mockImplementationOnce((_config, _messages, opts) => {
    options = opts ?? {};
    return new Promise<string>((resolve) => {
      settle = resolve;
    });
  });
  return { getOptions: () => options, settle: (value = "") => settle(value) };
}

/** Parks durable commits until `release()`, like a slow disk. */
function heldStorage() {
  const storage = new MemoryStorageAdapter();
  let holding = false;
  let releaseCommit: (() => void) | null = null;
  storage.flush = () =>
    holding
      ? new Promise<void>((resolve) => {
          releaseCommit = resolve;
        })
      : Promise.resolve();
  return {
    storage,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      releaseCommit?.();
      releaseCommit = null;
    },
  };
}

/** A disk that refuses durable writes while `failing`, keeping what it had. */
function failingStorage() {
  const storage = new MemoryStorageAdapter();
  let failing = false;
  storage.flush = () =>
    failing ? Promise.reject(new Error("disk full")) : Promise.resolve();
  return {
    storage,
    fail: () => {
      failing = true;
    },
    recover: () => {
      failing = false;
    },
  };
}

/** What a restart would find: a fresh database over the same disk. */
const reopened = (storage: MemoryStorageAdapter) =>
  new Database(storage).collection("conversations").getAll();

function seedDb(storage = new MemoryStorageAdapter()) {
  const db = new Database(storage);
  db.prefs.set({ localAssistantEnabled: true, assistantContextEnabled: false });
  setDbForTesting(db);
  return db;
}

function seedConversation(db: Database) {
  db.collection("conversations").put({
    id: "conv_mbx1q2r3a1b2c3d4",
    title: "old question",
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
        content: "old question",
        createdAt: 1,
        requestId: "0f4d1a52-6c1e-4c51-8f0e-3d2b7a9c4e11",
      },
      {
        id: "msg_mbx1q2r30002",
        role: "assistant",
        content: "old answer",
        createdAt: 1,
        requestId: "0f4d1a52-6c1e-4c51-8f0e-3d2b7a9c4e11",
      },
    ],
  });
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Jarvis"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

const allMessages = (db: Database) =>
  db
    .collection("conversations")
    .getAll()
    .flatMap((c) => c.messages.map((m) => m.content));

afterEach(() => {
  setDbForTesting(null);
  vi.clearAllMocks();
  // Only the console spy some cases install; the module mocks stay.
  if (vi.isMockFunction(console.error)) vi.mocked(console.error).mockRestore();
});

/** Press Clear conversation, then confirm it in the dialog that asks. */
async function clearConversation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Clear conversation" }));
  const dialog = await screen.findByRole("dialog", { name: "Clear this conversation?" });
  await user.click(within(dialog).getByRole("button", { name: "Clear conversation" }));
}

describe("the chat keeps its transcript as a conversation document", () => {
  it("creates a conversation on the first question and saves the turn under its request id", async () => {
    const db = seedDb();
    const stream = armStreamChat();
    render(<LocalAssistantChat />);

    await ask("what listens on 10.0.0.5?");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => stream.settle("Port 22."));

    const requestId = stream.getOptions().requestId;
    expect(requestId).toBeTruthy();
    await waitFor(() => {
      const [conv] = db.collection("conversations").getAll();
      expect(conv?.title).toBe("what listens on 10.0.0.5?");
      expect(conv?.messages.map((m) => [m.role, m.content, m.requestId])).toEqual([
        ["user", "what listens on 10.0.0.5?", requestId],
        ["assistant", "Port 22.", requestId],
      ]);
    });
  });

  it("shows the transcript migrated from before conversations existed", () => {
    const storage = new MemoryStorageAdapter();
    storage.write("meta", JSON.stringify({ schemaVersion: 13 }));
    storage.write(
      "preferences",
      JSON.stringify({
        localAssistantEnabled: true,
        assistantContextEnabled: false,
        localAssistantHistory: [
          { role: "user", content: "a question from before" },
          { role: "assistant", content: "an answer from before" },
        ],
      }),
    );
    setDbForTesting(new Database(storage));

    render(<LocalAssistantChat />);

    expect(transcript().getByText("a question from before")).toBeInTheDocument();
    expect(transcript().getByText("an answer from before")).toBeInTheDocument();
  });
});

describe("an erase wins over a turn already under way", () => {
  it("a late answer after Settings cleared everything is neither shown nor saved", async () => {
    const db = seedDb();
    seedConversation(db);
    const stream = armStreamChat();
    render(<LocalAssistantChat />);

    await ask("new question");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    const signal = stream.getOptions().signal;

    await act(async () => {
      await clearAllConversations(db);
    });
    await act(async () => stream.settle("late answer"));

    expect(signal?.aborted).toBe(true);
    expect(transcript().queryByText("old question")).toBeNull();
    expect(transcript().queryByText("late answer")).toBeNull();
    expect(db.collection("conversations").getAll()).toEqual([]);
  });

  it("a question waits while Clear is on its way to disk, then goes to the emptied conversation", async () => {
    const disk = heldStorage();
    const db = seedDb(disk.storage);
    seedConversation(db);
    armStreamChat();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    // Until the clear is on disk the transcript still exists, so the chat
    // neither hides it nor accepts a question that would race the erase.
    disk.hold();
    await clearConversation(user);
    expect(screen.getByText("Clearing the conversation…")).toBeInTheDocument();
    expect(transcript().getByText("old question")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message to Jarvis"), "fresh question");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await act(async () => disk.release());
    await waitFor(() => expect(transcript().queryByText("old question")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(allMessages(db)).toEqual(["fresh question"]));
    expect(db.collection("conversations").getAll()[0]?.eraseRevision).toBe(1);
    expect(transcript().getByText("fresh question")).toBeInTheDocument();
  });

  it("erases nothing until the dialog that asks is confirmed", async () => {
    const db = seedDb();
    seedConversation(db);
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await user.click(screen.getByRole("button", { name: "Clear conversation" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear this conversation?" });
    expect(dialog).toHaveTextContent("This cannot be undone");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(transcript().getByText("old question")).toBeInTheDocument();
    expect(allMessages(db)).toEqual(["old question", "old answer"]);
    expect(db.collection("conversations").getAll()[0]?.eraseRevision).toBe(0);
  });

  it("a write that erases nothing does not end the turn", async () => {
    const db = seedDb();
    seedConversation(db);
    const stream = armStreamChat();
    render(<LocalAssistantChat />);

    await ask("still running?");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => {
      await openConversation(db, "conv_mbx1q2r3a1b2c3d4", 99);
    });

    expect(stream.getOptions().signal?.aborted).toBe(false);
    await act(async () => stream.settle("yes"));
    await waitFor(() =>
      expect(allMessages(db)).toEqual(["old question", "old answer", "still running?", "yes"]),
    );
  });
});

describe("an erase that does not reach disk is not reported as done", () => {
  it("keeps the transcript on screen and says it is still stored", async () => {
    const disk = failingStorage();
    const db = seedDb(disk.storage);
    seedConversation(db);
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    disk.fail();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await clearConversation(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The conversation was not cleared. It is still stored on this machine.",
    );
    expect(transcript().getByText("old question")).toBeInTheDocument();
    const [kept] = reopened(disk.storage);
    expect(kept?.title).toBe("old question");
    expect(kept?.messages.map((m) => m.content)).toEqual(["old question", "old answer"]);
    expect(kept?.eraseRevision).toBe(0);
  });

  it("saves a question asked after the failed clear", async () => {
    const disk = failingStorage();
    const db = seedDb(disk.storage);
    seedConversation(db);
    const stream = armStreamChat();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    disk.fail();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await clearConversation(user);
    await screen.findByRole("alert");
    disk.recover();

    await ask("next question");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => stream.settle("next answer"));

    await waitFor(() =>
      expect(reopened(disk.storage).flatMap((c) => c.messages.map((m) => m.content))).toEqual([
        "old question",
        "old answer",
        "next question",
        "next answer",
      ]),
    );
  });

  it("erases on Retry, and a restart brings nothing back", async () => {
    const disk = failingStorage();
    const db = seedDb(disk.storage);
    seedConversation(db);
    const user = userEvent.setup();
    const { unmount } = render(<LocalAssistantChat />);

    disk.fail();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await clearConversation(user);
    await screen.findByRole("alert");
    disk.recover();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(transcript().queryByText("old question")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    const [erased] = reopened(disk.storage);
    expect(erased?.title).toBe("");
    expect(erased?.messages).toEqual([]);
    expect(erased?.eraseRevision).toBe(1);

    unmount();
    setDbForTesting(new Database(disk.storage));
    render(<LocalAssistantChat />);
    expect(transcript().queryByText("old question")).toBeNull();
    expect(transcript().queryByText("old answer")).toBeNull();
  });

  it("says so when a question could not be saved", async () => {
    const disk = failingStorage();
    const db = seedDb(disk.storage);
    seedConversation(db);
    const stream = armStreamChat();
    render(<LocalAssistantChat />);

    disk.fail();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await ask("unsaved question");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => stream.settle("an answer"));

    expect(await screen.findByText(/was not saved on this machine/)).toBeInTheDocument();
  });
});

function seedSecondConversation(db: Database) {
  db.collection("conversations").put({
    id: "conv_mbx9z8y7k6j5h4g3",
    title: "second topic",
    workspaceId: null,
    engagementId: null,
    origin: "chat",
    createdAt: 2,
    updatedAt: 2,
    lastOpenedAt: 2,
    eraseRevision: 0,
    messages: [
      {
        id: "msg_mbx9z8y70001",
        role: "user",
        content: "second topic",
        createdAt: 2,
        requestId: "7a1c9e44-0b2d-4f6e-9a83-5c1d2e3f4a55",
      },
    ],
  });
}

describe("opening a conversation selects it",() => {
  const FIRST = "conv_mbx1q2r3a1b2c3d4";
  const SECOND = "conv_mbx9z8y7k6j5h4g3";

  it("switches the mounted chat to the conversation opened", async () => {
    const db = seedDb();
    seedConversation(db);
    seedSecondConversation(db);
    render(<LocalAssistantChat />);
    expect(transcript().getByText("second topic")).toBeInTheDocument();

    await act(async () => {
      await openConversation(db, FIRST, 99);
    });

    expect(transcript().getByText("old answer")).toBeInTheDocument();
    expect(transcript().queryByText("second topic")).toBeNull();
  });

  it("keeps a running turn with the conversation it began in", async () => {
    const db = seedDb();
    seedConversation(db);
    seedSecondConversation(db);
    const stream = armStreamChat();
    render(<LocalAssistantChat />);

    await ask("follow-up on the second");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => {
      await openConversation(db, FIRST, 99);
    });

    // Switching does not end the turn; it says where the work is.
    expect(stream.getOptions().signal?.aborted).toBe(false);
    expect(screen.getByTestId("assistant-busy-elsewhere")).toHaveTextContent(
      "Jarvis is still answering in “second topic”.",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await act(async () => stream.settle("answer for the second"));
    expect(transcript().queryByText("answer for the second")).toBeNull();
    await waitFor(() => {
      const second = db.collection("conversations").get(SECOND);
      expect(second?.messages.map((m) => m.content)).toEqual([
        "second topic",
        "follow-up on the second",
        "answer for the second",
      ]);
    });
    expect(
      db.collection("conversations").get(FIRST)?.messages.map((m) => m.content),
    ).toEqual(["old question", "old answer"]);
  });

  it("stops the other conversation's turn from here", async () => {
    const db = seedDb();
    seedConversation(db);
    seedSecondConversation(db);
    const stream = armStreamChat();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await ask("long question");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => {
      await openConversation(db, FIRST, 99);
    });
    const busy = screen.getByTestId("assistant-busy-elsewhere");
    await user.click(within(busy).getByRole("button", { name: "Stop" }));

    expect(stream.getOptions().signal?.aborted).toBe(true);
  });

  it("goes back to the conversation that is answering", async () => {
    const db = seedDb();
    seedConversation(db);
    seedSecondConversation(db);
    armStreamChat();
    const user = userEvent.setup();
    render(<LocalAssistantChat />);

    await ask("long question");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await act(async () => {
      await openConversation(db, FIRST, 99);
    });
    await user.click(screen.getByRole("button", { name: "Show" }));

    await waitFor(() => expect(transcript().getByText("long question")).toBeInTheDocument());
    expect(screen.queryByTestId("assistant-busy-elsewhere")).toBeNull();
    expect(db.collection("conversations").get(SECOND)?.lastOpenedAt).toBeGreaterThan(99);
  });

  it("says when the other conversation waits on an approval", async () => {
    const db = seedDb();
    seedConversation(db);
    seedSecondConversation(db);
    let onToolCall!: (event: { requestId: string; callId: string; summary: string }) => void;
    streamChat.mockImplementationOnce((_config, _messages, opts) => {
      onToolCall = opts?.onToolCall as typeof onToolCall;
      return new Promise<string>(() => {});
    });
    render(<LocalAssistantChat />);

    await ask("scan it");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    act(() =>
      onToolCall({
        requestId: "3e7b1f0a-9c2d-4e8f-a1b5-6d4c3b2a1f00",
        callId: "call_8f2e4d1c",
        summary: "Run nmap -sV 10.0.0.5 in a new terminal",
      }),
    );
    await act(async () => {
      await openConversation(db, FIRST, 99);
    });

    expect(screen.getByTestId("assistant-busy-elsewhere")).toHaveTextContent(
      "Jarvis is waiting for your approval in \u201csecond topic\u201d.",
    );
    expect(screen.queryByTestId("assistant-approval-card")).toBeNull();
  });
});
