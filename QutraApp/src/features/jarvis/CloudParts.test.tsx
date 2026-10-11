import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CloudAnswerMeta, CloudBadge, type CloudFacts } from "./CloudParts";

/* An answer says which connection it went to, by name and host. */

const facts = (overrides: Partial<CloudFacts>): CloudFacts => ({
  endpoint: "llm.example.net",
  masked: 0,
  servedBy: "model-a",
  fallbackFrom: null,
  sentBytes: 1024,
  stop: "end_turn",
  refusalCategory: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  ...overrides,
});

const line = () => screen.getByTestId("assistant-cloud-meta");

describe("CloudAnswerMeta", () => {
  it("names a preset connection and its host", () => {
    render(<CloudAnswerMeta cloud={facts({ provider: "groq", endpoint: "api.groq.com" })} />);
    expect(line()).toHaveTextContent("Answered by model-a · Sent: Groq · api.groq.com · 1 KB");
  });

  it("names a custom address by its host", () => {
    render(<CloudAnswerMeta cloud={facts({ provider: "custom" })} />);
    expect(line()).toHaveTextContent("Sent: OpenAI-compatible · llm.example.net · 1 KB");
  });

  it("says how many secrets were masked", () => {
    render(<CloudAnswerMeta cloud={facts({ provider: "anthropic", masked: 2 })} />);
    expect(line()).toHaveTextContent(
      "Sent: Claude (Anthropic) · llm.example.net · 1 KB · 2 secret(s) masked",
    );
  });

  it("keeps the host line for an answer saved before the provider was kept", () => {
    render(<CloudAnswerMeta cloud={facts({})} />);
    expect(line()).toHaveTextContent("Sent: llm.example.net · 1 KB");
  });
});

describe("CloudBadge", () => {
  const badge = () => screen.getByTestId("assistant-cloud-badge");

  it("says only the conversation goes when there is nothing else", () => {
    render(<CloudBadge name="Groq" />);
    expect(badge()).toHaveTextContent("Sends the conversation only · Groq");
  });

  it("says the memory and instructions go too when the first question carries them", () => {
    render(<CloudBadge name="Groq" personal />);
    expect(badge()).toHaveTextContent(
      "Sends the conversation, your memory and your instructions · Groq",
    );
    expect(badge()).not.toHaveTextContent("only");
  });

  it("names the investigation summary and the personal block together", () => {
    render(<CloudBadge name="Groq" linked personal />);
    expect(badge()).toHaveTextContent(
      "Sends the conversation, your memory and your instructions and, once you allow it, the investigation summary · Groq",
    );
    render(<CloudBadge name="Groq" linked />);
    expect(screen.getAllByTestId("assistant-cloud-badge")[1]).toHaveTextContent(
      "Sends the conversation and, once you allow it, the investigation summary · Groq",
    );
  });
});
