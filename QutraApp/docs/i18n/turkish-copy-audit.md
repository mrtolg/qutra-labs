# Qutra Labs — Turkish copy audit

Audit of the user-facing copy in `src/lib/i18n/tr.ts` and `src/lib/i18n/en.ts`.

| | |
|---|---|
| Source | The committed files at HEAD `e2ba3a2`, read with `git show HEAD:./src/lib/i18n/tr.ts` and `en.ts`. |
| Line numbers | `tr.ts:N` and `en.ts:N` refer to that HEAD. |
| HEAD moved | While the audit ran, HEAD advanced to `886cc6f` (the HUD re-skin: CSS, terminal theme, screenshots). `tr.ts` and `en.ts` are unchanged between the two commits, the copies that were read are byte-identical to the current blobs (`tr.ts` `0dff980`, `en.ts` `c7ecc8c`), none of the source files cited below changed, and the working tree has no uncommitted edits to either locale file. |
| Also read | `termbase.ts`, `termbase.test.ts`, `naming.test.ts`, `i18n.test.ts`, `docs/TERMBASE.md`, ADR 0007, the assistant-persona notes, the readiness work, and the components that render the strings, so surfaces and test constraints below come from source, not guesses. |
| Method | All 1,195 keys were read in both languages, then every proposal was checked by script against the catalogs: identical `{placeholders}`, every `DO_NOT_TRANSLATE` token kept, no `DISALLOWED_TR` term, no `contextos` outside the fixture path, the fixture path intact, termbase-bound keys untouched. **0 violations.** |
| Principles | Plain words, active voice, errors that say how to fix, buttons that say what happens. Tone stays calm, exact and short. |

**Legend for the tables**

- Reason codes (a row can carry two): **REG** register (sen/siz, or label vs sentence form) · **GLO** glossary (one term per concept) · **EN** left in English · **IMPL** implementation exposed · **NAT** unnatural, a calque · **ERR** wrong (grammar, meaning, suffix) · **STALE** no longer matches the English source or the product · **SRC** follows an English rewrite in §5.
- `†` the key is not referenced anywhere in `src/` at HEAD (dead copy: rewrite last, or delete).
- `‡` an existing test asserts the current text; update the test in the same change.
- `⚑` depends on an open question in §7 (`⚑1` means question 1; `⚑readiness` means the readiness work edits the same key).

## 1. Summary

**271 of 1,195 Turkish strings change** (22.7%): 263 rewrites plus 8 casing-only edits. **89 English strings** get a user-facing rewrite because the source talks about the implementation, is stale, or names one thing three ways. 190 keys are not referenced anywhere in `src/` at HEAD (33 of the Turkish rows fall on them, marked `†`); they are legacy productivity copy (Today, Insights, the block editor, most of the old Home grid) and can be rewritten last or deleted.

| Reason | Rows | | Reason | Rows |
|---|---:|---|---|---:|
| GLO glossary | 74 | | REG register | 16 |
| NAT unnatural | 76 | | SRC follows §5 | 15 |
| IMPL implementation | 35 | | STALE drifted | 10 |
| EN left in English | 29 | | ERR wrong | 9 |

### The three worst patterns

**1. The developer's notes reach the user.** 35 Turkish and 75 English strings describe how the app is built instead of what the user can do: "Rust still re-checks consent at execute", "narrow native broker", "the renderer cannot reach github.com", live stdout and stderr, "loopback endpoint", "typed arguments", "canonical path in the private app-data registry", "Tauri", "Schema version", "isolated lab". The guarantee is worth stating, in the user's terms: *"Access is checked again each time a tool runs."* Your `tools.enableBody` example is the clearest case, and the English source has it too.

**2. Half-translated, drifted and mistranslated text.** 22 labels and sentences in `tr.ts` are still entirely English (the whole `appearance.*` block, five `perm.*` messages, three theme strings). 10 more no longer match their English source: `theme.windows.desc` still describes the Mica-to-Acrylic fallback the English dropped, `perm.stored` lost a whole sentence, `github.patHint` says "Yalnızca geliştirme için", which the English never said. Some are plain mistranslations: **"Engelli"** for *Blocked* (the word for a person with a disability), **"Çatal"** for *Fork* (cutlery), "İlgi bekliyor" for *Needs attention*, "değişik" for *changed*, "mürekkep kontrastı" for *ink contrast*, "Kuru çalıştırma", "Bayat", "Tamamlandı işaretle", and "aracı eylemleri" for *agent actions* (it reads as "intermediary actions").

**3. One concept, many names, and two registers.** Private Lab is written five ways (`Private Lab`, `Private Lab'i`, `Özel Lab'ı`, `Özel Siber Lab`, `Özel Laboratuvar`). "Çalışma" carries five meanings: workspace, the *Work* mode, engagement, run ("Son çalışma") and working folder. "Onay" stands for consent, approval, confirmation and acknowledgement. "Lab/Laboratuvar" names three different things: the Security Lab, the Private Lab and the local Ollama ("izole laboratuvar"). Smaller splits: Tekrar/Yeniden dene, süz/filtrele, kip/mod, jeton/belirteç, aktif/etkin, dizin/klasör, Sırada/Kuyrukta. On top of this, 11 sentences address the user in the informal *sen* form next to formal *siz* sentences.

### Found on the way (not translation problems, but the copy is wrong)

- `capture.saved` says "Captured to inbox" after adding a **task** (`FocusPage.tsx:75-80`); the inbox no longer exists. English and Turkish.
- `notFound.back` says "Go to Today"; the link goes to Home (`NotFoundPage.tsx:16`). English and Turkish.
- `terminal.subtitle` says "not a system shell", but the tab spawns `pwsh.exe`, `powershell.exe` or `bash.exe` (`terminal/mod.rs:92-94`), and the readiness work adds a `cmd` fallback.
- The assistant is called **Qutra** in 23 strings; the product decision is that the persona is **Jarvis**. No user-visible string at HEAD says Jarvis.
- `docs/TERMBASE.md` disagrees with `termbase.ts` v2 and with the product (§7, question 9).

### Before anyone applies this

1. **Bound keys are untouched.** `nav.overview`, `nav.workspaces`, `nav.sessions`, `nav.tasks` (termbase), `nav.projects` and `settings.about.author` (`i18n.test.ts`) have no row here. The two casing questions that touch them are in §7.
2. **Tests that assert current text** (English unless noted). Update these with the strings:

| Test | Asserts | Key |
|---|---|---|
| `e2e/lab.spec.ts:104` | "Native tool execution requires the desktop app" | `lab.tools.desktopRequired` |
| `e2e/lab.spec.ts:115` | "Native execution needs the desktop build" | `lab.tools.unavailableDesktopTitle` |
| `e2e/lab.spec.ts:116`, `:137` | "Start with the reference adapter" | `lab.tools.unavailableFixtureTitle` |
| `e2e/lab.spec.ts:159`, `:189` | button "Enable the Private Lab" | `tools.enable` |
| `src/lib/launch/launchFailureMessage.test.ts:26` | "Private Lab consent is required before Test Tool can launch." | `lab.tools.launchReasonConsentRequired` |
| `src/features/jarvis/LocalAssistantChat.browser.test.tsx:58` | "Qutra runs through the desktop app. This build has no local broker." | `localAssistant.desktopOnly` |
| `e2e/local-assistant.spec.ts:114` | label "Endpoint (loopback only)" | `localAssistant.baseUrl` |
| `e2e/lab.spec.ts:283` (Turkish) | "Engellendi · onaylanmadı" | `lab.decision.no_acknowledgment` |
| `e2e/lab.spec.ts:280` (Turkish) | button "Kapsam ve Hedefler" (Playwright matches case-insensitively, so the casing-only edit is safe) | `lab.view.scope` |

   `e2e/tr-terminology.spec.ts:17-25` asserts the nine Turkish nav labels (Ana Sayfa, Projeler, Dosyalar, Araçlar, Güvenlik Laboratuvarı, Terminal, GitHub, Qutra, Sistem); no proposal touches them. I matched exact text and interpolated forms only, so run the e2e suite after applying, in case a regex locator names a changed string.
3. **Readiness overlaps.** The readiness work already rewrites `localAssistant.sectionHint` in all six locales, and the same work removes "isolated" and the fixed port. Five more keys carry that wording; all six are marked `⚑readiness` and have proposals that survive the change. Merge them with that work rather than editing the same keys twice.
4. **Other locales** (out of scope). de/es/fr/it repeat the same patterns: each still has `Rust` ×2, `renderer`, `stdout` ×2, `Tauri` ×2, "isolated" ×4, and Private Lab written three ways (for example es: `Private Lab`, `Laboratorio ciber privado`, `Activar el laboratorio privado`); "engagement" flips between translated and untranslated (es: `Nuevo compromiso` next to `Informe del engagement`). Whatever §5 changes in English will need the same pass there.

## 2. Register recommendation

**Use one register with two forms, which is how Windows 11 itself writes Turkish.** *Command labels* (buttons, menu items, tabs, toggle labels, palette entries) stay the bare verb stem: Kaydet, Aç, Yeniden dene, Etkinleştir. That is Windows's own command form, it addresses nobody, and it is not the informal *sen* the catalog currently slips into. *Every sentence that speaks to the reader* (hints, errors, empty states, dialogs, tooltips) uses the polite *siz* imperative and possessives: Seçin, Etkinleştirin, onayınız. *Sen* forms never appear: kaldığın, onayın, gönderdiğin, or a bare "etkinleştir." inside a sentence, as in `tools.enableBody`. This confirms your recommendation for sentences but stops short of buttons: Windows's own buttons say "Aç" and "Kaydet", and "Etkinleştirin" on a button reads as a request rather than a command. Where a status can be stated without addressing anyone, do that ("Yakalama duraklatıldı"); write headings as noun phrases in sentence case; use a colon, semicolon or full stop instead of a spaced em dash. The catalog is already in this shape almost everywhere: the mix is confined to 16 strings (11 sentences in the *sen* form plus a few label/sentence mismatches), all tagged REG in §4. I could not open a Windows 11 tr-TR install from here, so treat the Windows examples as my knowledge of its UI and check two or three on your machine.

## 3. Glossary

Where a row says **= TERMBASE.md**, the term is already approved in `docs/TERMBASE.md`; the code binds only four of them (`termbase.ts` v2: Home, Workspace, Session, Task).

### 3.1 The terms you listed

| Term | Proposed Turkish | Why | Alternatives |
|---|---|---|---|
| **Qutra Labs** | Qutra Labs | Product name; `DO_NOT_TRANSLATE` and `naming.test.ts`. Suffixes: Qutra Labs'a, Qutra Labs'ı, Qutra Labs'ın (§3.3). | none |
| **Jarvis** | Jarvis | Assistant persona (product decision). It is **not visible anywhere at HEAD**: the assistant shows as "Qutra" (question 2). Suffixes: Jarvis'in, Jarvis'e, Jarvis'i. | none |
| **Private Lab** | **Private Lab** (kept in English, one spelling everywhere) | It is a named consent switch, not a description, and it appears in 15 English strings, in screenshot names and in tests. "Özel" means private, custom and special at once, so a literal rendering says less than the English name. Microsoft does the same with InPrivate. The suffix is `Lab'ı` (`Private Lab'ı etkinleştirin`). English also needs one spelling: "Private Cyber Lab" and "the Private Lab" become "Private Lab". | Özel Lab (a find-and-replace on "Private Lab" is safe, the suffix stays `Lab'ı`); Özel Laboratuvar; Kişisel Lab |
| **Security Lab** | **Güvenlik Laboratuvarı** (chips and mode chip: Laboratuvar) | The module name in the nine-item nav (pinned by `e2e/tr-terminology.spec.ts`). Use "Lab" only inside "Private Lab". Never call the local Ollama a lab ("izole laboratuvar", "Yerel Asistan Laboratuvarı"): that was a third meaning. | Güvenlik Lab |
| **Engagement** | **güvenlik çalışması** (always in full) | **= TERMBASE.md**, and real infosec Turkish ("sızma testi çalışması", "çalışma kapsamı"). Never bare "Çalışma": that word already means workspace, Work mode, run and working folder. | Değerlendirme (matches "Değerlendirme metodolojisi" and "değerlendirmeye yetkiliyim"); Test çalışması; keep "engagement" |
| **Scope** | **kapsam**; *authorization scope* = **yetki kapsamı**; in/out of scope = kapsam içinde / kapsam dışı | One name for the authorization scope: the catalog said both "yetki kapsamı" and "yetkilendirme kapsamı". | yetkilendirme kapsamı (longer, no gain) |
| **Target** | **hedef** | **= TERMBASE.md** | none |
| **Finding** | **bulgu** | **= TERMBASE.md** | none |
| **Evidence** | **kanıt** | **= TERMBASE.md**. Not used for a session's own records ("oturum kayıtları"), which clashed with the Lab's Evidence. | delil (legal register) |
| **Run** (noun) | **çalıştırma**; verb: çalıştır | A run is never "çalışma". Toolbar/table plural: Çalıştırmalar. | yürütme; koşu |
| **Session** | **oturum** | **= TERMBASE.md** and `termbase.ts`. Terminal session: "terminal oturumu". | none |
| **Workspace** / **Project** | **çalışma alanı** / **proje** (mirroring the English one-to-one for now) | Both are approved and both are shown for the same screen: route `/workspaces` is labelled "Projeler" in the nav (`navConfig.tsx:31`). Fix it in English first; Turkish then follows. My recommendation is **proje** everywhere, because the nav, Home and Files already say it. That retires "çalışma alanı", which is `termbase.ts`-bound (question 3). | keep both |
| **Approval** | **onay**; Onayla / Reddet; *approval prompt* = onay istemi | A per-action decision on something Qutra proposes. Not used for consent or acknowledgement. | izin (that is *permission*) |
| **Tool launcher** | **araç başlatıcı**; the verb on rows stays **Başlat** | The design canvas calls the Tools screen "Tool Launcher"; the catalog has no such string yet, so this is the name to use when it lands. | Araç paneli; just "Araçlar" |
| **Readiness** | **hazırlık durumu**; a green state is **Hazır** | Name for the readiness panel. | Kurulum durumu; Hazır mı? |
| **Assistant** | **asistan** (its name, as shown at HEAD: Qutra) | Plain and short; "yardımcı" sounds like a utility. | yapay zekâ asistanı (longer) |
| **Verified** | **doğrulandı** (identity verified; a fix verified by re-test) | One word for verification. The finding status *Confirmed* becomes **teyit edildi** (an analyst confirmed it is real), so the two never share a word in the same dropdown. | onaylandı (collides with approval); kontrol edildi (weak); geçerli |
| **Registered** | **kayıtlı** (adjective); the verb *register* becomes **kitaplığa ekle** | "Kaydet" already means Save. | kaydedildi |
| **Consent** | **avoid the noun**; stored app-level records: **izin kaydı**; the Private Lab gate: state the action ("Private Lab'ı etkinleştirin") | English uses "consent" for the local record and "permission" for Windows grants (`perm.stored`), and Turkish "onay" cannot carry both plus approval. "Rıza" is the legal word and too heavy for this tool. | onay (only inside "onay penceresi" for the confirmation dialog); rıza |

### 3.2 Other terms I had to fix

