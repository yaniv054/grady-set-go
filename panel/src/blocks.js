// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const R = require('./registry');

// --- saved blocks, placements and occasions ---------------------------------------------
// data\blocks.json            { blocks: [{ id, name, occasion, notes, quiet, items, created, updated, last_used }] }
//                             items: [{ source, in, out, duration, title?, clip_id? }] (in/out trims kept).
//                             clip_id lets a renamed or moved file be found again later.
// data\blocks-archive.json    removed blocks (appended, never deleted).
// data\block-placements.json  { "<date>": [{ block_id, name, quiet, start, sources, offset_s? }] }:
//                             blocks inserted into a saved day (start "HH:MM" = pinned there
//                             for Generate). Written by the browser when it saves a day.
// data\occasions.json         { occasions: [{ id, name, branding_set, notes, dates: [{ date, placements: [{ block_id, start }] }] }] }
// data\occasions-archive.json removed occasions.
// Every write keeps the previous file as .bak. A damaged file is never overwritten: the
// request fails until it is restored.
const BLOCKS_FILE = path.join(R.core.DATA_DIR, 'blocks.json');
const BLOCKS_ARCHIVE = path.join(R.core.DATA_DIR, 'blocks-archive.json');
const PLACEMENTS_FILE = path.join(R.core.DATA_DIR, 'block-placements.json');
const OCCASIONS_FILE = path.join(R.core.DATA_DIR, 'occasions.json');
const OCCASIONS_ARCHIVE = path.join(R.core.DATA_DIR, 'occasions-archive.json');
const BLOCK_ID_RE = /^b[0-9a-z]{6,30}$/;
const OCC_ID_RE = /^o[0-9a-z]{6,30}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const BLOCK_MAX_ITEMS = 1000;
const reqErr = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r3 = (n) => Math.round(n * 1000) / 1000;
const hmToS = (s) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null; };
// One line of text (names): no control characters, trimmed.
const cleanLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanNotes = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
function checkIsoDate(v, what = 'date') {
    const s = String(v ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || R.metadata.normDate(s) !== s) throw reqErr(`${what} must be a date (YYYY-MM-DD).`);
    return s;
}
function checkHM(v, what = 'Time') {
    const s = String(v ?? '').trim();
    if (!HM_RE.test(s)) throw reqErr(`${what} must be HH:MM (00:00–23:59).`);
    return s;
}
const newId = (prefix) => prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
function readStore(file, empty) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return empty(); throw e; }
    try { const j = JSON.parse(text.replace(/^﻿/, '')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch { /* below */ }
    throw reqErr(`${file} is unreadable. Restore it from ${path.basename(file)}.bak in the same folder; nothing was changed.`, 503);
}
function writeStore(file, obj) {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    R.core.writeJsonAtomic(file, obj, 1);
}
const readBlocks = () => { const j = readStore(BLOCKS_FILE, () => ({ blocks: [] })); if (!Array.isArray(j.blocks)) j.blocks = []; return j; };
const readOccasions = () => { const j = readStore(OCCASIONS_FILE, () => ({ occasions: [] })); if (!Array.isArray(j.occasions)) j.occasions = []; return j; };
// Placements are read on every new clip by the live text: cached until the file changes.
let placeCache = { key: null, data: {} };
function readPlacements() {
    let key = 'none';
    try { const st = fs.statSync(PLACEMENTS_FILE); key = `${st.size}:${st.mtimeMs}`; } catch { /* none yet */ }
    if (key !== placeCache.key) placeCache = { key, data: key === 'none' ? {} : readStore(PLACEMENTS_FILE, () => ({})) };
    return placeCache.data;
}

// Program items for a block: in/out trims kept; the clip ID of each library file is stored.
function cleanBlockItems(list) {
    if (!Array.isArray(list) || !list.length) throw reqErr('A block needs at least one item.');
    if (list.length > BLOCK_MAX_ITEMS) throw reqErr(`A block can have at most ${BLOCK_MAX_ITEMS} items.`);
    return list.map((it, i) => {
        const source = String(it?.source ?? '');
        if (!source || source.length > 1024 || /[\u0000-\u001f]/.test(source)) throw reqErr(`Item ${i + 1}: the file path is missing or not valid.`);
        const inS = Number(it.in ?? 0), outS = Number(it.out ?? it.duration), dur = Number(it.duration ?? it.out);
        // out is clamped to the file length; in must stay before out.
        const outC = Number.isFinite(dur) && dur > 0 ? Math.min(outS, dur) : outS;
        if (![inS, outC, dur].every(Number.isFinite) || inS < 0 || outC <= inS || dur <= 0 || outC > 7 * 86400) throw reqErr(`Item ${i + 1} (${path.basename(source)}): in, out or duration is not valid.`);
        const out = { source, in: r3(inS), out: r3(outC), duration: r3(dur) };
        if (it.title) out.title = cleanLine(it.title, 300);
        // Other ffplayout item settings are kept as they were.
        for (const k of ['audio', 'custom_filter', 'category']) if (typeof it[k] === 'string' && it[k]) out[k] = it[k].slice(0, 1000);
        const id = R.asrun.STORAGE_KIND(source) ? null : R.media.idForPath(source) || (R.librarytools.CLIP_ID_RE.test(String(it.clip_id || '')) ? it.clip_id : null);
        if (id) out.clip_id = id;
        return out;
    });
}
const itemLen = (it) => Math.max(0, Number(it.out ?? it.duration) - Number(it.in || 0)) || 0;
function blockSummary(b) {
    const { items, ...rest } = b;
    return { ...rest, length_s: r3(items.reduce((s, it) => s + itemLen(it), 0)), items_n: items.length, clips: items.filter((it) => !R.asrun.STORAGE_KIND(it.source)).length };
}
function getBlock(id) {
    if (!BLOCK_ID_RE.test(String(id || ''))) throw reqErr('bad block id');
    const b = readBlocks().blocks.find((x) => x.id === id);
    if (!b) throw reqErr('This block no longer exists.', 404);
    return b;
}
function saveBlock(body) {
    const name = cleanLine(body.name, 80);
    if (!name) throw reqErr('The block needs a name.');
    const fields = { name, occasion: cleanLine(body.occasion, 80), notes: cleanNotes(body.notes, 2000), quiet: body.quiet === true, items: cleanBlockItems(body.items) };
    const store = readBlocks();
    const now = new Date().toISOString();
    let b;
    if (body.id != null && body.id !== '') {
        if (!BLOCK_ID_RE.test(String(body.id))) throw reqErr('bad block id');
        b = store.blocks.find((x) => x.id === body.id);
        if (!b) throw reqErr('This block no longer exists (removed meanwhile?). Use Save as copy to keep your changes.', 404);
        // Opened before someone else saved it (another tab or PC): not overwritten.
        if (body.base_updated && b.updated !== body.base_updated) throw reqErr(`This block was saved elsewhere at ${R.metadata.fmtDate(R.metadata.ymd(new Date(b.updated)))} ${new Date(b.updated).toTimeString().slice(0, 5)} since you opened it. Use Save as copy, or close it and open it again.`, 409);
        const renamed = b.name !== fields.name || !!b.quiet !== fields.quiet;
        Object.assign(b, fields, { updated: now });
        // Days it was inserted into follow a new name or Quiet setting (bands, live text).
        if (renamed) {
            try {
                const pl = readStore(PLACEMENTS_FILE, () => ({}));
                let n = 0;
                for (const list of Object.values(pl)) for (const x of Array.isArray(list) ? list : []) if (x.block_id === b.id) { x.name = b.name; x.quiet = b.quiet; n++; }
                if (n) { writeStore(PLACEMENTS_FILE, pl); placeCache.key = null; }
            } catch (e) { console.error('block placements', e.message); }
        }
    } else {
        if (store.blocks.length >= 500) throw reqErr('There are already 500 saved blocks. Remove some first.');
        b = { id: newId('b'), ...fields, created: now, updated: now, last_used: null };
        store.blocks.push(b);
    }
    writeStore(BLOCKS_FILE, store);
    return { block: b, summary: blockSummary(b) };
}
function markBlockUsed(id) {
    if (!BLOCK_ID_RE.test(String(id || ''))) throw reqErr('bad block id');
    const store = readBlocks();
    const b = store.blocks.find((x) => x.id === id);
    if (!b) throw reqErr('This block no longer exists.', 404);
    b.last_used = new Date().toISOString();
    writeStore(BLOCKS_FILE, store);
    return { id, last_used: b.last_used };
}
// "Remove" moves the block to the archive. A block pinned on an occasion date from
// yesterday on is refused (it would silently disappear from that day).
function removeBlock(id) {
    if (!BLOCK_ID_RE.test(String(id || ''))) throw reqErr('bad block id');
    const store = readBlocks();
    const i = store.blocks.findIndex((b) => b.id === id);
    if (i < 0) throw reqErr('This block no longer exists.', 404);
    const uses = [];
    for (const o of readOccasions().occasions) for (const d of o.dates || []) if (d.date >= R.metadata.yesterday() && (d.placements || []).some((p) => p.block_id === id)) uses.push(`${o.name} (${R.metadata.fmtDate(d.date)})`);
    if (uses.length) throw reqErr(`This block is pinned on ${uses.join(', ')}. Take it out of the occasion first.`, 409);
    const arch = readStore(BLOCKS_ARCHIVE, () => ({ blocks: [] }));
    if (!Array.isArray(arch.blocks)) arch.blocks = [];
    arch.blocks.push({ ...store.blocks[i], removed: new Date().toISOString() });
    writeStore(BLOCKS_ARCHIVE, arch);
    store.blocks.splice(i, 1);
    writeStore(BLOCKS_FILE, store);
    return { removed: id, archive: BLOCKS_ARCHIVE };
}

// Checks block items for a date: renamed/moved files (resolved to the current path),
// missing files, files hidden on the Needs attention page, rights for that date and, with a
// start time (HH:MM[:SS]), explicit clips outside the explicit-language window.
function checkBlockItems(items, { date, start = null, dayStart = 0 }) {
    const H = R.attention.hiddenIndex();
    const rules = R.branding.readBrandRules();
    const exAfter = hmToS(rules.explicit_after);
    const startS = start ? hmToS(start) : null;
    const counts = { moved: 0, missing: 0, hidden: 0, not_cleared: 0, explicit_window: 0 };
    const out = [];
    let t = 0;
    for (const [i, it] of items.entries()) {
        const warnings = [];
        let source = String(it.source || ''), row = null;
        if (R.asrun.STORAGE_KIND(source)) {
            if (!fs.existsSync(source)) warnings.push({ type: 'missing', text: 'Channel file not found in storage' });
        } else {
            row = R.media.library().get(source.toLowerCase()) || null;
            if (!row) {
                const cur = R.media.rowForId(R.media.pathHistory()[source.toLowerCase()]?.id) || R.media.rowForId(it.clip_id);
                if (cur) { warnings.push({ type: 'moved', text: `Renamed or moved; the current path is used: ${cur.path}`, from: source, to: cur.path }); source = cur.path; row = cur; }
                else warnings.push({ type: 'missing', text: 'Not on the share any more (not in library.csv) and could not be traced' });
            }
            if (row) {
                if (R.attention.isHiddenIn(H, row.path)) warnings.push({ type: 'hidden', text: 'Hidden on the Needs attention page' });
                const m = R.metadata.metaOf(row.id, row);
                if (!R.metadata.isCleared(m, date)) warnings.push({ type: 'not_cleared', text: m.rights === 'cleared' ? `Rights expired ${R.metadata.fmtDate(m.rights_expires)}` : `Rights ${m.rights} on ${R.metadata.fmtDate(date)}` });
                if (m.explicit === 'yes' && exAfter !== null && startS !== null) {
                    const tod = (startS + t) % 86400;
                    const ok = exAfter > dayStart ? (tod >= exAfter || tod < dayStart) : (tod >= exAfter && tod < dayStart);
                    if (!ok) warnings.push({ type: 'explicit_window', text: `Explicit language at ${R.metadata.fmtHms(tod)}; explicit clips may only air from ${rules.explicit_after}` });
                }
            }
        }
        for (const w of warnings) counts[w.type]++;
        const item = { ...it, source };
        if (row) item.clip_id = row.id;
        out.push({ index: i, title: row ? R.metadata.metaOf(row.id, row).title : path.basename(source).replace(/\.[^.]+$/, ''), warnings, item });
        t += itemLen(it);
    }
    return { items: out, counts, length_s: r3(t), problems: Object.values(counts).reduce((s, n) => s + n, 0) };
}
// Files reported missing that are on the share after all (added since the last library
// scan): their rights are not known yet. Looked up asynchronously with a time limit, so a
// slow share never holds up the panel.
async function refineMissing(r, budget = { n: 50 }) {
    const exists = (f) => Promise.race([fs.promises.access(f).then(() => true, () => false), new Promise((res) => setTimeout(res, 3000, false))]);
    await Promise.all(r.items.map(async (x) => {
        const w = x.warnings.find((y) => y.type === 'missing');
        if (!w || R.asrun.STORAGE_KIND(x.item.source) || budget.n-- <= 0 || !(await exists(x.item.source))) return;
        w.type = 'not_cleared';
        w.text = 'Not in the library yet (run Rescan library); rights unknown';
        r.counts.missing--; r.counts.not_cleared++;
    }));
    return r;
}
async function checkBlocks(body) {
    const date = body.date ? checkIsoDate(body.date) : R.metadata.today();
    const ds = Number(body.day_start_s);
    const opts = { date, dayStart: Number.isFinite(ds) && ds >= 0 && ds < 86400 ? ds : 0, start: null };
    if (body.start != null && body.start !== '') {
        if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(body.start))) throw reqErr('start must be HH:MM.');
        opts.start = String(body.start);
    }
    // Summary for several blocks at once (the badges in the Saved blocks list).
    if (Array.isArray(body.ids)) {
        const byId = new Map(readBlocks().blocks.map((b) => [b.id, b]));
        const results = {}, budget = { n: 50 };
        for (const id of body.ids.slice(0, 500)) {
            const b = byId.get(id);
            if (!b) continue;
            const r = await refineMissing(checkBlockItems(b.items, opts), budget);
            results[id] = { counts: r.counts, problems: r.problems, length_s: r.length_s, notes: r.items.flatMap((x) => x.warnings.map((w) => `${x.index + 1}. ${x.title}: ${w.text}`)).slice(0, 12) };
        }
        return { date, results };
    }
    const items = body.id ? getBlock(body.id).items : cleanBlockItems(body.items);
    return { date, start: opts.start, ...(await refineMissing(checkBlockItems(items, opts))) };
}

