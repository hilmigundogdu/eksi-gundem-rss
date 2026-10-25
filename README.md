# ekşi sözlük gündem RSS

Ekşi Sözlük gündemini ve günlük debeyi iki ayrı RSS 2.0 beslemesine çevirir.

- **Gündem:** https://hilmigundogdu.github.io/eksi-gundem-rss/feed.xml
- **Debe:** https://hilmigundogdu.github.io/eksi-gundem-rss/debe.xml

## Öğeler

- **Gündem başlığı** (`feed.xml`): başlık `(182) - başlık adı` biçimindedir; entry sayısı her çalışmada güncellenir, guid değişmez. İçerikte başlığın **bugün** (İstanbul saatiyle) yazılmış entry'lerinden en beğenilen ilk 20'si vardır (Ekşi'nin “şükela: bugün” süzgeci, `?a=dailynice`; metin, yazar, beğeni sayısı, entry'nin kalıcı bağlantısı olan tarih). Öğenin bağlantısı da bu süzgeci açar. `pubDate`, başlığın gündemde ilk görüldüğü andır.
- **Debe entry'si** (`debe.xml`): debedeki her entry ayrı öğedir; başlık `1. başlık adı` biçimindedir, öğe listesi debenin içindekileri gibi okunur. İçerikte entry metni, yazar, beğeni, tarih ve başlığın bağlantısı; yazar `dc:creator`, gün `debe 24.10.2026` kategorisidir. Okuyucular tarihe göre dizdiği için `pubDate` debenin ilk çekildiği andan sırası kadar saniye geridedir; böylece debe sırası korunur.

## Nasıl çalışır

- GitHub Actions her 30 dakikada `gundem.mjs`'i çalıştırır ve çıktıyı GitHub Pages'te yayımlar. Depoya commit atılmaz.
- Ekşi, düz istekleri Cloudflare challenge'ına düşürdüğü için sayfalar doğrudan değil, [Jina Reader](https://jina.ai/reader/) (`r.jina.ai`) üzerinden okunur. Anahtarsız kullanılır; istekler sırayla ve aralarında en az 3,5 saniye olacak şekilde gider (sınır dakikada 20 istek).
- Durum ayrıca saklanmaz: her çalışma yayımlanmış iki beslemeyi okur; ilk görülme tarihlerini, çekilmiş entry'leri ve debe listelerini (`debe.xml` kanalındaki `egr:debe` öğeleri) taşır.
- Bir çalışmada ana sayfa ve debe listesi dışında en çok 60 sayfa çekilir; debe genelde ilk çalışmada tamamlanır. Öncelik debededir; kalan bütçe gündem sayfalarına gider. Ekşi sayfada 10 entry gösterdiği için gündem başlığı iki sayfa ister; ikinci sayfa, sırada bekleyen hiç çekilmemiş başlıkların ilk sayfalarına bütçe kalıyorsa çekilir. Gündemde öncelik hiç çekilmemiş başlıklardadır; gündemde kalan başlığın entry'leri en çok 6 saatte bir ve gün değişince yenilenir; dünden kalan entry'ler gösterilmez, yenilenemeyen başlık o gün çekilene dek yalnız sayıyla yayımlanır. Bütçeye sığmayan başlık o çalışmada yalnız sayıyla yayımlanır; yarım kalan debe sonraki çalışmalarda yerinde tamamlanır.
- **Debe kuralı:** Zamanlama UTC'dir (`*/30`), gün kuralı betikte İstanbul saatiyle uygulanır. 00:00'dan (21:00 UTC) sonraki ilk çalışmada dünün debesi aranır ve doldurulmaya başlar. Ekşi debeyi henüz yenilememişse (liste elde olan debeyle aynıysa) yeni gün açılmaz, sonraki çalışmalarda yeniden denenir; debenin günü entry tarihlerinden çıkarılır. Gün içinde dünün debesi tamamsa debe için hiç istek atılmaz, bütçenin tamamı gündeme kalır. Debede çekilemeyen entry 24 saat boyunca yeniden denenir.
- Gündemden düşen başlıklar 3 gün, en çok 150 öğe; debe günleri 14 gün tutulur.
- Jina ana sayfayı getiremezse iş düşer ve eski besleme yerinde kalır. Debe listesi ya da tek bir sayfa düşerse yalnız o kısım sonraki çalışmaya kalır.
- Workflow günde bir kez kendini etkin tutar; GitHub 60 gün etkinlik olmayan depoda zamanlanmış işi kapatır.

Yerel deneme (Node 18+, bağımlılık yok):

```sh
node gundem.mjs --out /tmp/eksi --budget 3            # sıfırdan, 3 sayfa
node gundem.mjs --prev /tmp/eksi/feed.xml --prev-debe /tmp/eksi/debe.xml --out /tmp/eksi2 --budget 3
```
