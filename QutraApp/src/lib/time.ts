/** Locale-aware time helpers. All persistence uses ISO strings / epoch ms.
    Dates, times and numbers follow the regional formats chosen in Settings
    (date order, 12/24-hour clock, number marks, time zone). */

import {
  hourCycleOption,
  numberLocale,
  regionalFormat,
  timeZoneOption,
  type RegionalFormat,
} from "./regionalFormat";

export const now = () => Date.now();

export function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  return ts + days * 86_400_000;
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** `format` defaults to the user's choice; Settings passes others to show
    what each choice would look like. */
export function formatTime(
  ts: number,
  locale: string,
  format: RegionalFormat = regionalFormat(),
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: hourCycleOption(format),
    timeZone: timeZoneOption(format),
  }).format(ts);
}

/** A date in the chosen order: the language's own words ("10 Eki"), or
    all digits as day.month.year, month/day/year or year-month-day. */
export function formatDate(
  ts: number,
  locale: string,
  format: RegionalFormat = regionalFormat(),
): string {
  const timeZone = timeZoneOption(format);
  if (format.dateFormat !== "auto") {
    const parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone,
    }).formatToParts(ts);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const [d, m, y] = [part("day"), part("month"), part("year")];
    if (format.dateFormat === "dmy") return `${d}.${m}.${y}`;
    if (format.dateFormat === "mdy") return `${m}/${d}/${y}`;
    return `${y}-${m}-${d}`;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year:
      new Date(ts).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
    timeZone,
  }).format(ts);
}

/** A number with the chosen grouping and decimal marks. */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
  format: RegionalFormat = regionalFormat(),
): string {
  return new Intl.NumberFormat(numberLocale(locale, format), options).format(value);
}

export function formatDateTime(
  ts: number,
  locale: string,
  format: RegionalFormat = regionalFormat(),
): string {
  return `${formatDate(ts, locale, format)}, ${formatTime(ts, locale, format)}`;
}

export function formatWeekday(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: timeZoneOption() }).format(ts);
}

/** "3h ago" / "3 sa önce" style relative time. */
export function formatRelative(ts: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000)
    return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 30 * 86_400_000)
    return rtf.format(Math.round(diff / 86_400_000), "day");
  return formatDate(ts, locale);
}

/** Format elapsed duration as h:mm:ss or m:ss. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Format minutes as "1h 20m" / "1 sa 20 dk". */
export function formatMinutes(min: number, locale: string): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  const tr = locale.startsWith("tr");
  if (h > 0 && m > 0) return tr ? `${h} sa ${m} dk` : `${h}h ${m}m`;
  if (h > 0) return tr ? `${h} sa` : `${h}h`;
  return tr ? `${m} dk` : `${m}m`;
}
