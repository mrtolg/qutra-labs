# Workbench mimarisi derin inceleme

**Referanslar:** VS Code / Code-OSS · Zed · (kısa bakış) AFFiNE · **Qutra Labs**  
**Amaç:** Desktop “app shell / workbench” kavramını sıfırdan öğretmek; üç açık kaynak modeli karşılaştırmak; Qutra Labs için kanıta dayalı mimari ilkeler çıkarmak.  
**Kapsam:** Analiz ve öğretim. Ürün kodu değiştirilmez.  
**Tarih:** 2026-07-28

---

## 0. Bu belgeyi nasıl okumalı?

Önce **düz dil**, sonra **kesin terim**. Her bölüm:

1. Bir benzetme (mutfak / ofis / tarayıcı),
2. Referans uygulamada ne olduğu,
3. Qutra Labs’ta bugün ne olduğu,
4. Ne kopyalanmalı / ne kopyalanmamalı.

Kafanda tutman gereken tek cümle:

> **Workbench = pencerenin iskeleti.** Ortadaki “iş” (dosya, sayfa, lab run) değişir; kenarlardaki şeritler (sidebar, panel, status) aynı kalır ve o işe hizmet eder.

---

## 1. Workbench / app shell nedir?

### 1.1 Düz dil

Masaüstü uygulamasını açtığında gördüğün şey iki katmandır:

| Katman | Ne işe yarar? | Örnek |
|--------|----------------|--------|
| **Shell (kabuk / workbench)** | Layout, navigasyon, sekmeler, ayarlar kapısı, kalıcılık | Sol menü, üst sekme şeridi, alt panel |
| **Content (içerik)** | Asıl iş ekranı | Overview, Lab findings, Settings içeriği, Terminal |

Workbench olmadan her sayfa kendi menüsünü yeniden icat eder. Workbench ile kullanıcı “aynı binadayım, sadece odaya geçtim” hissini alır.

### 1.2 Neden IDE’ler bunu bu kadar büyüttü?

VS Code ve Zed **dosya editörü** değil; **çok parçalı çalışma alanı**dır:

- Aynı anda birden fazla “açık iş” (sekme),
- Bazen yan yana birden fazla “çalışma bölgesi” (editor group / pane),
- Kenarlarda araçlar (explorer, terminal, problems),
- Oturumlar arası “kaldığım yerden devam” (persistence).

Qutra Labs bir IDE klonu değil; ama **aynı kullanıcı beklentisini** taşıyor: Tauri + React ile dokuz modüllü bir “core workbench”.

### 1.3 App shell vs router vs “editor”

Üç kavramı karıştırma:

1. **Router** — URL → hangi React sayfası. Qutra Labs: `src/app/router.tsx` (`createHashRouter`).
2. **Workbench chrome** — Sidebar, tab strip, inspector, bottom panel. Qutra Labs: `src/app/workbench/*`.
3. **Editor / Item** — VS Code/Zed’de “açık belge” soyutlaması. Qutra Labs’ta birebir yok; **route tab** ile yaklaşık karşılık var.

AFFiNE burayı daha da net ayırır: her workbench view kendi `MemoryRouter`’ına sahip olabilir (doküman sekmeleri). Qutra Labs ise **tek global router + kalıcı tab listesi** kullanır — daha basit, IDE’den uzak, ürün için uygun.

---

## 2. VS Code nasıl düşünür?

Kaynak omurga: `src/vs/workbench/` (Code-OSS / microsoft/vscode).

### 2.1 Zihinsel model (pencere → workbench → parts → editors → tabs)

```
Window (Electron / browser)
  └── Workbench
        ├── Parts (layout parçaları)
        │     TITLEBAR | ACTIVITYBAR | SIDEBAR | EDITOR | PANEL | AUXILIARYBAR | STATUSBAR
        └── Editor area (EDITOR_PART)
              └── Editor groups (grid)
                    └── Tabs = açık EditorInput’lar (URI + tip)
```

**Parts** (`Parts` enum, `layoutService.ts`):

