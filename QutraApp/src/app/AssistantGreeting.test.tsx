import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { registerDeferredCopy } from "@/lib/i18n";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { deferredTr } from "@/lib/i18n/deferred/tr";
import { AssistantGreeting, GREETING_MS, resetGreetingForTesting } from "./AssistantGreeting";

const card = () => screen.queryByTestId("assistant-greeting");
const at = (hour: number) => vi.setSystemTime(new Date(2026, 9, 11, hour, 30));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function setup(prefs: Record<string, unknown>) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set(prefs);
  setDbForTesting(db);
}

async function show(prefs: Record<string, unknown>, hour = 9) {
  at(hour);
  setup({ localAssistantEnabled: true, locale: "tr", ...prefs });
  await act(async () => void render(<AssistantGreeting />));
}

beforeEach(() => {
  vi.useFakeTimers();
  registerDeferredCopy("en", deferredEn);
  registerDeferredCopy("tr", deferredTr);
  resetGreetingForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  setDbForTesting(null);
});

describe("the assistant's greeting", () => {
  it("greets by the time of day and the form of address the user gave", async () => {
    await show({ addressAs: "  Mert Bey " });

    expect(card()).toHaveTextContent("Günaydın, Mert Bey. İhtiyacınız olduğunda buradayım.");
  });

  it("greets without a name when there is no form of address", async () => {
    await show({ addressAs: "   " }, 20);

    expect(card()).toHaveTextContent("İyi akşamlar. İhtiyacınız olduğunda buradayım.");
  });

  it("follows the part of the day in the user's language", async () => {
    await show({ locale: "en", addressAs: "sir" }, 14);

    expect(card()).toHaveTextContent("Good afternoon, sir. I'm here whenever you need me.");
  });

  it("stays about ten seconds, then goes", async () => {
    await show({});

    await wait(GREETING_MS - 100);
    expect(card()).toBeInTheDocument();
    await wait(200);
    expect(card()).not.toBeInTheDocument();
  });

  it("waits while the pointer is on it and goes after the rest of its time", async () => {
    await show({});

    await wait(6_000);
    fireEvent.mouseEnter(card()!);
    await wait(60_000);
    expect(card()).toBeInTheDocument();

    fireEvent.mouseLeave(card()!);
    await wait(3_800);
    expect(card()).toBeInTheDocument();
    await wait(400);
    expect(card()).not.toBeInTheDocument();
  });

  it("waits while the keyboard is on it", async () => {
    await show({});

    fireEvent.focus(screen.getByRole("button"));
    await wait(30_000);
    expect(card()).toBeInTheDocument();
  });

  it("closes when asked", async () => {
    await show({});

    fireEvent.click(screen.getByRole("button"));

    expect(card()).not.toBeInTheDocument();
  });

  it("greets once per launch, however often the shell mounts again", async () => {
    await show({});
    fireEvent.click(screen.getByRole("button"));
    await act(async () => void render(<AssistantGreeting />));

    expect(card()).not.toBeInTheDocument();
  });

  it("says nothing while the assistant is off", async () => {
    await show({ localAssistantEnabled: false, addressAs: "Mert Bey" });

    expect(card()).not.toBeInTheDocument();
  });
});
