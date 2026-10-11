import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { localAssistant } from "@/lib/localAssistant/client";
import { isSpeaking, stopSpeaking } from "@/lib/voice/speech";
import { TOLGA, installFakeSpeech, type FakeSynth } from "@/test/fakeSpeech";
import { LocalAssistantChat } from "./LocalAssistantChat";

/* Reading answers aloud in the chat: a speaker button on each answer, an
   automatic read of a finished answer when the user asked for it, and a new
   question or Stop ending whatever is being said. */

vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localAssistant/client")>();
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

Element.prototype.scrollTo = vi.fn();
const streamChat = vi.mocked(localAssistant.streamChat);

let fake: FakeSynth;

function seed(prefs: Record<string, unknown> = {}) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, assistantContextEnabled: false, ...prefs });
  setDbForTesting(db);
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Qutra"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => {
  fake = installFakeSpeech([TOLGA]);
  streamChat.mockReset();
});
afterEach(() => {
  stopSpeaking();
  fake.uninstall();
  setDbForTesting(null);
});

describe("reading answers aloud in the chat", () => {
  it("puts a speaker button on a finished answer that reads it and stops it", async () => {
    seed();
    streamChat.mockResolvedValueOnce("Merhaba. **Kalın** bir cevap.");
    const user = userEvent.setup();
    render(<LocalAssistantChat />);
    await ask("selam");

    const button = await screen.findByTestId("assistant-speak");
    expect(fake.spoken).toHaveLength(0);
    await user.click(button);
    expect(fake.spoken[0]!.text).toBe("Merhaba. Kalın bir cevap.");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAccessibleName("Stop reading");

    await user.click(button);
    expect(fake.synth.cancel).toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAccessibleName("Read aloud");
  });

  it("does not read a finished answer on its own while reading aloud is off", async () => {
    seed();
    streamChat.mockResolvedValueOnce("Cevap.");
    render(<LocalAssistantChat />);
    await ask("selam");
    await screen.findByTestId("assistant-speak");
    expect(fake.spoken).toHaveLength(0);
  });

  it("reads a finished answer on its own when reading aloud is on", async () => {
    seed({ voiceReadAloud: true });
    streamChat.mockResolvedValueOnce("Şu komut:\n```\nnmap -sV 10.0.0.1\n```\nBitti.");
    render(<LocalAssistantChat />);
    await ask("tara");

    await waitFor(() => expect(fake.spoken.length).toBeGreaterThan(0));
    const said = fake.spoken.map((u) => u.text).join(" ");
    expect(said).toContain("code block");
    expect(said).not.toContain("nmap");
    expect(await screen.findByTestId("assistant-speak")).toHaveAttribute("aria-pressed", "true");
  });

  it("a new question ends the answer that is still being read", async () => {
    seed({ voiceReadAloud: true });
    streamChat.mockResolvedValueOnce("Birinci cevap. ".repeat(40));
    render(<LocalAssistantChat />);
    await ask("bir");
    await waitFor(() => expect(isSpeaking()).toBe(true));

    streamChat.mockReturnValueOnce(new Promise(() => undefined));
    const cancels = fake.synth.cancel.mock.calls.length;
    await ask("iki");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2));
    expect(fake.synth.cancel.mock.calls.length).toBeGreaterThan(cancels);
    expect(isSpeaking()).toBe(false);
  });

  it("does not read an answer the user stopped", async () => {
    seed({ voiceReadAloud: true });
    let settle!: (text: string) => void;
    streamChat.mockImplementationOnce(
      () => new Promise<string>((resolve) => (settle = resolve)),
    );
    const user = userEvent.setup();
    render(<LocalAssistantChat />);
    await ask("uzun bir soru");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    settle("Yarım kalan cevap.");
    await screen.findByText("Yarım kalan cevap.");
    expect(fake.spoken).toHaveLength(0);
  });

  it("shows no speaker button where speech is not available", async () => {
    fake.uninstall();
    seed();
    streamChat.mockResolvedValueOnce("Cevap.");
    render(<LocalAssistantChat />);
    await ask("selam");
    await screen.findByText("Cevap.");
    expect(screen.queryByTestId("assistant-speak")).not.toBeInTheDocument();
  });
});
