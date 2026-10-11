import { expect, test } from "@playwright/test";
import { seedLivedIn } from "./seedLivedIn";
import { waitForAppReady } from "./helpers";

test.use({ viewport: { width: 1280, height: 800 } });

test("sample creation shows files, duplicate status and the destination", async ({ page }) => {
  await seedLivedIn(page);
  await page.addInitScript(() => {
    const files: Record<string, unknown>[] = [];
    (window as unknown as Record<string, unknown>).__QUTRA_E2E_SAMPLES__ = {
      generate: (engagementId: string) => {
        if (files.length) return [{ outcome: "duplicate", file: files[0] }];
        const file = {
          id: "file-864d1497-8b11-42f8-9687-e758a6dc6d21", engagementId,
          name: "ornek-web-erisim-gunlugu.log", originalName: "ornek-web-erisim-gunlugu.log",
          relPath: "files/ornek-web-erisim-gunlugu.log", bytes: 1600,
          sha256: "a".repeat(64), sha1: "b".repeat(40), md5: "c".repeat(32),
          kind: "text", sample: false, source: "sample", addedAt: Date.now(), missing: false, readOnly: true,
        };
        files.push(file);
        return [{ outcome: "added", file }];
      },
      files: () => files,
    };
  });
  await page.goto("/#/tools?view=datasets");
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: "Örnek veriler", exact: true })).toBeVisible({ timeout: 15_000 });
  const create = page.getByRole("button", { name: "Örnek dosyayı oluştur" }).first();
  await expect(create).toBeDisabled();
  await page.getByLabel("İnceleme", { exact: true }).selectOption("e-web");
  await create.click();
  const results = page.getByRole("region", { name: "Oluşturulan dosyalar" });
  await expect(results).toContainText("ornek-web-erisim-gunlugu.log");
  await expect(results).toContainText("Eklendi");
  await expect(results).toContainText(`SHA-256 ${"a".repeat(64)}`);
  await results.scrollIntoViewIfNeeded();
  await expect(results).toBeVisible();
  await page.screenshot({ path: `${process.env.ACCEPTANCE_DIR ?? "test-results/acceptance"}/items/10-samples-created-1280.png` });
  await create.click();
  await expect(results).toContainText("Zaten mevcut");
  await page.getByRole("link", { name: "İncelemenin dosyalarını aç" }).click();
  await expect(page).toHaveURL(/e=e-web&view=targets/);
  await expect(page.getByText("ornek-web-erisim-gunlugu.log", { exact: true })).toBeVisible();
});

test("browser preview explains why sample creation is disabled", async ({ page }) => {
  await seedLivedIn(page);
  await page.goto("/#/tools?view=datasets&e=e-web");
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: "Örnek veriler", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Örnek dosyalar masaüstü uygulamasında oluşturulur/)).toBeVisible();
  const buttons = page.getByRole("button", { name: "Örnek dosyayı oluştur" });
  await expect(buttons).toHaveCount(6);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  await expect(page.getByRole("region", { name: "Oluşturulan dosyalar" })).toHaveCount(0);
});
