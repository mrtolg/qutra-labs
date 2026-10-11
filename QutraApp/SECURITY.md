# Security Policy

## Supported Versions

Qutra Labs is pre-1.0. Security fixes are applied to the latest released version
(`0.1.x`).

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a Vulnerability

Please report security issues **privately** so they can be addressed before
public disclosure.

- Preferred: open a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository ("Report a vulnerability" under the Security tab). This
  keeps the report private until a fix is ready.
- If you cannot use GitHub advisories, open a regular issue that contains **no
  exploit details** asking a maintainer to arrange a private channel.

Please do **not** open a public issue that includes exploit details, and do not
disclose the issue publicly until a fix has been released.

_No email address is published for this project; use the GitHub Security
Advisory workflow above._

### What to include

- A description of the vulnerability and its impact
- Steps to reproduce (proof of concept if possible)
- Affected version(s) and platform
- Any suggested remediation

### Response

- We aim to acknowledge reports within a few days.
- We will keep you informed of progress and coordinate a disclosure timeline.
- With your consent, we will credit you in the release notes.

## Security Model

Qutra Labs is local-first: no account, no telemetry, and no network requests
unless you explicitly configure an AI provider. Key protections:

- Strict Content Security Policy and narrow Tauri capabilities (no blanket
  filesystem or shell access).
- All IPC payloads validated in Rust; commands use argument arrays, never shell
  strings built from untrusted input.
- Secrets (e.g. AI provider credentials) belong in the OS-backed secure store,
  never in SQLite or frontend storage.
- Conservative local secret detection for clipboard capture (documented as
  imperfect); redaction for diagnostics export.

See `docs/decisions/0003-security-boundaries.md` for details.
