import { invoke } from "@tauri-apps/api/core";
import { getBridge } from "@/lib/bridge";

/* Engagement folders (2026-10-06): the desktop app keeps each
   engagement's files in a folder of its own. Rust makes the folder and is the
   only one that writes into it (`engagement_folders.rs`): the page asks for a
   folder by engagement id and a file by plain name, and never names a path. */

export interface FolderInfo {
  /** The folder as Explorer shows it. */
  path: string;
  /** False when the user moved or deleted it since. */
  exists: boolean;
}

/** A parent folder the user chose in the native dialog. */
export interface PickedParent {
  token: string;
  path: string;
}

export const engagementFolders = {
  /** The browser build has no file system to keep them in. */
  available: (): boolean => getBridge().mode === "tauri",
  /** Where new engagement folders go unless the user picks a parent. */
  root: (): Promise<string | null> => invoke<string | null>("engagement_folder_root"),
  pickParent: (title: string): Promise<PickedParent | null> =>
    invoke<PickedParent | null>("engagement_folder_pick_parent", { title }),
  create: (engagementId: string, name: string, parentToken: string | null): Promise<FolderInfo> =>
    invoke<FolderInfo>("engagement_folder_create", { engagementId, name, parentToken }),
  get: (engagementId: string): Promise<FolderInfo | null> =>
    invoke<FolderInfo | null>("engagement_folder_get", { engagementId }),
  /** Resolves with the written file's path. */
  write: (engagementId: string, fileName: string, contents: string): Promise<string> =>
    invoke<string>("engagement_folder_write", { engagementId, fileName, contents }),
};

const FORBIDDEN = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

/** The folder name Rust will make for `name` (`folder_name` in
    engagement_folders.rs), so the dialog can show it before anything is made. */
export function folderNameFor(name: string): string {
  const cleaned = Array.from(name, (c) => {
    const code = c.codePointAt(0) ?? 0;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    return control || FORBIDDEN.has(c) ? " " : c;
  }).join("");
  const collapsed = cleaned.split(/\s+/).filter(Boolean).join(" ");
  const capped = Array.from(collapsed).slice(0, 80).join("");
  const trimmed = capped.replace(/[. ]+$/, "").trimStart();
  const base = trimmed || "Engagement";
  const stem = (base.split(".")[0] ?? base).trim().toUpperCase();
  const reserved =
    ["CON", "PRN", "AUX", "NUL"].includes(stem) || /^(COM|LPT)\d$/.test(stem);
  return reserved ? `${base}_` : base;
}

/** A report file name the folder accepts: `<word> <yyyy-mm-dd> <hhmm>.md`. */
export function reportFileName(word: string, at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safeWord = folderNameFor(word).replace(/\./g, " ").trim() || "Report";
  return `${safeWord} ${day} ${pad(d.getHours())}${pad(d.getMinutes())}.md`;
}
