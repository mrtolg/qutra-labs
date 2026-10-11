/* The assistant's greeting: the part of the day, and the user's own form of
   address when they gave one. Pure, so the words and the clock stay apart. */

export type DayPart = "morning" | "afternoon" | "evening" | "night";

/** 05-11 morning, 12-17 afternoon, 18-21 evening, 22-04 night. */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

/** The form of address as the greeting uses it: trimmed, spaces collapsed;
    "" when there is none. */
export function addressName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