| Term | Proposed Turkish | Why | Alternatives |
|---|---|---|---|
| Acknowledgement (scope declaration) | **yetki beyanı** | The user declares they are authorized; it is not an approval. | onay |
| Tool library / registry | **araç kitaplığı** | **= TERMBASE.md**; "kitaplık" is the Windows word (Kitaplıklar). One name for "Lab library", "tool library", "native tool library". | kütüphane |
| Remediation | **düzeltme** | **= TERMBASE.md**. "Giderme" alone ("Giderme not edildi") is unreadable. | çözüm önerisi |
| Severity | **önem derecesi** ("Önem" allowed in narrow column headers) | Bare "Önem" is incomplete. | risk seviyesi |
| Snapshot | **anlık görüntü** | Existing Windows-style term; never "snapshot'ları". | kontrol noktası |
| Handoff | **devir notu** | Already used in most places. | |
| Workbench | **çalışma masası** | Keeps "çalışma alanı" for workspace only. | |
| Exclusion (privacy) | **dışlama** (Dışlamalar, Dışlama ekle) | The Windows Security term. Lab *excluded targets* stay "hariç tutulan hedefler". | hariç tutma |
| Token | **belirteç** | Microsoft's and GitHub's Turkish; not "jeton". | |
| Executable | **çalıştırılabilir dosya** | Already consistent. | yürütülebilir dosya |
| Native | do not render as "yerel"; say **Windows** or **masaüstü uygulaması** | "Yerel" means *local*; "native" leaked as both. | |
| Endpoint, loopback | **adres**, **bu bilgisayar** | Users need where, not the network term. | |
| Build, runtime, version | **sürüm** | "derleme" only when telling someone to compile (the fixture step). | |
| OS | **Windows** | The product is a Windows app. | işletim sistemi (only when generic) |
| Mode | **mod** | Matches "Odak modu", "Modlar"; not "kip". | |
| Retry | **Yeniden dene** | One of two existing forms. | |
| Filter | **filtrele** | Not "süz". | |
| Resume | **sürdür** | Pairs with Duraklat; Windows wording. | devam et |
| Board (view) | **Kanban** | "Pano" is the Windows clipboard in the same catalog (`privacy.clipboardOn`), and the termbase already calls "Pano" ambiguous. | Tahta |
| Active | **etkin** | Not "aktif". | |
| Queue | **kuyruk** (Kuyrukta) | Not "Sırada". | |
| Folder | **klasör** | Not "dizin". | |
| Privilege | **yetki** (yönetici yetkisi) | Not "ayrıcalık". | |
| This machine | **bu bilgisayar** | Not "bu makine". | |
| Agent (developer word) | not shown; say **araç önerileri** | English already says "tool proposals"; "agent actions" appears in three strings only. | |
| High contrast | **yüksek karşıtlık** (verify) | Windows 11 wording; question 7. | Yüksek kontrast |

### 3.3 Suffixes after names

| Name | Dative | Accusative | Genitive | Locative / ablative |
|---|---|---|---|---|
| Qutra Labs | Qutra Labs'a | Qutra Labs'ı | Qutra Labs'ın | Qutra Labs'ta / 'tan |
| Qutra | Qutra'ya | Qutra'yı | Qutra'nın | Qutra'da / 'dan |
| Jarvis | Jarvis'e | Jarvis'i | Jarvis'in | Jarvis'te / 'ten |
| Private Lab | Private Lab'a | Private Lab'ı | Private Lab'ın | Private Lab'da / 'dan |
| GitHub | GitHub'a | GitHub'ı | GitHub'ın | GitHub'da / 'dan |
| Nmap | Nmap'e | Nmap'i | Nmap'in | Nmap'te / 'ten |
| Ollama | Ollama'ya | Ollama'yı | Ollama'nın | Ollama'da / 'dan |
| Windows | Windows'a | Windows'u | Windows'un | Windows'ta / 'tan |
| Git | Git'e | Git'i | Git'in | Git'te / 'ten |
| Mica, Acrylic | Mica'ya, Acrylic'e | Mica'yı, Acrylic'i | Mica'nın, Acrylic'in | |

### 3.4 Conventions used in every rewrite

