// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const R = require('./registry');

// --- songs inside clips and their credits ------------------------------------------------
// data\transcripts\<clip id>.json: timed text (overnight "Timed text" check, or imported).
// data\songs\<clip id>.json: songs found in it, with credits looked up from MusicBrainz / Wikidata.
// A person confirms, edits or rejects each song in Needs attention > Songs; automation never
// overwrites what a person confirmed or edited. The code shared with the tools lives in
// tools\songs and tools\credits (next to deep-scan.js).
const TOOLS_DIR = path.resolve(R.core.cfg.toolsDir);
const SONGS_DIR = path.join(R.core.DATA_DIR, 'songs');
const TRANSCRIPTS_DIR = path.join(R.core.DATA_DIR, 'transcripts');
function songLib() {
    if (songLib.m) return songLib.m;
    try {
        songLib.m = {
            store: require(path.join(TOOLS_DIR, 'songs', 'song-store.js')),
            detect: require(path.join(TOOLS_DIR, 'songs', 'detect-songs.js')),
            credits: require(path.join(TOOLS_DIR, 'credits', 'lookup-credits.js')),
        };
    } catch (e) { throw Object.assign(new Error(`The song tools are missing or broken in ${TOOLS_DIR} (${String(e.message).slice(0, 160)}). Copy tools\\songs, tools\\credits and tools\\whisper there.`), { status: 503 }); }
    return songLib.m;
}
// Songs files, re-read only when one changed (folder checked at most every 2 s).
let songIdx = { at: 0, files: new Map(), ver: 0 };
function songsIndex() {
    if (Date.now() - songIdx.at < 2000) return songIdx;
    songIdx.at = Date.now();
    let names = [];
    try { names = fs.readdirSync(SONGS_DIR); } catch { /* none yet */ }
    const seen = new Set();
    for (const n of names) {
        const m = /^(c[0-9a-f]{15})\.json$/.exec(n);
        if (!m) continue;
        seen.add(m[1]);
        let st;
        try { st = fs.statSync(path.join(SONGS_DIR, n)); } catch { continue; }
        const cur = songIdx.files.get(m[1]);
        if (cur && cur.mtime === st.mtimeMs && cur.size === st.size) continue;
        let doc = null, error = null;
        try { doc = JSON.parse(fs.readFileSync(path.join(SONGS_DIR, n), 'utf8')); } catch (e) { error = e.message; }
        songIdx.files.set(m[1], { mtime: st.mtimeMs, size: st.size, doc, error });
        songIdx.ver++;
    }
    for (const k of [...songIdx.files.keys()]) if (!seen.has(k)) { songIdx.files.delete(k); songIdx.ver++; }
    return songIdx;
}
const songKind = (x) => (x.status === 'confirmed' ? 'confirmed' : x.status === 'not_a_song' || x.status === 'rejected' ? 'closed' : x.credits ? 'suggested' : 'missing');
const SONG_FIELDS = ['id', 's', 'e', 'title_heard', 'titles_heard', 'writers_heard', 'first_line', 'chorus_line', 'status', 'credits', 'candidates', 'source', 'confidence', 'hint', 'notes', 'confirmed_by', 'confirmed_at', 'looked_up', 'updated_at', 'updated_by'];
const songView = (x) => ({ ...Object.fromEntries(SONG_FIELDS.map((k) => [k, x[k] ?? null])), kind: songKind(x) });
function songClipView(id) {
    const rows = R.media.libraryById().get(id);
    if (!rows) return { id, missing: true, title: id, file: '', folder: '', path: '', duration: 0, thumb: R.attention.thumbIds().has(id), performer: '' };
    const vis = R.attention.visibleRows(rows);
    const r = vis[0] || rows[0];
    const m = R.metadata.metaOf(id, r);
    return { id, title: m.title, performer: m.performer || '', file: r.file, folder: r.folder, path: r.path, duration: Number(r.duration_s) || 0, thumb: R.attention.thumbIds().has(id), made: R.attention.madeOf(id), hidden: !vis.length };
}

