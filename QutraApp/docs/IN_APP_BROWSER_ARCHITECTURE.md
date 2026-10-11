# Qutra Labs In-App Browser Architecture

Status: researched design, not yet implemented  
Target: Windows-first packaged Tauri 2 desktop app  
Decision owner: Qutra Labs

## Decision

Build the browser as a native child webview hosted inside the existing
Qutra Labs window. Do not use an HTML `iframe`, and do not load arbitrary
remote pages into the main application webview.

The app chrome (tabs, address bar, navigation controls, privacy state) stays
in the trusted React webview. The page itself runs in a separate WebView2
child created by Tauri. Its label must never match a Tauri capability that
grants application commands.

This is the practical route because many useful sites block framing with CSP
or `X-Frame-Options`, while Tauri 2 already supports child webviews with
position, size, show, hide, zoom, incognito and isolated data-directory
controls.

## Product Shape

The browser is a research surface inside the workbench, not a replacement for
Edge or Firefox.

MVP:

- Address/search field with explicit HTTPS normalization.
- Back, forward, reload, stop and open-in-default-browser commands.
- One visible browser surface with Qutra Labs-managed tabs.
- Page title, URL, loading state and security-origin indicator.
- Bookmarks and local history stored as metadata.
- "Save to workspace" captures URL, title and a user note only.
- Private tab using a non-persistent/incognito webview.
- Clear browsing data and per-profile storage controls.
- Downloads disabled until a dedicated review flow exists.

Later:

- A bounded pool of suspended tab webviews.
- Download quarantine, hash, signature and destination review.
- Reading list and workspace collections.
- Explicit user-selected text capture.
- DevTools toggle restricted to development builds.
- Proxy profiles for an authorized laboratory engagement.

Not in scope:

- Password-manager replacement.
- Browser-extension compatibility.
- Silent DOM scraping.
- Automatic page control by the assistant.
- Exposing Qutra Labs commands, secrets or filesystem access to websites.
- Certificate-warning bypasses.

## Runtime Components

### Trusted React chrome

`BrowserPage` owns the visible toolbar, tab strip, permission prompts and
empty/error states. It never renders untrusted page HTML.

`BrowserViewport` reserves a rectangular area for the native child webview.
A `ResizeObserver` measures that area and sends logical position and size to
the native browser manager. The remote webview is hidden before route changes,
window minimization or modal flows that need to occupy that rectangle.

Native child webviews are not DOM children. React overlays cannot be assumed
to appear above them. The toolbar and any prompts must occupy reserved layout
space outside the child webview bounds.

### Native browser manager

A narrow Rust boundary owns child-webview creation and policy:

- `browser_create_tab`
- `browser_navigate`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_stop`
- `browser_set_bounds`
- `browser_show`
- `browser_hide`
- `browser_close_tab`
- `browser_clear_profile`

The manager emits typed state events to the trusted app:

- navigation started/completed/failed
- URL changed
- title changed
- new-window requested
- download requested
- renderer/process failed

Do not expose a generic "evaluate script" command. Fixed internal history
operations may use native WebView2 APIs or a constant script, but no
user-controlled JavaScript string may cross the command boundary.

### Webview lifecycle

Start with one active page webview. Qutra Labs tabs store navigation metadata;
switching tabs navigates the active webview to the selected tab state.

If preserving live page state becomes essential, move to a bounded pool:

- Maximum five live child webviews.
- Only one shown and focused.
- Inactive views hidden and eligible for eviction.
- Pinned/private/authentication tabs are never silently serialized.
- Eviction stores URL, title and navigation metadata, not DOM or form data.

This avoids multiplying WebView2 renderer, GPU and network processes for every
tab.

## Security Boundary

Treat every remote document as hostile.

### Capabilities

- Main app label: existing least-privilege capabilities.
- Browser labels: `browser-<uuid>`.
- No capability file may target `browser-*`.
- Do not configure Tauri `remote.urls` for arbitrary browsing origins.
- Never make `window.__TAURI__` globally available.
- No initialization script, host object or generic web-message bridge.

The absence of matching capabilities is an intentional security boundary, not
an inconvenience.

### Navigation policy

Allow:

- `https:`
- `http:` only after an explicit insecure-connection indication
- `about:blank` for initialization

Block:

- `file:`
- `javascript:`
- `data:`
- `blob:` as a top-level user navigation unless created by the current page
- `tauri:`, `asset:` and every Qutra Labs custom protocol
- unknown external protocols

External protocol requests such as `mailto:` must leave through the existing
opener bridge after a visible user action.

Use `WebviewBuilder::on_navigation` for the native decision. Treat
`window.open` through `on_new_window`: convert approved HTTP(S) destinations
to a Qutra Labs tab and reject the original unmanaged popup.

### Browser settings

- Release DevTools disabled.
- General autofill disabled initially.
- Clipboard access disabled unless a later permission design proves a need.
- Drag/drop disabled into remote pages for MVP.
- Separate data directory under app data, never the main app webview profile.
- Private tabs use incognito/non-persistent storage.
- Use the Evergreen WebView2 Runtime.
- Preserve WebView2 sandbox and user-data-folder ACLs.

JavaScript must remain enabled for a practical browser. Security comes from
process/origin isolation and zero native capability, not from breaking modern
sites.

### Downloads

MVP rejects downloads and offers "Open in default browser."

The later download flow must:

1. Pause or cancel the webview download.
2. Show origin, final URL, filename, MIME and expected size.
3. Require a user-selected destination.
4. Write to a temporary quarantine path first.
5. Compute SHA-256 and inspect Authenticode where applicable.
6. Never auto-open the result.
7. Record provenance without storing secrets in logs.

## Data and Privacy

Use a separate browser profile directory:

`%APPDATA%\app.contextos.desktop\browser\profiles\<profile-id>`

Qutra Labs database records only:

- tab id
- normalized URL
- title
- favicon cache key
- visit timestamp
- workspace/bookmark relationship
- private/persistent flag

Do not place cookies, page storage, credentials or response bodies in SQLite.
Those remain inside the WebView2 user-data folder.

Provide:

- clear history
- clear cookies/site data
- clear cache
- clear everything
- private mode
- a visible storage mode indicator

## URL Handling

The address field follows deterministic rules:

1. Trim Unicode whitespace.
2. Reject control characters and oversized input.
3. If a recognized scheme is present, validate against the scheme policy.
4. If the value resembles a hostname, prepend `https://`.
5. Otherwise build a search-provider URL with structured URL encoding.
6. Display the parsed host separately from the full URL.
7. Never present a custom lock icon as proof beyond the actual `https` scheme.