- **Casing:** sentence case for labels, tabs and headings; capitals only for named features (Private Lab, Güvenlik Laboratuvarı, Tema Stüdyosu, Gizlilik Merkezi). Title Case in Turkish is an English-origin tell. The four termbase-bound labels stay as they are (question 6).
- **Punctuation:** labels have no full stop; sentences do. One `…` character, never three dots. No spaced em dash; use `:`, `;` or a full stop.
- **Apostrophe** only before a suffix on a proper name or an English word (Nmap'i, Lab'ı, Ollama'ya), never after an ordinary Turkish noun.
- **Never in user copy:** Rust, IPC, PTY, execute, broker, renderer, schema, Tauri, stdout, stderr, loopback, endpoint, "typed", "native", "isolated". State the user-level fact instead.
- **Placeholders** are untouched: `{name}`, `{count}`, `{failed}`, `{skipped}`, `{feature}`, `{working}`, `{planned}`, `{adapter}`.

## 4. Turkish rewrites

Grouped by key prefix, in catalog order. Only strings that change. Every `{placeholder}` is identical to the English.

### `app.*` (1)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `app.tagline` † | Projeyi şimdi bırak. Günler sonra dön. Bir dakikadan kısa sürede kaldığın yerden devam et. | Bir projeyi şimdi bırakın, günler sonra dönün ve bir dakikadan kısa sürede kaldığınız yerden devam edin. | **REG** — Three commands in the 'sen' form; rewritten in the 'siz' form. |

### `action.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `action.resume` † | Devam et | Sürdür | **GLO** — Pairs with 'Duraklat'; 'resume' is 'Sürdür' everywhere. |
| `action.tryAgain` | Tekrar dene | Yeniden dene | **GLO** — Two words for retry ('Tekrar dene' / 'Yeniden dene'); one form. |

### `common.*` (1)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `common.due` † | Bitiş | Son tarih | **NAT** — 'Bitiş' means end; a due date is 'son tarih'. |

### `task.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `task.board` | Pano | Kanban | **GLO** — 'Pano' is also the Windows clipboard; TERMBASE.md already calls it ambiguous. |
| `task.markDone` | Tamamlandı işaretle | Tamamlandı olarak işaretle | **ERR** — 'Tamamlandı işaretle' is ungrammatical. |

### `today.*` (4)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `today.resumeContext` † | Bağlama devam et | Bağlamı sürdür | **GLO** — One heading, two names ('devam et' / 'sürdür'). |
| `today.resume` | Devam et | Sürdür | **GLO** — One verb for 'resume'. |
| `today.noContext` † | Henüz yakın tarihli bağlam yok | Henüz kayıtlı bağlam yok | **NAT** — 'yakın tarihli bağlam' is an English calque. |
| `today.inboxTriage` † | Gelen kutusunda {count} öğe ayıklama bekliyor | Gelen kutusunda ayıklanmayı bekleyen {count} öğe var | **NAT** — Smoother passive, same meaning. |

### `ws.*` (7)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `ws.board` | Pano | Kanban | **GLO** — See task.board. |
| `ws.emptyHint` | Bir çalışma alanı; proje klasörünü, oturumlarını, görevlerini ve bağlam anlık görüntülerini birbirine bağlar. | Çalışma alanı; proje klasörünü, oturumları, görevleri ve bağlam anlık görüntülerini bir araya getirir. | **NAT** — Subject + semicolon reads like machine output. |
| `ws.health` | Bağlam sağlığı | Bağlam durumu | **NAT** — 'Sağlık' is a calque of 'health'. |
| `ws.deleteBody` | "{name}" ile birlikte oturumları, anlık görüntüleri ve etkinlik geçmişi kaldırılır. Atanmış görevler projesiz olarak korunur. Bu işlem geri alınamaz. | "{name}", oturumları, anlık görüntüleri ve etkinlik geçmişiyle birlikte silinir. Atanmış görevler projesiz olarak korunur. Bu işlem geri alınamaz. | **NAT** — Subject and verb did not agree; 'kaldırılır' vs the 'Sil' button. |
| `ws.restoreBehavior` | Tercih edilen geri yükleme davranışı | Geri yükleme tercihi | **NAT** — Needlessly long. |
| `ws.dirtyFiles` | {count} değişik | {count} değişiklik | **ERR** — 'değişik' means 'different'; the count is of changed files. |
| `ws.filters.attention` | İlgi bekliyor | Dikkat gerektiriyor | **ERR** — 'İlgi bekliyor' means 'awaiting interest'; use the words of overview.attention. |

### `session.*` (5)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `session.outcomePlaceholder` | Bu oturum bittiğinde ortada ne olmalı? | Bu oturum bittiğinde ortaya ne çıkmış olmalı? | **NAT** — 'ortada ne olmalı' makes no sense. |
| `session.elapsed` | Geçen | Geçen süre | **NAT** — Bare 'Geçen' is incomplete. |
| `session.remaining` | Kalan | Kalan süre | **NAT** — Bare 'Kalan' is incomplete. |
| `session.resume` | Devam et | Sürdür | **GLO** — One verb for 'resume'. |
| `session.prefillHint` | Oturum kanıtlarından önceden dolduruldu — kaydetmeden önce düzenleyin. | Oturum kayıtlarından önceden dolduruldu. Kaydetmeden önce düzenleyin. | **GLO** — 'Oturum kanıtları' collides with the Lab's 'Kanıt'. |

### `snapshot.*` (5)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `snapshot.setResume` | Çalışma alanının devam noktası yap | Çalışma alanının devam noktası olarak ayarla | **REG** — 'yap' is colloquial; 'olarak ayarla' is the Windows pattern. |
| `snapshot.emptyHint` | Anlık görüntü; uygulamaları, sekmeleri, dosyaları, terminal ve Git durumunu kaydeder. | Anlık görüntü; uygulamaları, sekmeleri, dosyaları, terminali ve Git durumunu kaydeder; böylece daha sonra geri yükleyebilirsiniz. | **NAT** — The English 'so you can restore later' had dropped out. |
| `snapshot.excluded` | Gizlilik kurallarıyla hariç tutulanlar | Gizlilik kurallarıyla dışlananlar | **GLO** — The privacy list is 'Dışlamalar'; the Lab's 'hariç tutulan hedef' is a different idea. |
| `snapshot.excludedHint` | Hariç tutulan uygulamalar ve yok sayılan yollar asla yakalanmaz. Ayarlar › Gizlilik'ten yönetin. | Dışlanan uygulamalar ve yok sayılan yollar asla yakalanmaz. Dışlamaları Ayarlar › Gizlilik bölümünden yönetin. | **GLO** — 'Gizlilik'ten' suffix; 'hariç tutulan' → 'dışlanan'. |
| `snapshot.sensitive` † | Hassas işaretli | Hassas olarak işaretlendi | **NAT** — 'Hassas işaretli' is clipped. |

### `restore.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `restore.partial` | Geri yükleme {failed} başarısız, {skipped} atlanan öğeyle bitti | Geri yükleme bitti: {failed} öğe başarısız, {skipped} öğe atlandı | **NAT** — The clause structure was broken. |
| `restore.warn.staleUrl` † | URL güncelliğini yitirmiş olabilir | Adres güncel olmayabilir | **NAT** — 'güncelliğini yitirmiş' is heavy; URL → 'adres'. |

### `capture.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `capture.placeholder` | Bir düşünce, görev, bağlantı, hata yakalayın… | Bir düşünce, görev, bağlantı veya hata yazın… | **NAT** — 'yakalayın' is an English calque of 'capture'. |
| `capture.saved` | Gelen kutusuna kaydedildi | Görev eklendi | **STALE** — The composer adds a task (FocusPage.tsx:75-80); the inbox is gone. English is stale too (§5). |

### `palette.*` (1)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `palette.hint.navigate` † | git | gezin | **NAT** — The arrow-key hint should read 'gezin', not 'git'. |

### `auto.*` (5)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `auto.dryRun` † | Kuru çalıştırma | Deneme çalıştırması | **NAT** — 'Kuru çalıştırma' is not Turkish. |
| `auto.dryRunResult` † | Kuru çalıştırma — şunları yapardı: | Deneme çalıştırması; gerçek çalıştırmada şunlar yapılır: | **NAT** — As auto.dryRun. |
| `auto.lastRun` | Son çalışma | Son çalıştırma | **GLO** — 'çalışma' already carries five meanings; a run is 'çalıştırma'. |
| `auto.nextRun` † | Sonraki çalışma | Sonraki çalıştırma | **GLO** — As auto.lastRun. |
| `auto.runLog` † | Çalışma günlüğü | Çalıştırma günlüğü | **GLO** — As auto.lastRun. |

### `insights.*` (4)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `insights.activeStale` † | Etkin ve bayat çalışma alanları | Etkin ve etkin olmayan çalışma alanları | **NAT** — 'bayat' evokes stale bread. |
| `insights.carriedTasks` † | İleri taşınan görevler | Ertelenen görevler | **GLO** — task.carriedOver already says 'ertelendi'. |
| `insights.noDataHint` † | Birkaç oturum çalıştırın; Qutra Labs dürüst örüntüleri özetlesin — puan yok, seri yok. | Birkaç oturum çalıştırdığınızda Qutra Labs gerçek eğilimleri özetler; puan ve seri yok. | **NAT** — Optative 'özetlesin' and 'örüntü' read stiffly. |
| `insights.stale` † | Bayat | Etkin değil | **NAT** — 'Bayat' evokes stale bread. |

### `settings.*` (30)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `settings.privacy` | Gizlilik ve hariç tutmalar | Gizlilik ve dışlamalar | **NAT** — 'Hariç tutmalar' reads like a gerund list; Windows Security says 'Dışlamalar'. |
| `settings.importExport` | İçe / dışa aktarma / yedek | İçe/dışa aktarma ve yedekleme | **NAT** — Slash list mixes verbs and nouns. |
| `settings.advanced.enforcementHint` ⚑1 | Bu üç anahtar bağımsızdır. Asistan yüzeyindeki kip seçimi aynı üç değeri düzenler; dördüncü bir kayıtlı anahtar değildir. Yerel asistanı veya Private Lab'i kapatmak, araç önerilerini kayıtlı ama etkisiz bırakabilir. | Bu üç anahtar birbirinden bağımsızdır. Asistan ekranında seçtiğiniz mod da aynı üç anahtarı değiştirir. Yerel asistanı veya Private Lab'ı kapatırsanız araç önerileri kayıtlı kalır ama çalışmaz. | **SRC** — 'yüzey', 'kayıtlı anahtar', 'kip', 'Lab'i'. Follows the English rewrite. |
| `settings.advanced.privateLabHint` | Yerel araçlar, etkileşimli terminal ve lab kitaplığı. Rust, execute anında onayı yeniden kontrol eder. | Yerel araçlar, etkileşimli terminal ve araç kitaplığı. Erişim, bir araç her çalıştırıldığında yeniden denetlenir. | **IMPL** — Rust and 'execute' were shown to users. |
| `settings.density.compact` | Sıkışık | Kompakt | **NAT** — 'Sıkışık' means cramped. |
| `settings.highContrast` ⚑7 | Kontrastı artır | Karşıtlığı artır | **GLO** — Windows 11 Turkish says 'Karşıtlık temaları'; confirm on your machine (Open question 7). |
| `settings.highContrastHint` ⚑7 | Yüksek Kontrast temasına geçer: daha güçlü kenarlıklar, daha net metin, kalın odak halkaları. | Yüksek karşıtlık temasına geçer: daha belirgin kenarlıklar, daha net metin, daha kalın odak halkaları. | **GLO** — Follows the term above. |
| `settings.colorBlindCharts` | Renk körü dostu grafikler | Renk körlüğüne uygun grafikler | **NAT** — 'dostu' is a calque of 'friendly'. |
| `settings.startOnLoginHint` | Bu sürümde kullanılamıyor; Windows otomatik başlatma henüz bağlanmadı. | Bu sürümde henüz kullanılamıyor. | **IMPL** — 'not wired yet' is a developer note. Follows the English rewrite. |
| `settings.startOnLoginUnavailable` | Oturum açılışında başlatma bu sürümde kullanılamıyor. | Oturum açılınca başlatma bu sürümde kullanılamıyor. | **NAT** — 'Oturum açılışında başlatma' stumbles; same wording as the label above it. |
| `settings.migration` | Şema sürümü | Veritabanı sürümü | **IMPL** — 'Schema version' means nothing to a user. |
| `settings.exportAllHint` | Tercihleri ve yerel koleksiyonları içerir. GitHub belirteçleri gibi işletim sistemi güvenli depolama sırları asla dışa aktarılmaz. | Tercihleri ve yerel koleksiyonları içerir. Windows Kimlik Bilgisi Yöneticisi'nde saklanan gizli bilgiler (ör. GitHub belirteçleri) hiçbir zaman dışa aktarılmaz. | **SRC** — 'işletim sistemi güvenli depolama sırları' is a calque; token word unified. |
| `settings.diagnostics` | Tanılamayı dışa aktar (gizlenmiş) | Tanılamayı dışa aktar (karartılmış) | **NAT** — Security Turkish for 'redacted' is 'karartılmış'. |
| `settings.aiNone` | Yapılandırılmış bulut yapay zekâ sağlayıcısı yok | Bulut yapay zekâ sağlayıcısı ayarlanmamış | **NAT** — 'Yapılandırılmış ... yok' is a translation pattern. |
| `settings.aiNoneHint` | Bu derlemede bulut taslağı bağlı değil. Gerçek bir asistan için yukarıdaki Yerel Asistan Laboratuvarı'nı kullanın; tamamen bu makinede çalışır. | Bulut taslağı bu sürümde kullanılamıyor. Asistan kullanmak için yukarıdaki yerel asistanı açın; tamamen bu bilgisayarda çalışır. | **SRC** — 'Yerel Asistan Laboratuvarı' collides with Güvenlik Laboratuvarı. |
| `settings.aiSecureReady` | OS güvenli depolama, gelecekteki sağlayıcı kimlik bilgileri için hazır. | Windows Kimlik Bilgisi Yöneticisi, ileride eklenecek sağlayıcı kimlik bilgileri için kullanılabilir. | **SRC** — 'OS' is an English abbreviation. |
| `settings.aiSecureUnavailable` | Bu çalışma zamanında OS güvenli depolama yok — kimlik bilgisi saklanamaz. | Güvenli kimlik bilgisi depolaması burada kullanılamıyor; kimlik bilgileri kaydedilemez. | **IMPL** — 'çalışma zamanı' (runtime) is developer language. |
| `settings.aiProvidersDeferred` | Bulut sağlayıcı bağlantısı ertelenmiş durumda. Yerel Asistan Laboratuvarı ayrıdır, yalnızca yereldir ve isteğe bağlıdır. | Bulut sağlayıcıları henüz desteklenmiyor. Yerel asistan ayrıdır, yalnızca bu bilgisayarda çalışır ve siz açana kadar kapalıdır. | **SRC** — 'bağlantısı ertelenmiş' is a developer note. |
| `settings.aiOutboundHint` | Yalnızca istek başına onayladığınız bağlam: oturum başlıkları, görev adları ve devir metni. Siz açıkça eklemedikçe asla pano, gizli bilgi veya dosya içeriği gönderilmez. | Yalnızca istek başına onayladığınız bağlam: oturum başlıkları, görev adları ve devir notları. Siz açıkça eklemedikçe asla pano, gizli bilgi veya dosya içeriği gönderilmez. | **GLO** — 'devir metni' → 'devir notu' (glossary). |
| `settings.aiCredential` | Kimlik bilgisi işletim sistemi güvenli deposunda | Kimlik bilgisi Windows Kimlik Bilgisi Yöneticisi'nde saklanıyor | **SRC** — 'işletim sistemi güvenli deposu'. |
| `settings.notif.restore` | Geri yükleme tamamlanması | Geri yükleme tamamlandığında | **NAT** — A bare noun phrase left incomplete. |
| `settings.notif.quietHint` | Kategori tercihleri yereldir. İşletim sistemi bildirim izni yalnızca test bildirimi gönderdiğinizde istenir. | Kategori tercihleri yereldir. Windows bildirim izni yalnızca test bildirimi gönderdiğinizde istenir. | **GLO** — 'işletim sistemi' → 'Windows'. |
| `settings.notif.osUnavailable` | İşletim sistemi bildirimleri bu çalışma ortamında kullanılamıyor. | Sistem bildirimleri burada kullanılamıyor. | **IMPL** — 'çalışma ortamı' is developer language. |
| `settings.notif.testDenied` | İşletim sistemi bildirim izni reddedildi. | Windows bildirim izni reddedildi. | **GLO** — 'işletim sistemi' → 'Windows'. |
| `settings.about.mode` | Çalışma ortamı | Uygulama türü | **SRC** — 'Çalışma ortamı' (runtime). Follows the English rewrite. |
| `settings.about.modeBrowser` | Tarayıcı demosu (yerel entegrasyonlar simüle edilir) | Tarayıcı demosu (Windows özellikleri simüle edilir) | **SRC** — 'yerel entegrasyonlar' is vague. |
| `settings.about.modeDesktop` | Masaüstü (Tauri) | Masaüstü uygulaması | **IMPL** — 'Tauri' names the framework. |
| `settings.about.privacy` | Yerel öncelikli: telemetri yok, hesap yok, siz bir sağlayıcı yapılandırmadıkça ağ çağrısı yok. | Yerel öncelikli: telemetri yok, hesap yok; siz bir sağlayıcı ayarlamadıkça ağa bağlanmaz. | **NAT** — 'ağ çağrısı' is an English calque. |
| `settings.about.storage` | Depolama arka ucu | Depolama türü | **SRC** — 'arka uç' (backend) is developer language. |
| `settings.about.repoUnset` | Depo URL'si yapılandırılmadı | Depo adresi ayarlanmadı | **GLO** — URL → 'adres'; 'yapılandırılmadı' → 'ayarlanmadı'. |

### `privacy.*` (5)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `privacy.noOutbound` | Ağ istekleri merkezî olarak sayılmaz. GitHub yerel aracısını, Qutra ise yalnızca etkinleştirdiğiniz geri döngü adresini kullanır. | İstekler tek bir yerde sayılmaz. GitHub çağrıları masaüstü uygulaması üzerinden yapılır; Qutra yalnızca etkinleştirdiğiniz yerel adrese bağlanır. | **IMPL** — 'yerel aracı' and 'geri döngü adresi' expose implementation. |
| `privacy.exclusions` | Hariç tutmalar | Dışlamalar | **GLO** — Windows Security term. |
| `privacy.addExclusion` | Hariç tutma ekle | Dışlama ekle | **GLO** — As privacy.exclusions. |
| `privacy.retention` † | Saklama | Saklama süresi | **NAT** — Bare 'Saklama' is incomplete. |
| `privacy.secretNote` † | Olası gizli bilgiler (anahtarlar, belirteçler, parolalar) tutucu yerel algılamayla atlanır. Algılama kusursuz değildir — dışa aktarımları paylaşmadan önce gözden geçirin. | Olası gizli bilgiler (anahtarlar, belirteçler, parolalar) temkinli bir yerel algılamayla atlanır. Algılama kusursuz değildir; dışa aktarılan dosyaları paylaşmadan önce gözden geçirin. | **NAT** — 'tutucu algılama' is 'conservative' taken literally. |

### `perm.*` (15)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `perm.global_shortcuts.why` | Uygulama genelindeki klavye kısayollarını kullanır. | Uygulama genelinde klavye kısayollarını kullanabilmek için gerekli. | **NAT** — Matches the '... için gerekli' pattern of the other .why lines. |
| `perm.browser_integration.what` | Açık sekmeleri listelemek için bir tarayıcı eklentisiyle konuşur. | Açık sekmeleri listelemek için bir tarayıcı eklentisiyle iletişim kurar. | **NAT** — 'konuşur' is colloquial. |
| `perm.ai_provider.what` | Yalnızca onayladığınız bağlamı yapılandırdığınız sağlayıcıya gönderir. | Yalnızca onayladığınız bağlamı, ayarladığınız yapay zekâ sağlayıcısına gönderir. | **NAT** — 'yapılandırdığınız sağlayıcı' is a calque. |
| `perm.stored` | Saklama: yerel Qutra Labs veritabanında. | Bunlar Qutra Labs veritabanındaki yerel izin kayıtlarıdır; Windows izinleri değildir. | **STALE** — The Turkish had lost the English sentence 'local consent records, not OS permission grants'. |
| `perm.localOnly` | Changing this only updates the local consent record. It does not change Windows or browser permissions. | Bunu değiştirmek yalnızca yerel izin kaydını günceller. Windows veya tarayıcı izinlerini değiştirmez. | **EN** — Left in English. |
| `perm.without` | Onsuz: {feature} kapalı kalır; geri kalan her şey çalışmaya devam eder. | İzin verilmezse {feature} kapalı kalır; uygulamanın geri kalanı çalışmaya devam eder. | **NAT** — 'Onsuz:' is poetic. |
| `perm.grant` | İzin ver | İzin ver (yerel) | **STALE** — English is 'Allow (local)'; '(yerel)' had dropped out. |
| `perm.revoke` | Geri al | Reddet (yerel) | **ERR** — English is 'Deny (local)'; 'Geri al' is a different action. |
| `perm.test` | Erişimi test et | Windows iznini denetle | **SRC** — 'Erişimi test et' does not say which access. Follows the English rewrite. |
| `perm.testOk` | Erişim çalışıyor | Windows bildirim izni verilmiş. | **STALE** — Said something other than the English source. |
| `perm.testSkipped` | No OS probe for this local consent key. | Bu izin için Windows'ta denetlenecek bir şey yok. | **EN** — Left in English. |
| `perm.testDenied` | İşletim sistemi bildirim izni verilmedi. | Windows bildirim izni verilmemiş. | **GLO** — 'işletim sistemi' → 'Windows'. |
| `perm.openSystemUnavailable` | Opening system privacy settings is not available in this build. | Sistem gizlilik ayarlarını açma özelliği bu sürümde kullanılamıyor. | **EN** — Left in English. |
| `perm.openSystemOk` | Opened system settings. | Sistem ayarları açıldı. | **EN** — Left in English. |
| `perm.openSystemFailed` | Could not open system settings. | Sistem ayarları açılamadı. | **EN** — Left in English. |

### `onb.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `onb.promise` | Projeleri, görevleri, kayıtlı kaynakları ve doğrulanmış snapshot'ları tek bir yerel Windows çalışma alanında düzenleyin. | Projeleri, görevleri, kayıtlı kaynakları ve doğrulanmış anlık görüntüleri tek bir yerel Windows çalışma masasında düzenleyin. | **EN** — 'snapshot'ları' left in English; 'çalışma alanı' collided with workspace (workbench = çalışma masası). |
| `onb.start` | Başlayın | Başla | **REG** — Button labels use the bare stem; 'Başlayın' is the sentence form. |

### `assistant.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `assistant.draftLabel` | Taslak — yerel olarak üretildi, kullanmadan önce doğrulayın | Taslak: yerel olarak üretildi, kullanmadan önce doğrulayın | **NAT** — Spaced em dash is unusual in Turkish; colon, semicolon or full stop. |
| `assistant.noProvider` | Bulut sağlayıcısı yok. Yerel model için Ayarlar'dan Yerel Asistan Laboratuvarı'nı etkinleştirin veya bu deterministik özetleri kullanmaya devam edin. | Bulut sağlayıcısı ayarlanmamış. Yerel model için Ayarlar'dan yerel asistanı açın veya bu hazır özetleri kullanmaya devam edin. | **SRC** — 'deterministik' and 'Laboratuvar'. |

### `notFound.*` (1)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `notFound.back` | Bugün'e git | Ana sayfaya git | **STALE** — There is no 'Bugün' screen; the link goes to /overview. English is stale too (§5). |

### `nav.*` (3)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `nav.group.home` † | Ana | Ana Sayfa | **ERR** — 'Ana' is cut off. |
| `nav.group.intelligence` † | Zekâ | Yapay zekâ | **NAT** — 'Zekâ' alone reads oddly. |
| `nav.group.private` † ⚑1 | Özel | Private Lab | **GLO** — The same concept was 'Özel' here and 'Private Lab' elsewhere (assumes the group holds Private Lab surfaces). |

### `overview.*` (6)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `overview.homeContinueHint` | {name} projesinde kaldığın yerden devam et. | {name} projesinde kaldığınız yerden devam edin. | **REG** — 'kaldığın' and 'devam et' are 'sen' forms. |
| `overview.homeEmptyHint` | Bir projeyle başla — ana sayfa bu kadar. | Bir projeyle başlayın. Ana sayfa bu kadar. | **REG** — 'başla' is a 'sen' form; the dash adds nothing. |
| `overview.blocked` † | Engelli | Engellenen | **ERR** — 'Engelli' means a person with a disability; the state is 'engellendi'. |
| `overview.restoreHealth` † | Geri yükleme sağlığı | Geri yükleme durumu | **NAT** — 'sağlığı' is a calque. |
| `overview.noDataHint` † | Komuta merkezini görmek için ilk çalışma alanını oluştur. | Komuta merkezini görmek için ilk çalışma alanınızı oluşturun. | **REG** — 'oluştur' is a 'sen' form. |
| `overview.sections.restoreHealth` † | Geri yükleme sağlığı | Geri yükleme durumu | **NAT** — As overview.restoreHealth. |

### `theme.*` (7)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `theme.hud.desc` | Qutra Labs konsolu — koyu, camgöbeği, sakin. Açık modda Qutra Labs açık teması kullanılır. | Qutra Labs konsolu: koyu, camgöbeği, sakin. Açık modda Qutra Labs açık teması kullanılır. | **NAT** — Spaced em dash. |
| `theme.contextos.desc` | Katı marka yüzeyleri — grafit koyu / nötr açık, gül eylemler, şeffaflık yok. | Düz marka yüzeyleri: koyu modda grafit, açık modda nötr tonlar, gül rengi eylem düğmeleri, saydamlık yok. | **NAT** — 'Katı' and 'gül eylemler' are literal. |
| `theme.catppuccin.desc` | Offline-mapped Catppuccin Latte (light) / Mocha (dark) semantic pack. | Catppuccin renkleri: açık modda Latte, koyu modda Mocha. Çevrimdışı çalışır. | **EN** — Left in English. |
| `theme.windows.desc` | Yerel Windows şeffaflığı (Windows 11'de Mica, yoksa Acrylic). Masaüstü uygulaması gerekir. | Eski seçenek. Bunun yerine Pencere arka planı bölümünden Mica'yı veya Acrylic'i seçin. | **STALE** — Turkish still carries the old text (Mica/Acrylic fallback); the English changed. |
| `theme.windows.browserHint` | Windows şeffaflığı yalnızca paketlenen masaüstü uygulamasında görünür — tarayıcı Mica veya Acrylic gösteremez. | Windows pencere efektleri yalnızca masaüstü uygulamasında görünür. Tarayıcı önizlemesi düz kalır. | **STALE** — Does not match the English text. |
| `theme.highContrast` ⚑7 | Yüksek Kontrast | Yüksek karşıtlık | **GLO** — As settings.highContrast. |
| `theme.highContrast.desc` ⚑7 | Erişilebilirlik teması: güçlü kenarlıklar, yüksek mürekkep kontrastı, net odak. | Erişilebilirlik teması: belirgin kenarlıklar, yüksek metin karşıtlığı, net odak. | **ERR** — 'mürekkep kontrastı' is literally 'ink contrast'. |

### `themeStudio.*` (5)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `themeStudio.systemDesc` † | İşletim sisteminin açık/koyu tercihini izle (Qutra Labs görünümü). | Windows'un açık/koyu mod tercihini izler (Qutra Labs görünümü). | **REG** — Bare imperative inside a description. |
| `themeStudio.lightAt` | Açık saati | Açık mod saati | **NAT** — Label beside a time picker. |
| `themeStudio.darkAt` | Koyu saati | Koyu mod saati | **NAT** — Label beside a time picker. |
| `themeStudio.packImportError` | That file is not a valid theme pack. | Bu dosya geçerli bir tema paketi değil. | **EN** — Left in English. |
| `themeStudio.packImportDeferred` | Custom pack install is not shipped yet — the file was validated only. | Özel renk paketleri henüz yüklenemiyor. Dosya denetlendi ama uygulanmadı. | **EN** — Left in English. Follows the English rewrite. |

### `appearance.*` (14)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `appearance.pack` | Color pack | Renk paketi | **EN** — Left in English. |
| `appearance.material` | Material | Pencere arka planı | **EN** — Left in English; 'Malzeme' would be meaningless here, so the label names what the setting changes. |
| `appearance.experimental` | experimental | deneysel | **EN** — Left in English. |
| `appearance.material.none` | Solid | Düz | **EN** — Left in English. |
| `appearance.material.none.desc` | Opaque window — no native transparency. | Opak pencere; Windows saydamlık efekti yok. | **EN** — Left in English. |
| `appearance.material.mica.desc` | Default native Windows backdrop (Windows 11). Falls back to solid on failure — never to Acrylic. | Windows 11'in standart pencere arka planı. Kullanılamıyorsa pencere düz kalır. | **EN** — Left in English. Follows the English rewrite. |
| `appearance.material.acrylic.desc` | Explicit experimental translucent backdrop. Not used as a Mica fallback. | Deneysel, yarı saydam arka plan. Yalnızca siz seçtiğinizde kullanılır. | **EN** — Left in English. Follows the English rewrite. |
| `appearance.material.liquidGlass.desc` | Qutra chrome frost inside the web scene — not Apple’s native material. | Uygulama penceresinin içinde çizilen buzlu cam görünümü. Apple'ın Liquid Glass'ı değildir. | **EN** — Left in English. Follows the English rewrite. |
| `appearance.reduceTransparency` | Reduce transparency | Saydamlığı azalt | **EN** — Left in English. |
| `appearance.reduceTransparency.hint` | Forces solid surfaces even when a material is selected. Preference intent is kept. | Bir pencere efekti seçili olsa bile tüm yüzeyleri düz tutar. Seçiminiz saklanır ve bunu kapattığınızda yeniden kullanılır. | **EN** — Left in English. Follows the English rewrite. |
| `appearance.fallbackHint` | Material reduced to solid for this environment | Seçili efekt burada kullanılamıyor, bu yüzden pencere düz gösteriliyor. | **EN** — Left in English. Follows the English rewrite. |
| `appearance.exportConfig` | Export appearance | Görünümü dışa aktar | **EN** — Left in English. |
| `appearance.importConfig` | Import appearance | Görünümü içe aktar | **EN** — Left in English. |
| `appearance.importPack` | Import pack | Paketi içe aktar | **EN** — Left in English. |

### `github.*` (11)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `github.connectDeviceFlow` | GitHub ile bağlan (device flow) | GitHub ile bağlan (cihaz kodu) | **SRC** — 'device flow' left in English. Follows the English rewrite. |
| `github.deviceFlowUnavailable` | Bu sürümde GitHub Device Flow kapalı. Aşağıdan ince ayrımlı kişisel erişim jetonu ile bağlanın. Giden HTTPS dar bir yerel broker üzerinden gider — renderer github.com’a erişemez. | GitHub cihaz koduyla oturum açma bu sürümde kullanılamıyor. Bunun yerine aşağıdaki ince ayarlı kişisel erişim belirtecini kullanın. | **IMPL** — 'dar yerel broker' and 'renderer' shown; token word unified. |
| `github.notConfigured` | Device flow için yapılandırılmış bir GitHub App client ID gerekir. Kurulum kılavuzuna bakın; bu arada aşağıdaki ince ayrımlı jetonu kullanın. | Cihaz koduyla oturum açmak için bir GitHub App gerekiyor ve henüz kurulmamış. Kurulum kılavuzuna bakın veya aşağıdaki ince ayarlı belirteci kullanın. | **IMPL** — 'client ID' and 'device flow' left in English. |
| `github.connectPat` | Geliştirici jetonu (fine-grained PAT) | İnce ayarlı kişisel erişim belirteci | **STALE** — 'Geliştirici jetonu (fine-grained PAT)' does not match the English. |
| `github.patHint` | Yalnızca geliştirme için. En az kapsamda salt okunur ince ayrımlı bir jeton kullanın. OS güvenli deposunda saklanır, asla veritabanında değil. | Salt okunur erişimli ve en az izinli, ince ayarlı (fine-grained) bir belirteç oluşturun. Belirteç Windows Kimlik Bilgisi Yöneticisi'nde saklanır; veritabanına veya dışa aktarımlara asla yazılmaz. | **STALE** — 'Yalnızca geliştirme için' is not in the English; 'OS güvenli deposu'. |
| `github.patInvalid` | Bu bir GitHub jetonuna benzemiyor. | Bu bir GitHub belirtecine benzemiyor. | **GLO** — jeton → belirteç. |
| `github.connectFailed` | Jeton güvenli biçimde saklanamadı. | Belirteç güvenli biçimde saklanamadı. | **GLO** — jeton → belirteç. |
| `github.demoBanner` | Demo verisi — canlı bir GitHub hesabı değil. | Demo verisi. Canlı bir GitHub hesabı değil. | **NAT** — Spaced em dash. |
| `github.contributionsNote` | Sayımlar mevcut son bir yıllık katkı verisinden gelir. | Sayılar, kullanılabilir son bir yıllık katkı verisine dayanır. | **NAT** — 'Sayımlar ... gelir' is a calque. |
| `github.fork` | Çatal | Fork | **NAT** — 'Çatal' is cutlery; GitHub's own UI says 'Fork'. |
| `github.stateHint` | Mümkün olan yerde önbellek verisi gösterilir. | Mümkün olduğunda önbellekteki veriler gösterilir. | **NAT** — 'Mümkün olan yerde' is a calque. |

### `tools.*` (9)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `tools.enableTitle` ⚑1 | Özel Siber Lab | Private Lab | **GLO** — English is 'Private Cyber Lab'; the product term is 'Private Lab'. |
| `tools.enableBody` ⚑1 | Yerel araçlar ve etkileşimli terminal için Private Lab'i etkinleştir. Bu, asistanı açmaz ve bir dil modelinin araç önermesine izin vermez. Rust, execute anında onayı yeniden kontrol eder. | Yerel araçları ve etkileşimli terminali kullanmak için Private Lab'ı etkinleştirin. Bu, asistanı açmaz ve bir dil modelinin araç önermesine izin vermez. Erişim, bir araç her çalıştırıldığında yeniden denetlenir. | **IMPL, REG** — Rust/'execute' leaked; 'Lab'i' suffix error; 'etkinleştir' in a sentence is the 'sen' form. |
| `tools.enable` ⚑1 | Özel Lab'ı etkinleştir | Private Lab'ı etkinleştir | **GLO** — Was 'Özel Lab'ı'; the same button on the Terminal page read 'Private Lab'i'. Pinned by e2e/lab.spec.ts:159 (English). |
| `tools.stoppedNote` | Acil durdurma etkin — araç çalıştırmaları engellendi. Devam etmek için kapatın. | Acil durdurma etkin; araç çalıştırmaları engellendi. Devam etmek için kapatın. | **NAT** — Spaced em dash. |
| `tools.localOnly` | Yalnızca yerel, savunma amaçlı, yetki bağlı. | Yalnızca yerelde, savunma amacıyla ve yetki dahilinde kullanılır. | **NAT** — Word for word; carried no meaning. |
| `tools.summary` | {working} yerleşik çalışıyor · {planned} planlandı · {adapter} harici adaptör | {working} yerleşik araç çalışıyor · {planned} planlandı · {adapter} harici araç | **NAT** — 'adaptör' is the 'Harici araç' badge. |
| `tools.nativeLibraryTitle` | Yerel araç kitaplığı | Araç kitaplığı | **SRC** — 'Yerel' (native) removed; same place as the Lab's tool library. |
| `tools.nativeLibraryHint` | İncelenmiş yürütülebilirleri Security Lab üzerinden kaydedip çalıştırın. Bu sayfa çevrimdışı yerleşik araçları ve kataloğu tutar. | İncelenmiş çalıştırılabilir dosyaları Güvenlik Laboratuvarı'ndan ekleyin ve çalıştırın. Bu sayfada çevrimdışı yerleşik araçlar ve katalog yer alır. | **EN** — 'Security Lab' is 'Güvenlik Laboratuvarı' in the menu; 'yürütülebilirleri' is a noun made from an adjective. |
| `tools.openLabLibrary` | Lab kitaplığını aç | Araç kitaplığını aç | **GLO** — 'Lab library' and 'tool library' are one place. |

### `lab.*` (22)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `lab.subtitle` † | Yetkili, önce-yerel güvenlik çalışmaları. Hedefler, herhangi bir şey çalışmadan önce kapsama göre denetlenir. | Yetkili ve yerelde yürütülen güvenlik çalışmaları. Bir araç çalışmadan önce hedefler kapsama göre denetlenir. | **NAT** — 'önce-yerel' is not Turkish. |
| `lab.engagementName` ⚑4 | Çalışma başlığı | Güvenlik çalışması başlığı | **GLO** — As lab.engagement. |
| `lab.decision.excluded` | Engellendi · hariç | Engellendi · hariç tutuldu | **NAT** — 'hariç' alone is cut off. |
| `lab.decision.no_acknowledgment` ‡ | Engellendi · onaylanmadı | Engellendi · yetki beyanı yok | **GLO** — 'onaylanmadı' blurs consent and approval; the user declares authorization. Pinned by e2e/lab.spec.ts:283. |
| `lab.engagement` ⚑4 | Çalışma | Güvenlik çalışması | **GLO** — Bare 'Çalışma' collides with workspace and work. |
| `lab.scopeStatus.not_configured` | Yapılandırılmadı | Tanımlanmadı | **NAT** — 'Yapılandırılmadı' is heavy for a scope. |
| `lab.scopeStatus.acknowledgement_required` | Onay gerekli | Yetki beyanı gerekli | **GLO** — The user declares they are authorized; this is not an approval. |
| `lab.header.activeRuns` | aktif çalıştırma | etkin çalıştırma | **GLO** — 'aktif' / 'etkin': one form. |
| `lab.findings.filterSeverity` | Öneme göre süz | Önem derecesine göre filtrele | **GLO** — 'süz' vs 'filtrele': one verb. |
| `lab.findings.filterStatus` | Duruma göre süz | Duruma göre filtrele | **GLO** — 'süz' vs 'filtrele': one verb. |
| `lab.findings.filterSource` | Kaynak araca göre süz | Kaynak araca göre filtrele | **GLO** — 'süz' vs 'filtrele': one verb. |
| `lab.findings.allSeverity` | Tüm önemler | Tüm önem dereceleri | **GLO** — 'Tüm önemler' is incomplete. |
| `lab.method.remediation` | Giderme not edildi | Düzeltme notu eklendi | **NAT** — 'Giderme not edildi' is unreadable. |
| `lab.overview.findingSummary` | Öneme göre bulgular | Önem derecesine göre bulgular | **GLO** — 'Öneme göre' is incomplete. |
| `lab.report.title` ⚑4 | Engagement raporu | Güvenlik çalışması raporu | **EN** — Left in English. |
| `lab.report.hint` | Mevcut bulgular ve dahil edilen kanıtlardan Markdown raporu dışa aktarın. Rapor meta verisi yerel saklanır. | Mevcut bulgulardan ve dahil edilen kanıtlardan Markdown raporu dışa aktarın. Raporun meta verileri bu bilgisayarda saklanır. | **NAT** — 'yerel saklanır' is malformed. |
| `lab.report.exportMarkdown` | Markdown dışa aktar | Markdown olarak dışa aktar | **NAT** — A label, not a fragment. |
| `lab.runState.queued` | Sırada | Kuyrukta | **GLO** — Restore uses 'Kuyrukta'; 'Sırada' was a second name. |
| `lab.runState.orphaned` | Yarım kaldı | Kesintiye uğradı | **GLO** — English is 'Interrupted'; 'Yarım kaldı' suggests something else. |
| `lab.findingStatus.confirmed` | Doğrulandı | Teyit edildi | **GLO** — 'Doğrulandı' collided with 'verified' in the same list. |
| `lab.findingStatus.verified` | Kontrol edildi | Doğrulandı | **GLO** — 'Kontrol edildi' is weak; the fix was re-tested and confirmed. |
| `lab.contextViews` | Laboratuvar görünümleri | Güvenlik Laboratuvarı görünümleri | **SRC** — 'Laboratuvar' / 'Güvenlik Laboratuvarı': one name. |

### `lab.tools.*` (34)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `lab.tools.emptyHint` | Zararsız bir çalıştırılabilir dosya seçin, kimliğini inceleyin ve tür güvenli bir çalışma profili oluşturun. | Zararsız bir çalıştırılabilir dosya seçin, kimliğini inceleyin ve bir çalıştırma profili oluşturun. | **IMPL** — 'tür güvenli' (typed) removed. Follows the English rewrite. |
| `lab.tools.fixtureHint` | Referans adaptör: src-tauri/fixtures/contextos_fixture.rs dosyasını derleyin (echo/sleep) ve .exe dosyasını burada kaydedin. Çevrimdışı yardımcılar Tools altındadır. | Örnek program: src-tauri/fixtures/contextos_fixture.rs dosyasını derleyin (yalnızca metni yankılar ve bekler) ve oluşan .exe dosyasını buraya ekleyin. Çevrimdışı yardımcılar Araçlar bölümündedir. | **EN** — 'Tools altındadır' (menu says 'Araçlar'), 'adaptör'. File path kept exactly (i18n.test.ts). |
| `lab.tools.openOfflineTools` | Çevrimdışı Tools'u aç | Çevrimdışı araçları aç | **ERR** — English word plus suffix; the menu says 'Araçlar'. |
| `lab.tools.desktopRequired` | Yerel araç çalıştırmak için masaüstü uygulaması gerekir | Araç çalıştırmak için masaüstü uygulaması gerekir | **SRC** — 'Yerel' (native) removed. Pinned by e2e/lab.spec.ts:104 (English). |
| `lab.tools.desktopRequiredHint` | Tarayıcı modu yerel dosya seçemez, kaydedemez veya çalıştıramaz; başarılı çalıştırma taklidi de yapmaz. | Tarayıcı sürümü yerel dosya seçemez, kitaplığa ekleyemez veya çalıştıramaz; çalıştırma başarılı olmuş gibi de göstermez. | **GLO** — 'kaydedemez' reads as Save. |
| `lab.tools.unavailableCopyFixture` | Fixture yolunu kopyala | Örnek program yolunu kopyala | **EN** — 'Fixture' left in English. |
| `lab.tools.unavailableOfflineBody` | Kodlama, özet, JWT, regex ve entropi araçları tamamen bu derlemede çalışır. Yerel süreç gerektirmedikleri için bu sınırdan etkilenmezler. | Kodlama, hash, JWT, regex ve entropi araçları uygulamanın içinde çalışır; bu sınırlama onlar için geçerli değildir. | **GLO** — 'özet' reads as 'summary'; 'derleme', 'yerel süreç'. |
| `lab.tools.unavailableDesktopTitle` | Yerel çalıştırma masaüstü derlemesi ister | Araç çalıştırmak masaüstü uygulaması gerektirir | **NAT** — 'derlemesi ister' is unnatural. Pinned by e2e/lab.spec.ts:115 (English). |
| `lab.tools.unavailableDesktopBody` ⚑1 | Tauri masaüstü uygulamasını çalıştırın, ardından Private Lab'i etkinleştirin. Yerel bir çalıştırılabilir dosyayı yalnızca masaüstü derlemesi inceleyebilir, kaydedebilir ve başlatabilir. | Masaüstü uygulamasını açın ve Private Lab'ı etkinleştirin. Yerel çalıştırılabilir dosyaları yalnızca masaüstü uygulaması inceleyebilir, kitaplığa ekleyebilir ve başlatabilir. | **IMPL** — 'Tauri'; 'Lab'i'. |
| `lab.tools.unavailableFixtureTitle` | Referans adaptörle başlayın | Örnek programla başlayın | **GLO** — 'Referans adaptör'. Pinned by e2e/lab.spec.ts:116, 137 (English). |
| `lab.tools.unavailableFixtureStep1` | Pakete dahil fixture'ı derleyin; yalnızca girdiyi yankılar ve bekler. | Uygulamayla gelen örnek programı derleyin. Yalnızca girdiyi yankılar ve bekler. | **EN** — 'fixture'ı' left in English. |
| `lab.tools.unavailableFixtureStep2` | Oluşan .exe dosyasını burada kaydedin ve kimliğini inceleyin. | Oluşan .exe dosyasını buraya ekleyin ve kimliğini inceleyin. | **GLO** — 'kaydedin' reads as Save. |
| `lab.tools.unavailableFixtureStep3` | Tipli bir çalıştırma profili oluşturup başlatın; bu güvenli bir ilk denemedir. | Bir çalıştırma profili oluşturup başlatın. Bu, güvenli bir ilk denemedir. | **IMPL** — 'Tipli' (typed). |
| `lab.tools.requireScope` | Güncel yetkilendirme kapsamı zorunlu | Geçerli bir yetki kapsamı zorunlu | **GLO** — Two names: 'yetkilendirme kapsamı' and 'yetki kapsamı'. |
| `lab.tools.launchedInteractive` | {name} bir terminal sekmesinde açılıyor... | {name} bir terminal sekmesinde açılıyor… | **NAT** — Single '…' character. |
| `lab.tools.launchReasonConsentRequired` ⚑1 | {name} başlatılmadan önce Private Lab onayı gereklidir. | {name} başlatılmadan önce Private Lab'ı etkinleştirin. | **GLO** — Says what to do instead of naming 'onay'. Follows the English rewrite; pinned by launchFailureMessage.test.ts:26 (English). |
| `lab.tools.launchReasonWorkingDirMissing` | {name} için kayıtlı çalışma dizini bulunamıyor. Araç kitaplığında güncelleyin. | {name} için kayıtlı çalışma klasörü bulunamıyor. Araç kitaplığında güncelleyin. | **GLO** — 'dizin' / 'klasör': one term. |
| `lab.tools.launchReasonWorkingDirNotFolder` | {name} için kayıtlı çalışma dizini bir klasör değil. Araç kitaplığında güncelleyin. | {name} için kayıtlı çalışma klasörü bir klasör değil. Araç kitaplığında güncelleyin. | **GLO** — 'dizin' / 'klasör': one term. |
| `lab.tools.launchReasonElevationRequired` | {name}, bu uygulamada bulunmayan yönetici ayrıcalıkları gerektiriyor. | {name} yönetici yetkisi gerektiriyor; bu uygulamada yönetici yetkisi yok. | **NAT** — 'bulunmayan ... ayrıcalıkları'; one word for privilege ('yetki'). |
| `lab.tools.launchFailedGeneric` | {name} başlatılamadı. Yeniden deneyin veya araç kitaplığında kimliğini kontrol edin. | {name} başlatılamadı. Yeniden deneyin veya araç kitaplığında kimliğini denetleyin. | **GLO** — 'kontrol edin' vs the button 'Kimliği denetle'. |
| `lab.tools.arguments` | Tür güvenli argümanlar | Argümanlar | **IMPL** — 'Tür güvenli' (typed). |
| `lab.tools.argumentsHint` | Her değer ayrı bir süreç argümanı olarak kalır; kabuk komutu oluşturulmaz. | Her değer programa ayrı bir argüman olarak iletilir. Girdinizden kabuk komutu oluşturulmaz. | **IMPL** — 'süreç argümanı' (process argument). |
| `lab.tools.commandPreview` | Kaçış uygulanmış komut önizlemesi | Komut önizlemesi | **IMPL** — 'Kaçış uygulanmış' (escaped). |
| `lab.tools.scopeRequired` | Bu profil için bir hedef argümanı ve etkin yetkilendirme kapsamı gerekir. | Bu profil için bir hedef argümanı ve etkin yetki kapsamı gerekir. | **GLO** — 'yetkilendirme kapsamı' → 'yetki kapsamı'. |
| `lab.tools.scopeBlocked` | Yetkilendirme kapsamı hedefi engelledi | Yetki kapsamı hedefi engelledi | **GLO** — As lab.tools.scopeRequired. |
| `lab.tools.runHistoryHint` | Toplu çalıştırmalar görünür, iptal edilebilir, sınırlandırılmış ve yerel olarak saklanır. GUI ve etkileşimli başlatmalar burada izlenmez. | Toplu çalıştırmalar görünür, iptal edilebilir, sınırlıdır ve yerelde saklanır. GUI ve etkileşimli başlatmalar burada izlenmez. | **NAT** — 'sınırlandırılmış' (bounded) is malformed. |
| `lab.tools.refresh` | Yerel durumu yenile | Yenile | **IMPL** — 'Yerel durumu yenile' (native state). |
| `lab.tools.noRuns` | Henüz yerel araç çalıştırılmadı. | Henüz araç çalıştırılmadı. | **IMPL** — 'yerel araç' (native tool runs). |
| `lab.tools.truncated` | çıktı sınırlandı | çıktı kesildi | **NAT** — 'sınırlandı' is not what happened; the output was cut. |
| `lab.tools.waitingOutput` | Çıktı bekleniyor... | Çıktı bekleniyor… | **NAT** — Single '…' character. |
| `lab.tools.deleteArtifacts` | Artefaktları sil | Çıktı dosyalarını sil | **EN** — 'Artefakt' is not Turkish IT vocabulary. |
| `lab.tools.deleteArtifactsConfirm` | Bu çalıştırmanın stdout ve stderr dosyaları silinsin mi? Çalıştırma geçmişi ve çıktı kuyrukları korunur. | Bu çalıştırmanın kaydedilmiş çıktı dosyaları silinsin mi? Çalıştırma geçmişi ve çıktının son satırları korunur. | **IMPL** — 'stdout ve stderr', 'çıktı kuyrukları'. |
| `lab.tools.confirmRegister` | Onayla ve kaydet | Onayla ve ekle | **GLO** — 'kaydet' reads as Save. |
| `lab.tools.registerNote` | Kayıt işlemi standartlaştırılmış dosya yolunu ve SHA-256 değerini özel uygulama verisi deposunda saklar. Değişen dosya, siz inceleyip açıkça güvenene kadar engellenir. | Bir araç eklendiğinde tam dosya yolu ve SHA-256 değeri uygulamanın özel verilerinde saklanır. Dosya sonradan değişirse, siz inceleyip yeniden güvenene kadar engellenir. | **IMPL** — 'standartlaştırılmış dosya yolu', 'uygulama verisi deposu' (canonical path, registry). |

### `workbench.*` (2)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `workbench.newTab` | Yeni sekme — ara veya komut çalıştır | Yeni sekme: arama yapın veya komut çalıştırın | **REG** — Bare imperatives inside a tooltip sentence. |
| `workbench.pinned` | Sabitlendi | Sabitlenmiş | **NAT** — A state adjective, not the past event. |

### `panel.*` (1)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `panel.outputOwnedHint` | Canlı stdout ve stderr ortak Çıktı panelinde gösterilir. | Canlı çıktı ve hata çıktısı Çıktı panelinde gösterilir. | **IMPL** — 'stdout ve stderr'. |

### `lab.insp.*` (5)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `lab.insp.workingDir` | Çıktı dizini | Çıktı klasörü | **GLO** — 'dizin' → 'klasör'. |
| `lab.insp.tab.remediation` | Giderme | Düzeltme | **GLO** — 'Giderme' alone is meaningless; TERMBASE.md says 'Düzeltme'. |
| `lab.insp.severity` | Önem | Önem derecesi | **GLO** — Bare 'Önem' is incomplete. |
| `lab.insp.remediationText` | Giderme | Düzeltme | **GLO** — TERMBASE.md: Remediation → Düzeltme. |
| `lab.insp.noArguments` | Yapılandırılmış tipli argüman yok. | Tanımlı argüman yok. | **IMPL** — 'tipli' (typed). |

### `files.*` (1)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `files.pickDesktopOnly` | Yerel yollara göz atmak masaüstü uygulamasını gerektirir — bunun yerine yol yazın | Yerel yollara göz atmak masaüstü uygulamasını gerektirir; bunun yerine yol yazın | **NAT** — Spaced em dash. |

### `terminal.*` (7)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `terminal.subtitle` ⚑8 | Araç çalıştırma konsolu — sistem kabuğu değil. | Araçlarınızı çalıştırmak için etkileşimli terminal. | **STALE** — The English claim 'not a system shell' looks false now (Open question 8). |
| `terminal.nativeRequired` | Yerel çalışma zamanı gerekli | Masaüstü uygulaması gerekli | **IMPL** — 'Yerel çalışma zamanı' is developer language. |
| `terminal.nativeRequiredHint` | Etkileşimli terminal yalnızca paketlenmiş masaüstü uygulamasında çalışır. | Etkileşimli terminal yalnızca kurulu masaüstü uygulamasında çalışır. | **IMPL** — 'paketlenmiş' (packaged). |
| `terminal.consentRequiredHint` ⚑1 | Terminal ve lab için Private Lab'i bir kez etkinleştir. Bu, asistanı açmaz ve bir dil modelinin araç önermesine izin vermez. | Terminal ve Güvenlik Laboratuvarı için Private Lab'ı bir kez etkinleştirin. Bu, asistanı açmaz ve bir dil modelinin araç önermesine izin vermez. | **REG** — 'etkinleştir' is the 'sen' form; 'Lab'i'; bare 'lab'. |
| `terminal.enable` † ⚑1 | Private Lab'i etkinleştir | Private Lab'ı etkinleştir | **ERR** — 'Lab'i' → 'Lab'ı'. |
| `terminal.sessionGone` | Bu oturum artık çalışmıyor. Sekmeyi kapat veya yeni bir terminal aç. | Bu terminal oturumu artık çalışmıyor. Sekmeyi kapatın veya yeni bir terminal açın. | **REG** — 'kapat' and 'aç' are 'sen' forms. |
| `terminal.scrollbackFailed` | Bu oturumun çıktısı okunamadı. Terminal hâlâ çalışıyor olabilir — yeniden dene veya sekmeyi kapat. | Bu terminal oturumunun çıktısı okunamadı. Terminal hâlâ çalışıyor olabilir; yeniden deneyin veya sekmeyi kapatın. | **REG** — 'yeniden dene' and 'kapat' are 'sen' forms. |

### `localAssistant.*` (15)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `localAssistant.endpointPinned` | Uç nokta güvenlik için sabittir. Farklı bir kayıtlı değer yok sayılır. | Güvenlik nedeniyle bu adres değiştirilemez. Kayıtlı başka bir değer yok sayılır. | **IMPL** — 'Uç nokta' (endpoint). |
| `localAssistant.historyRetained` | {count} mesaj siz silene kadar bu makinede saklanır. | {count} mesaj, siz silene kadar bu bilgisayarda saklanır. | **GLO** — 'makine' → 'bilgisayar'. |
| `localAssistant.desktopOnly` | Qutra masaüstü uygulaması üzerinden çalışır. Bu derlemede yerel broker yok. | Qutra yalnızca masaüstü uygulamasında çalışır. Tarayıcı sürümü ona erişemez. | **IMPL** — 'yerel broker'. Pinned by LocalAssistantChat.browser.test.tsx:58 (English). |
| `localAssistant.modelPullHint` ⚑readiness | Tam olarak bu modeli istiyorsanız önce izole laboratuvara kurun: | Tam olarak bu modeli kullanmak için önce Ollama'ya kurun: | **IMPL** — 'izole laboratuvar' (the readiness work removes it). |
| `localAssistant.sectionHint` ⚑readiness | Qutra tamamen bu makinede, geri döngü adresindeki izole yerel Ollama ile çalışır. Bulut ve telemetri yoktur; hiçbir veri bu bilgisayardan çıkmaz. | Qutra yalnızca yerel bir Ollama ile, 127.0.0.1:11434 veya 127.0.0.1:11435 adresinde konuşur ve telemetri göndermez. O adreste yanıt veren program konuşmanızı alır; Qutra bu programın ne olduğunu doğrulayamaz. | **IMPL** — 'geri döngü', 'izole'; the readiness work already drops 'isolated'. **Replacement changed 2026-09-30 (security review #1):** the first proposal kept the unconditional privacy promise; the listener on those ports is unauthenticated, so the promise is unsupported (ADR 0010, amendment of 2026-09-30). |
| `localAssistant.enableHint` | Bu kapalıyken uygulama uç noktaya hiçbir istek yapmaz; sağlık kontrolü bile. | Bu kapalıyken uygulama Ollama'ya hiçbir şey göndermez; durum denetimi bile yapmaz. | **IMPL** — 'uç noktaya istek' (request to the endpoint). |
| `localAssistant.offlineHint` ⚑readiness | 127.0.0.1:11435 üzerinde dinleyen bir süreç yok. İzole laboratuvarı başlatın, sonra yeniden deneyin. | Qutra bu bilgisayardaki Ollama'ya ulaşamıyor. Ollama'yı başlatın, sonra yeniden deneyin. | **IMPL** — 'dinleyen bir süreç yok' plus a hard-coded port; the readiness work moves to two endpoints. |
| `localAssistant.retry` | Tekrar dene | Yeniden dene | **GLO** — 'Tekrar dene' / 'Yeniden dene': one form. |
| `localAssistant.baseUrl` | Uç nokta (yalnızca geri döngü) | Adres (yalnızca bu bilgisayar) | **IMPL** — 'Uç nokta (geri döngü)'. Pinned by e2e/local-assistant.spec.ts:114 (English). |
| `localAssistant.chatPlaceholder` | Qutra'ya sorun... | Qutra'ya sorun… | **NAT** — Single '…' character. |
| `localAssistant.thinking` | Üretiliyor... | Yanıt hazırlanıyor… | **NAT** — 'Üretiliyor' is technical; single '…'. |
| `localAssistant.historyLocal` | Bu konuşma yalnızca bu makinede saklanır. | Bu konuşma yalnızca bu bilgisayarda saklanır. | **GLO** — 'makine' → 'bilgisayar'. |
| `localAssistant.agentToggle` † | Qutra'nın eylem önermesine izin verin | Qutra'nın eylem önermesine izin ver | **REG** — A toggle label uses the bare stem. |
| `localAssistant.agentToggleHint` | Varsayılan olarak kapalıdır. Açıldığında Qutra bir uçbirim komutu çalıştırmayı, kayıtlı bir aracı başlatmayı veya proje bağlamını okumayı önerebilir. Uçbirim komutları ve araç başlatmaları, bu ayardan bağımsız olarak her zaman önce onayınızı gerektirir. | Varsayılan olarak kapalıdır. Açıldığında Qutra bir terminal komutu çalıştırmayı, kayıtlı bir aracı başlatmayı veya proje bağlamını okumayı önerebilir. Terminal komutları ve araç başlatmaları, bu ayardan bağımsız olarak her zaman önce onayınızı gerektirir. | **GLO** — 'uçbirim'; the menu says 'Terminal'. |
| `localAssistant.autoApproveReadsToggleHint` | Onay istemini yalnızca salt okunur proje bağlamı sorguları için atlar. Uçbirim komutları ve araç başlatmaları yine her zaman onayınızı gerektirir. Aracı eylemleri açık değilse bir etkisi olmaz. | Onay istemini yalnızca salt okunur proje bağlamı sorguları için atlar. Terminal komutları ve araç başlatmaları yine her zaman onayınızı gerektirir. Araç önerileri açık değilse bir etkisi olmaz. | **GLO** — 'Uçbirim'; 'Aracı eylemleri' (agent). |

### `qutra.*` (3)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `qutra.contextToggle` | Aktif proje bağlamını ekle | Etkin proje bağlamını ekle | **GLO** — 'aktif' → 'etkin'. |
| `qutra.contextEmpty` | Eklenecek aktif proje yok. | Eklenecek etkin proje yok. | **GLO** — 'aktif' → 'etkin'. |
| `qutra.contextTruncated` | Sınırlar içinde kalmak için bir kısmı kısaltıldı. | Bağlamın bir kısmı, sınırlar içinde kalmak için kısaltıldı. | **NAT** — The subject was missing. |

### `jarvis.*` (22)

| Key | Current | Proposed | Why |
|---|---|---|---|
| `jarvis.approval.pending` | Sonuç bekleniyor... | Sonuç bekleniyor… | **NAT** — Single '…' character. |
| `jarvis.approval.timedOut` | Bu öneri siz yanıt vermeden zaman aşımına uğradı. | Bu öneri, siz yanıt vermeden önce zaman aşımına uğradı. | **NAT** — Smoother clause order. |
| `jarvis.model.agentNeedsTools` | Ajan eylemleri açık, ancak bu model araç çağırmayı desteklemiyor. Yine de normal şekilde yanıt verir — yalnızca komut veya araç başlatma öneremez. | Araç önerileri açık, ancak bu model araç kullanamıyor. Yine de normal şekilde yanıt verir; yalnızca komut veya araç başlatma öneremez. | **GLO** — 'Ajan eylemleri' here, 'aracı eylemleri' elsewhere; both mean 'agent'. |
| `jarvis.model.unreachable` ⚑readiness | Laboratuvara ulaşılamadığı için model listesi okunamadı. Mevcut modeliniz seçili kalır. | Ollama'ya ulaşılamadığı için model listesi okunamadı. Seçili modeliniz değişmeden kalır. | **GLO** — 'Laboratuvar' collides with Güvenlik Laboratuvarı (readiness work). |
| `jarvis.error.busy` | Qutra zaten başka bir şeyi yanıtlıyor. Bunun bitmesini bekleyin. | Qutra şu anda başka bir isteği yanıtlıyor. Bitmesini bekleyin. | **NAT** — 'başka bir şeyi' is an English 'something else'. |
| `jarvis.error.invalidModel` | Herhangi bir model adı ayarlanmadı. | Model adı ayarlanmadı. | **NAT** — 'Herhangi bir' is a calque. |
| `jarvis.error.timeoutHealth` ⚑readiness | Qutra zamanında yanıt vermedi. İzole sunucunun çalıştığından emin olun. | Qutra zamanında yanıt vermedi. Ollama'nın çalıştığından emin olun. | **IMPL** — 'izole sunucu' (readiness work). |
| `jarvis.error.timeoutTurn` | Bu tur, bekleyen bir onay dahil, süresini doldurdu. | Bu adım, bekleyen onayın süresi de dahil, zaman aşımına uğradı. | **NAT** — 'tur süresini doldurdu' is a calque of 'turn ran out of time'. |
| `jarvis.error.consentRequired` ⚑1 | Bu işlem önce Özel Laboratuvar onayını gerektiriyor. | Bu işlem için önce Private Lab'ı etkinleştirmeniz gerekir. | **GLO** — 'Özel Laboratuvar onayı' was a third name for Private Lab. |
| `jarvis.error.unknownTool` | Qutra, izin verilen araçların dışında bir eylem önerdi ve reddedildi. | Qutra, izin verilen araçların dışında bir eylem önerdi; öneri reddedildi. | **NAT** — 've reddedildi' has no subject. |
| `jarvis.error.elevationRequired` | Onaylanan eylem, bu uygulamada bulunmayan yönetici ayrıcalıkları gerektiriyor. Yükseltilmiş olarak çalıştırmak isterseniz kendiniz başlatın. | Onaylanan eylem için yönetici yetkisi gerekiyor; bu uygulamada yönetici yetkisi yok. Yönetici olarak çalıştırmak isterseniz kendiniz başlatın. | **GLO** — 'ayrıcalık' vs 'yetki'; 'yükseltilmiş' (elevated). |
| `jarvis.error.tooManySteps` | Qutra art arda çok fazla adım denedi, bu yüzden tur durduruldu. | Qutra art arda çok fazla adım denediği için işlem durduruldu. | **NAT** — 'tur' (turn). |
| `jarvis.error.modelToolsUnsupported` | Seçtiğiniz model, aracı eylemleriyle kullanılamaz. Farklı, araç kullanabilen bir model seçin veya Ayarlar'dan aracı eylemlerini kapatın. | Seçtiğiniz model araç önerileriyle kullanılamaz. Araç desteği olan başka bir model seçin veya Ayarlar'dan araç önerilerini kapatın. | **GLO** — 'aracı eylemleri' means 'intermediary actions'. |
| `jarvis.error.generic` | Bir şeyler ters gitti. Tekrar deneyin. | Bir şeyler ters gitti. Yeniden deneyin. | **GLO** — 'Tekrar' → 'Yeniden'. |
| `jarvis.setup.endpointDisclosure` ⚑readiness | Qutra 127.0.0.1:11435 kullanır. Gönderdiğin iletiler ve bu ekranda gösterilen bağlam o yerel modele gider. | Qutra 127.0.0.1:11435 adresini kullanır. Gönderdiğiniz iletiler ve bu ekranda gösterilen bağlam bu yerel modele gider. | **REG** — 'Gönderdiğin' is the 'sen' form (the address changes in the readiness work). |
| `jarvis.setup.toolProposalsExplain` | Model uçbirim komutları, kayıtlı araçların başlatılması ve uygulama bağlamının sınırlı okunmasını önerebilir. Uçbirim komutları ve araç başlatmaları her seferinde onayını gerektirir. Bu, okumaların otomatik onayını açmaz — o tercih ayrı kalır. | Model, terminal komutları çalıştırmayı, kayıtlı araçları başlatmayı ve uygulama bağlamını sınırlı ölçüde okumayı önerebilir. Terminal komutları ve araç başlatmaları her seferinde onayınızı gerektirir. Bu ayar, okumaların otomatik onayını açmaz; o tercih ayrıdır. | **REG** — 'onayını' is the 'sen' form; the noun phrase was broken. |
| `jarvis.setup.q2Body` ⚑1 ⚑12 | Araç önerilerine izin var, ancak Private Lab kapalıyken çalışamazlar. Private Lab'i açmak bu makinedeki yerel onay yolundan geçer. | Araç önerilerine izin veriliyor, ancak Private Lab kapalıyken çalıştırılamazlar. Private Lab'ı açmak, bu bilgisayarda bir onay penceresi gösterir. | **IMPL** — 'yerel onay yolu' (native consent path); 'Lab'i'. |
| `jarvis.restore.action` | Araç önerilerini geri yükle | Araç önerilerini yeniden aç | **NAT** — 'geri yükle' suggests restore-from-backup. |
| `jarvis.restore.autoApproveOn` | Salt okunur bağlam sorguları şu anda otomatik onaylı. Araç önerilerini geri yüklemek bunu değiştirmez. Uçbirim komutları ve araç başlatmaları yine her seferinde onayını gerektirir. | Salt okunur bağlam sorguları şu anda otomatik onaylanıyor. Araç önerilerini yeniden açmak bunu değiştirmez. Terminal komutları ve araç başlatmaları yine her seferinde onayınızı gerektirir. | **REG** — 'onayını' is the 'sen' form; 'Uçbirim'. |
| `jarvis.permission.nativeUnavailable` ⚑1 ⚑12 | Bu derleme yerel onayı tamamlayamaz. Private Lab kapalı kalır. | Bu sürüm onay penceresini gösteremiyor. Private Lab kapalı kalır. | **IMPL** — 'yerel onay' (native acknowledgement). |
| `jarvis.permission.nativeDeclined` ⚑1 ⚑12 | Yerel onay verilmedi. Private Lab kapalı kalır. | Onay verilmedi. Private Lab kapalı kalır. | **IMPL** — 'Yerel onay' (native acknowledgement). |
| `jarvis.mode.answerOnlyComplete` | Yalnızca yanıt, eksiksiz desteklenen bir kiptir. | Yalnızca yanıt modu tam olarak desteklenir. | **GLO** — 'kip' → 'mod'. |

### Casing only (optional, 8)

Generic labels in Title Case, changed to sentence case. Apply after question 6.

| Key | Current | Proposed |
|---|---|---|
| `ws.tab.overview` | Genel Bakış | Genel bakış |
| `ws.tab.snapshots` | Anlık Görüntüler | Anlık görüntüler |
| `lab.view.overview` | Genel Bakış | Genel bakış |
| `lab.insp.tab.overview` | Genel Bakış | Genel bakış |
| `lab.view.scope` ‡ | Kapsam ve Hedefler | Kapsam ve hedefler |
| `lab.nav.utilities` † | Yardımcı Araçlar | Yardımcı araçlar |
| `snapshot.title` † | Anlık Görüntüler | Anlık görüntüler |
| `lab.engagements` † ⚑4 | Güvenlik Çalışmaları | Güvenlik çalışmaları |

## 5. English rewrites

Where the English source talks about how the app is built, is stale, or names one thing three ways, the Turkish should translate what the user needs, so the English changes first. Same rules: calm, exact, short; `{placeholders}` and brand tokens unchanged.

| Key | Current | Proposed | Why |
|---|---|---|---|
| `capture.saved` | Captured to inbox | Task added | **STALE** — FocusPage.tsx:75-80 calls addTask() and shows this toast; the inbox concept was retired |
| `settings.advanced.enforcementHint` ⚑1 | These three switches are independent. The mode choice on the Assistant surface edits the same three values; it is not a fourth stored switch. Turning off Local assistant or Private Lab may leave tool proposals saved but inactive. | These three switches work independently. The mode you pick on the Assistant screen changes the same three switches. If you turn off the local assistant or Private Lab, tool proposals stay saved but stop working. | **IMPL** — 'surface', 'stored switch', 'values' |
| `settings.advanced.privateLabHint` | Native tools, the interactive terminal, and the lab library. Rust still re-checks consent at execute. | Local tools, the interactive terminal and the tool library. Access is checked again each time a tool runs. | **IMPL** — 'Rust still re-checks consent at execute' states the guarantee in developer terms |
| `settings.startOnLoginHint` | Not available in this build — OS autostart is not wired yet. | Not available in this version yet. | **IMPL** — 'OS autostart is not wired yet' |
| `settings.migration` | Schema version | Database version | **IMPL** — 'Schema version' |
| `settings.exportAllHint` | Includes preferences and local collections. OS secure-store secrets (e.g. GitHub tokens) are never included. | Includes preferences and local collections. Secrets kept in Windows Credential Manager, such as GitHub tokens, are never exported. | **IMPL** — 'OS secure-store secrets'; keyring uses windows-native (Cargo.toml:37) |
| `settings.aiNoneHint` | Cloud drafting is not wired up in this build. For a real assistant, use the Local Assistant Lab above - it runs entirely on this machine. | Cloud drafting isn't available in this version. To use an assistant, turn on the local assistant above; it runs entirely on this computer. | **IMPL** — 'not wired up', 'Local Assistant Lab' (a third 'Lab') |
| `settings.aiSecureReady` | OS secure storage is available for future provider credentials. | Windows Credential Manager is available for future provider credentials. | **IMPL** — 'OS secure storage' |
| `settings.aiSecureUnavailable` | OS secure storage is unavailable in this runtime — credentials cannot be stored. | Secure credential storage isn't available here, so credentials can't be saved. | **IMPL** — 'this runtime' |
| `settings.aiProvidersDeferred` | Cloud provider wiring stays deferred. The Local Assistant Lab is separate, local-only and opt-in. | Cloud providers aren't supported yet. The local assistant is separate, runs only on this computer and stays off until you turn it on. | **IMPL** — 'wiring stays deferred', 'Lab' |
| `settings.aiCredential` | Credential stored in OS secure storage | Credential stored in Windows Credential Manager | **IMPL** — 'OS secure storage' |
| `settings.notif.osUnavailable` | OS notifications are not available in this runtime. | System notifications aren't available here. | **IMPL** — 'in this runtime' |
| `settings.about.mode` | Runtime | App type | **IMPL** — 'Runtime' |
| `settings.about.modeBrowser` | Browser demo (native integrations simulated) | Browser demo (Windows features simulated) | **IMPL** — 'native integrations' |
| `settings.about.modeDesktop` | Desktop (Tauri) | Desktop app | **IMPL** — '(Tauri)' names the framework |
| `settings.about.storage` | Storage backend | Storage type | **IMPL** — 'Storage backend' |
| `privacy.noOutbound` | Network requests are not centrally counted. GitHub uses its native broker, and Qutra uses only the loopback endpoint you enable. | Requests aren't counted in one place. GitHub calls go through the desktop app, and Qutra talks only to the local address you enable. | **IMPL** — 'native broker', 'loopback endpoint' |
| `perm.test` | Probe OS capability | Check Windows permission | **IMPL** — 'Probe OS capability' |
| `perm.testSkipped` | No OS probe for this local consent key. | There is nothing to check in Windows for this permission. | **IMPL** — 'No OS probe for this local consent key' |
| `assistant.noProvider` | No cloud provider. Enable the Local Assistant Lab in Settings for a local model, or keep using these deterministic summaries. | No cloud provider is set up. Turn on the local assistant in Settings to use a local model, or keep using these built-in summaries. | **IMPL** — 'deterministic summaries', 'Local Assistant Lab' |
| `notFound.back` | Go to Today | Go to Home | **STALE** — NotFoundPage.tsx:16 links to /overview (Home); there is no Today screen |
| `theme.catppuccin.desc` | Offline-mapped Catppuccin Latte (light) / Mocha (dark) semantic pack. | Catppuccin colors: Latte for light mode, Mocha for dark mode. Works offline. | **IMPL** — 'Offline-mapped ... semantic pack' |
| `theme.windows.desc` | Legacy label: use Material → Mica. Acrylic is an explicit experimental choice only. | Older option. Choose Mica or Acrylic under Material instead. | **IMPL** — 'Legacy label' is a developer note |
| `theme.windows.browserHint` | Native Windows materials only appear in the packaged desktop app — the browser preview stays solid. | Windows window effects appear only in the desktop app. The browser preview stays solid. | **IMPL** — 'Native Windows materials ... packaged' |
| `themeStudio.packImportDeferred` | Custom pack install is not shipped yet — the file was validated only. | Custom color packs can't be installed yet. The file was checked but not applied. | **IMPL** — 'is not shipped yet ... validated only' |
| `appearance.material.mica.desc` | Default native Windows backdrop (Windows 11). Falls back to solid on failure — never to Acrylic. | Windows 11's standard window backdrop. If it isn't available, the window stays solid. | **IMPL** — 'Falls back to solid on failure — never to Acrylic' |
| `appearance.material.acrylic.desc` | Explicit experimental translucent backdrop. Not used as a Mica fallback. | Experimental translucent backdrop. Used only when you choose it. | **IMPL** — 'Not used as a Mica fallback' |
| `appearance.material.liquidGlass.desc` | Qutra chrome frost inside the web scene — not Apple’s native material. | A frosted-glass look drawn inside the app window. It is not Apple's Liquid Glass. | **IMPL** — 'Qutra chrome frost inside the web scene' |
| `appearance.reduceTransparency.hint` | Forces solid surfaces even when a material is selected. Preference intent is kept. | Keeps every surface solid, even when a window effect is selected. Your choice is remembered and used again when you turn this off. | **IMPL** — 'Preference intent is kept' |
| `appearance.fallbackHint` | Material reduced to solid for this environment | The selected effect isn't available here, so the window is solid. | **IMPL** — 'Material reduced to solid for this environment' |
| `github.connectDeviceFlow` | Connect with GitHub (device flow) | Connect with GitHub (device code) | **IMPL** — 'device flow' is OAuth jargon |
| `github.deviceFlowUnavailable` | GitHub Device Flow is not enabled in this build. Connect with a fine-grained personal access token below. Outbound HTTPS uses a narrow native broker — the renderer cannot reach github.com. | Signing in with a GitHub device code isn't available in this version. Use a fine-grained personal access token below instead. | **IMPL** — 'narrow native broker', 'the renderer cannot reach github.com' |
| `github.notConfigured` | Device flow needs a configured GitHub App client ID. See the setup guide; use a fine-grained token below meanwhile. | Device-code sign-in needs a GitHub App that hasn't been set up yet. See the setup guide, or use a fine-grained token below. | **IMPL** — 'configured GitHub App client ID' |
| `github.patHint` | Fine-grained token with read-only access to the minimum scopes. Stored in the OS secure store, never in the database or exports. Desktop API calls go through the native broker. | Create a fine-grained token with read-only access and the fewest permissions needed. It is stored in Windows Credential Manager, never in the database or in exports. | **IMPL** — 'Desktop API calls go through the native broker' |
| `tools.enableTitle` ⚑1 | Private Cyber Lab | Private Lab | **GLO** — 'Private Cyber Lab' vs 'Private Lab' vs 'the Private Lab' |
| `tools.enableBody` ⚑1 | Enable Private Lab for native tools and the interactive terminal. This does not turn on the assistant, and it does not let a language model propose tools. Rust still re-checks consent at execute. | Enable Private Lab to use local tools and the interactive terminal. This does not turn on the assistant or let a language model propose tools. Access is checked again each time a tool runs. | **IMPL** — 'Rust still re-checks consent at execute' |
| `tools.enable` ‡ ⚑1 | Enable the Private Lab | Enable Private Lab | **GLO** — matches terminal.enable |
| `tools.nativeLibraryTitle` | Native tool library | Tool library | **IMPL** — 'Native' |
| `tools.nativeLibraryHint` | Register and run reviewed executables from Security Lab. This page keeps offline built-ins and the catalog. | Add and run reviewed executables from Security Lab. This page holds the offline built-in tools and the catalog. | **IMPL** — 'Register', 'keeps offline built-ins' |
| `tools.openLabLibrary` | Open Lab library | Open tool library | **GLO** — 'Lab library' and 'tool library' are one place |
| `lab.tools.emptyHint` | Choose a harmless executable, review its identity, then create a typed run profile. | Choose a harmless executable, check its identity, then create a run profile. | **IMPL** — 'typed run profile' |
| `lab.tools.fixtureHint` | Reference adapter: build src-tauri/fixtures/contextos_fixture.rs (echo/sleep modes) and register that .exe here. Offline utilities live under Tools. | Sample program: build src-tauri/fixtures/contextos_fixture.rs (it only echoes text and waits) and add the .exe here. Offline utilities are under Tools. | **IMPL** — 'Reference adapter', 'echo/sleep modes'; path must stay (i18n.test.ts) |
| `lab.tools.desktopRequired` ‡ | Native tool execution requires the desktop app | Running tools requires the desktop app | **IMPL** — 'Native tool execution' |
| `lab.tools.desktopRequiredHint` | Browser mode cannot select, register, or execute local files and never simulates a successful run. | The browser version can't select, add or run local files, and it never pretends a run succeeded. | **IMPL** — 'Browser mode', 'register', 'simulates' |
| `lab.tools.unavailableCopyFixture` | Copy the fixture path | Copy the sample program path | **IMPL** — 'fixture' |
| `lab.tools.unavailableOfflineBody` | Encoding, hashing, JWT, regex and entropy tools run entirely in this build. They need no native process, so this boundary does not affect them. | Encoding, hashing, JWT, regex and entropy tools run inside the app itself, so this limit doesn't apply to them. | **IMPL** — 'run entirely in this build', 'native process', 'boundary' |
| `lab.tools.unavailableDesktopTitle` ‡ | Native execution needs the desktop build | Running tools needs the desktop app | **IMPL** — 'Native execution needs the desktop build' |
| `lab.tools.unavailableDesktopBody` ⚑1 | Run the Tauri desktop app, then enable the Private Lab. Only the desktop build can inspect, register and launch a local executable. | Open the desktop app and turn on Private Lab. Only the desktop app can inspect, add and launch local executables. | **IMPL** — 'Run the Tauri desktop app' |
| `lab.tools.unavailableFixtureTitle` ‡ | Start with the reference adapter | Start with the sample program | **IMPL** — 'reference adapter' |
| `lab.tools.unavailableFixtureStep1` | Compile the bundled fixture (it only echoes input and sleeps). | Build the bundled sample program. It only echoes input and waits. | **IMPL** — 'Compile the bundled fixture ... sleeps' |
| `lab.tools.unavailableFixtureStep2` | Register the resulting .exe here and review its identity. | Add the resulting .exe here and check its identity. | **GLO** — 'Register' vs 'Add local tool' |
| `lab.tools.unavailableFixtureStep3` | Create a typed run profile and launch it - a safe first run. | Create a run profile and launch it. This is a safe first run. | **IMPL** — 'typed run profile' |
| `lab.tools.launchReasonConsentRequired` ‡ ⚑1 | Private Lab consent is required before {name} can launch. | Turn on Private Lab before launching {name}. | **GLO** — says what to do instead of naming 'consent' |
| `lab.tools.arguments` | Typed arguments | Arguments | **IMPL** — 'Typed' |
| `lab.tools.argumentsHint` | Each value stays a separate process argument; no shell command is assembled. | Each value is passed to the program as its own argument. No shell command is built from your input. | **IMPL** — 'separate process argument; no shell command is assembled' |
| `lab.tools.commandPreview` | Escaped command preview | Command preview | **IMPL** — 'Escaped' |
| `lab.tools.refresh` | Refresh native state | Refresh | **IMPL** — 'native state' |
| `lab.tools.noRuns` | No native tool runs yet. | No tool runs yet. | **IMPL** — 'native tool runs' |
| `lab.tools.deleteArtifacts` | Delete artifacts | Delete output files | **IMPL** — 'artifacts' |
| `lab.tools.deleteArtifactsConfirm` | Delete this run's stdout and stderr files? Run history and output tails remain. | Delete the saved output files for this run? The run history and the last lines of output are kept. | **IMPL** — 'stdout and stderr', 'output tails' |
| `lab.tools.confirmRegister` | Confirm and register | Confirm and add | **GLO** — 'register' vs 'Add local tool' |
| `lab.tools.registerNote` | Registration stores this canonical path and SHA-256 in the private app-data registry. A changed binary is blocked until you review and explicitly trust it. | Adding a tool saves its full path and SHA-256 hash in the app's private data. If the file changes later, it is blocked until you review it and trust it again. | **IMPL** — 'canonical path', 'private app-data registry', 'binary' |
| `panel.outputOwnedHint` | Live stdout and stderr are shown in the shared Output panel. | Live output and errors appear in the shared Output panel. | **IMPL** — 'stdout and stderr' |
| `lab.insp.workingDir` | Artifacts directory | Output folder | **IMPL** — 'Artifacts directory' |
| `lab.insp.artifacts` | Artifacts | Output files | **IMPL** — 'Artifacts' |
| `lab.insp.noArguments` | No typed arguments configured. | No arguments configured. | **IMPL** — 'typed' |
| `lab.contextViews` | Laboratory views | Security Lab views | **GLO** — 'Laboratory' / 'Security Lab' / 'Lab' |
| `terminal.subtitle` ⚑8 | Tool-run console — not a system shell. | Interactive terminal for running your tools. | **STALE** — 'not a system shell' is contradicted by terminal/mod.rs:92-94 (the tab spawns pwsh.exe, powershell.exe or bash.exe). To be confirmed. |
| `terminal.nativeRequired` | Native runtime required | Desktop app required | **IMPL** — 'Native runtime' |
| `terminal.nativeRequiredHint` | The interactive terminal runs only in the packaged desktop app. | The interactive terminal works only in the installed desktop app. | **IMPL** — 'packaged' |
| `localAssistant.endpointPinned` | The endpoint is fixed for safety. A different stored value is ignored. | For safety, this address can't be changed. Any other stored value is ignored. | **IMPL** — 'endpoint' |
| `localAssistant.desktopOnly` ‡ | Qutra runs through the desktop app. This build has no local broker. | Qutra works only in the desktop app. The browser version can't reach it. | **IMPL** — 'no local broker' |
| `localAssistant.modelPullHint` ⚑readiness | If you want this exact model, install it into the isolated lab first: | To use this exact model, install it in Ollama first: | **IMPL** — 'isolated lab' (the readiness work removes it) |
| `localAssistant.sectionHint` ⚑readiness | Qutra runs entirely on this machine, against an isolated local Ollama on loopback. No cloud, no telemetry, no data leaves this computer. | Qutra talks only to a local Ollama at 127.0.0.1:11434 or 127.0.0.1:11435, and sends no telemetry. Whatever program answers at that address receives your conversation, and Qutra can't verify what it is. | **IMPL** — 'isolated ... on loopback' (readiness work). **Replacement changed 2026-09-30 (security review #1):** the first proposal kept the unconditional privacy promise; the listener on those ports is unauthenticated, so the promise is unsupported (ADR 0010, amendment of 2026-09-30). |
| `localAssistant.enableHint` | While this is off, the app makes no request to the endpoint at all - not even a health check. | While this is off, the app sends nothing to Ollama, not even a status check. | **IMPL** — 'the endpoint', 'health check' |
| `localAssistant.offlineHint` ⚑readiness | Nothing is listening on 127.0.0.1:11435. Start the isolated lab, then retry. | Qutra can't reach Ollama on this computer. Start Ollama, then try again. | **IMPL** — 'Nothing is listening on 127.0.0.1:11435 ... isolated lab' (readiness work) |
| `localAssistant.baseUrl` ‡ | Endpoint (loopback only) | Address (this computer only) | **IMPL** — 'Endpoint (loopback only)' |
| `jarvis.model.agentNeedsTools` | Agent actions are on, but this model does not support tool calling. It will still answer normally — it just cannot propose a command or a tool launch. | Tool proposals are on, but this model can't use tools. It still answers normally; it just can't suggest a command or a tool launch. | **GLO** — 'Agent actions' vs 'tool proposals' |
| `jarvis.model.unreachable` ⚑readiness | The lab is not reachable, so the model list could not be read. Your current model stays selected. | Ollama isn't reachable, so the model list couldn't be read. Your current model stays selected. | **IMPL** — 'The lab' (readiness work) |
| `jarvis.error.timeoutHealth` ⚑readiness | Qutra did not respond in time. Check that the isolated server is running. | Qutra didn't respond in time. Check that Ollama is running. | **IMPL** — 'the isolated server' (readiness work) |
| `jarvis.error.timeoutTurn` | This turn ran out of time, including any pending approval. | This step timed out, including any approval that was still waiting. | **IMPL** — 'This turn ran out of time' |
| `jarvis.error.consentRequired` ⚑1 | This action needs Private Lab consent first. | Turn on Private Lab first to allow this action. | **GLO** — says what to do; optional |
| `jarvis.error.tooManySteps` | Qutra tried too many steps in a row, so the turn was stopped. | Qutra tried too many steps in a row, so the request was stopped. | **IMPL** — 'the turn' |
| `jarvis.error.modelToolsUnsupported` | Your selected model can't be used with agent actions. Pick a different, tool-capable model, or turn agent actions off in Settings. | Your selected model can't be used with tool proposals. Pick a different, tool-capable model, or turn tool proposals off in Settings. | **GLO** — 'agent actions' |
| `localAssistant.autoApproveReadsToggleHint` | Skip the approval prompt only for read-only project context lookups. Terminal commands and tool launches still always need your approval. Has no effect unless agent actions are on. | Skip the approval prompt only for read-only project context lookups. Terminal commands and tool launches still always need your approval. Has no effect unless tool proposals are on. | **GLO** — 'agent actions' is used nowhere else |
| `jarvis.setup.q2Body` ⚑1 ⚑12 | Tool proposals are permitted, but they cannot run while Private Lab is off. Enabling Private Lab goes through the native consent path on this machine. | Tool proposals are allowed, but they can't run while Private Lab is off. Turning on Private Lab opens a confirmation dialog on this computer. | **IMPL** — 'the native consent path on this machine' |
| `jarvis.permission.nativeUnavailable` ⚑1 ⚑12 | This build cannot complete native acknowledgement. Private Lab stays off. | This version can't show the confirmation dialog. Private Lab stays off. | **IMPL** — 'native acknowledgement' |
| `jarvis.permission.nativeDeclined` ⚑1 ⚑12 | Native acknowledgement was not given. Private Lab stays off. | The confirmation wasn't given. Private Lab stays off. | **IMPL** — 'Native acknowledgement' |
| `jarvis.mode.answerOnlyComplete` | Answer-only is a complete supported mode. | Answer-only mode is fully supported. | **IMPL** — 'a complete supported mode' reads like a design note |

**Also**

- *Typography:* replace three ASCII dots with the single `…` character in `lab.tools.launchedInteractive`, `lab.tools.waitingOutput`, `jarvis.approval.pending`, `localAssistant.chatPlaceholder`, `localAssistant.thinking`, in `en.ts` and `tr.ts` (the Turkish rows above already do).
- *Tool proposals:* three strings say "agent actions" (`jarvis.model.agentNeedsTools`, `jarvis.error.modelToolsUnsupported`, `localAssistant.autoApproveReadsToggleHint`) while the rest of the UI says "tool proposals". I unified on "tool proposals"; this is also what removes the mistranslated "aracı eylemleri" and "Ajan eylemleri".
- *Not changed on purpose:* `tools.localOnly` ("Local-only, defensive, authorization-bound.") is telegraphic but not implementation talk; the Turkish rewrite carries the fix. `lab.tools.identityChanged` and similar hyphenated labels are fine.
- *Tests:* the table in §1 lists the seven English strings that a test asserts; the rest are safe to change.

## 6. Overflow risks

Turkish is longer than English in short places. Across the 870 short labels (4 to 24 English characters) it is on average **16% longer**, and 146 are at least 1.5 times as long. I looked for the ones that land in chips, tabs, small buttons and headers, and read the component to see where each one sits. The short form is a fallback, to use only if the string actually clips; it keeps the glossary term or drops a word the context already gives.

| Key | Where it appears | Proposed → short form | Chars |
|---|---|---|---|
| `lab.decision.scope_expired` | Chip beside each target in Scope & Targets (`DecisionBadge`, labViews.tsx:65) | Engellendi · kapsam süresi doldu → **Engellendi · süre doldu** | 32 → 23 (en 23) |
| `lab.decision.outside_window` | Same chip | Engellendi · zaman aralığı dışı → **Engellendi · aralık dışı** | 31 → 24 (en 24) |
| `lab.decision.excluded` | Same chip | Engellendi · hariç tutuldu → **Engellendi · hariç** | 26 → 18 (en 18) |
| `lab.decision.no_acknowledgment` | Same chip; e2e/lab.spec.ts:283 asserts the current text | Engellendi · yetki beyanı yok → **Engellendi · beyan yok** | 29 → 22 (en 26) |
| `lab.scopeStatus.acknowledgement_required` | Lab header badge, followed by " · N kapsam dışı" and three stats (LabPage.tsx:161-170) | Yetki beyanı gerekli → **Beyan gerekli** | 20 → 13 (en 24) |
| `lab.header.activeRuns` | Lab header stat after a count (LabPage.tsx:175) | etkin çalıştırma → **çalıştırma** | 16 → 10 (en 11) |
| `lab.runState.orphaned` | Run status chip (labels.ts:18) | Kesintiye uğradı → **Kesildi** | 16 → 7 (en 11) |
| `lab.findingStatus.riskAccepted` | Finding status chip and column (labels.ts:29) | Risk kabul edildi → **Risk kabulü** | 17 → 11 (en 13) |
| `health.needs_handoff` | Project health chip in the list and detail header (WorkspacesPage.tsx:351, 405; WorkspaceDetailPage.tsx:163) | Devir notu gerekli → **Devir notu yok** | 18 → 14 (en 13) |
| `localAssistant.statusUnavailable` | Status chip in Settings › local assistant (LocalAssistantSettings.tsx:30) | Masaüstü uygulaması gerekli → **Masaüstü gerekli** | 27 → 16 (en 20) |
| `settings.ai` | Settings section list (SettingsPage.tsx:141, built as `settings.${section}`) | Yapay zekâ sağlayıcıları → **Yapay zekâ** | 24 → 10 (en 12) |
| `ws.tab.snapshots` | Project detail tab row of ten tabs (WorkspaceDetailPage.tsx:221) | Anlık görüntüler → **Görüntüler** | 16 → 10 (en 9) |
| `lab.view.runs` | Lab view: context-sidebar item and, once opened, a workbench tab (navConfig.tsx:53, WorkspaceTabs.tsx:179). "Çalıştırmalar" is the correct plural; shorten only if it clips | Çalıştırmalar → **Çalıştırma** | 13 → 10 (en 4) |
| `lab.insp.tab.runs` | Inspector tab (inspectors.tsx:445); same caveat | Çalıştırmalar → **Çalıştırma** | 13 → 10 (en 4) |
| `nav.securityLab` | Nine-item rail (navConfig.tsx:34) and the first Lab tab (WorkspaceTabs.tsx:179): the same key, and the longest of the nine labels. `e2e/tr-terminology.spec.ts:21` pins the full name, so a short tab label needs its own key | Güvenlik Laboratuvarı → **Laboratuvar** | 21 → 11 (en 12) |
| `restore.retryFailed` | Restore dialog footer, with " (N)" appended (RestoreDialog.tsx:301) | Başarısızları yeniden dene → **Başarısızları dene** | 26 → 18 (en 12) |
| `restore.cancel` | Restore dialog footer while running (RestoreDialog.tsx:291) | Geri yüklemeyi iptal et → **İptal et** | 23 → 8 (en 14) |
| `restore.start` | Restore dialog footer, with " (N)" appended (RestoreDialog.tsx:279) | Geri yüklemeyi başlat → **Başlat** | 21 → 6 (en 13) |
| `restore.copyCommand` | Row action in the Restore dialog (RestoreDialog.tsx:462-463) | Başlatma komutunu kopyala → **Komutu kopyala** | 25 → 14 (en 19) |
| `lab.report.exportMarkdown` | Small button with an icon in the report card (labViews.tsx:889) | Markdown olarak dışa aktar → **Markdown'a aktar** | 26 → 16 (en 15) |
| `lab.newEngagement` | Lab header and empty-state button, and also the default title of the record it creates (LabPage.tsx:111, 144, 158), so the short form must still work as a title | Yeni güvenlik çalışması → **Yeni çalışma** | 23 → 12 (en 14) |
| `session.review.save` | Primary button of the Session review dialog (SessionReviewDialog.tsx:99) | Değerlendirmeyi kaydet → **Kaydet** | 22 → 6 (en 11) |
| `onb.createWs` | Onboarding primary button (OnboardingPage.tsx:265) | Çalışma alanı oluştur → **Oluştur** | 21 → 7 (en 16) |
| `tools.enable` | `EnablePrivateLabButton` on the Tools and Terminal gate cards (components/EnablePrivateLabButton.tsx:41); the card title already says Private Lab | Private Lab'ı etkinleştir → **Etkinleştir** | 25 → 11 (en 22) |

Two notes. **Blocked chips:** the shield icon in `DecisionBadge` is `aria-hidden`, so the "Engellendi · " prefix is what a screen reader hears. If the chips still clip after the short forms above, the better fix is a code change (a visually hidden "Engellendi" plus the short reason), not a shorter Turkish string. **Counts in buttons:** the Restore dialog appends "(N)" to two labels, so budget for three more characters there.

## 7. Open questions

Each has a recommendation, so a one-word answer is enough.

1. **Keep "Private Lab" in English?** Recommended: yes (§3.1). If you prefer Turkish, choose "Özel Lab"; because the suffix is the same (`Lab'ı`), a find-and-replace on "Private Lab" in `tr.ts` is then safe. Affects the rows marked `⚑1`.
2. **Which name does the assistant wear, Jarvis or Qutra?** The product decision is "Jarvis = the assistant persona" and Jarvis stays as it is. At HEAD, `nav.jarvis`, `localAssistant.assistant`, `jarvis.approval.title` and 20 more strings say **"Qutra"** in all six locales, and no user-visible string says Jarvis. I left the name as it is at HEAD. Separately, an assistant called "Qutra" next to an app called "Qutra Labs" invites a reader to ask whether "Qutra Labs" reads their files (compare `privacy.noOutbound`). Suffix forms for both names are in §3.3.
3. **Workspace or project?** It is one entity with two names: route `/workspaces` is labelled "Projeler" in the nav, while pages, tabs and hints say "çalışma alanı". Unify in English first. Recommended: **proje**. That retires "Çalışma Alanları", which `termbase.ts` and `termbase.test.ts` bind to `nav.workspaces`, so `termbase.ts` changes in the same commit, and the suffixes change too (çalışma alanında → projede), so it is not a mechanical replace.
4. **Engagement = "güvenlik çalışması"?** I kept the `docs/TERMBASE.md` decision and only removed the bare "Çalışma" and the untranslated "Engagement raporu". The alternative is "değerlendirme", which already matches "Değerlendirme metodolojisi" and "değerlendirmeye yetkiliyim". Rows marked `⚑4`.
5. **Register: two forms, or formal everywhere?** Recommended: two forms (§2). "Formal everywhere" would make buttons "Etkinleştirin", "Seçin", "Kaydedin", which is not what Windows does and would touch nearly every button label in the app.
6. **Casing.** Recommended: sentence case for generic labels. Eight optional casing-only edits are listed at the end of §4. Not touched, because they are bound: `nav.overview` "Ana Sayfa", `nav.workspaces` "Çalışma Alanları" (`termbase.ts`), and `e2e/tr-terminology.spec.ts` asserts "Ana Sayfa". `ws.title` and `nav.mode.home` were left so they stay paired with them.
7. **"Yüksek karşıtlık" or "Yüksek Kontrast"?** As far as I know, Windows 11's Turkish setting is "Karşıtlık temaları" (Windows 10 said "Yüksek karşıtlık"), so I used "karşıtlık". Please confirm on a Windows 11 machine under Ayarlar › Erişilebilirlik. Rows marked `⚑7`; reverting is a two-key change.
8. **Is the terminal still "not a system shell"?** `terminal.subtitle` says so in every state of the page, but `terminal/mod.rs:92-94` spawns `pwsh.exe`, `powershell.exe` or `bash.exe`, and the readiness work adds a `cmd` fallback. I proposed "Interactive terminal for running your tools" and marked it `⚑8`. If the claim is deliberate (for example, a restricted profile), keep the English and only my Turkish wording changes.
9. **`docs/TERMBASE.md` is out of date.** It is v1 and `termbase.ts` is v2. It still lists retired concepts (Inbox, Snippets, Timeline, Clipboard → "Pano Geçmişi", which `e2e/tr-terminology.spec.ts` now forbids on the Home screen), says "Overview → Genel Bakış" while the code binds "Home → Ana Sayfa", and records "Private Security Lab → Özel Güvenlik Laboratuvarı", which matches no name in the UI today. Once questions 1, 3 and 4 are answered, update it and bind the Lab terms (bulgu, kanıt, hedef, kapsam, güvenlik çalışması) to keys so drift fails the build.
10. **Dead copy.** 190 keys have no reference in `src/`: `insights.*` (17 of 17), `editor.*` (10 of 10), `overview.*` (33 of 39), `auto.*` (25 of 40), `today.*` (18 of 28) and a scatter elsewhere (full list in Appendix A). Are they coming back? If not, deleting them removes 33 of the rows in §4 and shrinks the surface in all six locales.
11. **Readiness overlap.** Six keys carry the "isolated"/fixed-port wording that the readiness work removes: `localAssistant.offlineHint`, `localAssistant.modelPullHint`, `jarvis.setup.endpointDisclosure`, `jarvis.error.timeoutHealth`, `jarvis.model.unreachable`, and `localAssistant.sectionHint`. Who edits them? The readiness work is next, so this is the one question with a deadline. The proposals avoid the port and the word "isolated", so they should survive that work; `endpointDisclosure` still names 127.0.0.1:11435 and needs the final address.
12. **Is the native consent step a confirmation dialog?** I wrote "onay penceresi" (confirmation window) for it, based on `jarvis.setup.q2Body` and `jarvis.permission.native*`, whose English talks about a "native consent path" and "native acknowledgement". If it is something else, those three strings need another noun. Rows marked `⚑12`.
13. **Judgement calls you may want to veto:** *Kanban* for the board view (alternative: keep "Pano" and rename the clipboard strings instead), *teyit edildi* for the finding status "Confirmed", *Dışlamalar* for the privacy exclusions, *Sürdür* for every "Resume", and naming *Windows Kimlik Bilgisi Yöneticisi* where the English said "OS secure storage" (accurate: `Cargo.toml:37` uses the `windows-native` keyring feature; but the browser demo has no such store, and the English rewrite in §5 assumes a Windows-only product).

## Appendix A. Keys not referenced in `src/` at HEAD (190)

A key counts as referenced if a string literal equal to it, or a template literal that can produce it (for example `lab.severity.${x}`), appears in a non-test file under `src/` other than the locale files. A key built some other way would be misreported here, so check before deleting.

| Prefix | Unreferenced / total | Keys |
|---|---:|---|
| `overview.*` | 33 / 39 | `customize` `resetLayout` `moveUp` `moveDown` `hideSection` `showSection` `protected` `hiddenCount` `attention` `allClear` `blocked` `restoreHealth` `restoreSuccess` `restorePartial` `restoreFailed` `successRate` `noRestores` `privacy` `captureActive` `capturePaused` `captureOff` `pauseCapture` `resumeCapture` `noData` `noDataHint` `sections.resume` `sections.session` `sections.attention` `sections.recent` `sections.activity` `sections.restoreHealth` `sections.github` `sections.privacy` |
| `auto.*` | 25 / 40 | `title` `new` `trigger` `conditions` `actions` `dryRun` `dryRunResult` `nextRun` `runLog` `rateLimit` `perHour` `permissions` `shellWarning` `action.open_resource` `action.start_timer` `action.create_task` `action.create_note` `action.capture_snapshot` `action.notify` `action.run_command` `action.apply_tag` `action.export_report` `action.webhook` `enabled` `disabled` |
| `today.*` | 18 / 28 | `title` `resumeContext` `lastGoal` `noContext` `noContextHint` `activeSession` `plannedOutputs` `overdueTasks` `recentWorkspaces` `inboxTriage` `triageNow` `activity7d` `insights` `quickActions` `addInboxItem` `openPalette` `planSomething` `sessionsCount` |
| `insights.*` | 17 / 17 | `title` `range.week` `range.month` `activeStale` `resumeTime` `interruptions` `productiveHours` `carriedTasks` `restoreFailures` `noData` `noDataHint` `stale` `staleFor` `median` `viewEvents` `completions` `chartTable` |
| `nav.*` | 13 / 31 | `group.home` `group.work` `group.knowledge` `group.intelligence` `group.system` `group.private` `lab` `mode.home` `mode.work` `mode.knowledge` `mode.automate` `mode.lab` `mode.system` |
| `common.*` | 10 / 31 | `yesterday` `thisWeek` `tags` `priority` `due` `selected` `noWorkspace` `updated` `created` `showArchived` |
| `editor.*` | 10 / 10 | `placeholder` `slashHint` `slash.h1` `slash.h2` `slash.bullet` `slash.numbered` `slash.check` `slash.quote` `slash.code` `slash.divider` |
| `session.*` | 9 / 47 | `title` `startShort` `resourcesToOpen` `quickNote` `quickBookmark` `quickSnippet` `quickError` `duration` `active` |
| `action.*` | 8 / 40 | `edit` `search` `filter` `copied` `confirm` `clear` `pause` `resume` |
| `lab.*` | 8 / 275 | `title` `subtitle` `engagements` `safetyNote` `views` `view.engagement` `nav.utilities` `nav.utilitiesGroup` |
| `privacy.*` | 7 / 20 | `retention` `pauseAll` `resumeAll` `pausedBanner` `secretNote` `clipboardOff` `clipboardOn` |
| `palette.*` | 5 / 10 | `commands` `navigation` `hint.navigate` `hint.open` `actions` |
| `ws.*` | 4 / 57 | `unsolvedErrors` `currentSession` `trackedFolders` `connectFolder` |
| `snapshot.*` | 3 / 28 | `title` `sensitive` `delete` |
| `settings.*` | 3 / 86 | `notif.testFailed` `language.en` `language.tr` |
| `toast.*` | 3 / 6 | `deletedUndo` `error` `demoDataNeeded` |
| `localAssistant.*` | 3 / 45 | `enable` `openSettings` `agentToggle` |
| `restore.*` | 2 / 26 | `plan` `warn.staleUrl` |
| `capture.*` | 2 / 5 | `title` `hint` |
| `assistant.*` | 2 / 9 | `summarize` `close` |
| `app.*` | 1 / 2 | `tagline` |
| `error.*` | 1 / 6 | `dbTitle` |
| `themeStudio.*` | 1 / 10 | `systemDesc` |
| `workbench.*` | 1 / 19 | `modes` |
| `terminal.*` | 1 / 12 | `enable` |
