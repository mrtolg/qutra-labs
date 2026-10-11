import type { Observation } from "@/lib/analysis";
import type { MessageKey } from "@/lib/i18n/en";
import { fileKindLabelKey } from "./fileKinds";

/* The words for what a built-in analysis, or a program outside Qutra Labs
   (ExifTool, YARA, capinfos), found, shared by the Önerilen analiz panel
   and the investigation summary Jarvis may receive, so both say the same
   thing. Lab-only. */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export const STEP_NAMES: Record<string, MessageKey> = {
  identify: "lab.analysis.step.identify",
  pe: "lab.analysis.step.pe",
  image: "lab.analysis.step.image",
  strings: "lab.analysis.step.strings",
  entropy: "lab.analysis.step.entropy",
  signatures: "lab.analysis.step.signatures",
  exiftool: "lab.analysis.step.exiftool",
  yara: "lab.analysis.step.yara",
  capinfos: "lab.analysis.step.capinfos",
};

export const LABELS: Record<string, MessageKey> = {
  "identify.kind": "lab.analysis.obs.kind",
  "identify.extension": "lab.analysis.obs.extension",
  "identify.mismatch": "lab.analysis.obs.mismatch",
  "identify.magic": "lab.analysis.obs.magic",
  "entropy.file": "lab.analysis.obs.entropy",
  "entropy.high": "lab.analysis.obs.entropy",
  "entropy.max": "lab.analysis.obs.entropyMax",
  "strings.count": "lab.analysis.obs.strings",
  "strings.ascii": "lab.analysis.obs.stringsAscii",
  "strings.utf16": "lab.analysis.obs.stringsUtf16",
  "strings.urls": "lab.analysis.obs.urls",
  "strings.ips": "lab.analysis.obs.ips",
  "strings.emails": "lab.analysis.obs.emails",
  "strings.paths": "lab.analysis.obs.paths",
  "strings.registry": "lab.analysis.obs.registry",
  "signatures.count": "lab.analysis.obs.signatures",
  "signatures.executable": "lab.analysis.obs.embeddedPrograms",
  "signatures.archive": "lab.analysis.obs.embeddedArchives",
  "signatures.other": "lab.analysis.obs.embeddedOther",
  "pe.machine": "lab.analysis.obs.machine",
  "pe.compiled": "lab.analysis.obs.compiled",
  "pe.subsystem": "lab.analysis.obs.subsystem",
  "pe.sections": "lab.analysis.obs.sections",
  "pe.imports": "lab.analysis.obs.imports",
  "pe.signed": "lab.analysis.obs.signed",
  "pe.dlls": "lab.analysis.obs.dlls",
  "pe.entry": "lab.analysis.obs.entry",
  "pe.packedSections": "lab.analysis.obs.packedSections",
  "pe.writableCode": "lab.analysis.obs.writableCode",
  "pe.entryOutside": "lab.analysis.obs.entry",
  "pe.riskyImports": "lab.analysis.obs.riskyImports",
  "pe.noImports": "lab.analysis.obs.imports",
  "pe.oddDate": "lab.analysis.obs.compiled",
  "pe.overlay": "lab.analysis.obs.overlay",
  "pe.invalid": "lab.analysis.obs.invalid",
  "image.camera": "lab.analysis.obs.camera",
  "image.taken": "lab.analysis.obs.taken",
  "image.software": "lab.analysis.obs.software",
  "image.gps": "lab.analysis.obs.gps",
  "image.owner": "lab.analysis.obs.owner",
  "image.serial": "lab.analysis.obs.serial",
  "image.text": "lab.analysis.obs.text",
  "image.none": "lab.analysis.obs.none",
  "exiftool.type": "lab.analysis.obs.fileType",
  "exiftool.camera": "lab.analysis.obs.camera",
  "exiftool.taken": "lab.analysis.obs.taken",
  "exiftool.modified": "lab.analysis.obs.modified",
  "exiftool.software": "lab.analysis.obs.software",
  "exiftool.tags": "lab.analysis.obs.tags",
  "exiftool.error": "lab.analysis.obs.toolError",
  "exiftool.gps": "lab.analysis.obs.gps",
  "exiftool.owner": "lab.analysis.obs.owner",
  "exiftool.serial": "lab.analysis.obs.serial",
  "exiftool.warning": "lab.analysis.obs.toolWarning",
  "exiftool.outdated": "lab.analysis.obs.oldTool",
  "exiftool.groups": "lab.analysis.obs.groups",
  "exiftool.version": "lab.analysis.obs.toolVersion",
  "yara.rulesFile": "lab.analysis.obs.rulesFile",
  "yara.count": "lab.analysis.obs.ruleMatches",
  "yara.matches": "lab.analysis.obs.ruleMatches",
  "yara.strings": "lab.analysis.obs.ruleStrings",
  "yara.error": "lab.analysis.obs.toolError",
  "capinfos.type": "lab.analysis.obs.captureType",
  "capinfos.encap": "lab.analysis.obs.encapsulation",
  "capinfos.packets": "lab.analysis.obs.packets",
  "capinfos.empty": "lab.analysis.obs.packets",
  "capinfos.duration": "lab.analysis.obs.duration",
  "capinfos.first": "lab.analysis.obs.firstPacket",
  "capinfos.last": "lab.analysis.obs.lastPacket",
  "capinfos.snaplen": "lab.analysis.obs.snaplen",
  "capinfos.order": "lab.analysis.obs.timeOrder",
  "capinfos.dataSize": "lab.analysis.obs.dataSize",
  "capinfos.app": "lab.analysis.obs.app",
  "capinfos.interfaces": "lab.analysis.obs.interfaces",
  "capinfos.error": "lab.analysis.obs.toolError",
};

