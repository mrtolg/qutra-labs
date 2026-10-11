import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "./ui";

describe("toast lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUi.setState({ toasts: [], liveMessage: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses passive information", () => {
    useUi.getState().toast({ kind: "info", message: "Saved" });
    expect(useUi.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(4_000);

    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it("keeps errors and actionable messages until manual dismissal", () => {
    useUi.getState().toast({ kind: "danger", message: "Failed" });
    useUi.getState().toast({
      kind: "success",
      message: "Removed",
      onAction: () => undefined,
    });

    vi.advanceTimersByTime(60_000);

    expect(useUi.getState().toasts).toHaveLength(2);
  });
});
