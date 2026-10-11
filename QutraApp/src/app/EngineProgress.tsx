import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useAutoEngine } from "@/lib/localEngine/autoEngine";
import {
  ENGINE_TASK_EVENT,
  type LocalEngineClient,
  type TaskEvent,
  formatBytes,
  localEngine,
} from "@/lib/localEngine/client";
import "@/features/localEngine/localEngine.css";
import "./assistantCards.css";

/* While the engine is being made ready after a model was chosen (wherever it
   was chosen), a small card in the corner says which step it is on and how
   far the download or the copy has got. It is there only while that goes on;
   a failure is a toast (useEngineAutopilot). */
export function EngineProgress({ client = localEngine }: { client?: LocalEngineClient }) {
  const { t, locale } = useT();
  const { phase, model } = useAutoEngine();
  const [task, setTask] = useState<TaskEvent | null>(null);
  const working = phase === "installing" || phase === "preparing" || phase === "starting";

  useEffect(() => {
    if (!working || !client.available()) return;
    let disposed = false;
    let unlisten = () => {};
    void client
      .listen<TaskEvent>(ENGINE_TASK_EVENT, (next) => {
        setTask(next.phase === "running" ? next : null);
      })
      .then((un) => (disposed ? un() : (unlisten = un)));
    return () => {
      disposed = true;
      unlisten();
      setTask(null);
    };
  }, [working, client]);

  if (!working) return null;
  const percent =
    task && task.totalBytes > 0
      ? Math.min(100, Math.floor((task.doneBytes / task.totalBytes) * 100))
      : null;
  const text =
    phase === "installing"
      ? task
        ? t("engine.installing", {
            done: formatBytes(task.doneBytes, locale),
            total: formatBytes(task.totalBytes, locale),
          })
        : t("engine.auto.working")
      : phase === "preparing"
        ? t("engine.prepare.running", { model: model ?? "", percent: percent ?? 0 })
        : t("engine.phase.loading", { model: model ?? "" });

  return (
    <div className="acard acard--engine" role="status" aria-live="polite" data-testid="engine-progress">
      <span>
        <Loader2 size={13} className="spin" aria-hidden /> {text}
      </span>
      {percent !== null && (
        <div
          className="le-progress"
          role="progressbar"
          aria-label={text}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="le-progress__bar" style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
      )}
    </div>
  );
}
