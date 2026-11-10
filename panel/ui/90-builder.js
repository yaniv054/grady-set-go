// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 90-builder. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- block builder
// Full-screen two-pane editor (sources left, the list being built right) for a saved block
// or a whole day. Nothing is stored until Save: a block through /local/blocks, a day through
// saveDayPlaylist() (the Program page's own Save, with its confirms and block placements).
let B = null;
const bldLists = { tgt: null, src: null };
const BLD_ROW_H = 40;
const fmtTrim = (sec) => { sec = Math.max(0, Number(sec) || 0); const m = Math.floor(sec / 60), s = sec - m * 60; return `${pad(m)}:${s.toFixed(1).padStart(4, '0')}`; };
// mm:ss.f, h:mm:ss.f or seconds -> seconds (null if not a time).
function parseTrim(v) {
    const s = String(v ?? '').trim();
    let m;
    if ((m = /^(\d+(?:\.\d+)?)$/.exec(s))) return Number(m[1]);
    if ((m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s))) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return null;
}
// Lengths typed by the editor: 60:00, 1:00:00, 3:40, 5m, 90s, 2h, 45 (minutes).
function parseLen(v) {
    const s = String(v ?? '').trim().toLowerCase();
    const m = /^(\d+(?:\.\d+)?)\s*(h|m|min|s)$/.exec(s);
    if (m) return Number(m[1]) * ({ h: 3600, m: 60, min: 60, s: 1 }[m[2]]);
    if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s) * 60;
    return parseTrim(s);
}

// A scrolling list that keeps only the visible rows in the page (fixed row height).
function vlist(el, render) {
    const sizer = h('div', { class: 'vl-sizer' }), win = h('div', { class: 'vl-win' }), line = h('div', { class: 'vl-line', hidden: true });
    sizer.append(win, line);
    el.replaceChildren(sizer);
    const v = {
        el, count: 0, onrender: null,
        refresh() {
            sizer.style.height = `${Math.max(1, v.count) * BLD_ROW_H}px`;
            const top = el.scrollTop, hgt = el.clientHeight || 400;
            const a = Math.max(0, Math.floor(top / BLD_ROW_H) - 8), b = Math.min(v.count, Math.ceil((top + hgt) / BLD_ROW_H) + 8);
            win.style.top = `${a * BLD_ROW_H}px`;
            const rows = [];
            for (let i = a; i < b; i++) rows.push(render(i));
            win.replaceChildren(...rows);
            if (v.onrender) v.onrender(a, b);
        },
        setCount(n) { v.count = n; v.refresh(); },
        scrollTo(i) { const y = i * BLD_ROW_H; if (y < el.scrollTop) el.scrollTop = y; else if (y + BLD_ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + BLD_ROW_H - el.clientHeight; },
        indexAt(clientY) { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(v.count, Math.round((clientY - r.top + el.scrollTop) / BLD_ROW_H))); },
        showLine(i) { line.hidden = i == null; if (i != null) line.style.top = `${i * BLD_ROW_H - 1}px`; },
    };
    let raf = 0;
    el.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; v.refresh(); }); });
    return v;
}

// ---- open / close ----
async function openBuilder(opts) {
    if (B && B.dirty && !(await confirmModal(T('Discard builder changes?'), T('The list open in the block builder has unsaved changes.'), { ok: T('Discard'), danger: true }))) return;
    const rules = await localJson('GET', '/local/branding/rules').catch(() => ({}));
    const dayStart = parseHms(S.config.playlist.day_start) || 0;
    const nb = {
        mode: opts.mode, rules, dayStart, list: [], placements: [], cursor: -1, sel: new Set(), anchor: null, active: 'right',
        undo: [], redo: [], dirty: false, info: new Map(), lastAdded: null, drag: null,
        returnTo: VIEWS.includes(location.hash.slice(1)) && location.hash.slice(1) !== 'builder' ? location.hash.slice(1) : 'program',
        src: { tab: 'library', rows: [], sel: new Set(), cursor: 0, anchor: null, total: 0, loading: false, seq: 0, path: '', set: '', blockOpen: null,
            // Same starting point as the Generate options (rights cleared, skip problem clips).
            f: { q: '', cat: '', cleared: $('#gen-cleared').checked, wide: false, explicit: '', an: $('#gen-skip-issues').checked ? 'skip' : '', min: '', max: '', notaired: '', sort: 'title', dir: 'asc' }, gap: '', tol: '10' },
    };
    if (opts.mode === 'block') {
        const b = opts.block;
        nb.block = { id: b.id || null, name: b.name || '', occasion: b.occasion || '', notes: b.notes || '', quiet: !!b.quiet, updated: b.updated || null };
        nb.list = (b.items || []).map(toProgramItem);
        const len = nb.list.reduce((s, it) => s + itemDur(it), 0);
        nb.startS = 20 * 3600;
        nb.targetS = len ? Math.ceil(len / 300) * 300 : 3600;
        // Checked for the next occasion date that uses this block, else today's broadcast day.
        const today = broadcastDate();
        const occ = b.id ? S.occasions.flatMap((o) => (o.dates || []).filter((d) => d.date >= today && (d.placements || []).some((p) => p.block_id === b.id)).map((d) => d.date)).sort()[0] : null;
        nb.checkDate = occ || today;
    } else {
        // A copy of the open day (with its unsaved changes); its block marks follow the copied rows.
        const map = new Map();
        nb.list = S.playlist.program.map((it) => { const c = { ...it }; map.set(it, c); return c; });
        nb.placements = S.plPlacements.map((p) => ({ ...p, refs: p.refs ? (p.refs.every((r) => map.has(r)) ? p.refs.map((r) => map.get(r)) : []) : undefined }));
        nb.date = S.playlist.date;
        nb.startS = dayStart;
        // Fixed times at opening: the live slot(s), and what the saved playlist looked like.
        nb.live0 = [];
        let t = dayStart;
        for (const it of nb.list) { if (isLiveSlot(it.source)) nb.live0.push(t); t += itemDur(it); }
        nb.daySig = S.plSig;
        nb.targetS = parseHms(S.config.playlist.length) || 86400;
        nb.checkDate = nb.date;
    }
    nb.cursor = nb.list.length ? 0 : -1;
    B = nb;
    if (location.hash === '#builder') renderBuilder(); else location.hash = 'builder';
}
async function closeBuilder() {
    if (!B) return;
    if (B.dirty && !(await confirmModal(T('Close without saving?'), T(`The changes in the block builder are not saved and will be lost.`), { ok: T('Discard changes'), danger: true }))) return;
    const back = B.returnTo;
    B = null;
    location.hash = back;
    renderBlocks();
}
$('#bld-close').addEventListener('click', () => closeBuilder());
$('#pl-builder').addEventListener('click', () => { if (S.playlist) openBuilder({ mode: 'day' }); });
$('#blk-new').addEventListener('click', () => openBuilder({ mode: 'block', block: {} }));
async function editBlock(id) {
    let b;
    try { b = await fetchBlock(id); } catch (e) { return toast(e.message, 'err'); }
    openBuilder({ mode: 'block', block: b });
}

