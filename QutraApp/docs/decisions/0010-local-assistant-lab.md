# ADR 0010 — Yerel Asistan Laboratuvarı (Ollama / Gemma, loopback-only)

**Status:** accepted · 2026-07-28 (Faz 4, §3.14)

> **Kısmen [ADR 0012](0012-agentic-assistant.md) ile geçersiz kılındı (2026-08-13).**
> Bu belgenin **"Karar 4 — Bilgisayar kontrolü: yok, iskelet var"** bölümü artık geçerli
> değildir: yerel asistan, kapalı ve üç öğeli bir izin listesindeki araçları
> (`terminal_run`, `launch_tool`, `read_context`) **çağrı başına açık kullanıcı onayıyla**
> çalıştırabilir. `PermissionGate` iskeleti canlı sözleşmeye dönüşmüştür.
> **Değişmeyenler:** bulut sağlayıcı yok; endpoint hâlâ izole loopback lab'ine sabitlenmiş
> (`127.0.0.1:11435`) ve tercih/IPC/model çıktısı ile değiştirilemez; 11434 hâlâ yasak;
> dosya *içeriği* hâlâ okunmuyor (Faz 2 kararı korunuyor); model hâlâ ne bir yol, ne bir
> çalışma dizini, ne de bir host adı verebilir — yalnızca kayıtlı bir **id** verir.
> Faz 2 notundaki "modelin hiçbir aracı yok, enjekte edilen talimatın ulaşacağı bir şey
> yok" gerekçesi bu tarihten sonra **geçerli değildir**; yerine geçen sınırlar 0012'dedir.
>
> **2026-09-29'da kısmen değiştirildi.** 11434 yasağı ve tek-port sabitlemesi
> artık geçerli değildir. Endpoint kapalı küme (`127.0.0.1:11434`, `127.0.0.1:11435`),
> seçim Rust'tadır; ayrıntı aşağıdaki Ek'tedir. Orijinal karar metni tarihsel kayıttır.

Bu not §3.14'ün "önce kısa mimari değerlendirme yaz" şartıdır. Uygulamadan önce
yazılmıştır; belirsizlikler varsayıma çevrilmeden aşağıda açıkça listelenmiştir.

## Bağlam — mevcut kod ne durumda

Denetim: repoda `ollama`, `localAssistant`, `11435`, `gemma`, `PermissionGate`
için **sıfır** eşleşme. Bu sıfırdan bir dilim.

İlgili mevcut yüzeyler:

| Yüzey | Durum |
|---|---|
| CSP (`tauri.conf.json:24`) | `connect-src 'self' ipc: http://ipc.localhost` |
| Tauri capability (`capabilities/default.json`) | http izni **yok** |
| Rust bağımlılıkları | `reqwest` / `tauri-plugin-http` **yok** |
| Prefs (`domain/types.ts`) | zod + defaults; asistan alanı yok |
| Assistant gövdesi (`app/AssistantPanel.tsx`) | deterministik özet; `assistant.noProvider` "cloud yok" diyor |
| `/jarvis` | `AssistantInspectorBody`'yi sarar — inspector ile **aynı** bileşen |

## Karar 1 — İstek katmanı: kontrollü TS istemci, Rust değil

§3.14/6 "tercihen native/Rust **veya kontrollü app service katmanında**" diyor.
İkinci seçeneği bilinçli olarak seçiyorum.

