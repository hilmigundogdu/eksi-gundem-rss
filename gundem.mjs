#!/usr/bin/env node
// Ekşi Sözlük gündemini RSS 2.0 beslemesine çevirir; her başlığa en beğenilen 10 entry eklenir. Bağımlılık yok (Node 18+).
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
const ENTRIES_PER_TOPIC = 10;
const REFRESH_MS = 6 * 60 * 60 * 1000;      // gündemde kalan başlığın entry'leri en çok bu sıklıkla yenilenir
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;    // gündemden düşen başlık son görülmesinden sonra bu kadar süre beslemede kalır
const MAX_ITEMS = 150;

const { values: args } = parseArgs({ options: { prev: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' } } });
const feedUrl = process.env.FEED_URL || '';
const outDir = args.out || process.env.OUT_DIR || 'public';
const budget = Math.max(0, Number(args.budget ?? 15) || 0);   // bir çalışmada çekilecek en çok başlık sayfası

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
      // X-No-Cache: Jina'nın önbelleği gündemi yarım saatten eski gösterebiliyor.
      headers: { 'X-Return-Format': 'html', 'X-No-Cache': 'true', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    return { status: res.status, body, ms: Date.now() - started, challenge: isChallenge(res, body), remaining: res.headers.get('x-ratelimit-remaining') ?? '-' };
  } finally {
    lastDone = Date.now();
  }
}

async function fetchHome() {
  const r = await viaJina('/');
  console.log(`Jina ana sayfa: HTTP ${r.status}, ${Buffer.byteLength(r.body)} bayt, ${seconds(r.ms)} sn, kalan istek hakkı ${r.remaining}`);
  if (r.status !== 200) throw new Error(`Jina ana sayfada HTTP ${r.status} döndü (${text(r.body).slice(0, 200)}); yayın yapılmadı.`);
  if (r.challenge) throw new Error('Jina üzerinden Cloudflare challenge sayfası geldi; yayın yapılmadı.');
  return r.body;
}

function parseTopics(html) {
  const list = /<ul\b[^>]*\bclass\s*=\s*["'][^"']*\btopic-list\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i.exec(html);
  if (!list) throw new Error('topic-list bulunamadı; sayfa yapısı değişmiş olabilir. Yayın yapılmadı.');
  const topics = [], seen = new Set();
  for (const [, attrs, content] of list[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(attrsOf(attrs).href ?? '');
    const m = url && new URL(url).hostname === 'eksisozluk.com' && /^\/([^/]+)--(\d+)$/.exec(new URL(url).pathname);
    if (!m || seen.has(m[2])) continue;
    const title = text(content.replace(/<small\b[^>]*>[\s\S]*?<\/small>/gi, ''));
    if (!title) continue;
    seen.add(m[2]);
    const count = text(/<small\b[^>]*>([\s\S]*?)<\/small>/i.exec(content)?.[1] ?? '');
    topics.push({ id: m[2], title, count, guid: `${SITE}/${m[1]}--${m[2]}`, link: `${SITE}/${m[1]}--${m[2]}?a=nice` });
  }
  if (!topics.length) throw new Error('topic-list içinde başlık bulunamadı; yayın yapılmadı.');
  return topics;
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

function parseTopicPage(html) {
  const h1 = /<h1\b[^>]*\bid\s*=\s*["']title["'][^>]*>/i.exec(html);
  if (!h1) throw new Error('h1#title yok');
  const { 'data-title': title = '', 'data-id': id = '' } = attrsOf(h1[0]);
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
      author: a['data-author'] || '?',
      favorites: Number(a['data-favorite-count']) || 0,
      html: cleanContent(content),
      date: permalink ? text(permalink[2]) : '',
      url: absUrl(permalink ? attrsOf(permalink[1]).href ?? '' : '') ?? `${SITE}/entry/${a['data-id']}`,
    });
    if (entries.length === ENTRIES_PER_TOPIC) break;
  }
  if (!entries.length) throw new Error('entry bulunamadı');
  return { id, title: title.trim(), entries };
}

const renderEntries = entries => entries.map(e =>
  `<blockquote><p>${e.html}</p></blockquote>\n<p>— ${esc(e.author)} · ${e.favorites} beğeni · <a href="${esc(e.url)}">${esc(e.date || 'entry')}</a></p>`).join('\n');

// Önceki beslemeyi biz ürettiğimiz için düzenli ifadeyle okumak yeterli.
function parseFeedXml(body) {
  if (!/<rss\b/.test(body)) throw new Error('Önceki besleme RSS değil; tarihler kaybolmasın diye yayın yapılmadı.');
  const raw = (item, tag) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? '';
  const field = (item, tag) => decode(raw(item, tag)).trim();
  const items = [];
  for (const [, item] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const guid = field(item, 'guid'), id = /--(\d+)$/.exec(guid)?.[1], firstSeen = Date.parse(field(item, 'pubDate'));
    if (!id || !Number.isFinite(firstSeen)) continue;
    const descRaw = raw(item, 'description');
    const desc = (descRaw.includes('<![CDATA[') ? descRaw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : decode(descRaw)).trim();
    const countLine = /^<p>([^<]*) entry<\/p>\s*/.exec(desc);
    const fetchedAt = Date.parse(field(item, 'egr:entriesFetched'));
    const lastSeen = Date.parse(field(item, 'egr:lastSeen'));
    items.push({
      id, guid, title: field(item, 'title'), link: field(item, 'link'), count: countLine?.[1] ?? '',
      entriesHtml: Number.isFinite(fetchedAt) ? desc.slice(countLine?.[0].length ?? 0) : '',
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
      firstSeen, lastSeen: Number.isFinite(lastSeen) ? lastSeen : firstSeen,
    });
  }
  return items;
}

async function loadPrevious() {
  if (args.prev) return parseFeedXml(await readFile(args.prev, 'utf8'));
  if (!feedUrl) { console.log('FEED_URL yok; önceki besleme okunmadı, sıfırdan başlanıyor.'); return []; }
  const res = await fetch(`${feedUrl}?t=${Date.now()}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) { console.log('Önceki besleme yok (404); sıfırdan başlanıyor.'); return []; }
  if (!res.ok) throw new Error(`Önceki besleme okunamadı (HTTP ${res.status}); tarihler kaybolmasın diye yayın yapılmadı.`);
  return parseFeedXml(await res.text());
}

function render(items, now) {
  const date = ms => new Date(ms).toUTCString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:egr="${REPO}">`,
    '<channel>',
    '<title>ekşi sözlük gündem</title>',
    `<link>${SITE}/</link>`,
    '<description>ekşi sözlük gündem başlıkları ve en beğenilen entry\'leri</description>',
    '<language>tr</language>',
    `<lastBuildDate>${date(now)}</lastBuildDate>`,
    '<ttl>30</ttl>',
    `<generator>${REPO}</generator>`,
    ...(feedUrl ? [`<atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>`] : []),
  ];
  for (const item of items) {
    const description = [item.count ? `<p>${esc(item.count)} entry</p>` : '', item.entriesHtml].filter(Boolean).join('\n');
    lines.push('<item>',
      `<title>${esc(item.title)}</title>`,
      `<link>${esc(item.link)}</link>`,
      `<guid isPermaLink="false">${esc(item.guid)}</guid>`,
      `<pubDate>${date(item.firstSeen)}</pubDate>`,
      ...(description ? [`<description>${cdata(description)}</description>`] : []),
      `<egr:lastSeen>${new Date(item.lastSeen).toISOString()}</egr:lastSeen>`,
      ...(item.fetchedAt ? [`<egr:entriesFetched>${new Date(item.fetchedAt).toISOString()}</egr:entriesFetched>`] : []),
      '</item>');
  }
  lines.push('</channel>', '</rss>', '');
  return lines.join('\n');
}

const INDEX_HTML = `<!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ekşi sözlük gündem RSS</title>
<link rel="alternate" type="application/rss+xml" title="ekşi sözlük gündem" href="feed.xml">
<p>ekşi sözlük gündeminin RSS beslemesi: <a href="feed.xml">feed.xml</a></p>
<p>Kaynak: <a href="${REPO}">${REPO.replace('https://', '')}</a></p>
`;

async function main() {
  const topics = parseTopics(await fetchHome());
  const previous = await loadPrevious();
  const now = Date.now();
  const prevById = new Map(previous.map(item => [item.id, item]));

  // İlk görülme tarihi korunur; aynı anda görülenler gündem sırası bozulmasın diye saniyeyle kaydırılır.
  const current = topics.map((topic, rank) => {
    const prev = prevById.get(topic.id);
    return { ...topic, count: topic.count || prev?.count || '', entriesHtml: prev?.entriesHtml ?? '', fetchedAt: prev?.fetchedAt ?? null,
      firstSeen: prev?.firstSeen ?? now - rank * 1000, lastSeen: now };
  });
  const fresh = current.filter(item => !prevById.has(item.id)).length;
  console.log(`Gündem: ${topics.length} başlık (yeni ${fresh}, süren ${topics.length - fresh}); önceki beslemede ${previous.length} öğe.`);

  // Öncelik hiç çekilmemiş başlıklarda (gündem sırasıyla); sonra 6 saati geçmiş olanlar (en eskisi önce).
  const never = current.filter(item => !item.fetchedAt);
  const stale = current.filter(item => item.fetchedAt && now - item.fetchedAt >= REFRESH_MS).sort((a, b) => a.fetchedAt - b.fetchedAt);
  const queue = [...never, ...stale].slice(0, budget);
  console.log(`Entry çekme: hiç çekilmemiş ${never.length}, yenilenecek ${stale.length}; bu çalışmada ${queue.length} başlık (bütçe ${budget}).`);

  let ok = 0, failed = 0;
  for (const [i, item] of queue.entries()) {
    const tag = `  [${i + 1}/${queue.length}] ${item.title}`;
    try {
      const r = await viaJina(new URL(item.link).pathname + '?a=nice');
      if (r.status === 429) { failed++; console.log(`${tag}: HTTP 429, Jina sınırı doldu; kalan başlıklar sonraki çalışmaya kaldı.`); break; }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      if (r.challenge) throw new Error('Cloudflare challenge sayfası');
      const page = parseTopicPage(r.body);
      if (page.id && page.id !== item.id) console.log(`${tag}: sayfa başka başlığa (${page.id}) yönlendi.`);
      if (page.title) item.title = page.title;
      item.entriesHtml = renderEntries(page.entries);
      item.fetchedAt = Date.now();
      ok++;
      console.log(`${tag}: ${page.entries.length} entry (HTTP 200, ${seconds(r.ms)} sn, kalan istek hakkı ${r.remaining})`);
    } catch (error) {
      failed++;
      console.log(`${tag}: atlandı, sonraki çalışmaya kaldı (${error.message})`);
    }
  }

  const currentIds = new Set(current.map(item => item.id));
  const dropped = previous.filter(item => !currentIds.has(item.id) && now - item.lastSeen <= KEEP_MS).sort((a, b) => b.lastSeen - a.lastSeen);
  const items = [...current, ...dropped].slice(0, MAX_ITEMS).sort((a, b) => b.firstSeen - a.firstSeen);
  const waiting = current.filter(item => !item.fetchedAt).length;
  console.log(`Sonuç: ${ok} başlığın entry'leri çekildi, ${failed} düştü; entry'si henüz olmayan ${waiting} başlık sonraki çalışmalara kaldı.`);
  console.log(`Besleme: ${items.length} öğe (gündemde ${current.length}, gündemden düşüp tutulan ${items.length - current.length}).`);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'feed.xml'), render(items, now));
  await writeFile(join(outDir, 'index.html'), INDEX_HTML);
  console.log(`Yazıldı: ${join(outDir, 'feed.xml')}`);
}

main().catch(error => { console.error(`HATA: ${error.message}`); process.exit(1); });
