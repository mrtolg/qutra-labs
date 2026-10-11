import { getDb } from "@/lib/db/database";
import { localEngine } from "@/lib/localEngine/client";

/* The models Jarvis can run on this computer. This is the one place the
   chat asks for them, so the local engine behind it can change without the
   chat changing. The engine is Qutra's own (ADR 0016): Rust reads the app's
   models folder and Ollama's model store in place, so Ollama need not run. */

export type LocalModel = {
  id: string;
  name: string;
  sizeBytes?: number;
  source: string;
};

/** Thrown when the local engine could not be asked: this is the browser
    build, or Rust could not read the model folders. An empty list means it
    answered with none. */
export class LocalModelsUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`local models unavailable: ${reason}`);
    this.name = "LocalModelsUnavailable";
  }
}

/** The local models. Resolves to [] while Jarvis's local engine is switched
    off (nothing is asked then); rejects with `LocalModelsUnavailable` when it
    is on and cannot be asked. A model that needs its one-time copy is listed:
    choosing it leads to the step that prepares it. One the engine cannot run
    is not. */
export async function listLocalModels(): Promise<LocalModel[]> {
  const { localAssistantEnabled } = getDb().prefs.get();
  if (!localAssistantEnabled) return [];
  if (!localEngine.available()) throw new LocalModelsUnavailable("unavailable");
  let report;
  try {
    report = await localEngine.models();
  } catch (caught) {
    const code =
      caught && typeof caught === "object" && "error" in caught
        ? String((caught as { error: { code: string } }).error.code)
        : "error";
    throw new LocalModelsUnavailable(code);
  }
  return report.models
    .filter((m) => m.state === "ready" || m.state === "needs_prepare")
    .map((m) => ({ id: m.id, name: m.name, sizeBytes: m.sizeBytes, source: m.source }));
}
