# Security note — GHSA-qwww-vcr4-c8h2 (react-router RSC CSRF bypass)

**Date:** 2026-07-27
**Status:** Assessed — not applicable to Qutra Labs. Not remediated by upgrade. Re-evaluation triggers below.
**Advisory:** <https://github.com/advisories/GHSA-qwww-vcr4-c8h2>

`npm audit --omit=dev` reports 2 high-severity findings. This note records why
they are not being closed by an upgrade, so the result is a deliberate decision
with an expiry condition rather than a warning someone learned to ignore.

## What audit reports

```
react-router  7.12.0 - 8.2.0
Severity: high
React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response
node_modules/react-router
  react-router-dom  >=7.12.0-pre.0
2 high severity vulnerabilities
```

Installed: `react-router` **7.18.1** (via `react-router-dom ^7.6.0`).

## Why it does not apply here

The advisory states the flaw **only affects applications using the unstable RSC
(React Server Components) APIs**. The CSRF bypass lets a forged cross-origin
request reach a server action before the request is rejected with a 400 — which
requires a server processing actions.

Qutra Labs has none of that surface:

| Precondition for the advisory | Qutra Labs |
|---|---|
| Uses unstable RSC APIs | No — 0 matches for `unstable_RSC`, `routeRSCServerRequest`, `createCallServer`, `@vitejs/plugin-rsc` across `src/` and `package.json` |
| Server handling actions | No — the app is a local-first Tauri desktop app; there is no Qutra Labs server and no action endpoint |
| Browser router / server-driven navigation | No — `src/app/router.tsx:48` uses `createHashRouter`, client-only |
| Cross-origin requests reaching a router action | No — the webview loads local assets under a restrictive CSP |

There is no code path in this product that can reach the vulnerable behaviour.

## Why we are not upgrading (yet)

The advisory is fixed in **react-router 8.3.0**. That is not a patch bump:

- `react-router-dom` has **no 8.x release at all** (latest is 7.18.1); v8 folds it
  into `react-router`. Upgrading therefore means removing the `react-router-dom`
  dependency and rewriting its imports in **24 files**.
- That is a breaking, cross-cutting refactor of the entire routing layer, taken
  on to fix a vulnerability that provably cannot be triggered in this app.

During a phase whose purpose is to stabilise the release gates, a 24-file
routing migration carries materially more risk of introducing a real defect than
the advisory carries of causing one. The migration is worth doing on its own
merits — it is simply not a security remediation, and should not be smuggled in
as one.

**This is a deferral, not a dismissal.** It is recorded here, not silenced with
an audit override, so `npm audit` keeps reporting it.

## Re-evaluate immediately if any of these change

- Qutra Labs adopts React Server Components or any `unstable_` RSC API.
- Qutra Labs gains a server component, action endpoint, or any non-`createHashRouter` router.
- The advisory is amended to cover non-RSC usage, or a new react-router advisory lands that is not RSC-scoped.
- The routing layer is migrated to v8 for product reasons — take the fix then.

## Reproduce this assessment

```bash
npm audit --omit=dev                 # shows the 2 high findings
node -p "require('./node_modules/react-router/package.json').version"   # 7.18.1
npm view react-router-dom version    # 7.18.1 — confirms no 8.x line
grep -rn "createHashRouter" src/app/router.tsx
grep -rn "unstable_RSC\|routeRSCServerRequest\|createCallServer" src/ package.json   # no matches
```
