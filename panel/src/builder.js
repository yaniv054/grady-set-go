// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./registry');

// --- block builder: search, item details, related media, length-fill suggestions --------
// Read-only helpers for the two-pane Block builder (blocks and whole days). Library rows,
// clip metadata, the as-run archive, saved playlists and saved blocks are only read.

// Lengths typed by the editor: 90 (seconds), 5m, 2h, 90s, 3:40, 1:02:03 -> seconds.
function parseLenS(v) {
    const s = String(v ?? '').trim().toLowerCase();
    let m;
    if ((m = /^(\d+(?:\.\d+)?)\s*(h|m|min|s)?$/.exec(s))) return Number(m[1]) * ({ h: 3600, m: 60, min: 60, s: 1 }[m[2]] || 1);
    if ((m = /^(?:(\d+):)?(\d{1,3}):(\d{2}(?:\.\d+)?)$/.exec(s))) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return null;
}
// Last date each clip aired (as-run archive), rebuilt when the archive changes (checked at most every 60 s).
// Each month file is read once and kept until it changes (the 5-minute as-run sync only
// touches the current month).
let airedCache = { key: null, at: 0, map: new Map() };
const airedMonths = new Map();
function lastAiredIndex() {
    if (Date.now() - airedCache.at < 60000) return airedCache.map;
    airedCache.at = Date.now();
    let files = [];
    try { files = fs.readdirSync(R.core.ASRUN_DIR).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { /* none yet */ }
    const sigs = files.map((f) => { try { const st = fs.statSync(path.join(R.core.ASRUN_DIR, f)); return `${st.size}:${st.mtimeMs}`; } catch { return ''; } });
    const key = files.map((f, i) => `${f}:${sigs[i]}`).join('|');
    if (key === airedCache.key) return airedCache.map;
    for (const f of [...airedMonths.keys()]) if (!files.includes(f)) airedMonths.delete(f);
    files.forEach((f, i) => {
        if (airedMonths.get(f)?.sig === sigs[i]) return;
        const m = new Map();
        for (const e of R.asrun.readAsrunMonth(f.slice(0, 7))) {
            const id = e.id || R.media.idForPath(e.source);
            if (id && e.aired_s >= 30 && (!m.has(id) || m.get(id) < e.date)) m.set(id, e.date);
        }
        airedMonths.set(f, { sig: sigs[i], map: m });
    });
    const map = new Map();
    for (const f of files) for (const [id, d] of airedMonths.get(f).map) if (!map.has(id) || map.get(id) < d) map.set(id, d);
    airedCache = { key, at: Date.now(), map };
    return map;
}
// Builder rows with their last-aired date (looked up when sent, so the cached pools do not
// depend on the as-run archive unless a filter or the sort uses it).
const withAired = (rows) => { const a = lastAiredIndex(); return rows.map((c) => ({ ...c, last_aired: a.get(c.id) || null })); };
const daysBefore = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
// Explicit clips may air from explicit_after until the broadcast day starts (no rule = any time).
function explicitAllowed(rules, dayStart, fromS, lenS = 0) {
    const ex = R.blocks.hmToS(rules.explicit_after);
    if (ex === null) return true;
    const ok = (t) => { t = ((t % 86400) + 86400) % 86400; return ex > dayStart ? (t >= ex || t < dayStart) : (t >= ex && t < dayStart); };
    return ok(fromS) && ok(fromS + Math.max(0, lenS - 1));
}
// One clip as the builder lists it.
function bldClip(id, rows, date, aired) {
    const first = rows[0];
    const m = R.metadata.metaOf(id, first);
    const an = R.analysis.analysisSummary(id);
    return {
        id, path: first.path, folder: first.folder, file: first.file, title: m.title, performer: m.performer, category: m.category, language: m.language, tags: m.tags,
        duration: Number(first.duration_s) || 0, size: Number(first.size_bytes) || 0, aspect: R.media.aspectOf(first.width, first.height), conform: first.needs_conform === 'yes',
        rights: m.rights, cleared: R.metadata.isCleared(m, date), explicit: m.explicit === 'yes', thumb: R.attention.thumbIds().has(id),
        mtime: first.mtime || null, ...(aired ? { last_aired: aired.get(id) || null } : {}), checked: an.checked, problems: an.flags.some((f) => R.analysis.PROBLEM_FLAGS.has(f)),
    };
}
// Search filters (query or JSON body). Typed tokens in q: cat:<category> len:<5m len:>2m
// explicit:yes|no aired:>14d (not aired in 14 days) aired:<7d (aired within 7 days).
function builderFilters(src) {
    const get = (k) => (typeof src.get === 'function' ? src.get(k) : src[k]);
    const f = { words: [], cat: String(get('cat') || ''), cleared: String(get('cleared') || '') === '1', wide: String(get('wide') || '') === '1',
        explicit: String(get('explicit') || ''), an: String(get('an') || ''), min: parseLenS(get('min')), max: parseLenS(get('max')),
        notAired: Math.max(0, Number(get('notaired')) || 0), airedWithin: 0 };
    for (const w of String(get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
        let m;
        if ((m = /^cat:(.+)$/.exec(w))) { const v = m[1].replace(/_/g, ' '); f.cat = R.metadata.CATEGORY_BY_LABEL.get(v) || (R.metadata.CATEGORIES.includes(v) ? v : [...R.metadata.CATEGORY_BY_LABEL].find(([l]) => l.includes(v))?.[1] || v); }
        else if ((m = /^len:([<>])(.+)$/.exec(w)) && parseLenS(m[2]) !== null) { if (m[1] === '<') f.max = parseLenS(m[2]); else f.min = parseLenS(m[2]); }
        else if ((m = /^explicit:(yes|no)$/.exec(w))) f.explicit = m[1];
        else if ((m = /^aired:([<>])(\d+)d?$/.exec(w))) { if (m[1] === '>') f.notAired = Number(m[2]); else f.airedWithin = Number(m[2]); }
        else f.words.push(w);
    }
    return f;
}
// Library clips matching the filters (hidden files always left out), as builder rows.
function builderPool(f, date) {
    const H = R.attention.hiddenIndex(), aired = f.notAired || f.airedWithin ? lastAiredIndex() : null;
    const notSince = f.notAired ? daysBefore(date, f.notAired) : null, within = f.airedWithin ? daysBefore(date, f.airedWithin) : null;
    const out = [];
    for (const [id, all] of R.media.libraryById()) {
        const rows = R.attention.visibleRows(all, H);
        if (!rows.length) continue;
        const c = bldClip(id, rows, date, null);
        if (c.duration < 1) continue;
        if (f.cat && (f.cat === '-' ? c.category : c.category !== f.cat)) continue;
        if (f.cleared && !c.cleared) continue;
        if (f.wide && c.aspect !== '16:9') continue;
        if (f.explicit === 'yes' && !c.explicit) continue;
        if (f.explicit === 'no' && c.explicit) continue;
        if (f.an === 'ok' && (!c.checked || c.problems)) continue;
        if (f.an === 'problems' && !c.problems) continue;
        if (f.an === 'skip' && R.analysis.hasSkipIssue(id)) continue;
        if (f.min !== null && c.duration < f.min) continue;
        if (f.max !== null && c.duration > f.max) continue;
        if (notSince && aired.get(id) && aired.get(id) > notSince) continue;
        if (within && !(aired.get(id) > within)) continue;
        if (f.words.length) {
            const hay = [c.title, c.performer, R.metadata.metaOf(id, rows[0]).songwriters, c.tags, c.folder, c.file].join('\n').toLowerCase();
            if (!f.words.every((w) => hay.includes(w))) continue;
        }
        out.push(c);
    }
    return out;
}
// Filtered (and for the search, sorted) pools are kept for 10 s per filters + date (+ sort),
// so paging and scrolling do not scan the library again. A library reload, a hide/unhide,
// a metadata edit or a new as-run entry gives a new key. Callers must not change the rows.
const poolCache = new Map();
function cachedPool(f, date, sortKey, build) {
    R.attention.hiddenIndex();
    R.metadata.loadMeta();
    const usesAired = !!(f.notAired || f.airedWithin || String(sortKey).startsWith('aired'));
    if (usesAired) lastAiredIndex();
    const key = JSON.stringify([f, date, sortKey, R.media.libCache.mtime, R.attention.attnVer, R.metadata.metaMtime, usesAired ? airedCache.key : '']);
    const hit = poolCache.get(key);
    if (hit && Date.now() - hit.at < 10000) return hit.rows;
    for (const [k, v] of poolCache) if (Date.now() - v.at >= 10000) poolCache.delete(k);
    const rows = build();
    poolCache.set(key, { at: Date.now(), rows });
    if (poolCache.size > 30) poolCache.delete(poolCache.keys().next().value);
    return rows;
}
const builderPoolCached = (f, date) => cachedPool(f, date, '', () => builderPool(f, date));
function builderSearch(q) {
    const date = q.get('date') ? R.blocks.checkIsoDate(q.get('date')) : R.metadata.today();
    const f = builderFilters(q);
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
    const dir = q.get('dir') === 'desc' ? -1 : 1;
    const KEYS = { title: (a, b) => cmp(a.title, b.title), length: (a, b) => a.duration - b.duration, date: (a, b) => String(a.mtime || '').localeCompare(String(b.mtime || '')), aired: (a, b) => { const x = lastAiredIndex(); return String(x.get(a.id) || '').localeCompare(String(x.get(b.id) || '')); } };
    const sk = KEYS[q.get('sort')] ? q.get('sort') : 'title';
    const key = KEYS[sk];
    const all = cachedPool(f, date, `${sk}|${dir}`, () => builderPoolCached(f, date).slice().sort((a, b) => dir * key(a, b) || cmp(a.title, b.title)));
    const offset = Math.max(0, Number(q.get('offset')) || 0), limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 100));
    return { date, total: all.length, offset, rows: withAired(all.slice(offset, offset + limit)) };
}
// Details for the items of the builder list (rights for the check date, flags).
function builderInfo(body) {
    const date = body.date ? R.blocks.checkIsoDate(body.date) : R.metadata.today();
    const sources = Array.isArray(body.sources) ? body.sources.slice(0, 5000) : [];
    const H = R.attention.hiddenIndex(), out = {};
    for (const src of sources) {
        const s = String(src || '');
        if (!s) continue;
        if (R.asrun.STORAGE_KIND(s)) { out[s] = { storage: true, brand: R.branding.brandTypeOf(s), missing: !fs.existsSync(s), title: path.basename(s).replace(/\.[^.]+$/, '') }; continue; }
        const row = R.media.library().get(s.toLowerCase());
        if (!row) { const cur = R.media.rowForId(R.media.pathHistory()[s.toLowerCase()]?.id); out[s] = { missing: true, moved_to: cur ? cur.path : null, title: path.basename(s).replace(/\.[^.]+$/, '') }; continue; }
        const m = R.metadata.metaOf(row.id, row);
        out[s] = { id: row.id, title: m.title, performer: m.performer, duration: Number(row.duration_s) || null, size: Number(row.size_bytes) || 0, cleared: R.metadata.isCleared(m, date), rights: m.rights,
            explicit: m.explicit === 'yes', hidden: R.attention.isHiddenIn(H, row.path), conform: row.needs_conform === 'yes', aspect: R.media.aspectOf(row.width, row.height), thumb: R.attention.thumbIds().has(row.id) };
    }
    return { date, items: out };
}

