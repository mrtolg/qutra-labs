import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUi } from "@/state/ui";
import { Toasts } from "./Toasts";

describe("Toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUi.setState({ toasts: [], liveMessage: "" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const archive = (name: string) =>
    useUi.getState().toast({
      kind: "success",
      messageKey: "lab.list.archived",
      params: { name },
      actionKey: "action.undo",
      onAction: () => undefined,
    });

  it("removes an undo toast on its own", () => {
    render(<Toasts />);
    act(() => archive("Alpha"));
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(7_100);
    });
    expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument();
  });

  it("keeps a toast while the pointer is over it", () => {
    render(<Toasts />);
    act(() => archive("Alpha"));
    const toast = screen.getByText(/Alpha/).closest(".toast")!;

    fireEvent.pointerEnter(toast);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();

    fireEvent.pointerLeave(toast);
    act(() => {
      vi.advanceTimersByTime(7_100);
    });
    expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument();
  });

  it("keeps a toast while its button has focus", () => {
    render(<Toasts />);
    act(() => archive("Alpha"));
    const undo = screen.getAllByRole("button")[0]!;

    fireEvent.focus(undo);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
  });

  it("stacks no more than three and counts repeats", () => {
    render(<Toasts />);
    act(() => {
      for (const name of ["A1", "A2", "A3", "A4"]) archive(name);
      archive("A4");
      archive("A4");
    });
    expect(document.querySelectorAll(".toast")).toHaveLength(3);
    expect(screen.queryByText(/A1/)).not.toBeInTheDocument();
    expect(screen.getByTestId("toast-count")).toHaveTextContent("×3");
  });
});
