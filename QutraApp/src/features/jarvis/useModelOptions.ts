import { useCallback, useEffect, useState } from "react";
import { listLocalModels, type LocalModel } from "@/lib/ai/localModels";
import { aiConnections, targetKey, type AiTarget, type KeyStatus } from "@/lib/aiConnections";
import { usePreferences } from "@/lib/db/database";
import { cloudModelOf } from "./jarvisModel";

/* The models Jarvis can be pointed at, for the composer's switcher and the
   settings' default: what the local engine has installed, and the cloud
   connections with the model chosen for each. Asking the local engine and
   reading whether a key is saved stay on this computer; no cloud service is
   called here. */

export type LocalModels =
  | { kind: "loading" }
  /** The local engine is switched off: nothing was asked. */
  | { kind: "off" }
  | { kind: "unreachable" }
  | { kind: "ready"; models: LocalModel[] };

export interface CloudOption {
  target: AiTarget;
  /** The model chosen for the connection in its card; "" when none yet. */
  model: string;
  /** null while being read, or in the browser build. */
  key: KeyStatus | null;
}

export function useModelOptions(active: boolean) {
  const prefs = usePreferences();
  const [local, setLocal] = useState<LocalModels>({ kind: "loading" });
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [attempt, setAttempt] = useState(0);
  const cloudAvailable = aiConnections.available();

  useEffect(() => {
    if (!active) return;
    if (!prefs.localAssistantEnabled) {
      setLocal({ kind: "off" });
      return;
    }
    let live = true;
    setLocal({ kind: "loading" });
    listLocalModels().then(
      (models) => {
        if (live) setLocal({ kind: "ready", models });
      },
      () => {
        if (live) setLocal({ kind: "unreachable" });
      },
    );
    return () => {
      live = false;
    };
  }, [active, prefs.localAssistantEnabled, attempt]);

  const targets: AiTarget[] = [
    { provider: "anthropic" },
    { provider: "openai_compat", preset: prefs.aiOpenAiPreset },
  ];
  const targetsKey = targets.map(targetKey).join("|");

  useEffect(() => {
    if (!active || !cloudAvailable) return;
    let live = true;
    for (const target of targetsKey.split("|").map(parseTarget)) {
      aiConnections.keyStatus(target).then(
        (status) => {
          if (live) setKeys((prev) => ({ ...prev, [targetKey(target)]: status }));
        },
        (caught: unknown) => console.error("cloud key status not read", caught),
      );
    }
    return () => {
      live = false;
    };
  }, [active, cloudAvailable, targetsKey, attempt]);

  const cloud: CloudOption[] = cloudAvailable
    ? targets.map((target) => ({
        target,
        model: cloudModelOf(prefs, target),
        key: keys[targetKey(target)] ?? null,
      }))
    : [];

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { local, cloud, cloudAvailable, retry };
}

function parseTarget(key: string): AiTarget {
  if (key === "anthropic") return { provider: "anthropic" };
  const preset = key.slice("openai_compat:".length) as Extract<AiTarget, { provider: "openai_compat" }>["preset"];
  return { provider: "openai_compat", preset };
}
