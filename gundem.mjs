#!/usr/bin/env node
// Ekşi Sözlük gündemini (feed.xml) ve günlük debeyi (debe.xml, her entry ayrı öğe) RSS 2.0 beslemelerine çevirir. Bağımlılık yok (Node 18+).
// Ekşi'ye doğrudan istek atılmaz: Cloudflare düz isteği challenge'a düşürdüğü için sayfalar Jina Reader (r.jina.ai) üzerinden okunur.
// Anahtarsız Jina isteği de challenge'a düşerse çalışmanın kalanı JINA_API_KEY ile Jina'nın tarayıcı motorundan gider.
//
// Ortam:  FEED_URL  yayımlanmış gündem beslemesinin adresi; debe beslemesi yanındaki debe.xml'dir. İlk görülme tarihleri
//                   ve çekilmiş entry'ler bu iki beslemeden taşınır.
//         OUT_DIR   çıktı klasörü (varsayılan: public).
//         JINA_API_KEY  yalnız anahtarsız istek challenge'a düşünce kullanılır; yoksa o çalışma yayın yapmaz.
// Yerel deneme:  node gundem.mjs [--prev eski-feed.xml] [--prev-debe eski-debe.xml] [--out klasor] [--budget 3]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const SITE = 'https://eksisozluk.com';
const JINA = 'https://r.jina.ai/';
const REPO = 'https://github.com/hilmigundogdu/eksi-gundem-rss';
const USER_AGENT = `eksi-gundem-rss/1.0 (+${REPO})`;
const TIMEOUT_MS = 45_000;
const KEYED_TIMEOUT_MS = 90_000;            // tarayıcı motoru sayfanın öğesini en çok 40 sn bekler (X-Timeout)
const GAP_MS = 3_500;                       // Jina istekleri arasındaki en kısa ara (anahtarsız sınır dakikada 20 istek)
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ENTRIES_PER_TOPIC = 20;               // gündem başlığı başına son 24 saatin en beğenilen entry'leri; Ekşi sayfada 10 gösterdiği için iki sayfa
const TODAY = '?a=dailynice';               // Ekşi'nin “şükela: bugün” süzgeci; gece yarısı sıfırlanmaz, son 24 saati gösterir
const REFRESH_MS = 6 * HOUR;                // gündemde kalan başlığın entry'leri en çok bu sıklıkla yenilenir
const KEEP_MS = 3 * DAY;                    // gündemden düşen başlık son görülmesinden sonra bu kadar süre beslemede kalır
const MAX_ITEMS = 150;                      // gündem öğesi sınırı
const DEBE_KEEP_MS = 14 * DAY;              // debe günü ilk çekilmesinden sonra bu kadar süre beslemede kalır
const DEBE_RETRY_MS = DAY;                  // debede düşen entry bu süre boyunca yeniden denenir; silinmiş entry sonsuza dek istek yemez

const { values: args } = parseArgs({ options: {
  prev: { type: 'string' }, 'prev-debe': { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' },
} });
const feedUrl = process.env.FEED_URL || '';
const debeFeedUrl = feedUrl && new URL('debe.xml', feedUrl).href;
const outDir = args.out || process.env.OUT_DIR || 'public';
// Bir çalışmada çekilecek en çok ayrıntı sayfası (debe entry'leri + gündem sayfaları); ana sayfa ve debe listesi buna girmez.
const budget = Math.max(0, Number(args.budget ?? 60) || 0);

const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©',
}));