function cleanPlacement(p, i) {
    if (!p || typeof p !== 'object') throw reqErr(`Placement ${i + 1} is not valid.`);
    if (!BLOCK_ID_RE.test(String(p.block_id || ''))) throw reqErr(`Placement ${i + 1}: bad block id.`);
    const sources = Array.isArray(p.sources) ? p.sources : [];
    if (!sources.length || sources.length > BLOCK_MAX_ITEMS || sources.some((s) => typeof s !== 'string' || !s || s.length > 1024)) throw reqErr(`Placement ${i + 1}: the list of files is not valid.`);
    const out = { block_id: p.block_id, name: cleanLine(p.name, 80) || p.block_id, quiet: p.quiet === true, start: p.start == null || p.start === '' ? null : checkHM(p.start, `Placement ${i + 1}: the start`), sources };
    const off = Number(p.offset_s);
    if (p.offset_s != null && Number.isFinite(off) && off >= 0 && off <= 2 * 86400) out.offset_s = r3(off);
    return out;
}
const PLACEMENTS_ARCHIVE = path.join(R.core.DATA_DIR, 'block-placements-archive.json');
// Moves records out of block-placements.json into block-placements-archive.json
// ({ "<date>": [records with archived + why] }); nothing is deleted.
function archivePlacements(store, dates, why) {
    const moved = dates.filter((d) => Array.isArray(store[d]) && store[d].length);
    if (!moved.length) { for (const d of dates) delete store[d]; return 0; }
    const arch = readStore(PLACEMENTS_ARCHIVE, () => ({}));
    const at = new Date().toISOString();
    // Records already in the archive (e.g. a retry after a failed write) are not added twice.
    const key = (x) => JSON.stringify([x.block_id, x.start, x.offset_s, x.sources]);
    for (const d of moved) {
        const have = Array.isArray(arch[d]) ? arch[d] : [];
        const seen = new Set(have.map(key));
        arch[d] = [...have, ...store[d].filter((x) => !seen.has(key(x))).map((x) => ({ ...x, archived: at, why }))];
    }
    writeStore(PLACEMENTS_ARCHIVE, arch);
    for (const d of dates) delete store[d];
    return moved.length;
}
// Dates more than 30 days back are moved to the archive whenever the file is written.
const prunePlacements = (store) => {
    const cut = R.metadata.ymd(new Date(Date.now() - 30 * 86400e3));
    archivePlacements(store, Object.keys(store).filter((d) => d < cut), 'older than 30 days');
};
function writePlacements(body) {
    const date = checkIsoDate(body.date);
    const list = Array.isArray(body.placements) ? body.placements : null;
    if (!list || list.length > 50) throw reqErr('placements must be a list (at most 50 per day).');
    const clean = list.map(cleanPlacement);
    const store = readStore(PLACEMENTS_FILE, () => ({}));
    if (clean.length) store[date] = clean; else delete store[date];
    prunePlacements(store);
    writeStore(PLACEMENTS_FILE, store);
    placeCache.key = null;
    return { date, placements: clean };
}
// The day's playlist was deleted: its placements go to the archive (pins included).
function archiveDayPlacements(body) {
    const date = checkIsoDate(body.date);
    const store = readStore(PLACEMENTS_FILE, () => ({}));
    if (!store[date]) return { date, archived: 0 };
    const n = store[date].length;
    archivePlacements(store, [date], 'playlist deleted');
    writeStore(PLACEMENTS_FILE, store);
    placeCache.key = null;
    return { date, archived: n };
}
// "Remove pin": the placement stays (band, quiet live text) but Generate no longer places it.
function unpinPlacement(body) {
    const date = checkIsoDate(body.date);
    if (!BLOCK_ID_RE.test(String(body.block_id || ''))) throw reqErr('bad block id');
    const start = checkHM(body.start, 'start');
    const store = readStore(PLACEMENTS_FILE, () => ({}));
    let n = 0;
    for (const x of store[date] || []) if (x.block_id === body.block_id && x.start === start) { x.start = null; n++; }
    if (!n) throw reqErr('This pin is no longer there.', 404);
    writeStore(PLACEMENTS_FILE, store);
    placeCache.key = null;
    return { date, unpinned: n, placements: store[date] };
}

