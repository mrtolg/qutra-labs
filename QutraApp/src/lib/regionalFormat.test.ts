import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REGIONAL_FORMAT,
  setRegionalFormatSource,
  timeZoneOption,
  type RegionalFormat,
} from "./regionalFormat";
import { formatDate, formatNumber, formatTime } from "./time";

// 2026-10-10 14:05 UTC.
const AT = Date.UTC(2026, 9, 10, 14, 5);
const UTC: RegionalFormat = { ...DEFAULT_REGIONAL_FORMAT, timeZone: "UTC" };
const fmt = (changes: Partial<RegionalFormat>): RegionalFormat => ({ ...UTC, ...changes });

afterEach(() => setRegionalFormatSource(() => DEFAULT_REGIONAL_FORMAT));

describe("regional formats", () => {
  it("writes a date in the chosen order", () => {
    expect(formatDate(AT, "tr", fmt({ dateFormat: "dmy" }))).toBe("10.10.2026");
    expect(formatDate(AT, "tr", fmt({ dateFormat: "mdy" }))).toBe("10/10/2026");
    expect(formatDate(AT, "tr", fmt({ dateFormat: "ymd" }))).toBe("2026-10-10");
    expect(formatDate(AT, "tr", fmt({ dateFormat: "auto" }))).toMatch(/10 Eki/);
  });

  it("uses the chosen clock", () => {
    expect(formatTime(AT, "en", fmt({ hourCycle: "h23" }))).toBe("14:05");
    expect(formatTime(AT, "tr", fmt({ hourCycle: "h12" }))).toMatch(/02:05/);
  });

  it("uses the chosen number marks", () => {
    const n = 1234567.89;
    expect(formatNumber(n, "tr", undefined, fmt({ numberFormat: "dot" }))).toBe("1,234,567.89");
    expect(formatNumber(n, "en", undefined, fmt({ numberFormat: "comma" }))).toBe("1.234.567,89");
    expect(formatNumber(n, "en", undefined, fmt({ numberFormat: "space" }))).toMatch(
      /^1\s234\s567,89$/u,
    );
    expect(formatNumber(n, "tr", undefined, fmt({ numberFormat: "auto" }))).toBe("1.234.567,89");
  });

  it("shows times in the chosen zone, and ignores a zone the platform does not know", () => {
    expect(formatTime(AT, "en", fmt({ hourCycle: "h23", timeZone: "Europe/Istanbul" }))).toBe(
      "17:05",
    );
    expect(timeZoneOption(fmt({ timeZone: "Mars/Olympus" }))).toBeUndefined();
    expect(timeZoneOption(fmt({ timeZone: "system" }))).toBeUndefined();
  });

  it("reads the stored choice when none is passed", () => {
    setRegionalFormatSource(() => fmt({ dateFormat: "ymd" }));
    expect(formatDate(AT, "en")).toBe("2026-10-10");
  });
});
