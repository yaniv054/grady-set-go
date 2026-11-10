// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 80-blocks. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- saved blocks
// Pre-edited slots for reuse (topical days and the like), stored by the panel in
// data\blocks.json; Remove moves a block to data\blocks-archive.json. Where a block was
// inserted into a saved day is kept by the panel too (data\block-placements.json, not in
// the ffplayout playlist) and drawn as a band in the playlist table.

// Item fields a block keeps (and puts back into a playlist); in/out trims included.
function toProgramItem(it) {
    const out = { in: Number(it.in) || 0, out: Number(it.out ?? it.duration), duration: Number(it.duration ?? it.out), source: it.source };
    for (const k of ['title', 'audio', 'custom_filter', 'category']) if (it[k]) out[k] = it[k];
    return out;
}

// Where each placement's file sequence is in a program: [{ from, to, offset_s } | null]
// (item indexes, inclusive). Files compare without regard to case or slash direction.
// With several matches the one nearest the placement's pinned start (or its recorded
// offset) wins; rows already matched (by an earlier placement, or marked in `taken`) are not used twice. Same
// function as matchPlacements() in server.js (quiet blocks in the live text).
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

// ---- placements (bands) of the open day ----
// Placements matched to the rows of the open day. Once found, a placement keeps the row
// objects it covers (refs): its band then follows those rows when other rows are added,
// moved or removed, and goes when one of its own rows is removed or moved out of order (the
// record stays until the day is saved). Without refs (just loaded) the file sequence is
// searched, nearest the pinned start or the recorded offset.
function placementMatches(prog, placements, dayStart) {
    const idx = new Map(prog.map((it, i) => [it, i]));
    const offs = [];
    let t = 0;
    for (const it of prog) { offs.push(t); t += itemDur(it); }
    const taken = new Uint8Array(prog.length);
    const out = placements.map((p) => {
        if (!p.refs) return undefined;
        const ix = p.refs.map((r) => idx.get(r));
        if (!ix.length || !ix.every((v, k) => v != null && v === ix[0] + k && !taken[v])) return null;
        for (const v of ix) taken[v] = 1;
        return { from: ix[0], to: ix[ix.length - 1], offset_s: offs[ix[0]] };
    });
    const rest = placements.map((p, k) => (out[k] === undefined ? k : -1)).filter((k) => k >= 0);
    if (rest.length) {
        const m = matchPlacements(prog, rest.map((k) => placements[k]), dayStart, taken);
        rest.forEach((k, j) => { out[k] = m[j]; if (m[j]) placements[k].refs = prog.slice(m[j].from, m[j].to + 1); });
    }
    return out;
}
// S.plPlacements: [{ block_id, name, quiet, start, sources, offset_s, saved }]; saved = as on
// the server. S.plStored: how many records the server has for that date.
S.plStored = { date: null, n: 0 };
// Name and Quiet as the block has them now (it may have been changed since it was inserted).
const blockNow = (p) => { const b = S.blocks.find((x) => x.id === p.block_id); return b ? { name: b.name, quiet: !!b.quiet } : { name: p.name, quiet: !!p.quiet }; };
const placementRecord = (p) => ({ block_id: p.block_id, ...blockNow(p), start: p.start || null, sources: p.sources, ...(p.offset_s != null ? { offset_s: p.offset_s } : {}) });
const savePlacements = (date, list) => localJson('POST', '/local/blocks/placements', { date, placements: list.map(placementRecord) });
// After a day is saved: keep the placements that still match its rows (with their current offset).
async function saveDayPlacements(pl) {
    const m = placementMatches(pl.program, S.plPlacements, parseHms(S.config.playlist.day_start) || 0);
    const keep = S.plPlacements.map((p, k) => (m[k] ? { ...p, offset_s: m[k].offset_s } : null)).filter(Boolean);
    const had = S.plStored.date === pl.date ? S.plStored.n : 0;
    if (!keep.length && !had) return;
    await savePlacements(pl.date, keep);
    S.plStored = { date: pl.date, n: keep.length };
    if (pl === S.playlist) S.plPlacements = keep.map((p) => ({ ...p, saved: true }));
}
async function detachPlacement(p) {
    if (!(await confirmModal(T('Detach this block?'), [
        `The rows stay in the playlist as they are; they are just no longer marked as the block “${bidiText(p.name)}”.`,
        p.start ? T('The pin at {start} goes too: Generate will no longer place this block on {date}.', { start: p.start, date: fmtDate(S.playlist.date) }) : '',
    ].filter(Boolean), { ok: T('Detach') }))) return;
    S.plPlacements = S.plPlacements.filter((x) => x !== p);
    if (p.saved) {
        const rest = S.plPlacements.filter((x) => x.saved);
        try { await savePlacements(S.playlist.date, rest); S.plStored = { date: S.playlist.date, n: rest.length }; toast(T('Block detached. The rows stay in the playlist.'), 'ok'); }
        catch (e) { toast(e.message, 'err'); }
    }
    renderPlaylist();
}