// ---- list changes, undo / redo ----
function bldSnapshot() {
    const m = B.mode === 'day' ? placementMatches(B.list, B.placements, B.startS) : [];
    return { list: B.list.map((x) => ({ ...x })), placements: B.placements.map((p, k) => ({ ...p, refs: undefined, ix: m[k] ? [m[k].from, m[k].to] : p.refs ? 'broken' : null })) };
}
function bldRestore(snap) {
    B.list = snap.list.map((x) => ({ ...x }));
    B.placements = snap.placements.map(({ ix, ...p }) => ({ ...p, refs: Array.isArray(ix) ? B.list.slice(ix[0], ix[1] + 1) : ix === 'broken' ? [] : undefined }));
    B.sel = new Set();
    B.cursor = Math.min(Math.max(B.cursor, B.list.length ? 0 : -1), B.list.length - 1);
}
function bldCommit(fn) {
    B.undo.push(bldSnapshot());
    if (B.undo.length > 100) B.undo.shift();
    B.redo = [];
    fn();
    B.dirty = true;
    bldListChanged();
}
function bldUndo(redo = false) {
    const from = redo ? B.redo : B.undo, to = redo ? B.undo : B.redo;
    if (!from.length) return toast(redo ? T('Nothing to redo.') : T('Nothing to undo.'));
    to.push(bldSnapshot());
    bldRestore(from.pop());
    B.dirty = true;
    bldListChanged();
}
function bldListChanged() { renderBldBar(); renderTarget(); fetchBldInfo(); }

// Items' details (title, rights for the check date, flags), fetched for new files only.
function fetchBldInfo() {
    clearTimeout(fetchBldInfo.t);
    fetchBldInfo.t = setTimeout(async () => {
        if (!B) return;
        const want = [...new Set(B.list.map((i) => i.source))].filter((s) => !B.info.has(s));
        if (!want.length) return;
        const date = B.checkDate;
        try {
            const r = await localJson('POST', '/local/builder/info', { sources: want, date });
            if (!B || B.checkDate !== date) return;
            for (const [s, v] of Object.entries(r.items)) B.info.set(s, v);
            renderTarget();
        } catch { /* details are optional */ }
    }, 120);
}

// ---- saved-block marks in a day: pinned or quiet blocks are fixed ----
// Rows of a pinned or quiet block are not removed, moved or split here (Detach it first);
// changing another block's rows is asked first (its mark is dropped when the day is saved).
// The live slot row is fixed the same way: not removed, moved or trimmed here.
async function bldBandGuard(indices, insertAt = null) {
    if (B.mode !== 'day') return true;
    const live = indices.find((i) => isLiveSlot(B.list[i]?.source));
    if (live != null) { toast(T('The live slot at {time} stays as it is (it is fixed in the day). Change the live slot from Generate instead.', { time: clockOf(B.clocks?.[live] ?? B.startS) }), 'err'); return false; }
    const hit = new Map();
    for (const i of indices) { const b = B.bandOf[i]; if (b) hit.set(b.k, b); }
    if (insertAt != null) for (const b of B.bandList) if (insertAt > b.from && insertAt <= b.to) hit.set(b.k, b);
    if (!hit.size) return true;
    const fixed = [...hit.values()].find((b) => b.p.start || b.p.quiet);
    if (fixed) { toast(T('The rows of the {v} “{name}” stay as they are. Detach it first (button in its first row) to change them.', { v: fixed.p.start ? T('block pinned at {start}', { start: fixed.p.start }) : 'quiet block', name: bidiText(fixed.p.name) }), 'err'); return false; }
    return confirmModal(T('Change a saved block?'), T('This changes the rows of the block {v}. The rows stay, but the block mark is dropped when the day is saved.', { v: [...hit.values()].map((b) => `“${bidiText(b.p.name)}”`).join(', ') }), { ok: T('Change it') });
}
// Day: the live slot and pinned blocks that are no longer at their time (rows added or
// removed before them). Live slot: against its time when the builder opened; pinned
// blocks: against the pin time (more than a minute off).
function bldDrifts() {
    if (!B || B.mode !== 'day') return [];
    const out = [], cum = [0];
    for (const it of B.list) cum.push(cum[cum.length - 1] + itemDur(it));
    let k = 0;
    B.list.forEach((it, i) => {
        if (!isLiveSlot(it.source)) return;
        const at = B.startS + cum[i], was = B.live0?.[k++];
        if (was != null && Math.abs(at - was) > 1) out.push(T('Live slot now starts {time} (was {time2})', { time: clockOf(at), time2: clockOf(was) }));
    });
    placementMatches(B.list, B.placements, B.startS).forEach((m, j) => {
        const p = B.placements[j];
        if (!m || !p.start) return;
        const at = B.startS + cum[m.from], want = parseHM(p.start);
        const d = ((at - want) % 86400 + 86400 + 43200) % 86400 - 43200;
        if (Math.abs(d) > 60) out.push(T('“{name}” pinned at {start} now starts {time} ({v}{duration})', { name: bidiText(p.name), start: p.start, time: clockOf(at), v: d > 0 ? '+' : '−', duration: fmtDur(Math.abs(d)) }));
    });
    return out;
}
// After an edit: say so when it moved the live slot or a pinned block.
function bldReportDrift(before) {
    const now = bldDrifts().filter((x) => !before.includes(x));
    if (now.length) toast(T('This moves fixed times: {v}.', { v: now.join('; ') }), 'err');
}
function bldDetach(p) {
    bldCommit(() => { B.placements = B.placements.filter((x) => x !== p); });
    toast(T('“{name}” detached: the rows stay; the block mark (and its pin) goes when you save.', { name: bidiText(p.name) }), 'ok');
}

