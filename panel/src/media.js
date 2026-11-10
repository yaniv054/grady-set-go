// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const R = require('./registry');

// --- media share (read-only) ------------------------------------------------

// A clip's ID is a fingerprint of its content (file size + duration), not its path,
// so metadata survives moving or renaming files on the share, and duplicate copies
// of the same file share one record. The "c" prefix keeps Excel from reading an ID
// as a number.
const clipId = (row) => 'c' + crypto.createHash('sha1').update(`${row.size_bytes}:${Number(row.duration_s || 0).toFixed(3)}`).digest('hex').slice(0, 15);

// Files renamed by the former "Change file name" check (removed 2026-11-01; the share is
// read-only) before the last library scan that saw them: the log
// (data\analysis\renames.jsonl, undo lines included) gives each original path's current name.
const RENAMES_LOG = path.join(R.core.DATA_DIR, 'analysis', 'renames.jsonl');
function renameMap() {
    const cur = new Map(), byValue = new Map();
    let text = '';
    try { text = fs.readFileSync(RENAMES_LOG, 'utf8'); } catch { return cur; }
    for (const line of text.split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (!e || !e.from || !e.to) continue;
        const from = e.from.toLowerCase();
        for (const k of byValue.get(from) || []) { cur.set(k, e.to); }
        const moved = byValue.get(from) || new Set();
        byValue.delete(from);
        if (!cur.has(from)) { cur.set(from, e.to); moved.add(from); }
        const tl = e.to.toLowerCase();
        byValue.set(tl, new Set([...(byValue.get(tl) || []), ...moved]));
    }
    return cur;
}

// Re-read when library.csv or the rename log changes (checked at most once a second).
// A file that fails to parse is reported once and not retried until it changes again.
let libCache = { mtime: 0, byPath: new Map(), byId: new Map() }, libChecked = 0, libFailedKey = '';
function library() {
    if (Date.now() - libChecked < 1000) return libCache.byPath;
    libChecked = Date.now();
    let key, rn = 0;
    try {
        const st = fs.statSync(R.core.LIBRARY_CSV);
        try { rn = fs.statSync(RENAMES_LOG).mtimeMs; } catch { /* no renames */ }
        key = st.mtimeMs + ':' + rn;
    } catch { return libCache.byPath; /* no library yet */ }
    if (key === libCache.mtime || key === libFailedKey) return libCache.byPath;
    try {
        const rows = R.library.parseCsv(fs.readFileSync(R.core.LIBRARY_CSV, 'utf8'));
        const renamed = rn ? renameMap() : new Map();
        const byId = new Map();
        for (const r of rows) {
            const now = renamed.get(String(r.path).toLowerCase());
            if (now && now !== r.path) { r.path = now; r.file = path.basename(now); }
            r.id = clipId(r);
            if (!byId.has(r.id)) byId.set(r.id, []);
            byId.get(r.id).push(r);
        }
        libCache = { mtime: key, byPath: new Map(rows.map((r) => [r.path.toLowerCase(), r])), byId };
        libFailedKey = '';
        rememberPaths(rows);
    } catch (e) { libFailedKey = key; console.error(`library.csv could not be read (${e.message}); keeping the previous list.`); }
    return libCache.byPath;
}

// Path history: every path ever seen in library.csv with its clip ID, kept in
// data\path-history.json. When a file is renamed or moved on the share, its old path
// (still used by saved playlists and the as-run archive) leads to the clip ID, and the
// ID leads to the file's current path.
const PATH_HISTORY = path.join(R.core.DATA_DIR, 'path-history.json');
let pathHist = null;
function pathHistory() {
    if (!pathHist) { try { pathHist = JSON.parse(fs.readFileSync(PATH_HISTORY, 'utf8')); } catch { pathHist = {}; } }
    return pathHist;
}
function rememberPaths(rows) {
    const hist = pathHistory();
    let changed = false;
    for (const r of rows) {
        const k = r.path.toLowerCase();
        if (!hist[k] || hist[k].id !== r.id) { hist[k] = { path: r.path, id: r.id }; changed = true; }
    }
    if (!changed) return;
    try { R.core.writeJsonAtomic(PATH_HISTORY, hist); }
    catch (e) { console.error('path history', e.message); }
}
// Clip ID for a path: current library first, then the path history.
const idForPath = (p) => { const k = String(p).toLowerCase(); return library().get(k)?.id || pathHistory()[k]?.id || null; };
// Library row for a clip ID (first copy), or null if the clip is no longer on the share.
const rowForId = (id) => (id && libraryById().get(id)?.[0]) || null;

