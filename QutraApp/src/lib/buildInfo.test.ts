import { describe, expect, it } from "vitest";
import { BUILD_INFO, formatBuild } from "./buildInfo";

/* Every build says "0.1.0", so the version alone cannot tell a user
   whether the app in the Start menu is the one built from the current
   commit. The build stamp can. */
describe("build stamp", () => {
  it("names the commit and the build date", () => {
    expect(
      formatBuild({ commit: "5c8fad1a2b3c", dirty: false, builtAt: "2026-09-28T01:51:00.000Z" }),
    ).toBe("5c8fad1a2b3c · 2026-09-28");
  });

  it("says so when the tree had uncommitted changes", () => {
    expect(
      formatBuild({ commit: "5c8fad1a2b3c", dirty: true, builtAt: "2026-09-28T01:51:00.000Z" }),
    ).toBe("5c8fad1a2b3c-dirty · 2026-09-28");
  });

  it("stays honest when no stamp was compiled in", () => {
    expect(formatBuild({ commit: "unknown", dirty: false, builtAt: "" })).toBe("unknown");
  });

  it("is stamped with a real commit in this build", () => {
    expect(BUILD_INFO.commit).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
