import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Markdown, { parseMarkdown } from "./Markdown";

/* Qutra's answers are Markdown. Rendering stays
   inert -- markup, link schemes and images in an answer cannot act -- and
   code is shown and copied exactly as written. */

describe("Markdown in an answer", () => {
  it("renders the board's answer: prose, inline code, a list and a code block", () => {
    const { container } = render(
      <Markdown
        text={[
          "Good — that host is inside your validated scope, so I can reach it.",
          "",
          "- Top 200 TCP ports, service + version detection",
          "- Skip host discovery (`-Pn`)",
          "",
          "Here's the exact command I'd run:",
          "",
          "```pwsh",
          "nmap -sV -Pn --top-ports 200 192.168.56.101",
          "```",
        ].join("\n")}
      />,
    );

    expect(screen.getByText(/inside your validated scope/)).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("-Pn").tagName).toBe("CODE");
    expect(screen.getByText("pwsh")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent(
      "nmap -sV -Pn --top-ports 200 192.168.56.101",
    );
    expect(screen.getByRole("button", { name: "Copy the pwsh code" })).toBeInTheDocument();
  });

  it("keeps HTML as text and never makes an element from it", () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="window.__md=1"> and <script>alert(1)</script>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="window.__md=1">');
    expect((window as unknown as { __md?: number }).__md).toBeUndefined();
  });

  it("shows a link's address and makes nothing followable", () => {
    const { container } = render(
      <Markdown
        text={
          "[docs](https://nmap.org/book/) [click me](javascript:alert(1)) ![logo](https://example.com/x.png)"
        }
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("docs (https://nmap.org/book/)");
    expect(container).toHaveTextContent("click me (javascript:alert(1))");
    // An image is never fetched; its description stands in for it.
    expect(container).toHaveTextContent("logo");
  });

  it("shows an unclosed code fence as code, as a streaming answer has it", () => {
    const blocks = parseMarkdown("Running:\n```bash\nnmap -sV 10.0.0.5\nwhoami");
    expect(blocks.at(-1)).toEqual({ k: "code", lang: "bash", text: "nmap -sV 10.0.0.5\nwhoami" });
  });

  it("nests lists, numbers ordered ones and keeps emphasis inside words literal", () => {
    const { container } = render(
      <Markdown text={"3. first\n   - inner **bold**\n4. second\n\nsnake_case_name stays"} />,
    );
    const ol = container.querySelector("ol");
    expect(ol).toHaveAttribute("start", "3");
    expect(ol?.querySelector("ul li strong")).toHaveTextContent("bold");
    expect(container).toHaveTextContent("snake_case_name stays");
    expect(container.querySelector("em")).toBeNull();
  });

  it("renders a table", () => {
    const { container } = render(
      <Markdown text={"| Port | Service |\n|---:|---|\n| 22 | ssh |\n| 445 | smb |"} />,
    );
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("td")).toHaveStyle({ textAlign: "right" });
  });

  it("survives deep and huge input", () => {
    const deep = ">".repeat(500) + " x";
    expect(() => render(<Markdown text={deep} />)).not.toThrow();
    const huge = "x".repeat(250_000);
    const { container } = render(<Markdown text={huge} />);
    expect(container.querySelector(".md-plain")).not.toBeNull();
  });
});
