#!/usr/bin/env node
// Ekşi Sözlük gündemini ve günlük debeyi RSS 2.0 beslemesine çevirir. Bağımlılık yok (Node 18+).
// Ekşi'ye doğrudan istek atılmaz: Cloudflare düz isteği challenge'a düşürdüğü için sayfalar Jina Reader (r.jina.ai) üzerinden okunur.
//
// Ortam:  FEED_URL  yayımlanmış beslemenin adresi; ilk görülme tarihleri ve çekilmiş entry'ler buradan taşınır.
//         OUT_DIR   çıktı klasörü (varsayılan: public).
// Yerel deneme:  node gundem.mjs [--prev eski-feed.xml] [--out klasor] [--budget 3]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const SITE = 'https://eksisozluk.com';
const JINA = 'https://r.jina.ai/';
const REPO = 'https://github.com/hilmigundogdu/eksi-gundem-rss';
const USER_AGENT = `eksi-gundem-rss/1.0 (+${REPO})`;
const TIMEOUT_MS = 45_000;
const GAP_MS = 3_500;                       // Jina istekleri arasındaki en kısa ara (anahtarsız sınır dakikada 20 istek)
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ENTRIES_PER_TOPIC = 10;
const REFRESH_MS = 6 * HOUR;                // gündemde kalan başlığın entry'leri en çok bu sıklıkla yenilenir
const KEEP_MS = 3 * DAY;                    // gündemden düşen başlık son görülmesinden sonra bu kadar süre beslemede kalır
const MAX_ITEMS = 150;                      // gündem öğesi sınırı (debe öğeleri ayrı)
const DEBE_KEEP_MS = 7 * DAY;               // debe öğesi ilk çekilmesinden sonra bu kadar süre beslemede kalır
const DEBE_RETRY_MS = DAY;                  // debede düşen entry bu süre boyunca yeniden denenir; silinmiş entry sonsuza dek istek yemez

