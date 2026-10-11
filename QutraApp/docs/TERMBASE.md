# Qutra Labs Product Termbase

**Version:** 1 · **Owner:** localization lead · **Status:** enforced by
`src/lib/i18n/termbase.test.ts` (release gate)

This glossary is the single source of truth for approved domain terminology.
The structured data lives in `src/lib/i18n/termbase.ts`; this file explains the
decisions. Turkish is the reviewed baseline; German, Spanish, French and Italian
receive the same structural checks (key parity, placeholder parity, no raw keys,
brand preservation) via `i18n.test.ts` and `termbase.test.ts`.

## How it is enforced

- **Approved-term binding.** Each concept binds to one or more catalog keys whose
  value must exactly equal the approved translation. Drift fails the build.
- **Disallowed literals.** Known bad translations may never reappear anywhere in
  the Turkish catalog (substring match).
- **Do-not-translate brands.** If an English string contains a brand/technical
  token, every locale must preserve it verbatim.
- **No raw keys.** No locale value may equal its own message key.

## Turkish terminology decisions (v1)

| English concept | Approved Turkish | Rationale / disallowed |
| --- | --- | --- |
| Overview | Genel Bakış | |
| Today | Bugün | |
| Workspace / Project | Proje (nav: Projeler) | One name since 2026-09-29; **not** "Çalışma Alanı", which also meant the Work mode, engagement, run and working folder |
| Session | Oturum (nav: Oturumlar) | |
| Task | Görev (nav: Görevler) | |
| Inbox | Gelen Kutusu | |
| Notes | Notlar | |
| Timeline | Zaman Çizelgesi | |
| Snippets | Kod Parçacıkları | **not** "Parçacık Kasası" (a literal "particle vault") |
| New snippet | Yeni kod parçacığı | **not** "Yeni parçacık" |
| Clipboard | Pano Geçmişi | "Pano" alone is ambiguous |
| Insights | Analizler | **not** "İçgörüler" (over-literal) |

## Do-not-translate list

`Qutra Labs`, `GitHub`, `JWT`, `Regex`, `Nmap`, `CVE`, `CWE`, `CVSS`, `SARIF`,
`MITRE ATT&CK`. Established brand/technical names stay unchanged unless normal
target-language grammar requires surrounding words.

## Phase 3 forward terms (to add as the surfaces ship)

The Phase 3 spec (§5) fixes additional Turkish terms for the Security Laboratory
that will be bound to keys as those surfaces are built: Private Security Lab →
Özel Güvenlik Laboratuvarı, Tool Registry → Araç Kitaplığı, Tool Run → Araç
Çalıştırması, Finding → Bulgu, Evidence → Kanıt, Engagement → Güvenlik Çalışması,
Asset → Varlık, Target → Hedef, Remediation → Düzeltme, Risk acceptance → Risk
Kabulü, Report → Rapor. They are recorded here now so the translation is decided
before the UI exists; `termbase.ts` gains the binding when each key lands.

## Changing a term

Update `termbase.ts` (structured) and this file (rationale) in the same commit,
bump `TERMBASE_VERSION` when a shipped approved term changes, and let the gate
test confirm the catalogs comply.