**Neden Rust değil:** streaming'i Rust'tan geçirmek `reqwest` + Tauri event
plumbing (tool supervisor'daki gibi) demek. Bu checkout'ta `cargo build`
**RC.EXE engeline takılıyor** (bkz. `docs/NATIVE_BUILD_BLOCKER.md`: yol
adındaki apostroflar). Yani yazacağım Rust streaming kodunu bu ortamda
uçtan uca **doğrulayamam**. Doğrulanmamış streaming göndermek, doğrulanmış bir
TS istemciden daha kötü bir teslimdir.

**Bunu telafi eden şey:** loopback kısıtı istemcide değil, **saf domain
fonksiyonunda** yaşar ve her istekten önce çalışır. Yani kural, ağ katmanının
kendisinden bağımsız olarak unit test edilebilir — asıl güvence orada.

**Bu karar geri alınabilir:** yol apostrofsuz hale gelip `cargo` çalışınca
istek katmanı Rust'a taşınabilir; domain kuralları aynen korunur.

## Karar 2 — CSP: loopback için minimum genişletme

Bugün `connect-src` loopback'e izin **vermiyor**; webview'den
`http://127.0.0.1:11435` fetch'i CSP tarafından reddedilir. Yani bu iş CSP'ye
dokunmadan çalışamaz.

Eklenecek tek şey `connect-src`'ye `http://127.0.0.1:11435` ve
`http://localhost:11435`. Diğer direktifler (`default-src`, `script-src`,
`object-src 'none'`, …) **değişmiyor**. Dış ağ hâlâ yasak: genişletme yalnız
loopback origin'i, yalnız bu port.

Not: CSP bir origin listesidir, port bazlı. Kullanıcı prefs'ten base URL'i
başka bir loopback portuna çevirirse **CSP o isteği reddeder**. Bu bilinçli:
CSP'yi tüm loopback'e açmak (`http://127.0.0.1:*`) sınırı gereksiz genişletirdi.
Kullanıcıya görünür hata olarak yansıtılacak, sessiz başarısızlık değil.

## Karar 3 — Yetki sırası (fail-closed)

Her istek şu sırayla geçer, ilk başarısızlıkta durur:

```
localAssistantEnabled === true ?   → hayırsa istek YOK (fetch hiç çağrılmaz)
  → base URL loopback mı ?         → değilse reddet (8.8.8.8, example.com, …)
    → port 11434 değil mi ?        → 11434 ise reddet (izole lab dışı)
      → ancak o zaman fetch
```

`11434` reddi ayrı ve açık bir kural: kullanıcının kendi varsayılan Ollama
sunucusuna kazara bağlanmak §3.14'te yasak. Bunu "loopback'tir, geçsin"
mantığına bırakmıyorum.

## Karar 4 — Bilgisayar kontrolü: yok, iskelet var

Bu fazda model **hiçbir** eylem çalıştıramaz: shell yok, dosya yok, tool
calling yok. `PermissionGate` yalnız **tip/arayüz** olarak dokümante edilir;
çalıştıran kod eklenmez. Bunu ayrı bir dosyada tip olarak bırakmak, ileride
"zaten yarısı vardı" diye kazara aktive edilmesini kolaylaştırmamalı — bu yüzden
hiçbir yerden import edilmez ve testle doğrulanmaz; sadece niyet kaydıdır.

## Riskler ve DOĞRULANMAMIŞ varsayımlar (varsayıma çevrilmedi)

1. **`gemma4:26b` model etiketini doğrulayamıyorum.** §3.14 bunu varsayılan
   olarak dayatıyor; öyle uyguluyorum. Etiket yanlışsa uygulama çökmez —
   "Model bulunamadı" durumuna düşer. Doğrulama kullanıcıdadır.
2. **`D:\Local-AI-Lab\start-isolated-ollama.ps1` varlığını doğrulamadım.** Bu yol
   yalnız **metin olarak** gösterilir; uygulama onu okumaz, çalıştırmaz, var mı
   diye bakmaz. §3.14/1 ve /  "autostart yok" gereği.
3. ~~**Canlı uçtan uca akış doğrulanamıyor.**~~ **ÇÖZÜLDÜ (2026-07-28).**
   `e2e/local-assistant-live.spec.ts` loopback'te Ollama'nın tel protokolünü
   konuşan gerçek bir HTTP sunucusu ayağa kaldırıyor (`/api/tags` +
   NDJSON `/api/chat`). Böylece health → Ready, token token streaming, Stop'un
   kısmi yanıtı koruması, yerel geçmiş ve "model yok → kurulu modeli seç"
   kurtarması **gerçek fetch/ReadableStream üzerinden** kanıtlanıyor.
   Uygulama içinde hiçbir mock yok.
4. **WebView2'de `fetch` + `ReadableStream`** destekleniyor, ancak bu checkout'ta
   paketli uygulamada koşturulamadı (aynı RC.EXE engeli). Dev/Chromium'da
   uçtan uca kanıtlandı.
5. **CSP iki yerde yaşıyor.** `tauri.conf.json` paketli pencereyi,
   `index.html` içindeki `<meta>` ise dev dahil her derlemede dokümanı yönetir.
   İlk uygulamada yalnız birincisi güncellenmişti; asistan CSP tarafından
   sessizce bloklanıyordu ve bunu ancak **gerçek istek yapan** bir test yakaladı.
   İkisinin aynı kalması artık testle zorunlu.

---

## Ek (2026-07-29) — Faz 1: transport Rust broker'a taşındı

**Karar 1 ("TS istemci") ağ sınırı için geçersizdir.** Gerekçesi zamanla
doğrulandı ve ortadan kalktı: TS istemci, RC.EXE engeli yüzünden Rust'ı
uçtan uca doğrulayamayacağım için seçilmişti. Apostrofsuz bir kopyada
`cargo test` çalıştığı kanıtlandıktan sonra bu gerekçe geçerliliğini yitirdi.

Faz 1 ile gelen (`src-tauri/src/assistant/`):

- `ollama.rs` — sabit endpoint, `/api/tags` + NDJSON `/api/chat`. Modülde
  host/port/URL alan **hiçbir API yok**; `no_proxy` ile makine genelindeki bir
  proxy'nin loopback trafiğini saptırması engelleniyor.
- `broker.rs` — tek-uçuş (ikinci istek `busy`), gerçek iptal, opt-in kontrolü
  her şeyden önce.
- `commands.rs` — `assistant_health` / `assistant_start` / `assistant_cancel`
  ve `assistant://stream` event kanalı. Zaman aşımları Rust'ta: health 5s,
  ilk token 30s, toplam 5 dk.
- `audit.rs` — istek kimliği, model, sonuç, süre. **İçerik yok.** Transkript
  zaten kullanıcının silebildiği Preferences'ta; ikinci bir kopya "sohbeti sil"
  düğmesini yalancı yapardı.
- `error.rs` — kararlı hata kodları (`disabled`, `busy`, `offline`,
  `model_missing`, `timeout_*`, `cancelled`, `http_<code>`, `internal`).
- `capabilities/assistant.json` — ayrı, izinsiz capability.

**Domain gate ilkeleri değişmedi:** opt-in URL'den önce, 11434 yasak, yalnız
loopback. Artık iki katmanda birden yaşıyorlar.

**Tamamlandı (aynı gün):** IPC adaptörü ve CSP daraltması da yapıldı.
`src/lib/localAssistant/client.ts` artık `invoke`/`listen` kullanıyor; renderer'da
Ollama'ya giden hiçbir HTTP yolu kalmadı ve `connect-src` **11435 içermiyor** —
yani webview isteği yapmamakla kalmıyor, **yapamıyor**. Bu belgenin yukarıdaki
"Karar 2 — CSP: loopback için minimum genişletme" bölümü tarihsel kayıttır:
o genişletme Faz 0 içindi ve Faz 1'de geri alındı.

## Ek (2026-07-29) — Model politikası

Endpoint sabit, **model değil**. Bu iki ayrı karardır ve karıştırılmamalıdır:

- **Endpoint** güvenlik sınırıdır: tek, sabit, `127.0.0.1:11435`. Kullanıcı
  değiştiremez.
- **Model** kullanıcı tercihidir: lab'e **kendi kurduğu** modeller arasından
  seçer. Varsayılan `qwen2.5:14b` (resmi Qwen 2.5, Apache 2.0).

Bu belgenin ilk sürümü `gemma4:26b`'yi "sabit varsayılan" diye yazıyordu; o bir
örnekti, kısıt değil. Rust broker hiçbir model adını hard-code etmez — modeli
argüman olarak alır ve yalnız boş olmadığını doğrular.

Kurulu model listesi yalnız `/api/tags`'tan gelir: uygulama **indirilebilir model
kataloğu göstermez** ve **hiçbir modeli otomatik çekmez**. Tercih edilen model
kurulu değilse durum `model_missing` olur ve kullanıcıya lab'e nasıl kuracağı
söylenir — sessizce başka bir modele düşülmez.

## Etkilenecek dosyalar

- `src/domain/localAssistant.ts` (yeni, saf + test)
- `src/lib/localAssistant/client.ts` (yeni, fetch enjekte edilebilir)
- `src/domain/types.ts` (4 prefs alanı)
- `src-tauri/tauri.conf.json` (yalnız `connect-src`)
- Settings → "Yerel Asistan Laboratuvarı"
- `AssistantPanel` / `/jarvis` (streaming + Stop)
- i18n 6 locale; `assistant.noProvider` metni yerel lab ile çelişmeyecek şekilde

## Kabul kapısı

enable=false iken sıfır fetch · loopback reddi · 11434 sıfır istek · kapalı
sunucuda çökme yok + Retry · streaming + Stop · Settings durumları ·
typecheck/test/build yeşil · bilinen sınırlamalar yazılı.

## Ek (2026-07-29) — Faz 2 ilk dilim: salt-okunur proje bağlamı

Qutra artık her tura, aktif projenin **kısa ve salt-okunur** bir özetini
ekleyebiliyor.

**Ne ekleniyor:** proje adı, amacı, yerel yolu ve o projeye kayıtlı kaynakların
başlık/hedefleri. Hepsi uygulamanın **zaten sahip olduğu** kayıtlardan.

**Ne eklenmiyor — ve neden:**

- **Dosya içeriği okunmuyor.** Sözleşme "excerpt VEYA metadata" diyordu;
  metadata seçildi çünkü içerik okumak yeni bir native dosya-sistemi
  capability'si gerektirirdi. Bu ayrı bir karardır ve kendi risk incelemesini
  hak eder. Metadata, "şu an ne üzerinde çalışıyorum" sorularının çoğunu zaten
  yanıtlıyor. Sonuç: bu dilimde **hiçbir yeni capability eklenmedi**.
- İndeks yok (FTS5/embedding), tool yok, yazma yok.

**Sınırlar sözleşmenin parçası** (`CONTEXT_LIMITS`, testli): alan başına 200
karakter, en fazla 10 kaynak, blok toplamı 2000 karakter. Sınırsız bir packer,
bir asistanın kullanıcının tüm çalışma alanını modele göndermesinin yoludur.

**Görünürlük:** eklenecek satırların tamamı sohbet ekranında, gönderilmeden
önce açılabilir bir listede gösteriliyor; tek tıkla kapatılabiliyor. Varsayılan
**açık** — çünkü asistanın kendisi zaten opt-in, hedef loopback broker ve blok
gönderilmeden önce görünüyor: sürpriz değil, ifşa.

**Prompt injection:** blok `CONTEXT (read-only)` / `END CONTEXT` ile
sınırlandırılıyor ve sistem mesajı bunun veri olduğunu, talimat olmadığını
söylüyor. Bu bir azaltmadır, garanti değil — asıl sınır modelin **hiçbir aracı
olmaması**: enjekte edilen bir talimatın ulaşabileceği bir şey yok.

**Bağlam transkripte yazılmıyor:** türetilmiş veri bayatlar, ve dışarıda
tutmak "sohbeti sil"in atlayacağı ikinci bir kopya bırakmıyor.

### Sıradaki (Faz 2b)

Dosya içeriği/alıntı gerekirse: en dar salt-okunur Tauri scope'u + kullanıcı
seçtiği root, canonical path kontrolü, boyut/MIME sınırı, symlink reddi. FTS5
indeksi ancak "metadata yetmiyor" ölçüldükten sonra.

## Ek (2026-09-29) — kapalı iki-port kümesi

Karar (2026-09-19): asistan uç noktası **yalnızca** iki loopback origin'dir:
`http://127.0.0.1:11434` ve `http://127.0.0.1:11435`. Başka bir origin — tercih, IPC
veya model çıktısı yoluyla — kabul edilmez. 11434 önce yoklanır; yanıt yoksa 11435
denenir. Seçilen origin ve model her tura bağlanır; tur ortasında sessiz geçiş yoktur.

**11435'in tek başına garanti ettiği şey.** İzole lab, varsayılan Ollama'dan ayrı bir
süreçti: kullanıcı makinesinde zaten dinleyen 11434'e kazara bağlanılmazdı. ADR'nin
Karar 3'ü ve Faz 1 eki bunu güvenlik sınırı olarak yazdı. Renderer o porta giden bir
HTTP yolu da taşımıyordu.

**11434'ü kabul etmenin bıraktığı şey.** 11434 yanıt verirse seçilir — 11435 lab'i
aynı anda çalışıyor olsa bile. 11434, başka bir Ollama'nın (çoğu kurulumda tüm
arayüzlere bağlı olabilen varsayılan süreç) en olası adresidir. "İzole lab" iddiası
bu yüzden durur: ürün, kullanıcının özel betiğini çağırmaz ve hangi sürecin dinlediğini
doğrulayamaz.