// Where each placement's file sequence is in a program: [{ from, to, offset_s } | null]
// (item indexes, inclusive). Files compare without regard to case or slash direction.
// With several matches the one nearest the placement's pinned start (or its recorded
// offset) wins; rows already matched (by an earlier placement, or marked in `taken`) are not used twice. The same
// function is in app.js (bands in the playlist table).
function matchPlacements(program, placements, dayStart = 0, taken = new Uint8Array(program.length)) {
    const norm = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();
    const src = program.map((it) => norm(it && it.source));
    const offs = [];
    let t = 0;
    for (const it of program) { offs.push(t); t += Math.max(0, (Number(it?.out ?? it?.duration) || 0) - (Number(it?.in) || 0)); }
    return placements.map((p) => {
        const seq = (Array.isArray(p?.sources) ? p.sources : []).map(norm);
        if (!seq.length || seq.length > src.length) return null;
        let want = null;
        const m = /^(\d{2}):(\d{2})$/.exec(String(p.start || ''));
        if (m) want = ((Number(m[1]) * 3600 + Number(m[2]) * 60 - dayStart) % 86400 + 86400) % 86400;
        else if (p.offset_s != null && Number.isFinite(Number(p.offset_s))) want = Number(p.offset_s);
        let best = -1, bestD = Infinity;
        outer: for (let i = 0; i + seq.length <= src.length; i++) {
            for (let k = 0; k < seq.length; k++) if (taken[i + k] || src[i + k] !== seq[k]) continue outer;
            if (want === null) { best = i; break; }
            const d = Math.abs(offs[i] - want);
            if (d < bestD) { best = i; bestD = d; }
        }
        if (best < 0) return null;
        for (let k = 0; k < seq.length; k++) taken[best + k] = 1;
        return { from: best, to: best + seq.length - 1, offset_s: offs[best] };
    });
}