function decode(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e) => {
    if (e[0] !== '#') return ENTITIES.get(e.toLowerCase()) ?? all;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const text = html => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = s => String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = s => `<![CDATA[${String(s).replace(INVALID_XML, '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const seconds = ms => (ms / 1000).toFixed(1).replace('.', ',');

// Günler 'YYYY-MM-DD' olarak tutulur; debe günü İstanbul saatine göredir.
const istanbulDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const previousDay = day => new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
const trDate = day => day.split('-').reverse().join('.');
// Entry'nin yazılış anı ("25.10.2026 19:22 ~ 26.10.2026 00:14" düzenlenmişse ilk tarih); İstanbul yaz saatsiz UTC+3'tür.
const entryTime = date => { const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/.exec(date); return m ? Date.UTC(+m[3], m[2] - 1, +m[1], m[4] - 3, +m[5]) : null; };
const entryDay = date => { const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(date); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const mostCommon = list => [...list.reduce((map, x) => map.set(x, (map.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

function attrsOf(tag) {
  const attrs = {};
  for (const [, name, dq, sq] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[name.toLowerCase()] ??= decode(dq ?? sq);
  return attrs;
}

function absUrl(href) {
  try {
    const url = new URL(href, SITE);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function isChallenge(res, body) {
  if ((res.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge') return true;
  // Olağan sayfalara da eklenen cdn-cgi/challenge-platform/scripts/jsd betiği challenge sayılmaz.
  return /_cf_chl_opt|<title>\s*(Just a moment|Attention Required|Bir dakika)/i.test(body);
}

// Anahtarla istenen sayfa parçası: tarayıcı motoru challenge'ı çözer, wait gelene dek bekler ve yalnız target'ı döndürür. Jina token'ı döndürülen
// içerik kadar düşer (gündem listesi ~4 bin, başlık sayfası ~16 bin); tam sayfa, hele challenge sayfası (~310 bin), kotayı hızla bitirir.
const LIST = { wait: 'ul.topic-list', target: 'ul.topic-list' };
const PAGE = { wait: '#entry-item-list', target: 'h1#title, #entry-item-list, div.pager' };
const JINA_KEY = process.env.JINA_API_KEY || '';
const jina = { keyed: false, requests: 0, tokens: 0 };

// Jina istekleri sırayla gider; anahtarsız istek bir öncekinin bitişinden en az GAP_MS sonra gider (anahtarla sınır dakikada 500).
let lastDone = 0;
async function request(path, view) {
  const keyed = jina.keyed, wait = keyed ? 0 : lastDone + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const started = Date.now();
  try {
    // X-No-Cache: Jina'nın önbelleği sayfayı yarım saatten eski gösterebiliyor.
    const headers = { 'X-Return-Format': 'html', 'X-No-Cache': 'true', 'User-Agent': USER_AGENT };
    if (keyed) Object.assign(headers, { Authorization: `Bearer ${JINA_KEY}`, Accept: 'application/json', 'X-Engine': 'browser',
      'X-Wait-For-Selector': view.wait, 'X-Target-Selector': view.target, 'X-Timeout': '40' });
    const res = await fetch(JINA + SITE + path, { headers, signal: AbortSignal.timeout(keyed ? KEYED_TIMEOUT_MS : TIMEOUT_MS) });
    let body = await res.text();
    if (keyed) {
      jina.requests++;
      try { const { data } = JSON.parse(body); body = data?.html ?? body; jina.tokens += Number(data?.usage?.tokens) || 0; } catch { /* hata gövdesi JSON değil */ }
    }
    return { status: res.status, body, ms: Date.now() - started, challenge: isChallenge(res, body), remaining: res.headers.get('x-ratelimit-remaining') ?? '-' };
  } finally {
    lastDone = Date.now();
  }
}

// Anahtarsız istek challenge'a düşünce aynı istek anahtarla yinelenir ve çalışmanın kalanı anahtarla gider.
async function viaJina(path, view) {
  const r = await request(path, view);
  if (!r.challenge || jina.keyed || !JINA_KEY) return r;
  jina.keyed = true;
  console.log('Anahtarsız Jina isteği Cloudflare challenge\'ına düştü; bu çalışmanın kalanı Jina anahtarı ve tarayıcı motoruyla gider.');
  return request(path, view);
}

async function fetchList(path, label) {
  const r = await viaJina(path, LIST);
  console.log(`Jina ${label}: HTTP ${r.status}, ${Buffer.byteLength(r.body)} bayt, ${seconds(r.ms)} sn, kalan istek hakkı ${r.remaining}`);
  if (r.status !== 200) throw new Error(`Jina ${label} için HTTP ${r.status} döndü (${text(r.body).slice(0, 200)})`);
  if (r.challenge) throw new Error(`Jina üzerinden ${label} için Cloudflare challenge sayfası geldi`);
  return r.body;
}

// Başlık ya da entry sayfası; 429'da çağıran o çalışmadaki öteki ayrıntı sayfalarını bırakır.
async function fetchDetail(path) {
  const r = await viaJina(path, PAGE);
  if (r.status === 429) throw Object.assign(new Error('HTTP 429, Jina sınırı doldu'), { stop: true });
  if (r.status === 402) throw Object.assign(new Error('HTTP 402, Jina anahtarının token kotası bitti'), { stop: true });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  if (r.challenge) throw new Error('Cloudflare challenge sayfası');
  return { page: parsePage(r.body), ms: r.ms, remaining: r.remaining };
}

function topicList(html) {
  const list = /<ul\b[^>]*\bclass\s*=\s*["'][^"']*\btopic-list\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i.exec(html);
  if (!list) throw new Error('topic-list bulunamadı; sayfa yapısı değişmiş olabilir');
  return [...list[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(([, attrs, content]) => ({ url: absUrl(attrsOf(attrs).href ?? ''), content }));
}

function parseTopics(html) {
  const topics = [], seen = new Set();
  for (const { url, content } of topicList(html)) {
    const m = url && new URL(url).hostname === 'eksisozluk.com' && /^\/([^/]+)--(\d+)$/.exec(new URL(url).pathname);
    if (!m || seen.has(m[2])) continue;
    const title = text(content.replace(/<small\b[^>]*>[\s\S]*?<\/small>/gi, ''));
    if (!title) continue;
    seen.add(m[2]);
    const count = text(/<small\b[^>]*>([\s\S]*?)<\/small>/i.exec(content)?.[1] ?? '');
    topics.push({ id: m[2], title, count, guid: `${SITE}/${m[1]}--${m[2]}`, link: `${SITE}/${m[1]}--${m[2]}${TODAY}` });
  }
  if (!topics.length) throw new Error('topic-list içinde başlık bulunamadı');
  return topics;
}

function parseDebeList(html) {
  const ids = [], captions = new Map();
  for (const { url, content } of topicList(html)) {
    const id = url && /^\/entry\/(\d+)$/.exec(new URL(url).pathname)?.[1];
    if (!id || captions.has(id)) continue;
    ids.push(id);
    captions.set(id, text(content));
  }
  if (!ids.length) throw new Error('debe listesinde entry bulunamadı');
  return { ids, captions };
}

// Entry metni: yalnız <br> ve mutlak adresli <a> kalır; öteki etiketler düşer, içerikleri kalır.
function cleanContent(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  let out = '', open = false;
  for (const [, slash, name, rest, plain] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+|<)/g)) {
    if (plain !== undefined) { out += esc(decode(plain)); continue; }
    const tag = name.toLowerCase();
    if (tag === 'br') out += '<br>';
    else if (tag === 'a') {
      if (open) { out += '</a>'; open = false; }
      if (slash) continue;
      const a = attrsOf(rest), href = absUrl(a.href ?? '');
      if (!href) continue;
      out += `<a href="${esc(href)}"${a.title ? ` title="${esc(a.title)}"` : ''}>`;
      open = true;
    }
  }
  if (open) out += '</a>';
  return out.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
}

// Başlık sayfası da tek entry sayfası da aynı yapıda: h1#title ve entry'ler (li[data-id][data-author]); başlık sayfasında
// div.pager[data-pagecount] sayfa sayısını verir.
function parsePage(html) {
  const h1 = /<h1\b[^>]*\bid\s*=\s*["']title["'][^>]*>/i.exec(html);
  if (!h1) throw new Error('h1#title yok');
  const { 'data-title': title = '', 'data-id': id = '', 'data-slug': slug = '' } = attrsOf(h1[0]);
  const starts = [...html.matchAll(/<li\b[^>]*\bdata-id\s*=\s*["']\d+["'][^>]*>/gi)].filter(m => /\bdata-author\s*=/.test(m[0]));
  const entries = [];
  for (const [i, m] of starts.entries()) {
    const a = attrsOf(m[0]);
    const part = html.slice(m.index + m[0].length, starts[i + 1]?.index ?? html.length);
    const content = (/<div\b[^>]*\bclass\s*=\s*["']content["'][^>]*>([\s\S]*?)<\/div>\s*<footer\b/i.exec(part)
      ?? /<div\b[^>]*\bclass\s*=\s*["']content["'][^>]*>([\s\S]*?)<\/div>/i.exec(part))?.[1];
    if (content === undefined) continue;
    const permalink = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bentry-date\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/i.exec(part);
    entries.push({
      id: a['data-id'],
      author: a['data-author'] || '?',
      favorites: Number(a['data-favorite-count']) || 0,
      html: cleanContent(content),
      date: permalink ? text(permalink[2]) : '',
      url: absUrl(permalink ? attrsOf(permalink[1]).href ?? '' : '') ?? `${SITE}/entry/${a['data-id']}`,
    });
  }
  if (!entries.length) throw new Error('entry bulunamadı');
  const pager = /<div\b[^>]*\bclass\s*=\s*["']pager["'][^>]*>/i.exec(html);
  return { id, slug, title: title.trim(), entries, pages: Number(pager && attrsOf(pager[0])['data-pagecount']) || 1 };
}

const entryFooter = e => `<p>— ${esc(e.author)} · ${e.favorites} beğeni · <a href="${esc(e.url)}">${esc(e.date || 'entry')}</a></p>`;
const renderEntry = e => `<blockquote><p>${e.html}</p></blockquote>\n${entryFooter(e)}`;

// Debe entry'si tek öğedir: metin, alt satır ve başlığın bağlantısı. Sıra numarası yalnız öğe başlığındadır, yazarken eklenir.
function debeEntry(page, entry, caption) {
  const topic = page.title || caption || 'entry';
  const topicUrl = page.slug && page.id ? `${SITE}/${page.slug}--${page.id}` : `${SITE}/?q=${encodeURIComponent(topic)}`;
  return { topic, link: entry.url, author: entry.author,
    description: `<p>${entry.html}</p>\n${entryFooter(entry)}\n<p>başlık: <a href="${esc(topicUrl)}">${esc(topic)}</a></p>` };
}

// Önceki beslemeleri biz ürettiğimiz için düzenli ifadeyle okumak yeterli.
const xmlItems = body => [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
const raw = (item, tag) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? '';
const field = (item, tag) => decode(raw(item, tag)).trim();
function description(item) {
  const value = raw(item, 'description');
  return (value.includes('<![CDATA[') ? value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : decode(value)).trim();
}

function parseFeedXml(body) {
  if (!/<rss\b/.test(body)) throw new Error('Önceki gündem beslemesi RSS değil; tarihler kaybolmasın diye yayın yapılmadı.');
  const topics = [], debes = [];
  for (const item of xmlItems(body)) {
    const guid = field(item, 'guid'), firstSeen = Date.parse(field(item, 'pubDate'));
    if (!Number.isFinite(firstSeen)) continue;
    const desc = description(item);

    // Geçiş: debe eskiden bu beslemede günlük tek öğeydi. debe.xml yokken yalnız liste ve tarih alınır, entry'ler yeniden çekilir.
    const debeDay = /\/debe#(\d{4}-\d{2}-\d{2})$/.exec(guid)?.[1];
    if (debeDay) {
      debes.push({ day: debeDay, ids: field(item, 'egr:debeIds').split(/\s+/).filter(Boolean), entries: new Map(), firstSeen });
      continue;
    }

    const id = /--(\d+)$/.exec(guid)?.[1];
    if (!id) continue;
    let title = field(item, 'title'), count = field(item, 'egr:count'), entriesHtml = desc;
    if (count && title.startsWith(`(${count}) - `)) title = title.slice(count.length + 5);
    const countLine = /^<p>([^<]*) entry<\/p>\s*/.exec(desc);   // eski biçim: sayı açıklamanın ilk satırındaydı
    if (countLine) { count ||= countLine[1]; entriesHtml = desc.slice(countLine[0].length); }
    const fetchedAt = Date.parse(field(item, 'egr:entriesFetched')), lastSeen = Date.parse(field(item, 'egr:lastSeen'));
    topics.push({
      id, guid, title, link: field(item, 'link'), count,
      entriesHtml: Number.isFinite(fetchedAt) ? entriesHtml : '',
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
      firstSeen, lastSeen: Number.isFinite(lastSeen) ? lastSeen : firstSeen,
    });
  }
  return { topics, debes };
}

// Debe beslemesi: her entry bir öğe (guid entry adresi); günlerin listesi ve ilk çekilme anı kanaldaki egr:debe öğelerindedir.
function parseDebeXml(body) {
  if (!/<rss\b/.test(body)) throw new Error('Önceki debe beslemesi RSS değil; tarihler kaybolmasın diye yayın yapılmadı.');
  const entries = new Map();
  for (const item of xmlItems(body)) {
    const id = /\/entry\/(\d+)$/.exec(field(item, 'guid'))?.[1];
    if (id) entries.set(id, { topic: field(item, 'egr:topic'), link: field(item, 'link'), author: field(item, 'dc:creator'), description: description(item) });
  }
  const debes = [];
  for (const [, attrs, list] of body.matchAll(/<egr:debe\b([^>]*)>([^<]*)<\/egr:debe>/g)) {
    const { day, seen } = attrsOf(attrs), firstSeen = Date.parse(seen);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !Number.isFinite(firstSeen)) continue;
    const ids = list.split(/\s+/).filter(Boolean);
    debes.push({ day, ids, entries: new Map(ids.filter(id => entries.has(id)).map(id => [id, entries.get(id)])), firstSeen });
  }
  return debes;
}

async function readPrevious(file, url, label) {
  if (file) return readFile(file, 'utf8');
  if (!url) return null;
  const res = await fetch(`${url}?t=${Date.now()}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) { console.log(`Önceki ${label} yok (404).`); return null; }
  if (!res.ok) throw new Error(`Önceki ${label} okunamadı (HTTP ${res.status}); tarihler kaybolmasın diye yayın yapılmadı.`);
  return res.text();
}

