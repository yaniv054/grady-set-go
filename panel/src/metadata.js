// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./registry');

// --- templates (weighted category mix) ---------------------------------------
function readTemplates() {
    try { const j = JSON.parse(fs.readFileSync(R.core.TEMPLATES_FILE, 'utf8')); return Array.isArray(j.templates) ? j.templates : []; } catch { return []; }
}
function writeTemplates(list) {
    if (!Array.isArray(list)) throw Object.assign(new Error('templates must be a list'), { status: 400 });
    const clean = list.slice(0, 50).map((t, i) => {
        const name = String(t.name || '').trim().slice(0, 80);
        if (!name) throw Object.assign(new Error(`Template ${i + 1} needs a name.`), { status: 400 });
        const items = (Array.isArray(t.items) ? t.items : []).map((x) => ({ category: String(x.category || ''), weight: Math.round(Math.max(0, Number(x.weight) || 0)) }))
            .filter((x) => x.weight > 0);
        for (const x of items) if (!CATEGORIES.includes(x.category) || !x.category) throw Object.assign(new Error(`Template "${name}": unknown category ${x.category}`), { status: 400 });
        if (!items.length) throw Object.assign(new Error(`Template "${name}" needs at least one category with a weight.`), { status: 400 });
        return { id: String(t.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || `t${Date.now().toString(36)}${i}`, name, items };
    });
    fs.mkdirSync(R.core.DATA_DIR, { recursive: true });
    if (fs.existsSync(R.core.TEMPLATES_FILE)) fs.copyFileSync(R.core.TEMPLATES_FILE, R.core.TEMPLATES_FILE + '.bak');
    R.core.writeJsonAtomic(R.core.TEMPLATES_FILE, { templates: clean }, 1);
    return clean;
}

// --- clip metadata ----------------------------------------------------------

const META_FIELDS = ['title', 'performer', 'songwriters', 'category', 'rights', 'rights_expires', 'rights_note', 'language', 'tags', 'notes', 'explicit'];
const CATEGORIES = ['', ...R.core.cfg.categories.map((c) => c.code)];
// Display names (same as the panel). CSV import accepts either the code or the display name.
const CATEGORY_LABELS = Object.fromEntries(R.core.cfg.categories.map((c) => [c.code, c.label]));
const CONCERT_CATEGORIES = new Set(R.core.cfg.categories.filter((c) => c.concert).map((c) => c.code));
const CATEGORY_BY_LABEL = new Map(Object.entries(CATEGORY_LABELS).map(([k, v]) => [v.toLowerCase().replace(/\s+/g, ' '), k]));
const RIGHTS = ['unknown', 'cleared', 'blocked'];
// Defaults shown for fields that were never set. A value equal to its default is not stored.
const META_DEFAULTS = { language: 'Hebrew' };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); };

// The store is cached in memory and re-read when the file changes on disk (checked at
// most once a second), so an edit made outside the panel is picked up instead of being
// overwritten by the next save.
let metaStore = null, metaMtime = 0, metaChecked = 0;
function loadMeta() {
    const now = Date.now();
    if (metaStore && now - metaChecked < 1000) return metaStore;
    metaChecked = now;
    let st = null;
    try { st = fs.statSync(R.core.META_FILE); } catch { /* no file yet */ }
    if (!st) {
        // Loaded from disk before and now gone: refuse rather than start empty (the next
        // save would replace the real file).
        if (metaMtime) { metaStore = null; throw Object.assign(new Error(`${R.core.META_FILE} is missing. Restore it from ${R.core.META_FILE}.bak or ${R.core.META_BACKUPS}, the panel picks it up automatically.`), { status: 503 }); }
        if (!metaStore) metaStore = { version: 1, clips: {} };
        return metaStore;
    }
    if (metaStore && st.mtimeMs === metaMtime) return metaStore;
    try {
        const j = JSON.parse(fs.readFileSync(R.core.META_FILE, 'utf8').replace(/^\uFEFF/, ''));
        if (!j || typeof j.clips !== 'object') throw new Error('no clips');
        metaMtime = st.mtimeMs;
        return (metaStore = j);
    } catch {
        metaStore = null;
        // Never start over silently: that would overwrite the real file on the next save.
        throw Object.assign(new Error(`${R.core.META_FILE} is unreadable. Restore it from ${R.core.META_FILE}.bak or ${R.core.META_BACKUPS}, the panel picks it up automatically.`), { status: 503 });
    }
}