// Clips in saved playlists from today to 6 days ahead: { clip id: [dates] } (30 s cache).
let soonCache = { at: 0, day: '', map: {} };
// Broadcast day: the playlist date that is playing now: yesterday's date while the wall clock
// is before the day start. The day start comes from ffplayout's config: the panel's pages send it with their
// requests (?ds=seconds) and the automation reads it too; the last value seen is kept.
let dayStartS = 0, dayStartFromPage = false;
function noteDayStart(v) { if (v === null || v === undefined || v === '') return; const n = Number(v); if (Number.isFinite(n) && n >= 0 && n < 86400) { dayStartS = Math.floor(n); dayStartFromPage = true; } }
function broadcastToday() {
    // The automation's copy of the config is used only until a page has sent the day start.
    if (!dayStartFromPage && R.automation.auto.config?.playlist?.day_start) { const n = R.automation.parseHms(R.automation.auto.config.playlist.day_start); if (Number.isFinite(n) && n >= 0 && n < 86400) dayStartS = Math.floor(n); }
    // By the wall clock (not "now minus N seconds", which is off by an hour on DST change days).
    const d = new Date();
    if (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() < dayStartS) d.setDate(d.getDate() - 1);
    return R.metadata.ymd(d);
}
function soonClips() {
    const t = broadcastToday();
    if (soonCache.day === t && Date.now() - soonCache.at < 30000) return soonCache.map;
    const end = new Date(t + 'T12:00:00'); end.setDate(end.getDate() + 6);
    const last = R.metadata.ymd(end);
    const map = {};
    R.attention.forEachSavedPlaylist(t, (date, pl) => {
        if (date > last) return;
        for (const it of pl.program || []) {
            const id = it && it.source ? R.media.idForPath(it.source) : null;
            if (!id) continue;
            const l = map[id] || (map[id] = []);
            if (!l.includes(date)) l.push(date);
        }
    });
    for (const k of Object.keys(map)) map[k].sort();
    soonCache = { at: Date.now(), day: t, map };
    return map;
}
const onAirId = (source) => (source ? R.media.idForPath(String(source)) : null);

// "format changed" is remembered until a later lookup works.
let lookupState = { ok: null, at: null, detail: '' };
function songsTools() {
    let transcript = null;
    try { const m = R.analysis.analyzerModules().get('transcript'); transcript = m && m.available ? m.available() : null; } catch { /* none */ }
    return { whisper: transcript ? { ok: !!transcript.ok, why: transcript.why || '' } : { ok: false, why: 'tools\\analyzers\\transcript.js is missing' }, lookup: lookupState };
}

function songsList(q) {
    songLib();
    const idx = songsIndex();
    const filter = ['missing', 'suggested', 'confirmed', 'closed', 'all'].includes(q.get('filter')) ? q.get('filter') : 'missing';
    const range = ['today', 'week'].includes(q.get('range')) ? q.get('range') : 'all';
    const only = q.get('clip') || '';
    const onair = onAirId(q.get('onair'));
    noteDayStart(q.get('ds'));
    const soon = soonClips();
    const t = broadcastToday();
    const counts = { missing: 0, suggested: 0, confirmed: 0, closed: 0, all: 0, clips: 0, soon_today: 0, soon_week: 0, damaged: 0, on_air: 0 };
    const groups = [];
    const damaged = [];
    for (const [id, f] of idx.files) {
        if (f.error || !f.doc) { counts.damaged++; damaged.push(id); continue; }
        const songs = Array.isArray(f.doc.songs) ? f.doc.songs : [];
        if (!songs.length) continue;
        counts.clips++;
        const sd = soon[id] || null;
        const isToday = !!sd && sd[0] === t;
        let open = 0;
        for (const x of songs) { const k = songKind(x); counts[k]++; counts.all++; if (k === 'missing' || k === 'suggested') open++; }
        // The clip on air now counts as "on air today" too.
        if (open && (sd || id === onair)) { counts.soon_week += open; if (isToday || id === onair) counts.soon_today += open; }
        if (open && id === onair) counts.on_air += open;
        if (only && id !== only) continue;
        if (range === 'today' && !isToday && id !== onair) continue;
        if (range === 'week' && !sd && id !== onair) continue;
        const pick = songs.filter((x) => filter === 'all' || songKind(x) === filter).sort((a, b) => a.s - b.s);
        if (!pick.length) continue;
        groups.push({ clip: songClipView(id), soon: sd, on_air: id === onair, songs: pick.map(songView), total_songs: songs.length });
    }
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
    groups.sort((a, b) => (b.on_air - a.on_air) || ((a.soon ? 0 : 1) - (b.soon ? 0 : 1)) || String(a.soon?.[0] || '').localeCompare(String(b.soon?.[0] || '')) || cmp(a.clip.title, b.clip.title));
    const offset = Math.max(0, Number(q.get('offset')) || 0), limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 30));
    let transcripts = 0;
    try { transcripts = fs.readdirSync(TRANSCRIPTS_DIR).filter((n) => /^c[0-9a-f]{15}\.json$/.test(n)).length; } catch { /* none */ }
    return { counts, total_groups: groups.length, groups: groups.slice(offset, offset + limit), offset, limit, filter, range, on_air_id: onair, transcripts, damaged, tools: songsTools() };
}

