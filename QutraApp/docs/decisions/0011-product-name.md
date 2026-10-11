# ADR 0011 — Ürün adı "Qutra Labs", iç tanımlayıcı "contextos"

**Status:** accepted · 2026-07-29

## Karar

İki ad bilinçli olarak farklıdır ve öyle kalacaktır.

| | Değer | Nerede |
|---|---|---|
| **Ürün adı** | `Qutra Labs` | Titlebar, pencere başlığı, installer (`productName`), `index.html` `<title>`, 6 locale'de `app.name`, termbase `DO_NOT_TRANSLATE` |
| **İç tanımlayıcı** | `contextos` | npm paket adı, Tauri `identifier` (`app.contextos.desktop`), `contextos.db`, `contextos.v1.*` depolama anahtarları, `contextos_fixture.rs`, repo adı |

Önceki denetim listesi "Marka Qutra→Qutra Labs" değişikliğini P1 olarak öneriyordu.
**Bu öneri reddedildi.** Ürün adı Qutra Labs'tir; Qutra Labs iç isimdir.

## Neden yeniden adlandırma yapılmadı

`productName` yalnız bir etiket değil: Tauri'nin `app_data_dir()` yolunu belirler.
Değiştirmek mevcut kurulumlarda şunları yetim bırakırdı:

- `contextos.db` (tüm kullanıcı verisi),
- native araç kaydı,
- `private-tools-consent` işaretçisi (ADR 0007) — sessizce "onay verilmemiş"e düşerdi.

Kullanıcıya bu, verinin kaybolması gibi görünürdü. Kozmetik bir tutarlılık için
alınacak bir risk değil.

## Asıl tehlike: iki yöne de find/replace

Bu ayrım kırılgandır ve **bir kez zaten kırılmıştır**: bir marka find/replace
Lab ipucundaki *literal dosya adını* da süpürüp altı locale'de
`src-tauri/fixtures/Qutra Labs_fixture.rs` üretti — var olmayan bir yol.
Anahtar parity testleri bunu göremedi, çünkü anahtar mevcuttu ve çevrilmişti.

Bu yüzden karar testle kilitlendi (`src/lib/i18n/naming.test.ts`):

- `app.name`, `productName`, pencere başlığı ve `<title>` **Qutra Labs** olmalı;
- paket adı, bundle identifier, veritabanı adı ve depolama anahtarı öneki
  **contextos** kalmalı;
- hiçbir çeviri dizesi ürün adını bir **yol/dosya adı/tanımlayıcı** içine
  gömmemeli (`Qutra Labs.db`, `Qutra Labs/logs`, `…_fixture.rs` gibi);
- hiçbir kullanıcıya görünen dize iç adı marka gibi göstermemeli (`Qutra Labs`).

Ayrıca `i18n.test.ts` fixture ipucunun **diskte gerçekten var olan** bir dosyayı
işaret ettiğini doğrular.

## Sonuç

- Yeniden adlandırma yapılmadı; veri dizini korundu.
- Repo/dokümanların `Qutra Labs` demesi bir tutarsızlık değil, kasıtlı iç isimdir.
- Gelecekte biri "markayı düzeltmek" isterse, testler her iki yönde de durduracak.