// Saved playlist sources that are no longer on the share: maps each one that was only
// renamed/moved to its current path; the rest are reported as missing.
function resolveSources(sources) {
    const map = {}, missing = [];
    for (const src of Array.isArray(sources) ? sources : []) {
        const s = String(src || '');
        if (!s || R.asrun.STORAGE_KIND(s) || library().has(s.toLowerCase())) continue;
        const row = rowForId(pathHistory()[s.toLowerCase()]?.id);
        if (row && row.path.toLowerCase() !== s.toLowerCase()) map[s] = row.path;
        else missing.push(s);
    }
    return { map, missing };
}
const libraryById = () => { library(); return libCache.byId; };
const probed = new Map();

function mediaPath(rel) {
    const clean = String(rel || '').replace(/^[\\/]+/, '');
    // Windows drops trailing dots and spaces, so ". ." or "..." act like "." / "..".
    if (clean.split(/[\\/]/).some((c) => c && !c.replace(/[. ]+$/, ''))) throw Object.assign(new Error('bad path'), { status: 400 });
    // path.resolve() keeps a trailing separator on a UNC share root; strip it so
    // prefix comparisons against library paths work at the top level too.
    const full = path.resolve(R.core.MEDIA_ROOT, clean).replace(/[\\/]+$/, '');
    if (full !== R.core.MEDIA_ROOT && !full.toLowerCase().startsWith(R.core.MEDIA_ROOT.toLowerCase() + path.sep)) throw Object.assign(new Error('outside media root'), { status: 400 });
    return full;
}

// Picture shape from the stored size. 720x576/480 SD files may be 4:3 or 16:9 (pixel
// aspect is not in library.csv), so they get their own label.
function aspectOf(w, h) {
    w = Number(w) || 0; h = Number(h) || 0;
    if (!w || !h) return '';
    if ((w === 720 || w === 704) && (h === 576 || h === 480)) return 'sd';
    const r = w / h;
    if (r < 0.9) return 'vertical';
    if (r < 1.1) return 'square';
    if (Math.abs(r - 16 / 9) < 0.03) return '16:9';
    if (Math.abs(r - 4 / 3) < 0.03) return '4:3';
    return 'other';
}
function fileInfo(full) {
    const row = library().get(full.toLowerCase()) || probed.get(full.toLowerCase());
    if (!row) return { duration: null };
    // A library row without a usable length falls back to an on-demand probe of the file.
    const pr = probed.get(full.toLowerCase());
    return {
        id: row.id || null,
        duration: Number(row.duration_s) || (pr && Number(pr.duration_s)) || null,
        res: row.width ? `${row.width}x${row.height}` : '',
        fps: row.fps ? Number(row.fps) : null,
        conform: row.needs_conform === 'yes',
        aspect: aspectOf(row.width, row.height),
        issues: row.issues || '',
        lufs: row.integrated_lufs || '',
    };
}

// Format filter: a list like ["mp4","mov"] -> Set of ".mp4", ".mov" (only known video
// extensions). Empty or missing means every video format.
function extFilter(list) {
    const set = new Set((Array.isArray(list) ? list : String(list || '').split(','))
        .map((e) => '.' + String(e).trim().toLowerCase().replace(/^\./, ''))
        .filter((e) => R.core.VIDEO_EXT.has(e)));
    return set.size ? set : R.core.VIDEO_EXT;
}

// Library rows under a share folder (recursive), filtered by format and flags.
function libraryRows(dir, exts = R.core.VIDEO_EXT) {
    const prefix = dir.toLowerCase() + path.sep;
    const out = [];
    for (const [key, row] of library()) {
        if ((key.startsWith(prefix) || dir === R.core.MEDIA_ROOT) && exts.has(path.extname(key))) out.push(row);
    }
    return out;
}

