import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ensureLocaleLoaded, translate } from "@/lib/i18n";
import { CloudBadge } from "./CloudParts";

describe("CloudBadge", () => {
  it("says only the conversation goes when nothing personal is set", () => {
    render(<CloudBadge name="Anthropic" />);
    expect(screen.getByTestId("assistant-cloud-badge")).toHaveTextContent(
      "Sends the conversation only · Anthropic",
    );
  });

  it("says memory and instructions go when personal is set", () => {
    render(<CloudBadge name="Anthropic" personal />);
    expect(screen.getByTestId("assistant-cloud-badge")).toHaveTextContent(
      "Sends the conversation, your memory and your instructions · Anthropic",
    );
  });

  it("names the investigation summary as well when linked with personal", async () => {
    await ensureLocaleLoaded("en");
    render(<CloudBadge name="Anthropic" linked personal />);
    expect(screen.getByTestId("assistant-cloud-badge")).toHaveTextContent(
      translate("en", "jarvis.cloud.chipLinkedPersonal", { name: "Anthropic" }),
    );
  });
});
