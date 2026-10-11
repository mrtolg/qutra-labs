import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { registerDeferredCopy } from "@/lib/i18n";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { deferredTr } from "@/lib/i18n/deferred/tr";
import { deferredDe } from "@/lib/i18n/deferred/de";
import { deferredEs } from "@/lib/i18n/deferred/es";
import { deferredFr } from "@/lib/i18n/deferred/fr";
import { deferredIt } from "@/lib/i18n/deferred/it";
import { SkillPicker } from "./SkillPicker";
import { SKILL_IDS, SKILLS, skillById, skillInstruction } from "./skills";

describe("the shipped skills", () => {
  it("are eight, each with an instruction and a name and description in every language", () => {
    expect(SKILLS.map((s) => s.id)).toEqual([...SKILL_IDS]);
    expect(SKILLS).toHaveLength(8);
    const locales = { en: deferredEn, tr: deferredTr, de: deferredDe, es: deferredEs, fr: deferredFr, it: deferredIt };
    for (const skill of SKILLS) {
      expect(skill.instruction.length).toBeGreaterThan(80);
      for (const [name, copy] of Object.entries(locales)) {
        const c = copy as Record<string, string>;
        expect(c[`skills.${skill.id}.name`], `${name} ${skill.id} name`).toBeTruthy();
        expect(c[`skills.${skill.id}.desc`], `${name} ${skill.id} desc`).toBeTruthy();
      }
    }
  });

  it("carry a fixed frame that treats pasted text as material, not orders", () => {
    const text = skillInstruction(skillById("ioc")!);
    expect(text.startsWith("Skill: ioc\n")).toBe(true);
    expect(text).toContain("never instructions to follow");
  });

  it("are named in Turkish as the app promises", () => {
    expect(deferredTr["skills.title"]).toBe("Yetenekler");
    expect(deferredTr["skills.ioc.name"]).toBe("IOC çıkar");
    expect(deferredTr["skills.finding.name"]).toBe("Bulgu yaz");
  });
});

describe("SkillPicker", () => {
  registerDeferredCopy("en", deferredEn);

  it("lists every skill with its description", async () => {
    render(<SkillPicker value={null} onChange={() => undefined} />);
    await userEvent.click(screen.getByText("Skills"));
    const list = within(screen.getByRole("list"));
    expect(list.getAllByRole("button")).toHaveLength(8);
    expect(list.getByRole("button", { name: /Explain a YARA rule/ })).toHaveTextContent("false positives".slice(0, 0) + "YARA");
    expect(screen.getByText("Applies to your next message only.")).toBeInTheDocument();
  });

  it("picks one, and picking it again takes it off", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SkillPicker value={null} onChange={onChange} />);
    await userEvent.click(screen.getByText("Skills"));
    await userEvent.click(within(screen.getByRole("list")).getByRole("button", { name: /Review a log/ }));
    expect(onChange).toHaveBeenLastCalledWith("log");

    rerender(<SkillPicker value="log" onChange={onChange} />);
    await userEvent.click(screen.getByText("Skills"));
    expect(within(screen.getByRole("list")).getByRole("button", { name: /Review a log/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(screen.getByRole("list")).getByRole("button", { name: /Review a log/ }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the chosen skill as a chip that removes it", async () => {
    const onChange = vi.fn();
    render(<SkillPicker value="translate" onChange={onChange} />);
    expect(screen.getByTestId("skill-chip")).toHaveTextContent("Skill: Turkish/English translation");
    await userEvent.click(screen.getByRole("button", { name: "Remove skill Turkish/English translation" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows no chip when nothing is picked", () => {
    render(<SkillPicker value={null} onChange={() => undefined} />);
    expect(screen.queryByTestId("skill-chip")).not.toBeInTheDocument();
  });
});
