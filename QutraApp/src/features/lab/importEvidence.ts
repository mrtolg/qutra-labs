import { EvidenceSchema, type Evidence } from "@/domain/findings";
import { createId } from "@/lib/id";

/* An imported file becomes evidence: the scan a finding was
   imported from, named and hashed from its real bytes. The row has no
   content: one scan is evidence for many findings, and a copy in each would
   fill the report. Lab-only. */

export interface ImportSource {
  /** The file's name, or the pasted-text label. */
  name: string;
  /** SHA-256 of the file's bytes, or of the pasted text as UTF-8. */
  sha256: string;
}

export function evidenceFromImport(input: {
  engagementId: string;
  findingId: string;
  source: ImportSource;
  /** The parser that read it: "sarif", "nmap". */
  parser: string;
  now: number;
}): Evidence {
  return EvidenceSchema.parse({
    id: createId("ev"),
    findingId: input.findingId,
    engagementId: input.engagementId,
    kind: "file",
    title: input.source.name.slice(0, 120),
    content: "",
    path: "",
    sha256: input.source.sha256,
    capturedAt: input.now,
    source: `import:${input.parser}`,
    sensitivity: "normal",
    includeInReport: true,
    demo: false,
    createdAt: input.now,
  });
}