// ---- edits ----
const bldInsertAt = () => (B.cursor >= 0 ? B.cursor + 1 : B.list.length);
async function bldAdd(rows, at = bldInsertAt()) {
    const items = [];
    try { for (const r of rows) if (r.toItems) items.push(...(await r.toItems())); } catch (e) { return toast(e.message, 'err'); }
    if (!items.length) return toast(T('Nothing to add here (pick clips, not folders or headings).'), 'err');
    if (!(await bldBandGuard([], at))) return;
    const drift0 = bldDrifts();
    bldCommit(() => { B.list.splice(at, 0, ...items); B.sel = new Set(items); B.cursor = at + items.length - 1; B.anchor = B.cursor; B.lastAdded = items[items.length - 1]; });
    // Added sources are no longer selected on the left (like a file manager after a copy).
    B.src.sel = new Set();
    renderSource();
    B.tgt.scrollTo(B.cursor);
    bldReportDrift(drift0);
}
const bldPicked = () => { const s = B.list.filter((x) => B.sel.has(x)); return s.length ? s : B.list[B.cursor] ? [B.list[B.cursor]] : []; };
async function bldRemove(items = bldPicked()) {
    if (!items.length) return;
    const set = new Set(items), idx = B.list.map((x, i) => (set.has(x) ? i : -1)).filter((i) => i >= 0);
    if (!(await bldBandGuard(idx))) return;
    const drift0 = bldDrifts();
    bldCommit(() => { B.list = B.list.filter((x) => !set.has(x)); B.sel = new Set(); B.cursor = Math.min(idx[0], B.list.length - 1); });
    bldReportDrift(drift0);
}
// Moves items so that they start at index `at` of the current list.
async function bldMoveTo(items, at) {
    const set = new Set(items), idx = B.list.map((x, i) => (set.has(x) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    if (!(await bldBandGuard(idx, at))) return;
    const drift0 = bldDrifts();
    bldCommit(() => {
        const rest = B.list.filter((x) => !set.has(x));
        const pos = at - idx.filter((i) => i < at).length;
        const moved = idx.map((i) => B.list[i]);
        rest.splice(Math.max(0, Math.min(pos, rest.length)), 0, ...moved);
        B.list = rest;
        B.sel = new Set(moved);
        B.cursor = B.list.indexOf(moved[moved.length - 1]);
    });
    B.tgt.scrollTo(B.cursor);
    bldReportDrift(drift0);
}
function bldMove(dir) {
    const items = bldPicked();
    if (!items.length) return;
    const idx = items.map((x) => B.list.indexOf(x));
    const lo = Math.min(...idx), hi = Math.max(...idx);
    if (dir < 0 ? lo === 0 : hi === B.list.length - 1) return;
    bldMoveTo(items, dir < 0 ? lo - 1 : hi + 2);
}
// In / out points: clamped to the file length, in stays before out.
async function bldSetTrim(i, which, text) {
    const it = B.list[i], v = parseTrim(text);
    // Rows of the live slot, pinned or quiet blocks keep their length (the field goes back).
    if (!(await bldBandGuard([i]))) return renderTarget();
    const drift0 = bldDrifts();
    const len = Number(it.duration) || B.info.get(it.source)?.duration || Number(it.out);
    if (v === null) { toast(T('Use mm:ss.f, e.g. 01:23.5.'), 'err'); return renderTarget(); }
    const inS = which === 'in' ? Math.max(0, Math.min(v, Number(it.out) - 0.1)) : Number(it.in) || 0;
    const outS = which === 'out' ? Math.min(len, Math.max(v, inS + 0.1)) : Number(it.out);
    if (Math.abs(inS - (Number(it.in) || 0)) < 0.001 && Math.abs(outS - Number(it.out)) < 0.001) return renderTarget();
    bldCommit(() => { it.in = Math.round(inS * 1000) / 1000; it.out = Math.round(outS * 1000) / 1000; });
    bldReportDrift(drift0);
    if ((which === 'in' && v !== inS) || (which === 'out' && v !== outS)) toast(T('Kept inside the file (0 – {time}) and before the out point.', { time: fmtTrim(len) }));
}

// Start time typed into a row of the day (block builder, day mode; see rowStartPlan).
async function bldSetRowStart(i, clockSec) {
    if (!B || B.mode !== 'day') return;
    const bands = B.bandList.map((b) => ({ from: b.from, to: b.to, p: b.p }));
    const plan = rowStartPlan(B.list, i, clockSec, { dayStart: B.startS, bands });
    if (plan.error) { toast(plan.error, 'err'); renderTarget(); return; }
    if (plan.noop) { renderTarget(); return; }
    const it = B.list[i];
    if (!(await rowStartConfirm(plan, it.title || B.info.get(it.source)?.title || baseName(it.source)))) { renderTarget(); return; }
    const drift0 = bldDrifts();
    bldCommit(() => { rowStartApply(B.list, plan); if (plan.detach) B.placements = B.placements.filter((p) => p !== plan.detach.p); });
    bldReportDrift(drift0);
    toast(T('Row starts at {time}.', { time: clockOf(plan.clock) }), 'ok');
}

// ---- selection (both panes): click, Ctrl+click toggles, Shift+click range, Space toggles ----
function bldPick(pane, i, e = {}) {
    const right = pane === 'right';
    const rows = right ? B.list : B.src.rows;
    const keyOf = (x) => (right ? x : x.key);
    const P = right ? B : B.src;
    if (!rows[i]) return;
    if (e.shiftKey && P.anchor != null) {
        if (!(e.ctrlKey || e.metaKey)) P.sel = new Set();
        for (let k = Math.min(P.anchor, i); k <= Math.max(P.anchor, i); k++) if (!rows[k].head) P.sel.add(keyOf(rows[k]));
    } else if (e.ctrlKey || e.metaKey) {
        const k = keyOf(rows[i]);
        if (P.sel.has(k)) P.sel.delete(k); else if (!rows[i].head) P.sel.add(k);
        P.anchor = i;
    } else { P.sel = new Set(rows[i].head ? [] : [keyOf(rows[i])]); P.anchor = i; }
    P.cursor = i;
    B.active = pane;
    renderPanesActive();
    if (right) { renderTarget(); if (B.src.tab === 'suggest') loadRelated(); } else renderSource();
}

// ---- header, bar ----
function renderBuilder() {
    if (!B) return;
    $('#bld-mode').textContent = B.mode === 'block' ? T('Block') : T('Day');
    $('#bld-saveas').hidden = B.mode !== 'block';
    $('#bld-save').textContent = B.mode === 'block' ? T('Save block') : T('Save day');
    const meta = $('#bld-meta');
    if (B.mode === 'block') {
        $('#bld-title').textContent = B.block.id ? T('Edit block') : T('New block');
        $('#blk-occ-list').replaceChildren(...(S.occNames || []).map((n) => h('option', { value: n })));
        const field = (k, label, attrs = {}) => h('label', {}, label, h('input', { value: B.block[k], dir: 'auto', autocomplete: 'off', ...attrs, oninput: (e) => { B.block[k] = e.target.value; B.dirty = true; renderBldBar(); } }));
        meta.replaceChildren(field('name', T('Name'), { maxlength: 80, id: 'bld-name', placeholder: T('Required') }), field('occasion', T('Occasion'), { maxlength: 80, list: 'blk-occ-list' }), field('notes', T('Notes'), { maxlength: 2000 }),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: B.block.quiet, onchange: (e) => { B.block.quiet = e.target.checked; B.dirty = true; renderBldBar(); } }), T('Quiet — no automatic branding or live text inside')));
    } else {
        $('#bld-title').textContent = T('Day: {v} {date}', { v: WEEKDAY[new Date(B.date + 'T12:00:00').getDay()], date: fmtDate(B.date) });
        meta.replaceChildren(h('span', { class: 'muted small' }, T('Save writes the day’s playlist like Save on the Program page (same checks).')));
    }
    // The two scrolling lists are made once and serve every builder session.
    if (!bldLists.tgt) {
        bldLists.tgt = vlist($('#bld-tgt'), tgtRow);
        bldLists.src = vlist($('#bld-src'), srcRow);
        bldLists.src.onrender = (a, b) => { if (B && B.src.tab === 'library' && b >= B.src.rows.length - 5 && B.src.rows.length < B.src.total) loadLibrary(true); };
    }
    B.tgt = bldLists.tgt;
    B.srcv = bldLists.src;
    renderBldBar();
    renderTabs();
    setSrcTab(B.src.tab);
    renderTarget();
    fetchBldInfo();
    renderPanesActive();
}
function renderBldBar() {
    if (!B) return;
    const total = B.list.reduce((s, it) => s + itemDur(it), 0), target = B.targetS || 1;
    const diff = target - total;
    const bar = $('#bld-bar');
    const lenIn = (val, title, on) => h('input', { class: 'bld-len', value: val, title, inputmode: 'numeric', onchange: (e) => on(e.target.value) });
    const ctrls = B.mode === 'block' ? [
        h('label', { class: 'inline' }, T('Target'), lenIn(fmtDur(B.targetS).replace(/^00:/, ''), T('Target length, e.g. 60:00 or 1:30:00'), (v) => { const s = parseLen(v); if (!s || s < 1) return toast(T('Target length: e.g. 60:00.'), 'err'); B.targetS = s; renderBldBar(); })),
        h('label', { class: 'inline' }, T('Start'), lenIn(fmtHM(B.startS), T('Clock time of the first row (HH:MM)'), (v) => { const s = parseHM(v); if (s == null || s >= 86400) return toast(T('Start: HH:MM.'), 'err'); B.startS = s; renderBldBar(); renderTarget(); })),
        h('label', { class: 'inline' }, T('Check date'), lenIn(fmtDate(B.checkDate), T('Rights are checked for this date ({format})', { format: dateHint() }), (v) => { const d = parseDate(v); if (!d) return toast(T('Check date: dd/mm/yy.'), 'err'); B.checkDate = d; B.info = new Map(); renderBldBar(); renderTarget(); fetchBldInfo(); if (B.src.tab === 'library') loadLibrary(); })),
    ] : [
        h('span', {}, T('Broadcast day '), h('b', {}, `${fmtHM(B.startS)} → ${fmtHM(B.startS + target)}`), ` (${fmtDur(target)})`),
        h('span', {}, T('Rights for '), h('b', {}, fmtDate(B.checkDate))),
    ];
    const pct = Math.min(100, (total / target) * 100);
    // Day: the live slot or pinned blocks no longer at their time.
    const off = bldDrifts().map((x) => h('span', { class: 'bad', title: T('Rows were added, removed or trimmed before it. Use Suggestions → Fill, or remove rows.') }, x));
    bar.replaceChildren(...ctrls, ...off,
        h('div', { class: 'bld-fill', title: T('{duration} of {duration2}', { duration: fmtDur(total), duration2: fmtDur(target) }) }, h('div', { class: Math.abs(diff) <= 1 ? 'ok' : diff < 0 ? 'bad' : 'warn', style: `width:${pct}%` })),
        h('span', { class: Math.abs(diff) <= 1 ? 'ok' : diff < 0 ? 'bad' : 'warn' }, `${Tn('{n} item', '{n} items', B.list.length)} · ${fmtDur(total)}`, Math.abs(diff) <= 1 ? T(' · fills it') : diff > 0 ? T(' · {duration} missing', { duration: fmtDur(diff) }) : T(' · {duration} over', { duration: fmtDur(-diff) })),
        ...(B.dirty ? [h('span', { class: 'warn' }, T('● Unsaved'))] : []));
}
function renderPanesActive() {
    $('#bld-left').classList.toggle('active', B.active === 'left');
    $('#bld-right-pane').classList.toggle('active', B.active === 'right');
}

