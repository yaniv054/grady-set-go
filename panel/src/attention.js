// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const os = require('os');
const R = require('./registry');

// --- thumbnails ------------------------------------------------------------------
let thumbCache = { at: 0, ids: new Set() };
function thumbIds() {
    if (Date.now() - thumbCache.at < 5000) return thumbCache.ids;
    let names = [];
    try { names = fs.readdirSync(R.core.THUMB_DIR); } catch { /* none yet */ }
    thumbCache = { at: Date.now(), ids: new Set(names.map((n) => /^(c[0-9a-f]{15})\.jpg$/.exec(n)?.[1]).filter(Boolean)) };
    return thumbCache.ids;
}
// Serves an image file; the browser keeps it and asks again with If-Modified-Since.
function sendImage(req, res, file, type) {
    const st = fs.statSync(file);
    const lm = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
    if (req.headers['if-modified-since'] === lm) { res.writeHead(304, { 'Last-Modified': lm, 'Cache-Control': 'no-cache' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': type, 'Last-Modified': lm, 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(file));
}
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
// Runs an ffmpeg tool (thumbnails, loudness) at below-normal priority; resolves with its
// exit code and stderr (stdout is ignored).
function runTool(bin, argv, { timeout = 3 * 60e3 } = {}) {
    return new Promise((resolve, reject) => {
        const exe = path.join(R.core.FFMPEG_DIR, bin + (process.platform === 'win32' ? '.exe' : ''));
        const ch = spawn(fs.existsSync(exe) ? exe : bin, argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ }
        let err = '';
        ch.stderr.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
        const timer = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, timeout);
        ch.on('error', (e) => { clearTimeout(timer); reject(e); });
        ch.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: '', stderr: err }); });
    });
}
// One on-demand thumbnail at a time; repeated requests for the same clip share the job.
const thumbJobs = new Map();
let thumbChain = Promise.resolve();
function makeThumb(id) {
    if (thumbJobs.has(id)) return thumbJobs.get(id);
    const row = R.media.rowForId(id);
    if (!row) return Promise.reject(Object.assign(new Error('Clip is not in the library.'), { status: 404 }));
    const mod = path.join(path.dirname(R.core.DEEP_SCAN), 'analyzers', 'thumb.js');
    if (!fs.existsSync(mod)) return Promise.reject(Object.assign(new Error(`Not found: ${mod}`), { status: 404 }));
    const job = thumbChain.then(() => require(mod).run({ file: row.path, row, id, run: runTool, dataDir: R.core.DATA_DIR, force: false }))
        .finally(() => { thumbJobs.delete(id); thumbCache.at = 0; });
    thumbChain = job.catch(() => {});
    thumbJobs.set(id, job);
    return job;
}

// Fills empty title/performer from the metadata suggestions (never overwrites).
function applySuggestions(ids, fields) {
    const want = (Array.isArray(fields) ? fields : ['title', 'performer']).filter((f) => f === 'title' || f === 'performer');
    const store = R.metadata.loadMeta();
    let changed = 0, matched = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
        const sug = R.analysis.analysisIndex().get(id)?.meta?.result;
        if (!sug || !R.media.libraryById().has(id)) continue;
        matched++;
        const cur = store.clips[id] || {};
        const patch = {};
        const fileTitle = String(R.media.libraryById().get(id)[0].file || '').replace(/\.[^.]+$/, '');
        for (const f of want) if (!cur[f] && sug[f] && !(f === 'title' && sug[f] === fileTitle)) patch[f] = sug[f];
        if (Object.keys(patch).length && R.metadata.applyFields(id, R.metadata.cleanFields(patch))) changed++;
    }
    if (changed) {
        R.metadata.backupMeta('before-suggestions');
        R.metadata.saveMeta();
    }
    return { matched, changed };
}

