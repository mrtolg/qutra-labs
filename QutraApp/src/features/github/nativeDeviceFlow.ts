import { invoke } from "@tauri-apps/api/core";

export interface NativeDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export type NativeDeviceFlowState =
  | { phase: "requesting" }
  | { phase: "awaiting"; code: NativeDeviceCode }
  | { phase: "authorized" }
  | { phase: "denied" }
  | { phase: "expired" }
  | { phase: "cancelled" }
  | { phase: "error"; detail: string };

interface PollResponse {
  state: "authorized" | "pending" | "slow_down" | "denied" | "expired";
}

interface DeviceFlowDeps {
  invokeImpl?: typeof invoke;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: { aborted: boolean };
  onState?: (state: NativeDeviceFlowState) => void;
}

export async function runNativeDeviceFlow(
  clientId: string,
  deps: DeviceFlowDeps = {},
): Promise<NativeDeviceFlowState> {
  const invokeImpl = deps.invokeImpl ?? invoke;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const emit = (state: NativeDeviceFlowState) => {
    deps.onState?.(state);
    return state;
  };
  const cancelled = () => deps.signal?.aborted === true;

  emit({ phase: "requesting" });
  let code: NativeDeviceCode;
  try {
    code = await invokeImpl<NativeDeviceCode>("github_device_start", {
      clientId,
    });
  } catch (error) {
    return emit({ phase: "error", detail: stableError(error) });
  }
  emit({ phase: "awaiting", code });

  let intervalMs = Math.max(1, code.intervalSec) * 1000;
  const deadline = now() + code.expiresInSec * 1000;
  while (!cancelled()) {
    await sleep(intervalMs);
    if (cancelled()) return emit({ phase: "cancelled" });
    if (now() >= deadline) return emit({ phase: "expired" });

    let response: PollResponse;
    try {
      response = await invokeImpl<PollResponse>("github_device_poll", {
        clientId,
        deviceCode: code.deviceCode,
      });
    } catch (error) {
      const detail = stableError(error);
      if (detail === "offline") continue;
      return emit({ phase: "error", detail });
    }

    if (response.state === "authorized") {
      return emit({ phase: "authorized" });
    }
    if (response.state === "denied") return emit({ phase: "denied" });
    if (response.state === "expired") return emit({ phase: "expired" });
    if (response.state === "slow_down") intervalMs += 5000;
  }
  return emit({ phase: "cancelled" });
}

function stableError(error: unknown): string {
  const text = String(error);
  for (const code of [
    "offline",
    "invalid_client_id",
    "invalid_device_code",
    "device_flow_disabled",
    "github_device_error",
  ]) {
    if (text.includes(code)) return code;
  }
  return "github_device_error";
}
