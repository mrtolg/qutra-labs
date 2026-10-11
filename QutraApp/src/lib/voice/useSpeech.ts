import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import {
  isSpeaking,
  listVoices,
  speakingId,
  stopSpeaking,
  subscribeSpeaking,
  subscribeVoices,
} from "./speech";

/** The `id` being spoken now (see `SpeakOptions.id`), or null. */
export function useSpeakingId(): string | null {
  return useSyncExternalStore(subscribeSpeaking, speakingId, () => null);
}

/* `getVoices()` may return a new array on every call, so the snapshot is kept
   while the list holds the same voices. */
let voicesSnapshot: SpeechSynthesisVoice[] = [];
const sameVoices = (a: SpeechSynthesisVoice[], b: SpeechSynthesisVoice[]) =>
  a.length === b.length && a.every((voice, i) => voice.voiceURI === b[i]!.voiceURI && voice.name === b[i]!.name);
const readVoices = () => {
  const now = listVoices();
  if (!sameVoices(voicesSnapshot, now)) voicesSnapshot = now;
  return voicesSnapshot;
};
const noVoices: SpeechSynthesisVoice[] = [];

/** The installed voices, updated when Windows reports them (they arrive after
    the first call in some engines). */
export function useVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(subscribeVoices, readVoices, () => noVoices);
}

/** Esc and a page change end speech. Mounted once, in the app shell. */
export function useSpeechCancel(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    stopSpeaking();
  }, [pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isSpeaking()) stopSpeaking();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
