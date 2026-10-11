import { expect, test } from "@playwright/test";
import { NEW_ENGAGEMENT, newEngagement, primePreferences, waitForAppReady } from "./helpers";

/* The Lab's views were hard to use, and on a wide screen
   their fields stretched across it. Each section of an investigation says
   what it is for, keeps to a readable width, and an empty one says what goes
   there and how. */

const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };

test("each Lab view says what it is for and keeps to a readable width", async ({ page }) => {
  await primePreferences(page, { ...HUD, locale: "tr", privateToolsEnabled: true });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto("/#/lab");
  await waitForAppReady(page);
  await newEngagement(page, "Ev laboratuvarı: iç ağ", NEW_ENGAGEMENT.tr);
  const sections = page.getByRole("navigation", { name: "Ev laboratuvarı: iç ağ bölümleri" });
  const main = page.locator("main");

  // The road from scope to remediation is the Overview's first panel now
  // (spec 2026-10-07 §5.1).
  await sections.getByRole("button", { name: "Özet", exact: true }).click();
  await expect(main.getByText("6 adımdan 0 tamamlandı")).toBeVisible();
  await expect(main.getByText("Sıradaki")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/lab-view-road.png" });

  // The strip says what the gate lets a tool reach: with nothing listed yet,
  // local and private addresses only (they need no entry). Scope opens from it.
  const strip = page.getByTestId("lab-scope-strip");
  await expect(strip).toContainText(
    "Yalnız yerel ve özel ağ adresleri taranabilir · geri kalan her şey engelli",
  );
  await strip.click();
  await expect(main.getByRole("heading", { level: 2, name: "Kapsam", exact: true })).toBeVisible();
  await expect(
    main.getByText(/Araçlar yalnız burada listelenen hedeflere ve yerel ya da özel ağ adreslerine ulaşır/),
  ).toBeVisible();
  // Fields no longer run the width of a 1920 px window.
  const allowed = main.getByLabel("İzin verilen hedefler");
  expect((await allowed.boundingBox())!.width).toBeLessThan(700);
  await page.screenshot({ path: "e2e/screenshots/lab-view-scope.png" });

  // Files join the targets. The browser build cannot copy a file,
  // and says so; targets are added as before.
  await sections.getByRole("button", { name: "Hedefler ve dosyalar", exact: true }).click();
  await expect(
    main.getByRole("heading", { level: 2, name: "Hedefler ve dosyalar", exact: true }),
  ).toBeVisible();
  await expect(main.getByText("Dosya eklemek masaüstü uygulamasında çalışır.")).toBeVisible();
  await expect(main.getByRole("region", { name: /^Dosyalar/ })).toContainText("Henüz dosya yok.");
  await page.screenshot({ path: "e2e/screenshots/lab-view-targets.png" });

  await sections.getByRole("button", { name: "Taramalar", exact: true }).click();
  await page.screenshot({ path: "e2e/screenshots/lab-view-runs.png" });

  await sections.getByRole("button", { name: "Bulgular", exact: true }).click();
  await expect(main.getByRole("heading", { level: 3, name: "Henüz bulgu yok" })).toBeVisible();
  // No filters before there is anything to filter.
  await expect(main.getByLabel("Önem derecesine göre filtrele")).toHaveCount(0);
  await expect(main.getByText("Dosyadan yükle", { exact: true })).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/lab-view-findings.png" });

  await sections.getByRole("button", { name: "Rapor", exact: true }).click();
  await expect(main.getByRole("heading", { level: 2, name: "Rapor", exact: true })).toBeVisible();
  await expect(main.getByTestId("lab-report-preview")).toContainText("Ev laboratuvarı: iç ağ");
  await page.screenshot({ path: "e2e/screenshots/lab-view-report.png" });
});