// ---- name / occasion / notes / quiet dialog ----
// Resolves with { name, occasion, notes, quiet } or null (cancelled).
function blockMetaDialog(init, { title, sub = '', ok = T('Save') }) {
    const dlg = $('#blk-meta-dlg'), f = $('#blk-meta-form');
    $('#blk-meta-title').textContent = title;
    $('#blk-meta-sub').textContent = sub;
    $('#blk-meta-ok').textContent = ok;
    f.elements.name.value = init.name || '';
    f.elements.occasion.value = init.occasion || '';
    f.elements.notes.value = init.notes || '';
    f.elements.quiet.checked = !!init.quiet;
    $('#blk-occ-list').replaceChildren(...(S.occNames || []).map((n) => h('option', { value: n })));
    dlg.showModal();
    f.elements.name.focus();
    return new Promise((resolve) => {
        const done = (v) => { f.onsubmit = null; $('#blk-meta-cancel').onclick = null; dlg.oncancel = null; dlg.close(); resolve(v); };
        f.onsubmit = (e) => {
            e.preventDefault();
            const name = f.elements.name.value.trim();
            if (!name) { toast(T('The block needs a name.'), 'err'); return; }
            done({ name, occasion: f.elements.occasion.value.trim(), notes: f.elements.notes.value.trim(), quiet: f.elements.quiet.checked });
        };
        $('#blk-meta-cancel').onclick = () => done(null);
        dlg.oncancel = (e) => { e.preventDefault(); done(null); };
    });
}

async function saveItemsAsBlock(items, what) {
    if (!items.length) return toast(T('Nothing to save: there are no rows.'), 'err');
    const meta = await blockMetaDialog({}, { title: T('Save as block'), sub: T('{what}. In and out points are kept.', { what }), ok: T('Save block') });
    if (!meta) return;
    try {
        const r = await localJson('POST', '/local/blocks', { ...meta, items: items.map(toProgramItem) });
        toast(T('Saved block “{name}”: {count}, {duration}.', { name: bidiText(r.block.name), count: plural(r.summary.items_n, 'item', 'items'), duration: fmtDur(r.summary.length_s) }), 'ok');
        loadBlocks();
    } catch (e) { toast(e.message, 'err'); }
}
$('#pl-saveday').addEventListener('click', () => {
    const items = S.playlist?.program || [];
    saveItemsAsBlock(items, T('The whole playlist of {date}: {count}, {duration}', { date: fmtDate(S.playlist?.date), count: Tn('{n} item', '{n} items', items.length), duration: fmtDur(items.reduce((s, it) => s + itemDur(it), 0)) }));
});

