import { getDb } from "@/lib/db/database";
import { translate, type Locale } from "@/lib/i18n";
import { resolveLocale } from "@/lib/i18n/locales";

/* Qutra speaking: the Web Speech API's `speechSynthesis`, which in WebView2
   uses the voices Windows has installed. Nothing leaves the computer and
   nothing is added to the app.

   `speak(text)` and `stopSpeaking()` are the whole surface other parts of the
   app need. The text is cleaned first (markdown, code and addresses are not
   read out) and spoken sentence by sentence, so a stop takes effect within
   one sentence. */

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
/** The longest piece handed to the engine at once, in characters. */
export const CHUNK_LIMIT = 220;

const LANGUAGE_TAGS: Record<Locale, string> = {
  en: "en-US",
  tr: "tr-TR",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
};

/** The BCP 47 tag the app's language is spoken in. */
export function languageTag(locale: Locale): string {
  return LANGUAGE_TAGS[locale];
}

function engine(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return typeof window.speechSynthesis === "undefined" ? null : window.speechSynthesis;
}

/** Whether this environment can speak at all. */
export function speechAvailable(): boolean {
  return engine() !== null && typeof SpeechSynthesisUtterance !== "undefined";
}

/* ---------- Voices ---------- */

/** The installed voices; empty until the engine has loaded them. */
export function listVoices(): SpeechSynthesisVoice[] {
  try {
    return engine()?.getVoices() ?? [];
  } catch {
    return [];
  }
}

/** Calls `listener` when the installed voices become known or change. */
export function subscribeVoices(listener: () => void): () => void {
  const synth = engine();
  if (!synth) return () => undefined;
  synth.addEventListener("voiceschanged", listener);
  return () => synth.removeEventListener("voiceschanged", listener);
}

const primary = (tag: string) => tag.toLowerCase().replace("_", "-").split("-")[0];

/** Whether a voice speaks the app's language ("tr-TR" speaks "tr"). */
export function voiceMatches(voice: SpeechSynthesisVoice, locale: Locale): boolean {
  return primary(voice.lang) === locale;
}

/** Better first: voices that run on this computer (an online voice sends the
    text away, so it is only chosen when nothing local speaks the language),
    then the region the app's tag names, then the system default. */
function rank(voice: SpeechSynthesisVoice, locale: Locale): number {
  let score = 0;
  if (voice.localService) score += 4;
  if (voice.lang.toLowerCase().replace("_", "-") === languageTag(locale).toLowerCase()) score += 2;
  if (voice.default) score += 1;
  return score;
}

/** The voices for the app's language first, best match first, then every
    other voice by name. */
export function voiceChoices(
  voices: readonly SpeechSynthesisVoice[],
  locale: Locale,
): { matching: SpeechSynthesisVoice[]; others: SpeechSynthesisVoice[] } {
  const byName = (a: SpeechSynthesisVoice, b: SpeechSynthesisVoice) => a.name.localeCompare(b.name);
  const matching = voices.filter((v) => voiceMatches(v, locale));
  matching.sort((a, b) => rank(b, locale) - rank(a, locale) || byName(a, b));
  const others = voices.filter((v) => !voiceMatches(v, locale)).sort(byName);
  return { matching, others };
}

/** The voice to use: the one saved by name when it is still installed, else
    the best match for the language. `null` when no installed voice speaks the
    language -- the engine's own default then reads the text in that language
    rather than a foreign voice being chosen silently. */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  locale: Locale,
  savedName: string,
): SpeechSynthesisVoice | null {
  if (savedName) {
    const saved = voices.find((v) => v.name === savedName);
    if (saved) return saved;
  }
  return voiceChoices(voices, locale).matching[0] ?? null;
}

/* ---------- Cleaning and chunking ---------- */

/** What is left of a markdown answer when it is read aloud: no markup, no
    addresses, and code replaced by `codeLabel` ("code block"). Line breaks
    stay as sentence breaks. */