// ---- right pane: the list ----
const allowedExplicit = (clock) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(B.rules.explicit_after || '').trim());
    if (!m) return true;
    const ex = Number(m[1]) * 3600 + Number(m[2]) * 60, ds = B.dayStart, t = ((clock % 86400) + 86400) % 86400;
    return ex > ds ? t >= ex || t < ds : t >= ex && t < ds;
};
function rowWarnings(it, inf, clock) {
    const w = [];
    const b = (cls, text, tip) => w.push(h('span', { class: `badge ${cls}`, title: tip }, text));
    if (inf.missing) b('bad', T('Missing'), inf.moved_to ? `Renamed or moved; now ${inf.moved_to}` : T('Not on the share or in storage'));
    if (inf.hidden) b('bad', T('Hidden'), T('Hidden on the Needs attention page'));
    if (inf.id && !inf.cleared) b('warn', T('Rights'), T('Not rights-cleared for {date} (rights {rights})', { date: fmtDate(B.checkDate), rights: inf.rights }));
    if (inf.explicit && !allowedExplicit(clock)) b('bad', T('Explicit'), `Explicit language at ${clockOf(clock)}; allowed only from ${B.rules.explicit_after} until the day starts`);
    if (inf.conform) b('warn', T('Conform'), T('Flagged for conforming by the library scan'));
    if (inf.aspect && inf.aspect !== '16:9') b('warn', ASPECT_LABEL[inf.aspect] || inf.aspect, T('Picture is not 16:9'));
    return w;
}
function renderTarget() {
    if (!B || !B.tgt) return;
    const clocks = [];
    let t = B.startS;
    for (const it of B.list) { clocks.push(t); t += itemDur(it); }
    B.clocks = clocks;
    B.bandOf = [];
    B.bandList = [];
    if (B.mode === 'day') placementMatches(B.list, B.placements, B.startS).forEach((m, k) => {
        if (!m) return;
        const band = { k, p: B.placements[k], from: m.from, to: m.to, color: BAND_COLORS[k % BAND_COLORS.length] };
        B.bandList.push(band);
        for (let i = m.from; i <= m.to; i++) B.bandOf[i] = band;
    });
    for (const x of [...B.sel]) if (!B.list.includes(x)) B.sel.delete(x);
    B.tgt.setCount(B.list.length);
    if (!B.list.length) B.tgt.el.querySelector('.vl-win').replaceChildren(h('div', { class: 'bld-empty muted' }, B.mode === 'block' ? T('Empty. Add clips from the left (→, Enter, or drag).') : T('This day has no rows yet.')));
}
function tgtRow(i) {
    const it = B.list[i], inf = B.info.get(it.source) || {}, clock = B.clocks[i], band = B.bandOf[i];
    const btype = brandTypeOfSrc(it.source);
    const title = it.title || inf.title || baseName(it.source);
    const trim = (which) => h('input', { class: 'trim mono', value: fmtTrim(which === 'in' ? it.in : it.out), 'aria-label': which === 'in' ? T('In point') : T('Out point'), title: T('{v} point (mm:ss.f); file length {time}', { v: which === 'in' ? 'In' : T('Out'), time: fmtTrim(Number(it.duration) || inf.duration) }),
        onmousedown: (e) => { e.stopPropagation(); e.currentTarget.closest('.bld-row').draggable = false; },
        onblur: (e) => { const r = e.currentTarget.closest('.bld-row'); if (r) r.draggable = true; },
        onchange: (e) => bldSetTrim(i, which, e.target.value), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
    const head = band && band.from === i ? h('span', { class: 'bh-tag' }, T('Block: '), bidiText(band.p.name), band.p.quiet ? T(' · Quiet') : '', band.p.start ? T(' · pinned {start}', { start: band.p.start }) : '',
        h('button', { class: 'btn ghost tiny', title: T('Keep the rows; drop the block mark (and pin)'), onclick: (e) => { e.stopPropagation(); bldDetach(band.p); } }, T('Detach'))) : null;
    return h('div', {
        class: ['bld-row', i === B.cursor ? 'cur' : '', B.sel.has(it) ? 'sel' : '', btype || isOffair(it.source) || isLiveSlot(it.source) ? 'brand' : '', band ? 'inband' : ''].filter(Boolean).join(' '),
        style: band ? `--band:${band.color}` : null, draggable: 'true', 'data-i': i,
        onclick: (e) => { if (!e.target.closest('input,button')) bldPick('right', i, e); },
        ondragstart: (e) => {
            if (!B.sel.has(it)) { B.sel = new Set([it]); B.cursor = i; }
            B.drag = { from: 'right', items: B.list.filter((x) => B.sel.has(x)) };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'rows');
        },
    },
    h('span', { class: 'n muted' }, i + 1),
    B.mode === 'day'
        ? h('span', { class: 'mono start-cell', tabindex: 0, title: T('Double-click (or Enter) to set the start time'),
            ondblclick: (e) => { e.stopPropagation(); startCellEditor(e.currentTarget, clock, (sec) => bldSetRowStart(i, sec)); },
            onmousedown: (e) => { if (e.detail > 1) e.preventDefault(); },
            onkeydown: (e) => { if ((e.key === 'Enter' || e.key === 'F2') && e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); startCellEditor(e.currentTarget, clock, (sec) => bldSetRowStart(i, sec)); } } }, clockOf(clock))
        : h('span', { class: 'mono' }, clockOf(clock)),
    h('span', { class: 't' }, h('span', { class: 'tt' }, btype ? h('span', { class: 'badge brandtag' }, btype) : null, isLiveSlot(it.source) ? h('span', { class: 'badge live' }, T('Live slot')) : null, bidiText(title)),
        h('span', { class: 'pf muted' }, head || bidiText(inf.performer || dirName(it.source)))),
    h('span', { class: 'num mono', title: inf.size ? T('File size {size}', { size: fmtBytes(inf.size) }) : undefined }, fmtDur(itemDur(it))),
    trim('in'), trim('out'),
    h('span', { class: 'w' }, ...rowWarnings(it, inf, clock)));
}