// ---- Saved blocks card ----
S.blocks = [];
S.occNames = [];
S.blockChecks = new Map();
const fetchBlock = async (id) => (await localJson('GET', `/local/blocks?id=${encodeURIComponent(id)}`)).block;
const blockCmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const sortedBlocks = () => [...S.blocks].sort((a, b) => blockCmp(a.name, b.name));
async function loadBlocks() {
    try { const r = await localJson('GET', '/local/blocks'); S.blocks = r.blocks; S.occNames = r.occasion_names || []; }
    catch (e) { $('#blk-list').replaceChildren(h('li', { class: 'muted' }, e.message)); return; }
    // Badges: one batched check of every block for today's broadcast day.
    S.blockChecks = new Map();
    renderBlocks();
    checkBlockBadges();
}
const blockCheckKey = (b, date) => `${date}|${b.id}|${b.updated}`;
async function checkBlockBadges() {
    const date = broadcastDate();
    const want = S.blocks.filter((b) => !S.blockChecks.has(blockCheckKey(b, date)));
    if (!want.length) return;
    try {
        const r = await localJson('POST', '/local/blocks/check', { ids: want.map((b) => b.id), date });
        for (const b of want) if (r.results[b.id]) S.blockChecks.set(blockCheckKey(b, date), r.results[b.id]);
        renderBlocks();
    } catch { /* the badges are optional */ }
}
function blockBadge(r) {
    if (!r) return null;
    const c = r.counts, tip = r.notes.join('\n') + (r.problems > r.notes.length ? '\n…' : '');
    if (c.missing) return h('span', { class: 'badge bad', title: tip }, T('{count} missing', { count: n0(c.missing) }));
    const n = c.hidden + c.not_cleared + c.explicit_window;
    if (n) return h('span', { class: 'badge warn', title: tip }, Tn('{n} warning', '{n} warnings', n));
    if (c.moved) return h('span', { class: 'badge', title: tip }, T('{count} moved', { count: n0(c.moved) }));
    return null;
}
function renderBlocks() {
    const q = $('#blk-q').value.trim().toLowerCase();
    const date = broadcastDate();
    const list = sortedBlocks().filter((b) => !q || [b.name, b.occasion, b.notes].some((v) => String(v || '').toLowerCase().includes(q)));
    const editing = B?.mode === 'block' ? B.block.id : null;
    $('#blk-list').replaceChildren(...(list.length ? list.map((b) => h('li', { class: 'blk-item' + (editing === b.id ? ' editing' : '') },
        h('div', { class: 'blk-main' },
            h('div', { class: 'name' }, bidiText(b.name), b.quiet ? h('span', { class: 'badge quiet', title: T('No automatic branding or live text inside') }, T('Quiet')) : null, blockBadge(S.blockChecks.get(blockCheckKey(b, date))), editing === b.id ? h('span', { class: 'badge on' }, T('Open')) : null),
            b.occasion ? h('div', { class: 'muted small bidi' }, b.occasion) : null,
            h('div', { class: 'muted small' }, [fmtDur(b.length_s), Tn('{n} clip', '{n} clips', b.clips), b.items_n !== b.clips ? Tn('{n} channel file', '{n} channel files', b.items_n - b.clips) : '', b.last_used ? T('last used {time}', { time: fmtStamp(b.last_used) }) : 'not used yet'].filter(Boolean).join(' · '))),
        h('div', { class: 'acts' },
            h('button', { class: 'btn small', onclick: () => openInsert(b.id) }, T('Insert…')),
            h('button', { class: 'btn ghost small', onclick: () => editBlock(b.id) }, T('Edit…')),
            h('button', { class: 'btn ghost small', onclick: () => duplicateBlock(b.id) }, T('Duplicate')),
            h('button', { class: 'btn ghost small danger', onclick: () => removeBlockUi(b) }, T('Remove')))))
        : [h('li', { class: 'muted small' }, S.blocks.length ? T('No block matches the search.') : T('No saved blocks yet. Tick rows in the playlist and press “Save selection as block…”, or press New block.'))]));
}
$('#blk-q').addEventListener('input', renderBlocks);
async function duplicateBlock(id) {
    try {
        const b = await fetchBlock(id);
        const r = await localJson('POST', '/local/blocks', { name: `${b.name} (copy)`.slice(0, 80), occasion: b.occasion, notes: b.notes, quiet: b.quiet, items: b.items });
        toast(T('Duplicated as “{name}”.', { name: bidiText(r.block.name) }), 'ok');
        loadBlocks();
    } catch (e) { toast(e.message, 'err'); }
}
async function removeBlockUi(b) {
    if (B?.mode === 'block' && B.block.id === b.id) return toast(T('This block is open in the block builder. Close it first.'), 'err');
    if (!(await confirmModal(T('Remove this block?'), [T('“{name}” is moved to the blocks archive (data\\blocks-archive.json); nothing is deleted. Playlists that already contain its rows keep them.', { name: bidiText(b.name) })], { ok: T('Move to archive') }))) return;
    try { await localJson('POST', '/local/blocks/remove', { id: b.id }); toast(T('Block moved to the archive.'), 'ok'); loadBlocks(); }
    catch (e) { toast(e.message, 'err'); }
}