// Clip totals for a selection of folders (de-duplicated if folders overlap).
function countSelection({ folders = [], extensions = [], skip_flagged = false, require_cleared = false, date = '', skip_issues = false, only_169 = false }) {
    const exts = extFilter(extensions);
    const seen = new Map(), paths = new Set();
    // Keyed by clip ID: duplicate copies in different folders count once; overlapping
    // folders list the same file once.
    let hiddenN = 0;
    const H = R.attention.hiddenIndex();
    for (const rel of folders) for (const row of libraryRows(mediaPath(rel), exts)) {
        const k = row.path.toLowerCase();
        if (paths.has(k)) continue;
        paths.add(k);
        if (R.attention.isHiddenIn(H, row.path)) { hiddenN++; continue; }
        if (!seen.has(row.id)) seen.set(row.id, row);
    }
    let clips = 0, seconds = 0, flagged = 0, noDuration = 0, notCleared = 0, issues = 0, notWide = 0;
    const byFormat = {};
    for (const row of seen.values()) {
        const d = Number(row.duration_s) || 0;
        if (d < 1) { noDuration++; continue; }
        if (only_169 && aspectOf(row.width, row.height) !== '16:9') { notWide++; continue; }
        if (row.needs_conform === 'yes') { flagged++; if (skip_flagged) continue; }
        if (!R.metadata.isCleared(R.metadata.metaOf(row.id), date || R.metadata.today())) { notCleared++; if (require_cleared) continue; }
        if (skip_issues && R.analysis.hasSkipIssue(row.id)) { issues++; continue; }
        clips++;
        seconds += d;
        const ext = path.extname(row.path).toLowerCase().slice(1);
        byFormat[ext] = (byFormat[ext] || 0) + 1;
    }
    return { clips, hours: Number((seconds / 3600).toFixed(1)), flagged, skipped_flagged: skip_flagged ? flagged : 0, no_duration: noDuration, not_cleared: notCleared, skipped_rights: require_cleared ? notCleared : 0, skipped_issues: issues, skipped_hidden: hiddenN, skipped_not_169: notWide, by_format: byFormat };
}

