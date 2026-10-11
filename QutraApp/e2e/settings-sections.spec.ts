import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openSettings, primePreferences, waitForAppReady } from "./helpers";

/* Settings › AI providers, Permissions, Privacy & exclusions, and Language
   & region: each section is driven
   the way a user does, then photographed at 1280 and 1920 px wide. Set
   QUTRA_SHOTS_DIR to keep the images somewhere else. */

const SHOTS = process.env.QUTRA_SHOTS_DIR ?? path.join("test-results", "settings-sections");
const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Nothing in the pane is wider than the pane: no clipped or sideways text. */
async function expectNoSidewaysOverflow(dialog: Locator) {
  const pane = dialog.locator(".settings-pane");
  const { scrollWidth, clientWidth } = await pane.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

for (const width of [1280, 1920] as const) {
  test.describe(`settings sections at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1280 ? 800 : 1080 } });

    test(`AI providers, Turkish (${width})`, async ({ page }) => {
      await primePreferences(page, { ...HUD, locale: "tr" });
      await page.goto("/#/overview");
      await waitForAppReady(page);
      const dialog = await openSettings(page, "ai");

      const picker = dialog.getByRole("radiogroup", { name: "Jarvis hangi yoldan konuşsun?" });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole("radio", { name: /Yerel model/ })).toBeChecked();
      // The root bug: a long hint beside a select wrapped one word a line.
      const hint = dialog.locator(".local-model__hint");
      expect((await hint.boundingBox())?.width ?? 0).toBeGreaterThan(300);
      await expectNoSidewaysOverflow(dialog);
      await shot(page, `ai-tr-${width}`);

      await dialog.locator(".settings-pane").evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect(dialog.locator(".mask-line")).toBeVisible();
      await shot(page, `ai-tr-${width}-bottom`);
    });

    test(`Permissions, Turkish (${width})`, async ({ page }) => {
      await primePreferences(page, { ...HUD, locale: "tr", localAssistantEnabled: false });
      await page.goto("/#/overview");
      await waitForAppReady(page);
      const dialog = await openSettings(page, "permissions");
      const ledger = dialog.getByTestId("permissions-ledger");
      await expect(ledger).toBeVisible();
      await shot(page, `permissions-tr-${width}`);

      const local = ledger.locator('[data-perm="localAssistant"]');
      await local.locator("label.switch").click();
      await expect(local.getByText("Jarvis artık yerel modelle yanıt verebilir.")).toBeVisible();
      await expect(local.getByRole("checkbox")).toBeChecked();
      await expect(local).toContainText("tarihinden beri açık");

      await ledger.locator('[data-perm="toolProposals"] label.switch').click();
      await expect(page.getByRole("dialog", { name: "Jarvis işlem önerebilsin mi?" })).toBeVisible();
      await shot(page, `permissions-tr-${width}-confirm`);
      await page.getByRole("button", { name: "Önerilere izin ver" }).click();
      await expect(ledger.locator('[data-perm="toolProposals"]')).toContainText(
        "Jarvis artık işlem önerebilir.",
      );
      await expectNoSidewaysOverflow(dialog);
      await shot(page, `permissions-tr-${width}-after`);
    });

    test(`Privacy and exclusions, Turkish (${width})`, async ({ page }) => {
      await primePreferences(page, { ...HUD, locale: "tr", activityTrackingEnabled: true });
      await page.goto("/#/overview");
      await waitForAppReady(page);
      const dialog = await openSettings(page, "privacy");

      await expect(dialog.getByRole("heading", { name: "Bilgisayardan hiç çıkmayanlar" })).toBeVisible();
      await shot(page, `privacy-tr-${width}`);

      const value = dialog.getByLabel("Değer");
      await dialog.locator(".exclusion-kind", { hasText: "Alan adı" }).click();
      await value.fill("https://corp.acme.local");
      await dialog.getByRole("button", { name: "Dışlama ekle" }).click();
      await expect(dialog.getByRole("alert")).toContainText("Yalnızca alan adını yazın");
      await value.fill("corp.acme.local");
      await dialog.getByRole("button", { name: "Dışlama ekle" }).click();
      await dialog.getByRole("button", { name: /Acme Holding/ }).click();
      await dialog.getByRole("button", { name: "Dışlama ekle" }).click();
      const list = dialog.getByRole("list", { name: "Dışlamalarınız" });
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await list.scrollIntoViewIfNeeded();
      await expectNoSidewaysOverflow(dialog);
      await shot(page, `privacy-tr-${width}-exclusions`);

      const data = dialog.locator(".data-table");
      await data.scrollIntoViewIfNeeded();
      // Every action button sits inside the table, none cut off at its edge.
      const table = await data.boundingBox();
      for (const button of await data.getByRole("button").all()) {
        const box = await button.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((table?.x ?? 0) + (table?.width ?? 0));
      }
      await shot(page, `privacy-tr-${width}-data`);
    });

    test(`Language and region (${width})`, async ({ page }) => {
      await primePreferences(page, { ...HUD, locale: "en" });
      await page.goto("/#/overview");
      await waitForAppReady(page);
      let dialog = await openSettings(page, "languageRegion");
      await shot(page, `region-en-${width}`);

      // The choice flips once it is on disk, so click, then wait for it.
      await dialog.locator(".lang-row", { hasText: "Türkçe" }).click();
      await expect(dialog.getByRole("radio", { name: /Türkçe/ })).toBeChecked();
      await expect(dialog.getByRole("heading", { name: "Uygulamanın dili" })).toBeVisible();
      await dialog.getByLabel("Tarih").selectOption("ymd");
      await expect(dialog.getByTestId("region-preview")).toContainText(/\d{4}-\d{2}-\d{2}/);
      await dialog.getByLabel("Saat", { exact: true }).selectOption("h12");
      await expectNoSidewaysOverflow(dialog);
      await shot(page, `region-tr-${width}`);

      // The language and the formats are still there after a restart. A new
      // page: the first one re-primes the preferences on every load.
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog.settings-dialog[open]")).toHaveCount(0);
      const fresh = await page.context().newPage();
      await fresh.goto("/#/overview");
      await waitForAppReady(fresh);
      await fresh.locator('button[aria-keyshortcuts="Control+Comma"]').click();
      dialog = fresh.locator("dialog.settings-dialog[open]");
      await dialog.locator('[data-section="languageRegion"]').click();
      await expect(dialog.getByRole("radio", { name: /Türkçe/ })).toBeChecked();
      await expect(dialog.getByLabel("Tarih")).toHaveValue("ymd");
      await expect(dialog.getByLabel("Saat", { exact: true })).toHaveValue("h12");
    });
  });
}