// ---- left pane: sources ----
const SRC_TABS = i18nLazy([['library', N_('Library')], ['folders', N_('Folders')], ['branding', N_('Branding')], ['blocks', N_('Saved blocks')], ['suggest', N_('Suggestions')]]);
function renderTabs() {
    $('#bld-tabs').replaceChildren(...SRC_TABS.map(([k, l]) => h('button', { class: 'bld-tab' + (B.src.tab === k ? ' on' : ''), role: 'tab', 'aria-selected': String(B.src.tab === k), onclick: () => setSrcTab(k) }, l)));
}
function setSrcTab(tab) {
    B.src.tab = tab;
    B.src.rows = []; B.src.sel = new Set(); B.src.cursor = 0; B.src.anchor = null; B.src.total = 0;
    renderTabs();
    $('#bld-addall').hidden = tab !== 'library';
    const tools = $('#bld-src-tools');
    tools.replaceChildren();
    $('#bld-src-foot').textContent = '';
    if (tab === 'library') { tools.append(...libraryTools()); loadLibrary(); }
    else if (tab === 'folders') loadFolder(B.src.path);
    else if (tab === 'branding') loadBrandingSrc();
    else if (tab === 'blocks') loadBlocksSrc();
    else { tools.append(...suggestTools()); renderSource(); loadRelated(); }
    renderSource();
}
function renderSource() { if (B?.srcv) { B.srcv.setCount(B.src.rows.length); if (!B.src.rows.length) B.srcv.el.querySelector('.vl-win').replaceChildren(h('div', { class: 'bld-empty muted' }, B.src.loading ? T('Loading…') : B.src.empty || T('Nothing here.'))); } }
// A library clip as a source row.
const clipRow = (c, extra = {}) => ({
    key: `c:${c.id}${extra.keySuffix || ''}`, id: c.id, path: c.path, label: c.title, sub: [c.performer, c.folder].filter(Boolean).join(' · '), dur: extra.len ?? c.duration, clip: c, ...extra,
    toItems: extra.toItems || (async () => [{ in: extra.in ?? 0, out: extra.out ?? c.duration, duration: c.duration, source: c.path }]),
});
function srcRow(i) {
    const r = B.src.rows[i];
    if (r.head) return h('div', { class: 'bld-row src head' }, h('span', { class: 't' }, h('b', {}, r.label)), r.sub ? h('span', { class: 'muted small' }, r.sub) : null);
    const c = r.clip;
    const badges = [];
    if (c) {
        if (!c.cleared) badges.push(h('span', { class: 'badge warn', title: T('Not rights-cleared for {date}', { date: fmtDate(B.checkDate) }) }, T('Rights')));
        if (c.explicit) badges.push(h('span', { class: 'badge', title: T('Explicit language') }, T('Explicit')));
        if (c.aspect && c.aspect !== '16:9') badges.push(h('span', { class: 'badge warn', title: T('Picture is not 16:9') }, ASPECT_LABEL[c.aspect] || c.aspect));
        if (c.last_aired) badges.push(h('span', { class: 'badge', title: T('Last aired (as-run)') }, T('Aired {date}', { date: fmtDate(c.last_aired) })));
    }
    for (const why of r.reasons || []) badges.push(h('span', { class: 'badge reason' }, bidiText(why)));
    const thumb = c?.thumb ? h('img', { class: 'thumb small', src: `/local/thumb/${c.id}.jpg`, loading: 'lazy', alt: '' }) : h('span', { class: 'thumb small none' });
    return h('div', {
        class: ['bld-row', 'src', i === B.src.cursor ? 'cur' : '', B.src.sel.has(r.key) ? 'sel' : '', r.folder ? 'folder' : ''].filter(Boolean).join(' '),
        draggable: r.toItems ? 'true' : null, 'data-i': i,
        onclick: (e) => { if (!e.target.closest('button')) bldPick('left', i, e); },
        ondblclick: () => (r.open ? r.open() : bldAdd([r])),
        ondragstart: (e) => {
            if (!B.src.sel.has(r.key)) { B.src.sel = new Set([r.key]); B.src.cursor = i; }
            B.drag = { from: 'left', rows: B.src.rows.filter((x) => B.src.sel.has(x.key) && x.toItems) };
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', 'sources');
        },
    },
    r.folder ? h('span', { class: 'thumb small none fold' }, '📁') : thumb,
    h('span', { class: 't' }, h('span', { class: 'tt' }, bidiText(r.label)), h('span', { class: 'pf muted' }, ...(badges.length ? badges : [bidiText(r.sub || '')]))),
    h('span', { class: 'num mono', title: c?.size ? T('File size {size}', { size: fmtBytes(c.size) }) : undefined }, r.dur ? fmtDur(r.dur) : ''),
    r.toItems && r.addBtn !== false ? h('button', { class: 'btn ghost tiny', title: T('Add after the cursor row'), onclick: () => bldAdd([r]) }, '+') : h('span'));
}
// Library tab: one search box (with typed tokens) and filter chips.
function libraryTools() {
    const f = B.src.f;
    const go = () => { clearTimeout(libraryTools.t); libraryTools.t = setTimeout(() => loadLibrary(), 250); };
    const chk = (k, label, tip) => h('label', { class: 'chip-check', title: tip }, h('input', { type: 'checkbox', checked: f[k], onchange: (e) => { f[k] = e.target.checked; loadLibrary(); } }), label);
    const sel = (k, opts, label) => h('select', { class: 'auto', 'aria-label': label, onchange: (e) => { f[k] = e.target.value; loadLibrary(); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: f[k] === v }, l)));
    const txt = (k, ph, tip, w = '5.5em') => h('input', { value: f[k], placeholder: ph, title: tip, style: `width:${w}`, oninput: (e) => { f[k] = e.target.value; go(); } });
    return [
        h('input', { type: 'search', id: 'bld-q', value: f.q, placeholder: T('Search title, performer, songwriters, tags, folder, file…'), dir: 'auto',
            title: T('Words match title, performer, songwriters, tags, folder and file name.\nTokens: cat:podcast  len:<5m  len:>2m  len:<3:40  explicit:no  aired:>14d (not aired in 14 days)  aired:<7d (aired in the last 7 days)'),
            oninput: (e) => { f.q = e.target.value; go(); } }),
        h('div', { class: 'bld-chips' },
            sel('cat', [['', T('Any category')], ['-', T('No category')], ...Object.entries(CAT_LABEL)], T('Category')),
            chk('cleared', T('Cleared'), T('Only clips rights-cleared for the check date')),
            chk('wide', '16:9', T('Only 16:9 clips')),
            sel('explicit', [['', T('Explicit: any')], ['no', T('Not explicit')], ['yes', T('Explicit only')]], T('Explicit language')),
            sel('an', [['', T('Analysis: any')], ['skip', T('Skip problem clips')], ['ok', T('Checked, no problems')], ['problems', T('Problems found')]], T('Analysis')),
            txt('min', T('min 0:00'), T('Shortest length (mm:ss)')), txt('max', T('max 5:00'), T('Longest length (mm:ss)')),
            txt('notaired', T('not aired N d'), T('Not aired in the last N days (as-run)'), '7.5em'),
            sel('sort', [['title', T('Sort: title')], ['length', T('Sort: length')], ['date', T('Sort: file date')], ['aired', T('Sort: last aired')]], T('Sort')),
            h('button', { class: 'btn ghost tiny', title: T('Ascending / descending'), onclick: (e) => { f.dir = f.dir === 'asc' ? 'desc' : 'asc'; e.target.textContent = f.dir === 'asc' ? '▲' : '▼'; loadLibrary(); } }, f.dir === 'asc' ? '▲' : '▼')),
    ];
}
async function loadLibrary(more = false) {
    if (!B || B.src.tab !== 'library' || (more && B.src.loading)) return;
    const f = B.src.f, seq = more ? B.src.seq : ++B.src.seq;
    const len = (v) => { const s = parseLen(v); return s == null ? '' : String(s); };
    const q = new URLSearchParams({ q: f.q, cat: f.cat, cleared: f.cleared ? '1' : '', wide: f.wide ? '1' : '', explicit: f.explicit, an: f.an, min: f.min ? len(/^\d+$/.test(f.min.trim()) ? `${f.min}:00` : f.min) : '', max: f.max ? len(/^\d+$/.test(f.max.trim()) ? `${f.max}:00` : f.max) : '', notaired: f.notaired, sort: f.sort, dir: f.dir, date: B.checkDate, offset: more ? B.src.rows.length : 0, limit: 100 });
    B.src.loading = true;
    if (!more) { B.src.rows = []; B.src.sel = new Set(); B.src.cursor = 0; renderSource(); }
    try {
        const r = await localJson('GET', `/local/builder/search?${q}`);
        if (!B || seq !== B.src.seq || B.src.tab !== 'library') return;
        B.src.total = r.total;
        B.src.rows.push(...r.rows.map((c) => clipRow(c)));
        B.src.empty = T('No clips match.');
        $('#bld-src-foot').textContent = T('{count}{v} · rights for {date}', { count: plural(r.total, 'clip', 'clips'), v: r.total > B.src.rows.length ? ` (${B.src.rows.length} shown; scroll for more)` : '', date: fmtDate(r.date) });
    } catch (e) { B.src.empty = e.message; }
    finally { if (B) B.src.loading = false; }
    renderSource();
}
async function loadFolder(rel) {
    B.src.path = rel;
    B.src.loading = true;
    renderSource();
    try {
        const r = await localJson('GET', `/local/media/browse?path=${encodeURIComponent(rel)}`);
        if (!B || B.src.tab !== 'folders') return;
        const crumbs = h('div', { class: 'crumbs' });
        renderCrumbs(crumbs, rel, loadFolder, T('Media'));
        $('#bld-src-tools').replaceChildren(crumbs);
        const rows = [];
        if (rel) rows.push({ key: 'up', label: '↩ ..', folder: true, open: () => loadFolder(rel.split('/').slice(0, -1).join('/')) });
        for (const f of r.folders) { const sub = rel ? `${rel}/${f}` : f; rows.push({ key: `d:${sub}`, label: f, folder: true, sub: r.folder_counts?.[f] ? T('{clips} clips · {hours} h', { clips: r.folder_counts[f].clips, hours: r.folder_counts[f].hours }) : '', open: () => loadFolder(sub) }); }
        for (const f of r.files) {
            const relPath = rel ? `${rel}/${f.name}` : f.name;
            rows.push({ key: `f:${f.path}`, id: f.id, path: f.path, label: f.name, sub: [f.res, f.fps && `${f.fps} fps`].filter(Boolean).join(' · '), dur: f.duration,
                toItems: async () => {
                    let d = f.duration;
                    if (!d) d = (await localJson('GET', `/local/media/probe?path=${encodeURIComponent(relPath)}`)).duration;
                    if (!d) throw new Error(T('{name} has no readable length and cannot be scheduled.', { name: f.name }));
                    return [{ in: 0, out: d, duration: d, source: f.path }];
                } });
        }
        B.src.rows = rows;
        B.src.empty = T('Empty folder.');
        $('#bld-src-foot').textContent = [r.hidden_marked ? T('{hidden_marked} hidden on Needs attention', { hidden_marked: r.hidden_marked }) : '', T('Read-only. Double-click a folder to open it.')].filter(Boolean).join(' · ');
    } catch (e) { B.src.empty = e.message; }
    finally { if (B) B.src.loading = false; }
    renderSource();
}
async function loadBrandingSrc() {
    let sets = [];
    try { sets = (await localJson('GET', '/local/branding/sets')).sets; } catch { /* Default only */ }
    if (!B || B.src.tab !== 'branding') return;
    $('#bld-src-tools').replaceChildren(h('label', { class: 'inline' }, T('Branding set'), h('select', { class: 'auto', onchange: (e) => { B.src.set = e.target.value; loadBrandingSrc(); } },
        h('option', { value: '' }, T('Default')), ...sets.map((s) => h('option', { value: s, selected: s === B.src.set }, s)))));
    try {
        const d = await localJson('GET', `/local/branding?set=${encodeURIComponent(B.src.set)}`);
        if (!B || B.src.tab !== 'branding') return;
        const rows = [];
        for (const [type, list] of Object.entries(d.types)) {
            const ok = list.filter((x) => x.check?.ok && x.check.info.duration > 0);
            if (!ok.length) continue;
            rows.push({ key: `h:${type}`, head: true, label: BRAND_INFO[type]?.[0] || type });
            for (const x of ok) rows.push({ key: `b:${x.rel}`, path: x.source, label: x.name, sub: brandInfoLine(x), dur: x.check.info.duration, toItems: async () => [slateItem(x.source, x.check.info.duration)] });
        }
        B.src.rows = rows;
        B.src.empty = T('No checked files in this set.');
    } catch (e) { B.src.set = ''; B.src.empty = e.message; }
    renderSource();
}
function loadBlocksSrc() {
    const own = B.mode === 'block' ? B.block.id : null;
    $('#bld-src-tools').replaceChildren(h('p', { class: 'muted small' }, T('Adds all items of a saved block (double-click, Enter or +).')));
    B.src.rows = sortedBlocks().filter((b) => b.id !== own).map((b) => ({
        key: `k:${b.id}`, label: b.name, sub: [b.occasion, `${Tn('{n} item', '{n} items', b.items_n)}`, b.quiet ? T('Quiet') : ''].filter(Boolean).join(' · '), dur: b.length_s,
        toItems: async () => (await fetchBlock(b.id)).items.map(toProgramItem),
    }));
    B.src.empty = T('No other saved blocks.');
    renderSource();
}

