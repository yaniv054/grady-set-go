// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const R = require('./registry');

// --- undo ---------------------------------------------------------------------------------
// Actions that change data with one click are recorded in data\undo.json so they can be
// undone (toast "Undo" for 15 s, and the "Undo…" list per browser session).
//   JSON stores (attention marks, clip details, songs, blocks, occasions, block marks,
//   settings): the changed entries are stored with their previous and new value. Undo puts
//   the previous value back only if the entry still has the new value (nothing newer
//   changed it); otherwise it refuses and says why.
//   Files (branding, logo, release documents): files are only ever moved aside; undo moves
//   them back if nothing replaced them since.
//   Playlists (saved through ffplayout): the day's previous file is kept in
//   playlists\_previous\YYYY-MM-DD-<time>.json; undo moves the current file there too and
//   copies the previous one back, if the day was not saved again since.
// The newest 100 entries are kept in undo.json; older ones go to undo-archive.jsonl.
// Stream keys never pass through here (ffplayout's own config is not recorded).
const UNDO_FILE = path.join(R.core.DATA_DIR, 'undo.json');
const UNDO_ARCHIVE = path.join(R.core.DATA_DIR, 'undo-archive.jsonl');
const PLAYLISTS_PREV = path.join(R.core.PLAYLISTS_DIR, '_previous');
const UNDO_KEEP = 100;
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const idArray = (a) => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');
// Changes between two versions of a JSON store, down to `depth` levels; arrays of objects
// with an id are compared by id (so a removed block is one change, not a shifted list).
function diffJson(a, b, p, out, depth) {
    if (deepEq(a, b)) return out;
    if (depth > 0 && isObj(a) && isObj(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffJson(a[k], b[k], [...p, k], out, depth - 1);
        return out;
    }
    if (depth > 0 && idArray(a) && idArray(b)) {
        const ids = new Set([...a.map((x) => x.id), ...b.map((x) => x.id)]);
        for (const id of ids) {
            const i = a.findIndex((x) => x.id === id);
            const before = i >= 0 ? a[i] : undefined, after = b.find((x) => x.id === id);
            if (deepEq(before, after)) continue;
            out.push({ path: [...p, { id }], before, after, index: i >= 0 ? i : null });
        }
        return out;
    }
    out.push({ path: p, before: a, after: b });
    return out;
}
function getAt(doc, p) {
    let cur = doc;
    for (const seg of p) {
        if (cur === undefined || cur === null) return undefined;
        cur = typeof seg === 'object' ? (Array.isArray(cur) ? cur.find((x) => x && x.id === seg.id) : undefined) : cur[seg];
    }
    return cur;
}
function setAt(doc, p, value, index) {
    let cur = doc;
    for (let i = 0; i < p.length - 1; i++) {
        const seg = p[i];
        const nextIsId = typeof p[i + 1] === 'object';
        if (typeof seg === 'object') cur = cur.find((x) => x && x.id === seg.id);
        else { if (cur[seg] === undefined || cur[seg] === null) cur[seg] = nextIsId ? [] : {}; cur = cur[seg]; }
    }
    const last = p.at(-1);
    if (typeof last === 'object') {
        const i = cur.findIndex((x) => x && x.id === last.id);
        if (value === undefined) { if (i >= 0) cur.splice(i, 1); }
        else if (i >= 0) cur[i] = value;
        else cur.splice(Math.min(index ?? cur.length, cur.length), 0, value);
    } else if (value === undefined) delete cur[last];
    else cur[last] = value;
}
const pathText = (p) => p.map((s) => (typeof s === 'object' ? s.id : s)).join(' › ');
function readJsonLoose(file) {
    let t;
    try { t = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { missing: true, doc: undefined }; throw e; }
    try { return { doc: JSON.parse(t.replace(/^﻿/, '')) }; } catch { return { damaged: true }; }
}
let undoMem = null;
function undoStore() {
    if (undoMem) return undoMem;
    const r = readJsonLoose(UNDO_FILE);
    if (r.damaged) { try { fs.copyFileSync(UNDO_FILE, `${UNDO_FILE}.damaged-${Date.now()}`); } catch { /* none */ } }
    undoMem = r.doc && Array.isArray(r.doc.entries) ? r.doc : { version: 1, entries: [] };
    return undoMem;
}
function saveUndo() {
    const s = undoStore();
    if (s.entries.length > UNDO_KEEP) {
        const old = s.entries.splice(0, s.entries.length - UNDO_KEEP);
        try { fs.appendFileSync(UNDO_ARCHIVE, old.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'); } catch (e) { console.error('undo archive', e.message); }
    }
    R.core.writeJsonAtomic(UNDO_FILE, s);
}
// Fingerprint of a file for "was it changed afterwards" checks. Small files (playlists,
// the logo) are hashed whole; large ones (branding videos, up to 4 GB) by size plus the
// first and last 1 MB, so opening the Undo list never reads gigabytes on the event loop.
// Entries written by earlier versions hold a full-file sha1 and still compare correctly
// because the full hash is kept for files up to the sample size.
const HASH_SAMPLE = 1024 * 1024;
const fileHash = (f) => {
    try {
        const st = fs.statSync(f);
        const h = crypto.createHash('sha1');
        if (st.size <= 2 * HASH_SAMPLE) { h.update(fs.readFileSync(f)); return h.digest('hex'); }
        const fd = fs.openSync(f, 'r');
        try {
            const buf = Buffer.alloc(HASH_SAMPLE);
            fs.readSync(fd, buf, 0, HASH_SAMPLE, 0); h.update(buf);
            fs.readSync(fd, buf, 0, HASH_SAMPLE, st.size - HASH_SAMPLE); h.update(buf);
        } finally { fs.closeSync(fd); }
        return `s${st.size}-${h.digest('hex')}`;
    } catch { return null; }
};
// Entries recorded before sampled hashes hold a full-file sha1 for big files too; those are
// compared the old (slow) way once, so existing undo entries stay valid.
const hashMatches = (f, stored) => {
    if (stored && !stored.startsWith('s') && stored.length === 40) {
        try { const st = fs.statSync(f); if (st.size > 2 * HASH_SAMPLE) return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') === stored; } catch { return false; }
    }
    return fileHash(f) === stored;
};
const undoId = () => 'u' + crypto.randomBytes(6).toString('hex');
// After a JSON store is written back by undo, the panel's caches re-read it.
function storeWritten(file) {
    if (file === R.attention.ATTENTION_FILE) { R.attention.attn = null; R.attention.attnVer++; R.attention.attnStatAt = 0; }
    if (file === R.core.META_FILE) { R.metadata.metaChecked = 0; }
    if (file.startsWith(R.songs.SONGS_DIR)) R.songs.songIdx.at = 0;
}

// Which requests are recorded, the stores they change and a label (English only; names and
// titles are not put in labels). `scope`: only these entries of the store are compared and
// kept (clip details: the clips the request names, not the whole metadata file).
// `limit`: the route's own request size limit; bodies over 8 MB are not recorded.
const n_ = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const idsScope = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((x) => /^c[0-9a-f]{15}$/.test(x)))].map((id) => ['clips', id]);
const csvIds = (csv) => { try { return R.library.parseCsv(String(csv || '')).map((r) => String(r.id || '').trim()); } catch { return []; } };
const CREDITS_DIR = path.join(R.core.DATA_DIR, 'credits');
const UNDO_ROUTES = [
    { m: 'POST', re: /^\/local\/attention\/(hide|unhide|accept|unaccept|types)$/, files: () => [{ file: R.attention.ATTENTION_FILE }], label: (b, x) => ({
        hide: () => `Hide ${n_((b.ids || []).length + (b.paths || []).length, 'item', 'items')}`, unhide: () => 'Unhide', accept: () => `Keep as is (${n_((b.items || []).length, 'item', 'items')})`,
        unaccept: () => 'Back on the Needs attention list', types: () => 'Hidden file types changed' }[x[1]]()) },
    { m: 'PUT', re: /^\/local\/meta\/clip$/, files: (b) => [{ file: R.core.META_FILE, scope: idsScope([b.id]) }], label: () => 'Clip details saved' },
    { m: 'PUT', re: /^\/local\/meta\/bulk$/, files: (b) => [{ file: R.core.META_FILE, scope: idsScope(b.ids) }], label: (b) => `Bulk edit: ${Object.keys(b.fields || {}).join(', ')} (${n_((b.ids || []).length, 'clip', 'clips')})` },
    { m: 'POST', re: /^\/local\/meta\/import$/, limit: 32 * 1024 * 1024, files: (b) => [{ file: R.core.META_FILE, scope: idsScope(csvIds(b.csv)) }], label: () => 'Metadata import', skip: (b) => b.dry_run !== false },
    { m: 'POST', re: /^\/local\/analysis\/apply$/, files: (b) => [{ file: R.core.META_FILE, scope: idsScope(b.ids) }], label: (b) => `Suggested ${(b.fields || []).join(' and ')} filled in (${n_((b.ids || []).length, 'clip', 'clips')})` },
    { m: 'POST', re: /^\/local\/songs\/update$/, files: (b) => [{ file: path.join(R.songs.SONGS_DIR, `${String(b.clip || '').replace(/[^0-9a-z]/g, '')}.json`) }, { file: path.join(CREDITS_DIR, 'aliases.json') }],
        label: (b) => ({ accept: 'Song credits accepted', edit: 'Song credits edited', not_a_song: 'Marked as not a song', reopen: 'Song reopened', adjust: 'Song times changed', split: 'Song split in two', hint: 'Song hint saved' }[b.action] || 'Song changed') },
    { m: 'POST', re: /^\/local\/blocks$/, files: () => [{ file: R.blocks.BLOCKS_FILE }], label: (b) => (b.id ? 'Block saved' : 'Block created') },
    { m: 'POST', re: /^\/local\/blocks\/remove$/, files: () => [{ file: R.blocks.BLOCKS_FILE }], label: () => 'Block removed' },
    { m: 'POST', re: /^\/local\/occasions$/, files: () => [{ file: R.blocks.OCCASIONS_FILE }], label: (b) => (b.id ? 'Occasion saved' : 'Occasion created') },
    { m: 'POST', re: /^\/local\/occasions\/remove$/, files: () => [{ file: R.blocks.OCCASIONS_FILE }], label: () => 'Occasion removed' },
    // Block marks of a day can join that day's playlist save (same undo entry).
    { m: 'POST', re: /^\/local\/blocks\/placements$/, files: () => [{ file: R.blocks.PLACEMENTS_FILE }], label: (b) => `Block marks saved (${R.metadata.fmtDate(b.date)})`, joins: true },
    { m: 'POST', re: /^\/local\/blocks\/placements\/archive$/, files: () => [{ file: R.blocks.PLACEMENTS_FILE }], label: (b) => `Block marks archived (${R.metadata.fmtDate(b.date)})`, joins: true },
    { m: 'POST', re: /^\/local\/blocks\/placements\/unpin$/, files: () => [{ file: R.blocks.PLACEMENTS_FILE }], label: (b) => `Pin removed (${R.metadata.fmtDate(b.date)})` },
    { m: 'PUT', re: /^\/local\/branding\/rules$/, files: () => [{ file: R.branding.BRAND_RULES_FILE }], label: () => 'Branding rules saved' },
    { m: 'PUT', re: /^\/local\/templates$/, files: () => [{ file: R.core.TEMPLATES_FILE }], label: () => 'Templates saved' },
    { m: 'PUT', re: /^\/local\/automation$/, files: () => [{ file: R.core.AUTOMATION_FILE }], label: () => 'Live text settings saved' },
    { m: 'PUT', re: /^\/local\/state$/, files: () => [{ file: R.core.STATE_FILE }], label: () => 'Panel settings saved' },
    // File actions: the handler adds the moves (see undoFiles); no JSON store.
    { m: 'POST', re: /^\/local\/branding\/remove$/, files: () => [], label: () => 'Branding file removed' },
    { m: 'POST', re: /^\/local\/branding\/use$/, files: () => [], label: (b) => ({ logo: 'Channel logo replaced', offair: 'Off-air slate replaced', live: 'Live standby slate replaced' }[b.as] || 'Channel file replaced') },
    { m: 'POST', re: /^\/local\/logo$/, files: () => [], label: () => 'Channel logo replaced', raw: true },
    { m: 'POST', re: /^\/local\/branding\/upload$/, files: () => [], label: () => 'Branding file uploaded', raw: true },
    { m: 'PUT', re: /^\/local\/meta\/docs$/, files: () => [], label: () => 'Release document removed' },
];
// Playlist saves through ffplayout: begun before the write (previous files kept), committed after.
const undoPending = new Map();
const RECORD_MAX = 8 * 1024 * 1024;

// A store's snapshot: the whole document, or only the scoped entries.
function snapStore(spec) {
    const r = readJsonLoose(spec.file);
    if (r.damaged || !spec.scope) return r;
    return { scoped: new Map(spec.scope.map((p) => [JSON.stringify(p), getAt(r.doc, p)])) };
}
// Called for every request before routing: snapshots the stores the action changes.
async function undoBegin(req, res, pathname) {
    if (!pathname.startsWith('/local/') || req.method === 'GET') return;
    const spec = UNDO_ROUTES.find((r) => r.m === req.method && r.re.test(pathname));
    if (!spec) return;
    let body = {};
    if (!spec.raw) {
        req._bodyText = await R.core.readBody(req, spec.limit || 4 * 1024 * 1024);
        // Very large requests (a big metadata import) are carried out but not recorded.
        if (req._bodyText.length > RECORD_MAX) return;
        try { body = JSON.parse(req._bodyText) || {}; } catch { body = {}; }
    }
    if (spec.skip && spec.skip(body)) return;
    const files = spec.files(body);
    const before = new Map();
    for (const f of files) before.set(f.file, snapStore(f));
    // A playlist save in progress (X-Undo-Group): only the block marks of one of its days join it.
    const group = String(req.headers['x-undo-group'] || '').slice(0, 40);
    const pend = group && spec.joins ? undoPending.get(group) : null;
    res.undoCtx = { label: spec.label(body, spec.re.exec(pathname)), files, before, moves: [], replaced: [],
        session: String(req.headers['x-panel-session'] || '').slice(0, 40), join: pend && pend.days.some((d) => d.date === body.date) ? pend : null };
}
// The handler passes the files it moved aside; they are not part of the reply.
const takeUndo = (res, r) => { if (r && r.undo) { undoFiles(res, r.undo); const { undo, ...rest } = r; return rest; } return r; };
const undoFiles = (res, { moves = [], replaced = [] }) => { if (res.undoCtx) { res.undoCtx.moves.push(...moves); res.undoCtx.replaced.push(...replaced); } };
// Called from send() for a successful reply: records what changed and names the entry in a header.
function undoFinish(res, status) {
    const ctx = res.undoCtx;
    res.undoCtx = null;
    if (!ctx || status >= 400) return;
    try {
        const changes = [];
        for (const f of ctx.files) {
            const b = ctx.before.get(f.file);
            if (b.damaged) continue;
            if (f.scope) {
                const a = snapStore(f);
                if (a.damaged) continue;
                for (const p of f.scope) { const k = JSON.stringify(p), x = b.scoped.get(k), y = a.scoped.get(k); if (!deepEq(x, y)) changes.push({ file: f.file, path: p, before: x, after: y }); }
                continue;
            }
            const a = readJsonLoose(f.file);
            if (a.damaged) continue;
            for (const c of diffJson(b.doc, a.doc, [], [], 2)) changes.push({ file: f.file, ...c });
        }
        if (!changes.length && !ctx.moves.length && !ctx.replaced.length) return;
        if (ctx.join) { ctx.join.changes.push(...changes); ctx.join.moves.push(...ctx.moves); return; }
        const e = { id: undoId(), at: new Date().toISOString(), session: ctx.session, label: ctx.label, changes, moves: ctx.moves, replaced: ctx.replaced, playlists: [], undone_at: null };
        undoStore().entries.push(e);
        saveUndo();
        res.setHeader('X-Undo-Id', e.id);
        res.setHeader('X-Undo-Label', encodeURIComponent(e.label));
    } catch (err) { console.error('undo record', err.message); }
}

const plFile = (date) => path.join(R.core.PLAYLISTS_DIR, date.slice(0, 4), date.slice(5, 7), `${date}.json`);
const hhmmss = () => new Date().toTimeString().slice(0, 8).replace(/:/g, '');
const PREV_OLD = path.join(PLAYLISTS_PREV, '_old');
// Keeps the newest 20 copies per day in playlists\_previous; older ones go to _previous\_old.
function prunePrevious(date) {
    let names = [];
    try { names = fs.readdirSync(PLAYLISTS_PREV).filter((n) => n.startsWith(`${date}-`) && n.endsWith('.json')); } catch { return; }
    if (names.length <= 20) return;
    const mt = (n) => { try { return fs.statSync(path.join(PLAYLISTS_PREV, n)).mtimeMs; } catch { return 0; } };
    const old = names.sort((a, b) => mt(b) - mt(a) || b.localeCompare(a)).slice(20);
    fs.mkdirSync(PREV_OLD, { recursive: true });
    for (const n of old) { try { R.core.renameRetry(path.join(PLAYLISTS_PREV, n), path.join(PREV_OLD, n)); } catch (e) { console.error('prune _previous', e.message); } }
}
// A kept copy, also after it was moved to _old.
const prevPath = (p) => (!p ? null : fs.existsSync(p) ? p : fs.existsSync(path.join(PREV_OLD, path.basename(p))) ? path.join(PREV_OLD, path.basename(p)) : null);
// stage "begin": keeps a copy of each day's current playlist; "commit": records the entry.
function undoPlaylist(body, res) {
    if (body.stage === 'begin') {
        const dates = (Array.isArray(body.dates) ? body.dates : []).slice(0, 400).map((d) => R.blocks.checkIsoDate(d));
        if (!dates.length) throw R.blocks.reqErr('no dates');
        const token = 'p' + crypto.randomBytes(6).toString('hex');
        const days = dates.map((date) => {
            const f = plFile(date);
            if (!fs.existsSync(f)) return { date, prev: null };
            fs.mkdirSync(PLAYLISTS_PREV, { recursive: true });
            const prev = path.join(PLAYLISTS_PREV, `${date}-${hhmmss()}-${token.slice(1, 5)}.json`);
            fs.copyFileSync(f, prev);
            prunePrevious(date);
            return { date, prev };
        });
        undoPending.set(token, { label: String(body.label || 'Playlist saved').slice(0, 80), days, changes: [], moves: [], at: Date.now() });
        setTimeout(() => undoPending.delete(token), 10 * 60e3).unref();
        return { token };
    }
    if (body.stage === 'commit') {
        const p = undoPending.get(String(body.token || ''));
        if (!p) throw R.blocks.reqErr('This save can no longer be undone (it took too long).', 410);
        undoPending.delete(String(body.token));
        const done = new Set(Array.isArray(body.dates) ? body.dates : p.days.map((d) => d.date));
        const days = p.days.filter((d) => done.has(d.date)).map((d) => ({ ...d, after: fileHash(plFile(d.date)) }));
        if (!days.length && !p.changes.length) return { recorded: false };
        const e = { id: undoId(), at: new Date().toISOString(), session: String(body.session || '').slice(0, 40), label: p.label, changes: p.changes, moves: p.moves, replaced: [], playlists: days, undone_at: null };
        undoStore().entries.push(e);
        saveUndo();
        res.setHeader('X-Undo-Id', e.id);
        res.setHeader('X-Undo-Label', encodeURIComponent(e.label));
        return { recorded: true, id: e.id };
    }
    throw R.blocks.reqErr('unknown stage');
}

// Days around now: the broadcast day playing now, and the next one.
const playlistDays = () => { const t = R.songs.broadcastToday(); const n = new Date(t + 'T12:00:00Z'); n.setUTCDate(n.getUTCDate() + 1); return { today: t, tomorrow: n.toISOString().slice(0, 10) }; };
// Why an entry cannot be undone now (or null).
function undoBlocker(e) {
    if (e.undone_at) return 'it was undone already.';
    const entries = undoStore().entries;
    const newer = entries.slice(entries.indexOf(e) + 1).filter((x) => !x.undone_at);
    for (const c of e.changes) {
        const r = readJsonLoose(c.file);
        if (r.damaged) return `${path.basename(c.file)} is damaged and left as it is.`;
        if (!deepEq(getAt(r.doc, c.path), c.after)) {
            const by = newer.find((x) => x.changes.some((y) => y.file === c.file && pathText(y.path).startsWith(pathText(c.path))));
            return by ? `“${by.label}” (${new Date(by.at).toLocaleTimeString('en-GB')}) changed the same thing later: undo that first.` : 'the same thing was changed again afterwards, so it is left as it is.';
        }
    }
    for (const m of e.moves) {
        if (fs.existsSync(m.from)) return `a file is back at ${path.basename(m.from)} already.`;
        if (!fs.existsSync(m.to)) return `the moved file is no longer at ${path.basename(m.to)}.`;
    }
    for (const r of e.replaced) {
        if (!hashMatches(r.target, r.hash)) return `${path.basename(r.target)} was replaced again afterwards.`;
        // The same rule as Remove and Replace: a file in a saved playlist from today on is not swapped.
        try { R.branding.refuseIfScheduled(r.target, path.basename(r.target)); } catch (err) { return err.message; }
    }
    const { today, tomorrow } = playlistDays();
    for (const d of e.playlists) {
        if (fileHash(plFile(d.date)) !== d.after) return `the playlist of ${R.metadata.fmtDate(d.date)} was saved again afterwards.`;
        if (d.prev && !prevPath(d.prev)) return `the earlier playlist of ${R.metadata.fmtDate(d.date)} is no longer in playlists\\_previous.`;
        if (!d.prev && fs.existsSync(plFile(d.date)) && (d.date === today || d.date === tomorrow)) return 'there was no earlier playlist for this day; delete the day from the Program page if you mean it.';
    }
    return null;
}
// Questions the page must ask before this undo (the server refuses until confirmed).
function undoQuestions(e) {
    const { today } = playlistDays();
    const q = [];
    if (e.playlists.some((d) => d.date === today)) q.push('on_air');
    if (e.playlists.some((d) => !d.prev && fs.existsSync(plFile(d.date)))) q.push('day_empty');
    return q;
}
// Puts a kept playlist back: through ffplayout's own save (automation account) when possible,
// else a temp file renamed into place. The current file is copied to _previous first; a day
// is never left without a playlist.
async function restorePlaylist(date, prevFile) {
    const f = plFile(date);
    const text = fs.readFileSync(prevFile, 'utf8');
    fs.mkdirSync(PLAYLISTS_PREV, { recursive: true });
    if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(PLAYLISTS_PREV, `${date}-undone-${hhmmss()}.json`)); prunePrevious(date); }
    if (R.automation.readSecrets()) {
        try {
            if (!R.automation.auto.channelId) { const ch = await R.automation.ffApi('GET', '/api/channels'); R.automation.auto.channelId = ch?.[0]?.id; }
            await R.automation.ffApi('POST', `/api/playlist/${R.automation.auto.channelId}`, JSON.parse(text));
            return 'ffplayout';
        } catch (err) { console.error('undo: ffplayout playlist save failed, writing the file', err.message); }
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = path.join(path.dirname(f), `.${date}.${process.pid}.undo.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    R.core.renameRetry(tmp, f);
    return 'file';
}
async function undoApply(id, { confirm = [] } = {}) {
    const e = undoStore().entries.find((x) => x.id === id);
    if (!e) throw R.blocks.reqErr('This action is no longer in the undo list.', 404);
    const why = undoBlocker(e);
    if (why) throw R.blocks.reqErr(`“${e.label}” cannot be undone: ${why}`, 409);
    const ask = undoQuestions(e).filter((q) => !(Array.isArray(confirm) ? confirm : []).includes(q));
    if (ask.length) throw Object.assign(R.blocks.reqErr(ask[0] === 'on_air' ? 'This changes the playlist that is on air now.' : 'There was no earlier playlist for this day: undo moves the current one aside (to playlists\\_previous) and the day has no playlist.', 409), { uiCode: `confirm_${ask[0]}` });
    // JSON stores: one write per file, the changes reversed newest first. Songs and credits
    // files go through their lock (the overnight run and the credits lookup write them too).
    const byFile = new Map();
    for (const c of e.changes) { if (!byFile.has(c.file)) byFile.set(c.file, []); byFile.get(c.file).push(c); }
    for (const [file, list] of byFile) {
        const revert = (doc) => {
            for (const c of list.slice().reverse()) {
                if (!c.path.length) { doc = c.before; continue; }
                if (doc === undefined || doc === null) doc = {};
                setAt(doc, c.path, c.before, c.index);
            }
            return doc;
        };
        if (file.startsWith(R.songs.SONGS_DIR + path.sep) || file.startsWith(CREDITS_DIR + path.sep)) {
            await R.songs.songLib().store.updateJsonAsync(file, (cur) => { const d = revert(cur === null ? undefined : cur); return d === undefined ? {} : d; });
        } else {
            const doc = revert(readJsonLoose(file).doc);
            if (file === R.core.META_FILE && fs.existsSync(R.core.META_FILE)) fs.copyFileSync(R.core.META_FILE, R.core.META_FILE + '.bak');
            if (doc === undefined) { if (fs.existsSync(file)) R.core.renameRetry(file, `${file}.undone-${R.core.stamp()}`); }
            else R.core.writeJsonAtomic(file, doc, 1);
        }
        storeWritten(file);
    }
    for (const m of e.moves.slice().reverse()) { fs.mkdirSync(path.dirname(m.from), { recursive: true }); R.core.renameRetry(m.to, m.from); }
    for (const r of e.replaced) {
        // The current file is moved aside (next to it, or into the set's _removed/_replaced folder).
        const name = path.basename(r.target).replace(/(\.[^.]+)$/, `-undone-${R.core.stamp()}$1`);
        if (r.aside) fs.mkdirSync(r.aside, { recursive: true });
        R.core.renameRetry(r.target, r.aside ? path.join(r.aside, name) : path.join(path.dirname(r.target), name));
        if (r.previous && fs.existsSync(r.previous)) R.core.renameRetry(r.previous, r.target);
    }
    const how = [];
    for (const d of e.playlists) {
        const prev = prevPath(d.prev);
        if (prev) how.push(await restorePlaylist(d.date, prev));
        else if (fs.existsSync(plFile(d.date))) {
            // A day that had no playlist before (confirmed, never today or tomorrow): moved aside.
            fs.mkdirSync(PLAYLISTS_PREV, { recursive: true });
            R.core.renameRetry(plFile(d.date), path.join(PLAYLISTS_PREV, `${d.date}-undone-${hhmmss()}.json`));
            prunePrevious(d.date);
        }
    }
    if (e.moves.length || e.replaced.length) R.librarytools.docIndex.at = 0;
    e.undone_at = new Date().toISOString();
    saveUndo();
    return { undone: e.id, label: e.label, playlists: e.playlists.map((d) => d.date), via: how };
}
function undoList(q) {
    const session = q.get('session') || '';
    const all = q.get('all') === '1';
    const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 20));
    return { entries: undoStore().entries.filter((e) => all || e.session === session).slice(-limit).reverse()
        .map((e) => ({ id: e.id, at: e.at, label: e.label, undone_at: e.undone_at, blocked: e.undone_at ? null : undoBlocker(e), questions: e.undone_at ? [] : undoQuestions(e), files: e.playlists.length ? e.playlists.map((d) => d.date) : undefined })) };
}


// ---- exports (read by the other modules through R.undo) ----
R.undo = module.exports;
Object.assign(module.exports, { UNDO_FILE, UNDO_ARCHIVE, PLAYLISTS_PREV, UNDO_KEEP, deepEq, isObj, idArray, diffJson, getAt, setAt, pathText, readJsonLoose, undoStore, saveUndo, HASH_SAMPLE, fileHash, hashMatches, undoId, storeWritten, n_, idsScope, csvIds, CREDITS_DIR, UNDO_ROUTES, undoPending, RECORD_MAX, snapStore, undoBegin, takeUndo, undoFiles, undoFinish, plFile, hhmmss, PREV_OLD, prunePrevious, prevPath, undoPlaylist, playlistDays, undoBlocker, undoQuestions, restorePlaylist, undoApply, undoList });
Object.defineProperty(module.exports, 'undoMem', { get: () => undoMem, set: (v) => { undoMem = v; }, enumerable: true });
