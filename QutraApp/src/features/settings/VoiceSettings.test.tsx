import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { ensureLocaleLoaded } from "@/lib/i18n";
import { DAVID, HAZEL, TOLGA, installFakeSpeech, voice, type FakeSynth } from "@/test/fakeSpeech";
import { VoiceSettings } from "./VoiceSettings";

/* Settings › AI providers › Voice, against a stand-in speech engine. */

let fake: FakeSynth | null = null;

beforeAll(() => ensureLocaleLoaded("tr"));

function setup(prefs: Record<string, unknown> = {}, voices = [DAVID, TOLGA, HAZEL]) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ locale: "tr", ...prefs });
  setDbForTesting(db);
  fake = installFakeSpeech(voices);
  return db;
}

afterEach(() => {
  fake?.uninstall();
  fake = null;
  setDbForTesting(null);
});

describe("Settings › Voice", () => {
  let db: Database;
  beforeEach(() => {
    db = setup();
  });

  it("is off by default and turns reading aloud on and off", async () => {
    render(<VoiceSettings />);
    const toggle = screen.getByRole("checkbox", { name: "Cevapları sesli oku" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(db.prefs.get().voiceReadAloud).toBe(true);
    await userEvent.click(toggle);
    expect(db.prefs.get().voiceReadAloud).toBe(false);
  });

  it("lists the voices for the language first and defaults to the best match", () => {
    render(<VoiceSettings />);
    const picker = screen.getByTestId("voice-picker") as HTMLSelectElement;
    const groups = Array.from(picker.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Türkçe için sesler", "Diğer sesler"]);
    expect(within(picker.querySelectorAll("optgroup")[0] as HTMLElement).getAllByRole("option")).toHaveLength(1);
    expect(picker.value).toBe("");
    expect(screen.getByRole("option", { name: `Otomatik (${TOLGA.name})` })).toBeInTheDocument();
  });

  it("saves the picked voice by name", async () => {
    render(<VoiceSettings />);
    await userEvent.selectOptions(screen.getByTestId("voice-picker"), HAZEL.name);
    expect(db.prefs.get().voiceName).toBe(HAZEL.name);
  });

  it("says so when a saved voice is gone and uses the best match meanwhile", () => {
    db.prefs.set({ voiceName: "Microsoft Removed" });
    render(<VoiceSettings />);
    expect(screen.getByTestId("voice-saved-missing")).toHaveTextContent(
      `Seçtiğiniz ses (Microsoft Removed) artık kurulu değil. Onun yerine ${TOLGA.name} kullanılıyor.`,
    );
    expect((screen.getByTestId("voice-picker") as HTMLSelectElement).value).toBe("");
  });

  it("warns when no installed voice speaks the language", () => {
    fake!.setVoices([DAVID]);
    render(<VoiceSettings />);
    expect(screen.getByTestId("voice-no-match")).toHaveTextContent("Türkçe");
  });

  it("marks an online voice and says what that means", () => {
    fake!.setVoices([voice("Online Natural - Turkish", "tr-TR", { localService: false })]);
    render(<VoiceSettings />);
    expect(screen.getByRole("option", { name: "Online Natural - Turkish (çevrimiçi)" })).toBeInTheDocument();
    expect(screen.getByTestId("voice-online-note")).toBeInTheDocument();
  });

  it("changes the speed", () => {
    render(<VoiceSettings />);
    const slider = screen.getByLabelText("Hız") as HTMLInputElement;
    expect(slider.min).toBe("0.5");
    expect(slider.max).toBe("2");
    act(() => {
      getDb().prefs.set({ voiceRate: 1.6 });
    });
    expect(slider.value).toBe("1.6");
    expect(screen.getByText("1.6×")).toBeInTheDocument();
  });

  it("tries the voice with a sample, and stops it on a second press", async () => {
    db.prefs.set({ voiceName: HAZEL.name, voiceRate: 1.2 });
    render(<VoiceSettings />);
    await userEvent.click(screen.getByTestId("voice-try"));
    const sample = fake!.spoken[0]!;
    expect(sample.text).toBe("Merhaba, ben Qutra. Cevaplarımı bu sesle okuyacağım.");
    expect(sample.voice?.name).toBe(HAZEL.name);
    expect(sample.rate).toBe(1.2);
    expect(screen.getByTestId("voice-try")).toHaveTextContent("Durdur");
    await userEvent.click(screen.getByTestId("voice-try"));
    expect(fake!.synth.cancel).toHaveBeenCalled();
    expect(screen.getByTestId("voice-try")).toHaveTextContent("Dene");
  });

  it("picks up voices that Windows reports after the page opened", () => {
    fake!.setVoices([]);
    render(<VoiceSettings />);
    expect(screen.getByTestId("voice-none")).toHaveTextContent("Bu bilgisayarda kurulu ses yok");
    act(() => fake!.setVoices([TOLGA]));
    expect(screen.queryByTestId("voice-none")).not.toBeInTheDocument();
    expect(screen.getByTestId("voice-picker")).toBeInTheDocument();
  });
});

describe("Settings › Voice without a speech engine", () => {
  it("says it is unavailable and keeps the switch off", () => {
    setDbForTesting(new Database(new MemoryStorageAdapter()));
    render(<VoiceSettings />);
    expect(screen.getByTestId("voice-unavailable")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Read answers aloud" })).toBeDisabled();
  });
});