// Related media. Co-occurrence: clips aired next to each other on the same day (as-run
// archive) or next to each other in a saved playlist (channel files in between are
// skipped), over the last 180 days, and clips saved together in a block. Each as-run month
// and playlist file is parsed once and kept (with its pairs) until it changes; the combined
// counts are updated by taking out a changed file's old pairs and adding its new ones, so
// the as-run sync appending to this month re-reads that one file only. Checked at most
// once a minute.
const REL_DAYS = 180;
const relFiles = new Map();
let relCache = { sig: null, at: 0, co: new Map(), blocks: new Map(), blocksKey: null };
function relBump(co, a, b, d) {
    for (const [x, y] of [[a, b], [b, a]]) {
        let m = co.get(x);
        if (!m) { if (d < 0) continue; co.set(x, (m = new Map())); }
        const n = (m.get(y) || 0) + d;
        if (n > 0) m.set(y, n); else { m.delete(y); if (!m.size) co.delete(x); }
    }
}
const pairsOf = (ids) => { const out = []; for (let i = 1; i < ids.length; i++) if (ids[i - 1] !== ids[i]) out.push([ids[i - 1], ids[i]]); return out; };
function relatedIndex() {
    if (relCache.sig !== null && Date.now() - relCache.at < 60e3) return relCache;
    relCache.at = Date.now();
    const cutoff = daysBefore(R.metadata.today(), REL_DAYS);
    const want = new Map(); // file -> { sig, kind }
    try {
        for (const f of fs.readdirSync(R.core.ASRUN_DIR)) {
            if (!/^\d{4}-\d{2}\.jsonl$/.test(f) || f.slice(0, 7) < cutoff.slice(0, 7)) continue;
            const st = fs.statSync(path.join(R.core.ASRUN_DIR, f));
            // The month the window starts in is read again when the window moves on.
            want.set(path.join(R.core.ASRUN_DIR, f), { kind: 'asrun', sig: `${st.size}:${st.mtimeMs}:${f.slice(0, 7) === cutoff.slice(0, 7) ? cutoff : ''}` });
        }
    } catch { /* none */ }
    forEachPlaylistFile((f, st, full) => { if (f.slice(0, 10) >= cutoff) want.set(full, { kind: 'pl', sig: `${st.size}:${st.mtimeMs}` }); });
    let bkey = 'none';
    try { bkey = String(fs.statSync(R.blocks.BLOCKS_FILE).mtimeMs); } catch { /* none */ }
    const sig = [...want].map(([f, x]) => `${f}:${x.sig}`).join('|') + `|b:${bkey}`;
    if (sig === relCache.sig) return relCache;
    const co = relCache.co;
    for (const [f, old] of relFiles) {
        const w = want.get(f);
        if (w && w.sig === old.sig) continue;
        for (const [x, y] of old.pairs) relBump(co, x, y, -1);
        relFiles.delete(f);
    }
    for (const [f, w] of want) {
        if (relFiles.has(f)) continue;
        let pairs = [];
        try {
            if (w.kind === 'asrun') {
                const byDay = new Map();
                for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
                    if (!l) continue;
                    let e; try { e = JSON.parse(l); } catch { continue; }
                    if (!e || e.date < cutoff) continue;
                    if (!byDay.has(e.date)) byDay.set(e.date, []);
                    byDay.get(e.date).push(e);
                }
                for (const list of byDay.values()) { list.sort((a, b) => a.at - b.at); pairs.push(...pairsOf(list.map((e) => (R.asrun.STORAGE_KIND(e.source) ? null : e.id || R.media.idForPath(e.source))).filter(Boolean))); }
            } else {
                const pl = JSON.parse(fs.readFileSync(f, 'utf8'));
                pairs = pairsOf((pl?.program || []).map((it) => String(it?.source || '')).map((src) => (src && !R.asrun.STORAGE_KIND(src) ? R.media.idForPath(src) : null)).filter(Boolean));
            }
        } catch { pairs = []; }
        for (const [x, y] of pairs) relBump(co, x, y, 1);
        relFiles.set(f, { sig: w.sig, pairs });
    }
    let blocks = relCache.blocks;
    if (bkey !== relCache.blocksKey) {
        blocks = new Map();
        try {
            for (const bl of R.blocks.readBlocks().blocks) {
                const ids = [...new Set(bl.items.map((it) => it.clip_id || R.media.idForPath(it.source)).filter(Boolean))];
                for (const id of ids) { if (!blocks.has(id)) blocks.set(id, new Set()); blocks.get(id).add(bl.name); }
            }
        } catch { /* blocks file unreadable: no block reasons */ }
    }
    relCache = { sig, at: Date.now(), co, blocks, blocksKey: bkey };
    return relCache;
}
function forEachPlaylistFile(fn) {
    let years = [];
    try { years = fs.readdirSync(R.core.PLAYLISTS_DIR).filter((y) => /^\d{4}$/.test(y)); } catch { return; }
    for (const y of years) {
        let months = [];
        try { months = fs.readdirSync(path.join(R.core.PLAYLISTS_DIR, y)).filter((m) => /^\d{2}$/.test(m)); } catch { continue; }
        for (const m of months) {
            let names = [];
            try { names = fs.readdirSync(path.join(R.core.PLAYLISTS_DIR, y, m)).filter((f) => /\.json$/.test(f)); } catch { continue; }
            for (const f of names) { const full = path.join(R.core.PLAYLISTS_DIR, y, m, f); try { fn(f, fs.statSync(full), full); } catch { /* gone */ } }
        }
    }
}
const STOP_WORDS = new Set(['the', 'and', 'full', 'song', 'live', 'final', 'mp4', 'mov', 'clip', 'version', 'edit', 'new', 'של', 'את', 'עם', 'גרסה']);
const titleWords = (t) => new Set(String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP_WORDS.has(w)));
const seriesOf = (folder) => String(folder || '').split(/[\\/]/).filter(Boolean).slice(0, 2).join('/').toLowerCase();
// Title words and tags of a builder clip, worked out once per clip object.
const wordSet = (c) => c._words || Object.defineProperty(c, '_words', { value: titleWords(c.title) })._words;
const tagSet = (c) => c._tags || Object.defineProperty(c, '_tags', { value: new Set(String(c.tags || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) })._tags;
// How a candidate clip relates to one reference clip: { score, reasons }.
function relation(ref, c, idx) {
    let score = 0;
    const reasons = [];
    const n = idx.co.get(ref.id)?.get(c.id) || 0;
    if (n) { score += 6 * Math.min(n, 5); reasons.push(`Aired next to it ${n}×`); }
    const rb = idx.blocks.get(ref.id), cb = idx.blocks.get(c.id);
    if (rb && cb) { const common = [...rb].filter((x) => cb.has(x)); if (common.length) { score += 4 * Math.min(common.length, 2); reasons.push(...common.slice(0, 2).map((x) => `In block “${x}”`)); } }
    if (ref.performer && c.performer && ref.performer.trim().toLowerCase() === c.performer.trim().toLowerCase()) { score += 8; reasons.push('Same performer'); }
    const rt = tagSet(ref), shared = [...tagSet(c)].filter((x) => rt.has(x));
    if (shared.length) { score += 2 * Math.min(shared.length, 3); reasons.push(`Shared tags: ${shared.slice(0, 3).join(', ')}`); }
    if (ref.folder && seriesOf(ref.folder) === seriesOf(c.folder)) { score += ref.folder === c.folder ? 3 : 2; reasons.push(ref.folder === c.folder ? 'Same folder' : 'Same series'); }
    const rw = wordSet(ref), kw = [...wordSet(c)].filter((w) => rw.has(w));
    if (kw.length) { score += 1.5 * Math.min(kw.length, 2); reasons.push(`Title: ${kw.slice(0, 2).join(', ')}`); }
    if (ref.category && ref.category === c.category) { score += 1; reasons.push('Same category'); }
    if (score && ref.language && ref.language === c.language) { score += 0.3; reasons.push('Same language'); }
    return { score, reasons };
}
// q: URLSearchParams (GET, exclude as a comma list) or a JSON body (POST, exclude as a list).
function builderRelated(q) {
    const get = (k) => (typeof q.get === 'function' ? q.get(k) : q[k]);
    const id = String(get('id') || '');
    if (!R.librarytools.CLIP_ID_RE.test(id)) throw R.blocks.reqErr('bad clip id');
    const date = get('date') ? R.blocks.checkIsoDate(get('date')) : R.metadata.today();
    const limit = Math.min(100, Math.max(1, Number(get('limit')) || 30));
    const ex = get('exclude');
    const exclude = new Set((Array.isArray(ex) ? ex : String(ex || '').split(',')).map(String).filter(Boolean).slice(0, 5000));
    const aired = lastAiredIndex(), idx = relatedIndex();
    const refRows = R.media.libraryById().get(id);
    if (!refRows) throw R.blocks.reqErr('This clip is not in the library.', 404);
    const ref = bldClip(id, refRows, date, aired);
    const out = [];
    // Every visible clip with a length (the cached unfiltered pool).
    for (const c of builderPoolCached(builderFilters({}), date)) {
        if (c.id === id || exclude.has(c.id)) continue;
        const r = relation(ref, c, idx);
        if (r.score >= 2) out.push({ ...c, score: Math.round(r.score * 10) / 10, reasons: r.reasons });
    }
    out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return { id, date, rows: withAired(out.slice(0, limit)) };
}

// Length fill: clips (single, or 2–3 together) that fill `gap_s` without going over and at
// most `tol_s` short, plus clips that fit once only their silent/black head or tail is
// trimmed (the analysis trim suggestion; never into content). Filtered like the search
// (rights for the date, 16:9, recently aired, explicit window at that clock time, hidden
// always out) and ranked by relevance to the clips already in the list.
function builderFill(body) {
    const date = body.date ? R.blocks.checkIsoDate(body.date) : R.metadata.today();
    const gap = Number(body.gap_s), tol = Math.min(600, Math.max(0, Number(body.tol_s ?? 10)));
    if (!Number.isFinite(gap) || gap < 1 || gap > 86400) throw R.blocks.reqErr('The length to fill must be between 1 second and 24 hours.');
    const ds = Number(body.day_start_s);
    const dayStart = Number.isFinite(ds) && ds >= 0 && ds < 86400 ? ds : 0;
    const clock = Number.isFinite(Number(body.clock_s)) ? Number(body.clock_s) : null;
    const f = builderFilters(body.filters && typeof body.filters === 'object' ? body.filters : {});
    const exclude = new Set(Array.isArray(body.exclude_ids) ? body.exclude_ids.map(String) : []);
    const rules = R.branding.readBrandRules(), idx = relatedIndex();
    const lo = gap - tol, hi = gap + 0.01;
    // Copies: the cached pool rows are shared and are not changed here.
    const pool = builderPoolCached(f, date).filter((c) => !exclude.has(c.id) && (!c.explicit || clock === null || explicitAllowed(rules, dayStart, clock, gap))).map((c) => ({ ...c, rel: 0, reasons: [] }));
    // Relevance to the last 10 clips of the list, only for clips that can be used whole
    // (not longer than the gap); trim candidates are ranked by length only.
    const ctx = (Array.isArray(body.context_ids) ? body.context_ids : []).map(String).filter((x) => R.media.libraryById().has(x)).slice(-10);
    const aired = lastAiredIndex();
    const refs = ctx.map((id) => bldClip(id, R.media.libraryById().get(id), date, aired));
    if (refs.length) for (const c of pool) {
        if (c.duration > hi) continue;
        let s = 0;
        const why = new Set();
        for (const r of refs) { const x = relation(r, c, idx); s += x.score; for (const w of x.reasons) if (!/^Same language/.test(w)) why.add(w.replace(/ \d+×$/, '')); }
        c.rel = Math.round(s * 10) / 10;
        c.reasons = [...why].slice(0, 3);
    }
    const singles = pool.filter((c) => c.duration >= lo && c.duration <= hi)
        .sort((a, b) => (gap - a.duration) - (gap - b.duration) || b.rel - a.rel).slice(0, 15);
    // Combinations: the 300 most relevant clips shorter than the gap; pairs, then triples
    // while time allows (about 60 ms).
    const t0 = Date.now();
    // Very short clips (transitions, stings) make no useful combination.
    const minPart = Math.min(20, gap / 4);
    const cand = pool.filter((c) => c.duration < gap && c.duration >= minPart).sort((a, b) => b.rel - a.rel || a.duration - b.duration).slice(0, 300).sort((a, b) => a.duration - b.duration);
    const durs = cand.map((c) => c.duration);
    const firstAtLeast = (x, from) => { let a = from, b = durs.length; while (a < b) { const m = (a + b) >> 1; if (durs[m] < x) a = m + 1; else b = m; } return a; };
    const combos = [];
    outer: for (let i = 0; i < cand.length; i++) {
        for (let j = Math.max(i + 1, firstAtLeast(lo - durs[i], i + 1)); j < cand.length && durs[i] + durs[j] <= hi; j++) {
            combos.push([cand[i], cand[j]]);
            if (combos.length >= 400) break outer;
        }
    }
    let partial = false;
    triples: for (let i = 0; i < cand.length; i++) {
        for (let j = i + 1; j < cand.length && durs[i] + durs[j] < hi; j++) {
            if (Date.now() - t0 > 60) { partial = true; break triples; }
            for (let k = Math.max(j + 1, firstAtLeast(lo - durs[i] - durs[j], j + 1)); k < cand.length && durs[i] + durs[j] + durs[k] <= hi; k++) {
                combos.push([cand[i], cand[j], cand[k]]);
                if (combos.length >= 1500) break triples;
            }
        }
    }
    const sum = (list) => list.reduce((s, c) => s + c.duration, 0);
    const topCombos = combos.map((list) => ({ items: list, total: Math.round(sum(list) * 1000) / 1000, rel: list.reduce((s, c) => s + c.rel, 0) }))
        .sort((a, b) => b.rel - a.rel || a.items.length - b.items.length || (gap - a.total) - (gap - b.total)).slice(0, 12);
    // Trims: only the black-and-silent head/tail found by the analysis.
    const trims = [];
    for (const c of pool) {
        if (c.duration <= hi) continue;
        const t = R.analysis.analysisDetail(c.id).trim;
        if (!t.in && !t.out) continue;
        const tin = t.in || 0, tout = t.out && t.out > tin ? Math.min(t.out, c.duration) : c.duration;
        const len = tout - tin;
        if (len >= lo && len <= hi) trims.push({ ...c, in: Math.round(tin * 1000) / 1000, out: Math.round(tout * 1000) / 1000, len: Math.round(len * 1000) / 1000 });
    }
    trims.sort((a, b) => (gap - a.len) - (gap - b.len) || b.rel - a.rel);
    return { date, gap_s: gap, tol_s: tol, pool: pool.length, singles: withAired(singles), combos: topCombos.map((cb) => ({ ...cb, items: withAired(cb.items) })), trims: withAired(trims.slice(0, 10)), partial, ms: Date.now() - t0 };
}


// ---- exports (read by the other modules through R.builder) ----
R.builder = module.exports;
Object.assign(module.exports, { parseLenS, airedMonths, lastAiredIndex, withAired, daysBefore, explicitAllowed, bldClip, builderFilters, builderPool, poolCache, cachedPool, builderPoolCached, builderSearch, builderInfo, REL_DAYS, relFiles, relBump, pairsOf, relatedIndex, forEachPlaylistFile, STOP_WORDS, titleWords, seriesOf, wordSet, tagSet, relation, builderRelated, builderFill });
Object.defineProperty(module.exports, 'airedCache', { get: () => airedCache, set: (v) => { airedCache = v; }, enumerable: true });
Object.defineProperty(module.exports, 'relCache', { get: () => relCache, set: (v) => { relCache = v; }, enumerable: true });
