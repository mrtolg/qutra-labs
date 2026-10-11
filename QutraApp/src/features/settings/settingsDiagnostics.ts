import { getDb, getStorageKind } from "@/lib/db/database";
import { isTauri } from "@/lib/bridge";
import { APP_VERSION } from "@/lib/appMeta";
import { BUILD_INFO } from "@/lib/buildInfo";
import { CURRENT_SCHEMA_VERSION } from "@/lib/db/migrations";
import { getDiagnosticErrors } from "@/lib/diagnostics";
import { redactForDiagnostics } from "@/domain/privacy";

/** The redacted diagnostics block that Import/export saves and About copies. */
export function diagnosticsText(): string {
  const db = getDb();
  const diag = {
    version: APP_VERSION,
    build: BUILD_INFO,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mode: isTauri() ? "tauri" : "browser",
    storage: getStorageKind(),
    dbSizeBytes: db.estimateSizeBytes(),
    counts: Object.fromEntries(
      (["workspaces", "sessions", "snapshots", "tasks", "events"] as const).map(
        (name) => [name, db.collection(name).getAll().length],
      ),
    ),
    recentErrors: getDiagnosticErrors(),
  };
  return redactForDiagnostics(JSON.stringify(diag, null, 2));
}
