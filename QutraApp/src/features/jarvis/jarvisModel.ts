import type { ModelChoice } from "@/domain/conversations";
import type { Preferences } from "@/domain/types";
import {
  DEFAULT_ANTHROPIC_MODEL,
  targetKey,
  type AiTarget,
  type OpenAiPreset,
} from "@/lib/aiConnections";
import type { Database } from "@/lib/db/database";

/* Which model answers: a default in preferences, and a
   choice per conversation that overrides it. The default lives in the same
   preferences Settings already uses (`aiProvider`, `ollamaModel`,
   `aiModels`), so there is one default however it is set. */

export type Provider = ModelChoice["provider"];

/** The model a conversation's next turn uses. `model` may be empty: a cloud
    connection whose model was never chosen. */
export interface ResolvedModel {
  provider: Provider;
  preset?: OpenAiPreset;
  model: string;
  /** Chosen for this conversation rather than inherited from the default. */
  own: boolean;
}

/** The connection's model as Settings keeps it. */
export function cloudModelOf(prefs: Preferences, target: AiTarget): string {
  return (
    prefs.aiModels[targetKey(target)] ??
    (target.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "")
  );
}

export function defaultModel(prefs: Preferences): ResolvedModel {
  if (prefs.aiProvider === "anthropic") {
    return { provider: "anthropic", model: cloudModelOf(prefs, { provider: "anthropic" }), own: false };
  }
  if (prefs.aiProvider === "openai_compat") {
    const preset = prefs.aiOpenAiPreset;
    return {
      provider: "openai_compat",
      preset,
      model: cloudModelOf(prefs, { provider: "openai_compat", preset }),
      own: false,
    };
  }
  return { provider: "local", model: prefs.ollamaModel, own: false };
}

export function resolveModel(choice: ModelChoice | undefined, prefs: Preferences): ResolvedModel {
  if (!choice) return defaultModel(prefs);
  return choice.provider === "openai_compat"
    ? { provider: "openai_compat", preset: choice.preset, model: choice.model, own: true }
    : { provider: choice.provider, model: choice.model, own: true };
}

/** The cloud connection a resolved model goes through; null for local. */
export function targetOf(model: Pick<ResolvedModel, "provider" | "preset">): AiTarget | null {
  if (model.provider === "anthropic") return { provider: "anthropic" };
  if (model.provider === "openai_compat") {
    return { provider: "openai_compat", preset: model.preset ?? "openai" };
  }
  return null;
}

/** As a stored choice; null when the model is not chosen yet. */
export function choiceOf(model: Pick<ResolvedModel, "provider" | "preset" | "model">): ModelChoice | null {
  if (!model.model) return null;
  if (model.provider === "openai_compat") {
    return { provider: "openai_compat", preset: model.preset ?? "openai", model: model.model };
  }
  return { provider: model.provider, model: model.model };
}

export function sameModel(
  a: Pick<ResolvedModel, "provider" | "preset" | "model">,
  b: Pick<ResolvedModel, "provider" | "preset" | "model">,
): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    (a.provider !== "openai_compat" || a.preset === b.preset)
  );
}

/** Make a choice the default for every conversation without its own. */
export function setDefaultModel(db: Database, choice: ModelChoice): void {
  const prefs = db.prefs.get();
  if (choice.provider === "local") {
    db.prefs.set({ aiProvider: "ollama", ollamaModel: choice.model });
    return;
  }
  const target: AiTarget =
    choice.provider === "anthropic"
      ? { provider: "anthropic" }
      : { provider: "openai_compat", preset: choice.preset };
  db.prefs.set({
    aiProvider: choice.provider,
    ...(choice.provider === "openai_compat" ? { aiOpenAiPreset: choice.preset } : {}),
    aiModels: { ...prefs.aiModels, [targetKey(target)]: choice.model },
  });
}
