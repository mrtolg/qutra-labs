import { describe, expect, it } from "vitest";
import { parseNmapXml } from "@/domain/lab/parsers/nmap";
import { parseSarif } from "@/domain/lab/parsers/sarif";
import { MAX_PARSE_BYTES } from "@/domain/lab/parsers/types";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";
import { importErrorKey, importWarningText } from "./importMessages";

/* A scan that cannot be imported is explained in the app's language, never
   with the parser's own English message. */

const failure = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the parser to refuse");
};

const words = (catalog: Record<string, string>) => (key: string, params?: Record<string, string | number>) =>
  (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ""));

describe("import messages", () => {
  it("name each refusal by a key of the catalog, not by the parser's message", () => {
    const cases: Array<[unknown, string]> = [
      [failure(() => parseSarif("not json")), "lab.import.error.notJson"],
      [failure(() => parseSarif(JSON.stringify({ version: "2.1.0" }))), "lab.import.error.noRuns"],
      [failure(() => parseNmapXml("<a><b></a>")), "lab.import.error.badXml"],
      [failure(() => parseNmapXml("<other></other>")), "lab.import.error.notNmap"],
      [failure(() => parseSarif("x".repeat(MAX_PARSE_BYTES + 1))), "lab.import.error.tooLarge"],
      [new Error("anything else"), "lab.import.error.generic"],
      ["a string", "lab.import.error.generic"],
    ];
    for (const [error, key] of cases) {
      expect(importErrorKey(error)).toBe(key);
      expect(en).toHaveProperty([key]);
      expect(tr).toHaveProperty([key]);
    }
  });

  it("says a SARIF version it does not expect in the app's language", () => {
    const result = parseSarif(JSON.stringify({ version: "1.0.0", runs: [] }));
    expect(result.warnings).toEqual(["sarif_version:1.0.0"]);
    expect(importWarningText(words(en), result.warnings[0]!)).toBe(
      "Unexpected SARIF version 1.0.0; read as far as possible",
    );
    expect(importWarningText(words(tr), result.warnings[0]!)).toBe(
      "Beklenmeyen SARIF sürümü 1.0.0; mümkün olduğunca okundu",
    );
    // A warning this page does not know is shown as it came.
    expect(importWarningText(words(en), "something new")).toBe("something new");
  });
});
