import { vi } from "vitest";
import { stopSpeaking } from "@/lib/voice/speech";

/* A stand-in for the browser's `speechSynthesis`: it records what was asked
   to be spoken and lets a test decide when each piece "finishes". */

export type FakeVoice = { name: string; lang: string; localService: boolean; default: boolean; voiceURI: string };

export function voice(name: string, lang: string, extra: Partial<FakeVoice> = {}): FakeVoice {
  return { name, lang, localService: true, default: false, voiceURI: name, ...extra };
}

export class FakeUtterance {
  voice: FakeVoice | null = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

export type FakeSynth = ReturnType<typeof installFakeSpeech>;

export function installFakeSpeech(initialVoices: FakeVoice[]) {
  let voices = initialVoices;
  const listeners = new Set<() => void>();
  const spoken: FakeUtterance[] = [];
  let current: FakeUtterance | null = null;
  const synth = {
    getVoices: vi.fn(() => voices),
    speak: vi.fn((utterance: FakeUtterance) => {
      spoken.push(utterance);
      current = utterance;
    }),
    cancel: vi.fn(() => {
      const was = current;
      current = null;
      was?.onerror?.({ error: "canceled" });
    }),
    addEventListener: vi.fn((_name: string, listener: () => void) => void listeners.add(listener)),
    removeEventListener: vi.fn((_name: string, listener: () => void) => void listeners.delete(listener)),
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return {
    synth,
    spoken,
    /** What is being spoken right now, if anything. */
    get current() {
      return current;
    },
    /** The current piece finishes; the next one (if any) is queued by the app. */
    finishCurrent() {
      const was = current;
      current = null;
      was?.onend?.();
    },
    /** Windows reports a different list of voices. */
    setVoices(next: FakeVoice[]) {
      voices = next;
      for (const listener of [...listeners]) listener();
    },
    uninstall() {
      stopSpeaking();
      Reflect.deleteProperty(window, "speechSynthesis");
      vi.unstubAllGlobals();
    },
  };
}

export const TOLGA = voice("Microsoft Tolga - Turkish (Turkey)", "tr-TR");
export const DAVID = voice("Microsoft David - English (United States)", "en-US");
export const ZIRA = voice("Microsoft Zira - English (United States)", "en-US", { default: true });
export const HAZEL = voice("Microsoft Hazel - English (United Kingdom)", "en-GB");
