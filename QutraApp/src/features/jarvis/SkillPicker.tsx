import { useRef } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { SKILLS, skillById, type SkillId } from "./skills";
import { useDetailsDismiss } from "./useDetailsDismiss";

/**
 * The composer's skills: pick one and it goes with the next question only.
 * The picked one stays visible as a chip that takes it off again. Works the
 * same on this computer and through a cloud connection.
 */
export function SkillPicker({
  value,
  onChange,
}: {
  value: SkillId | null;
  onChange: (id: SkillId | null) => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(ref);
  const chosen = skillById(value);
  const chosenName = chosen ? t(`skills.${chosen.id}.name`) : "";

  return (
    <>
      {chosen && (
        <span className="asst-chip asst-chip--live" data-testid="skill-chip">
          <Sparkles size={12} aria-hidden />
          <span className="asst-chip__text">{t("skills.attached", { name: chosenName })}</span>
          <button
            type="button"
            className="asst-chip__x"
            aria-label={t("skills.remove", { name: chosenName })}
            onClick={() => onChange(null)}
          >
            <X size={11} aria-hidden />
          </button>
        </span>
      )}
      <details ref={ref} className="asst-context asst-skills" data-testid="skill-picker">
        <summary className="asst-chip asst-chip--btn">
          <Sparkles size={12} aria-hidden />
          {t("skills.title")}
        </summary>
        <div className="asst-context__pop asst-skills__pop">
          <p className="asst-small faint">{t("skills.hint")}</p>
          <ul className="asst-skills__list">
            {SKILLS.map((skill) => {
              const selected = skill.id === value;
              return (
                <li key={skill.id}>
                  <button
                    type="button"
                    className={selected ? "asst-skill is-selected" : "asst-skill"}
                    aria-pressed={selected}
                    data-skill={skill.id}
                    onClick={() => {
                      onChange(selected ? null : skill.id);
                      if (ref.current) ref.current.open = false;
                    }}
                  >
                    <span className="asst-skill__name">
                      {t(`skills.${skill.id}.name`)}
                      {selected && <Check size={12} aria-hidden />}
                    </span>
                    <span className="asst-skill__desc">{t(`skills.${skill.id}.desc`)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
    </>
  );
}
