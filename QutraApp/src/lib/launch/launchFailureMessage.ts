import type { MessageKey } from "@/lib/i18n/en";

/** Maps a native launch refusal reason to translated, user-facing copy.
    Shared by the *tool*-launch routes -- the detached GUI route
    (`ToolLabPanel`'s `launchDetached` call) and the interactive terminal
    route's tool tabs (`TerminalTab`, via `terminal_open_tool`) -- since both
    resolve through `ToolSupervisor::resolve_launchable` and so can produce
    the same set of refusal codes. Shell tabs never call this: a shell PTY
    failure has no installation or tool identity to describe, so `TerminalTab`
    renders that raw diagnostic itself instead of routing it through here.
    `reason` is a stable code string from Rust (`tool_disabled`,
    `tool_identity_changed`, ...), `"browser_mode"`, or an unrecognized value
    -- most commonly the dynamic `spawn:<os error>` message. Known reasons
    get dedicated copy; anything else falls back to a generic, still-
    translated message rather than ever showing the raw code (a user must
    never see `tool_identity_changed` in a callout). The fallback is a
    visible message, not a swallowed failure.

    `"browser_mode"` specifically comes from `browserBridge.ts`'s
    `launchDetached` stub (`{ ok: false, reason: "browser_mode" }`), reached
    only via the gui route. It is NOT reachable via the terminal route: the
    terminal browser stub (`createBrowserTerminal` in `bridge/terminal.ts`)
    rejects with `Error("terminal_unavailable:browser_mode")`, a different
    string that falls through to the generic `default` case above, not this
    one. Do not read this case as evidence the terminal route ever hits it. */
export function launchFailureMessage(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  reason: string | undefined,
  name: string,
): string {
  const params = { name };
  switch (reason) {
    case "browser_mode":
      return t("lab.tools.launchUnavailable");
    case "private_tools_consent_required":
      return t("lab.tools.launchReasonConsentRequired", params);
    case "tool_not_found":
      return t("lab.tools.launchReasonNotFound", params);
    case "tool_disabled":
      return t("lab.tools.launchReasonDisabled", params);
    case "tool_identity_changed":
      return t("lab.tools.launchReasonIdentityChanged", params);
    case "tool_path_missing":
      return t("lab.tools.launchReasonPathMissing", params);
    case "working_directory_missing":
      return t("lab.tools.launchReasonWorkingDirMissing", params);
    case "working_directory_not_folder":
      return t("lab.tools.launchReasonWorkingDirNotFolder", params);
    case "elevation_required":
      return t("lab.tools.launchReasonElevationRequired", params);
    default:
      return t("lab.tools.launchFailedGeneric", params);
  }
}