async function loadPrevious() {
  if (!args.prev && !feedUrl) console.log('FEED_URL yok; önceki beslemeler okunmadı, sıfırdan başlanıyor.');
  const [feed, debe] = await Promise.all([
    readPrevious(args.prev, feedUrl, 'gündem beslemesi'), readPrevious(args['prev-debe'], debeFeedUrl, 'debe beslemesi'),
  ]);
  const { topics, debes: legacy } = feed ? parseFeedXml(feed) : { topics: [], debes: [] };
  if (!debe && legacy.length) console.log(`Debe beslemesi yok; gündem beslemesindeki ${legacy.length} eski debe günü taşınıyor.`);
  return { topics, debes: debe ? parseDebeXml(debe) : legacy };
}

// Debe: her gün bir önceki günün debesi. Liste yalnız dünün (İstanbul) debesi elde yokken çekilir; böylece
// İstanbul'da 00:00'dan sonraki ilk çalışmada yeni gün aranır, gün içinde debe tamamsa hiç istek gitmez.
// Liste elde olan bir debeyle aynıysa (Ekşi henüz yenilememiş) yeni gün açılmaz; gün, çekilen entry'lerin tarihinden çıkarılır.
async function updateDebe(previous, now, limit) {
  const debes = previous.filter(debe => now - debe.firstSeen <= DEBE_KEEP_MS);
  const yesterday = previousDay(istanbulDay(now));
  let work = debes.find(debe => debe.day === yesterday), fresh = false;
  if (!work) {
    try {
      const list = parseDebeList(await fetchList('/debe', 'debe listesi'));
      // Ayrı günlerin debeleri entry paylaşmaz: ortak entry'si olan liste elde olan debedir (Ekşi debeyi henüz yenilememiş).
      const same = debes.find(debe => list.ids.some(id => debe.ids.includes(id)));
      if (same) {
        const changed = same.ids.join() !== list.ids.join();
        console.log(`Debe listesi (${list.ids.length} entry) elde olan ${trDate(same.day)} debesi; Ekşi yeni debeyi henüz yayımlamamış, yeni gün açılmadı${changed ? ' (liste güncellendi)' : ''}.`);
        Object.assign(same, { ids: list.ids, captions: list.captions });
        work = same;
      } else {
        work = { ids: list.ids, captions: list.captions, entries: new Map(), firstSeen: now };
        fresh = true;
      }
    } catch (error) {
      console.log(`Debe listesi alınamadı (${error.message}); debe bu çalışmada atlandı.`);
      return { debes, used: 0, stop: false };
    }
  }

  const missing = work.ids.filter(id => !work.entries.has(id));
  const retry = fresh || now - work.firstSeen <= DEBE_RETRY_MS;
  const queue = retry ? missing.slice(0, limit) : [];
  console.log(`Debe ${fresh ? '(yeni liste)' : trDate(work.day)}: ${work.ids.length} entry, eksik ${missing.length}${retry ? '' : ' (yeniden deneme süresi doldu)'}; bu çalışmada ${queue.length} entry çekilecek.`);
  const days = [];
  let used = 0, stop = false;
  for (const [i, id] of queue.entries()) {
    const tag = `  [debe ${i + 1}/${queue.length}] ${work.captions?.get(id) ?? id}`;
    used++;
    try {
      const { page, ms, remaining } = await fetchDetail(`/entry/${id}`);
      const entry = page.entries.find(e => e.id === id) ?? page.entries[0];
      work.entries.set(id, debeEntry(page, entry, work.captions?.get(id)));
      if (entryDay(entry.date)) days.push(entryDay(entry.date));
      console.log(`${tag}: ${entry.author}, ${entry.date} (HTTP 200, ${seconds(ms)} sn, kalan istek hakkı ${remaining})`);
    } catch (error) {
      console.log(`${tag}: atlandı, sonraki çalışmaya kaldı (${error.message})`);
      if (error.stop) { stop = true; break; }
    }
  }

  if (fresh) {
    const day = mostCommon(days);
    if (!day) {
      console.log('Yeni debenin günü belirlenemedi (entry çekilemedi); gün açılmadı.');
    } else {
      if (day !== yesterday) console.log(`Not: debe entry'lerinin tarihi ${trDate(day)}, İstanbul saatiyle dün ${trDate(yesterday)}; entry tarihi esas alındı.`);
      const existing = debes.find(debe => debe.day === day);
      if (existing) {
        console.log(`Debe ${trDate(day)} zaten vardı; liste güncellendi, çekilmiş entry'ler korundu.`);
        existing.ids = work.ids;
        for (const [id, entry] of work.entries) existing.entries.set(id, entry);
        work = existing;
      } else {
        work.day = day;
        debes.push(work);
      }
    }
  }
  if (work.day) console.log(`Debe ${trDate(work.day)}: ${work.ids.filter(id => work.entries.has(id)).length}/${work.ids.length} entry hazır.`);
  return { debes, used, stop };
}

