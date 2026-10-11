import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getBridge } from "@/lib/bridge";

/* Files in an investigation (spec 2026-10-07 §4.2). Rust copies a
   picked or dropped file into the investigation's folder, hashes and types it
   and keeps the record (`investigation_files.rs`). The page asks by
   investigation id and never names a path: Rust opens the picker, and a drop
   on the window is redeemed with the single-use token that comes with its
   event. */

export interface InvestigationFile {
  id: string;
  engagementId: string;
  /** The copy's path inside the investigation folder: `files/<name>`. */
  relPath: string;
  /** The copy's file name, with `.sample` when a double click could run it. */
  name: string;
  /** The name the user's file had. */
  originalName: string;
  bytes: number;
  sha256: string;
  sha1: string;
  md5: string;
  /** A type code from Rust's `detect_kind` ("jpeg", "pe", "pcap", ...). */
  kind: string;
  sample: boolean;
  source: "picked" | "dropped" | "sample";
  addedAt: number;
  /** The copy is not in the investigation's folder (or not whole) any more. */
  missing: boolean;
  /** The copy is marked read-only. */
  readOnly: boolean;
}

/** What happened to one file the user added. */
export type AddOutcome =
  | { outcome: "added"; file: InvestigationFile }
  /** The same content is already in this investigation; nothing was copied. */
  | { outcome: "duplicate"; file: InvestigationFile }
  | { outcome: "failed"; originalName: string; reason: string };

/** A drop on the window, waiting to be added to an investigation. */
export interface DroppedFiles {
  token: string;
  /** File names only, at most 20, for the toast. */
  names: string[];
}

export const FILES_DRAG_EVENT = "qutra://files-drag";
export const FILES_DROPPED_EVENT = "qutra://files-dropped";

export const investigationFiles = {
  /** The browser build has no file system to copy into. */
  available: (): boolean => getBridge().mode === "tauri",
  list: (engagementId: string): Promise<InvestigationFile[]> =>
    invoke<InvestigationFile[]>("investigation_files_list", { engagementId }),
  /** Opens the native picker; resolves with one outcome per picked file. */
  pick: (engagementId: string, title: string): Promise<AddOutcome[]> =>
    invoke<AddOutcome[]>("investigation_files_pick", { engagementId, title }),
  addDropped: (token: string, engagementId: string): Promise<AddOutcome[]> =>
    invoke<AddOutcome[]>("investigation_files_add_dropped", { token, engagementId }),
  onDrag: (handler: (over: boolean) => void): Promise<() => void> =>
    listen<{ over: boolean }>(FILES_DRAG_EVENT, (event) => handler(event.payload.over)),
  onDropped: (handler: (drop: DroppedFiles) => void): Promise<() => void> =>
    listen<DroppedFiles>(FILES_DROPPED_EVENT, (event) => handler(event.payload)),
};
