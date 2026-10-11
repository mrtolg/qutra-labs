# Release Checklist

Follow these steps to cut a Qutra Labs release.

## 1. Version bump (keep all in sync)

- [ ] `package.json` → `version`
- [ ] `src-tauri/Cargo.toml` → `version`
- [ ] `src-tauri/tauri.conf.json` → `version`
- [ ] `src/lib/appMeta.ts` → `APP_VERSION`
- [ ] `CHANGELOG.md` → move `[Unreleased]` items under a new dated version

## 2. Verify

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e`
- [ ] `cargo fmt --check` (in `src-tauri/`)
- [ ] `cargo clippy --all-targets --all-features -- -D warnings`
- [ ] `cargo test`
- [ ] `npm run tauri build`

> On a non-ASCII checkout path, build via an ASCII directory junction and the
> `TAURI_CONFIG` icon override (see CONTRIBUTING.md and `scripts/msvc-env.ps1`).

## 3. Installer verification

- [ ] Launch the generated release `.exe` (not `tauri dev`); confirm the window
      renders with no dev server.
- [ ] Complete onboarding, create/edit data, restart the app, confirm the data
      persisted (SQLite at `%APPDATA%\app.contextos.desktop\contextos.db`).
- [ ] Exercise one real native capability (e.g. snapshot capture enumerates
      real windows) and confirm unsupported capabilities are reported honestly.
- [ ] Switch through all six languages and both themes.
- [ ] Inspect the icon in the window, taskbar, executable and installer.
- [ ] Install with the NSIS installer, launch the installed app, verify
      uninstall behavior.

## 4. Signing (optional)

- [ ] If signing, sign with a real Authenticode certificate and verify with
      `signtool verify /pa`. Never claim the binary is signed otherwise.

## 5. Publish

- [ ] Generate `SHA256SUMS.txt` from the final artifacts.
- [ ] Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
- [ ] The `release.yml` workflow builds and drafts a GitHub Release; attach the
      installer, verify hashes, then publish.
