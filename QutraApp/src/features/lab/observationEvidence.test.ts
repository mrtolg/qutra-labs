import { describe, expect, it } from "vitest";
import type { AnalysisRun, Observation } from "@/lib/analysis";
import { sha256Hex } from "@/lib/hash";
import {
  evidenceFromObservation,
  evidencePointingAtRun,
  findingFromObservation,
  isSensitiveObservation,
  pinnedEvidence,
} from "./observationEvidence";

/* An observation of a built-in analysis as evidence, and as a
   finding whose chain starts at the analysis. */

const RUN: AnalysisRun = {
  id: "ana-00000000-0000-4000-8000-000000000001",
  kind: "builtin",
  engagementId: "eng_1",
  fileId: "file_1",
  analyzer: "image",
  state: "finished",
  startedAt: 1,
  endedAt: 2,
  trigger: { by: "user" },
  fileSha256: "ab".repeat(32),
  limited: false,
  observations: [],
  outputs: [
    { name: "output.txt", relPath: "analysis/ana-1/output.txt", sha256: "cd".repeat(32), bytes: 10 },
  ],
};

const GPS: Observation = {
  id: `${RUN.id}:3`,
  key: "image.gps",
  value: "41.008200, 28.978400",
  group: "interesting",
  hint: "gpsLocation",
};

const CAMERA: Observation = {
  id: `${RUN.id}:1`,
  key: "image.camera",
  value: "Canon EOS 5D",
  group: "summary",
};

describe("observation evidence", () => {
  it("keeps what was found, hashed, with its run and raw output", async () => {
    const evidence = await evidenceFromObservation({
      run: RUN,
      observation: { ...GPS, items: ["alt 12 m"] },
      label: "Location",
      shown: "41.008200, 28.978400",
      hint: "The photo says where it was taken.",
      now: 5,
    });
    expect(evidence).toMatchObject({
      kind: "observation",
      runId: RUN.id,
      fileId: "file_1",
      engagementId: "eng_1",
      observationIds: [GPS.id],
      rawRef: { relPath: "analysis/ana-1/output.txt", sha256: "cd".repeat(32) },
      source: "analysis:image",
      content: [
        "Location: 41.008200, 28.978400",
        "The photo says where it was taken.",
        "image.gps = 41.008200, 28.978400",
        "- alt 12 m",
      ].join("\n"),
      sensitivity: "sensitive",
    });
    expect(evidence.sha256).toBe(await sha256Hex(evidence.content));
  });

  it("keeps a sensitive value out of the title", async () => {
    const gps = await evidenceFromObservation({
      run: RUN,
      observation: GPS,
      label: "Location",
      shown: "41.008200, 28.978400",
      now: 5,
    });
    const camera = await evidenceFromObservation({
      run: RUN,
      observation: CAMERA,
      label: "Camera",
      shown: "Canon EOS 5D",
      now: 5,
    });
    expect(gps.title).toBe("Location");
    expect(camera).toMatchObject({ title: "Camera: Canon EOS 5D", sensitivity: "normal" });
  });

  it("makes a finding whose source is the analysis run and whose description is the hint", () => {
    const finding = findingFromObservation({
      run: RUN,
      observation: CAMERA,
      label: "Camera",
      shown: "Canon EOS 5D",
      hint: "It can identify a person or a camera.",
      target: "IMG_0042.jpg",
      now: 5,
    });
    expect(finding).toMatchObject({
      sourceRunId: RUN.id,
      engagementId: "eng_1",
      status: "new",
      severity: "info",
      title: "Camera: Canon EOS 5D",
      description: "It can identify a person or a camera.",
      affectedTargets: ["IMG_0042.jpg"],
    });
    const located = findingFromObservation({
      run: RUN,
      observation: GPS,
      label: "Location",
      shown: "41.008200, 28.978400",
      target: "IMG_0042.jpg",
      now: 5,
    });
    expect(located.title).toBe("Location");
  });

  it("knows which observations are already kept, also after a step ran again", async () => {
    const evidence = await evidenceFromObservation({
      run: RUN,
      observation: CAMERA,
      label: "Camera",
      shown: "Canon EOS 5D",
      now: 5,
    });
    const title = "Camera: Canon EOS 5D";
    expect(pinnedEvidence([evidence], RUN, CAMERA, title)?.id).toBe(evidence.id);

    // The same step on the same file again: new ids, the same finding.
    const again = { ...RUN, id: "ana-00000000-0000-4000-8000-000000000002" };
    const sameAgain = { ...CAMERA, id: `${again.id}:1` };
    expect(pinnedEvidence([evidence], again, sameAgain, title)?.id).toBe(evidence.id);
    // Another file, or something else found: not kept.
    expect(pinnedEvidence([evidence], { ...again, fileId: "file_2" }, sameAgain, title)).toBeUndefined();
    expect(pinnedEvidence([evidence], again, sameAgain, "Camera: Nikon")).toBeUndefined();
  });
});