export const HINTS: Record<string, MessageKey> = {
  disguisedExecutable: "lab.analysis.hint.disguisedExecutable",
  extensionMismatch: "lab.analysis.hint.extensionMismatch",
  packed: "lab.analysis.hint.packed",
  embeddedExecutable: "lab.analysis.hint.embeddedExecutable",
  embeddedArchive: "lab.analysis.hint.embeddedArchive",
  writableCode: "lab.analysis.hint.writableCode",
  entryOutside: "lab.analysis.hint.entryOutside",
  riskyImports: "lab.analysis.hint.riskyImports",
  noImports: "lab.analysis.hint.noImports",
  oddDate: "lab.analysis.hint.oddDate",
  overlay: "lab.analysis.hint.overlay",
  gpsLocation: "lab.analysis.hint.gpsLocation",
  identifying: "lab.analysis.hint.identifying",
  toolWarning: "lab.analysis.hint.toolWarning",
  oldTool: "lab.analysis.hint.oldTool",
  yaraMatch: "lab.analysis.hint.yaraMatch",
  snaplen: "lab.analysis.hint.snaplen",
  timeOrder: "lab.analysis.hint.timeOrder",
  emptyCapture: "lab.analysis.hint.emptyCapture",
};

/** Words Rust sends as the values of these keys, shown in the reader's
    language. Looked up by own keys only: other values are file text, and
    "__proto__" must stay text. */
export const VALUE_WORDS: Record<string, Record<string, MessageKey>> = {
  "pe.signed": { yes: "lab.analysis.value.yes", no: "lab.analysis.value.no" },
  "pe.invalid": {
    notPe: "lab.analysis.value.notPe",
    truncated: "lab.analysis.value.truncated",
    badOptional: "lab.analysis.value.badOptional",
  },
  "image.none": { none: "lab.analysis.value.none" },
  "capinfos.order": { no: "lab.analysis.value.no", yes: "lab.analysis.value.yes" },
};

export const own = <T,>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** An observation's label as the page shows it. */
export function observationLabel(t: Translate, o: Observation): string {
  const key = own(LABELS, o.key);
  return key ? t(key) : o.key;
}

/** An observation's value as the page shows it: numbers rounded for the
    reader, codes as words, file text as it is. */
export function observationShown(t: Translate, locale: string, o: Observation): string {
  if (o.key === "identify.kind") return t(fileKindLabelKey(String(o.value)));
  if (typeof o.value === "number") {
    return o.value.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
  if (o.key === "identify.extension" || o.key === "identify.mismatch") return `.${o.value}`;
  const words = own(VALUE_WORDS, o.key);
  const word = words && own(words, o.value);
  return word ? t(word) : o.value;
}
