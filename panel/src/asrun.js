// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const R = require('./registry');

// --- as-run log --------------------------------------------------------------
// Built from ffplayout's engine log: every "Play for <length>: <source>" line is an item
// that started at that time. An item ends at the next item's start, at a playout stop, or
// after its planned length, whichever comes first. Entries are archived per month in
// data\asrun\YYYY-MM.jsonl so they survive engine log rotation.

const stripTags = (l) => l.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const LOG_LINE = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)?([+-]\d\d:\d\d)?\]\s+\[\s*(\w+)\]\s+(.*)$/;
const hmsToS = (t) => { const [h, m, x] = t.split(':').map(Number); return h * 3600 + m * 60 + x; };

// Output health from the engine's own log (this PC's side only: whether the encoder
// reports trouble sending the stream, not what YouTube does with it). Looks at the
// current log since the last playout start; stream keys are masked.
const OUTPUT_ERR = /rtmps?:\/\/|tcp:\/\/|\b(rtmp|flv|tls|tcp) @|connection (refused|reset|timed out)|broken pipe|i\/o error|input\/output error|av_interleaved_write_frame|error writing trailer|failed to update header|handshake|server error|network is unreachable|error muxing|error number -?\d+ occurred|could not write header|unable to (open|connect)|no route to host|host is unreachable/i;
const maskKeys = (t) => String(t).replace(/(rtmps?:\/\/[^/\s]+\/[^/\s]+\/)[^\s"'<:]+/gi, '$1••••••••').replace(/(live2\/)[^\s"'<:]+/gi, '$1••••••••');
let healthCache = { key: '', value: null };
function outputHealth() {
    const file = path.join(R.core.ENGINE_LOG_DIR, 'ffplayout_1.log');
    let st;
    try { st = fs.statSync(file); } catch { return { log: false, started_at: null, stopped_at: null, errors: [] }; }
    const key = `${st.size}:${st.mtimeMs}`;
    if (healthCache.key === key) return healthCache.value;
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    let started = null, stopped = null, errors = [];
    for (const raw of buf.toString('utf8').split(/\r?\n/)) {
        const m = LOG_LINE.exec(stripTags(raw).trim());
        if (!m) continue;
        const [, d, t, tz = '+00:00', level, msg] = m;
        const at = Date.parse(`${d}T${t}${tz}`);
        if (/^Start ffplayout\b/i.test(msg)) { started = at; stopped = null; errors = []; continue; }
        if (/stop all child processes/i.test(msg)) { stopped = at; continue; }
        if (/^(ERROR|WARN|WARNING|FATAL)$/i.test(level) && OUTPUT_ERR.test(msg) && !/playlist/i.test(msg)) {
            errors.push({ at, level: level.toUpperCase(), text: maskKeys(msg).replace(/^\[ffmpeg\]\s*/i, '').slice(0, 300) });
            if (errors.length > 50) errors.shift();
        }
    }
    const value = { log: true, started_at: started, stopped_at: stopped, error_count: errors.length, last_error: errors.at(-1) || null, recent: errors.slice(-5), log_updated: st.mtimeMs };
    healthCache = { key, value };
    return value;
}

// Parsed per log file and kept until that file's size or time changes.
const engineLogCache = new Map();
let engineAll = { key: '', out: [] };
function parseEngineLogs() {
    let names = [];
    try { names = fs.readdirSync(R.core.ENGINE_LOG_DIR).filter((n) => /^ffplayout_\d+.*\.log/i.test(n)); } catch { return []; }
    const events = [], keys = [];
    for (const n of names) {
        const file = path.join(R.core.ENGINE_LOG_DIR, n);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        const k = `${st.size}:${st.mtimeMs}`;
        let c = engineLogCache.get(n);
        if (!c || c.key !== k) {
            let text = '';
            try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
            const ev = [];
            for (const raw of text.split(/\r?\n/)) {
                if (!raw.includes('Play for') && !/stop all child processes/i.test(raw)) continue;
                const m = LOG_LINE.exec(stripTags(raw).trim());
                if (!m) continue;
                const [, d, t, tz = '+00:00', , msg] = m;
                const at = Date.parse(`${d}T${t}${tz}`);
                const play = /^Play for (\d+:\d\d:\d\d(?:\.\d+)?): (.+)$/.exec(msg);
                if (play) ev.push({ at, date: d, time: t, tz, planned: hmsToS(play[1]), source: play[2].trim() });
                else ev.push({ at, stop: true });
            }
            c = { key: k, events: ev };
            engineLogCache.set(n, c);
        }
        keys.push(`${n}=${k}`);
        for (const e of c.events) events.push(e);
    }
    for (const n of [...engineLogCache.keys()]) if (!names.includes(n)) engineLogCache.delete(n);
    const allKey = keys.join('|');
    if (engineAll.key === allKey) return engineAll.out;
    events.sort((x, y) => x.at - y.at);
    const out = [];
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.stop) continue;
        const next = events[i + 1];
        const until = next ? (next.at - e.at) / 1000 : null;
        out.push({ key: `${e.at}|${e.source}`, date: e.date, time: e.time, tz: e.tz, at: e.at, planned_s: e.planned, aired_s: Math.max(0, Math.min(e.planned, until ?? e.planned)), open: !next, source: e.source });
    }
    engineAll = { key: allKey, out };
    return out;
}