// ---- suggestions: fill a length, related media ----
// The time still to fill: block = target − length; day = up to the next pinned block after
// the cursor (its pin time minus where it starts now), else to the end of the day.
function bldGap() {
    const at = bldInsertAt();
    let t = 0;
    const cum = [0];
    for (const it of B.list) { t += itemDur(it); cum.push(t); }
    if (B.mode === 'block') return { gap: Math.max(0, B.targetS - t), clock: B.startS + cum[at], what: 'to reach the target length' };
    for (const band of [...(B.bandList || [])].sort((a, b) => a.from - b.from)) {
        if (band.from < at || !band.p.start) continue;
        const want = ((parseHM(band.p.start) - B.startS) % 86400 + 86400) % 86400;
        return { gap: Math.max(0, want - cum[band.from]), clock: B.startS + cum[at], what: T('before the block pinned at {start}', { start: band.p.start }) };
    }
    return { gap: Math.max(0, B.targetS - t), clock: B.startS + cum[at], what: 'to the end of the day' };
}
function suggestTools() {
    const auto = bldGap();
    const gapIn = h('input', { class: 'bld-len', value: B.src.gap, placeholder: fmtDur(auto.gap).replace(/^00:/, ''), title: T('Length to fill (mm:ss); empty = what is missing'), oninput: (e) => { B.src.gap = e.target.value; } });
    const tolIn = h('input', { class: 'bld-len', value: B.src.tol, title: T('How much shorter than the length a suggestion may be (seconds)'), oninput: (e) => { B.src.tol = e.target.value; } });
    return [h('div', { class: 'bld-chips' }, h('label', { class: 'inline' }, T('Fill'), gapIn), h('label', { class: 'inline' }, T('up to'), tolIn, T('s short')),
        h('button', { class: 'btn small', onclick: () => loadFill() }, T('Find')), h('span', { class: 'muted small' }, T('Missing {duration} {what}. Uses the Library filters (rights, 16:9, not aired).', { duration: fmtDur(auto.gap), what: auto.what })))];
}
// Combined suggestion rows: fill results first, then related media.
function renderSuggest() {
    if (!B || B.src.tab !== 'suggest') return;
    B.src.rows = [...(B.src.fillRows || []), ...(B.src.relRows || [])];
    B.src.empty = T('Press Find for clips that fill the missing time, or pick a clip in the list for related media.');
    renderSource();
}
async function loadFill() {
    const auto = bldGap();
    const gap = B.src.gap.trim() ? parseLen(B.src.gap) : auto.gap;
    if (!gap || gap < 1) return toast(B.src.gap.trim() ? T('Length to fill: e.g. 03:40.') : T('Nothing is missing. Type a length to fill, e.g. 03:40.'), 'err');
    const f = B.src.f;
    const ids = [...new Set(B.list.map((i) => B.info.get(i.source)?.id).filter(Boolean))];
    try {
        const r = await localJson('POST', '/local/builder/fill', { gap_s: gap, tol_s: Number(B.src.tol) || 0, date: B.checkDate, clock_s: auto.clock, day_start_s: B.dayStart,
            filters: { cleared: f.cleared ? '1' : '', wide: f.wide ? '1' : '', notaired: f.notaired, explicit: f.explicit, an: f.an }, exclude_ids: ids, context_ids: ids });
        if (!B) return;
        const rows = [{ key: 'h:s', head: true, label: T('Single clips for {duration}', { duration: fmtDur(gap) }), sub: r.singles.length ? '' : T('none') }];
        rows.push(...r.singles.map((c) => clipRow(c, { keySuffix: ':s', reasons: c.reasons })));
        rows.push({ key: 'h:c', head: true, label: T('Two or three clips together'), sub: r.combos.length ? '' : T('none') });
        r.combos.forEach((cb, n) => rows.push({ key: `cb:${n}`, label: cb.items.map((c) => c.title).join(' + '), sub: `${cb.items.map((c) => fmtDur(c.duration)).join(' + ')} = ${fmtDur(cb.total)}`, dur: cb.total, combo: cb,
            reasons: [...new Set(cb.items.flatMap((c) => c.reasons || []))].slice(0, 2),
            toItems: async () => cb.items.map((c) => ({ in: 0, out: c.duration, duration: c.duration, source: c.path })) }));
        rows.push({ key: 'h:t', head: true, label: T('Fits once its black/silent head or tail is trimmed'), sub: r.trims.length ? '' : T('none') });
        rows.push(...r.trims.map((c) => clipRow(c, { keySuffix: ':t', in: c.in, out: c.out, len: c.len, reasons: [T('Trim {time} – {time2}', { time: fmtTrim(c.in), time2: fmtTrim(c.out) })] })));
        B.src.fillRows = rows;
        $('#bld-src-foot').textContent = T('{count} considered{v}.', { count: plural(r.pool, 'clip', 'clips'), v: r.partial ? T(' (combinations cut short to stay fast)') : '' });
        renderSuggest();
    } catch (e) { toast(e.message, 'err'); }
}
async function loadRelated() {
    if (!B || B.src.tab !== 'suggest') return;
    const it = B.list[B.cursor] || B.lastAdded;
    const id = it && B.info.get(it.source)?.id;
    if (!id) { B.src.relRows = []; return renderSuggest(); }
    const exclude = [...new Set(B.list.map((i) => B.info.get(i.source)?.id).filter(Boolean))];
    const seq = (loadRelated.seq = (loadRelated.seq || 0) + 1);
    try {
        const r = await localJson('POST', '/local/builder/related', { id, date: B.checkDate, limit: 30, exclude });
        if (!B || seq !== loadRelated.seq) return;
        const name = B.info.get(it.source)?.title || baseName(it.source);
        B.src.relRows = [{ key: 'h:r', head: true, label: T('Related to “{name}”', { name: bidiText(name) }), sub: r.rows.length ? '' : T('nothing found') }, ...r.rows.map((c) => clipRow(c, { keySuffix: ':r', reasons: c.reasons }))];
        renderSuggest();
    } catch { /* optional */ }
}