// Open a file in VLC on this PC (the panel only listens on 127.0.0.1). Read-only:
// VLC just plays the file. Only video files on the share or in ffplayout storage.
// start/stop (seconds, optional): play only that part (e.g. one song inside a concert).
// Each play gets its own VLC process (a long-running single instance stalls after many hand-overs);
// the previous VLC the panel opened is closed first, so only one panel VLC window is open at a time.
// A song (start/stop given) closes VLC at its end.
const vlcArgs = (full, range = []) => ['--no-one-instance', ...(range.some((o) => o.startsWith('stop-time')) ? ['--play-and-exit'] : []), full, ...range.map((o) => `:${o}`)];
let vlcChild = null;
function closePanelVlc() {
    const c = vlcChild;
    vlcChild = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    try { c.kill(); } catch { /* already gone */ }
}
function playInVlc(file, start, stop) {
    const full = path.resolve(String(file || ''));
    const low = full.toLowerCase();
    const inside = (root) => low.startsWith(root.toLowerCase() + path.sep);
    if (!(inside(R.core.MEDIA_ROOT) || inside(R.core.STORAGE_ROOT)) || !R.core.VIDEO_EXT.has(path.extname(low))) throw Object.assign(new Error('only video files on the media share or in storage can be played'), { status: 400 });
    if (!fs.existsSync(R.core.VLC)) throw Object.assign(new Error('VLC not found at ' + R.core.VLC), { status: 404 });
    const a = Number(start), b = Number(stop);
    const range = [];
    if (Number.isFinite(a) && a > 0) range.push(`start-time=${a.toFixed(1)}`);
    if (Number.isFinite(b) && b > 0 && (!(a > 0) || b > a)) range.push(`stop-time=${b.toFixed(1)}`);
    // Per-file options (":start-time=" after the path) apply to this file only.
    closePanelVlc();
    const child = spawn(R.core.VLC, vlcArgs(full, range), { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.on('exit', () => { if (vlcChild === child) vlcChild = null; });
    child.unref();
    vlcChild = child;
    return { playing: path.basename(full) };
}

async function browseMedia(rel, exts = R.core.VIDEO_EXT) {
    const dir = mediaPath(rel);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const folders = [], files = [], extCounts = {}, folderCounts = {};
    let hidden = 0, hiddenMarked = 0;
    const H = R.attention.hiddenIndex();
    for (const e of entries) {
        if (e.isDirectory()) { if (!R.core.isSystemDir(e.name)) folders.push(e.name); }
        else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (!R.core.VIDEO_EXT.has(ext)) continue;
            extCounts[ext.slice(1)] = (extCounts[ext.slice(1)] || 0) + 1;
            if (!exts.has(ext)) { hidden++; continue; }
            const full = path.join(dir, e.name);
            if (R.attention.isHiddenIn(H, full)) { hiddenMarked++; continue; }
            files.push({ name: e.name, path: full, ...fileInfo(full) });
        }
    }
    // Per-subfolder clip counts (recursive, current format filter) from library.csv.
    const prefix = dir.toLowerCase() + path.sep;
    const wanted = new Map(folders.map((f) => [f.toLowerCase(), f]));
    for (const [key, row] of library()) {
        if (!key.startsWith(prefix) || !exts.has(path.extname(key))) continue;
        const first = wanted.get(key.slice(prefix.length).split(path.sep)[0]);
        if (!first || !key.slice(prefix.length).includes(path.sep)) continue;
        const c = folderCounts[first] || (folderCounts[first] = { clips: 0, hours: 0 });
        c.clips++;
        c.hours += (Number(row.duration_s) || 0) / 3600;
    }
    for (const c of Object.values(folderCounts)) c.hours = Number(c.hours.toFixed(1));
    const cmp = new Intl.Collator(undefined, { numeric: true }).compare;
    folders.sort(cmp); files.sort((a, b) => cmp(a.name, b.name));
    return { root: R.core.MEDIA_ROOT, path: path.relative(R.core.MEDIA_ROOT, dir).split(path.sep).join('/'), folders, files, ext_counts: extCounts, hidden_by_format: hidden, hidden_marked: hiddenMarked, folder_counts: folderCounts };
}

// Library-wide counts per format (from library.csv), for the filter chips.
function formatCounts() {
    const counts = {};
    for (const row of library().values()) {
        const ext = path.extname(row.path).toLowerCase().slice(1);
        if (!counts[ext]) counts[ext] = { files: 0, hours: 0 };
        counts[ext].files++;
        counts[ext].hours += (Number(row.duration_s) || 0) / 3600;
    }
    for (const c of Object.values(counts)) c.hours = Number(c.hours.toFixed(1));
    return { supported: [...R.core.VIDEO_EXT].map((e) => e.slice(1)), counts };
}

function probeMedia(full) {
    return new Promise((resolve) => {
        execFile(R.core.FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate', '-of', 'json', full],
            { timeout: 60000, windowsHide: true }, (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const j = JSON.parse(stdout);
                    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
                    const [a, b] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
                    const row = { duration_s: j.format.duration, width: v.width || '', height: v.height || '', fps: b ? (a / b).toFixed(3) : '' };
                    probed.set(full.toLowerCase(), row);
                    resolve(row);
                } catch { resolve(null); }
            });
    });
}

// At most two on-demand probes at a time; the rest wait their turn.
let probeActive = 0;
const probeWaiting = [];
async function probeLimited(full) {
    if (probeActive >= 2) await new Promise((r) => probeWaiting.push(r));
    probeActive++;
    try { return await probeMedia(full); } finally { probeActive--; probeWaiting.shift()?.(); }
}

async function walkMedia(dir, out) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!R.core.isSystemDir(e.name)) await walkMedia(full, out); }
        else if (e.isFile() && R.core.VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
}