- `TITLEBAR_PART`
- `ACTIVITYBAR_PART` — sol ince ikon şeridi (Explorer / Search / …)
- `SIDEBAR_PART` — seçili viewlet’in gövdesi
- `EDITOR_PART` — asıl içerik alanı
- `PANEL_PART` — Terminal / Output / Problems (alt veya yan)
- `AUXILIARYBAR_PART` — ikinci yan bar (Chat vb.)
- `STATUSBAR_PART`

Orkestrasyon: `src/vs/workbench/browser/layout.ts` + `IWorkbenchLayoutService`.  
Konum/boyut: `SerializableGrid` ile parçalar arasında.

**Önemli:** Activity bar ≠ sidebar. Activity bar *hangi viewlet*, sidebar *o viewlet’in içeriği*.

### 2.2 Editor groups ve sekmeler

- Bir **editor group** = bir sütun/bölme; içinde sıralı sekmeler.
- Split → yeni group.
- Sekme = `EditorInput` (çoğu zaman bir `URI` + editor tipi).
- Servisler: `IEditorService`, `IEditorGroupsService`, `EditorPart` (`editorPart.ts`), `EditorGroupView` (`editorGroupView.ts`).

**Son sekmeyi kapatınca ne olur?** (`editorGroupView.ts`)

1. Group boşalır.
2. Varsayılan: `workbench.editor.closeEmptyGroups: true` → boş group layout’tan **silinir** (`removeGroup`). Aktif group’un son editor’ü kapanırken flicker azaltmak için önce MRU’daki sonraki group aktive edilir.
3. `closeEmptyGroups: false` → group **boş chrome** olarak kalır (çift tık = untitled; orta tık = group sil).
4. **Son kalan group** yok edilmez: boş editor alanı kalır; pencere kapanmaz. (~1.57’de “editor yokken Cmd/Ctrl+W → pencere kapat” keybinding bilinçli kaldırıldı; `window.closeWhenEmpty` ayrı / isteğe bağlı.)
5. Boş alan ≠ otomatik Welcome; Welcome ayrı startup contribution’dır (aşağıda).