// ---- save ----
async function saveBuilder(asCopy = false) {
    if (!B) return;
    if (B.mode === 'block') {
        if (!B.list.length) return toast(T('Add at least one item before saving the block.'), 'err');
        let meta = B.block;
        if (asCopy) {
            meta = await blockMetaDialog({ ...B.block, name: `${B.block.name} (copy)`.slice(0, 80) }, { title: T('Save as copy'), sub: T('Saved as a new block; the original stays as it is.'), ok: T('Save copy') });
            if (!meta) return;
        } else if (!B.block.name.trim()) { $('#bld-name')?.focus(); return toast(T('The block needs a name.'), 'err'); }
        try {
            const r = await localJson('POST', '/local/blocks', { ...(asCopy || !B.block.id ? {} : { id: B.block.id, base_updated: B.block.updated }), name: meta.name, occasion: meta.occasion, notes: meta.notes, quiet: meta.quiet, items: B.list.map(toProgramItem) });
            if (!B) return;
            const b = r.block;
            B.block = { id: b.id, name: b.name, occasion: b.occasion, notes: b.notes, quiet: b.quiet, updated: b.updated };
            B.dirty = false;
            renderBuilder();
            loadBlocks();
            toast(T('Block “{name}” saved{v}: {count}, {duration}.', { name: bidiText(b.name), v: asCopy ? T(' as a new block (now open)') : '', count: plural(r.summary.items_n, 'item', 'items'), duration: fmtDur(r.summary.length_s) }), 'ok');
        } catch (e) { toast(e.message, 'err'); }
        return;
    }
    // Day: first the fixed times, then whether the saved playlist was changed elsewhere since
    // the builder opened; then through the Program page's Save (same confirms and
    // placements); on cancel or failure the Program page keeps what it had.
    const drift = bldDrifts();
    if (drift.length && !(await confirmModal(T('Fixed times have moved'), [h('ul', { class: 'small' }, ...drift.map((x) => h('li', {}, x))), T('Save the day anyway?')], { ok: T('Save anyway'), danger: true }))) return;
    try {
        const disk = progSig(await savedProgram(B.date));
        if (B.daySig != null && disk !== B.daySig && !(await confirmModal(T('Changed elsewhere'), T('The saved playlist of {date} was changed elsewhere (another tab or Fill) since the builder opened. Saving replaces that version with this one.', { date: fmtDate(B.date) }), { ok: T('Replace it'), danger: true }))) return;
    } catch { /* the Save below reports a connection problem */ }
    const keep = { playlist: S.playlist, plPlacements: S.plPlacements, plDirty: S.plDirty };
    const map = new Map();
    const program = B.list.map((it) => { const c = { ...it }; map.set(it, c); return c; });
    S.playlist = { ...(S.playlist || {}), channel: S.channel.name, date: B.date, program };
    S.plPlacements = B.placements.map((p) => ({ ...p, refs: p.refs ? (p.refs.every((r) => map.has(r)) ? p.refs.map((r) => map.get(r)) : []) : undefined }));
    S.plDirty = true;
    const ok = await saveDayPlaylist();
    if (!ok) { ({ playlist: S.playlist, plPlacements: S.plPlacements, plDirty: S.plDirty } = keep); return; }
    if (!B) return;
    B.dirty = false;
    B.daySig = progSig(program);
    // The new live slot times become the reference.
    B.live0 = [];
    { let t = B.startS; for (const it of B.list) { if (isLiveSlot(it.source)) B.live0.push(t); t += itemDur(it); } }
    renderBldBar();
}
$('#bld-save').addEventListener('click', () => saveBuilder(false));
$('#bld-saveas').addEventListener('click', () => saveBuilder(true));