function render(channel, items, now) {
  const date = ms => new Date(ms).toUTCString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:egr="${REPO}">`,
    '<channel>',
    `<title>${esc(channel.title)}</title>`,
    `<link>${esc(channel.link)}</link>`,
    `<description>${esc(channel.description)}</description>`,
    '<language>tr</language>',
    `<lastBuildDate>${date(now)}</lastBuildDate>`,
    '<ttl>30</ttl>',
    `<generator>${REPO}</generator>`,
    ...(channel.self ? [`<atom:link href="${esc(channel.self)}" rel="self" type="application/rss+xml"/>`] : []),
    ...channel.state ?? [],
  ];
  for (const item of items) {
    lines.push('<item>',
      `<title>${esc(item.title)}</title>`,
      `<link>${esc(item.link)}</link>`,
      `<guid isPermaLink="false">${esc(item.guid)}</guid>`,
      `<pubDate>${date(item.firstSeen)}</pubDate>`,
      ...(item.author ? [`<dc:creator>${esc(item.author)}</dc:creator>`] : []),
      ...(item.category ? [`<category>${esc(item.category)}</category>`] : []),
      ...(item.description ? [`<description>${cdata(item.description)}</description>`] : []),
      ...item.state,
      '</item>');
  }
  lines.push('</channel>', '</rss>', '');
  return lines.join('\n');
}

const topicItem = t => ({
  title: t.count ? `(${t.count}) - ${t.title}` : t.title, link: t.link, guid: t.guid, firstSeen: t.firstSeen, description: t.entriesHtml,
  state: [
    ...(t.count ? [`<egr:count>${esc(t.count)}</egr:count>`] : []),
    `<egr:lastSeen>${new Date(t.lastSeen).toISOString()}</egr:lastSeen>`,
    ...(t.fetchedAt ? [`<egr:entriesFetched>${new Date(t.fetchedAt).toISOString()}</egr:entriesFetched>`] : []),
  ],
});

// Okuyucular öğeleri tarihe göre dizer: debe sırası korunsun diye her entry günün ilk çekilme anından sırası kadar saniye geridedir.
const debeItems = d => d.ids.flatMap((id, i) => {
  const e = d.entries.get(id);
  return e ? [{ title: `${i + 1}. ${e.topic}`, link: e.link, guid: `${SITE}/entry/${id}`, firstSeen: d.firstSeen - i * 1000, author: e.author,
    category: `debe ${trDate(d.day)}`, description: e.description, state: [`<egr:topic>${esc(e.topic)}</egr:topic>`] }] : [];
});
const debeState = d => `<egr:debe day="${d.day}" seen="${new Date(d.firstSeen).toISOString()}">${d.ids.join(' ')}</egr:debe>`;

const GUNDEM_CHANNEL = { title: 'ekşi sözlük gündem', link: `${SITE}/`, description: 'ekşi sözlük gündem başlıkları ve son 24 saatin en beğenilen entry\'leri', self: feedUrl };
const DEBE_CHANNEL = { title: 'ekşi sözlük debe', link: `${SITE}/debe`, description: 'dünün en beğenilen entry\'leri (debe); her entry ayrı öğe', self: debeFeedUrl };

const INDEX_HTML = `<!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ekşi sözlük RSS</title>
<link rel="alternate" type="application/rss+xml" title="ekşi sözlük gündem" href="feed.xml">
<link rel="alternate" type="application/rss+xml" title="ekşi sözlük debe" href="debe.xml">
<p>ekşi sözlük RSS beslemeleri:</p>
<ul>
<li><a href="feed.xml">gündem</a>: gündem başlıkları ve son 24 saatin en beğenilen entry'leri</li>
<li><a href="debe.xml">debe</a>: dünün en beğenilen entry'leri, her entry ayrı öğe</li>
</ul>
<p>Kaynak: <a href="${REPO}">${REPO.replace('https://', '')}</a></p>
`;

async function main() {
  const topics = parseTopics(await fetchList('/', 'ana sayfa').catch(error => { throw new Error(`${error.message}; yayın yapılmadı.`); }));
  const previous = await loadPrevious();
  const now = Date.now();
  const prevById = new Map(previous.topics.map(item => [item.id, item]));

  // İlk görülme tarihi korunur; aynı anda görülenler gündem sırası bozulmasın diye saniyeyle kaydırılır.
  const current = topics.map((topic, rank) => {
    const prev = prevById.get(topic.id);
    return { ...topic, count: topic.count || prev?.count || '', entriesHtml: prev?.entriesHtml ?? '', fetchedAt: prev?.fetchedAt ?? null,
      firstSeen: prev?.firstSeen ?? now - rank * 1000, lastSeen: now };
  });
  const fresh = current.filter(item => !prevById.has(item.id)).length;
  console.log(`Gündem: ${topics.length} başlık (yeni ${fresh}, süren ${topics.length - fresh}); önceki beslemelerde ${previous.topics.length} gündem öğesi, ${previous.debes.length} debe günü.`);

  // Bütçede öncelik debede; kalan gündem sayfalarına gider.
  const debe = await updateDebe(previous.debes, now, budget);
  let left = debe.stop ? 0 : budget - debe.used;

  // Gündemde öncelik hiç çekilmemiş başlıklarda (gündem sırasıyla); sonra 6 saati geçmiş olanlar (en eskisi önce).
  // Her sayfa bütçeden bir düşer; ikinci sayfa, sırada bekleyen hiç çekilmemiş başlıkların ilk sayfalarına bütçe kalıyorsa istenir.
  const never = current.filter(item => !item.fetchedAt);
  const stale = current.filter(item => item.fetchedAt && now - item.fetchedAt >= REFRESH_MS).sort((a, b) => a.fetchedAt - b.fetchedAt);
  const queue = [...never, ...stale];
  console.log(`Gündem entry'leri: hiç çekilmemiş ${never.length}, yenilenecek ${stale.length}; kalan bütçe ${left}/${budget} sayfa.`);

  let ok = 0, failed = 0, waitingNever = never.length, stop = false;
  for (const [i, item] of queue.entries()) {
    if (stop || left <= 0) break;
    if (!item.fetchedAt) waitingNever--;
    left--;
    const tag = `  [${i + 1}/${queue.length}] ${item.title}`, path = new URL(item.link).pathname;
    try {
      const first = await fetchDetail(path + TODAY);
      let { page: { entries } } = first, { ms, remaining } = first, pages = 1, note = '';
      if (first.page.pages > 1 && entries.length < ENTRIES_PER_TOPIC && left > waitingNever) {
        left--;
        try {
          const second = await fetchDetail(`${path}${TODAY}&p=2`), seen = new Set(entries.map(e => e.id));
          entries = [...entries, ...second.page.entries.filter(e => !seen.has(e.id))];
          ms += second.ms; remaining = second.remaining; pages = 2;
        } catch (error) {
          note = `; 2. sayfa alınamadı (${error.message})`;
          stop = !!error.stop;
        }
      }
      if (first.page.id && first.page.id !== item.id) console.log(`${tag}: sayfa başka başlığa (${first.page.id}) yönlendi.`);
      if (first.page.title) item.title = first.page.title;
      // Yalnız son 24 saatte yazılmış entry'ler: tarihi okunamayan entry atılmaz (sayfa yapısı değişirse içerik boşalmasın).
      const all = entries.length;
      entries = entries.filter(e => (entryTime(e.date) ?? now) > now - DAY);
      if (entries.length < all) note += `; 24 saatten eski ${all - entries.length} entry atıldı`;
      entries = entries.slice(0, ENTRIES_PER_TOPIC);
      item.entriesHtml = entries.map(renderEntry).join('\n');
      item.fetchedAt = Date.now();
      ok++;
      console.log(`${tag}: ${entries.length} entry, ${pages} sayfa (HTTP 200, ${seconds(ms)} sn, kalan istek hakkı ${remaining})${note}`);
    } catch (error) {
      failed++;
      // 24 saatten önce çekilmiş entry'ler gösterilmez; başlık yeniden çekilene dek yalnız sayıyla yayımlanır.
      if (now - item.fetchedAt >= DAY) item.entriesHtml = '';
      console.log(`${tag}: atlandı, sonraki çalışmaya kaldı (${error.message})`);
      stop = !!error.stop;
    }
  }

  const currentIds = new Set(current.map(item => item.id));
  const dropped = previous.topics.filter(item => !currentIds.has(item.id) && now - item.lastSeen <= KEEP_MS).sort((a, b) => b.lastSeen - a.lastSeen);
  const kept = [...current, ...dropped].slice(0, MAX_ITEMS);
  const topicItems = kept.map(topicItem).sort((a, b) => b.firstSeen - a.firstSeen);
  const days = debe.debes.sort((a, b) => b.day.localeCompare(a.day));
  const debeEntries = days.flatMap(debeItems).sort((a, b) => b.firstSeen - a.firstSeen);
  const waiting = current.filter(item => !item.fetchedAt).length;
  console.log(`Sonuç: ${ok} başlığın entry'leri çekildi, ${failed} düştü; entry'si henüz olmayan ${waiting} başlık sonraki çalışmalara kaldı.`);
  console.log(`Gündem beslemesi: ${topicItems.length} öğe (gündemde ${current.length}, gündemden düşüp tutulan ${kept.length - current.length}).`);
  console.log(`Debe beslemesi: ${days.length} gün, ${debeEntries.length} entry.`);
  if (jina.keyed) console.log(`Jina anahtarı: ${jina.requests} istek, ${jina.tokens.toLocaleString('tr-TR')} token.`);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'feed.xml'), render(GUNDEM_CHANNEL, topicItems, now));
  await writeFile(join(outDir, 'debe.xml'), render({ ...DEBE_CHANNEL, state: days.map(debeState) }, debeEntries, now));
  await writeFile(join(outDir, 'index.html'), INDEX_HTML);
  console.log(`Yazıldı: ${join(outDir, 'feed.xml')}, ${join(outDir, 'debe.xml')}`);
}

main().catch(error => { console.error(`HATA: ${error.message}`); process.exit(1); });