// Builds a program from library clips using library.csv durations.
//
// Pool: the ticked share folders, or (with a template) every library clip whose
// category is in the template. Filters: format, flagged, rights (require_cleared on
// `date`), duplicates (one copy per clip ID).
// Order: shuffle deals clips like a deck (every clip once before any repeats). Clips in
// `avoid` (used earlier in a batch) and clips aired in the last `no_repeat_days` days
// (from the as-run archive) go to the bottom of the first deck, so they're used only if
// nothing else fits. With `artist_gap_s`, a clip whose artist played less than that many
// seconds earlier in this program is passed over when another clip fits. A template
// picks the category that is furthest behind its weight share (by time) at each step.
// The last clip is trimmed to fit the length exactly.
function shuffled(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

// Artist for separation: the performer if set, otherwise the first two folder levels
// (e.g. "Series\Season 1"); clips directly in a top folder have none.
function artistOf(row, meta) {
    const p = String(meta.performer || '').trim().toLowerCase();
    if (p) return 'p:' + p;
    const parts = String(row.folder || '').split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? 'f:' + parts.slice(0, 2).join('/').toLowerCase() : null;
}

async function generateFromMedia({ folders = [], shuffle = true, length_s = 86400, skip_flagged = false, extensions = [], require_cleared = false, date = '', avoid = [], template = null, no_repeat_days = 0, artist_gap_s = 0, skip_issues = false, only_169 = false, branding = false, start_s = 0, day_start_s = 0, branding_set = '', after_block = false }) {
    const exts = extFilter(extensions);
    // Branding set for the inserted items: '' = Default, 'none' = no automatic branding, or a named set.
    branding_set = String(branding_set ?? '');
    if (branding_set && branding_set !== 'none') R.branding.checkSetName(branding_set);
    const day = R.metadata.normDate(date) || R.metadata.today();
    const files = [];
    const tpl = template && Array.isArray(template.items)
        ? template.items.map((t) => ({ category: String(t.category || ''), weight: Math.max(0, Number(t.weight) || 0) })).filter((t) => t.category && t.weight > 0)
        : null;
    if (tpl && !tpl.length) throw Object.assign(new Error('The template has no categories with a weight.'), { status: 400 });
    if (tpl) { for (const r of library().values()) files.push(r.path); }
    else for (const rel of folders) await walkMedia(mediaPath(rel), files);
    const cmp = new Intl.Collator(undefined, { numeric: true }).compare;
    // Overlapping folders (a folder and its subfolder) list a file once.
    const seenPath = new Set();
    files.splice(0, files.length, ...files.filter((f) => { const k = f.toLowerCase(); if (seenPath.has(k)) return false; seenPath.add(k); return true; }));
    files.sort(cmp);
    const H = R.attention.hiddenIndex();
    let noDuration = 0, flagged = 0, wrongFormat = 0, notCleared = 0, duplicates = 0, noCategory = 0, badClips = 0, notWide = 0, hiddenN = 0;
    const pool = [];
    const ids = new Set();
    const tplCats = tpl ? new Set(tpl.map((t) => t.category)) : null;
    for (const f of files) {
        if (!exts.has(path.extname(f).toLowerCase())) { wrongFormat++; continue; }
        if (R.attention.isHiddenIn(H, f)) { hiddenN++; continue; }
        const info = fileInfo(f);
        if (!info.duration || info.duration < 1) { noDuration++; continue; }
        if (skip_flagged && info.conform) { flagged++; continue; }
        if (only_169 && info.aspect !== '16:9') { notWide++; continue; }
        const m = R.metadata.metaOf(info.id);
        if (require_cleared && !R.metadata.isCleared(m, day)) { notCleared++; continue; }
        if (tplCats && !tplCats.has(m.category)) { noCategory++; continue; }
        if (skip_issues && R.analysis.hasSkipIssue(info.id)) { badClips++; continue; }
        if (info.id) { if (ids.has(info.id)) { duplicates++; continue; } ids.add(info.id); }
        const row = library().get(f.toLowerCase()) || { folder: '' };
        pool.push({ source: f, duration: info.duration, id: info.id, category: m.category, artist: artistOf(row, m), explicit: m.explicit === 'yes' });
    }
    // Soft avoid: earlier days of a batch, and clips aired recently.
    const avoidSet = new Set((Array.isArray(avoid) ? avoid : []).map((a) => String(a).toLowerCase()));
    let recentAired = 0;
    if (no_repeat_days > 0) {
        const recent = R.asrun.recentlyAiredIds(day, Number(no_repeat_days));
        for (const p of pool) if (p.id && recent.has(p.id)) { avoidSet.add(p.source.toLowerCase()); recentAired++; }
    }
    const deckOf = (items) => {
        if (!shuffle) return items.slice();
        const fresh = items.filter((p) => !avoidSet.has(p.source.toLowerCase()));
        const used = items.filter((p) => avoidSet.has(p.source.toLowerCase()));
        return [...shuffled(fresh), ...shuffled(used)];
    };
    const groups = tpl ? tpl.map((t) => ({ ...t, items: pool.filter((p) => p.category === t.category) })).filter((g) => g.items.length) : [{ weight: 1, items: pool }];
    for (const g of groups) { g.deck = deckOf(g.items); g.i = 0; g.played = 0; }
    const totalW = groups.reduce((s, g) => s + g.weight, 0);
    const lastArtistAt = new Map();
    const program = [];
    const playedIds = new Set();
    let total = 0, last = null, repeats = 0;
    // Branding rules (Channel Branding page): inserted while the day is built. The
    // explicit-clip window applies even when no branding items are inserted.
    const brandRules = R.branding.readBrandRules();
    const rules = branding && branding_set !== 'none' ? brandRules : null;
    const tod = () => ((Number(start_s) || 0) + total) % 86400;
    const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null; };
    const exAfter = hm(brandRules.explicit_after), ds = Number(day_start_s) || 0;
    // Explicit clips may air from exAfter until the broadcast day starts again.
    const explicitOk = () => {
        if (exAfter === null) return true;
        const t = tod();
        return exAfter > ds ? (t >= exAfter || t < ds) : (t >= exAfter && t < ds);
    };
    // Outside the explicit window with only explicit clips left: repeat an allowed clip
    // (this group first, then any group); none at all = stop and leave the rest to filler.
    const allowedRepeat = (g) => {
        let alt = g.items.filter((p) => !p.explicit);
        if (!alt.length) alt = groups.flatMap((x) => x.items.filter((p) => !p.explicit));
        return alt.length ? alt[Math.floor(Math.random() * alt.length)] : null;
    };
    const take = (g) => {
        const exOk = explicitOk();
        const okEx = (p) => exOk || !p.explicit;
        if (!shuffle) {
            const n = g.items.length;
            for (let j = 0; j < n; j++) { const p = g.items[(g.i + j) % n]; if (okEx(p)) { g.i += j + 1; return p; } }
            return allowedRepeat(g);
        }
        if (!g.deck.length) {
            g.deck = shuffled(g.items.slice());
            if (g.deck.length > 1 && g.deck[0] === last) g.deck.push(g.deck.shift());
        }
        const okArtist = (p) => artist_gap_s <= 0 || !p.artist || !lastArtistAt.has(p.artist) || total - lastArtistAt.get(p.artist) >= artist_gap_s;
        let k = g.deck.findIndex((p) => okEx(p) && okArtist(p));
        if (k < 0) k = g.deck.findIndex(okEx);
        if (k < 0 && !exOk) return allowedRepeat(g);
        if (k < 0) k = 0;
        return g.deck.splice(k, 1)[0];
    };
    const bpool = {}, bidx = {}, brandMissing = new Set();
    let brandItems = 0, brandSecs = 0, lastIdentAt = 0, lastHour = null, prevShort = false;
    // Right after a pinned block (after_block) the first position gets no ident: the hour
    // counts as already marked, and "every N minutes" counts from here.
    if (after_block) lastHour = Math.floor((Number(start_s) || 0) / 3600);
    const pick = (type) => {
        if (!bpool[type]) bpool[type] = shuffled(R.branding.brandPool(type, branding_set));
        const p = bpool[type];
        if (!p.length) { brandMissing.add(type); return null; }
        bidx[type] = ((bidx[type] ?? -1) + 1) % p.length;
        return p[bidx[type]];
    };
    const pushBrand = (type) => {
        const b = pick(type);
        if (!b || total + b.duration > length_s) return false;
        program.push({ in: 0, out: Number(b.duration.toFixed(3)), duration: b.duration, source: b.source });
        total += b.duration; brandItems++; brandSecs += b.duration;
        return true;
    };
    if (groups.length) {
        while (total < length_s && program.length < 20000) {
            // The group furthest behind its share of the time so far (one group without a template).
            let g = groups[0];
            if (groups.length > 1) {
                let best = -Infinity;
                for (const c of groups) { const d = (c.weight / totalW) * (total + 1) - c.played; if (d > best) { best = d; g = c; } }
            }
            const it = take(g);
            if (!it) break;
            last = it;
            const concert = rules && rules.concert_wrap && R.metadata.CONCERT_CATEGORIES.has(it.category);
            if (rules) {
                const hour = Math.floor(((Number(start_s) || 0) + total) / 3600);
                let branded = false;
                // One branding item between two clips: hourly ident, else an ident when the
                // last one is ident_every_min ago, else a stinger between two short clips.
                if (rules.hourly_ident && (lastHour === null || hour > lastHour)) branded = pushBrand('ident');
                else if (rules.ident_every_min > 0 && program.length && total - lastIdentAt >= rules.ident_every_min * 60) branded = pushBrand('ident');
                if (branded) lastIdentAt = total;
                else if (rules.stingers && prevShort && it.duration <= rules.stinger_max_clip_min * 60) pushBrand('stinger');
                lastHour = hour;
                if (rules.upnext_min_clip_min > 0 && it.duration >= rules.upnext_min_clip_min * 60) pushBrand('upnext');
                if (concert) pushBrand('opener');
                if (rules.advisory && it.explicit) pushBrand('advisory');
                if (length_s - total < 1) break;
            }
            const out = Math.min(it.duration, length_s - total);
            program.push({ in: 0, out: Number(out.toFixed(3)), duration: it.duration, source: it.source });
            const key = it.id || it.source;
            if (playedIds.has(key)) repeats++; else playedIds.add(key);
            if (it.artist) lastArtistAt.set(it.artist, total);
            total += out;
            g.played += out;
            if (rules) {
                prevShort = it.duration <= rules.stinger_max_clip_min * 60;
                if (concert && out >= it.duration - 0.01) pushBrand('closer');
            }
        }
    }
    const byCategory = tpl ? Object.fromEntries(groups.map((g) => [g.category, { clips: g.items.length, seconds: Math.round(g.played) }])) : null;
    const missing = tpl ? tpl.filter((t) => !groups.some((g) => g.category === t.category)).map((t) => t.category) : [];
    return { program, files: files.length, usable: pool.length, skipped_format: wrongFormat, skipped_no_duration: noDuration, skipped_flagged: flagged, skipped_rights: notCleared, skipped_duplicates: duplicates, skipped_no_category: noCategory, skipped_issues: badClips, skipped_not_169: notWide, skipped_hidden: hiddenN, recently_aired: recentAired, by_category: byCategory, missing_categories: missing, formats: [...exts].map((e) => e.slice(1)), total, repeats, pool_s: Math.round(pool.reduce((s, p) => s + p.duration, 0)), brand_items: brandItems, brand_s: Math.round(brandSecs), brand_missing: [...brandMissing], branding_set };
}


