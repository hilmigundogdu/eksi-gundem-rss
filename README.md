# ekşi sözlük gündem RSS

Ekşi Sözlük ana sayfasındaki gündemi RSS 2.0 beslemesine çevirir. Her gündem başlığı bir öğedir; öğede başlığın entry sayısı ve en beğenilen ilk 10 entry (metin, yazar, beğeni sayısı, entry bağlantılı tarih) bulunur.

**Besleme:** https://hilmigundogdu.github.io/eksi-gundem-rss/feed.xml

## Nasıl çalışır

- GitHub Actions her 30 dakikada `gundem.mjs`'i çalıştırır ve çıktıyı GitHub Pages'te yayımlar. Depoya commit atılmaz.
- Ekşi, düz istekleri Cloudflare challenge'ına düşürdüğü için sayfalar doğrudan değil, [Jina Reader](https://jina.ai/reader/) (`r.jina.ai`) üzerinden okunur. Anahtarsız kullanılır; istekler sırayla ve aralarında en az 3,5 saniye olacak şekilde gider (sınır dakikada 20 istek).
- Durum ayrıca saklanmaz: her çalışma yayımlanmış beslemeyi okur, başlıkların ilk görülme tarihini (`pubDate`) ve çekilmiş entry'lerini taşır.
- Bir çalışmada en çok 15 başlık sayfası çekilir. Öncelik hiç çekilmemiş başlıklardadır; gündemde kalan başlığın entry'leri en çok 6 saatte bir yenilenir. Sığmayan başlık o çalışmada yalnız entry sayısıyla yayımlanır.
- Gündemden düşen başlıklar 3 gün, en çok 150 öğe olarak tutulur.
- Jina ana sayfayı getiremezse iş düşer ve eski besleme yerinde kalır. Tek bir başlık sayfası düşerse yalnız o başlık sonraki çalışmaya kalır.
- Workflow günde bir kez kendini etkin tutar; GitHub 60 gün etkinlik olmayan depoda zamanlanmış işi kapatır.

Yerel deneme (Node 18+, bağımlılık yok):

```sh
node gundem.mjs --out /tmp/eksi --budget 2            # sıfırdan, 2 başlık sayfası
node gundem.mjs --prev /tmp/eksi/feed.xml --out /tmp/eksi2 --budget 2
```