Resmi UI dokümanı: [User interface](https://code.visualstudio.com/docs/editing/userinterface).

### 2.3 Welcome / empty / home

VS Code’da “home” bir route değil; **editor input** (`GettingStartedInput`, `walkThrough://…`) + `StartupPageRunnerContribution` (`startupPage.ts`):

- Ayar: `workbench.startupEditor` (default `welcomePage`; ayrıca `none`, `readme`, `newUntitledFile`, `welcomePageInEmptyWorkbench`, `terminal`, …).
- **Reload** (`StartupKind.ReloadedWindow`) → Welcome yeniden açılmaz.
- Önceki oturumdan editor restore edildiyse Welcome genelde **yerine geçmez**.
- Boş group’a çift tık untitled açar; Welcome’ı otomatik doldurmaz.

Qutra Labs bilerek bunu **route** ile modelledi: `HOME_ROUTE = "/overview"` (`src/domain/workbench.ts`). Yorum satırı da VS Code empty group → Welcome metaforunu açıkça yazıyor — pratikte Qutra Labs “empty ⇒ her zaman Overview’a in” diyerek VS Code’dan daha deterministik.

### 2.4 Panel (terminal) görünürlüğü

- Layout state: **`PANEL_HIDDEN` default `true`** — cold start’ta panel/terminal **kapalı** (`layout.ts` `LayoutStateKeys`). Qutra Labs’un `bottomPanelOpen: false` cold start’ı aynı aileden.
- `PANEL_PART` bağımsız görünürlük + boyut + pozisyon (alt/yan); `workbench.panel.defaultLocation` çoğunlukla **yeni** workspace için.
- Terminal panel içinde bir **view**; panel açık olsa da başka sekme (Problems) aktif olabilir; view container’lar sidebar/panel/aux arasında taşınabilir.
- Workspace storage sonraki oturumda görünürlüğü hatırlar (default’tan sonra).

Qutra Labs farkı: alt panel **lab çıktısı** odaklı (`output` / `problems` / `audit`); tam terminal ayrı route (`/terminal`). Cold start’ta `bottomPanelOpen: false` **zorlanır** (`Workbench.tsx`) — VS Code’daki “son durumu restore et”ten bilinçli sapma.

### 2.5 Settings UI mimarisi

Settings bir **editor** gibi açılır (`Preferences` / SettingsEditor2):

| Parça | Dosya / kavram | Rol |
|-------|----------------|-----|
| TOC (içindekiler ağacı) | `tocTree.ts`, `settingsLayout.ts` (`tocData`) | Kategori navigasyonu |
| Ayar listesi | `settingsTree.ts`, `settingsTreeModels.ts` | Arama + render |
| Shell | `settingsEditor2.ts` | TOC + content + search |

Desen: **sol ağaç (kategoriler) + sağ içerik + üst arama**.  
Ayar anahtarları `editor.*`, `workbench.*` gibi namespace; TOC bunları pattern ile gruplar.

Bu, modern editör ve sohbet uygulamalarındaki “settings rail + section body” düzenine akrabadır — VS Code bunu editor içinde, binlerce ayar için ölçekler.

### 2.6 Persistence / restore vs fresh start

VS Code katmanları:

1. **User settings** (`settings.json`) — tercihler.
2. **Workspace storage** — o klasör için UI state.
3. **Editor part UI state** (`editorpart.state` vb.) — group layout, açık editor’lar.
4. **Hot exit / backups** — kaydedilmemiş buffer’lar.

Cold start vs restore:

| Senaryo | Tipik sonuç |
|---------|-------------|
| Yeni boş pencere | Panel gizli; `startupEditor` → Welcome mümkün |
| Normal relaunch + restore | Önceki editor’lar + layout chrome |
| Window reload | Welcome yeniden açılmaz |
| `workbench.editor.restoreEditors: false` / temporary workspace | Editor restore yok |

“Welcome only” özellikle boş / henüz restore edilecek bir şey yokken.

### 2.7 Contribution / service / URI modeli (neden bu kadar ağır?)

- **Contribution**: extension veya core modül UI/komut kaydeder.
- **Service**: DI ile `IEditorService` gibi tekil API.
- **URI**: her açılabilir şeyin kimliği (`file://`, `untitled:`, `vscode-settings:`…).

Bu model **plugin ekosistemi** içindir. Qutra Labs’un Tauri + sabit dokuz rota dünyasında birebir kopyalamak maliyet; **fikirleri** (parts, empty fallback, settings TOC) almak yeterli.

---

## 3. Zed nasıl düşünür?

Kaynak omurga: `crates/workspace/` (zed-industries/zed). Blog: [New panel system](https://zed.dev/blog/new-panel-system).

### 3.1 Zihinsel model (workspace → center panes → docks)

```
Window
  └── Workspace (bir proje penceresi; MultiWorkspace ile pencere-içi workspace sekmeleri)
        ├── center: PaneGroup (split tree)
        │     └── Pane → items[] (tabs)  // Item trait
        ├── left_dock / right_dock / bottom_dock  // Dock → Panel’ler
        └── status_bar
```

VS Code “Parts + EditorPart grid” derken Zed:

- **Center** = düzenleme (pane ağacı),
- **Dock** = kenar konteynerleri (panel taşınabilir),
- **Panel** = Project panel, Terminal panel, Agent panel… (`Panel` trait).

v0.88 sonrası üç dock; terminal ve project panel dock konumunu `settings.json` ile değiştirir.

### 3.2 Pane / Item / sekmeler

- `Pane` (`pane.rs`): sıralı item listesi, aktif index, pin, history.
- Her şey `Item` / `ItemHandle` — editor, search, bazen başka view’lar.
- `PaneGroup` (`pane_group.rs`): yatay/dikey split ağacı.

**Hard rule:** Paneller dock’ta; Item’lar pane’de. `Editor` `Panel` implement etmez.

**Son item kapanınca** (`pane.rs`):

1. `close_pane_if_empty` → split’teki boş yan pane’ler `Event::Remove` ile kalkar (layout sadeleşir).
2. **Kök merkez pane yok edilmez** (`PaneGroup::remove` son tek pane için `Ok(false)`): empty center kalır; Welcome / Launchpad render edilir.
3. Pane zaten boşken Close → `when_closing_with_no_tabs`: `platform_default` (macOS’ta pencere kapat / Linux-Windows’ta açık tut), `close_window`, `keep_window_open`. Bu, VS Code `window.closeWhenEmpty` göç eşleniğidir — **içerik kapanması ≠ pencere kapanması** bilinçli ayrılmıştır.
4. Sonraki sekme: `tabs.activate_on_close` = `history` (default) | `neighbour` | `left_neighbour`.

Qutra Labs’ta split pane **yok**; tek merkez + route tabs. Zed’in “son merkez pane’i yok etme + welcome” politikasının karşılığı: **son tab → `/overview`, pencere açık**.

### 3.3 Terminal / dock varsayılanları

- **Terminal panel** (``Ctrl+` ``): dock default **`bottom`**; `TerminalPanel` kendi içinde mini `PaneGroup` tutar (yalnızca terminal sekmeleri — v0.88 sonrası non-terminal yasak).
- **Center terminal**: ayrı komut → merkezde normal Item sekmesi.
- Focus toggle dock’u da açar; aynı dock’ta bir anda **tek** aktif panel.
- Dock açık/kapalı + aktif panel çoğunlukla **WorkspaceDb**; dock *konumu* `terminal.dock` ayarından.

Qutra Labs: lab bottom panel ≠ full terminal page (`/terminal` + opsiyonel `embedded` BottomPanel). İki kanalı karıştırma — Zed’in “terminal dock’a yabancı içerik koyma” kısıtı aynı disiplini öğretir.

### 3.4 Settings

Zed ayarları **ayrı `SettingsWindow`** içinde (`crates/settings_ui`) — workbench sekmesi değil; “settings’in kendi yeri var”.  
JSON hâlâ kaynak gerçek (`update_settings_file`, yorum koruma); UI aranabilir sayfalar (`page_data.rs`).  
Dock konumları ayar anahtarlarıyla (`project_panel.dock`, `terminal.dock`).

Qutra Labs Settings bir **workbench tab/route** (`/settings`) — editör ve sohbet uygulamalarındaki rail düzenine yakın, Zed’in ayrı penceresine değil. İleride User vs Project ayrımı gerekirse Zed’in “ayrı konum” içgörüsü değerli.

### 3.5 Persistence

- **Preferences:** settings JSON katmanları (user / project `.zed/settings.json`).
- **Layout/session:** SQLite `WorkspaceDb` — `SerializedPaneGroup`, `DockStructure`, window bounds; değişikliklerde throttle’lı serialize.
- Cold start: `restore_on_startup` = `last_session` (default) | `last_workspace` | `empty_tab` | `launchpad`.
- Boş restore pane’ler atılır; panel sistemi büyük değişince bir sürüm restore’u bozmuştu (v0.88) — **layout schema versioning** dersi.

### 3.6 VS Code’dan farkı (özet)

| | VS Code | Zed |
|--|---------|-----|
| Merkez | Editor groups + EditorInput/URI | Pane + Item trait |
| Kenarlar | Esnek viewlet grid (Activity↔Sidebar↔Panel↔Aux) | Sabit **3 dock**; Panel vs Item ayrımı |
| Eklenti | Contribution/DI çok ağır | Rust crate + GPUI, daha bütünleşik |
| Boş merkez | Empty group + isteğe bağlı Welcome startup | Son center pane kalır + Welcome/Launchpad |
| Settings | Workbench içinde editor tab | Ayrı SettingsWindow + JSON |
| Felsefe | Her şey açılabilir editor | Center = edit; tools = docks |

Zed “daha basit ürün” değil; **daha kısıtlı layout dilbilgisi**. Qutra Labs’a yakın olan: sabit chrome + az sayıda içerik türü — kimlik **URI/Item değil route**.

---

## 4. AFFiNE’e kısa bakış (settings / workspace)

AFFiNE (`Workbench` entity, `WorkbenchService`):

- Birden fazla **View** (sekme / split),
- Her view kendi path’i (bazen kendi MemoryRouter),
- Sidebar open/width LiveData + globalState.

Ders: **workbench state’i router’dan ayır**, ama Qutra Labs ölçeğinde AFFiNE’nin multi-router karmaşıklığına gerek yok. Settings için: workspace seçici + app settings ayrımı (Qutra Labs’ta zaten Preferences blob’u tek).

---

## 5. Qutra Labs bugün nasıl map oluyor?

### 5.1 Dosya haritası

| Dosya | Rol |
|-------|-----|
| `src/domain/workbench.ts` | Saf model: rotalar, tab API, layout bounds, lab views, history |
| `src/domain/types.ts` → `PreferencesSchema` | Kalıcı prefs: tabs, panel, sidebar, inspector… |
| `src/app/workbench/Workbench.tsx` | Shell layout + cold start |
| `src/app/workbench/WorkspaceTabs.tsx` | Tab şeridi, open/close/pin/reopen/history |
| `src/app/workbench/ContextSidebar.tsx` | Sol nav (CORE_NAV = 9) |
| `src/app/workbench/BottomPanel.tsx` | Lab output/problems/audit |
| `src/app/workbench/Inspector.tsx` | Sağ inspector |
| `src/app/workbench/navConfig.tsx` | Nav + lab view defs |
| `src/app/AppShell.tsx` | Titlebar + Workbench + palette |
| `src/app/router.tsx` | Hash routes; default → `/overview` |
| `src/features/settings/SettingsPage.tsx` | Rail + section (`?section=`) |

### 5.2 Layout (VS Code Parts karşılığı)

```
AppShell
  Titlebar
  Workbench
    ContextSidebar          ≈ SIDEBAR (+ kısmen ACTIVITYBAR birleşik)
    wb-main-col
      WorkspaceTabs         ≈ editor tab strip (tek group)
      <Outlet/> main        ≈ EDITOR_PART (ama route sayfası)
      BottomPanel?          ≈ PANEL_PART (lab-gated)
    Inspector               ≈ AUXILIARYBAR (seçim yoksa mount yok)
```

Status bar: VS Code’daki sürekli `STATUSBAR_PART` yok; BottomPanel kapalıyken yalnızca aktif/problem run varsa ince `wb-statusbar` şeridi.

### 5.3 Tab modeli

- Tab = **normalize edilmiş workbench route** (`WorkbenchTabState`: route, pinned, openedAt).
- `/overview` **tab değil**; empty fallback (`isHomeRoute` / `isTabbableRoute`).
- Navigasyon tabbable route’a gidince `openWorkbenchTab` ile strip’e eklenir.
- Son tab kapanınca `navigate(HOME_ROUTE)` — empty working set.
- Recently closed + Ctrl+Shift+T; Ctrl+Tab cycle; Ctrl+F4 close.
- Workbench-local back/forward (`TabHistory`) — router history’den ayrı.

Bu, VS Code “Welcome fallback” + tarayıcı “working set” karışımı; URI editor değil.

### 5.4 Cold start

`Workbench.tsx` session başına bir kez:

```text
bottomPanelOpen: false
workbenchTabs: normalizeWorkbenchTabs(...)  // home stub’ları temizle
```

Yani: **panel kapalı başla**, tab listesini güvenli hale getir. Tabs tamamen silinmez — restore var; ama home asla working tab olmaz.

### 5.5 Bottom panel

- Prefs: `bottomPanelOpen` default `false`, height, tab.
- Sadece `privateToolsEnabled` ve path ≠ `/terminal` iken shell’de.
- Kapalı + sorun yok → `null` (chrome yok).
- Lab tool run açabilir (`ToolLabPanel` → `bottomPanelOpen: true`).

VS Code “terminal her zaman bir tuşla” hissinden daha **sessiz**; ürün kararı bilinçli.

### 5.6 Settings

`SettingsPage`:

- Sol **gruplu rail** (`NAV_GROUPS`: app / privacy / data / system),
- Sağ section body,
- `?section=appearance` ile deep link,
- Arama = section label filter (VS Code’un setting-key araması kadar derin değil).

Bu, **editör ve sohbet uygulamalarındaki gibi bir settings rail** — VS Code SettingsEditor2’nin sade kuzeni. Preferences tek Zod şemasında; TOC ayrı `settingsLayout` contribution değil.

### 5.7 Routing vs “editors”

Qutra Labs **sayfa uygulamaları** (Overview, Lab, Settings) workbench içinde render edilir.  
VS Code’da Settings bile bir editor tab’ıdır.  
Qutra Labs’ta Settings de tabbable route → strip’te görünebilir; Overview görünmez.

Legacy path’ler (`/today`, `/inbox`…) → `/overview` redirect: ürün sadeleştirmesi.

### 5.8 Güçlü / zayıf map

| Beklenti | Qutra Labs | Not |
|----------|-----------|-----|
| Tek iskelet | ✅ Workbench | İyi |
| Empty = home | ✅ `/overview` | VS Code Welcome / Zed launchpad analogu |
| Son tab | ✅ home | Pencere kapanmaz (doğru; Zed `keep_window_open` ailesi) |
| Split groups | ❌ | Gerekmez (şimdilik) |
| URI/Item soyutlaması | ❌ route string | Yeterli |
| Panel default | Kapalı + lab-gated | VS Code `PANEL_HIDDEN` ile hizalı; restore’u force-close eder |
| Settings TOC | ✅ basit rail | Derin arama sonra; Zed ayrı pencere değil |
| Status bar | Kısmi | Lab sinyali için yeterli olabilir |
| Persistence | Prefs blob | Schema cap (24 tab) var |

### 5.9 Bilinen quirk / borç (Qutra Labs haritasından)

1. **Mode Rail yok** — CSS/yorum kalıntısı; yalnızca `"core"`. `workbenchModeRoutes` / `routeForMode` UI’da ölü.
2. **`overviewLayout` / `domain/overview.ts`** — prefs’te var; güncel `OverviewPage` kullanmıyor (eski yoğun dashboard).
3. **`/sessions/focus`** shell’de açılır ama `resolveModeForPath` null → **otomatik tab olmaz** (normalize dışı).
4. **Overview’dayken strip’te aktif tab olmayabilir** — diğer tab’lar açık kalır; home strip’te görünmez (bilinçli).
5. **Tab Back/Forward (`TabHistory`) session-only** — reload’da sıfırlanır; `workbenchTabs` kalır.
6. **Inspector çift state** — `useUi` + prefs `inspectorSelection`; mount’ta restore.
7. **Lab `?e=&view=`** her kombinasyon ayrı tab — güçlü bağlam, gürültülü strip riski.
8. **`/terminal`** shell BottomPanel’i gizler; sayfa `embedded` panel kullanabilir — çift chrome’u engeller.
9. Hash router (`#/…`); “+” sekmesi blank editor değil → command palette.

---

## 6. Davranış karşılaştırma matrisi

| Davranış | VS Code | Zed | Qutra Labs |
|----------|---------|-----|-----------|
| Son sekme kapanınca | Boş group silinebilir (`closeEmptyGroups`); son group boş kalır | Yan pane silinir; **son center pane kalır** + welcome; window ayrı ayar | `/overview`, boş strip; pencere açık |
| Cold start | Layout restore; `PANEL_HIDDEN` default; Welcome koşullu | `restore_on_startup` + WorkspaceDb | Tabs normalize + **panel force-close** |
| Terminal | Panel view (taşınabilir) | Bottom dock panel *veya* center tab | `/terminal` sayfa + lab BottomPanel |
| Settings | Editor tab + TOC SplitView | **Ayrı SettingsWindow** + JSON | Rail + `?section=` (workbench tab) |
| Kimlik modeli | URI + EditorInput | Item entity | Route string |
| Split | Editor groups grid | PaneGroup | Yok |
| Pin | Var | Var | Var |
| Reopen closed | Var | Var | `workbenchRecentlyClosed` |

---

## 7. Ne kopyala / ne kopyalama

### Kopyala (yüksek değer)

1. **Parts zihniyeti** — chrome bölgelerinin tek sahibi olsun (Qutra Labs zaten yakın).
2. **Empty fallback ≠ sticky home tab** — Overview’ı tab yapma (zaten doğru).
3. **Son tab → güvenli home, pencereyi öldürme**.
4. **Settings: kategorili rail + içerik + deep link** (mevcut; aramayı güçlendir).
5. **Layout size clamp + drag’de commit-on-end** (ResizeHandle yorumu — SQLite yazma dersi).
6. **Cold start’ta gürültülü chrome’u kapat** (panel).
7. **Region ErrorBoundary** (Workbench) — IDE’ler de part izolasyonu ister.
8. **Schema versioning** düşüncesi (Zed 0.88 restore kırığı).

### Kopyalama (maliyet / yanlış ürün)

1. Full **contribution / DI** platformu.
2. **URI scheme** ormanı ve her şeyin editor olması.
3. **Multi editor group / pane split** — Qutra Labs iş akışı sayfa/lab; kod diff değil.
4. Activity bar + sidebar çift katmanı — 9 item için overkill; tek sidebar yeterli.
5. Binlerce ayarlık SettingsTree renderer’ları.
6. Terminal’i zorunlu her zaman-açık panel yapmak.
7. AFFiNE multi-MemoryRouter — tek hash router daha sade.

### “En iyi pratik” Qutra Labs için

> **Route-backed working set + fixed chrome + home-as-empty + opt-in panels.**  
> IDE’nin *şeklini* al; *motorunu* alma.

---

## 8. Katman katman mimari (Qutra Labs hedef modeli)

### 8.1 State model

```
Preferences (Zod, kalıcı)
  workbenchTabs[], workbenchRecentlyClosed[]
  bottomPanel*, contextSidebarWidth, inspector*
  …ürün prefs

Ephemeral UI (Zustand useUi vb.)
  palette, toasts, inspectorContent runtime

Router location
  pathname + search  = “aktif yüzey”

TabHistory (component state)
  back/forward for working set
```

İlke: **Kalıcı olan working set ve layout; geçici olan focus ve overlay.**

### 8.2 Routing vs editors

- Router = kaynak gerçek (hangi sayfa mount).
- Tabs = kullanıcının “şu an üzerinde çalıştığım set” projeksiyonu.
- Home router’da var, tabs’ta yok.
- Lab query (`?e=&view=`) tab kimliğinin parçası olabilir — VS Code’da URI query’ye benzer.

### 8.3 UI chrome

Sabit sözleşmeler:

1. Sidebar her zaman product destinations.
2. Tab strip yalnızca working set.
3. Main = Outlet.
4. Inspector = selection-driven, boşken yok.
5. Bottom = lab telemetry, default kapalı.

### 8.4 Persistence

- Tek Preferences yazımı; clamp on read.
- MAX_WORKBENCH_TABS = güvenlik tavanı, UX eviction değil.
- Cold start policy’yi dokümante et (panel closed) — kullanıcı “dün açıktı neden kapalı?” diye sorarsa cevap hazır olsun.

---

## 9. Settings mimarisi karşılaştırması

| Stil | Kim | Qutra Labs’a uygunluk |
|------|-----|----------------------|
| Settings as Editor + TOC + virtualized tree | VS Code | Aşırı; ilham: TOC + search |
| Ayrı SettingsWindow + JSON layers | Zed | Ayrı pencere şart değil; User/Project scope ilham |
| Rail + section pages | Modern editör ve sohbet uygulamaları / Qutra Labs | **Birincil hedef** |
| Workspace vs User scope | VS Code/AFFiNE/Zed | İleride workspace-level prefs gerekirse |

Öneri: Mevcut `SettingsPage` rail’ini koru; aramayı section içeriğine (kontrol etiketleri) genişlet; `?section=` sözleşmesini bozma.

---

## 10. Kafanda kalacak mental model

Üç kutucuk:

```
[ CHROME ]     sabit: sidebar, tabs bar, inspector slot, bottom slot
[ SURFACE ]    değişir: router Outlet (overview | lab | settings | …)
[ WORKING SET] tabs[] ⊆ surfaces, overview ∉ tabs
```

Kararlar:

- Bir yere gidince → surface değişir; tabbable ise set’e girer.
- Tab kapat → set küçülür; set boşsa surface = overview.
- Panel/inspector → chrome; surface değil (terminal sayfası hariç — o surface).

VS Code’da SURFACE ≈ editor; Zed’de ≈ pane item; sende ≈ route page.

---

## 11. Aksiyonel mimari ilkeler (önem sırası)

1. **Home empty-state’tir, tab değildir.** (`HOME_ROUTE`, `isTabbableRoute`) — bozulursa “Overview kapanmıyor” cehennemi.
2. **Tek workbench chrome, tek Outlet.** Yeni özellik önce “yeni part mı, yeni surface mi?” diye sınıflansın.
3. **Working set route kimliğiyle yaşar; etiketler render-time türetilir.** (i18n stale text yok)
4. **Gürültülü chrome default kapalı; iş sinyaliyle açılsın.** (bottom panel cold start + lab open)
5. **Son tab pencereyi öldürmez; home’a iner.**
6. **Layout ölçüleri clamp + commit-on-gesture-end.**
7. **Settings = rail + deep-linkable sections; Settings’i ikinci bir app yapma.**
8. **Lab panel ≠ Terminal page** — iki kanalın UX sözleşmesini karıştırma.
9. **Split/URI/contribution’ı ertele** — ürün kanıtı olmadan IDE karmaşıklığı alma.
10. **Persist schema’yı versiyonla** — tab/layout şekli değişince migration yaz (`migrations.ts` yolu hazır).
11. **Region failure isolation** — ErrorBoundary per chrome region (mevcut).
12. **Dokümante edilmiş cold-start politikası** — restore ile fresh hissi arasında bilinçli denge.

---

## 12. Somut Qutra Labs önerileri (kanıt → aksiyon)

| # | Öneri | Kanıt |
|---|--------|-------|
| A | Overview’ın tab olmaması invariant kalsın; testlerle kilitle | `workbench.ts` + VS Code Welcome |
| B | Cold start panel policy’yi kullanıcıya Settings’te “Oturum başında alt paneli kapat” olarak opsiyonelleştir (istersen) | VS Code panel restore vs Qutra Labs force-close gerilimi |
| C | Settings aramasını TOC+içerik yap (hafif); VS Code SettingsTree kopyalama | SettingsEditor2 vs mevcut rail |
| D | Status sinyallerini abartma; lab yokken status bar yok doğru | Zed/VS sürekli status ≠ Qutra Labs |
| E | İleride “pin + reopen” yeterli; split group ekleme | Zed/VS split maliyeti |
| F | Terminal sayfasında BottomPanel gizleme kuralını koru | Çift terminal chrome çakışması |
| G | AFFiNE’den sadece “view state ≠ browser URL bazen” fikrini not et; multi-router alma | AFFiNE Workbench PR |
| H | `workbenchMode` legacy enum transform → `core` — ölü mode rail’i geri getirme | `types.ts` |

---

## 13. Kaynaklar

### VS Code / Code-OSS

- [User interface](https://code.visualstudio.com/docs/editing/userinterface)
- [Custom layout](https://code.visualstudio.com/docs/configure/custom-layout)
- `src/vs/workbench/browser/layout.ts` (`PANEL_HIDDEN` default true)
- `src/vs/workbench/services/layout/browser/layoutService.ts` (`Parts`)
- `src/vs/workbench/browser/parts/editor/editorPart.ts`
- `src/vs/workbench/browser/parts/editor/editorGroupView.ts` (`closeEmptyGroups`)
- `contrib/welcomeGettingStarted/browser/startupPage.ts` (`workbench.startupEditor`)
- `contrib/preferences/browser/settingsEditor2.ts`, `settingsLayout.ts`, `tocTree.ts`

### Zed

- [Introducing Zed's new panel system](https://zed.dev/blog/new-panel-system)
- [Settings UI](https://zed.dev/blog/settings-ui) · [Glossary](https://zed.dev/docs/development/glossary)
- `crates/workspace/src/{workspace,pane,pane_group,dock}.rs`
- `crates/workspace/src/persistence/{model.rs,..}` · `when_closing_with_no_tabs` / `restore_on_startup`
- `crates/terminal_view/src/terminal_panel.rs` · `crates/settings_ui/`

### AFFiNE

- `packages/frontend/core/src/modules/workbench/entities/workbench.ts`
- Workbench system PR #5837

### Qutra Labs

- `src/domain/workbench.ts`
- `src/app/workbench/*`
- `src/features/settings/SettingsPage.tsx`
- `src/app/router.tsx`, `src/app/AppShell.tsx`

---

## 14. Sonuç cümlesi

Qutra Labs zaten doğru yolda: **IDE shape, product-scale state.**  
VS Code’dan parts + empty fallback + settings TOC fikirlerini; Zed’den dock/panel ayrımı ve empty-pane politikası netliğini; AFFiNE’den workbench/view ayrımını al.  
URI editor platformunu, contribution motorunu ve split grid’i alma.

Bir sonraki adım (bu belgenin dışı): ilkeleri ADR’ye çevirmek veya cold-start/settings arama için küçük UX ticket’ları açmak — kod değişikliği bu araştırmanın parçası değil.