// --- needs attention: problem files, copies, hidden files ------------------------
// data\attention.json keeps the decisions; nothing on the share is changed.
//   hidden:   { "<lower-case path>": { path, id, reason, note, at, whole } }
//             A hidden file is left out of the Library, Generate, the folder browser and
//             the overnight analysis. "whole" = every copy of that clip (problem files);
//             otherwise only that one file (a duplicate copy). A mark applies while the
//             file at that path still has the same content (clip ID): a file replaced by
//             a fixed version shows up again by itself.
//   accepted: { "<item key>": { sig, label, note, at } }
//             "Keep as is" / "Not the same content". The item comes back when what it was
//             accepted for changes (new problem flags, another copy appears...).
const ATTENTION_FILE = path.join(R.core.DATA_DIR, 'attention.json');
const HIDE_REASONS = { duplicate: 'Duplicate', bad: 'Bad file', fix: 'Needs fixing', not_for_air: 'Not for air', other: 'Other' };
// Library scan findings that need a decision (the rest of "issues" is conform information).
const LIB_PROBLEMS = [[/\bunreadable\b/i, 'unreadable'], [/\bzero length\b/i, 'no_duration'], [/\bno video\b/i, 'no_video'], [/\bno audio\b/i, 'no_audio']];
const BAD_PROBLEMS = new Set([...R.analysis.SKIP_FLAGS, 'unreadable', 'no_duration', 'too_short']);
const SAME_LENGTH_MIN_S = 10;
let attn = null, attnVer = 0, attnMtime = 0, attnStatAt = 0;
// Picks up an attention.json changed outside the panel (checked at most every 2 s).
function attnFresh() {
    if (Date.now() - attnStatAt < 2000) return;
    attnStatAt = Date.now();
    let m = 0;
    try { m = fs.statSync(ATTENTION_FILE).mtimeMs; } catch { /* none yet */ }
    if (m !== attnMtime) { attn = null; attnVer++; }
}
function attention() {
    if (attn) return attn;
    try { attnMtime = fs.statSync(ATTENTION_FILE).mtimeMs; } catch { attnMtime = 0; }
    try { attn = JSON.parse(fs.readFileSync(ATTENTION_FILE, 'utf8')); }
    catch (e) {
        // A damaged file is kept aside (never overwritten) before starting empty.
        if (e.code !== 'ENOENT') { try { fs.copyFileSync(ATTENTION_FILE, `${ATTENTION_FILE}.damaged-${Date.now()}`); } catch { /* none */ } }
        attn = {};
    }
    if (!attn || typeof attn !== 'object') attn = {};
    attn.hidden = attn.hidden && typeof attn.hidden === 'object' ? attn.hidden : {};
    attn.accepted = attn.accepted && typeof attn.accepted === 'object' ? attn.accepted : {};
    // Whole file types hidden (e.g. ["mxf"]): every file with that extension, now and later.
    attn.hide_types = Array.isArray(attn.hide_types) ? attn.hide_types.map((t) => String(t).toLowerCase().replace(/^\./, '')).filter((t) => R.core.VIDEO_EXT.has('.' + t)) : [];
    return attn;
}
function saveAttention() {
    R.core.writeJsonAtomic(ATTENTION_FILE, attention(), 1);
    try { attnMtime = fs.statSync(ATTENTION_FILE).mtimeMs; } catch { /* none */ }
    attnVer++;
}
// Lower-case paths that are hidden now, plus the state of every mark.
let hidCache = { key: '' };
function hiddenIndex() {
    attnFresh();
    R.media.library();
    const key = `${R.media.libCache.mtime}|${attnVer}`;
    if (hidCache.key === key) return hidCache;
    const a = attention();
    const paths = new Set(), state = {};
    let rn = null, migrated = false;
    for (const k of Object.keys(a.hidden)) {
        const e = a.hidden[k];
        let row = R.media.library().get(k);
        if (!row) {
            // Renamed by "Change file name": the mark follows the file.
            rn = rn || R.media.renameMap();
            const to = rn.get(k);
            const moved = to && R.media.library().get(to.toLowerCase());
            if (moved && moved.id === e.id && !a.hidden[to.toLowerCase()]) {
                delete a.hidden[k];
                e.path = moved.path;
                a.hidden[to.toLowerCase()] = e;
                row = moved; migrated = true;
                state[to.toLowerCase()] = 'hidden';
                paths.add(to.toLowerCase());
                continue;
            }
        }
        if (!row) state[k] = e.whole && e.id && R.media.libraryById().has(e.id) ? 'moved' : 'missing';
        else if (e.id && row.id !== e.id) state[k] = 'changed';
        else { state[k] = 'hidden'; paths.add(k); }
    }
    // "Whole clip" marks also cover copies found later (same content, another path).
    for (const e of Object.values(a.hidden)) {
        if (!e.whole || !e.id) continue;
        const k = e.path.toLowerCase();
        if (state[k] === 'changed' || state[k] === 'missing') continue;
        for (const r of R.media.libraryById().get(e.id) || []) paths.add(r.path.toLowerCase());
    }
    const types = new Set(a.hide_types.map((t) => '.' + t));
    if (types.size) for (const [k] of R.media.library()) if (types.has(path.extname(k))) paths.add(k);
    if (migrated) { try { saveAttention(); } catch (err) { console.error('attention', err.message); } }
    hidCache = { key: `${R.media.libCache.mtime}|${attnVer}`, paths, state, types };
    return hidCache;
}
const isHiddenIn = (H, p) => { const k = String(p).toLowerCase(); return H.paths.has(k) || H.types.has(path.extname(k)); };
const visibleRows = (rows, H = hiddenIndex()) => rows.filter((r) => !isHiddenIn(H, r.path));
// Clip IDs with no visible copy left (kept with the hidden index it was built from).
function hiddenClipIds() {
    const H = hiddenIndex();
    if (H.clipIds) return H.clipIds;
    const out = new Set();
    for (const [id, rows] of R.media.libraryById()) if (!visibleRows(rows, H).length) out.add(id);
    return (H.clipIds = out);
}

