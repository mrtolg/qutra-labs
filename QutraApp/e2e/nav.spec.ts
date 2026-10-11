import { expect, test, type Page } from "@playwright/test";
import { newEngagement, primePreferences, waitForAppReady } from "./helpers";

/* ============================================================
   One navigation bar (it replaces the side rail). The
   top bar holds Home and the four areas (spec 2026-10-07), and the chosen area's
   sections slide into the row under it. Every section in that row goes
   somewhere.
   ============================================================ */

const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };
const areas = (page: Page) => page.getByRole("navigation", { name: "Surfaces" });

test("choosing an area shows its sections under the top bar, and each one acts", async ({
  page,
}) => {
  await primePreferences(page, HUD);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/overview");
  await waitForAppReady(page);

  await expect(page.locator("nav.rail")).toHaveCount(0);
  const home = page.getByRole("navigation", { name: "Home sections" });
  await home.getByRole("button", { name: "Projects" }).click();
  await expect(page).toHaveURL(/#\/workspaces$/);
  await expect(home.getByRole("button", { name: "Projects" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(areas(page).getByRole("button", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await areas(page).getByRole("button", { name: "Tools", exact: true }).click();
  const tools = page.getByRole("navigation", { name: "Tools views" });
  await tools.getByRole("button", { name: "Catalog" }).click();
  await expect(page).toHaveURL(/#\/tools\?view=catalog$/);

  await areas(page).getByRole("button", { name: "Investigations", exact: true }).click();
  await newEngagement(page, "Nav check");
  await expect(page).toHaveURL(/#\/lab\?e=[^&]+&view=overview$/);
  const views = page.getByRole("navigation", { name: "Nav check: investigation sections" });
  await views.getByRole("button", { name: /Findings/ }).click();
  await expect(page).toHaveURL(/view=findings/);
  await expect(views.getByRole("button", { name: /Findings/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.screenshot({ path: "e2e/screenshots/nav-one-bar-lab.png" });
});

test("the sections row slides in, and simply appears under reduced motion", async ({ page }) => {
  await primePreferences(page, HUD);
  await page.goto("/#/overview");
  await waitForAppReady(page);
  await expect(page.locator(".subnav__in")).toHaveCSS("animation-name", "subnav-in");

  await primePreferences(page, { ...HUD, reduceMotion: true });
  await page.reload();
  await waitForAppReady(page);
  await expect(page.locator(".subnav__in")).toHaveCSS("animation-name", "none");
});

/* Definition of usable, criterion 2: the top bar, its sections row
   and the surface. The context panel and the run panel are on demand, so a
   fresh window shows neither. */
test("the window has the top bar, its sections and the surface in every area", async ({
  page,
}) => {
  await primePreferences(page, HUD);
  for (const route of ["/overview", "/terminal", "/tools", "/jarvis", "/lab", "/files"]) {
    await page.goto(`/#${route}`);
    await waitForAppReady(page);
    const regions = await page.evaluate(() => {
      const shell = document.querySelector(".shell")!;
      const top = [...shell.children].filter((el) => el.matches("header.topbar, .subnav"));
      const body = [...document.querySelector(".workbench")!.children].flatMap(
        /* The main column has no box of its own; it carries `inert`. */
        (el) => (el.classList.contains("wb-main-col") ? [...el.children] : [el]),
      );
      return [...top, ...body].map((el) =>
        el.matches("header.topbar")
          ? "top bar"
          : el.matches(".subnav")
            ? "sections"
            : el.matches("main#main")
              ? "surface"
              : el.className || el.tagName,
      );
    });
    expect(regions, route).toEqual(["top bar", "sections", "surface"]);
  }
});
