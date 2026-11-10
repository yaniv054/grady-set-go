// Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady.
//
// Credits lookup for songs found inside clips: MusicBrainz first, Wikidata when MusicBrainz
// has nothing. Module (used by the panel and the overnight run) and CLI.
//
//   node lookup-credits.js [--clip <clip id>] [--all] [--force] [--max 200] [--until 07:00]
//                          [--data <data folder>] [--library <library.csv>]
//                          [--meta <clip-metadata.json>] [--no-wikidata]
//
// Exit codes: 0 done, 3 "format changed" (the tool needs an update), 4 provider temporarily
// unavailable (HTTP 429/503 or a redirect: try again later), 1 other failure.
//
// Without --clip it looks up every song that has no confirmed credits yet and was not
// looked up before (--force: again, e.g. after aliases were added). It never sets a song
// to "confirmed" and never changes confirmed credits; it fills `candidates` (top 5) and,
// when one work is clearly ahead, `credits` as a suggestion.
//
// MusicBrainz (https://musicbrainz.org/ws/2/): work search (`/work?query=...&fmt=json`), then
// one lookup per top work with `inc=artist-rels` for its composers and lyricists. The
// MusicBrainz rules are followed: at most one request per second across all processes on
// this PC (panel + overnight run + CLI) and a descriptive User-Agent. Every answer is checked
// for the expected shape and the run stops with "format changed" when it is not (no
// guessing). Answers are cached in <data>/credits/musicbrainz-cache.json for 30 days.
// Wikidata (https://www.wikidata.org/w/api.php): wbsearchentities, then the composer (P86),
// lyricist (P676) and performer (P175) claims; same limit, cached too. Labels use the
// language in config.json "credits_language" (default "en").
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const store = require('../songs/song-store');
const { normHe, normTitle, tokens } = require('../songs/detect-songs');

const cfg = require('../../panel/config');
const UA = `GradySetGo-Playout/1.0 (credits lookup${cfg.creditsContact ? '; ' + cfg.creditsContact : ''})`;
const MB_BASE = process.env.MUSICBRAINZ_BASE || 'https://musicbrainz.org/ws/2/';
const WIKIDATA_API = process.env.WIKIDATA_API || 'https://www.wikidata.org/w/api.php';
const CACHE_DAYS = 30;
const MIN_INTERVAL_MS = 1050;   // 1 request per second, with a margin for timer jitter
const SUGGEST_MIN = 0.62;     // best score needed for a suggestion
const SUGGEST_LEAD = 0.1;     // ...and its lead over the next different work

class FormatChanged extends Error { constructor(detail) { super(`Credits provider format changed: ${detail}`); this.code = 'CREDITS_FORMAT'; this.status = 502; } }
// HTTP 429 / 503 / a redirect: the site is busy or in maintenance. The run stops quietly and
// tries again next time (not a format change).
class Unavailable extends Error { constructor(detail) { super(`The credits provider is temporarily unavailable (${detail}). Try again later.`); this.code = 'CREDITS_UNAVAILABLE'; this.status = 503; } }
const stripBom = (t) => String(t || '').replace(/^\uFEFF/, '');