describe("evidence from an outside program", () => {
  const TOOL_RUN: AnalysisRun = {
    ...RUN,
    id: "run-00000000-0000-4000-8000-000000000009",
    kind: "external",
    analyzer: "exiftool",
    outputs: [{ name: "stdout.log", relPath: "runs/run-9/stdout.log", sha256: "ee".repeat(32), bytes: 7 }],
  };

  it("names the program as its source, keeps the log as its raw output, and guards a person's data", async () => {
    for (const key of ["exiftool.gps", "exiftool.owner", "exiftool.serial"]) {
      expect(isSensitiveObservation(key)).toBe(true);
    }
    expect(isSensitiveObservation("exiftool.camera")).toBe(false);
    const evidence = await evidenceFromObservation({
      run: TOOL_RUN,
      observation: { id: `${TOOL_RUN.id}:6`, key: "exiftool.gps", value: "41.008200, 28.978400", group: "interesting" },
      label: "Location",
      shown: "41.008200, 28.978400",
      now: 5,
    });
    expect(evidence).toMatchObject({
      source: "tool:exiftool",
      sensitivity: "sensitive",
      title: "Location",
      rawRef: { relPath: "runs/run-9/stdout.log", sha256: "ee".repeat(32) },
    });
    // A pin from a built-in step of the same name is another evidence.
    expect(pinnedEvidence([evidence], RUN, { ...GPS, id: "other" }, "Location")).toBeUndefined();
  });

  it("finds the evidence that points at a run's logs", () => {
    const pointing = { runId: TOOL_RUN.id, kind: "observation" };
    const other = { runId: "run-other", kind: "observation" };
    expect(evidencePointingAtRun([pointing, other, { kind: "text" }] as never, TOOL_RUN.id)).toEqual([pointing]);
    // Only an observation's link to the logs breaks; other kinds of the same run do not point at them.
    expect(evidencePointingAtRun([{ runId: TOOL_RUN.id, kind: "text" }] as never, TOOL_RUN.id)).toEqual([]);
  });

  it("keeps a run's built-in steps and an outside program's apart, and finds the program's again after a rerun", async () => {
    const owner: Observation = { id: `${TOOL_RUN.id}:2`, key: "exiftool.camera", value: "Canon", group: "summary" };
    const evidence = await evidenceFromObservation({ run: TOOL_RUN, observation: owner, label: "Camera", shown: "Canon", now: 5 });
    expect(evidence.source).toBe("tool:exiftool");

    // The same program on the same file again: new ids, the same evidence.
    const again = { ...TOOL_RUN, id: "run-00000000-0000-4000-8000-00000000000a" };
    const sameAgain = { ...owner, id: `${again.id}:2` };
    expect(pinnedEvidence([evidence], again, sameAgain, "Camera: Canon")?.id).toBe(evidence.id);
    // A built-in step of the same name on the same file is another source.
    expect(pinnedEvidence([evidence], { ...again, kind: "builtin" }, sameAgain, "Camera: Canon")).toBeUndefined();
  });

  it("makes a finding that starts at the program's run", () => {
    const finding = findingFromObservation({
      run: TOOL_RUN,
      observation: { id: `${TOOL_RUN.id}:6`, key: "exiftool.gps", value: "41.008200, 28.978400", group: "interesting" },
      label: "Location",
      shown: "41.008200, 28.978400",
      target: "IMG_0042.jpg",
      now: 5,
    });
    expect(finding).toMatchObject({ sourceRunId: TOOL_RUN.id, title: "Location" });
  });
});
