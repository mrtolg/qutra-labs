import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { PreferencesSchema } from "@/domain/types";
import {
  DAVID,
  HAZEL,
  TOLGA,
  ZIRA,
  installFakeSpeech,
  voice,
  type FakeSynth,
} from "@/test/fakeSpeech";
import {
  CHUNK_LIMIT,
  chunkForSpeech,
  isSpeaking,
  pickVoice,
  speak,
  speakIfEnabled,
  speakingId,
  stopSpeaking,
  stripForSpeech,
  voiceChoices,
} from "./speech";

const asVoices = (list: unknown[]) => list as SpeechSynthesisVoice[];

describe("voice selection by language", () => {
  const all = asVoices([DAVID, TOLGA, ZIRA, HAZEL]);

  it("picks the voice that speaks the app language", () => {
    expect(pickVoice(all, "tr", "")?.name).toBe(TOLGA.name);
  });

  it("prefers a voice on this computer to an online one, then the app's own region", () => {
    const online = voice("Online Natural - English (United States)", "en-US", { localService: false });
    expect(pickVoice(asVoices([HAZEL, online, DAVID]), "en", "")?.name).toBe(DAVID.name);
    // Local but another region still beats an online voice of the right one.
    expect(pickVoice(asVoices([online, HAZEL]), "en", "")?.name).toBe(HAZEL.name);
    // With only online voices for the language, one is used.
    expect(pickVoice(asVoices([online]), "en", "")?.name).toBe(online.name);
  });

  it("lists the voices for the language first, then every other voice", () => {
    const { matching, others } = voiceChoices(all, "tr");
    expect(matching.map((v) => v.name)).toEqual([TOLGA.name]);
    expect(others.map((v) => v.name)).toEqual([DAVID.name, HAZEL.name, ZIRA.name]);
  });

  it("keeps a saved voice even if it speaks another language", () => {
    expect(pickVoice(all, "tr", HAZEL.name)?.name).toBe(HAZEL.name);
  });

  it("falls back to the best match when the saved voice is gone", () => {
    expect(pickVoice(all, "tr", "Microsoft Removed")?.name).toBe(TOLGA.name);
  });

  it("chooses no voice when none speaks the language, rather than a foreign one", () => {
    expect(pickVoice(asVoices([DAVID, ZIRA]), "tr", "")).toBeNull();
    expect(pickVoice([], "tr", "")).toBeNull();
  });
});

describe("what is left to say", () => {
  it("drops markdown marks but keeps the words", () => {
    const md = "# Title\n\n**Bold** and *soft* and ~~gone~~ text.\n\n> quoted\n\n- first\n- second\n1. third";
    expect(stripForSpeech(md, "code block")).toBe(
      "Title\nBold and soft and gone text.\nquoted\nfirst\nsecond\nthird",
    );
  });

  it("says the code label in place of fenced code, closed or cut off", () => {
    const closed = "Run this:\n```bash\nrm -rf /tmp/x\nls\n```\nThen wait.";
    expect(stripForSpeech(closed, "kod bloğu")).toBe("Run this:\nkod bloğu.\nThen wait.");
    const open = "Here:\n~~~\nline one\nline two";
    expect(stripForSpeech(open, "kod bloğu")).toBe("Here:\nkod bloğu.");
    expect(stripForSpeech(closed, "kod bloğu")).not.toContain("rm -rf");
  });

  it("does not read addresses, and keeps the words of a link", () => {
    const md = "See [the guide](https://example.com/guide) or https://example.com/x?a=1 and www.example.org now.";
    expect(stripForSpeech(md, "code block")).toBe("See the guide or and now.");
  });

  it("reads inline code without its backticks and a table without its rules", () => {
    expect(stripForSpeech("Use `nmap -sV` here.", "code block")).toBe("Use nmap -sV here.");
    const table = stripForSpeech("| a | b |\n| --- | --- |\n| 1 | 2 |", "code block");
    expect(table).not.toContain("---");
    expect(table).not.toContain("|");
  });
});

describe("sentence chunks", () => {
  it("keeps every word and starts a new piece at a sentence end", () => {
    const text = "First sentence here. Second one follows! Is a third a question? Yes.";
    const pieces = chunkForSpeech(text, 45);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 45)).toBe(true);
    expect(pieces.join(" ")).toBe(text);
  });

  it("does not split a decimal number or a path", () => {
    expect(chunkForSpeech("Version 3.5 is in C:\\tools.", 200)).toEqual(["Version 3.5 is in C:\\tools."]);
  });

  it("cuts a very long sentence at a space instead of running on", () => {
    const sentence = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + ".";
    const pieces = chunkForSpeech(sentence);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((p) => p.length <= CHUNK_LIMIT)).toBe(true);
    expect(pieces.join(" ")).toBe(sentence);
  });

  it("gives nothing for nothing", () => {
    expect(chunkForSpeech("  \n ")).toEqual([]);
  });
});