// Which copy to keep: no conform needed, 16:9, not in an old/backup folder, MP4, shortest path.
const OLD_DIR = /(^|[\\/ _-])(old|temp|tmp|backup|bak|copy|archive|ישן|גיבוי|עותק)([\\/ _.-]|$)/i;
function keepScore(r) {
    return (r.needs_conform === 'yes' ? 0 : 8) + (R.media.aspectOf(r.width, r.height) === '16:9' ? 4 : 0)
        + (OLD_DIR.test(path.relative(R.core.MEDIA_ROOT, r.path)) ? 0 : 2) + (/\.mp4$/i.test(r.path) ? 1 : 0);
}
const bestRow = (rows) => rows.slice().sort((a, b) => keepScore(b) - keepScore(a) || a.path.length - b.path.length || a.path.localeCompare(b.path))[0];

function problemsOf(id, rows) {
    const out = new Set();
    for (const f of R.analysis.analysisSummary(id).flags) if (R.analysis.PROBLEM_FLAGS.has(f)) out.add(f);
    const r = rows[0];
    const d = Number(r.duration_s) || 0;
    if (r.error) out.add('unreadable');
    for (const [re, f] of LIB_PROBLEMS) if (re.test(r.issues || '')) out.add(f);
    // "zero length" from the scan also covers clips under a second (e.g. transitions).
    if (d > 0) { out.delete('no_duration'); if (d < 1) out.add('too_short'); }
    else if (!out.has('unreadable')) out.add('no_duration');
    return [...out].sort();
}

// Saved playlists dated `from` or later: fn(date, playlist) for each readable one.
function forEachSavedPlaylist(from, fn) {
    let years = [];
    try { years = fs.readdirSync(R.core.PLAYLISTS_DIR).filter((y) => /^\d{4}$/.test(y) && y >= from.slice(0, 4)); } catch { /* none */ }
    for (const y of years) {
        let months = [];
        try { months = fs.readdirSync(path.join(R.core.PLAYLISTS_DIR, y)).filter((m) => /^\d{2}$/.test(m)); } catch { continue; }
        for (const m of months) {
            let files = [];
            try { files = fs.readdirSync(path.join(R.core.PLAYLISTS_DIR, y, m)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= from); } catch { continue; }
            for (const f of files) {
                let pl;
                try { pl = JSON.parse(fs.readFileSync(path.join(R.core.PLAYLISTS_DIR, y, m, f), 'utf8')); } catch { continue; }
                if (pl && typeof pl === 'object') fn(f.slice(0, 10), pl);
            }
        }
    }
}
// Saved playlists from yesterday on (yesterday's broadcast day can run past midnight)
// that contain hidden files: { lower path: [dates] }. schedVersion changes only when
// the result does.
let schedCache = { key: '', at: 0, map: {}, json: '' }, schedVersion = 0;
function hiddenScheduled() {
    const H = hiddenIndex();
    if (schedCache.key === H.key && Date.now() - schedCache.at < 60000) return schedCache.map;
    const map = {};
    let rn = null;
    forEachSavedPlaylist(R.metadata.yesterday(), (date, pl) => {
        for (const it of pl.program || []) {
            let k = String(it && it.source || '').toLowerCase();
            if (!k) continue;
            // A playlist saved before a rename still names the old path.
            if (!isHiddenIn(H, k)) { rn = rn || R.media.renameMap(); k = String(rn.get(k) || '').toLowerCase(); }
            if (k && isHiddenIn(H, k)) { (map[k] = map[k] || new Set()).add(date); }
        }
    });
    for (const k of Object.keys(map)) map[k] = [...map[k]].sort();
    const json = JSON.stringify(map);
    if (json !== schedCache.json) schedVersion++;
    schedCache = { key: H.key, at: Date.now(), map, json };
    return map;
}

