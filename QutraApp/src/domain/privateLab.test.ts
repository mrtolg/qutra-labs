import { describe, expect, it } from "vitest";
import { applyPrivateLabGrant, PRIVATE_LAB_GRANT } from "./privateLab";

describe("applyPrivateLabGrant", () => {
  it("turns on Private Lab without touching the assistant or the agent", () => {
    const next = applyPrivateLabGrant({
      privateToolsEnabled: false,
      localAssistantEnabled: false,
      assistantAgentToolsEnabled: false,
    });
    expect(next.privateToolsEnabled).toBe(true);
    expect(next.localAssistantEnabled).toBe(false);
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect("localAssistantEnabled" in PRIVATE_LAB_GRANT).toBe(false);
    expect("assistantAgentToolsEnabled" in PRIVATE_LAB_GRANT).toBe(false);
  });

  it("does not treat an existing Private Lab profile as agent consent", () => {
    const next = applyPrivateLabGrant({
      privateToolsEnabled: true,
      localAssistantEnabled: true,
      assistantAgentToolsEnabled: false,
    });
    expect(next.assistantAgentToolsEnabled).toBe(false);
    expect(next.localAssistantEnabled).toBe(true);
  });

  it("does not strip a user who already opted into the agent", () => {
    const next = applyPrivateLabGrant({
      privateToolsEnabled: true,
      localAssistantEnabled: true,
      assistantAgentToolsEnabled: true,
    });
    expect(next.assistantAgentToolsEnabled).toBe(true);
  });
});
