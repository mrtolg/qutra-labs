import { useEffect, useState } from "react";
import { create } from "zustand";
import { aiConnections, targetKey, type AiTarget, type KeyStatus } from "@/lib/aiConnections";

/* What Rust says about a connection's key, shared by every place that shows
   it (the route picker and the connection cards), so saving or removing a
   key on one card updates the others at once. The renderer only ever sees
   `{present, last4, baseUrl}`, never the key. */

const useVersion = create<{ version: number }>(() => ({ version: 0 }));

/** Ask every reader to fetch the status again (after a save or a removal). */
export function refreshKeyStatuses(): void {
  useVersion.setState((state) => ({ version: state.version + 1 }));
}

const UNREADABLE: KeyStatus = { present: false, last4: null, baseUrl: null };

/** The key status for one connection; null until Rust has answered. */
export function useKeyStatus(target: AiTarget | null): KeyStatus | null {
  const version = useVersion((state) => state.version);
  const name = target ? targetKey(target) : null;
  const [answer, setAnswer] = useState<{ name: string; status: KeyStatus } | null>(null);

  useEffect(() => {
    if (!target || !name || !aiConnections.available()) return;
    let alive = true;
    aiConnections
      .keyStatus(target)
      .then((status) => {
        if (alive) setAnswer({ name, status });
      })
      .catch(() => {
        if (alive) setAnswer({ name, status: UNREADABLE });
      });
    return () => {
      alive = false;
    };
    // `name` identifies the target; the object itself is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, version]);

  return answer && answer.name === name ? answer.status : null;
}
