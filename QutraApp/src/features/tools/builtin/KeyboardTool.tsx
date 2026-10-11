import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Eraser } from "lucide-react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { Destination, ResultActions } from "./shared";
import { keyEventsText } from "./summaries";

/* Keyboard-event viewer: what the browser reports for each key press while
   this pane has the focus — key, code, location, modifiers. Events live in
   this panel's memory only, at most MAX_EVENTS, and go when it closes.
   Tab and Shift+Tab still move the focus out; other keys are held here so
   that a shortcut shows instead of running. Nothing animates: key
   presses come hundreds at a time. */

const MAX_EVENTS = 40;
const MODIFIERS = ["Control", "Shift", "Alt", "Meta"] as const;
const LOCKS = ["CapsLock", "NumLock"] as const;

export interface KeyRecord {
  type: "keydown" | "keyup";
  key: string;
  code: string;
  location: number;
  repeat: boolean;
  modifiers: string[];
  keyCode: number;
  at: number;
}

const LOCATION_KEYS: Record<number, BuiltinKey> = {
  0: "builtin.keys.location.standard",
  1: "builtin.keys.location.left",
  2: "builtin.keys.location.right",
  3: "builtin.keys.location.numpad",
};

/** What a key cap shows: a space as a word, everything else as reported. */
function capLabel(key: string, t: (k: BuiltinKey) => string): string {
  if (key === " ") return t("builtin.keys.space");
  return key;
}

export function KeyboardTool() {
  const { t } = useT();
  const [events, setEvents] = useState<KeyRecord[]>([]);
  const [held, setHeld] = useState<string[]>([]);
  const [locks, setLocks] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const start = useRef<number | null>(null);
  const hintId = useId();

  const record = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") return;
    // Held here: neither the browser nor the app's own shortcuts (Ctrl+K,
    // Ctrl+,) see it. The area switches (Ctrl+1…4) and the context panel
    // (Ctrl+B) still work, so the app can always be left (useShortcuts).
    event.preventDefault();
    event.stopPropagation();
    const native = event.nativeEvent;
    if (start.current === null) start.current = native.timeStamp;
    const modifiers = MODIFIERS.filter((m) => event.getModifierState(m));
    setHeld(modifiers);
    setLocks(LOCKS.filter((m) => event.getModifierState(m)));
    const entry: KeyRecord = {
      type: event.type === "keyup" ? "keyup" : "keydown",
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      modifiers,
      keyCode: native.keyCode,
      at: Math.round(native.timeStamp - start.current),
    };
    setEvents((list) => [entry, ...list].slice(0, MAX_EVENTS));
  };

  const last = events.find((e) => e.type === "keydown") ?? events[0];
  const clear = () => {
    setEvents([]);
    setHeld([]);
    start.current = null;
  };

  return (
    <div className="bt-tool bt-keys">
      <Destination local />
      <div className="bt-keys__bench">
        <div
          className={`bt-keys__well${focused ? " is-focused" : ""}`}
          tabIndex={0}
          // A read-only field the keys are typed into: focusable and
          // announced as one, which it is.
          role="textbox"
          aria-readonly="true"
          aria-label={t("builtin.keys.well")}
          aria-describedby={hintId}
          data-testid="key-well"
          // The app's shortcut handler steps aside here (useShortcuts).
          data-holds-keys=""
          onKeyDown={record}
          onKeyUp={record}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setHeld([]);
          }}
        >
          {last ? (
            <>
              <span className="bt-keys__cap" data-testid="key-cap">
                {capLabel(last.key, t)}
              </span>
              <span className="bt-keys__code mono">{last.code || "—"}</span>
              <span className="bt-keys__meta">
                {t(LOCATION_KEYS[last.location] ?? "builtin.keys.location.standard")}
                {" · "}
                {t("builtin.keys.keyCode", { code: last.keyCode })}
                {last.repeat && ` · ${t("builtin.keys.repeat")}`}
              </span>
            </>
          ) : (
            <span className="bt-keys__prompt">
              {focused ? t("builtin.keys.pressAny") : t("builtin.keys.clickToStart")}
            </span>
          )}
          <span className="bt-keys__lamps" aria-label={t("builtin.keys.modifiers")}>
            {MODIFIERS.map((m) => (
              <span key={m} className={`bt-lamp${held.includes(m) ? " is-on" : ""}`}>
                {t(`builtin.keys.mod.${m}` as BuiltinKey)}
              </span>
            ))}
            {LOCKS.map((m) => (
              <span key={m} className={`bt-lamp bt-lamp--lock${locks.includes(m) ? " is-on" : ""}`}>
                {t(`builtin.keys.mod.${m}` as BuiltinKey)}
              </span>
            ))}
          </span>
        </div>
        <p id={hintId} className="bt-keys__hint">
          {t("builtin.keys.hint")}
        </p>
      </div>

      <section className="bt-keys__log" aria-label={t("builtin.keys.log")}>
        <header className="bt-section-head">
          <h3>{t("builtin.keys.log")}</h3>
          <span className="bt-count">{t("builtin.keys.count", { count: events.length })}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={clear} disabled={events.length === 0}>
            <Eraser size={13} aria-hidden /> {t("builtin.keys.clear")}
          </button>
        </header>
        {events.length === 0 ? (
          <p className="bt-empty">{t("builtin.keys.empty")}</p>
        ) : (
          <>
            <div className="table-wrap bt-table-wrap">
              <table className="table bt-table">
                <thead>
                  <tr>
                    <th>{t("builtin.keys.col.type")}</th>
                    <th lang="en">key</th>
                    <th lang="en">code</th>
                    <th>{t("builtin.keys.col.location")}</th>
                    <th>{t("builtin.keys.col.modifiers")}</th>
                    <th className="bt-num">{t("builtin.keys.col.time")}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={`${e.at}-${i}`} className={e.type === "keyup" ? "is-up" : undefined}>
                      <td>{e.type === "keydown" ? "↓" : "↑"} {e.type}</td>
                      <td className="mono">{e.key === " " ? "␠" : e.key}</td>
                      <td className="mono">{e.code}</td>
                      <td>{t(LOCATION_KEYS[e.location] ?? "builtin.keys.location.standard")}</td>
                      <td>{e.modifiers.map((m) => t(`builtin.keys.mod.${m}` as BuiltinKey)).join(" + ") || "—"}</td>
                      <td className="bt-num mono">{e.at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ResultActions
              tool="keys"
              target=""
              text={keyEventsText(events)}
              data={events}
              title=""
              saveable={false}
            />
          </>
        )}
      </section>
    </div>
  );
}
