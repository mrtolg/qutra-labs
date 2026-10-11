import { describe, expect, it } from "vitest";
import { launchFailureMessage } from "./launchFailureMessage";
import { en as enCatalog } from "@/lib/i18n/en";
import { deferredEn } from "@/lib/i18n/deferred/en";
import type { MessageKey } from "@/lib/i18n/en";

// A key may live in the first-paint catalog or in the deferred words.
const en = { ...enCatalog, ...deferredEn };

/** A stand-in `t` that mirrors `translate("en", ...)` without pulling in the
    full locale-loading machinery: this module is pure and locale-agnostic,
    so it only needs to prove it calls `t` with the right key and params. */
function tEnglish(key: MessageKey, params?: Record<string, string | number>): string {
  let msg: string = en[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}

describe("launchFailureMessage", () => {
  it("maps every known reason to its dedicated translated copy", () => {
    expect(launchFailureMessage(tEnglish, "browser_mode", "Test Tool")).toBe(
      "This build cannot launch external tools.",
    );
    expect(
      launchFailureMessage(tEnglish, "private_tools_consent_required", "Test Tool"),
    ).toBe("Turn on Private Lab before launching Test Tool.");
    expect(launchFailureMessage(tEnglish, "tool_not_found", "Test Tool")).toBe(
      "Test Tool is no longer registered. Refresh the tool library and try again.",
    );
    expect(launchFailureMessage(tEnglish, "tool_disabled", "Test Tool")).toBe(
      "Test Tool is disabled. Enable it before launching.",
    );
    expect(
      launchFailureMessage(tEnglish, "tool_identity_changed", "Test Tool"),
    ).toBe(
      "Test Tool's identity changed since it was last verified. Review and trust it before launching.",
    );
    expect(launchFailureMessage(tEnglish, "tool_path_missing", "Test Tool")).toBe(
      "Test Tool's executable is missing from disk.",
    );
    expect(
      launchFailureMessage(tEnglish, "elevation_required", "Test Tool"),
    ).toBe("Test Tool needs administrator privileges this app does not have.");
  });

  it("maps the working-directory refusal reasons the gate can also produce", () => {
    // resolve_launchable's own working-dir gate (resolve_run_working_dir)
    // can refuse with these two codes -- reachable from both the gui and
    // interactive launch routes, not just the batch Run button.
    const missing = launchFailureMessage(
      tEnglish,
      "working_directory_missing",
      "Test Tool",
    );
    expect(missing).toContain("Test Tool");
    expect(missing).not.toBe(en["lab.tools.launchFailedGeneric"].replace("{name}", "Test Tool"));

    const notFolder = launchFailureMessage(
      tEnglish,
      "working_directory_not_folder",
      "Test Tool",
    );
    expect(notFolder).toContain("Test Tool");
    expect(notFolder).not.toBe(en["lab.tools.launchFailedGeneric"].replace("{name}", "Test Tool"));
    expect(notFolder).not.toBe(missing);
  });

  it("falls back to a generic translated message for an unrecognized or dynamic reason, never the raw code", () => {
    const generic = launchFailureMessage(
      tEnglish,
      "spawn:No such file or directory (os error 2)",
      "Test Tool",
    );
    expect(generic).toBe(
      "Couldn't launch Test Tool. Try again, or check its identity in the tool library.",
    );
    expect(generic).not.toContain("spawn:");

    expect(launchFailureMessage(tEnglish, undefined, "Test Tool")).toBe(generic);
  });
});