// ---- exports (read by the other modules through R.media) ----
R.media = module.exports;
Object.assign(module.exports, { clipId, RENAMES_LOG, renameMap, library, PATH_HISTORY, pathHistory, rememberPaths, idForPath, rowForId, resolveSources, libraryById, probed, mediaPath, aspectOf, fileInfo, extFilter, libraryRows, countSelection, vlcArgs, closePanelVlc, playInVlc, browseMedia, formatCounts, probeMedia, probeWaiting, probeLimited, walkMedia, shuffled, artistOf, generateFromMedia });
Object.defineProperty(module.exports, 'libCache', { get: () => libCache, set: (v) => { libCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'libChecked', { get: () => libChecked, set: (v) => { libChecked = v; }, enumerable: true });
Object.defineProperty(module.exports, 'libFailedKey', { get: () => libFailedKey, set: (v) => { libFailedKey = v; }, enumerable: true });
Object.defineProperty(module.exports, 'pathHist', { get: () => pathHist, set: (v) => { pathHist = v; }, enumerable: true });
Object.defineProperty(module.exports, 'vlcChild', { get: () => vlcChild, set: (v) => { vlcChild = v; }, enumerable: true });
Object.defineProperty(module.exports, 'probeActive', { get: () => probeActive, set: (v) => { probeActive = v; }, enumerable: true });