// ---- names and titles ------------------------------------------------------------------
// Rough Hebrew sound key: ע=א, ק=כ, ט=ת, ח=כ, ס=ש, final letters, no inner ו/י, no final ה/א.
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
function phonWord(w) {
    let x = w.replace(/[ךםןףץ]/g, (c) => FINALS[c]).replace(/ע/g, 'א').replace(/ק/g, 'כ').replace(/ט/g, 'ת').replace(/ח/g, 'כ').replace(/ס/g, 'ש');
    if (/^[\u05d0-\u05ea]+$/.test(x)) {
        x = x[0] + x.slice(1).replace(/[וי]/g, '');
        if (x.length > 2) x = x.replace(/[הא]$/, '');
    }
    return x;
}
const phon = (t) => normHe(t).split(' ').filter(Boolean).map(phonWord);
function dice(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const g = (s) => { const m = new Map(); for (let i = 0; i + 1 < s.length; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
    const A = g(a), B = g(b);
    let hit = 0;
    for (const [k, n] of A) hit += Math.min(n, B.get(k) || 0);
    return (2 * hit) / (a.length - 1 + b.length - 1);
}
// 0..1: how likely two spellings name the same person.
function nameSim(a, b) {
    const A = phon(a), B = phon(b);
    if (!A.length || !B.length) return 0;
    if (A.join(' ') === B.join(' ')) return 1;
    if (A.length >= 2 && B.length >= 2) {
        const sameLast = A.at(-1) === B.at(-1);
        const f1 = A[0], f2 = B[0];
        if (sameLast && (f1 === f2 || f1.startsWith(f2) || f2.startsWith(f1))) return 0.95;
        if (sameLast) return 0.55;
    }
    return Math.min(0.9, dice(A.join(''), B.join('')));
}
// Best match of a name anywhere in a text (windows of the name's word count).
function nameInText(name, textTokens) {
    const n = Math.max(1, tokens(name).length);
    let best = 0;
    for (let i = 0; i + n <= textTokens.length; i++) {
        const s = nameSim(name, textTokens.slice(i, i + n).join(' '));
        if (s > best) best = s;
        if (best >= 1) break;
    }
    return best;
}
function titleSim(q, t) {
    const a = normTitle(q), b = normTitle(t);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (phon(a).join(' ') === phon(b).join(' ')) return 0.95;
    // Registered titles are often the heard one plus a word or two (heard "A B", registered "A B C").
    if (b.startsWith(a + ' ') || a.startsWith(b + ' ')) return 0.75 + 0.2 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
    if (b.includes(a) || a.includes(b)) return 0.6 + 0.35 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
    return Math.min(0.85, dice(a.replace(/ /g, ''), b.replace(/ /g, '')));
}

// ---- MusicBrainz answers -> works --------------------------------------------------------
// Search answer: { count, works: [{ id, title, score, iswcs? }] }. Checks the shape; throws FormatChanged.
function parseMbSearch(j) {
    if (!j || typeof j !== 'object') throw new FormatChanged('the answer is not a JSON object');
    if (j.error) throw Object.assign(new Error(`MusicBrainz answered with an error: ${String(j.error).slice(0, 200)}`), { status: 502 });
    if (!Array.isArray(j.works)) throw new FormatChanged('works is missing');
    const works = j.works.map((w) => {
        if (!w || typeof w.id !== 'string' || typeof w.title !== 'string') throw new FormatChanged('a work has no id or title');
        return { id: w.id, title: w.title.trim(), score: Number(w.score) || 0, iswcs: Array.isArray(w.iswcs) ? w.iswcs.map(String) : [] };
    });
    return { works, count: Number(j.count) || works.length };
}
// Work lookup with inc=artist-rels: relations[{ type, artist: { id, name } }].
const MB_LYRICIST = new Set(['lyricist', 'librettist']);
const MB_COMPOSER = new Set(['composer', 'writer']);
function parseMbWork(j, hit) {
    if (!j || typeof j !== 'object' || typeof j.id !== 'string') throw new FormatChanged('the work answer has no id');
    if (j.relations != null && !Array.isArray(j.relations)) throw new FormatChanged('relations is not a list');
    const lyricists = [], composers = [], others = [];
    for (const r of j.relations || []) {
        if (!r || typeof r.type !== 'string' || !r.artist || typeof r.artist !== 'object') continue;   // other relation kinds
        const p = { name: String(r.artist.name || '').trim(), name_en: String(r.artist.name || '').trim(), ipi: '', musicbrainz: String(r.artist.id || '') };
        if (!p.name) continue;
        if (MB_LYRICIST.has(r.type)) lyricists.push(p); else if (MB_COMPOSER.has(r.type)) composers.push(p); else others.push({ ...p, role: r.type });
    }
    const iswcs = Array.isArray(j.iswcs) && j.iswcs.length ? j.iswcs.map(String) : (hit && hit.iswcs) || [];
    return { source: 'musicbrainz', full_work_id: j.id, work_no: iswcs[0] || '', title: String(j.title || (hit && hit.title) || '').trim(), title_en: '', lyricists, composers, others, versions: 0, albums: 0, musicbrainz: j.id };
}

// ---- HTTP ----------------------------------------------------------------------------------
// `timeout`: longest silence; `total`: the whole request (a slow trickle cannot hang a lookup).
function request(url, headers = {}, { timeout = 20000, total = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        let overall = null;
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(u, { method: 'GET', headers: { 'User-Agent': UA, ...headers } }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => { size += c.length; if (size < 8 * 1024 * 1024) chunks.push(c); });
            res.on('end', () => { clearTimeout(overall); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
            res.on('error', reject);
        });
        req.setTimeout(timeout, () => req.destroy(Object.assign(new Error(`no answer from ${u.host} within ${timeout / 1000} s`), { status: 504 })));
        overall = setTimeout(() => req.destroy(Object.assign(new Error(`${u.host} did not finish answering within ${total / 1000} s`), { status: 504 })), total);
        req.on('close', () => clearTimeout(overall));
        req.on('error', (e) => { clearTimeout(overall); reject(e.status ? e : Object.assign(new Error(`${u.host} is not reachable (${e.code || e.message})`), { status: 502 })); });
        req.end();
    });
}

// ---- rate limit across processes (data\credits\rate-<name>.json under a lock) --------------
async function takeSlot(dataDir, name) {
    const file = path.join(store.dirs(dataDir).credits, `rate-${name}.json`);
    const wait = await store.withLockAsync(file, () => {
        let next = 0;
        try { next = Number(JSON.parse(fs.readFileSync(file, 'utf8')).next_at) || 0; } catch { /* first use */ }
        const now = Date.now();
        // Queued requests stay at least 1 s apart, however many wait. Only a stored time
        // more than an hour ahead (the clock was put back) is ignored.
        const at = next > now + 3600e3 ? now : Math.max(now, next);
        fs.writeFileSync(file, JSON.stringify({ next_at: at + MIN_INTERVAL_MS }));
        return at - now;
    });
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ---- cache ---------------------------------------------------------------------------------
function cacheFile(dataDir, kind) { return path.join(store.dirs(dataDir).credits, `${kind}-cache.json`); }
function cacheGet(dataDir, kind, key) {
    const doc = store.readJson(cacheFile(dataDir, kind));
    const e = doc && doc.entries && doc.entries[key];
    if (!e || !e.at) return null;
    if (Date.now() - Date.parse(e.at) > CACHE_DAYS * 86400e3) return null;
    return e;
}
// Entries older than the reuse period are dropped on every write, so the file (read on
// every lookup) stays as large as 30 days of answers.
function cachePut(dataDir, kind, key, value) {
    return store.updateJsonAsync(cacheFile(dataDir, kind), (doc) => {
        const d = doc && typeof doc === 'object' && doc.entries ? doc : { version: 1, entries: {} };
        const old = Date.now() - CACHE_DAYS * 86400e3;
        for (const [k, v] of Object.entries(d.entries)) if (!(Date.parse(v && v.at) >= old)) delete d.entries[k];
        d.entries[key] = { at: new Date().toISOString(), ...value };
        return d;
    }, 0);
}

// ---- aliases ---------------------------------------------------------------------------------
function readAliases(dataDir) {
    let d = null;
    try { d = store.readJson(path.join(store.dirs(dataDir).credits, 'aliases.json')); } catch { d = null; }
    return { names: (d && d.names) || {}, titles: (d && d.titles) || {} };
}
const aliasKey = (t) => normHe(t);
// Records heard -> registered pairs (names and titles) that differ. Returns how many were added.
async function addAliases(dataDir, { names = [], titles = [] }, by = '') {
    const pairs = (list) => list.filter((p) => p && p.heard && p.registered && aliasKey(p.heard) !== aliasKey(p.registered));
    const n = pairs(names), t = pairs(titles);
    if (!n.length && !t.length) return 0;
    let added = 0;
    await store.updateJsonAsync(path.join(store.dirs(dataDir).credits, 'aliases.json'), (doc) => {
        const d = doc && typeof doc === 'object' ? doc : {};
        d.version = 1; d.names = d.names || {}; d.titles = d.titles || {};
        const at = new Date().toISOString();
        for (const p of n) { const k = aliasKey(p.heard); if (d.names[k]?.name !== p.registered) { d.names[k] = { name: p.registered, heard: p.heard, at, by }; added++; } }
        for (const p of t) { const k = aliasKey(p.heard); if (d.titles[k]?.title !== p.registered) { d.titles[k] = { title: p.registered, heard: p.heard, at, by }; added++; } }
        return d;
    });
    return added;
}
// Heard names (writers) paired with the confirmed creators they most likely meant.
function aliasPairs(song, credits) {
    const creators = [...(credits.lyricists || []), ...(credits.composers || []), ...(credits.others || [])].map((c) => c.name).filter(Boolean);
    const names = [];
    for (const h of song.writers_heard || []) {
        let best = null;
        for (const c of creators) { const s = nameSim(h, c); if (s >= 0.5 && (!best || s > best.s)) best = { s, c }; }
        // Same person, other spelling (one letter more or fewer in the registered name).
        if (best && aliasKey(h) !== aliasKey(best.c)) names.push({ heard: h, registered: best.c });
    }
    const titles = song.title_heard && credits.title && normTitle(song.title_heard) !== normTitle(credits.title) ? [{ heard: song.title_heard, registered: credits.title }] : [];
    return { names, titles };
}

// ---- client ---------------------------------------------------------------------------------
function createClient({ dataDir, mbBase = MB_BASE, wikidataApi = WIKIDATA_API, wikidata = true, language = cfg.creditsLanguage || 'en', log = () => {} } = {}) {
    async function mbGet(pathAndQuery, cacheKey) {
        const hit = cacheGet(dataDir, 'musicbrainz', cacheKey);
        if (hit) return { ...hit.value, cached: true };
        await takeSlot(dataDir, 'musicbrainz');
        const url = new URL(pathAndQuery, mbBase);
        url.searchParams.set('fmt', 'json');
        const r = await request(url.toString(), { Accept: 'application/json' });
        if (r.status === 429 || r.status === 503 || (r.status >= 300 && r.status < 400)) throw new Unavailable(`HTTP ${r.status}`);
        if (r.status >= 500) throw Object.assign(new Error(`MusicBrainz answered HTTP ${r.status}`), { status: 502 });
        if (r.status === 403 || r.status === 401) throw Object.assign(new Error(`MusicBrainz refused the request (HTTP ${r.status})`), { status: 502 });
        let j;
        try { j = JSON.parse(stripBom(r.body)); } catch { throw new FormatChanged(`HTTP ${r.status} with a non-JSON answer (${String(r.headers['content-type'] || '').slice(0, 60)})`); }
        if (r.status !== 200) throw new FormatChanged(`unexpected HTTP ${r.status}`);
        return { json: j };
    }
    // Searches works by title (Lucene phrase query on the work field); looks up the best few for their creators.
    async function search(term) {
        if (String(term || '').replace(/[^\p{L}\p{N}]/gu, '').length < 2) { log(`MusicBrainz "${term}": skipped, too short to search`); return { works: [], counts: {}, skipped: true }; }
        const key = 'term:' + normHe(term);
        const hit = cacheGet(dataDir, 'musicbrainz', key);
        if (hit) return { ...hit.value, cached: true };
        const q = `work:"${String(term).replace(/["\\]/g, ' ').trim()}"`;
        const found = parseMbSearch((await mbGet(`work?query=${encodeURIComponent(q)}&limit=8`)).json);
        const works = [];
        for (const w of found.works.slice(0, 5)) {
            const one = await mbGet(`work/${encodeURIComponent(w.id)}?inc=artist-rels`);
            works.push(parseMbWork(one.json, w));
        }
        const value = { works, counts: { musical: found.count } };
        await cachePut(dataDir, 'musicbrainz', key, { term, value });
        log(`MusicBrainz "${term}": ${works.length} works of ${found.count}`);
        return value;
    }
    async function wdGet(params) {
        const url = new URL(wikidataApi);
        for (const [k, v] of Object.entries({ format: 'json', ...params })) url.searchParams.set(k, v);
        const key = url.searchParams.toString();
        const hit = cacheGet(dataDir, 'wikidata', key);
        if (hit) return hit.value;
        await takeSlot(dataDir, 'wikidata');
        const r = await request(url.toString(), { Accept: 'application/json' });
        let j;
        if (r.status === 429 || r.status === 503 || (r.status >= 300 && r.status < 400)) throw Object.assign(new Error(`Wikidata is temporarily unavailable (HTTP ${r.status})`), { status: 503 });
        try { j = JSON.parse(stripBom(r.body)); } catch { throw Object.assign(new Error(`Wikidata answered HTTP ${r.status} without JSON`), { status: 502 }); }
        if (r.status !== 200 || j.error) throw Object.assign(new Error(`Wikidata error: ${j.error?.info || r.status}`), { status: 502 });
        await cachePut(dataDir, 'wikidata', key, { value: j });
        return j;
    }
    async function wikidataSearch(term) {
        if (!wikidata) return [];
        const s = await wdGet({ action: 'wbsearchentities', search: term, language, uselang: language, type: 'item', limit: '7' });
        const ids = (s.search || []).map((x) => x.id).filter((x) => /^Q\d+$/.test(x)).slice(0, 7);
        if (!ids.length) return [];
        const e = await wdGet({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims', languages: `${language}|en` });
        const ref = (ent, p) => ((ent.claims || {})[p] || []).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean);
        const people = new Set();
        const items = [];
        for (const id of ids) {
            const ent = e.entities && e.entities[id];
            if (!ent) continue;
            const c = { P86: ref(ent, 'P86'), P676: ref(ent, 'P676'), P175: ref(ent, 'P175') };
            if (!c.P86.length && !c.P676.length && !c.P175.length) continue;
            for (const v of Object.values(c)) for (const x of v) people.add(x);
            items.push({ id, label: ent.labels?.[language]?.value || ent.labels?.en?.value || '', c });
        }
        if (!items.length) return [];
        const names = {};
        const plist = [...people].slice(0, 50);
        if (plist.length) {
            const pe = await wdGet({ action: 'wbgetentities', ids: plist.join('|'), props: 'labels', languages: `${language}|en` });
            for (const id of plist) { const x = pe.entities?.[id]; names[id] = { name: x?.labels?.[language]?.value || x?.labels?.en?.value || id, name_en: x?.labels?.en?.value || '' }; }
        }
        const who = (list) => list.map((id) => ({ ...(names[id] || { name: id, name_en: '' }), ipi: '', wikidata: id }));
        return items.map((it) => ({ source: 'wikidata', wikidata: it.id, work_no: '', full_work_id: '', title: it.label, title_en: '', lyricists: who(it.c.P676), composers: who(it.c.P86), others: who(it.c.P175).map((p) => ({ ...p, role: 'performer' })), versions: 0, albums: 0 }));
    }
    return { search, wikidataSearch };
}

// ---- scoring --------------------------------------------------------------------------------
function scoreWorks(works, ctx) {
    const heardTok = tokens(ctx.heardText);
    const clipTok = tokens(ctx.clipText);
    const out = [];
    for (const w of works) {
        const creators = [...w.lyricists, ...w.composers, ...w.others];
        const tSim = Math.max(0, ...ctx.titles.map((t) => titleSim(t, w.title)));
        let strong = 0, medium = 0, clip = 0;
        const why = [];
        for (const c of creators) {
            const s = Math.max(nameInText(c.name, heardTok), c.name_en ? nameInText(c.name_en, tokens(ctx.heardText.toLowerCase())) : 0);
            if (s >= 0.8) { strong++; why.push(`${c.name} heard`); } else if (s >= 0.6) medium++;
            const p = Math.max(nameInText(c.name, clipTok), c.name_en ? nameInText(c.name_en, clipTok) : 0);
            if (p > clip) clip = p;
        }
        if (clip >= 0.8) why.push('clip performer among the writers');
        const heard = Math.min(1, 0.6 * strong + 0.3 * medium);
        const people = clip >= 0.8 ? 1 : clip >= 0.6 ? 0.5 : 0;
        let score = 0.5 * tSim + 0.3 * heard + 0.2 * people;
        if (tSim >= 0.95) why.unshift('same title');
        else if (tSim >= 0.6) why.unshift('similar title');
        out.push({ ...w, score, tSim, why });
    }
    // Only one work with exactly this title: the title alone says more.
    for (const w of out) if (w.tSim >= 0.95 && out.filter((x) => x.tSim >= 0.95 && (x.full_work_id || x.work_no) !== (w.full_work_id || w.work_no)).length === 0) { w.score += 0.15; w.why.push('the only work with this title'); }
    for (const w of out) w.score = Math.round(Math.min(1, w.score) * 100) / 100;
    out.sort((a, b) => b.score - a.score || b.versions - a.versions);
    return out;
}
const creditsOf = (w) => ({
    title: w.title, work_no: w.work_no, full_work_id: w.full_work_id || '', source: w.source,
    lyricists: w.lyricists.map(({ name, ipi }) => ({ name, ipi })), composers: w.composers.map(({ name, ipi }) => ({ name, ipi })),
    others: w.others.map(({ name, ipi, role }) => ({ name, ipi, role })),
});
const candidateOf = (w) => ({ ...creditsOf(w), title_en: w.title_en || '', score: w.score, why: w.why.slice(0, 4), versions: w.versions || 0, albums: w.albums || 0, ...(w.wikidata ? { wikidata: w.wikidata } : {}) });

// Search terms for a song: the hint, else the heard titles (aliased), else lyric fragments.
function termsFor(song, aliases) {
    const fragment = (t) => tokens(t).slice(0, 5).join(' ');
    const alias = (t) => aliases.titles[aliasKey(t)]?.title;
    if (song.hint && song.hint.trim()) { const h = song.hint.trim(); return [...new Set([alias(h), h].filter(Boolean))]; }
    const heard = (song.titles_heard && song.titles_heard.length ? song.titles_heard : [song.title_heard]).filter(Boolean).slice(0, 3);
    const t = [];
    for (const x of heard) { const a = alias(x); if (a) t.push(a); t.push(x); }
    if (t.length) return [...new Set(t)];
    return [...new Set([fragment(song.chorus_line), fragment(song.first_line)].filter((x) => tokens(x).length >= 2))];
}

// Looks up one song. clip = { title, performer, folder, file }. Returns the updated song
// fields { candidates, credits?, looked_up } — the caller merges them into the stored song.
async function lookupSong(song, clip, client, { dataDir } = {}) {
    const aliases = readAliases(dataDir);
    const terms = termsFor(song, aliases);
    const at = new Date().toISOString();
    if (!terms.length) return { candidates: song.candidates || [], looked_up: { at, terms: [], result: 'nothing to search' } };
    const aliasNames = Object.values(aliases.names);
    const heardNames = (song.writers_heard || []).flatMap((h) => { const a = aliases.names[aliasKey(h)]; return a ? [h, a.name] : [h]; });
    const heardText = [song.talk_before || '', heardNames.join(' , '), song.hint || '', ...aliasNames.filter((a) => (song.talk_before || '').includes(a.heard)).map((a) => a.name)].join(' , ');
    const clipText = [clip.performer, clip.title, clip.folder, clip.file].filter(Boolean).join(' , ');
    const works = new Map();
    const counts = [];
    for (const term of terms) {
        const r = await client.search(term);
        counts.push({ term, musical: r.counts.musical || 0, cached: !!r.cached });
        for (const w of r.works) works.set(w.full_work_id || w.work_no, w);
    }
    let scored = scoreWorks([...works.values()], { titles: terms, heardText, clipText });
    // Many works share this title and none fits the people: search title + a name.
    const crowded = counts.some((c) => c.musical > 10);
    if (crowded && (!scored[0] || scored[0].score < SUGGEST_MIN)) {
        const names = [clip.performer, ...(song.writers_heard || [])].filter((n) => n && tokens(n).length >= 2);
        const fromTitle = tokens(clip.title).length >= 2 ? [tokens(clip.title).filter((w) => !/\d/.test(w)).slice(0, 2).join(' ')] : [];
        for (const n of [...names, ...fromTitle].slice(0, 2)) {
            const term = `${terms[0]} ${n}`;
            const r = await client.search(term);
            counts.push({ term, musical: r.counts.musical || 0, cached: !!r.cached });
            for (const w of r.works) works.set(w.full_work_id || w.work_no, w);
        }
        scored = scoreWorks([...works.values()], { titles: terms, heardText, clipText });
    }
    let source = 'musicbrainz';
    if (!scored.length) {
        try {
            const wd = [];
            for (const term of terms.slice(0, 2)) wd.push(...await client.wikidataSearch(term));
            scored = scoreWorks(wd, { titles: terms, heardText, clipText });
            source = 'wikidata';
        } catch (e) { counts.push({ term: 'wikidata', error: e.message }); }
    }
    const top = scored.slice(0, 5);
    const best = top[0];
    const next = top.find((w) => w !== best && (w.work_no || w.title) !== (best?.work_no || best?.title));
    const clear = best && best.score >= SUGGEST_MIN && (!next || best.score - next.score >= SUGGEST_LEAD);
    const out = { candidates: top.map(candidateOf), looked_up: { at, terms: counts, result: !best ? 'none' : clear ? 'suggested' : 'ambiguous', source } };
    if (clear) out.credits = creditsOf(best);
    return out;
}

// Applies a lookup result to the stored song (re-read under the lock): confirmed credits and
// songs a person changed meanwhile keep their credits; candidates are always refreshed.
async function applyLookup(dataDir, clipId, songId, seen, res) {
    let changed = null;
    await store.updateSongsAsync(dataDir, clipId, (doc) => {
        if (!doc || !Array.isArray(doc.songs)) return undefined;
        const s = doc.songs.find((x) => x.id === songId);
        if (!s) return undefined;
        s.candidates = res.candidates;
        s.looked_up = res.looked_up;
        const untouched = s.status === 'suggested' && JSON.stringify(s.credits || null) === JSON.stringify(seen.credits || null) && (s.hint || '') === (seen.hint || '');
        if (untouched && s.source !== 'person') s.credits = res.credits || null;
        doc.updated = new Date().toISOString();
        changed = s;
        return doc;
    });
    return changed;
}

const needsLookup = (s, force) => s.status !== 'not_a_song' && s.status !== 'rejected' && (s.status !== 'confirmed' || !!s.hint) && (force || !s.looked_up || (s.hint && s.looked_up.hint !== s.hint));

// Looks up the songs of one clip that need it. Stops at the first "format changed".
async function lookupClip(dataDir, clipId, clip, client, { force = false, onlySong = null, stop = () => false, log = () => {} } = {}) {
    const doc = store.readSongs(dataDir, clipId);
    if (!doc || !Array.isArray(doc.songs)) return { looked_up: 0, suggested: 0 };
    let n = 0, sug = 0;
    for (const s of doc.songs) {
        if (stop()) break;
        if (onlySong ? s.id !== onlySong : !needsLookup(s, force)) continue;
        const res = await lookupSong(s, clip, client, { dataDir });
        res.looked_up.hint = s.hint || '';
        const after = await applyLookup(dataDir, clipId, s.id, s, res);
        n++;
        if (after && after.credits && after.status === 'suggested') sug++;
        log(`${clipId} ${s.title_heard || '(no title)'}: ${res.looked_up.result}${res.credits ? ` -> ${res.credits.title} (${res.credits.work_no})` : ''}`);
    }
    return { looked_up: n, suggested: sug };
}

// ---- library and metadata for the CLI and the overnight run ------------------------------------
function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
        else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
        else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const [head, ...data] = rows.filter((r) => r.length > 1 || r[0]);
    return head ? data.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^\uFEFF/, ''), r[i] ?? '']))) : [];
}
const clipId = (r) => 'c' + crypto.createHash('sha1').update(`${r.size_bytes}:${Number(r.duration_s || 0).toFixed(3)}`).digest('hex').slice(0, 15);
// Clip id -> { title, performer, folder, file } from library.csv and clip-metadata.json.
function clipContext(libraryCsv, metaFile) {
    const map = new Map();
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, '')).clips || {}; } catch { /* no metadata */ }
    try {
        for (const r of parseCsv(fs.readFileSync(libraryCsv, 'utf8'))) {
            const id = clipId(r);
            if (map.has(id)) continue;
            const m = meta[id] || {};
            map.set(id, { title: m.title || String(r.file || '').replace(/\.[^.]+$/, ''), performer: m.performer || '', folder: r.folder || '', file: r.file || '' });
        }
    } catch { /* no library */ }
    return map;
}

