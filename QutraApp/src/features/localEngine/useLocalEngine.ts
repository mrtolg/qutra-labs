import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENGINE_STATUS_EVENT,
  ENGINE_TASK_EVENT,
  type EngineReport,
  type EngineStatus,
  type LocalEngineClient,
  LocalEngineCommandError,
  type LocalEngineError,
  type ModelsReport,
  type TaskEvent,
  localEngine,
} from "@/lib/localEngine/client";

export interface LocalEngineView {
  report: EngineReport | null;
  models: ModelsReport | null;
  /** The last command this view sent that Rust refused. */
  error: LocalEngineError | null;
  loading: boolean;
  refresh: () => Promise<void>;
  run: <T>(action: (client: LocalEngineClient) => Promise<T>) => Promise<T | undefined>;
}

/** The engine and its models as Rust reports them, kept current by its
    events. Reads nothing while `enabled` is off. */
export function useLocalEngine(
  enabled: boolean,
  onSettled?: (task: TaskEvent) => void,
  client: LocalEngineClient = localEngine,
): LocalEngineView {
  const [report, setReport] = useState<EngineReport | null>(null);
  const [models, setModels] = useState<ModelsReport | null>(null);
  const [error, setError] = useState<LocalEngineError | null>(null);
  const [loading, setLoading] = useState(false);
  const live = useRef(true);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const refresh = useCallback(async () => {
    if (!enabled || !client.available()) return;
    setLoading(true);
    try {
      const [nextReport, nextModels] = await Promise.all([client.status(), client.models()]);
      if (!live.current) return;
      setReport(nextReport);
      setModels(nextModels);
    } catch (caught) {
      if (live.current && caught instanceof LocalEngineCommandError) setError(caught.error);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [enabled, client]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setReport(null);
      setModels(null);
      return;
    }
    void refresh();
    let unlistenStatus = () => {};
    let unlistenTask = () => {};
    let disposed = false;
    void client
      .listen<EngineStatus>(ENGINE_STATUS_EVENT, (status) => {
        setReport((prev) => (prev ? { ...prev, status } : prev));
      })
      .then((un) => (disposed ? un() : (unlistenStatus = un)));
    void client
      .listen<TaskEvent>(ENGINE_TASK_EVENT, (task) => {
        setReport((prev) => (prev ? { ...prev, task } : prev));
        if (task.phase !== "running") {
          void refresh();
          settled.current?.(task);
        }
      })
      .then((un) => (disposed ? un() : (unlistenTask = un)));
    return () => {
      disposed = true;
      unlistenStatus();
      unlistenTask();
    };
  }, [enabled, client, refresh]);

  const run = useCallback(
    async <T,>(action: (c: LocalEngineClient) => Promise<T>): Promise<T | undefined> => {
      setError(null);
      try {
        return await action(client);
      } catch (caught) {
        if (live.current) {
          setError(caught instanceof LocalEngineCommandError ? caught.error : { code: "io" });
        }
        return undefined;
      }
    },
    [client],
  );

  return { report, models, error, loading, refresh, run };
}
