import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { TOLGA, installFakeSpeech, type FakeSynth } from "@/test/fakeSpeech";
import { AssistantGreeting, resetGreetingForTesting } from "./AssistantGreeting";

/* The launch greeting is spoken when reading aloud is on, and not otherwise. */

let fake: FakeSynth;

async function show(prefs: Record<string, unknown>) {
  vi.setSystemTime(new Date(2026, 9, 11, 9, 30));
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ localAssistantEnabled: true, locale: "tr", addressAs: "Mert Bey", ...prefs });
  setDbForTesting(db);
  await act(async () => void render(<AssistantGreeting />));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetGreetingForTesting();
  fake = installFakeSpeech([TOLGA]);
});
afterEach(() => {
  fake.uninstall();
  vi.useRealTimers();
  setDbForTesting(null);
});

describe("the launch greeting, aloud", () => {
  it("is spoken in the user's language when reading aloud is on", async () => {
    await show({ voiceReadAloud: true });

    expect(screen.getByTestId("assistant-greeting")).toBeInTheDocument();
    expect(fake.spoken).toHaveLength(1);
    expect(fake.spoken[0]!.text).toBe("Günaydın, Mert Bey. İhtiyacınız olduğunda buradayım.");
    expect(fake.spoken[0]!.lang).toBe("tr-TR");
    expect(fake.spoken[0]!.voice?.name).toBe(TOLGA.name);
  });

  it("stays silent when reading aloud is off", async () => {
    await show({});

    expect(screen.getByTestId("assistant-greeting")).toBeInTheDocument();
    expect(fake.spoken).toHaveLength(0);
  });

  it("closing the card stops the voice", async () => {
    await show({ voiceReadAloud: true });

    fireEvent.click(screen.getByRole("button", { name: /^(Close|Kapat)/ }));
    expect(fake.synth.cancel).toHaveBeenCalled();
    expect(screen.queryByTestId("assistant-greeting")).not.toBeInTheDocument();
  });
});
