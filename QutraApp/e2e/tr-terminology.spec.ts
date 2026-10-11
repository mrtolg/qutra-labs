import { expect, test } from "@playwright/test";
import { primePreferences } from "./helpers";

test("Turkish catalog names the areas, their sections and every destination", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await primePreferences(page, { locale: "tr" });
  await page.goto("/#/overview");
  const surfaces = page.getByRole("navigation", { name: "Bölümler", exact: true });
  for (const label of ["Ana Sayfa", "İncelemeler", "Araçlar", "Qutra", "Terminal"]) {
    await expect(surfaces.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  const sections = page.getByRole("navigation", { name: "Ana Sayfa bölümleri" });
  for (const label of ["Ana Sayfa", "Projeler", "Dosyalar", "GitHub"]) {
    await expect(sections.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // The nine destinations the sidebar used to list are all in the palette.
  await page.getByRole("button", { name: "Ara", exact: true }).click();
  const palette = page.getByRole("dialog");
  for (const label of [
    "Ana Sayfa",
    "Projeler",
    "Dosyalar",
    "Araçlar",
    "İncelemeler",
    "Terminal",
    "GitHub",
    "Qutra",
    "Ayarlar",
  ]) {
    await expect(
      palette.getByRole("option", { name: new RegExp(`^${label}`) }).first(),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  expect(await page.locator("body").innerText()).not.toMatch(
    /Parçacık Kasası|İçgörüler|Pano Geçmişi/,
  );
  await page.screenshot({ path: "e2e/screenshots/tr-core-navigation.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});