// ---- buttons, drag and drop ----
const srcPicked = () => { const s = B.src.rows.filter((r) => B.src.sel.has(r.key) && r.toItems); return s.length ? s : B.src.rows[B.src.cursor]?.toItems ? [B.src.rows[B.src.cursor]] : []; };
$('#bld-add').addEventListener('click', () => B && bldAdd(srcPicked()));
$('#bld-addall').addEventListener('click', async () => {
    if (!B || B.src.tab !== 'library') return;
    const n = B.src.total;
    if (!n) return;
    if (n > 20 && !(await confirmModal(T('Add all results?'), T('This adds {count} after the cursor row.', { count: plural(n, 'clip', 'clips') }), { ok: T('Add {n}', { n }) }))) return;
    try {
        while (B.src.loading) await new Promise((r) => setTimeout(r, 50));
        while (B.src.rows.length < B.src.total) {
            const before = B.src.rows.length;
            await loadLibrary(true);
            if (B.src.rows.length === before) break;
        }
    } catch { /* add what is there */ }
    bldAdd(B.src.rows.filter((r) => r.toItems));
});
$('#bld-remove').addEventListener('click', () => B && bldRemove());
$('#bld-up').addEventListener('click', () => B && bldMove(-1));
$('#bld-down').addEventListener('click', () => B && bldMove(1));
$('#bld-undo').addEventListener('click', () => B && bldUndo(false));
$('#bld-redo').addEventListener('click', () => B && bldUndo(true));
for (const [id, pane] of [['#bld-left', 'left'], ['#bld-right-pane', 'right']]) $(id).addEventListener('mousedown', () => { if (B && B.active !== pane) { B.active = pane; renderPanesActive(); } });
{
    const tgt = $('#bld-tgt'), src = $('#bld-src');
    tgt.addEventListener('dragover', (e) => {
        if (!B?.drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = B.drag.from === 'left' ? 'copy' : 'move';
        B.tgt.showLine(B.tgt.indexAt(e.clientY));
    });
    tgt.addEventListener('dragleave', (e) => { if (B?.tgt && !tgt.contains(e.relatedTarget)) B.tgt.showLine(null); });
    tgt.addEventListener('drop', (e) => {
        if (!B?.drag) return;
        e.preventDefault();
        const at = B.tgt.indexAt(e.clientY), d = B.drag;
        B.drag = null;
        B.tgt.showLine(null);
        if (d.from === 'left') bldAdd(d.rows, at); else bldMoveTo(d.items, at);
    });
    src.addEventListener('dragover', (e) => { if (B?.drag?.from !== 'right') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; src.classList.add('drop-remove'); });
    src.addEventListener('dragleave', (e) => { if (!src.contains(e.relatedTarget)) src.classList.remove('drop-remove'); });
    src.addEventListener('drop', (e) => {
        if (B?.drag?.from !== 'right') return;
        e.preventDefault();
        src.classList.remove('drop-remove');
        const items = B.drag.items;
        B.drag = null;
        bldRemove(items);
    });
    document.addEventListener('dragend', () => { if (!B) return; B.drag = null; B.tgt?.showLine(null); src.classList.remove('drop-remove'); });
}

// ---- keyboard (not while typing in a field, except Ctrl+F, F3, F4) ----
document.addEventListener('keydown', async (e) => {
    if (!B || $('#view-builder').hidden || document.querySelector('dialog[open]')) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const inField = e.target.closest?.('input, textarea, select');
    const right = B.active === 'right';
    const cur = right ? B.list[B.cursor] : B.src.rows[B.src.cursor];
    if (ctrl && k.toLowerCase() === 'f') { e.preventDefault(); if (B.src.tab !== 'library') setSrcTab('library'); $('#bld-q')?.focus(); B.active = 'left'; renderPanesActive(); return; }
    if (k === 'F3') { e.preventDefault(); const p = right ? cur?.source : cur?.path; if (p) playLocal(p); return; }
    if (k === 'F4') {
        e.preventDefault();
        const id = right ? B.info.get(cur?.source)?.id : cur?.id;
        if (!id) return toast(T('Clip details are for library clips only.'), 'err');
        try { editClip(await localJson('GET', `/local/builder/clip?id=${id}`)); } catch (err) { toast(err.message, 'err'); }
        return;
    }
    // Buttons, links, fields: Enter, Space, Tab and arrows do what they normally do there.
    if (e.target.closest?.('button, a, select, input, textarea, [contenteditable]')) { if (inField && k === 'Escape') e.target.blur(); return; }
    if (ctrl && (k.toLowerCase() === 'z' || k.toLowerCase() === 'y')) { e.preventDefault(); bldUndo(k.toLowerCase() === 'y' || e.shiftKey); return; }
    if (k === 'Tab') { e.preventDefault(); B.active = right ? 'left' : 'right'; (right ? $('#bld-src') : $('#bld-tgt')).focus(); renderPanesActive(); return; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        const d = k === 'ArrowUp' ? -1 : 1;
        if (right && ctrl) return bldMove(d);
        const P = right ? B : B.src, n = right ? B.list.length : B.src.rows.length;
        if (!n) return;
        P.cursor = Math.max(0, Math.min(n - 1, (P.cursor < 0 ? 0 : P.cursor) + d));
        if (e.shiftKey) bldPick(right ? 'right' : 'left', P.cursor, { shiftKey: true });
        (right ? B.tgt : B.srcv).scrollTo(P.cursor);
        if (right) { renderTarget(); if (B.src.tab === 'suggest') loadRelated(); } else renderSource();
        return;
    }
    if (k === ' ') {
        e.preventDefault();
        if (!cur || cur.head) return;
        const P = right ? B : B.src, key = right ? cur : cur.key;
        if (P.sel.has(key)) P.sel.delete(key); else P.sel.add(key);
        P.anchor = P.cursor;
        if (right) renderTarget(); else renderSource();
        return;
    }
    if (k === 'Enter' || k === 'Insert') {
        e.preventDefault();
        if (!right) { if (cur?.open && !B.src.sel.size) return cur.open(); bldAdd(srcPicked()); }
        return;
    }
    if (k === 'Delete' && right) { e.preventDefault(); bldRemove(); }
});
// After the clip details dialog saves, the list shows the new titles and rights.
$('#meta-dlg').addEventListener('close', () => { if (B) { B.info = new Map(); fetchBldInfo(); } });
window.addEventListener('resize', () => { if (B) { B.tgt?.refresh(); B.srcv?.refresh(); } });