function cleanOccasion(body, blockIds) {
    const name = cleanLine(body.name, 80);
    if (!name) throw reqErr('The occasion needs a name.');
    const bs = String(body.branding_set ?? '');
    if (bs && bs !== 'none') R.branding.checkSetName(bs);
    const dates = Array.isArray(body.dates) ? body.dates : [];
    if (dates.length > 200) throw reqErr('At most 200 dates per occasion.');
    const seen = new Set();
    const clean = dates.map((d, i) => {
        const date = checkIsoDate(d?.date, `Date ${i + 1}`);
        if (seen.has(date)) throw reqErr(`${R.metadata.fmtDate(date)} is listed twice.`);
        seen.add(date);
        const pl = Array.isArray(d.placements) ? d.placements : [];
        if (pl.length > 20) throw reqErr(`${R.metadata.fmtDate(date)}: at most 20 blocks per date.`);
        const placements = pl.map((p, k) => {
            if (!blockIds.has(String(p?.block_id))) throw reqErr(`${R.metadata.fmtDate(date)}, block ${k + 1}: choose a saved block.`);
            return { block_id: p.block_id, start: checkHM(p.start, `${R.metadata.fmtDate(date)}, block ${k + 1}: the start`) };
        }).sort((a, b) => a.start.localeCompare(b.start));
        return { date, placements };
    }).sort((a, b) => a.date.localeCompare(b.date));
    return { name, branding_set: bs, notes: cleanNotes(body.notes, 2000), dates: clean };
}
function saveOccasion(body) {
    const fields = cleanOccasion(body, new Set(readBlocks().blocks.map((b) => b.id)));
    const store = readOccasions();
    let o = null;
    if (body.id != null && body.id !== '') {
        if (!OCC_ID_RE.test(String(body.id))) throw reqErr('bad occasion id');
        o = store.occasions.find((x) => x.id === body.id);
        if (!o) throw reqErr('This occasion no longer exists.', 404);
    }
    // One occasion per date (it decides that day's branding set).
    for (const other of store.occasions) {
        if (other === o) continue;
        const clash = fields.dates.find((d) => (other.dates || []).some((x) => x.date === d.date));
        if (clash) throw reqErr(`${R.metadata.fmtDate(clash.date)} is already a date of the occasion "${other.name}".`, 409);
    }
    const now = new Date().toISOString();
    if (o) Object.assign(o, fields, { updated: now });
    else {
        if (store.occasions.length >= 200) throw reqErr('There are already 200 occasions.');
        o = { id: newId('o'), ...fields, created: now, updated: now };
        store.occasions.push(o);
    }
    writeStore(OCCASIONS_FILE, store);
    return { occasion: o };
}
function removeOccasion(id) {
    if (!OCC_ID_RE.test(String(id || ''))) throw reqErr('bad occasion id');
    const store = readOccasions();
    const i = store.occasions.findIndex((o) => o.id === id);
    if (i < 0) throw reqErr('This occasion no longer exists.', 404);
    const arch = readStore(OCCASIONS_ARCHIVE, () => ({ occasions: [] }));
    if (!Array.isArray(arch.occasions)) arch.occasions = [];
    arch.occasions.push({ ...store.occasions[i], removed: new Date().toISOString() });
    writeStore(OCCASIONS_ARCHIVE, arch);
    store.occasions.splice(i, 1);
    writeStore(OCCASIONS_FILE, store);
    return { removed: id, archive: OCCASIONS_ARCHIVE };
}
const occasionOn = (date) => readOccasions().occasions.find((o) => (o.dates || []).some((d) => d.date === date)) || null;

