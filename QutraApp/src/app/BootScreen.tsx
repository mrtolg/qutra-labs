/**
 * Desktop boot / recovery surface shown while SQLite opens.
 * Uses no i18n/db hooks — it may render before the store exists.
 */
export function BootScreen({ error }: { error?: string }) {
  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--surface)",
        color: "var(--ink)",
      }}
      role="status"
      aria-live="polite"
    >
      <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
        <img
          src="/favicon.png"
          alt=""
          aria-hidden
          width={40}
          height={40}
          style={{
            display: "block",
            margin: "0 auto 16px",
            borderRadius: 10,
          }}
        />
        {error ? (
          <>
            <h1 style={{ fontSize: "var(--fs-16)", marginBottom: 8 }}>
              Qutra Labs could not open its local database
            </h1>
            <p
              style={{
                fontSize: "var(--fs-13)",
                color: "var(--muted)",
                marginBottom: 12,
              }}
            >
              Your data is untouched. Restart the app; if this persists, export
              a backup from another device or reinstall.
            </p>
            <pre
              className="mono"
              style={{
                textAlign: "left",
                fontSize: 11,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 12,
                overflow: "auto",
                maxHeight: 160,
              }}
            >
              {error}
            </pre>
          </>
        ) : (
          <p style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>
            Qutra Labs
          </p>
        )}
      </div>
    </div>
  );
}
