import { describe, expect, it } from "vitest";
import type { Observation } from "@/lib/analysis";
import { en as enCatalog } from "@/lib/i18n/en";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { translate, type MessageKey } from "@/lib/i18n";
import { HINTS, LABELS, STEP_NAMES, VALUE_WORDS, observationLabel, observationShown } from "./analysisLabels";

/* The words for what ExifTool, YARA and capinfos report. */

// A key may live in the first-paint catalog or in the deferred words.
const en = { ...enCatalog, ...deferredEn };

const t = (key: MessageKey, params?: Record<string, string | number>) => translate("en", key, params);

// Every key and hint the parsers in src-tauri/src/external_tools/ emit.
// `capinfos.comment` is not here on purpose: it is the capture's own free
// text, and Rust leaves it out.
const EMITTED = [
  "exiftool.type",
  "exiftool.camera",
  "exiftool.taken",
  "exiftool.modified",
  "exiftool.software",
  "exiftool.tags",
  "exiftool.error",
  "exiftool.gps",
  "exiftool.owner",
  "exiftool.serial",
  "exiftool.warning",
  "exiftool.outdated",
  "exiftool.groups",
  "exiftool.version",
  "yara.rulesFile",
  "yara.count",
  "yara.matches",
  "yara.strings",
  "yara.error",
  "capinfos.type",
  "capinfos.encap",
  "capinfos.packets",
  "capinfos.empty",
  "capinfos.duration",
  "capinfos.first",
  "capinfos.last",
  "capinfos.snaplen",
  "capinfos.order",
  "capinfos.dataSize",
  "capinfos.app",
  "capinfos.interfaces",
  "capinfos.error",
];
const EMITTED_HINTS = [
  "toolWarning",
  "oldTool",
  "yaraMatch",
  "snaplen",
  "timeOrder",
  "emptyCapture",
  "gpsLocation",
  "identifying",
];

describe("the words for an outside program's findings", () => {
  it("has a name for each step and a label for each key Rust emits", () => {
    for (const step of ["exiftool", "yara", "capinfos"]) {
      expect(STEP_NAMES[step], step).toBeDefined();
      expect(en[STEP_NAMES[step]!]).toBeTruthy();
    }
    for (const key of EMITTED) {
      const label = LABELS[key];
      expect(label, key).toBeDefined();
      expect(en[label!], key).toBeTruthy();
    }
    for (const hint of EMITTED_HINTS) {
      expect(HINTS[hint], hint).toBeDefined();
      expect(en[HINTS[hint]!]).toBeTruthy();
    }
  });

  it("leaves out the capture's own comment", () => {
    expect(Object.keys(LABELS)).not.toContain("capinfos.comment");
  });

  it("says a sensitive ExifTool key the way the photo step does", () => {
    const at = (key: string): Observation => ({ id: "r:0", key, value: "x", group: "interesting" });
    expect(observationLabel(t, at("exiftool.gps"))).toBe(observationLabel(t, at("image.gps")));
    expect(observationLabel(t, at("exiftool.owner"))).toBe(observationLabel(t, at("image.owner")));
    expect(observationLabel(t, at("exiftool.serial"))).toBe(observationLabel(t, at("image.serial")));
    expect(observationLabel(t, at("exiftool.warning"))).toBe("Warning from the tool");
    // A key this version does not know is shown as it is.
    expect(observationLabel(t, at("exiftool.future"))).toBe("exiftool.future");
  });

  it("turns the time-order flag into a word, and shows numbers rounded", () => {
    expect(Object.keys(VALUE_WORDS["capinfos.order"]!)).toEqual(["no", "yes"]);
    const order: Observation = { id: "r:1", key: "capinfos.order", value: "no", group: "interesting", hint: "timeOrder" };
    expect(observationShown(t, "en", order)).toBe("No");
    const duration: Observation = { id: "r:2", key: "capinfos.duration", value: 12.3456, group: "summary" };
    expect(observationShown(t, "en", duration)).toBe("12.35");
  });
});