// Clip date: the file date on the share (library.csv "mtime"); for copies the earliest,
// since copying a file can give the copy a newer date.
function madeOf(id) {
    let best = null;
    for (const r of R.media.libraryById().get(id) || []) if (r.mtime && (!best || r.mtime < best)) best = r.mtime;
    return best;
}
// Rebuilt only when the library, the marks, the analysis results, the date, the
// hidden-but-scheduled list or the clip metadata (titles) change.
let attnCache = { key: '', value: null };
function attentionReport() {
    const H = hiddenIndex();
    R.analysis.analysisIndex();
    R.metadata.loadMeta();
    const sched = hiddenScheduled();
    const key = `${H.key}|${R.analysis.an.size}|${R.metadata.today()}|${schedVersion}|${R.metadata.metaMtime}`;
    if (attnCache.key === key) return attnCache.value;
    const date = R.metadata.today();
    const acc = attention().accepted;
    const isAcc = (k, sig) => acc[k] && acc[k].sig === sig;
    const rowView = (r) => ({ path: r.path, folder: r.folder, file: r.file, size: Number(r.size_bytes) || 0, mtime: r.mtime || null, hidden: isHiddenIn(H, r.path) });
    const view = (id, rows) => ({ ...R.metadata.clipView(id, rows, date), made: madeOf(id), all_rows: R.media.libraryById().get(id).map(rowView) });
    const problems = [], copies = [], same = [];
    let accepted = 0;
    const byLen = new Map();
    for (const [id, rows] of R.media.libraryById()) {
        const vis = visibleRows(rows, H);
        if (!vis.length) continue;
        // Problem files
        const flags = problemsOf(id, rows);
        if (flags.length) {
            const k = `p:${id}`, sig = flags.join(',');
            if (isAcc(k, sig)) accepted++;
            else problems.push({ key: k, sig, flags, severity: flags.some((f) => BAD_PROBLEMS.has(f)) ? 'bad' : 'warn', clip: view(id, vis) });
        }
        // Identical copies (same content in more than one place)
        if (vis.length > 1) {
            const k = `c:${id}`, sig = vis.map((r) => r.path.toLowerCase()).sort().join('|');
            if (isAcc(k, sig)) accepted++;
            else copies.push({ key: k, sig, keep: bestRow(vis).path, clip: view(id, vis) });
        }
        // Same length to the millisecond, different file: usually the same video in
        // another format or export (e.g. MXF master + MP4).
        const d = Number(rows[0].duration_s) || 0;
        if (d >= SAME_LENGTH_MIN_S) {
            const lk = d.toFixed(3);
            if (!byLen.has(lk)) byLen.set(lk, []);
            byLen.get(lk).push({ id, vis });
        }
    }
    for (const [lk, list] of byLen) {
        if (list.length < 2) continue;
        const k = `l:${lk}`, sig = list.map((x) => x.id).sort().join(',');
        if (isAcc(k, sig)) { accepted++; continue; }
        const best = bestRow(list.map((x) => bestRow(x.vis)));
        same.push({ key: k, sig, duration: Number(lk), keep: best.id, clips: list.map((x) => view(x.id, x.vis)) });
    }
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
    problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1) || cmp(a.clip.folder, b.clip.folder) || cmp(a.clip.file, b.clip.file));
    copies.sort((a, b) => cmp(a.clip.folder, b.clip.folder) || cmp(a.clip.file, b.clip.file));
    same.sort((a, b) => cmp(a.clips[0].folder, b.clips[0].folder) || cmp(a.clips[0].file, b.clips[0].file));
    // Why each scheduled file is hidden: its own mark (by "path"), a whole-clip mark on
    // another copy ("whole", key = that mark) or a hidden file type ("type").
    const marks = attention().hidden, wholeById = new Map();
    for (const [mk, e] of Object.entries(marks)) if (e.whole && e.id && !['changed', 'missing'].includes(H.state[mk]) && !wholeById.has(e.id)) wholeById.set(e.id, [mk, e]);
    const scheduled = Object.entries(sched).map(([k, dates]) => {
        const e = marks[k];
        const row = R.media.library().get(k);
        const id = row ? row.id : (e && e.id) || null;
        let by = 'type', reason = 'type', key = null;
        if (e && H.state[k] === 'hidden') { by = 'path'; reason = e.reason; key = k; }
        else if (id && wholeById.has(id)) { const [mk, w] = wholeById.get(id); by = 'whole'; reason = w.reason; key = mk; }
        return { path: row ? row.path : (e ? e.path : k), size: row ? Number(row.size_bytes) || 0 : 0, dates, reason, reason_label: HIDE_REASONS[reason] || 'Hidden file type', id, by, key };
    });
    const hidden = Object.entries(attention().hidden).map(([k, e]) => {
        const row = R.media.library().get(k);
        return { key: k, path: e.path, size: row ? Number(row.size_bytes) || 0 : Number(R.media.rowForId(e.id)?.size_bytes) || 0, folder: row ? row.folder : path.relative(R.core.MEDIA_ROOT, path.dirname(e.path)), file: path.basename(e.path), id: e.id || null, reason: e.reason, reason_label: HIDE_REASONS[e.reason] || e.reason, note: e.note || '', at: e.at, whole: !!e.whole, state: H.state[k] || 'missing', thumb: !!(e.id && thumbIds().has(e.id)), made: row ? row.mtime || null : madeOf(e.id) };
    }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const hiddenTypes = attention().hide_types.map((t) => {
        let files = 0, clips = 0;
        for (const [, rows] of R.media.libraryById()) {
            const n = rows.filter((r) => path.extname(r.path).toLowerCase() === '.' + t).length;
            files += n;
            if (n && !visibleRows(rows, H).length && rows.every((r) => path.extname(r.path).toLowerCase() === '.' + t)) clips++;
        }
        return { ext: t, files, clips_only: clips };
    });
    const acceptedList = Object.entries(acc).map(([k, e]) => ({ key: k, kind: k[0], label: e.label || k, note: e.note || '', at: e.at })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const counts = {
        problems: problems.length, problems_bad: problems.filter((p) => p.severity === 'bad').length,
        copies: copies.length, same: same.length, scheduled: scheduled.length,
        hidden: hidden.filter((x) => x.state === 'hidden' || x.state === 'moved').length, hidden_marks: hidden.length, accepted,
    };
    counts.total = counts.problems + counts.copies + counts.same + counts.scheduled;
    const value = { counts, problems, copies, same, scheduled, hidden, hidden_types: hiddenTypes, types_in_library: [...new Set([...R.media.library().keys()].map((k) => path.extname(k).slice(1)))].filter(Boolean).sort(), accepted: acceptedList, reasons: HIDE_REASONS, analysed: R.analysis.analysisStatus().checked, clips: R.media.libraryById().size };
    attnCache = { key, sched, value };
    return value;
}

function hideFiles({ paths = [], ids = [], reason, note = '' }) {
    if (!HIDE_REASONS[reason]) throw Object.assign(new Error('Choose a reason.'), { status: 400 });
    const a = attention();
    const at = new Date().toISOString();
    const n0 = String(note || '').slice(0, 500);
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
        for (const r of R.media.libraryById().get(id) || []) { a.hidden[r.path.toLowerCase()] = { path: r.path, id, reason, note: n0, at, whole: true }; n++; }
    }
    for (const p of Array.isArray(paths) ? paths : []) {
        const r = R.media.library().get(String(p).toLowerCase());
        if (!r) continue;
        a.hidden[r.path.toLowerCase()] = { path: r.path, id: r.id, reason, note: n0, at, whole: false };
        n++;
    }
    if (!n) throw Object.assign(new Error('None of these files is in the library.'), { status: 400 });
    saveAttention();
    return { hidden: n };
}
function setHiddenTypes({ types = [] }) {
    const a = attention();
    a.hide_types = [...new Set((Array.isArray(types) ? types : []).map((t) => String(t).toLowerCase().replace(/^\./, '')).filter((t) => R.core.VIDEO_EXT.has('.' + t)))];
    saveAttention();
    return { hide_types: a.hide_types };
}
function unhideFiles({ keys = [], ids = [] }) {
    const a = attention();
    const want = new Set((Array.isArray(keys) ? keys : []).map((k) => String(k).toLowerCase()));
    const wantIds = new Set(Array.isArray(ids) ? ids : []);
    // Unhiding one "whole clip" mark removes that clip's other whole marks too (otherwise
    // they would keep every copy hidden).
    const wholeIds = new Set();
    for (const [k, e] of Object.entries(a.hidden)) if (want.has(k) && e.whole && e.id) wholeIds.add(e.id);
    let n = 0;
    for (const [k, e] of Object.entries(a.hidden)) if (want.has(k) || (e.id && wantIds.has(e.id)) || (e.whole && e.id && wholeIds.has(e.id))) { delete a.hidden[k]; n++; }
    if (n) saveAttention();
    return { unhidden: n };
}
function acceptItems({ items = [], note = '' }) {
    const a = attention();
    const at = new Date().toISOString();
    let n = 0;
    for (const it of Array.isArray(items) ? items : []) {
        if (!it || !/^[pcl]:[\w.]{1,40}$/.test(String(it.key)) || typeof it.sig !== 'string') continue;
        a.accepted[it.key] = { sig: it.sig.slice(0, 20000), label: String(it.label || '').slice(0, 300), note: String(note || '').slice(0, 500), at };
        n++;
    }
    if (n) saveAttention();
    return { accepted: n };
}
function unacceptItems({ keys = [] }) {
    const a = attention();
    let n = 0;
    for (const k of Array.isArray(keys) ? keys : []) if (a.accepted[k]) { delete a.accepted[k]; n++; }
    if (n) saveAttention();
    return { removed: n };
}

