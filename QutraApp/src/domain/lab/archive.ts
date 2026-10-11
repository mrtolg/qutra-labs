import type { Engagement } from "@/domain/lab";

/* Archiving an investigation and putting it back. The state it had before
   goes with it, so a completed or active one is not turned into "planned" by
   the round trip. */

/** What changes when an investigation is archived. */
export function archivePatch(e: Engagement, at: number): Partial<Engagement> {
  return {
    status: "archived",
    // Archiving twice keeps the first answer.
    statusBeforeArchive: e.status === "archived" ? e.statusBeforeArchive : e.status,
    updatedAt: at,
  };
}

/** What changes when an archived investigation is restored. A record
    archived before this was kept comes back as "planned". */
export function restorePatch(e: Engagement, at: number): Partial<Engagement> {
  return {
    status: e.statusBeforeArchive ?? "planned",
    statusBeforeArchive: undefined,
    updatedAt: at,
  };
}