// ---- Insert dialog ----
// Checks the block for the open day (moved files use their current path; missing files are
// always left out, hidden ones by choice) and inserts it (a) at the row boundary nearest a
// time (kept as a pin for that date), (b) before the first selected row or (c) at the end.
let insertTime = '';
async function openInsert(id) {
    let b;
    try { b = await fetchBlock(id); } catch (e) { return toast(e.message, 'err'); }
    if (!S.playlist) return;
    const dlg = $('#blk-ins-dlg'), body = $('#blk-ins-body'), okBtn = $('#blk-ins-ok');
    const pl = S.playlist, prog = pl.program;
    const dayStart = parseHms(S.config.playlist.day_start) || 0;
    const cum = [0];
    for (const it of prog) cum.push(cum[cum.length - 1] + itemDur(it));
    const selIdx = prog.findIndex((it) => S.plSel.has(it));
    const st = { pos: selIdx >= 0 ? 'before' : 'end', check: null, pending: null, drop: new Set(), inited: false, timer: null, repTouched: false };
    // Rows that must keep their time: the live slot and pinned blocks.
    const fixed = [], guard = [];
    {
        prog.forEach((it, i) => { if (isLiveSlot(it.source)) fixed.push({ from: i, to: i, label: T('the live slot at {time}', { time: clockOf(dayStart + cum[i]) }) }); });
        placementMatches(prog, S.plPlacements, dayStart).forEach((m, j) => {
            if (!m) return;
            const x = S.plPlacements[j];
            const g = { from: m.from, to: m.to, label: T('the {v}block “{name}” at {time}', { v: x.start ? 'pinned ' : '', name: bidiText(x.name), time: clockOf(dayStart + cum[m.from]) }) };
            guard.push(g);
            if (x.start) fixed.push(g);
        });
        fixed.sort((a, c) => a.from - c.from);
        for (const f of fixed) if (!guard.includes(f)) guard.push(f);
    }
    // Replace never covers the live slot or any saved block's rows (pinned or not).
    const fixedAt = (i) => guard.find((f) => i >= f.from && i <= f.to);
    // Length that will go in (items left out do not count).
    const insLen = () => (st.check ? st.check.items.filter((x) => !x.warnings.some((w) => w.type === 'missing') && !st.drop.has(x.index)).reduce((t, x) => t + itemDur(x.item), 0) : b.items.reduce((t, it) => t + itemDur(it), 0));
    // "Replace the rows in that time range": rows from k that overlap the block's span go;
    // a row running past its end keeps only that end part (under a minute: off-air slate).
    // Never the live slot or a pinned block.
    const replacePlan = (k, L) => {
        const t1 = cum[k] + L;
        let j = k;
        while (j < prog.length && cum[j] < t1 - 0.01) { const f = fixedAt(j); if (f) return { error: `Replacing would cover ${f.label}; insert elsewhere or untick Replace.` }; j++; }
        return { n: j - k, tail: j > k ? Math.max(0, cum[j] - t1) : 0, t1 };
    };
    const repBox = h('input', { type: 'checkbox', checked: st.pos === 'time', onchange: () => { st.repTouched = true; updateMove(); } });
    const repLabel = h('label', { class: 'check' }, repBox, T('Replace the rows in that time range (what follows keeps its time)'));
    const moveLine = h('p', { class: 'small ins-move' });
    const useReplace = () => st.pos !== 'end' && repBox.checked;
    function updateMove() {
        const p = position();
        repLabel.hidden = st.pos === 'end';
        moveLine.replaceChildren();
        if (p.k == null) return;
        const L = insLen();
        if (useReplace()) {
            const r = replacePlan(p.k, L);
            if (r.error) { moveLine.append(h('span', { class: 'bad' }, r.error)); okBtn.disabled = true; return; }
            moveLine.append(r.n ? `Replaces ${Tn('{n} row', '{n} rows', r.n)} from ${clockOf(dayStart + cum[p.k])} to ${clockOf(dayStart + r.t1)}${r.tail > 0.01 ? T(' (the remaining {duration} of the last one becomes off-air slate)', { duration: fmtDur(r.tail) }) : ''}; what follows keeps its time.` : T('Nothing to replace there.'));
        } else {
            const next = fixed.find((f) => f.from >= p.k);
            if (next) moveLine.append(h('span', { class: 'warn' }, T('This moves {label}{v} {duration} later, to {time}. Tick Replace to keep it in place.', { label: next.label, v: fixed.filter((f) => f.from >= p.k).length > 1 ? T(' (and what comes after it)') : '', duration: fmtDur(L), time: clockOf(dayStart + cum[next.from] + L) })));
        }
        if (st.check) okBtn.disabled = !st.check.items.some((x) => !x.warnings.some((w) => w.type === 'missing') && !st.drop.has(x.index));
    }
    const radio = (v, disabled) => h('input', { type: 'radio', name: 'ins-pos', value: v, checked: st.pos === v, disabled, onchange: () => { st.pos = v; if (!st.repTouched) repBox.checked = v === 'time'; refresh(); } });
    const radios = { time: radio('time', false), before: radio('before', selIdx < 0), end: radio('end') };
    const timeIn = h('input', { class: 'ins-time', inputmode: 'numeric', placeholder: '20:00', value: insertTime, 'aria-label': T('Start time'),
        oninput: () => { st.pos = 'time'; radios.time.checked = true; if (!st.repTouched) repBox.checked = true; refresh(); } });
    const startLine = h('p', { class: 'small ins-start' });
    const checks = h('div', { class: 'ins-checks' }, h('p', { class: 'muted small' }, T('Checking…')));
    // Where the block goes: { k: row index or null, want, hm } (want = requested offset).
    const position = () => {
        if (st.pos === 'before') return { k: selIdx };
        if (st.pos === 'end') return { k: prog.length };
        const tsec = parseHM(timeIn.value);
        if (tsec == null || tsec >= 86400) return { k: null };
        const want = ((tsec - dayStart) % 86400 + 86400) % 86400;
        let k = 0;
        for (let i = 1; i < cum.length; i++) if (Math.abs(cum[i] - want) < Math.abs(cum[k] - want)) k = i;
        return { k, want, hm: fmtHM(tsec) };
    };
    const offBy = (p) => (p.want == null ? 0 : cum[p.k] - p.want);
    const drawChecks = () => {
        const r = st.check;
        if (!r) return;
        const bad = r.items.filter((x) => x.warnings.length);
        const c = r.counts;
        const head = bad.length
            ? `Checked for ${fmtDate(r.date)}${r.start ? T(' starting {start}', { start: r.start }) : ''}: ` + [c.missing && T('{count} missing (left out)', { count: n0(c.missing) }), c.hidden && `${n0(c.hidden)} hidden`, c.moved && T('{count} renamed or moved (current path used)', { count: n0(c.moved) }), c.not_cleared && T('{count} not rights-cleared', { count: n0(c.not_cleared) }), c.explicit_window && T('{count} explicit outside the allowed hours', { count: n0(c.explicit_window) })].filter(Boolean).join(' · ')
            : T('No problems found for {date}.', { date: fmtDate(r.date) });
        checks.replaceChildren(h('p', { class: bad.length ? 'small' : 'small ok' }, head), bad.length ? h('ul', { class: 'ins-list' }, ...bad.map((x) => {
            const missing = x.warnings.some((w) => w.type === 'missing');
            const hidden = x.warnings.some((w) => w.type === 'hidden');
            const drop = missing ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: true, disabled: true }), T('Left out (missing)'))
                : hidden ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: st.drop.has(x.index), onchange: (e) => { if (e.target.checked) st.drop.add(x.index); else st.drop.delete(x.index); updateMove(); } }), T('Leave out')) : null;
            return h('li', { class: missing ? 'bad' : '' },
                h('div', { class: 'row-between' }, h('span', {}, `${x.index + 1}. `, bidiText(x.title)), drop),
                h('ul', { class: 'small muted' }, ...x.warnings.map((w) => h('li', { class: 'bidi' }, w.text))));
        })) : null);
        const n = r.items.filter((x) => !x.warnings.some((w) => w.type === 'missing') && !st.drop.has(x.index)).length;
        okBtn.disabled = !n;
        okBtn.textContent = n === r.items.length ? T('Insert') : T('Insert {n} of {count}', { n, count: r.items.length });
        updateMove();
    };
    const runCheck = () => {
        const p = position();
        const start = p.k == null ? null : clockOf(dayStart + cum[p.k]);
        const job = localJson('POST', '/local/blocks/check', { id: b.id, date: pl.date, start, day_start_s: dayStart });
        st.pending = job;
        job.then((r) => {
            if (st.pending !== job) return;
            st.pending = null;
            st.check = r;
            if (!st.inited) { st.inited = true; for (const x of r.items) if (x.warnings.some((w) => w.type === 'hidden')) st.drop.add(x.index); }
            drawChecks();
        }).catch((e) => { if (st.pending === job) { st.pending = null; checks.replaceChildren(h('p', { class: 'small bad' }, e.message)); } });
        return job;
    };
    function refresh() {
        const p = position();
        if (p.k == null) startLine.replaceChildren(h('span', { class: 'warn' }, T('Enter the start time as HH:MM, e.g. 20:00.')));
        else {
            const off = offBy(p);
            startLine.replaceChildren(T('Starts at {time} (row {v}).', { time: clockOf(dayStart + cum[p.k]), v: p.k + 1 }),
                Math.abs(off) > 60 ? h('span', { class: 'warn' }, T(' That is {duration} {v} {hm}: the nearest row boundary. Move rows or trim to get closer.', { duration: fmtDur(Math.abs(off)), v: off > 0 ? 'after' : 'before', hm: p.hm })) : '');
        }
        updateMove();
        // The explicit-language check depends on the start: checked again (debounced).
        clearTimeout(st.timer);
        st.timer = setTimeout(runCheck, 250);
    }
    $('#blk-ins-title').textContent = T('Insert block: {name}', { name: bidiText(b.name) });
    const len = b.items.reduce((s, it) => s + itemDur(it), 0);
    body.replaceChildren(
        h('p', { class: 'muted small' }, T('{count} · {duration}{v} · into the playlist of {v2} {date}', { count: plural(b.items.length, 'item', 'items'), duration: fmtDur(len), v: b.quiet ? T(' · Quiet (no automatic branding or live text inside)') : '', v2: WEEKDAY[new Date(pl.date + 'T12:00:00').getDay()], date: fmtDate(pl.date) })),
        h('fieldset', { class: 'ins-pos' }, h('legend', {}, T('Position')),
            h('label', { class: 'check' }, radios.time, T('At time '), timeIn, h('span', { class: 'muted small' }, T(' — the nearest row boundary; kept as a pin for this date'))),
            h('label', { class: 'check' }, radios.before, selIdx >= 0 ? T('Before the selected row (row {v})', { v: selIdx + 1 }) : T('Before the selected row (tick a row first)')),
            h('label', { class: 'check' }, radios.end, T('At the end')),
            startLine, repLabel, moveLine),
        checks);
    okBtn.disabled = true;
    okBtn.textContent = T('Insert');
    const close = () => { clearTimeout(st.timer); st.pending = null; okBtn.onclick = $('#blk-ins-cancel').onclick = dlg.oncancel = null; dlg.close(); };
    $('#blk-ins-cancel').onclick = close;
    dlg.oncancel = (e) => { e.preventDefault(); close(); };
    okBtn.onclick = async () => {
        const p = position();
        if (p.k == null) return toast(T('Enter the start time as HH:MM, e.g. 20:00.'), 'err');
        // The check for the current position (it may still be running).
        clearTimeout(st.timer);
        let r;
        try { r = await runCheck(); } catch (e) { return toast(e.message, 'err'); }
        if (!dlg.open || S.playlist !== pl) return;
        const keep = r.items.filter((x) => !x.warnings.some((w) => w.type === 'missing') && !st.drop.has(x.index)).map((x) => toProgramItem(x.item));
        if (!keep.length) return toast(T('Nothing left to insert: every item is left out.'), 'err');
        const off = offBy(p);
        let repl = null;
        if (useReplace()) {
            repl = replacePlan(p.k, keep.reduce((t, it) => t + itemDur(it), 0));
            if (repl.error) return toast(repl.error, 'err');
        }
        if (repl && repl.n) {
            const last = prog[p.k + repl.n - 1];
            // The rest of a clip the block ends inside: off-air slate (a clip never airs from its middle).
            const tail = repl.tail > 0.01 ? slateItem(offairSource(), repl.tail) : null;
            prog.splice(p.k, repl.n, ...keep, ...(tail ? [tail] : []));
        } else prog.splice(p.k, 0, ...keep);
        S.plPlacements.push({ block_id: b.id, name: b.name, quiet: !!b.quiet, start: st.pos === 'time' ? p.hm : null, sources: keep.map((i) => i.source), offset_s: cum[p.k], saved: false, refs: keep });
        if (st.pos === 'time') insertTime = timeIn.value.trim();
        S.plDirty = true;
        close();
        renderPlaylist();
        refreshRights();
        localJson('POST', '/local/blocks/used', { id: b.id }).then(loadBlocks).catch(() => {});
        const at = `starting ${clockOf(dayStart + cum[p.k])}`;
        const dropped = r.items.length - keep.length;
        toast(T('Inserted “{name}” ({count}) {at}', { name: bidiText(b.name), count: Tn('{n} item', '{n} items', keep.length), at }) +
            (Math.abs(off) > 60 ? T(', {duration} {v} {hm} (the nearest row boundary)', { duration: fmtDur(Math.abs(off)), v: off > 0 ? 'after' : 'before', hm: p.hm }) : '') +
            (dropped ? `; ${Tn('{n} item', '{n} items', dropped)} left out` : '') + (repl?.n ? `; replaced ${Tn('{n} row', '{n} rows', repl.n)}` : '') + '. Press Save to keep it.', Math.abs(off) > 60 || dropped ? 'err' : 'ok');
    };
    dlg.showModal();
    refresh();
}