function songsClip(id, withLines) {
    const L = songLib();
    if (!L.store.ID_RE.test(String(id))) throw Object.assign(new Error('unknown clip id'), { status: 400 });
    const doc = L.store.readSongs(R.core.DATA_DIR, id);
    let tr = null;
    try { tr = L.store.readTranscript(R.core.DATA_DIR, id); } catch (e) { tr = { damaged: e.message }; }
    const summary = tr && !tr.damaged ? { lines: (tr.lines || []).length, flagged: tr.flagged || 0, no_speech: !!tr.no_speech, model: tr.model || '', created: tr.created || '', source: tr.source || '', imported_from: tr.imported_from || '' } : tr;
    return {
        clip: songClipView(id), soon: soonClips()[id] || null,
        songs: doc && Array.isArray(doc.songs) ? doc.songs.map((x) => ({ ...songView(x), talk_before: x.talk_before || '' })) : [],
        archived: doc && Array.isArray(doc.archived) ? doc.archived.length : 0, updated: doc?.updated || null, detector: doc?.detector || null,
        transcript: summary, lines: withLines && tr && !tr.damaged ? (tr.lines || []).map((l) => ({ s: l.s, e: l.e, text: l.text, flags: l.flags || [] })) : undefined,
        tools: songsTools(),
    };
}

