import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { translate, type Locale } from "@/lib/i18n";
import { getDb } from "@/lib/db/database";
import { recordDiagnosticError } from "@/lib/diagnostics";
import { redactForDiagnostics } from "@/domain/privacy";

interface Props {
  children: ReactNode;
  /**
   * `page` (default) is the full-height fallback for routed content.
   *
   * `panel` is for the surrounding shell regions — sidebar, inspector, bottom
   * panel, tab strip. Each gets its own boundary so a crash in one piece of
   * chrome degrades to a small recoverable placeholder instead of unmounting
   * the entire app, which is what happened while `<Outlet/>` was the only
   * thing wrapped. A page-sized fallback would not fit a 240px rail, so the
   * panel variant stays compact.
   */
  variant?: "page" | "panel";
  /** Runs when this boundary catches. Used to invalidate retained owners
   * so Try again cannot silently relaunch a registered tool. */
  onError?: (error: Error) => void;
}
interface State {
  error: Error | null;
  showDetails: boolean;
}

/** Route-level error boundary: plain language, expandable diagnostics. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    recordDiagnosticError(error, `react:${this.props.variant ?? "page"}`);
    try {
      this.props.onError?.(error);
    } catch {
      /* owner cleanup must not replace the fallback */
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    let locale: Locale = "en";
    try {
      locale = getDb().prefs.get().locale as Locale;
    } catch {
      /* db unavailable — fall back to en */
    }
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const details = redactForDiagnostics(
      `${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack ?? ""}`,
    );

    if (this.props.variant === "panel") {
      return (
        <div
          role="alert"
          data-testid="shell-region-error"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "var(--sp-2)",
            padding: "var(--sp-3)",
            minWidth: 0,
            overflow: "hidden",
            color: "var(--muted)",
            fontSize: "var(--fs-12)",
          }}
        >
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />
          <span>{t("error.routeTitle")}</span>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => this.setState({ error: null })}
          >
            {t("action.tryAgain")}
          </button>
        </div>
      );
    }

    return (
      <div className="empty" role="alert" style={{ height: "100%" }}>
        <AlertTriangle size={28} strokeWidth={1.5} aria-hidden />
        <div className="empty-title">{t("error.routeTitle")}</div>
        <p>{t("error.routeBody")}</p>
        <div className="flex">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => this.setState({ error: null })}
          >
            {t("action.tryAgain")}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() =>
              this.setState((s) => ({ showDetails: !s.showDetails }))
            }
          >
            {t("error.details")}
          </button>
        </div>
        {this.state.showDetails && (
          <div style={{ maxWidth: 560, width: "100%" }}>
            <pre
              className="mono"
              style={{
                textAlign: "left",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-2)",
                padding: "var(--sp-3)",
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {details}
            </pre>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              style={{ marginTop: 8 }}
              onClick={() => navigator.clipboard?.writeText(details)}
            >
              {t("error.copyDetails")}
            </button>
          </div>
        )}
      </div>
    );
  }
}
