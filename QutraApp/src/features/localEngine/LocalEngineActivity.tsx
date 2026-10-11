import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  ENGINE_STATUS_EVENT,
  type EngineStatus,
  type LocalEngineClient,
  localEngine,
} from "@/lib/localEngine/client";
import "./localEngine.css";

/** One line under the conversation while the local engine starts or loads
    a model for the turn being sent, so a long first load reads as progress,
    not as a hang. Says nothing the rest of the time. */
export function LocalEngineActivity({ client = localEngine }: { client?: LocalEngineClient }) {
  const { t } = useT();
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    if (!client.available()) return;
    let disposed = false;
    let unlisten = () => {};
    void client
      .listen<EngineStatus>(ENGINE_STATUS_EVENT, setStatus)
      .then((un) => (disposed ? un() : (unlisten = un)));
    return () => {
      disposed = true;
      unlisten();
    };
  }, [client]);

  if (!status || (status.phase !== "starting" && status.phase !== "loading")) return null;
  return (
    <div className="le-activity" role="status" aria-live="polite" data-testid="local-engine-activity">
      <Loader2 size={13} className="spin" aria-hidden />
      <span>
        {status.phase === "starting"
          ? t("engine.phase.starting")
          : t("engine.phase.loading", { model: status.model ?? "" })}{" "}
        <span className="faint">{t("engine.loadingHint")}</span>
      </span>
    </div>
  );
}
