import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ApprovalCard, type PendingApproval } from "./ApprovalCard";

/* The approval card from Rust's facts: the
   intent as a fact template, the exact command, and chips that state only
   what was established. Nothing unassessed is ever shown as passed. */

const base: PendingApproval = {
  requestId: "req-1",
  callId: "call-1",
  summary: "Run in a new terminal session: nmap -sV 10.0.0.5",
  tool: "terminal_run",
  decision: "awaiting",
};

function card() {
  return within(screen.getByTestId("assistant-approval-card"));
}

describe("ApprovalCard", () => {
  it("shows a terminal command as written, with its scope and effects unassessed", () => {
    render(
      <ApprovalCard
        approval={{
          ...base,
          action: { kind: "terminal_run", sessionId: null, command: "nmap -sV 10.0.0.5" },
        }}
        onDecide={() => {}}
      />,
    );
    expect(card().getByText("Run this command in a new terminal.")).toBeInTheDocument();
    expect(card().getByTestId("assistant-approval-summary")).toHaveTextContent(/^nmap -sV 10\.0\.0\.5$/);
    expect(card().getByText("Scope not assessed")).toBeInTheDocument();
    expect(card().getByText("Command effects not classified")).toBeInTheDocument();
    expect(card().queryByText(/in scope/i)).toBeNull();
    expect(card().getByText("turn paused · waiting for you")).toBeInTheDocument();
    expect(card().getByText("Nothing runs until you approve.")).toBeInTheDocument();
  });

  it("shows a verified launch with its registered rating", () => {
    render(
      <ApprovalCard
        approval={{
          ...base,
          tool: "launch_tool",
          action: {
            kind: "launch_tool",
            installationId: "tool-1",
            displayName: "Nmap",
            argsText: "-sV example.com",
            identity: { state: "verified", sha256: "ab".repeat(32), riskTier: "medium" },
          },
        }}
        onDecide={() => {}}
      />,
    );
    expect(card().getByText("Launch Nmap.")).toBeInTheDocument();
    expect(card().getByTestId("assistant-approval-summary")).toHaveTextContent("Nmap -sV example.com");
    expect(card().getByText("Verified · SHA-256")).toHaveAttribute("title", `SHA-256 ${"ab".repeat(32)}`);
    expect(card().getByText("Registered rating: Medium")).toBeInTheDocument();
    expect(card().getByRole("button", { name: "Approve & run" })).toBeInTheDocument();
  });

  it("offers only Reject for a launch the identity gate refused, and says why", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        approval={{
          ...base,
          tool: "launch_tool",
          action: {
            kind: "launch_tool",
            installationId: "tool-1",
            displayName: null,
            argsText: "",
            identity: { state: "blocked", reason: "tool_identity_changed" },
          },
        }}
        onDecide={onDecide}
      />,
    );
    expect(card().getByText("Cannot run")).toBeInTheDocument();
    expect(card().getByText(/identity changed since it was last verified/)).toBeInTheDocument();
    expect(card().queryByRole("button", { name: "Approve & run" })).toBeNull();
    card().getByRole("button", { name: "Reject" }).click();
    expect(onDecide).toHaveBeenCalledWith(false);
  });

  it("falls back to the summary sentence when no facts came", () => {
    render(<ApprovalCard approval={base} onDecide={() => {}} />);
    expect(card().getByTestId("assistant-approval-summary")).toHaveTextContent(base.summary);
    expect(card().queryByText("Scope not assessed")).toBeNull();
  });
});
