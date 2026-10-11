/** The Private Lab grant from Terminal / Lab / Tools.

    One preference: native tools and the interactive terminal. It does not
    enable the assistant and does not write `assistantAgentToolsEnabled`.
    ADR 0012 Decision 1b: Private Lab consent was given so the user could
    drive native tools, not so a language model could propose them. */

export const PRIVATE_LAB_GRANT = {
  privateToolsEnabled: true,
} as const;

export function applyPrivateLabGrant<
  T extends { assistantAgentToolsEnabled: boolean; localAssistantEnabled: boolean },
>(prefs: T): T & typeof PRIVATE_LAB_GRANT {
  return { ...prefs, ...PRIVATE_LAB_GRANT };
}