const { values: args } = parseArgs({ options: { prev: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' } } });
const feedUrl = process.env.FEED_URL || '';
const outDir = args.out || process.env.OUT_DIR || 'public';
// Bir çalışmada çekilecek en çok ayrıntı sayfası (debe entry'leri + gündem başlıkları); ana sayfa ve debe listesi buna girmez.
const budget = Math.max(0, Number(args.budget ?? 30) || 0);

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

// Jina istekleri sırayla gider; bir istek bittikten sonra bir sonraki en az GAP_MS bekler.
let lastDone = 0;
async function viaJina(path) {
  const wait = lastDone + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const started = Date.now();
  try {
    const res = await fetch(JINA + SITE + path, {
      // X-No-Cache: Jina'nın önbelleği sayfayı yarım saatten eski gösterebiliyor.
      headers: { 'X-Return-Format': 'html', 'X-No-Cache': 'true', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    return { status: res.status, body, ms: Date.now() - started, challenge: isChallenge(res, body), remaining: res.headers.get('x-ratelimit-remaining') ?? '-' };
  } finally {
    lastDone = Date.now();
  }
}

async function fetchList(path, label) {
  const r = await viaJina(path);
  console.log(`Jina ${label}: HTTP ${r.status}, ${Buffer.byteLength(r.body)} bayt, ${seconds(r.ms)} sn, kalan istek hakkı ${r.remaining}`);
  if (r.status !== 200) throw new Error(`Jina ${label} için HTTP ${r.status} döndü (${text(r.body).slice(0, 200)})`);
  if (r.challenge) throw new Error(`Jina üzerinden ${label} için Cloudflare challenge sayfası geldi`);
  return r.body;
}

// Başlık ya da entry sayfası; 429'da çağıran o çalışmadaki öteki ayrıntı sayfalarını bırakır.
async function fetchDetail(path) {
  const r = await viaJina(path);
  if (r.status === 429) throw Object.assign(new Error('HTTP 429, Jina sınırı doldu'), { stop: true });
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
    topics.push({ id: m[2], title, count, guid: `${SITE}/${m[1]}--${m[2]}`, link: `${SITE}/${m[1]}--${m[2]}?a=nice` });
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

// Başlık sayfası da tek entry sayfası da aynı yapıda: h1#title ve entry'ler (li[data-id][data-author]).
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
    if (entries.length === ENTRIES_PER_TOPIC) break;
  }
  if (!entries.length) throw new Error('entry bulunamadı');
  return { id, slug, title: title.trim(), entries };
}

const renderEntry = e =>
  `<blockquote><p>${e.html}</p></blockquote>\n<p>— ${esc(e.author)} · ${e.favorites} beğeni · <a href="${esc(e.url)}">${esc(e.date || 'entry')}</a></p>`;

// Debe entry'si: önce başlık (başlığa bağlantılı), sonra gündemdeki gibi metin ve alt satır. Sıra numarası yazarken eklenir.
function renderDebeEntry(page, entry, caption) {
  const title = page.title || caption || 'entry';
  const topicUrl = page.slug && page.id ? `${SITE}/${page.slug}--${page.id}` : `${SITE}/?q=${encodeURIComponent(title)}`;
  return `<p><a href="${esc(topicUrl)}"><strong>${esc(title)}</strong></a></p>\n${renderEntry(entry)}`;
}

const DEBE_SEPARATOR = '\n<hr>\n';
const debeHtml = debe => debe.ids.map((id, i) => debe.chunks.get(id)?.replace(/^<p>/, `<p>${i + 1}. `)).filter(Boolean).join(DEBE_SEPARATOR);

// Önceki beslemeyi biz ürettiğimiz için düzenli ifadeyle okumak yeterli.
function parseFeedXml(body) {
  if (!/<rss\b/.test(body)) throw new Error('Önceki besleme RSS değil; tarihler kaybolmasın diye yayın yapılmadı.');
  const raw = (item, tag) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? '';
  const field = (item, tag) => decode(raw(item, tag)).trim();
  const topics = [], debes = [];
  for (const [, item] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const guid = field(item, 'guid'), firstSeen = Date.parse(field(item, 'pubDate'));
    if (!Number.isFinite(firstSeen)) continue;
    const descRaw = raw(item, 'description');
    const desc = (descRaw.includes('<![CDATA[') ? descRaw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : decode(descRaw)).trim();

    const debeDay = /\/debe#(\d{4}-\d{2}-\d{2})$/.exec(guid)?.[1];
    if (debeDay) {
      const chunks = new Map();
      for (const chunk of desc ? desc.split(DEBE_SEPARATOR) : []) {
        const id = [...chunk.matchAll(/\/entry\/(\d+)">/g)].at(-1)?.[1];   // son bağlantı alt satırdaki kalıcı bağlantıdır
        if (id) chunks.set(id, chunk.replace(/^<p>\d+\. /, '<p>'));
      }
      debes.push({ day: debeDay, guid, ids: field(item, 'egr:debeIds').split(/\s+/).filter(Boolean), chunks, firstSeen });
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

async function loadPrevious() {
  if (args.prev) return parseFeedXml(await readFile(args.prev, 'utf8'));
  if (!feedUrl) { console.log('FEED_URL yok; önceki besleme okunmadı, sıfırdan başlanıyor.'); return { topics: [], debes: [] }; }
  const res = await fetch(`${feedUrl}?t=${Date.now()}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) { console.log('Önceki besleme yok (404); sıfırdan başlanıyor.'); return { topics: [], debes: [] }; }
  if (!res.ok) throw new Error(`Önceki besleme okunamadı (HTTP ${res.status}); tarihler kaybolmasın diye yayın yapılmadı.`);
  return parseFeedXml(await res.text());
}

// Debe: her gün bir önceki günün debesi tek öğe. Liste yalnız dünün (İstanbul) debesi elde yokken çekilir; böylece
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
        work = { ids: list.ids, captions: list.captions, chunks: new Map(), firstSeen: now };
        fresh = true;
      }
    } catch (error) {
      console.log(`Debe listesi alınamadı (${error.message}); debe bu çalışmada atlandı.`);
      return { debes, used: 0, stop: false };
    }
  }

  const missing = work.ids.filter(id => !work.chunks.has(id));
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
      work.chunks.set(id, renderDebeEntry(page, entry, work.captions?.get(id)));
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
      console.log('Yeni debenin günü belirlenemedi (entry çekilemedi); öğe açılmadı.');
    } else {
      if (day !== yesterday) console.log(`Not: debe entry'lerinin tarihi ${trDate(day)}, İstanbul saatiyle dün ${trDate(yesterday)}; entry tarihi esas alındı.`);
      const existing = debes.find(debe => debe.day === day);
      if (existing) {
        console.log(`Debe ${trDate(day)} zaten vardı; liste güncellendi, çekilmiş entry'ler korundu.`);
        existing.ids = work.ids;
        for (const [id, chunk] of work.chunks) existing.chunks.set(id, chunk);
        work = existing;
      } else {
        Object.assign(work, { day, guid: `${SITE}/debe#${day}` });
        debes.push(work);
      }
    }
  }
  if (work.day) console.log(`Debe ${trDate(work.day)}: ${work.ids.filter(id => work.chunks.has(id)).length}/${work.ids.length} entry hazır.`);
  return { debes, used, stop };
}

function render(items, now) {
  const date = ms => new Date(ms).toUTCString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:egr="${REPO}">`,
    '<channel>',
    '<title>ekşi sözlük gündem</title>',
    `<link>${SITE}/</link>`,
    '<description>ekşi sözlük gündem başlıkları, en beğenilen entry\'leri ve günlük debe</description>',
    '<language>tr</language>',
    `<lastBuildDate>${date(now)}</lastBuildDate>`,
    '<ttl>30</ttl>',
    `<generator>${REPO}</generator>`,
    ...(feedUrl ? [`<atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>`] : []),
  ];
  for (const item of items) {
    lines.push('<item>',
      `<title>${esc(item.title)}</title>`,
      `<link>${esc(item.link)}</link>`,
      `<guid isPermaLink="false">${esc(item.guid)}</guid>`,
      `<pubDate>${date(item.firstSeen)}</pubDate>`,
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

const debeItem = d => ({
  title: `debe - ${trDate(d.day)}`, link: `${SITE}/debe`, guid: d.guid, firstSeen: d.firstSeen, description: debeHtml(d),
  state: [`<egr:debeIds>${d.ids.join(' ')}</egr:debeIds>`],
});

const INDEX_HTML = `<!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ekşi sözlük gündem RSS</title>
<link rel="alternate" type="application/rss+xml" title="ekşi sözlük gündem" href="feed.xml">
<p>ekşi sözlük gündemi ve günlük debenin RSS beslemesi: <a href="feed.xml">feed.xml</a></p>
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
  console.log(`Gündem: ${topics.length} başlık (yeni ${fresh}, süren ${topics.length - fresh}); önceki beslemede ${previous.topics.length} gündem, ${previous.debes.length} debe öğesi.`);

  // Bütçede öncelik debede; kalan gündem başlıklarına gider.
  const debe = await updateDebe(previous.debes, now, budget);
  const left = debe.stop ? 0 : budget - debe.used;

  // Gündemde öncelik hiç çekilmemiş başlıklarda (gündem sırasıyla); sonra 6 saati geçmiş olanlar (en eskisi önce).
  const never = current.filter(item => !item.fetchedAt);
  const stale = current.filter(item => item.fetchedAt && now - item.fetchedAt >= REFRESH_MS).sort((a, b) => a.fetchedAt - b.fetchedAt);
  const queue = [...never, ...stale].slice(0, left);
  console.log(`Gündem entry'leri: hiç çekilmemiş ${never.length}, yenilenecek ${stale.length}; bu çalışmada ${queue.length} başlık (kalan bütçe ${left}/${budget}).`);

  let ok = 0, failed = 0;
  for (const [i, item] of queue.entries()) {
    const tag = `  [${i + 1}/${queue.length}] ${item.title}`;
    try {
      const { page, ms, remaining } = await fetchDetail(new URL(item.link).pathname + '?a=nice');
      if (page.id && page.id !== item.id) console.log(`${tag}: sayfa başka başlığa (${page.id}) yönlendi.`);
      if (page.title) item.title = page.title;
      item.entriesHtml = page.entries.map(renderEntry).join('\n');
      item.fetchedAt = Date.now();
      ok++;
      console.log(`${tag}: ${page.entries.length} entry (HTTP 200, ${seconds(ms)} sn, kalan istek hakkı ${remaining})`);
    } catch (error) {
      failed++;
      console.log(`${tag}: atlandı, sonraki çalışmaya kaldı (${error.message})`);
      if (error.stop) break;
    }
  }

  const currentIds = new Set(current.map(item => item.id));
  const dropped = previous.topics.filter(item => !currentIds.has(item.id) && now - item.lastSeen <= KEEP_MS).sort((a, b) => b.lastSeen - a.lastSeen);
  const kept = [...current, ...dropped].slice(0, MAX_ITEMS);
  const items = [...kept.map(topicItem), ...debe.debes.map(debeItem)].sort((a, b) => b.firstSeen - a.firstSeen);
  const waiting = current.filter(item => !item.fetchedAt).length;
  console.log(`Sonuç: ${ok} başlığın entry'leri çekildi, ${failed} düştü; entry'si henüz olmayan ${waiting} başlık sonraki çalışmalara kaldı.`);
  console.log(`Besleme: ${items.length} öğe (gündemde ${current.length}, gündemden düşüp tutulan ${kept.length - current.length}, debe ${debe.debes.length}).`);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'feed.xml'), render(items, now));
  await writeFile(join(outDir, 'index.html'), INDEX_HTML);
  console.log(`Yazıldı: ${join(outDir, 'feed.xml')}`);
}

main().catch(error => { console.error(`HATA: ${error.message}`); process.exit(1); });