// Merges new log entries into the monthly archive files (the last, still-open item is
// stored once it has ended).
let asrunSynced = 0;
function syncAsrun(force, parsed) {
    if (!force && Date.now() - asrunSynced < 60000) return;
    asrunSynced = Date.now();
    const byMonth = new Map();
    for (const e of parsed || parseEngineLogs()) {
        if (e.open) continue;
        const k = e.date.slice(0, 7);
        if (!byMonth.has(k)) byMonth.set(k, []);
        byMonth.get(k).push(e);
    }
    fs.mkdirSync(R.core.ASRUN_DIR, { recursive: true });
    for (const [month, list] of byMonth) {
        const file = path.join(R.core.ASRUN_DIR, `${month}.jsonl`);
        const have = new Set(readAsrunMonth(month).map((e) => e.key));
        const add = list.filter((e) => !have.has(e.key));
        if (add.length) fs.appendFileSync(file, add.map((e) => JSON.stringify({ key: e.key, date: e.date, time: e.time, tz: e.tz, at: e.at, planned_s: e.planned_s, aired_s: Number(e.aired_s.toFixed(3)), source: e.source, id: R.media.idForPath(e.source) })).join('\n') + '\n', 'utf8');
    }
}
function readAsrunMonth(month) {
    try {
        return fs.readFileSync(path.join(R.core.ASRUN_DIR, `${month}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}
// Archived entries for dates from..to (inclusive), plus the item playing now.
function asrunRange(from, to) {
    const parsed = parseEngineLogs();
    syncAsrun(false, parsed);
    const months = new Set();
    for (let d = new Date(from + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) months.add(d.toISOString().slice(0, 7));
    const seen = new Set(), rows = [];
    for (const m of months) for (const e of readAsrunMonth(m)) if (e.date >= from && e.date <= to && !seen.has(e.key)) { seen.add(e.key); rows.push(e); }
    for (const e of parsed) if (e.open && e.date >= from && e.date <= to && !seen.has(e.key)) { seen.add(e.key); rows.push({ ...e, playing: true, aired_s: Math.min(e.planned_s, (Date.now() - e.at) / 1000) }); }
    rows.sort((a, b) => a.at - b.at);
    return rows;
}
const STORAGE_KIND = (src) => {
    const low = String(src).toLowerCase();
    const st = R.core.STORAGE_ROOT.toLowerCase();
    if (!low.startsWith(st + path.sep) && !low.startsWith(st + '/')) return null;
    const sub = low.slice(st.length + 1).split(/[\\/]/)[0];
    return sub === 'filler' ? 'filler' : sub === 'offair' ? 'offair' : sub === 'live' ? 'live' : 'storage';
};
function asrunView(e) {
    const kind = STORAGE_KIND(e.source);
    // By clip ID first, so plays of a file that was later renamed or moved keep their details.
    const row = R.media.rowForId(e.id || R.media.idForPath(e.source)) || R.media.library().get(String(e.source).toLowerCase());
    const m = row ? R.metadata.metaOf(row.id, row) : null;
    return {
        date: e.date, time: e.time, aired_s: e.aired_s, planned_s: e.planned_s, playing: !!e.playing, source: e.source,
        kind: kind || (row ? 'clip' : 'unknown'),
        title: m ? m.title : path.basename(String(e.source)).replace(/\.[^.]+$/, ''),
        performer: m?.performer || '', songwriters: m?.songwriters || '', category: m?.category || '', language: m?.language || '',
        rights: m ? (R.metadata.isCleared(m, e.date) ? 'cleared' : m.rights === 'cleared' ? 'expired' : m.rights) : '',
        folder: row?.folder || '', file: path.basename(String(e.source)),
        // Confirmed songs inside the part that aired (for rights-society and royalty reports); the clip entry itself is unchanged.
        works: kind ? [] : R.songs.asrunWorks(e),
    };
}
// Clip IDs aired on the `days` days before `date`.
function recentlyAiredIds(date, days) {
    const to = new Date(date + 'T12:00:00Z'); to.setUTCDate(to.getUTCDate() - 1);
    const from = new Date(date + 'T12:00:00Z'); from.setUTCDate(from.getUTCDate() - days);
    const ids = new Set();
    for (const e of asrunRange(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10))) {
        const id = e.id || R.media.idForPath(e.source);
        if (id && e.aired_s >= 30) ids.add(id);
    }
    return ids;
}
const RIGHTS_LABEL = { cleared: 'Cleared', expired: 'Expired', blocked: 'Blocked', unknown: 'Unknown' };
const KIND_LABEL = { clip: 'Content', filler: 'Filler', offair: 'Off air', live: 'Live (standby)', storage: 'Channel asset', unknown: 'Not in library' };
// As-run CSV (UTF-8 with BOM, opens in Excel) and JSON. Clips only unless `all` (then filler/off-air too).
// Song lines (confirmed works inside a clip) follow their clip line. Their time is inside the
// clip's time, so their lengths are already part of the clip line's length: the "Type" value
// says so, and totals must not add them twice. The work-ID column (ISWC or MusicBrainz ID) is
// added only to exports that have at least one song line.
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function asrunTable(from, to, all) {
    const head = ['Date', 'Start time', 'Duration', 'Title', 'Performer', 'Creators', 'Category', 'Language', 'Rights status', 'Type', 'Folder', 'File'];
    const SONG_KIND = 'Song inside content (its length is included in the content line)';
    const rows = asrunRange(from, to).map(asrunView).filter((r) => all || r.kind === 'clip' || r.kind === 'unknown');
    const withWorks = rows.some((r) => (r.works || []).length);
    const lines = rows.flatMap((r) => [[
        R.metadata.fmtDate(r.date), r.time, R.metadata.fmtHms(r.aired_s), r.title, r.performer, r.songwriters, R.metadata.CATEGORY_LABELS[r.category] || r.category, r.language,
        RIGHTS_LABEL[r.rights] || '', KIND_LABEL[r.kind] || r.kind, r.folder, r.file, ...(withWorks ? [''] : []),
    ], ...(r.works || []).map((w) => {
        // A song that starts after midnight is on the next date.
        const t = hmsToS(r.time) + w.at_s;
        return [
            R.metadata.fmtDate(addDays(r.date, Math.floor(t / 86400))), R.metadata.fmtHms(t % 86400), R.metadata.fmtHms(w.aired_s), w.title, r.performer,
            [w.lyricists && `Lyrics: ${w.lyricists}`, w.composers && `Music: ${w.composers}`, w.others && `Others: ${w.others}`].filter(Boolean).join('; '),
            R.metadata.CATEGORY_LABELS[r.category] || r.category, r.language, RIGHTS_LABEL[r.rights] || '', SONG_KIND, r.folder, r.file, w.work_no,
        ];
    })]);
    return { head: [...head, ...(withWorks ? ['Work ID'] : [])], lines };
}
function asrunCsv(from, to, all) {
    const { head, lines } = asrunTable(from, to, all);
    return '\uFEFF' + [head.join(','), ...lines.map((cells) => cells.map(R.metadata.csvCell).join(','))].join('\r\n') + '\r\n';
}
function asrunJson(from, to, all) {
    const { head, lines } = asrunTable(from, to, all);
    return JSON.stringify({ from, to, columns: head, rows: lines.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']))) }, null, 1);
}


// ---- exports (read by the other modules through R.asrun) ----
R.asrun = module.exports;
Object.assign(module.exports, { stripTags, LOG_LINE, hmsToS, OUTPUT_ERR, maskKeys, outputHealth, engineLogCache, parseEngineLogs, syncAsrun, readAsrunMonth, asrunRange, STORAGE_KIND, asrunView, recentlyAiredIds, RIGHTS_LABEL, KIND_LABEL, addDays, asrunTable, asrunCsv, asrunJson });
Object.defineProperty(module.exports, 'healthCache', { get: () => healthCache, set: (v) => { healthCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'engineAll', { get: () => engineAll, set: (v) => { engineAll = v; }, enumerable: true });
Object.defineProperty(module.exports, 'asrunSynced', { get: () => asrunSynced, set: (v) => { asrunSynced = v; }, enumerable: true });