describe("speaking", () => {
  let fake: FakeSynth;
  let db: Database;

  beforeEach(() => {
    fake = installFakeSpeech([DAVID, TOLGA]);
    db = new Database(new MemoryStorageAdapter());
    db.prefs.set({ locale: "tr" });
    setDbForTesting(db);
  });
  afterEach(() => {
    fake.uninstall();
    setDbForTesting(null);
  });

  it("speaks with the voice, language and speed chosen", () => {
    db.prefs.set({ voiceRate: 1.4 });
    speak("Bir. İki. Üç.", { id: "a" });
    const first = fake.spoken[0]!;
    expect(first.text).toBe("Bir. İki. Üç.");
    expect(first.voice?.name).toBe(TOLGA.name);
    expect(first.lang).toBe("tr-TR");
    expect(first.rate).toBe(1.4);
    expect(speakingId()).toBe("a");
    fake.finishCurrent();
    expect(speakingId()).toBeNull();
  });

  it("queues one piece at a time so a stop is heard within a sentence", () => {
    const long = Array.from({ length: 6 }, (_, i) => `${"kelime ".repeat(24).trim()} ${i}.`).join(" ");
    const done = vi.fn();
    speak(long, { id: "long", onEnd: done });
    expect(fake.spoken).toHaveLength(1);
    fake.finishCurrent();
    expect(fake.spoken).toHaveLength(2);
    expect(isSpeaking()).toBe(true);
    stopSpeaking();
    fake.finishCurrent();
    expect(fake.spoken).toHaveLength(2);
    expect(isSpeaking()).toBe(false);
    expect(done).not.toHaveBeenCalled();
  });

  it("calls onEnd once the last piece is spoken", () => {
    const done = vi.fn();
    speak("Tek cümle.", { onEnd: done });
    expect(done).not.toHaveBeenCalled();
    fake.finishCurrent();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a new answer cancels the one still being read", () => {
    speak("Eski cevap.", { id: "old" });
    speak("Yeni cevap.", { id: "new" });
    expect(fake.synth.cancel).toHaveBeenCalled();
    expect(speakingId()).toBe("new");
    expect(fake.current?.text).toBe("Yeni cevap.");
    expect(fake.spoken.map((u) => u.text)).toEqual(["Eski cevap.", "Yeni cevap."]);
  });

  it("stop cancels the engine and goes quiet at once", () => {
    speak("Bir cümle.", { id: "x" });
    stopSpeaking();
    expect(fake.synth.cancel).toHaveBeenCalled();
    expect(speakingId()).toBeNull();
  });

  it("says the code label for code and never the code itself", () => {
    speak("Şunu çalıştırın:\n```\nsudo rm -rf /\n```\nBitti.", { id: "c" });
    const said: string[] = [];
    while (fake.current) {
      said.push(fake.current.text);
      fake.finishCurrent();
    }
    expect(said.join(" ")).toContain("kod bloğu");
    expect(said.join(" ")).not.toContain("sudo");
  });

  it("is silent for a text that is only an address", () => {
    speak("https://example.com", { id: "u" });
    expect(fake.spoken).toHaveLength(0);
    expect(isSpeaking()).toBe(false);
  });

  it("falls back to the best voice when the saved one is gone", () => {
    db.prefs.set({ voiceName: "Microsoft Removed" });
    speak("Merhaba.");
    expect(fake.spoken[0]!.voice?.name).toBe(TOLGA.name);
  });

  it("uses the language tag when no installed voice speaks the language", () => {
    fake.setVoices([DAVID]);
    speak("Merhaba.");
    expect(fake.spoken[0]!.voice).toBeNull();
    expect(fake.spoken[0]!.lang).toBe("tr-TR");
  });

  it("clamps the speed to what the engine accepts", () => {
    speak("Hızlı.", { rate: 9 });
    expect(fake.spoken[0]!.rate).toBe(2);
  });

  it("speaks on its own only when reading aloud is on", () => {
    expect(speakIfEnabled("Cevap.")).toBe(false);
    expect(fake.spoken).toHaveLength(0);
    db.prefs.set({ voiceReadAloud: true });
    expect(speakIfEnabled("Cevap.")).toBe(true);
    expect(fake.spoken).toHaveLength(1);
  });
});

describe("without a speech engine", () => {
  it("does nothing and does not throw", () => {
    const db = new Database(new MemoryStorageAdapter());
    db.prefs.set({ voiceReadAloud: true });
    setDbForTesting(db);
    expect(() => speak("Merhaba.")).not.toThrow();
    expect(speakIfEnabled("Merhaba.")).toBe(false);
    expect(() => stopSpeaking()).not.toThrow();
    setDbForTesting(null);
  });
});

describe("the voice preferences", () => {
  it("start off, with the automatic voice at normal speed", () => {
    const prefs = PreferencesSchema.parse({});
    expect(prefs.voiceReadAloud).toBe(false);
    expect(prefs.voiceName).toBe("");
    expect(prefs.voiceRate).toBe(1);
  });

  it("survive a restart, the voice by name", () => {
    const storage = new MemoryStorageAdapter();
    new Database(storage).prefs.set({
      voiceReadAloud: true,
      voiceName: TOLGA.name,
      voiceRate: 1.3,
    });
    const reopened = new Database(storage).prefs.get();
    expect(reopened.voiceReadAloud).toBe(true);
    expect(reopened.voiceName).toBe(TOLGA.name);
    expect(reopened.voiceRate).toBe(1.3);
  });

  it("repair a damaged value instead of resetting the rest", () => {
    const prefs = PreferencesSchema.parse({ locale: "tr", voiceRate: 99, voiceReadAloud: "yes" });
    expect(prefs.voiceRate).toBe(1);
    expect(prefs.voiceReadAloud).toBe(false);
    expect(prefs.locale).toBe("tr");
  });
});