Keep URL parsing and policy in a pure Rust or TypeScript module with a shared
test matrix.

## GitHub Integration

Opening a repository from the GitHub dashboard should support two commands:

- Open in Qutra Labs browser.
- Open in the system browser.

The GitHub token remains in the OS secure store and is used only by the
GitHub API provider. It must not be injected into the browser profile, URL,
cookies or page scripts.

Future read-only GitHub modules can add notifications, pull requests, workflow
status and contribution data. Start with minimum token permissions and make
every additional scope visible before reconnection.

## Delivery Phases

### Phase 1: isolated browser shell

- Browser route and workbench tab type.
- Trusted toolbar and viewport geometry.
- One child webview with no remote capabilities.
- URL policy, navigation callbacks and open-in-system-browser fallback.
- Packaged Windows smoke test.

### Phase 2: durable browsing

- Qutra Labs tab metadata.
- Bookmarks, local history and workspace links.
- Separate persistent/private profiles.
- Clear-data controls and renderer recovery.

### Phase 3: controlled integrations

- GitHub "open here" action.
- Save URL/title to a page or workspace.
- Download review pipeline.
- Optional authorized-lab proxy profile.

## Acceptance Tests

Security:

- A remote test page cannot invoke any Tauri command.
- `file:`, `javascript:`, `data:`, `tauri:` and custom protocols are blocked.
- Popups cannot create unmanaged windows.
- GitHub/API tokens never appear in URL, logs, database or browser storage.
- Private mode leaves no persistent profile after close.

Behavior:

- Bounds remain correct at 800x900, 1024x768, 1280x720 and maximized sizes.
- Switching away hides the native webview without intercepting clicks.
- Back/forward/reload operate after cross-origin navigation.
- Renderer termination produces a recoverable error state.
- Clear-data operations are verifiable in the packaged app.

Visual:

- The native page never overlaps the workbench toolbar, sidebar or bottom
  output panel.
- Address text cannot overflow the toolbar.
- Loading, insecure HTTP, offline and blocked-navigation states are distinct
  without relying on color alone.

## References

- Tauri 2 `Webview` JavaScript API:
  https://v2.tauri.app/reference/javascript/api/namespacewebview/
- Tauri `WebviewBuilder` hooks and data directory:
  https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html
- Tauri capabilities:
  https://v2.tauri.app/security/capabilities/
- Microsoft WebView2 security guidance:
  https://learn.microsoft.com/microsoft-edge/webview2/concepts/security
- Microsoft WebView2 development guidance:
  https://learn.microsoft.com/microsoft-edge/webview2/concepts/developer-guide
- GitHub REST activity endpoints:
  https://docs.github.com/rest/activity
- GitHub GraphQL user/contribution schema:
  https://docs.github.com/graphql/reference/users
