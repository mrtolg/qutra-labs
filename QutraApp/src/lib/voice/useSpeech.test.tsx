import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { TOLGA, installFakeSpeech, type FakeSynth } from "@/test/fakeSpeech";
import { isSpeaking, speak } from "./speech";
import { useSpeechCancel } from "./useSpeech";

/* Esc and a change of page end speech wherever the app is. */

let fake: FakeSynth;
let go: (to: string) => void;

function Probe() {
  useSpeechCancel();
  const navigate = useNavigate();
  go = (to) => void navigate(to);
  return null;
}

beforeEach(() => {
  fake = installFakeSpeech([TOLGA]);
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  render(
    <MemoryRouter initialEntries={["/overview"]}>
      <Probe />
    </MemoryRouter>,
  );
});
afterEach(() => {
  fake.uninstall();
  setDbForTesting(null);
});

describe("ending speech", () => {
  it("Esc stops it", () => {
    speak("Bir cümle.");
    expect(isSpeaking()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(isSpeaking()).toBe(false);
    expect(fake.synth.cancel).toHaveBeenCalled();
  });

  it("leaves Esc alone when nothing is being said", () => {
    const before = fake.synth.cancel.mock.calls.length;
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fake.synth.cancel.mock.calls.length).toBe(before);
  });

  it("a change of page stops it", () => {
    speak("Bir cümle.");
    act(() => go("/lab"));
    expect(isSpeaking()).toBe(false);
  });

  it("other keys do not stop it", () => {
    speak("Bir cümle.");
    fireEvent.keyDown(window, { key: "a" });
    expect(isSpeaking()).toBe(true);
  });
});
