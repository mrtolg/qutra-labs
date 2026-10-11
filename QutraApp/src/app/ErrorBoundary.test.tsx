import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("retained owner died");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary onError", () => {
  it("notifies its parent so it can invalidate, not silently retry the same records", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
