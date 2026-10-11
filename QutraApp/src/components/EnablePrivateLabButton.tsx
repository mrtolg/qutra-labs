import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  grantPrivateLab,
  type PrivateLabGrantResult,
} from "@/lib/enablePrivateLab";
import { getBridge } from "@/lib/bridge";

export function EnablePrivateLabButton({
  testId = "enable-private-lab",
}: {
  testId?: string;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<PrivateLabGrantResult | "working" | null>(
    null,
  );
  const nativeAvailable = getBridge().toolSupervisor.available();

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      {!nativeAvailable && (
        <p
          className="faint"
          style={{ fontSize: "var(--fs-12)", margin: 0 }}
          data-testid="private-lab-native-status"
        >
          {t("jarvis.permission.nativeUnavailable")}
        </p>
      )}
      <button
        type="button"
        className="btn btn--primary"
        data-testid={testId}
        disabled={status === "working"}
        onClick={() => {
          setStatus("working");
          void grantPrivateLab().then(setStatus);
        }}
      >
        {t("tools.enable")}
      </button>
      {status === "working" || status === "pending" ? (
        <p className="muted" data-testid="private-lab-grant-status">
          {t("jarvis.permission.pending")}
        </p>
      ) : null}
      {status === "unavailable" ? (
        <p className="muted" data-testid="private-lab-grant-status">
          {t("jarvis.permission.nativeUnavailable")}
        </p>
      ) : null}
      {status === "declined" ? (
        <p className="muted" data-testid="private-lab-grant-status">
          {t("jarvis.permission.nativeDeclined")}
        </p>
      ) : null}
    </div>
  );
}
