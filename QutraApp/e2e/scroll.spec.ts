import { expect, test } from "@playwright/test";
import { loadDemo, openSettings, primePreferences } from "./helpers";

/* ============================================================
   Regression: the shell must own exactly one vertical scroll
   surface and it must actually move.

   The failure this locks out was invisible to the previous visual
   sweep, which only asserted `documentElement.scrollWidth` (horizontal
   overflow). `body` is `overflow: hidden` by design for a desktop
   shell, so the document never scrolls and never will — the real
   regression is a broken `min-height: 0` chain between `#root` and
   `.page-body`, which lets `.main` grow to content height. When that
   happens `.page-body` reports no overflow, the wheel is dead, and the
   bottom of every long page is unreachable with no visual clue.

   So these tests assert behaviour, not geometry: real wheel input and
   real keyboard input must change `scrollTop` on the designated owner,
   and content below the fold must be reachable.
   ============================================================ */

/** The page's designated vertical scroll surface.
 *
 * `.page-body` is the default every routed page uses. A page with a genuinely
 * different layout — Settings, whose rail and pane scroll independently — opts
 * out by marking its primary surface with `data-scroll-owner="page"` instead.
 *
 * This is expressed as a contract rather than a single class name on purpose:
 * the first version of this test hard-coded `.page-body`, and when Settings was
 * later restructured into two panes it stopped describing reality. The sweep at
 * the bottom of this file now enforces that every route has exactly one such
 * surface, so losing it is a failing contract rather than a silent dead page. */
const OWNER = '[data-scroll-owner="page"], .page-body';

/** Heights from the audit: 720 and 768 are common laptop panels, 900 is the
    height at which the user originally reported the dead wheel. */
const HEIGHTS = [720, 768, 900];

/** The Settings modal's section pane. Settings is a modal over the current
    surface, not a route, so it is not part of the route sweep below; it keeps
    its own scroll surface, marked the same way. */
const SETTINGS_OWNER = 'dialog.settings-dialog [data-scroll-owner="settings"]';

async function gotoSettings(page: import("@playwright/test").Page) {
  await primePreferences(page);
  await loadDemo(page);
  // Appearance is the densest Settings section, so it overflows at every
  // height under test without depending on demo-data volume.
  await openSettings(page, "appearance");
  await page.locator(SETTINGS_OWNER).waitFor();
}

for (const height of HEIGHTS) {
  test.describe(`vertical scroll @ 800x${height}`, () => {
    test.use({ viewport: { width: 800, height } });

    test("the page body overflows and the wheel scrolls it", async ({
      page,
    }) => {
      await gotoSettings(page);
      const owner = page.locator(SETTINGS_OWNER);

      // 1. The owner must genuinely have content below the fold. If this fails
      //    the rest is vacuous, so assert it explicitly rather than implying it.
      const { scrollHeight, clientHeight } = await owner.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(
        scrollHeight,
        `${OWNER} must overflow at 800x${height} for this test to mean anything`,
      ).toBeGreaterThan(clientHeight);

      // 2. The owner must be height-constrained by the flex chain. This is the
      //    direct assertion on the `min-height: 0` root cause: if `.main` keeps
      //    its auto floor, clientHeight balloons past the viewport.
      expect(
        clientHeight,
        "scroll owner must be clamped inside the viewport, not grown to content",
      ).toBeLessThan(height);

      // 3. A real wheel over the content must move that owner.
      await owner.hover();
      await page.mouse.wheel(0, 400);
      await expect
        .poll(() => owner.evaluate((el) => el.scrollTop), {
          message: "mouse wheel must scroll the page body",
        })
        .toBeGreaterThan(0);

      // 4. The document itself must not be the scroller — one owner, not two.
      const docScrollTop = await page.evaluate(
        () => document.documentElement.scrollTop + document.body.scrollTop,
      );
      expect(docScrollTop, "the document must not scroll; the page body does").toBe(0);
    });

    test("keyboard reaches content below the fold", async ({ page }) => {
      await gotoSettings(page);
      const owner = page.locator(SETTINGS_OWNER);

      // Keyboard users must not depend on a pointer. Focus the scroll owner and
      // drive it with PageDown, then confirm the very last focusable control on
      // the page can actually be reached and shown.
      await owner.evaluate((el) => {
        el.setAttribute("tabindex", "-1");
        el.focus();
      });
      await page.keyboard.press("PageDown");
      await expect
        .poll(() => owner.evaluate((el) => el.scrollTop), {
          message: "PageDown must scroll the page body",
        })
        .toBeGreaterThan(0);

      // Reaching the end must be possible, and the bottom-most control must be
      // inside the visible box — not clipped beyond a dead overflow.
      const last = owner.locator("button, a, input, select").last();
      await last.scrollIntoViewIfNeeded();
      const visible = await last.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight + 1;
      });
      expect(visible, "last control on the page must be reachable").toBe(true);
    });
  });
}

/* Contract sweep.

   The per-height tests above prove the mechanics on one dense page. This proves
   the invariant they rely on holds everywhere: every routed module exposes
   exactly one primary vertical scroll surface, and that surface is clamped
   inside the viewport rather than grown to its content.

   This is the test that was missing when Settings was restructured into a
   two-pane layout and quietly lost its `.page-body` — the page still rendered,
   so nothing failed until an unrelated scroll test timed out. */
const CORE_ROUTES = [
  "/#/overview",
  "/#/workspaces",
  "/#/files",
  "/#/tools",
  "/#/lab",
  "/#/terminal",
  "/#/github",
  "/#/jarvis",
];

test.describe("scroll owner contract", () => {
  // Nine cold app boots. Run them in one worker rather than adding nine more
  // parallel clients to a single Vite dev server — under the full suite the
  // contention alone pushed boot past the timeout, which reads as a product
  // failure when it is only the harness starving itself.
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1280, height: 720 } });

  for (const route of CORE_ROUTES) {
    test(`${route} has exactly one clamped scroll owner`, async ({ page }) => {
      await primePreferences(page);
      await page.goto(route);

      // Routes are lazy, and the Suspense skeleton also renders a `.page-body`.
      // Measuring that placeholder instead of the real page made this flake
      // under load, so wait for the route to actually settle first.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

      const owner = page.locator(OWNER);
      await owner.first().waitFor();

      await expect(
        owner,
        `${route} must designate exactly one primary scroll surface`,
      ).toHaveCount(1);

      const { clientHeight, canScroll } = await owner.evaluate((el) => ({
        clientHeight: el.clientHeight,
        canScroll: ["auto", "scroll"].includes(
          getComputedStyle(el).overflowY,
        ),
      }));

      expect(canScroll, `${route} owner must be scrollable`).toBe(true);
      expect(
        clientHeight,
        `${route} owner must be clamped inside the viewport, not grown to content`,
      ).toBeLessThan(720);
      expect(clientHeight, `${route} owner must be laid out`).toBeGreaterThan(0);
    });
  }
});