**Korunanlar.** Yalnız loopback. Küme Rust'ta kapalıdır; renderer origin seçemez.
Tur-bağlı seçim: ölü dinleyici veya kayıp model o turu görünür şekilde düşürür,
diğer porta veya başka bir modele sessizce geçmez. HTTP yönlendirmesi yoktur
(TM-003). Onay kapısı ve araç kimliği aynıdır. Cloud-backed modeller (Ollama
`remote_host` / `remote_model`) bulut yükseltmesi gelene kadar reddedilir — loopback'e gitmek,
verinin bu bilgisayarda kaldığı anlamına gelmez.

**Kimlik doğrulanmaz.** Her iki porttaki dinleyici de kimlik doğrulamasızdır; o
adreste dinleyen herhangi bir program seçilebilir. Sağlık raporu Rust'ın seçtiği
origin ve modeli gösterir; "hiçbir veri bu bilgisayardan çıkmaz" ancak cloud
escalation gelene kadar ve reddedilen cloud-backed modellerle birlikte doğrudur.

## Ek (2026-09-30) — Dinleyiciye güvenilmez

Yukarıdaki son cümle olduğu gibi bırakıldı; bu ek onun yerini alır. Güvenlik incelemesi
(`docs/reviews/2026-09-30-security-review.md`, bulgu #1) cümlenin
desteklenmediğini gösterdi:

- Cloud-backed reddi dinleyicinin kendi `/api/show` yanıtına dayanır.
  `remote_host` ve `remote_model` gelmezse boş sayılır
  (`src-tauri/src/assistant/ollama.rs:273-276`, `fc10c2b`) ve model kabul edilir;
  bu alanları hiç göndermeyen bir dinleyici reddi atlatır.
- 11434 veya 11435'te yanıt veren herhangi bir süreç — tehdit modelinin dışlamadığı yerel
  bir taklitçi dahil — istemleri, geçmişi ve bağlamı alır ve başka yere iletebilir.
  Kapalı küme ve yönlendirme reddi Qutra'nın *kendi* isteklerini sınırlar,
  dinleyicinin sonraki trafiğini değil.

**Karar.** Arayüz artık "hiçbir veri bu bilgisayardan çıkmaz" demez
(`localAssistant.sectionHint`, altı dil). Doğru olan söylenir: Qutra yalnızca
`127.0.0.1:11434` ve `127.0.0.1:11435`'e bağlanır ve telemetri göndermez; o adreste
yanıt veren program konuşmayı alır ve Qutra onun ne olduğunu doğrulayamaz. Sağlık
raporu bir önceki yoklamanın seçimini gösterdiği için her tur, gönderildiği adresi
ve modeli transkriptte kendisi gösterir; adres önceki yanıttan farklıysa bu
işaretlenir (`bound` olayı, incelemenin Orta bulgusu).

**Kabul edilen kalan risk.** Bu portlarda hangi programın çalıştığı kullanıcının
sorumluluğundadır; uygulama dinleyicinin kimliğini de trafiğini de doğrulayamaz.
Cloud-backed reddi yalnızca dürüst bir Ollama'ya karşı işe yarar. Bulut yükseltmesi
ya da bir dinleyici doğrulaması tasarlanırken bu yeniden ele alınmalıdır.