const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const nameList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/)).map(cleanName).filter(Boolean).slice(0, 12);
function cleanCredits(c) {
    if (!c || typeof c !== 'object') throw Object.assign(new Error('No credits to accept.'), { status: 400 });
    const people = (l) => (Array.isArray(l) ? l : []).map((p) => ({ name: cleanName(p && p.name), ipi: cleanName(p && p.ipi), ...(p && p.role ? { role: cleanName(p.role) } : {}) })).filter((p) => p.name).slice(0, 12);
    return { title: cleanName(c.title), work_no: cleanName(c.work_no), full_work_id: cleanName(c.full_work_id), source: cleanName(c.source) || 'person', lyricists: people(c.lyricists), composers: people(c.composers), others: people(c.others) };
}
const songErr = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function songUpdate(body) {
    const L = songLib();
    const id = String(body.clip || '');
    if (!L.store.ID_RE.test(id)) throw songErr('unknown clip id');
    const action = String(body.action || '');
    if (!['accept', 'edit', 'not_a_song', 'reopen', 'adjust', 'split', 'hint'].includes(action)) throw songErr('unknown action');
    const by = cleanName(body.by).slice(0, 80);
    let result = null, extra = null, aliasReq = null;
    // Non-blocking lock: a file held by the overnight run or the CLI makes this wait up to 3 s, then 503.
    await L.store.updateSongsAsync(R.core.DATA_DIR, id, (doc) => {
        if (!doc || !Array.isArray(doc.songs)) throw songErr('This clip has no songs.', 404);
        const s = doc.songs.find((x) => x.id === body.song);
        if (!s) throw songErr('This song is no longer in the list (detection ran again). Reload.', 409);
        const now = new Date().toISOString();
        const dur = Number(R.media.rowForId(id)?.duration_s) || Infinity;
        if (action === 'accept') {
            const c = body.candidate === 'suggestion' || body.candidate == null ? s.credits : (s.candidates || [])[Number(body.candidate)];
            if (!c) throw songErr('That suggestion is no longer there. Reload.', 409);
            s.credits = cleanCredits(c);
            s.status = 'confirmed'; s.source = 'person'; s.confirmed_by = by; s.confirmed_at = now;
            aliasReq = L.credits.aliasPairs(s, s.credits);
        } else if (action === 'edit') {
            const title = cleanName(body.title);
            const work = cleanName(body.work_no);
            if (work && !/^[0-9A-Za-z.-]{1,24}$/.test(work)) throw songErr('The work ID has letters or signs it cannot have.');
            const ly = nameList(body.lyricists), co = nameList(body.composers);
            if (!title && !ly.length && !co.length) throw songErr('Enter at least the title or one writer.');
            // Known IPI numbers are kept for names that stay the same.
            const known = new Map();
            for (const src of [s.credits, ...(s.candidates || []), ...doc.songs.flatMap((x) => [x.credits, ...(x.candidates || [])])]) for (const p of src ? [...(src.lyricists || []), ...(src.composers || []), ...(src.others || [])] : []) if (p.ipi && !known.has(p.name)) known.set(p.name, p.ipi);
            const ppl = (l) => l.map((n) => ({ name: n, ipi: known.get(n) || '' }));
            const sameWork = s.credits && s.credits.work_no && s.credits.work_no === work;
            s.credits = { title, work_no: work, full_work_id: sameWork ? s.credits.full_work_id || '' : '', source: 'person', lyricists: ppl(ly), composers: ppl(co), others: s.credits ? s.credits.others || [] : [] };
            if (body.notes !== undefined) s.notes = String(body.notes || '').slice(0, 1000);
            if (body.confirm !== false) { s.status = 'confirmed'; s.confirmed_by = by; s.confirmed_at = now; }
            s.source = 'person';
            aliasReq = L.credits.aliasPairs(s, s.credits);
        } else if (action === 'not_a_song') {
            s.status = 'not_a_song'; s.source = 'person';
            if (body.notes !== undefined) s.notes = String(body.notes || '').slice(0, 1000);
        } else if (action === 'reopen') {
            s.status = 'suggested'; s.source = 'person'; s.confirmed_by = ''; s.confirmed_at = '';
        } else if (action === 'adjust') {
            const a = Number(body.s), b = Number(body.e);
            if (!(Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a)) throw songErr('The start must be before the end.');
            if (b > dur + 1) throw songErr(`The end is after the end of the clip (${R.metadata.fmtHms(dur)}).`);
            if (b - a < 5) throw songErr('A song must be at least 5 seconds long.');
            s.s = Math.round(a * 10) / 10; s.e = Math.round(b * 10) / 10; s.source = 'person';
        } else if (action === 'split') {
            const at = Number(body.at);
            if (!(at > s.s + 5 && at < s.e - 5)) throw songErr('Split inside the song, at least 5 seconds from its start and end.');
            const second = { ...L.detect.emptySong({ s: Math.round(at * 10) / 10, e: s.e, title_heard: '', first_line: '', chorus_line: '' }), source: 'person', split_from: s.id };
            s.e = Math.round(at * 10) / 10; s.source = 'person';
            doc.songs.push(second);
            doc.songs.sort((x, y) => x.s - y.s);
            extra = second;
        } else if (action === 'hint') {
            s.hint = String(body.hint || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        s.updated_at = now; s.updated_by = by;
        doc.updated = now;
        result = s;
        return doc;
    });
    let aliases = 0;
    if (aliasReq) { try { aliases = await L.credits.addAliases(R.core.DATA_DIR, aliasReq, by); } catch (e) { console.error('aliases', e.message); } }
    songIdx.at = 0;
    return { song: songView(result), added: extra ? songView(extra) : null, aliases };
}

// One song looked up now (shared 1-request-per-second limit with the overnight run).
const lookupBusy = new Set();
let songClient = null;
async function songLookup(body) {
    const L = songLib();
    const id = String(body.clip || ''), sid = String(body.song || '');
    if (!L.store.ID_RE.test(id)) throw songErr('unknown clip id');
    if (typeof body.hint === 'string') await songUpdate({ clip: id, song: sid, action: 'hint', hint: body.hint, by: body.by });
    const key = `${id}|${sid}`;
    if (lookupBusy.has(key)) throw songErr('This song is being looked up already.', 409);
    lookupBusy.add(key);
    try {
        const r = R.media.rowForId(id);
        const m = r ? R.metadata.metaOf(id, r) : {};
        songClient = songClient || L.credits.createClient({ dataDir: R.core.DATA_DIR, log: (t) => console.log(`credits: ${t}`) });
        const res = await L.credits.lookupClip(R.core.DATA_DIR, id, { title: m.title || '', performer: m.performer || '', folder: r?.folder || '', file: r?.file || '' }, songClient, { onlySong: sid });
        if (!res.looked_up) throw songErr('This song is no longer in the list. Reload.', 409);
        lookupState = { ok: true, at: new Date().toISOString(), detail: '' };
    } catch (e) {
        if (e.code === 'CREDITS_FORMAT') lookupState = { ok: false, at: new Date().toISOString(), detail: e.message };
        // Provider busy (429/503/redirect): reported to the person, not remembered as a format change.
        throw e;
    } finally { lookupBusy.delete(key); }
    songIdx.at = 0;
    const doc = L.store.readSongs(R.core.DATA_DIR, id);
    const s = doc.songs.find((x) => x.id === sid);
    return { song: songView(s), lookup: lookupState };
}

async function songDetect(body) {
    const L = songLib();
    const id = String(body.clip || '');
    if (!L.store.ID_RE.test(id)) throw songErr('unknown clip id');
    const tr = L.store.readTranscript(R.core.DATA_DIR, id);
    if (!tr) throw songErr('This clip has no timed text yet. Tick “Timed text” in the Overnight analysis card, or import a transcript.', 404);
    const auto = L.detect.detect(tr);
    let before = 0;
    const doc = await L.store.updateSongsAsync(R.core.DATA_DIR, id, (cur) => { before = cur && Array.isArray(cur.songs) ? cur.songs.length : 0; return L.detect.merge(cur, auto, { clipId: id }); });
    songIdx.at = 0;
    return { songs: doc.songs.length, before, detected: auto.length, kept: doc.songs.filter(L.detect.isKept).length, archived: (doc.archived || []).length };
}

// ---- as-run: works (confirmed songs) inside what aired --------------------------------------
// The aired part of a clip starts at the playlist item's in-point (from the saved playlist of
// that day or the day before; 0 when not found) and lasts aired_s.
const plCache = new Map();
function savedPlaylist(date) {
    const file = path.join(R.core.PLAYLISTS_DIR, date.slice(0, 4), date.slice(5, 7), `${date}.json`);
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const c = plCache.get(file);
    if (c && c.mtime === st.mtimeMs) return c.pl;
    let pl = null;
    try { pl = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being written */ }
    if (plCache.size > 60) plCache.clear();
    plCache.set(file, { mtime: st.mtimeMs, pl });
    return pl;
}
function inPointOf(e) {
    const src = String(e.source).toLowerCase();
    const prev = new Date(e.date + 'T12:00:00Z'); prev.setUTCDate(prev.getUTCDate() - 1);
    for (const d of [e.date, prev.toISOString().slice(0, 10)]) {
        const pl = savedPlaylist(d);
        for (const it of (pl && pl.program) || []) {
            if (String(it.source || '').toLowerCase() !== src) continue;
            const len = Number(it.out ?? it.duration) - Number(it.in || 0);
            if (Number.isFinite(len) && Math.abs(len - e.planned_s) < 1.5) return Number(it.in) || 0;
        }
    }
    return 0;
}
function asrunWorks(e) {
    const id = e.id || R.media.idForPath(e.source);
    if (!id) return [];
    let f;
    try { f = songsIndex().files.get(id); } catch { return []; }
    const conf = (f && f.doc && Array.isArray(f.doc.songs) ? f.doc.songs : []).filter((x) => x.status === 'confirmed' && x.credits);
    if (!conf.length) return [];
    const a = inPointOf(e), b = a + (Number(e.aired_s) || 0);
    const names = (l) => (l || []).map((p) => p.name).filter(Boolean).join(', ');
    return conf.filter((x) => Math.min(x.e, b) - Math.max(x.s, a) >= 5).map((x) => ({
        work_no: x.credits.work_no || '', title: x.credits.title || x.title_heard || '', lyricists: names(x.credits.lyricists), composers: names(x.credits.composers),
        others: names(x.credits.others), at_s: Math.round(Math.max(x.s, a) - a), aired_s: Math.round(Math.min(x.e, b) - Math.max(x.s, a)), song_s: x.s, song_e: x.e,
    }));
}


// ---- exports (read by the other modules through R.songs) ----
R.songs = module.exports;
Object.assign(module.exports, { TOOLS_DIR, SONGS_DIR, TRANSCRIPTS_DIR, songLib, songsIndex, songKind, SONG_FIELDS, songView, songClipView, noteDayStart, broadcastToday, soonClips, onAirId, songsTools, songsList, songsClip, cleanName, nameList, cleanCredits, songErr, songUpdate, lookupBusy, songLookup, songDetect, plCache, savedPlaylist, inPointOf, asrunWorks });
Object.defineProperty(module.exports, 'songIdx', { get: () => songIdx, set: (v) => { songIdx = v; }, enumerable: true });
Object.defineProperty(module.exports, 'soonCache', { get: () => soonCache, set: (v) => { soonCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'dayStartS', { get: () => dayStartS, set: (v) => { dayStartS = v; }, enumerable: true });
Object.defineProperty(module.exports, 'dayStartFromPage', { get: () => dayStartFromPage, set: (v) => { dayStartFromPage = v; }, enumerable: true });
Object.defineProperty(module.exports, 'lookupState', { get: () => lookupState, set: (v) => { lookupState = v; }, enumerable: true });
Object.defineProperty(module.exports, 'songClient', { get: () => songClient, set: (v) => { songClient = v; }, enumerable: true });