// ---------------------------------------------------------------- occasions
// Days like Memorial Day, every date entered by hand (data\occasions.json). On those dates
// Generate and Fill use the occasion's branding set and pin its blocks at their times.
S.occasions = [];
async function loadOccasions() {
    try { S.occasions = (await localJson('GET', '/local/occasions')).occasions; }
    catch (e) { $('#occ-list').replaceChildren(h('li', { class: 'muted' }, e.message)); return; }
    renderOccasions();
}
const nextOccDate = (o, from) => (o.dates || []).map((d) => d.date).filter((d) => d >= from).sort()[0] || null;
const weekdayDate = (iso) => `${WEEKDAY[new Date(iso + 'T12:00:00').getDay()]} ${fmtDate(iso)}`;
function renderOccasions() {
    const from = broadcastDate();
    const name = (id) => S.blocks.find((b) => b.id === id)?.name || T('(removed block)');
    const list = [...S.occasions].map((o) => ({ o, next: nextOccDate(o, from) }))
        .sort((a, b) => (a.next ? 0 : 1) - (b.next ? 0 : 1) || String(a.next).localeCompare(String(b.next)) || blockCmp(a.o.name, b.o.name));
    $('#occ-list').replaceChildren(...(list.length ? list.map(({ o, next }) => {
        const day = next && o.dates.find((d) => d.date === next);
        return h('li', { class: 'blk-item' },
            h('div', { class: 'blk-main' },
                h('div', { class: 'name' }, bidiText(o.name)),
                h('div', { class: 'muted small' }, T(`Branding: `), bidiText(setLabel(o.branding_set)), ` · ${Tn('{n} date', '{n} dates', o.dates.length)}`),
                h('div', { class: next ? 'small' : 'muted small' }, next ? [`Next: ${weekdayDate(next)}`, day.placements.length ? ` — ${day.placements.map((p) => `${bidiText(name(p.block_id))} at ${p.start}`).join(', ')}` : T(' — no blocks pinned')].join('') : T('No upcoming date'))),
            h('div', { class: 'acts' },
                h('button', { class: 'btn ghost small', onclick: () => editOccasion(o) }, T('Edit')),
                h('button', { class: 'btn ghost small danger', onclick: () => removeOccasionUi(o) }, T('Remove'))));
    }) : [h('li', { class: 'muted small' }, T('No occasions yet.'))]));
}
async function removeOccasionUi(o) {
    if (!(await confirmModal(T('Remove this occasion?'), T('“{name}” is moved to the occasions archive (data\\occasions-archive.json); nothing is deleted. Saved playlists stay as they are.', { name: bidiText(o.name) }), { ok: T('Move to archive') }))) return;
    try { await localJson('POST', '/local/occasions/remove', { id: o.id }); toast(T('Occasion moved to the archive.'), 'ok'); loadOccasions(); loadBlocks(); checkSchedule(); }
    catch (e) { toast(e.message, 'err'); }
}
function occPinRow(p) {
    const sel = h('select', { class: 'occ-blk', 'aria-label': T('Block') }, h('option', { value: '' }, T('Choose a block…')),
        ...sortedBlocks().map((b) => h('option', { value: b.id }, `${bidiText(b.name)} (${fmtDur(b.length_s)})`)),
        p.block_id && !S.blocks.some((b) => b.id === p.block_id) ? h('option', { value: p.block_id }, T('(removed block)')) : null);
    sel.value = p.block_id || '';
    const tin = h('input', { class: 'occ-start', value: p.start || '', placeholder: '20:00', inputmode: 'numeric', 'aria-label': T('Start time') });
    const ends = h('span', { class: 'muted small occ-ends' });
    const upd = () => { const b = S.blocks.find((x) => x.id === sel.value); const t = parseHM(tin.value); ends.textContent = b && t != null && t < 86400 ? T('until {v}', { v: clockOf(t + b.length_s).slice(0, 5) }) : ''; };
    sel.addEventListener('change', upd);
    tin.addEventListener('input', upd);
    upd();
    const row = h('div', { class: 'occ-pin' }, sel, h('span', { class: 'muted small' }, T('at')), tin, ends,
        h('button', { type: 'button', class: 'btn ghost icon', title: T('Remove this block from the date'), onclick: () => row.remove() }, '✕'));
    return row;
}
function occDateRow(d) {
    const pins = h('div', { class: 'occ-pins' });
    const wd = h('span', { class: 'muted small' });
    const input = h('input', { class: 'occ-date-in', value: d.date ? fmtDate(d.date) : '', placeholder: dateHint(), inputmode: 'numeric', 'aria-label': T('Date') });
    const upd = () => { const iso = parseDate(input.value); wd.textContent = iso ? WEEKDAY[new Date(iso + 'T12:00:00').getDay()] : input.value.trim() ? T('not a date (dd/mm/yy)') : ''; };
    input.addEventListener('input', upd);
    const row = h('div', { class: 'occ-date' },
        h('div', { class: 'occ-date-head' }, input, wd,
            h('button', { type: 'button', class: 'btn ghost small', onclick: () => pins.append(occPinRow({})) }, T('Add block')),
            h('button', { type: 'button', class: 'btn ghost small danger', onclick: () => row.remove() }, T('Remove date'))),
        pins);
    for (const p of d.placements || []) pins.append(occPinRow(p));
    upd();
    return row;
}
async function editOccasion(o) {
    let sets = [];
    try { sets = (await localJson('GET', '/local/branding/sets')).sets; } catch { /* Default only */ }
    if (!S.blocks.length) await loadBlocks();
    const f = $('#occ-form'), dlg = $('#occ-dlg'), wrap = $('#occ-dates');
    $('#occ-title').textContent = o ? T('Edit occasion') : T('New occasion');
    f.elements.name.value = o?.name || '';
    f.elements.notes.value = o?.notes || '';
    const cur = o?.branding_set || '';
    f.elements.branding_set.replaceChildren(h('option', { value: '' }, T('Default')), h('option', { value: 'none' }, T('Quiet – no automatic branding')), ...sets.map((s) => h('option', { value: s }, s)),
        cur && cur !== 'none' && !sets.includes(cur) ? h('option', { value: cur }, T('{cur} (set not found)', { cur })) : null);
    f.elements.branding_set.value = cur;
    wrap.replaceChildren(...(o?.dates || []).map(occDateRow));
    if (!o) wrap.append(occDateRow({ date: '', placements: [] }));
    $('#occ-add-date').onclick = () => { const r = occDateRow({ date: '', placements: [] }); wrap.append(r); $('.occ-date-in', r).focus(); };
    const close = () => { f.onsubmit = null; $('#occ-cancel').onclick = null; dlg.close(); };
    $('#occ-cancel').onclick = close;
    f.onsubmit = async (e) => {
        e.preventDefault();
        const dates = [];
        try {
            for (const row of $$('.occ-date', wrap)) {
                const raw = $('.occ-date-in', row).value.trim();
                // Blocks are optional: rows left completely empty are ignored.
                const pinRows = $$('.occ-pin', row).filter((pr) => $('.occ-blk', pr).value || $('.occ-start', pr).value.trim());
                if (!raw && !pinRows.length) continue;
                const iso = parseDate(raw);
                if (!iso) throw new Error(raw ? T('“{raw}” is not a date. Use {format}.', { raw, format: dateHint() }) : T('A date is empty. Fill it in or press Remove date.'));
                const placements = [];
                for (const pr of pinRows) {
                    const block_id = $('.occ-blk', pr).value, t = parseHM($('.occ-start', pr).value);
                    if (!block_id) throw new Error(T('{date}: choose a block for the start time, or clear the row (✕).', { date: fmtDate(iso) }));
                    if (t == null || t >= 86400) throw new Error(T('{date}: the start time must be HH:MM, e.g. 20:00.', { date: fmtDate(iso) }));
                    placements.push({ block_id, start: fmtHM(t) });
                }
                dates.push({ date: iso, placements });
            }
        } catch (err) { return toast(err.message, 'err'); }
        try {
            await localJson('POST', '/local/occasions', { id: o?.id, name: f.elements.name.value.trim(), branding_set: f.elements.branding_set.value, notes: f.elements.notes.value.trim(), dates });
            close();
            toast(T('Occasion saved. Generate and Fill use it on its dates.'), 'ok');
            loadOccasions();
            loadBlocks();
            checkSchedule();
        } catch (err) { toast(err.message, 'err'); }
    };
    dlg.showModal();
}
$('#occ-new').addEventListener('click', () => editOccasion(null));

