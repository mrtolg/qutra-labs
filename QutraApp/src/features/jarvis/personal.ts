import type { JarvisMemory } from "@/domain/conversations";
import type { Preferences } from "@/domain/types";
import type { useT } from "@/lib/i18n";

type Translate = ReturnType<typeof useT>["t"];

/* What Jarvis knows about the user and how they want answers:
   memory entries, "about you", instructions and the response
   style, as one block. A local turn sends it as a system message on this
   computer; a cloud conversation's first question carries it, masked with
   the question and counted in the sent line. */

export type PersonalPrefs = Pick<
  Preferences,
  "jarvisMemoryEnabled" | "jarvisAboutYou" | "jarvisInstructions" | "jarvisResponseStyle"
>;

/** The block, or "" when there is nothing to say. */
export function personalBlock(
  t: Translate,
  prefs: PersonalPrefs,
  memories: readonly Pick<JarvisMemory, "text" | "createdAt">[],
): string {
  const parts: string[] = [];
  const about = prefs.jarvisAboutYou.trim();
  const instructions = prefs.jarvisInstructions.trim();
  if (about) parts.push(`${t("jarvis.personal.block.about")}\n${about}`);
  if (instructions) parts.push(`${t("jarvis.personal.block.instructions")}\n${instructions}`);
  if (prefs.jarvisResponseStyle !== "balanced") {
    parts.push(t(`jarvis.personal.block.style.${prefs.jarvisResponseStyle}`));
  }
  if (prefs.jarvisMemoryEnabled && memories.length > 0) {
    const lines = [...memories]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => `- ${m.text}`)
      .join("\n");
    parts.push(`${t("jarvis.personal.block.memory")}\n${lines}`);
  }
  if (parts.length === 0) return "";
  return [t("jarvis.personal.block.title"), ...parts].join("\n\n");
}
