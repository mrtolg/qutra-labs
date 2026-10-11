import { expect, test, type Page } from "@playwright/test";
import { openSettings, primePreferences, waitForAppReady } from "./helpers";

/* Settings › AI providers › Voice. The headless browser may have no speech
   voices at all, so the first test accepts either "a picker" or the plain
   message that there are none; the second gives the page a stand-in engine
   with known voices and checks the choices end to end. */

type Spoken = { text: string; lang: string; voice: string | null; rate: number };

async function installVoices(page: Page, voices: { name: string; lang: string }[]) {
  await page.addInitScript((list) => {
    const spoken: Spoken[] = [];
    const listeners = new Set<() => void>();
    const synth = {
      getVoices: () =>
        list.map((v) => ({ ...v, voiceURI: v.name, localService: true, default: false })),
      speak: (u: { text: string; lang: string; voice: { name: string } | null; rate: number; onend?: () => void }) => {
        spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.name ?? null, rate: u.rate });
      },
      cancel: () => undefined,
      addEventListener: (_: string, l: () => void) => void listeners.add(l),
      removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    class Utterance {
      voice: { name: string } | null = null;
      lang = "";
      rate = 1;
      constructor(public text: string) {}
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true });
    (window as unknown as { __spoken: Spoken[] }).__spoken = spoken;
  }, voices);
}

test("the voice section renders with a picker, or says plainly that no voice is installed", async ({ page }) => {
  await primePreferences(page, { locale: "tr" });
  await page.goto("/#/overview");
  await waitForAppReady(page);
  const dialog = await openSettings(page, "ai");

  const section = dialog.getByTestId("voice-settings");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "Ses" })).toBeVisible();
  const toggle = section.getByRole("checkbox", { name: "Cevapları sesli oku" });
  await expect(toggle).not.toBeChecked();

  const picker = section.getByTestId("voice-picker");
  const none = section.getByTestId("voice-none");
  const unavailable = section.getByTestId("voice-unavailable");
  // Voices can arrive a moment after the page opens; wait for one outcome.
  await expect(picker.or(none).or(unavailable)).toBeVisible();
  if (await picker.isVisible()) {
    await expect(picker.locator("option").first()).toContainText("Otomatik");
    await expect(section.getByLabel("Hız")).toBeVisible();
    await expect(section.getByRole("button", { name: "Dene" })).toBeVisible();
  } else {
    await expect(none.or(unavailable)).toContainText(/ses/i);
  }
});

test("the toggle, the voice choice and Dene work against a known set of voices", async ({ page }) => {
  await installVoices(page, [
    { name: "Microsoft David - English (United States)", lang: "en-US" },
    { name: "Microsoft Tolga - Turkish (Turkey)", lang: "tr-TR" },
  ]);
  await primePreferences(page, { locale: "tr" });
  await page.goto("/#/overview");
  await waitForAppReady(page);
  const dialog = await openSettings(page, "ai");
  const section = dialog.getByTestId("voice-settings");
  await section.scrollIntoViewIfNeeded();

  const groups = section.locator("optgroup");
  await expect(groups.first()).toHaveAttribute("label", "Türkçe için sesler");
  await expect(groups.first().locator("option")).toHaveText(["Microsoft Tolga - Turkish (Turkey)"]);
  await expect(groups.nth(1)).toHaveAttribute("label", "Diğer sesler");

  await section.locator("label.switch").click();
  await expect(section.getByRole("checkbox", { name: "Cevapları sesli oku" })).toBeChecked();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("contextos.v1.preferences") ?? "{}") as Record<string, unknown>,
  );
  expect(stored.voiceReadAloud).toBe(true);

  await section.getByRole("button", { name: "Dene" }).click();
  const spoken = await page.evaluate(() => (window as unknown as { __spoken: Spoken[] }).__spoken);
  expect(spoken).toHaveLength(1);
  expect(spoken[0]).toMatchObject({
    voice: "Microsoft Tolga - Turkish (Turkey)",
    lang: "tr-TR",
    rate: 1,
  });
  expect(spoken[0]!.text).toContain("Qutra");
});