// Opens Windows Explorer with the file selected (to fix, move or delete it by hand).
function revealFile(file) {
    const full = path.resolve(String(file || ''));
    if (!full.toLowerCase().startsWith(R.core.MEDIA_ROOT.toLowerCase() + path.sep)) throw Object.assign(new Error('only files on the media share'), { status: 400 });
    if (!fs.existsSync(full)) throw Object.assign(new Error('File not found: ' + full), { status: 404 });
    // Explorer needs /select,"path" exactly as written, so the argument is passed verbatim.
    const child = spawn('explorer.exe', [`/select,"${full}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
    return { shown: path.basename(full) };
}


// ---- exports (read by the other modules through R.attention) ----
R.attention = module.exports;
Object.assign(module.exports, { thumbIds, sendImage, IMAGE_TYPES, runTool, thumbJobs, makeThumb, applySuggestions, ATTENTION_FILE, HIDE_REASONS, LIB_PROBLEMS, BAD_PROBLEMS, SAME_LENGTH_MIN_S, attnFresh, attention, saveAttention, hiddenIndex, isHiddenIn, visibleRows, hiddenClipIds, OLD_DIR, keepScore, bestRow, problemsOf, forEachSavedPlaylist, hiddenScheduled, madeOf, attentionReport, hideFiles, setHiddenTypes, unhideFiles, acceptItems, unacceptItems, revealFile });
Object.defineProperty(module.exports, 'thumbCache', { get: () => thumbCache, set: (v) => { thumbCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'thumbChain', { get: () => thumbChain, set: (v) => { thumbChain = v; }, enumerable: true });
Object.defineProperty(module.exports, 'attn', { get: () => attn, set: (v) => { attn = v; }, enumerable: true });
Object.defineProperty(module.exports, 'attnVer', { get: () => attnVer, set: (v) => { attnVer = v; }, enumerable: true });
Object.defineProperty(module.exports, 'attnMtime', { get: () => attnMtime, set: (v) => { attnMtime = v; }, enumerable: true });
Object.defineProperty(module.exports, 'attnStatAt', { get: () => attnStatAt, set: (v) => { attnStatAt = v; }, enumerable: true });
Object.defineProperty(module.exports, 'hidCache', { get: () => hidCache, set: (v) => { hidCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'schedCache', { get: () => schedCache, set: (v) => { schedCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'schedVersion', { get: () => schedVersion, set: (v) => { schedVersion = v; }, enumerable: true });
Object.defineProperty(module.exports, 'attnCache', { get: () => attnCache, set: (v) => { attnCache = v; }, enumerable: true });
