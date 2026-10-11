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

  it("keeps errors until manual dismissal", () => {
    useUi.getState().toast({ kind: "danger", message: "Failed" });

    vi.advanceTimersByTime(60_000);

    expect(useUi.getState().toasts).toHaveLength(1);
  });

  it("lets an undo toast go after a few seconds", () => {
    useUi.getState().toast({
      kind: "success",
      message: "Archived",
      actionKey: "action.undo",
      onAction: () => undefined,
    });

    vi.advanceTimersByTime(6_000);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it("holds the countdown while a toast is hovered or focused", () => {
    useUi.getState().toast({ kind: "success", message: "Archived", onAction: () => undefined });
    const { id } = useUi.getState().toasts[0]!;

    vi.advanceTimersByTime(5_000);
    useUi.getState().pauseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(useUi.getState().toasts).toHaveLength(1);

    useUi.getState().resumeToast(id);
    vi.advanceTimersByTime(1_900);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it("shows at most three toasts, the oldest giving way", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      useUi.getState().toast({ kind: "danger", message: `Failed ${n}` });
    }
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([
      "Failed 3",
      "Failed 4",
      "Failed 5",
    ]);
  });

  it("collapses a repeated message into one toast with a count", () => {
    for (let i = 0; i < 24; i++) {
      useUi.getState().toast({
        kind: "success",
        messageKey: "lab.list.archived",
        params: { name: "Yeni inceleme" },
        actionKey: "action.undo",
        onAction: () => undefined,
      });
    }
    const toasts = useUi.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.count).toBe(24);

    vi.advanceTimersByTime(7_100);
    expect(useUi.getState().toasts).toHaveLength(0);
  });
});
