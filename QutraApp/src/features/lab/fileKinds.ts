import {
  Archive,
  Binary,
  Cpu,
  Database,
  FileImage,
  FileText,
  Link2,
  Network,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import type { EngagementKind } from "@/domain/lab";
import type { MessageKey } from "@/lib/i18n/en";

/** An investigation of a file, a capture or a forensic image starts with its
    file (spec 2026-10-07 §5.2); the others start with their targets. */
export function startsWithFile(kind: EngagementKind | undefined): boolean {
  return kind === "file" || kind === "pcap" || kind === "forensics";
}

/* How a file kind from Rust's `detect_kind` (investigation_files.rs) reads
   and looks. A code this version does not know reads as an unknown binary. */
const KIND_ICONS: Record<string, LucideIcon> = {
  jpeg: FileImage,
  png: FileImage,
  gif: FileImage,
  pdf: FileText,
  office: FileText,
  text: FileText,
  zip: Archive,
  gzip: Archive,
  "7z": Archive,
  rar: Archive,
  pe: Cpu,
  elf: Cpu,
  macho: Cpu,
  pcap: Network,
  pcapng: Network,
  evtx: ScrollText,
  sqlite: Database,
  lnk: Link2,
  binary: Binary,
};

const known = (kind: string) => Object.prototype.hasOwnProperty.call(KIND_ICONS, kind);

export function fileKindLabelKey(kind: string): MessageKey {
  return (known(kind) ? `lab.files.kind.${kind}` : "lab.files.kind.binary") as MessageKey;
}

export function fileKindIcon(kind: string): LucideIcon {
  return known(kind) ? KIND_ICONS[kind] : Binary;
}