function backupMeta(tag) {
    if (!fs.existsSync(R.core.META_FILE)) return;
    fs.mkdirSync(R.core.META_BACKUPS, { recursive: true });
    fs.copyFileSync(R.core.META_FILE, path.join(R.core.META_BACKUPS, `clip-metadata-${R.core.stamp()}-${tag}.json`));
}

function saveMeta() {
    try {
        // Serialised first: a store that cannot be encoded leaves the .bak untouched.
        const text = JSON.stringify(metaStore, null, 1);
        if (fs.existsSync(R.core.META_FILE)) fs.copyFileSync(R.core.META_FILE, R.core.META_FILE + '.bak');
        R.core.writeTextAtomic(R.core.META_FILE, text);
    } catch (e) {
        // The edits are only in memory: drop them so the next read comes from disk again.
        metaStore = null; metaChecked = 0;
        metaMtime = fs.existsSync(R.core.META_FILE) ? -1 : 0;
        throw e;
    }
    metaMtime = fs.statSync(R.core.META_FILE).mtimeMs;
    metaChecked = Date.now();
}

// Stored fields merged over defaults. The title defaults to the file name.
function metaOf(id, row) {
    const m = (id && loadMeta().clips[id]) || {};
    const first = row || (id && (R.media.libraryById().get(id) || [])[0]);
    const title = m.title || (first ? first.file.replace(/\.[^.]+$/, '') : '');
    return { ...Object.fromEntries(META_FIELDS.map((f) => [f, ''])), rights: 'unknown', ...META_DEFAULTS, ...m, title };
}

// Israeli display format dd/mm/yy (stored dates stay YYYY-MM-DD).
const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso || ''); };
const isCleared = (m, date) => m.rights === 'cleared' && (!m.rights_expires || m.rights_expires >= date);

// Accepts YYYY-MM-DD, or D/M/YY(YY), D.M.YY(YY), D-M-YY(YY) (Israeli order; two-digit years are 20xx).
function normDate(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    let y, mo, d;
    if (m) [, y, mo, d] = m;
    else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) { [, d, mo, y] = m; if (y.length === 2) y = '20' + y; }
    else return null;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const t = new Date(iso + 'T12:00:00Z');
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

// Validates and normalises the fields present in `input`; unknown keys are ignored.
function cleanFields(input) {
    const out = {};
    for (const f of META_FIELDS) {
        if (!(f in input)) continue;
        let v = String(input[f] ?? '').trim().slice(0, 1000);
        if (f === 'category') { v = v.toLowerCase().replace(/\s+/g, ' '); v = CATEGORY_BY_LABEL.get(v) || v; if (!CATEGORIES.includes(v)) throw Object.assign(new Error(`category must be one of: ${CATEGORIES.filter(Boolean).join(', ')} (or empty)`), { status: 400 }); }
        if (f === 'rights') { v = v.toLowerCase() || 'unknown'; if (!RIGHTS.includes(v)) throw Object.assign(new Error(`rights must be one of: ${RIGHTS.join(', ')}`), { status: 400 }); }
        if (f === 'explicit') v = ['yes', 'y', 'true', '1', 'x', 'explicit', 'כן'].includes(v.toLowerCase()) ? 'yes' : '';
        if (f === 'rights_expires') { const d = normDate(v); if (d === null) throw Object.assign(new Error(`rights_expires "${v}" is not a date (use dd/mm/yy)`), { status: 400 }); v = d; }
        out[f] = v;
    }
    return out;
}