// What Generate / Fill must respect on a date: its occasion (branding set, pinned blocks)
// and blocks pinned there by "Insert at time" (block-placements.json). The occasion wins
// for a block it pins itself. Items: renamed/moved files resolved, missing files dropped.
// Pinned items are never aired silently against the rules: missing files, files hidden on
// Needs attention (the generator never uses them either) and explicit clips outside the
// explicit-language window are always left out; clips not cleared for the date are left out
// when "Only clips with YouTube rights cleared" is on, otherwise kept with a warning. Every
// item left out or kept with a warning is listed in the pin (dropped / warned) for the UI.
const isoName = (s) => `\u2068${s}\u2069`; // keeps a Hebrew name in place inside an English sentence
async function blockPlan(date, dayStart, { requireCleared = false } = {}) {
    const blocks = new Map(readBlocks().blocks.map((b) => [b.id, b]));
    const occ = occasionOn(date);
    const pins = [], problems = [], seen = new Set();
    const add = async (blockId, start, from, label) => {
        const key = `${blockId}|${start}`;
        if (seen.has(key)) return;
        seen.add(key);
        const b = blocks.get(blockId);
        if (!b) { problems.push(`The block "${isoName(label || blockId)}" pinned at ${start} no longer exists (it may be in the blocks archive).`); return; }
        const chk = await refineMissing(checkBlockItems(b.items, { date, start, dayStart }));
        const DROP = new Set(['missing', 'hidden', 'explicit_window', ...(requireCleared ? ['not_cleared'] : [])]);
        const dropped = [], warned = [], keep = [];
        for (const x of chk.items) {
            const out = x.warnings.find((w) => DROP.has(w.type));
            if (out) dropped.push({ index: x.index, title: x.title, type: out.type, text: out.text });
            else {
                for (const w of x.warnings) if (w.type !== 'moved') warned.push({ index: x.index, title: x.title, type: w.type, text: w.text });
                keep.push(x);
            }
        }
        if (!keep.length) { problems.push(`Block "${isoName(b.name)}" at ${start}: every item had to be left out (${[...new Set(dropped.map((d) => d.type))].join(', ')}), so the block was not placed.`); return; }
        const items = keep.map((x) => x.item);
        pins.push({ block_id: b.id, name: b.name, quiet: !!b.quiet, start, from, items, length_s: r3(items.reduce((s, it) => s + itemLen(it), 0)), counts: chk.counts, dropped, warned });
    };
    const occDay = occ ? occ.dates.find((d) => d.date === date) : null;
    for (const p of occDay?.placements || []) await add(p.block_id, p.start, 'occasion');
    const occIds = new Set((occDay?.placements || []).map((p) => p.block_id));
    for (const p of readPlacements()[date] || []) if (p.start && !occIds.has(p.block_id)) await add(p.block_id, p.start, 'placement', p.name);
    // Pins from "Insert at time" on this date (the UI offers Remove pin for each).
    const placementPins = (readPlacements()[date] || []).filter((p) => p.start && !occIds.has(p.block_id)).map((p) => ({ block_id: p.block_id, name: blocks.get(p.block_id)?.name || p.name, start: p.start }));
    return { date, occasion: occ ? { id: occ.id, name: occ.name } : null, branding_set: occ ? occ.branding_set || '' : '', pins, problems, placement_pins: placementPins, placed_n: (readPlacements()[date] || []).length };
}
// Occasion dates from..from+days-1 with each pinned block's file sequence (current paths),
// plus the sequences recorded for it on that date (block-placements.json), for the schedule
// alert "block not in the saved playlist".
function upcomingOccasions(from, days) {
    const to = R.metadata.ymd(new Date(new Date(from + 'T12:00:00').getTime() + (days - 1) * 86400e3));
    const blocks = new Map(readBlocks().blocks.map((b) => [b.id, b]));
    const placed = readPlacements();
    const out = [];
    for (const o of readOccasions().occasions) for (const d of o.dates || []) {
        if (d.date < from || d.date > to) continue;
        const pins = (d.placements || []).map((p) => {
            const b = blocks.get(p.block_id);
            const sources = b ? checkBlockItems(b.items, { date: d.date }).items.filter((x) => !x.warnings.some((w) => w.type === 'missing')).map((x) => x.item.source) : [];
            const alt = (placed[d.date] || []).filter((x) => x.block_id === p.block_id).map((x) => x.sources);
            return { block_id: p.block_id, name: b ? b.name : '(removed block)', start: p.start, sources, alt };
        });
        out.push({ date: d.date, occasion: o.name, pins });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Live text: is the item at `index` of the playing day inside a quiet block? The matching is
// cached per playlist content and placements file, so it is redone only when either changes.
let quietCache = { key: '', set: new Set() };
async function quietItem(date, index, src, dayStart, getProgram) {
    let list;
    try { list = (readPlacements()[date] || []).filter((p) => p.quiet); } catch { return false; }
    if (!list.length) return false;
    const program = await getProgram();
    if (!Array.isArray(program)) return false;
    const it = program[Number(index)];
    const norm = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();
    if (!it || norm(it.source) !== norm(src)) return false;
    const key = `${date}|${placeCache.key}|${crypto.createHash('sha1').update(program.map((x) => `${x?.source}|${x?.in}|${x?.out}`).join('\n')).digest('hex')}`;
    if (quietCache.key !== key) {
        const set = new Set();
        for (const m of matchPlacements(program, list, dayStart)) if (m) for (let i = m.from; i <= m.to; i++) set.add(i);
        quietCache = { key, set };
    }
    return quietCache.set.has(Number(index));
}


// ---- exports (read by the other modules through R.blocks) ----
R.blocks = module.exports;
Object.assign(module.exports, { BLOCKS_FILE, BLOCKS_ARCHIVE, PLACEMENTS_FILE, OCCASIONS_FILE, OCCASIONS_ARCHIVE, BLOCK_ID_RE, OCC_ID_RE, HM_RE, BLOCK_MAX_ITEMS, reqErr, r3, hmToS, cleanLine, cleanNotes, checkIsoDate, checkHM, newId, readStore, writeStore, readBlocks, readOccasions, readPlacements, cleanBlockItems, itemLen, blockSummary, getBlock, saveBlock, markBlockUsed, removeBlock, checkBlockItems, refineMissing, checkBlocks, cleanPlacement, PLACEMENTS_ARCHIVE, archivePlacements, prunePlacements, writePlacements, archiveDayPlacements, unpinPlacement, matchPlacements, cleanOccasion, saveOccasion, removeOccasion, occasionOn, isoName, blockPlan, upcomingOccasions, quietItem });
Object.defineProperty(module.exports, 'placeCache', { get: () => placeCache, set: (v) => { placeCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'quietCache', { get: () => quietCache, set: (v) => { quietCache = v; }, enumerable: true });