module.exports = { FormatChanged, Unavailable, request, createClient, lookupSong, lookupClip, applyLookup, needsLookup, scoreWorks, parseMbSearch, parseMbWork, titleSim, nameSim, phon, termsFor, addAliases, aliasPairs, readAliases, clipContext, creditsOf, SUGGEST_MIN, SUGGEST_LEAD, _takeSlot: takeSlot };

// ---- CLI ---------------------------------------------------------------------------------------
if (require.main === module) {
    const args = process.argv.slice(2);
    const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
    const DATA = path.resolve(opt('--data', cfg.dataDir));
    const LIB = opt('--library', cfg.libraryCsv);
    const META = opt('--meta', path.join(DATA, 'clip-metadata.json'));
    const ONE = opt('--clip', '');
    const FORCE = args.includes('--force');
    const MAX = Number(opt('--max', 500)) || 500;
    const UNTIL = opt('--until', '');
    const STOPF = path.join(DATA, 'analysis', 'STOP');
    const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
    let untilAt = null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(UNTIL);
    if (m) { const t = new Date(); t.setHours(Number(m[1]), Number(m[2]), 0, 0); if (t <= Date.now()) t.setDate(t.getDate() + 1); untilAt = t.getTime(); }
    const stop = () => fs.existsSync(STOPF) || (untilAt && Date.now() >= untilAt);
    (async () => {
        const ctx = clipContext(LIB, META);
        const client = createClient({ dataDir: DATA, wikidata: !args.includes('--no-wikidata'), log });
        const ids = ONE ? [ONE] : store.listIds(store.dirs(DATA).songs);
        let songs = 0, sug = 0, clips = 0;
        for (const id of ids) {
            if (stop() || songs >= MAX) break;
            let r;
            try { r = await lookupClip(DATA, id, ctx.get(id) || {}, client, { force: FORCE, stop: () => stop() || songs >= MAX, log }); }
            catch (e) {
                if (e.code === 'CREDITS_FORMAT') { log(`${e.message}. Stopping: the lookup needs updating before it runs again.`); process.exitCode = 3; break; }
                if (e.code === 'CREDITS_UNAVAILABLE') { log(`${e.message} Stopping this run; nothing is lost.`); process.exitCode = 4; break; }
                if (e.damaged) { log(e.message); continue; }
                throw e;
            }
            if (r.looked_up) clips++;
            songs += r.looked_up; sug += r.suggested;
        }
        log(`Credits lookup done: ${songs} songs in ${clips} clips looked up, ${sug} with a suggestion to confirm.`);
    })().catch((e) => { log(`Credits lookup failed: ${e.message}`); process.exit(1); });
}