// Applies cleaned fields to one clip. Returns true if anything changed.
function applyFields(id, fields) {
    const store = loadMeta();
    const cur = store.clips[id] || {};
    const next = { ...cur };
    for (const [k, v] of Object.entries(fields)) { if (v === '' || v === META_DEFAULTS[k]) delete next[k]; else next[k] = v; }
    if (next.rights === 'unknown') delete next.rights;
    const changed = META_FIELDS.some((f) => (cur[f] || '') !== (next[f] || ''));
    if (!changed) return false;
    const { updated, ...rest } = next;
    if (Object.keys(rest).length) store.clips[id] = { ...rest, updated: new Date().toISOString() };
    else delete store.clips[id];
    return true;
}

function clipView(id, rows, date) {
    const first = rows[0];
    const m = metaOf(id, first);
    return {
        id, path: first.path, folder: first.folder, file: first.file, copies: rows.length, size: Number(first.size_bytes) || 0,
        // Identical copies elsewhere (same content, so the same size), for the clip details.
        ...(rows.length > 1 ? { other_copies: rows.slice(1, 20).map((r) => ({ path: r.path, size: Number(r.size_bytes) || 0 })) } : {}),
        ext: path.extname(first.file).slice(1).toLowerCase(),
        duration: Number(first.duration_s) || 0, res: first.width ? `${first.width}x${first.height}` : '', aspect: R.media.aspectOf(first.width, first.height), fps: Number(first.fps) || null,
        conform: first.needs_conform === 'yes', issues: first.issues || '',
        ...m, cleared: isCleared(m, date), expired: m.rights === 'cleared' && !!m.rights_expires && m.rights_expires < date,
        docs: R.librarytools.docCounts().get(id) || 0,
        an: R.analysis.analysisSummary(id),
        thumb: R.attention.thumbIds().has(id),
    };
}

