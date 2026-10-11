import { useId } from "react";
import { bindableLauncherItems } from "@/domain/tools/launcher";
import { useT } from "@/lib/i18n";

/** Which catalog item a native installation is. The user picks it; nothing
    here matches by name. "" means not in the catalog. */
export function CatalogBindingSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (catalogId: string) => void;
  className?: string;
}) {
  const { t } = useT();
  const selectId = useId();
  const hintId = useId();
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={selectId}>{t("lab.tools.catalogEntry")}</label>
      <select
        id={selectId}
        className="select"
        value={value}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("lab.tools.catalogNone")}</option>
        {bindableLauncherItems().map((item) => (
          <option key={item.catalogId} value={item.catalogId}>
            {item.name}
          </option>
        ))}
      </select>
      <small id={hintId} className="field-hint">
        {t("lab.tools.catalogHint")}
      </small>
    </div>
  );
}
