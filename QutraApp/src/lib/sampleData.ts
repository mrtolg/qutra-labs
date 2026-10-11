import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";
import type { AddOutcome } from "@/lib/investigationFiles";
import { e2eSamples } from "@/lib/e2eSamples";

/* Sample data (2026-10-10): harmless files the app makes itself and
   adds to an investigation by the same path as a picked file. Rust owns the
   list, the file names and every byte (`sample_data.rs`); the page names a
   sample by id and an investigation by id, never a path. */

/** The samples Rust can make, in the order it lists them. */
export const SAMPLE_IDS = [
  "web-log",
  "pcap",
  "program",
  "photo",
  "sarif",
  "event-log",
] as const;
export type SampleId = (typeof SAMPLE_IDS)[number];

export const sampleData = {
  /** The browser build has no folder to put the files in. */
  available: (): boolean => getBridge().mode === "tauri" || e2eSamples() !== undefined,
  /** Makes the chosen samples and adds them to the investigation, whose
      folder must exist. Resolves with one outcome per sample; rejects with
      Rust's reason (`no_engagement_folder`, `sample_write_failed`, ...). */
  generate(engagementId: string, samples: readonly SampleId[]): Promise<AddOutcome[]> {
    const seam = e2eSamples();
    if (seam) return Promise.resolve(seam.generate(engagementId, samples));
    return invoke<AddOutcome[]>("sample_data_generate", {
      engagementId,
      samples: [...samples],
    });
  },
};