function listClips(q) {
    const date = today();
    // File types come from the type filter and from ".mxf" / "type:mxf" words in the search text.
    const types = new Set(String(q.get('type') || '').toLowerCase().split(',').map((t) => t.trim().replace(/^\./, '')).filter(Boolean));
    const words = [];
    for (const w of String(q.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
        const m = /^(?:\.|type:)([a-z0-9]{2,5})$/.exec(w);
        if (m && R.core.VIDEO_EXT.has('.' + m[1])) types.add(m[1]); else words.push(w);
    }
    const text = words.join(' ');
    const folder = String(q.get('folder') || '');
    const rights = String(q.get('rights') || '');
    const category = String(q.get('category') || '');
    const issue = String(q.get('issue') || '');
    const aspect = String(q.get('aspect') || '');
    const explicit = String(q.get('explicit') || '');
    // issue=hidden lists only clips hidden on the Needs attention page; otherwise they are left out.
    const onlyHidden = issue === 'hidden';
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100));
    const all = [], folders = new Set(), extCounts = {};
    const sum = { clips: 0, hours: 0, cleared: 0, cleared_hours: 0, blocked: 0, unknown: 0, expired: 0, checked: 0, problems: 0, hidden: 0 };
    const H = R.attention.hiddenIndex();
    for (const [id, all_rows] of R.media.libraryById()) {
        const vis = R.attention.visibleRows(all_rows, H);
        if (!vis.length) { sum.hidden++; if (!onlyHidden) continue; }
        const rows = vis.length ? vis : all_rows;
        const c = clipView(id, rows, date);
        c.hidden = !vis.length;
        c.hidden_copies = all_rows.length - vis.length;
        const top = (c.folder || '').split(/[\\/]/)[0];
        if (c.hidden) { if (folder && top !== folder) continue; all.push(c); continue; }
        if (top) folders.add(top);
        if (c.ext) extCounts[c.ext] = (extCounts[c.ext] || 0) + 1;
        sum.clips++; sum.hours += c.duration / 3600;
        if (c.cleared) { sum.cleared++; sum.cleared_hours += c.duration / 3600; }
        else if (c.expired) sum.expired++;
        else if (c.rights === 'blocked') sum.blocked++;
        else sum.unknown++;
        if (c.an.checked) { sum.checked++; if (c.an.flags.some((f) => R.analysis.PROBLEM_FLAGS.has(f))) sum.problems++; }
        if (onlyHidden) continue;
        if (folder && top !== folder) continue;
        if (issue && !onlyHidden && !R.analysis.matchIssue(c.an, issue)) continue;
        if (types.size && !types.has(c.ext)) continue;
        if (aspect && (aspect === 'not169' ? c.aspect === '16:9' : c.aspect !== aspect)) continue;
        if (explicit === 'yes' && c.explicit !== 'yes') continue;
        if (explicit === 'no' && c.explicit === 'yes') continue;
        if (category && (category === '-' ? c.category : c.category !== category)) continue;
        if (rights === 'cleared' && !c.cleared) continue;
        if (rights === 'expired' && !c.expired) continue;
        if (rights === 'blocked' && c.rights !== 'blocked') continue;
        if (rights === 'unknown' && (c.rights !== 'unknown')) continue;
        if (rights === 'cleared-nodoc' && !(c.cleared && !c.docs)) continue;
        if (text && ![c.file, c.folder, c.title, c.performer, c.songwriters, c.tags, c.notes].some((v) => String(v || '').toLowerCase().includes(text))) continue;
        all.push(c);
    }
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
    // Sorting: sort=title|folder|type|duration|category|rights, dir=asc|desc. Without a
    // sort the list is in folder, then file order (also the tie-breaker).
    const base = (a, b) => cmp(a.folder, b.folder) || cmp(a.file, b.file);
    const RIGHTS_RANK = (c) => (c.cleared ? 0 : c.expired ? 1 : c.rights === 'blocked' ? 3 : 2);
    const KEYS = {
        title: (a, b) => cmp(a.title, b.title),
        folder: base,
        type: (a, b) => cmp(a.ext, b.ext),
        duration: (a, b) => a.duration - b.duration,
        // Clips without a category sort last in ascending order.
        category: (a, b) => (!a.category - !b.category) || cmp(CATEGORY_LABELS[a.category] || '', CATEGORY_LABELS[b.category] || ''),
        rights: (a, b) => RIGHTS_RANK(a) - RIGHTS_RANK(b),
    };
    const key = KEYS[String(q.get('sort') || '')];
    const dir = q.get('dir') === 'desc' ? -1 : 1;
    all.sort(key ? (a, b) => (dir * key(a, b)) || base(a, b) : base);
    sum.hours = Number(sum.hours.toFixed(1)); sum.cleared_hours = Number(sum.cleared_hours.toFixed(1));
    return { total: all.length, offset, rows: all.slice(offset, offset + limit), ids: all.map((c) => c.id), summary: sum, folders: [...folders].sort(cmp), types: Object.entries(extCounts).sort((a, b) => b[1] - a[1]).map(([ext, n]) => ({ ext, clips: n })), categories: CATEGORIES.filter(Boolean), rights: RIGHTS };
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// "documents" (number of attached release documents) is informational; import ignores it.
const EXPORT_COLS = ['id', 'folder', 'file', 'duration', 'copies', ...META_FIELDS, 'documents', 'path'];
function exportCsv() {
    const date = today();
    const cmp = new Intl.Collator(undefined, { numeric: true }).compare;
    const rows = [...R.media.libraryById()].map(([id, rows]) => clipView(id, rows, date)).sort((a, b) => cmp(a.folder, b.folder) || cmp(a.file, b.file));
    const lines = rows.map((c) => EXPORT_COLS.map((k) => csvCell(k === 'duration' ? fmtHms(c.duration) : k === 'rights' && c.rights === 'unknown' ? '' : k === 'rights_expires' ? fmtDate(c[k]) : k === 'documents' ? c.docs : c[k])).join(','));
    return '\uFEFF' + [EXPORT_COLS.join(','), ...lines].join('\r\n') + '\r\n';
}
function fmtHms(sec) { sec = Math.round(sec || 0); const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`; }

// Import edited metadata. Only metadata columns are read; media files are never touched.
// All-or-nothing: any invalid row rejects the whole import. A dry run reports what would change.
function importCsv(text, dryRun) {
    const rows = R.library.parseCsv(String(text || '').replace(/^\uFEFF/, ''));
    if (!rows.length) throw Object.assign(new Error('The file has no data rows.'), { status: 400 });
    const head = Object.keys(rows[0]);
    if (head.length === 1 && head[0].includes(';')) throw Object.assign(new Error('The file is separated by semicolons. In Excel use Save As → "CSV UTF-8 (Comma delimited)".'), { status: 400 });
    if (!head.includes('id')) throw Object.assign(new Error('The file has no "id" column. Start from an exported CSV.'), { status: 400 });
    const cols = META_FIELDS.filter((f) => head.includes(f));
    if (!cols.length) throw Object.assign(new Error('The file has no metadata columns to import.'), { status: 400 });
    const byId = R.media.libraryById();
    const errors = [], updates = [];
    let unknown = 0;
    rows.forEach((r, i) => {
        const id = String(r.id || '').trim();
        if (!id) return;
        if (!byId.has(id) && !loadMeta().clips[id]) { unknown++; return; }
        try {
            const fields = cleanFields(Object.fromEntries(cols.map((c) => [c, c === 'title' && r.title === (byId.get(id)?.[0]?.file || '').replace(/\.[^.]+$/, '') ? '' : r[c]])));
            updates.push([id, fields]);
        } catch (e) { if (errors.length < 50) errors.push(`Row ${i + 2}: ${e.message}`); }
    });
    if (errors.length) return { applied: false, errors, rows: rows.length, unknown_ids: unknown, columns: cols };
    // Compute changes against a copy so a dry run leaves the store untouched.
    const store = loadMeta();
    const before = JSON.stringify(store.clips);
    let changed = 0;
    for (const [id, f] of updates) if (applyFields(id, f)) changed++;
    if (dryRun || !changed) { store.clips = JSON.parse(before); return { applied: false, dry_run: !!dryRun, rows: rows.length, matched: updates.length, changed, unknown_ids: unknown, columns: cols, errors: [] }; }
    backupMeta('before-import');
    saveMeta();
    return { applied: true, rows: rows.length, matched: updates.length, changed, unknown_ids: unknown, columns: cols, errors: [] };
}

// Which of these playlist sources are not cleared for `date`?
function checkSources(sources, date) {
    const byPath = R.media.library();
    const out = [];
    for (const src of sources) {
        if (R.asrun.STORAGE_KIND(src)) continue; // channel files (slates, branding): no rights to check
        const row = byPath.get(String(src).toLowerCase());
        if (!row) { out.push({ source: src, reason: 'not in library.csv' }); continue; }
        const m = metaOf(row.id, row);
        if (!isCleared(m, date)) out.push({ source: src, reason: m.rights === 'cleared' ? `rights expired ${fmtDate(m.rights_expires)}` : `rights ${m.rights}` });
    }
    return out;
}


// ---- exports (read by the other modules through R.metadata) ----
R.metadata = module.exports;
Object.assign(module.exports, { readTemplates, writeTemplates, META_FIELDS, CATEGORIES, CATEGORY_LABELS, CONCERT_CATEGORIES, CATEGORY_BY_LABEL, RIGHTS, META_DEFAULTS, ymd, today, yesterday, loadMeta, backupMeta, saveMeta, metaOf, fmtDate, isCleared, normDate, cleanFields, applyFields, clipView, listClips, csvCell, EXPORT_COLS, exportCsv, fmtHms, importCsv, checkSources });
Object.defineProperty(module.exports, 'metaStore', { get: () => metaStore, set: (v) => { metaStore = v; }, enumerable: true });
Object.defineProperty(module.exports, 'metaMtime', { get: () => metaMtime, set: (v) => { metaMtime = v; }, enumerable: true });
Object.defineProperty(module.exports, 'metaChecked', { get: () => metaChecked, set: (v) => { metaChecked = v; }, enumerable: true });
