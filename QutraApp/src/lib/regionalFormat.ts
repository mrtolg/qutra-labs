/* The regional formats the user chose in Settings › Language & region. The
   time helpers read them on every call through a source registered at boot,
   so a change shows on the next render without a reload. Nothing here
   imports the database: tests and early boot get the defaults. */

export type DateFormat = "auto" | "dmy" | "mdy" | "ymd";
export type HourCycle = "auto" | "h23" | "h12";
export type NumberFormat = "auto" | "dot" | "comma" | "space";

export interface RegionalFormat {
  dateFormat: DateFormat;
  hourCycle: HourCycle;
  numberFormat: NumberFormat;
  /** An IANA zone such as Europe/Istanbul, or "system". */
  timeZone: string;
}

export const DEFAULT_REGIONAL_FORMAT: RegionalFormat = {
  dateFormat: "auto",
  hourCycle: "auto",
  numberFormat: "auto",
  timeZone: "system",
};

let source: () => RegionalFormat = () => DEFAULT_REGIONAL_FORMAT;

/** Called once at boot with a reader of the stored preferences. */
export function setRegionalFormatSource(read: () => RegionalFormat): void {
  source = read;
}

export function regionalFormat(): RegionalFormat {
  try {
    return source();
  } catch {
    return DEFAULT_REGIONAL_FORMAT;
  }
}

const validZones = new Map<string, boolean>();

/** Whether the platform knows this time zone. */
export function isTimeZone(zone: string): boolean {
  const known = validZones.get(zone);
  if (known !== undefined) return known;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    ok = true;
  } catch {
    ok = false;
  }
  validZones.set(zone, ok);
  return ok;
}

/** The computer's own time zone. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The `timeZone` option for Intl: undefined for the computer's own zone,
    or for a stored zone this platform does not know. */
export function timeZoneOption(format: RegionalFormat = regionalFormat()): string | undefined {
  const zone = format.timeZone;
  return zone !== "system" && isTimeZone(zone) ? zone : undefined;
}

/** The `hourCycle` option for Intl; undefined follows the language. */
export function hourCycleOption(
  format: RegionalFormat = regionalFormat(),
): "h23" | "h12" | undefined {
  return format.hourCycle === "auto" ? undefined : format.hourCycle;
}

/** A locale whose grouping and decimal marks match the chosen style. */
export function numberLocale(locale: string, format: RegionalFormat = regionalFormat()): string {
  switch (format.numberFormat) {
    case "dot":
      return "en-US";
    case "comma":
      return "de-DE";
    case "space":
      return "fr-FR";
    default:
      return locale;
  }
}
