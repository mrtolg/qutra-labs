import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { registerDeferredCopy } from "@/lib/i18n";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { deferredTr } from "@/lib/i18n/deferred/tr";
import { useUi } from "@/state/ui";
import { AssistantGreeting, resetGreetingForTesting } from "./AssistantGreeting";

const messages = () => useUi.getState().toasts.map((toast) => toast.message);
const at = (hour: number) => vi.setSystemTime(new Date(2026, 9, 11, hour, 30));

async function setup(prefs: Record<string, unknown>) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(prefs);
  setDbForTesting(db);
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  registerDeferredCopy("en", deferredEn);
  registerDeferredCopy("tr", deferredTr);
  useUi.setState({ toasts: [] });
  resetGreetingForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  setDbForTesting(null);
});

describe("the assistant's greeting", () => {
  it("greets by the time of day and the form of address the user gave", async () => {
    at(9);
    await setup({ localAssistantEnabled: true, locale: "tr", addressAs: "  Mert Bey " });
    await act(async () => void render(<AssistantGreeting />));

    expect(messages()).toEqual(["Günaydın, Mert Bey. İhtiyacınız olduğunda buradayım."]);
  });

  it("greets without a name when there is no form of address", async () => {
    at(20);
    await setup({ localAssistantEnabled: true, locale: "tr", addressAs: "   " });
    await act(async () => void render(<AssistantGreeting />));

    expect(messages()).toEqual(["İyi akşamlar. İhtiyacınız olduğunda buradayım."]);
  });

  it("follows the part of the day in the user's language", async () => {
    at(14);
    await setup({ localAssistantEnabled: true, locale: "en", addressAs: "sir" });
    await act(async () => void render(<AssistantGreeting />));

    expect(messages()).toEqual(["Good afternoon, sir. I'm here whenever you need me."]);
  });

  it("greets once per launch, however often the shell mounts again", async () => {
    at(9);
    await setup({ localAssistantEnabled: true, locale: "tr" });
    const first = render(<AssistantGreeting />);
    await act(async () => undefined);
    first.unmount();
    await act(async () => void render(<AssistantGreeting />));

    expect(messages()).toHaveLength(1);
  });

  it("says nothing while the assistant is off", async () => {
    at(9);
    await setup({ localAssistantEnabled: false, locale: "tr", addressAs: "Mert Bey" });
    await act(async () => void render(<AssistantGreeting />));

    expect(messages()).toEqual([]);
  });
});
