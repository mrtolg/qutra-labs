/**
 * Application metadata shown in About/diagnostics.
 * Keep APP_VERSION synchronized with package.json, Cargo.toml, tauri.conf.json
 * and CHANGELOG.md on every release (see docs/RELEASE_CHECKLIST.md).
 */
export const APP_VERSION = "0.1.0";

export const AUTHOR = "Mert Olgun";

/**
 * Real repository URL, configured only when known. Left null so the app
 * never invents a GitHub username/URL; the About "Open repository" action
 * stays disabled until this is set to the user's actual repository.
 */
export const REPO_URL: string | null = null;