export function stripForSpeech(markdown: string, codeLabel: string): string {
  // Fenced blocks (closed, or running to the end of a cut-off answer) become
  // one spoken phrase.
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence === null) {
      if (marker) {
        fence = marker[0];
        kept.push(`${codeLabel}.`);
      } else {
        kept.push(line);
      }
    } else if (marker && marker[0] === fence && line.trim() === marker) {
      fence = null;
    }
  }
  let text = kept.join("\n");
  // Images drop out, links keep their words.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Addresses on their own.
  text = text.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s)<>"]+/gi, "");
  text = text.replace(/<[^>\n]+>/g, "");
  // Inline code keeps its words, not its backticks.
  text = text.replace(/`([^`\n]*)`/g, "$1");
  text = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>+\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^\s*(?:[-*_]\s*){3,}$/, "")
        .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/, "")
        .replace(/\|/g, ", ")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, "$2")
        .replace(/~~(.+?)~~/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .join("\n");
  return text.replace(/\n{2,}/g, "\n").trim();
}

function splitLong(piece: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = piece;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
    const cut = at > limit / 2 ? at + 1 : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Sentences packed into pieces of at most `limit` characters. */
export function chunkForSpeech(text: string, limit = CHUNK_LIMIT): string[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => (s.length > limit ? splitLong(s, limit) : [s]));
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + 1 + sentence.length <= limit) {
      chunks[last] += ` ${sentence}`;
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}

/* ---------- Speaking ---------- */

export type SpeakOptions = {
  /** Names this speech so a button can show that it is the one playing. */
  id?: string;
  /** The language of the text; defaults to the app's language. */
  locale?: Locale;
  /** Overrides the saved voice name. */
  voiceName?: string;
  /** Overrides the saved speed. */
  rate?: number;
  /** What is said in place of a code block; defaults to the app's words. */
  codeLabel?: string;
  /** Called once when the last piece has been spoken (not when cut short). */
  onEnd?: () => void;
};

let playing: { id: string } | null = null;
let nextAnonymous = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever speech starts or ends. */
export function subscribeSpeaking(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The `id` of what is being spoken now, or `null` when it is quiet. */
export function speakingId(): string | null {
  return playing?.id ?? null;
}

export function isSpeaking(): boolean {
  return playing !== null;
}

/** Stops at once, mid-sentence; whatever was queued is dropped. */
export function stopSpeaking(): void {
  const was = playing;
  playing = null;
  try {
    engine()?.cancel();
  } catch {
    // A voice engine that refuses to cancel has nothing left to stop.
  }
  if (was) notify();
}

/** Reads `text` aloud with the saved voice and speed, replacing whatever is
    being said. Quiet when there is nothing to say or no speech engine. */
export function speak(text: string, options: SpeakOptions = {}): void {
  stopSpeaking();
  const synth = engine();
  if (!synth || !speechAvailable()) return;
  const prefs = getDb().prefs.get();
  const locale = options.locale ?? resolveLocale(prefs.locale);
  const codeLabel = options.codeLabel ?? translate(locale, "voice.codeBlock");
  const chunks = chunkForSpeech(stripForSpeech(text, codeLabel));
  if (chunks.length === 0) return;

  const voice = pickVoice(listVoices(), locale, options.voiceName ?? prefs.voiceName);
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, options.rate ?? prefs.voiceRate));
  const mine = { id: options.id ?? `speech-${(nextAnonymous += 1)}` };
  playing = mine;
  notify();

  const finish = (completed: boolean) => {
    if (playing !== mine) return;
    playing = null;
    notify();
    if (completed) options.onEnd?.();
  };
  const say = (index: number) => {
    if (playing !== mine) return;
    if (index >= chunks.length) {
      finish(true);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    utterance.lang = voice?.lang ?? languageTag(locale);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onend = () => say(index + 1);
    utterance.onerror = (event) => {
      // A cancel by someone else (another speech began) is not a failure here:
      // `playing` already moved on. Any other error ends this speech.
      if (event.error === "canceled" || event.error === "interrupted") return;
      finish(false);
    };
    try {
      synth.speak(utterance);
    } catch {
      finish(false);
    }
  };
  say(0);
}

/** Speaks only when the user turned reading aloud on; true when it did. */
export function speakIfEnabled(text: string, options: SpeakOptions = {}): boolean {
  if (!getDb().prefs.get().voiceReadAloud || !speechAvailable()) return false;
  speak(text, options);
  return true;
}
