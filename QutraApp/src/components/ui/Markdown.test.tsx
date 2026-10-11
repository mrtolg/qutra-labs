import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown (the parser always advances)", () => {
  it("renders a bare # line and a #word line as text instead of looping", () => {
    const { container } = render(<Markdown source={"#\n#tag\nafter"} />);
    expect(container.textContent).toContain("#");
    expect(container.textContent).toContain("#tag");
    expect(container.textContent).toContain("after");
  });

  it("still renders a real heading", () => {
    const { container } = render(<Markdown source={"# Title\nbody"} />);
    expect(container.querySelector("h2")?.textContent).toBe("Title");
  });
});
