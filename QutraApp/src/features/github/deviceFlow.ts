/* GitHub OAuth Device Flow (RFC 8628, as GitHub implements it).
   Pure/injectable so the whole state machine is unit-tested with a mocked
   fetch and sleep — never a real token. See docs/decisions/0006-github.md. */

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export type PollOutcome =
  | { kind: "authorized"; token: string; scope: string }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; detail: string };

export type DeviceFlowState =
  | { phase: "requesting" }
  | { phase: "awaiting"; code: DeviceCode }
  | { phase: "authorized"; token: string; scope: string }
  | { phase: "denied" }
  | { phase: "expired" }
  | { phase: "cancelled" }
  | { phase: "error"; detail: string };

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

interface Deps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  clientId: string;
  scope: string;
  signal?: { aborted: boolean };
  onState?: (s: DeviceFlowState) => void;
}

/** Parse GitHub's token-poll JSON into a discrete outcome. Redacts unknowns —
 *  a raw token only ever appears in the `authorized` branch. */
export function parsePollResponse(json: Record<string, unknown>): PollOutcome {
  if (typeof json.access_token === "string" && json.access_token) {
    return {
      kind: "authorized",
      token: json.access_token,
      scope: typeof json.scope === "string" ? json.scope : "",
    };
  }
  const err = typeof json.error === "string" ? json.error : "unknown_error";
  switch (err) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default:
      return { kind: "error", detail: err };
  }
}

export function parseDeviceCode(json: Record<string, unknown>): DeviceCode | null {
  if (typeof json.device_code !== "string" || typeof json.user_code !== "string") {
    return null;
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri:
      typeof json.verification_uri === "string"
        ? json.verification_uri
        : "https://github.com/login/device",
    expiresInSec: typeof json.expires_in === "number" ? json.expires_in : 900,
    intervalSec: typeof json.interval === "number" ? json.interval : 5,
  };
}

/**
 * Run the full device flow. Polls at the server-provided interval, honoring
 * slow_down (interval += 5s), pending, denial, expiry, and cancellation.
 * Never busy-polls. Returns the terminal state.
 */
export async function runDeviceFlow(deps: Deps): Promise<DeviceFlowState> {
  const emit = (s: DeviceFlowState) => {
    deps.onState?.(s);
    return s;
  };
  const cancelled = () => deps.signal?.aborted === true;

  emit({ phase: "requesting" });
  let codeRes: Response;
  try {
    codeRes = await deps.fetchImpl(DEVICE_CODE_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: deps.clientId, scope: deps.scope }),
    });
  } catch {
    return emit({ phase: "error", detail: "network" });
  }
  const code = parseDeviceCode((await codeRes.json()) as Record<string, unknown>);
  if (!code) return emit({ phase: "error", detail: "bad_device_code" });
  emit({ phase: "awaiting", code });

  let intervalMs = code.intervalSec * 1000;
  const deadline = Date.now() + code.expiresInSec * 1000;

  while (!cancelled()) {
    await deps.sleep(intervalMs);
    if (cancelled()) break;
    if (Date.now() >= deadline) return emit({ phase: "expired" });

    let pollRes: Response;
    try {
      pollRes = await deps.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: deps.clientId,
          device_code: code.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch {
      // Transient network error — keep waiting rather than failing hard.
      continue;
    }
    const outcome = parsePollResponse((await pollRes.json()) as Record<string, unknown>);
    switch (outcome.kind) {
      case "authorized":
        return emit({ phase: "authorized", token: outcome.token, scope: outcome.scope });
      case "pending":
        break;
      case "slow_down":
        intervalMs += 5000;
        break;
      case "denied":
        return emit({ phase: "denied" });
      case "expired":
        return emit({ phase: "expired" });
      case "error":
        return emit({ phase: "error", detail: outcome.detail });
    }
  }
  return emit({ phase: "cancelled" });
}
