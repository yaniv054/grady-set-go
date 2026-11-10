// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 70-program. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- program

function sep() { return String(S.channel.storage).includes('\\') ? '\\' : '/'; }
function storagePath(rel) {
    const root = String(S.channel.storage).replace(/[\\/]+$/, '');
    return rel ? root + sep() + rel.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep()) : root;
}

// What the saved playlist looked like when it was loaded (to notice changes made elsewhere).
const progSig = (prog) => JSON.stringify((prog || []).map((i) => [i.source, i.in, i.out]));
const dayTitle = (date) => T('Playlist · {v} {date}', { v: WEEKDAY[new Date(date + 'T12:00:00').getDay()], date: fmtDate(date) });
async function loadPlaylist() {
    const date = $('#pl-date').value;
    if (S.plDirty && S.playlist && S.playlist.date !== date && !(await confirmModal(T('Discard changes?'), T('The current playlist has unsaved changes.'), { ok: T('Discard') }))) {
        $('#pl-date').value = S.playlist.date;
        return;
    }
    $('#pl-title').textContent = dayTitle(date);
    // Only the latest request counts: an older answer for another date is dropped.
    const seq = (loadPlaylist.seq = (loadPlaylist.seq || 0) + 1);
    // Until this day has loaded, the heading names the new day while S.playlist and the
    // table still hold the previous one: nothing that saves, deletes or generates may run.
    const dayActions = () => ['#pl-save', '#pl-delete', '#pl-builder', '#gen-run', '#fill-run'].map((s) => $(s)).filter(Boolean);
    dayActions().forEach((b) => { b.disabled = true; });
    $('#pl-summary') && ($('#pl-summary').textContent = T('Loading…'));
    loadPlaylist.pending = seq;
    const release = () => { if (seq === loadPlaylist.seq) { loadPlaylist.pending = 0; dayActions().forEach((b) => { b.disabled = false; }); } };
    let pl, err = null;
    // Saved blocks inserted into this day (bands in the table), kept by the panel.
    const placed = localJson('GET', `/local/blocks/placements?date=${date}`).then((r) => r.placements).catch(() => []);
    try {
        const p = await api('GET', `/api/playlist/${S.channelId}?date=${date}`);
        pl = p && p.program ? p : { channel: S.channel.name, date, program: [] };
    } catch (e) {
        pl = { channel: S.channel.name, date, program: [] };
        err = e;
    }
    const placements = await placed;
    if (seq !== loadPlaylist.seq || $('#pl-date').value !== date) { release(); return; }
    release();
    if (err && !/not found|no such|404/i.test(err.message)) toast(err.message, 'err');
    S.playlist = pl;
    S.plDirty = false;
    S.plPlacements = placements.map((x) => ({ ...x, saved: true }));
    S.plStored = { date, n: placements.length };
    S.plSig = progSig(pl.program);
    renderPlaylist();
    refreshRights();
    if (!loadPlaylist.browsed) { loadPlaylist.browsed = true; renderFormats(); browse(''); renderGenFolders(); loadTemplates(); loadBlocks(); loadOccasions(); }
    else updateSelectionCount();
    renderWindowHint();
}

// Sources in the open playlist that are not cleared for YouTube on its date
// (files under ffplayout storage, like the filler, are ours and not checked).
S.plRights = new Map();
const inStorage = (src) => String(src).toLowerCase().startsWith(String(S.channel?.storage || '').toLowerCase() + '\\');
async function rightsProblems(program, date) {
    const sources = [...new Set(program.map((i) => i.source).filter((x) => x && !inStorage(x)))];
    if (!sources.length) return [];
    return (await localJson('POST', '/local/meta/check', { sources, date })).not_cleared;
}
async function refreshRights() {
    const pl = S.playlist;
    try {
        const bad = await rightsProblems(pl.program, pl.date);
        if (pl !== S.playlist) return;
        S.plRights = new Map(bad.map((b) => [b.source.toLowerCase(), b.reason]));
        renderPlaylist();
    } catch { /* optional */ }
}

function itemDur(item) {
    const d = (item.out ?? item.duration) - (item.in || 0);
    return Number.isFinite(d) ? d : 0;
}

// Saved-block bands in the playlist table (one colour per placement).
const BAND_COLORS = ['#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#38bdf8'];
S.plPlacements = [];
S.plSel = new Set();
S.plAnchor = null;

function renderPlaylist() {
    const tbody = $('#pl-table tbody');
    const prog = S.playlist.program;
    const start = parseHms(S.config.playlist.day_start) || 0;
    const len = parseHms(S.config.playlist.length) || 86400;
    let t = start;
    // Reuse the thumbnail <img> elements of the previous rendering (moving or removing a
    // row then does not load every picture again).
    const pics = new Map();
    for (const img of $$('img.thumb', tbody)) { const k = img.dataset.src; if (!pics.has(k)) pics.set(k, []); pics.get(k).push(img); }
    const thumbOf = (src) => pics.get(src)?.shift() || h('img', { class: 'thumb small', 'data-src': src, src, loading: 'lazy', alt: '', onerror: (e) => { e.target.style.visibility = 'hidden'; } });
    // Selection follows the items (moving a row keeps it selected); removed items drop out.
    const inProg = new Set(prog);
    for (const it of [...S.plSel]) if (!inProg.has(it)) S.plSel.delete(it);
    // Bands: placements whose file sequence is still in the program. A placement that no
    // longer matches (rows edited) just has no band; its record goes at the next save.
    const heads = new Map(), bandOf = [];
    placementMatches(prog, S.plPlacements, start).forEach((m, k) => {
        if (!m) return;
        const color = BAND_COLORS[k % BAND_COLORS.length];
        heads.set(m.from, { p: S.plPlacements[k], m, color });
        for (let i = m.from; i <= m.to; i++) bandOf[i] = color;
    });
    tbody.replaceChildren();
    if (!prog.length) tbody.append(h('tr', {}, h('td', { colspan: 7, class: 'empty' }, T('No playlist for this date. Generate one or add media from the right.'))));
    prog.forEach((item, i) => {
        const dur = itemDur(item);
        const clock = t; // this row's start; `t` itself keeps moving as the loop runs
        const move = (d) => { const j = i + d; if (j < 0 || j >= prog.length) return; [prog[i], prog[j]] = [prog[j], prog[i]]; S.plDirty = true; renderPlaylist(); };
        const btype = brandTypeOfSrc(item.source);
        const head = heads.get(i);
        if (head) tbody.append(blockHeadRow(head, prog));
        const sel = S.plSel.has(item);
        tbody.append(h('tr', { 'data-i': i, class: [btype ? 'brandrow' : '', bandOf[i] ? 'inblock' : '', sel ? 'sel' : ''].filter(Boolean).join(' ') || null, style: bandOf[i] ? `--band:${bandOf[i]}` : null },
            h('td', { class: 'selcell' }, h('input', { type: 'checkbox', checked: sel, 'aria-label': T('Select row {v}', { v: i + 1 }), onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, onclick: (e) => selectRow(i, e.shiftKey) })),
            h('td', { class: 'num muted' }, i + 1),
            h('td', { class: 'mono start-cell', tabindex: 0, title: T('Double-click (or Enter) to set the start time'), 'data-clock': clock,
                ondblclick: (e) => startCellEditor(e.currentTarget, clock, (sec) => setProgramRowStart(i, sec)),
                onkeydown: (e) => { if ((e.key === 'Enter' || e.key === 'F2') && e.target === e.currentTarget) { e.preventDefault(); startCellEditor(e.currentTarget, clock, (sec) => setProgramRowStart(i, sec)); } } }, clockOf(clock)),
            h('td', {}, thumbOf(btype ? brandThumbUrl(item.source) : `/local/thumb?path=${encodeURIComponent(item.source)}`),
                btype ? h('span', { class: 'badge brandtag' }, (BRAND_INFO[btype]?.[0] || btype).replace(/s$/, '')) : null, isOffair(item.source) ? h('span', { class: 'muted' }, T('⏸ Off air (slate)')) : isLiveSlot(item.source) ? h('span', { class: 'badge live' }, T('● Live slot')) : playLink(bidiText(item.title || baseName(item.source)), item.source), item.ad ? h('span', { class: 'badge', style: 'margin-left:6px' }, T('Ad')) : null,
                S.plRights.has(String(item.source).toLowerCase()) ? h('span', { class: 'badge warn', style: 'margin-left:6px', title: S.plRights.get(String(item.source).toLowerCase()) }, T('Not cleared')) : null),
            h('td', { class: 'muted small' }, bidiText(dirName(item.source))),
            h('td', { class: 'num mono' }, fmtDur(dur)),
            h('td', { class: 'acts' },
                h('button', { class: 'btn ghost icon', title: T('Move up'), onclick: () => move(-1) }, '▲'),
                h('button', { class: 'btn ghost icon', title: T('Move down'), onclick: () => move(1) }, '▼'),
                h('button', { class: 'btn ghost icon', title: T('Remove'), onclick: () => { prog.splice(i, 1); S.plDirty = true; renderPlaylist(); } }, '✕')),
        ));
        t += dur;
    });
    const total = t - start;
    const gap = len - total;
    $('#pl-summary').replaceChildren(...[
        h('span', {}, T('Items '), h('b', {}, prog.length)),
        h('span', {}, T('Total '), h('b', {}, fmtDur(total)), T(' of {count}', { count: S.config.playlist.length })),
        h('span', {}, T('Day '), h('b', {}, `${S.config.playlist.day_start} → ${clockOf(start + len)}`)),
        prog.length
            ? gap > 1
                ? h('span', { class: 'warn' }, T('Gap {duration}, covered by filler', { duration: fmtDur(gap) }))
                : gap < -1 ? h('span', { class: 'bad' }, T('{duration} over; the last items will be cut', { duration: fmtDur(-gap) })) : h('span', { class: 'ok' }, T('Fills the day'))
            : null,
        heads.size ? h('span', {}, T('Blocks '), h('b', {}, heads.size)) : null,
        S.plRights.size ? h('span', { class: 'warn' }, T('{size} not rights-cleared', { size: S.plRights.size })) : null,
        S.plDirty ? h('span', { class: 'warn' }, T('● Unsaved changes')) : null,
    ].filter(Boolean));
    { const all = $('#pl-selall'), k = selectedItems().length; if (all) { all.checked = prog.length > 0 && k === prog.length; all.indeterminate = k > 0 && k < prog.length; all.disabled = !prog.length; } }
    renderSelBar();
    markNowPlaying();
}

// Start time typed into a row of the Program table (see rowStartPlan).
async function setProgramRowStart(i, clockSec) {
    const prog = S.playlist.program;
    const dayStart = parseHms(S.config.playlist.day_start) || 0;
    const bands = placementMatches(prog, S.plPlacements, dayStart).map((m, k) => (m ? { ...m, p: S.plPlacements[k] } : null)).filter(Boolean);
    // On today's day the on-air row is known only while the table still matches the saved file.
    const live = S.process === 'active' && S.playlist.date === broadcastDate() && !S.plDirty && S.plSig === progSig(prog) && S.current?.index != null;
    const plan = rowStartPlan(prog, i, clockSec, { dayStart, bands, onAirIdx: live ? Number(S.current.index) : null });
    if (plan.error) { toast(plan.error, 'err'); renderPlaylist(); return; }
    if (plan.noop) { renderPlaylist(); return; }
    if (!(await rowStartConfirm(plan, prog[i].title || baseName(prog[i].source)))) { renderPlaylist(); return; }
    rowStartApply(prog, plan);
    if (plan.detach) S.plPlacements = S.plPlacements.filter((p) => p !== plan.detach.p);
    S.plDirty = true;
    renderPlaylist();
    refreshRights();
    toast(T('Row starts at {time}. Press Save to keep it.', { time: clockOf(plan.clock) }), 'ok');
}

// Header row above a saved block's rows: name, Quiet, pin, Detach.
function blockHeadRow({ p: rec, m, color }, prog) {
    const p = { ...rec, ...blockNow(rec) };
    const secs = prog.slice(m.from, m.to + 1).reduce((s, it) => s + itemDur(it), 0);
    return h('tr', { class: 'blockhead', style: `--band:${color}` }, h('td', { colspan: 7 },
        h('div', { class: 'bh' },
            h('span', { class: 'bh-name' }, T('Block: '), bidiText(p.name)),
            p.quiet ? h('span', { class: 'badge quiet', title: T('No automatic branding or live text inside this block') }, T('Quiet')) : null,
            h('span', { class: 'muted small' }, `${Tn('{n} item', '{n} items', m.to - m.from + 1)} · ${fmtDur(secs)}${p.start ? T(' · pinned at {start}', { start: p.start }) : ''}${p.saved ? '' : T(' · not saved yet')}`),
            h('button', { class: 'btn ghost small', title: T('Keep the rows, stop treating them as this block'), onclick: () => detachPlacement(rec) }, T('Detach')))));
}

// Row selection: click toggles, Shift+click sets the range from the last clicked row.
function selectRow(i, shift) {
    const prog = S.playlist.program, item = prog[i];
    const on = !S.plSel.has(item);
    const a = shift && S.plAnchor ? prog.indexOf(S.plAnchor) : -1;
    if (a >= 0) { for (let k = Math.min(a, i); k <= Math.max(a, i); k++) { if (on) S.plSel.add(prog[k]); else S.plSel.delete(prog[k]); } }
    else if (on) S.plSel.add(item); else S.plSel.delete(item);
    S.plAnchor = item;
    applySelection();
}
function applySelection() {
    const prog = S.playlist.program;
    for (const tr of $$('#pl-table tbody tr[data-i]')) {
        const on = S.plSel.has(prog[Number(tr.dataset.i)]);
        tr.classList.toggle('sel', on);
        const cb = $('td.selcell input', tr);
        if (cb) cb.checked = on;
    }
    const all = $('#pl-selall'), n = prog.length, k = selectedItems().length;
    if (all) { all.checked = n > 0 && k === n; all.indeterminate = k > 0 && k < n; all.disabled = !n; }
    renderSelBar();
}
const selectedItems = () => S.playlist.program.filter((it) => S.plSel.has(it));
// Header checkbox: all rows / none. Shows the in-between state while some are selected.
$('#pl-selall').addEventListener('change', (e) => {
    if (!S.playlist) { e.target.checked = false; return; }
    const prog = S.playlist.program || [];
    if (e.target.checked) for (const it of prog) S.plSel.add(it); else S.plSel.clear();
    S.plAnchor = null;
    applySelection();
});
function renderSelBar() {
    const bar = $('#pl-selbar');
    const items = selectedItems();
    bar.hidden = !items.length;
    if (!items.length) return bar.replaceChildren();
    bar.replaceChildren(
        h('span', {}, h('b', {}, Tn('{n} row', '{n} rows', items.length)), T(' selected · {duration}', { duration: fmtDur(items.reduce((s, it) => s + itemDur(it), 0)) })),
        h('button', { class: 'btn small', onclick: () => saveItemsAsBlock(items, `${Tn('{n} selected row', '{n} selected rows', items.length)}, ${fmtDur(items.reduce((s, it) => s + itemDur(it), 0))}`) }, T('Save selection as block…')),
        h('button', { class: 'btn ghost small', onclick: () => { S.plSel.clear(); S.plAnchor = null; applySelection(); } }, T('Clear selection')));
}

function markNowPlaying() {
    const c = S.current;
    const today = broadcastDate();
    $$('#pl-table tr.now').forEach((r) => r.classList.remove('now'));
    $$('#pl-table .onair-mark').forEach((m) => { const tr = m.closest('tr'); m.parentElement.textContent = tr ? String(Number(tr.dataset.i) + 1) : ''; });
    if (!c || S.process !== 'active' || !S.playlist || S.playlist.date !== today) return;
    // ffplayout's index refers to the saved file; after local edits it would point at the
    // wrong row, so the marker is only shown while the table matches what is on air.
    if (S.plDirty || S.plSig !== progSig(S.playlist.program)) return;
    const row = $(`#pl-table tr[data-i="${c.index}"]`);
    if (row) { row.classList.add('now'); const num = row.children[1]; if (num && !num.querySelector('.onair-mark')) num.replaceChildren(h('span', { class: 'onair-mark', title: T('On air now') }, '▶')); }
}

$('#pl-date').addEventListener('change', loadPlaylist);
$('#pl-prev').addEventListener('click', () => { $('#pl-date').value = addDays($('#pl-date').value, -1); loadPlaylist(); });
$('#pl-next').addEventListener('click', () => { $('#pl-date').value = addDays($('#pl-date').value, 1); loadPlaylist(); });
$('#pl-reload').addEventListener('click', async () => {
    if (S.plDirty && !(await confirmModal(T('Discard changes?'), T('The current playlist has unsaved changes.'), { ok: T('Discard') }))) return;
    S.plDirty = false;
    loadPlaylist();
});
// Saves S.playlist (with its block placements): the confirms (past date, short, too long,
// rights) and then ffplayout, then the placements. Used by the Program page and by the
// block builder in day mode. Resolves true when saved.
async function saveDayPlaylist() {
    // One save at a time: a second Save (or the builder's) while this one runs is ignored.
    if (saveDayPlaylist.busy) return false;
    saveDayPlaylist.busy = true;
    try { return await saveDayPlaylistInner(); } finally { saveDayPlaylist.busy = false; }
}
async function saveDayPlaylistInner() {
    // ffplayout does not fill a short playlist: it logs "not long enough" and
    // loops the filler for the rest of the day. Warn before saving one.
    const len = parseHms(S.config.playlist.length) || 86400;
    const total = S.playlist.program.reduce((sum, item) => sum + itemDur(item), 0);
    const gap = len - total;
    const nowDay = broadcastDate();
    // ffplayout reloads the day's file as soon as it is saved: this changes what is on air.
    if (isOnAirDay(S.playlist.date) && !(await confirmModal(T('Change the playlist ON AIR?'),
        T('{date} is the broadcast day on air now. Saving replaces it immediately; the running clip and everything after it follow the new list. Save it anyway?', { date: fmtDate(S.playlist.date) }),
        { ok: T('Save on air'), danger: true }))) return false;
    if (S.playlist.date < nowDay && !(await confirmModal(T('This date is in the past'),
        T('You are saving the playlist for {date}, but the current broadcast day is {date2}. A playlist for a past day never airs. Save it anyway?', { date: fmtDate(S.playlist.date), date2: fmtDate(nowDay) }),
        { ok: T('Save anyway'), danger: true }))) return false;
    if (gap > 1 && !(await confirmModal(T('Playlist is short'),
        T('This playlist runs {duration} of the channel\'s {count}. The remaining {duration2} will play the filler on a loop. Save anyway?', { duration: fmtDur(total), count: S.config.playlist.length, duration2: fmtDur(gap) }),
        { ok: T('Save anyway') }))) return false;
    if (gap < -1 && !(await confirmModal(T('Playlist is too long'),
        T('This playlist runs {duration}, {duration2} longer than the channel\'s {count} broadcast day. The last items will be cut at {time}. Save anyway?', { duration: fmtDur(total), duration2: fmtDur(-gap), count: S.config.playlist.length, time: clockOf((parseHms(S.config.playlist.day_start) || 0) + len) }),
        { ok: T('Save anyway'), danger: true }))) return false;
    try {
        const bad = await rightsProblems(S.playlist.program, S.playlist.date);
        if (bad.length && !(await confirmModal(T('Rights not cleared'),
            [Tn('{n} clip is not marked as cleared for YouTube on {date}:', '{n} clips are not marked as cleared for YouTube on {date}:', bad.length, { date: fmtDate(S.playlist.date) }),
                h('ul', { class: 'small' }, ...bad.slice(0, 8).map((b) => h('li', {}, `${baseName(b.source)}: ${b.reason}`)), bad.length > 8 ? h('li', {}, T('…and {v} more', { v: bad.length - 8 })) : null),
                T('Save anyway?')],
            { ok: T('Save anyway'), danger: true }))) return false;
        const pl = S.playlist;
        // Undo: the day's previous playlist (and block marks) are kept and restored together.
        const tok = await undoPlBegin([pl.date], T('Playlist saved ({date})', { date: fmtDate(pl.date) }));
        S.undoGroup = tok;
        let bandErr = null;
        try {
            await api('POST', `/api/playlist/${S.channelId}`, { channel: S.channel.name, date: pl.date, program: pl.program });
            S.plDirty = false;
            S.plSig = progSig(pl.program);
            // Block bands: rewritten from the placements that still match the saved rows.
            try { await saveDayPlacements(pl); } catch (e) { bandErr = e; }
        } finally { S.undoGroup = null; }
        await undoPlCommit(tok, [pl.date]);
        renderPlaylist();
        refreshRights();
        checkSchedule();
        if (bandErr) toast(T('Playlist saved, but the saved-block marks could not be stored: {error}', { error: bandErr.message }), 'err');
        else toast(T('Playlist saved'), 'ok');
        return true;
    } catch (e) { toast(e.message, 'err'); return false; }
}
$('#pl-save').addEventListener('click', () => saveDayPlaylist());
$('#pl-delete').addEventListener('click', async () => {
    const date = S.playlist.date;
    const onAir = isOnAirDay(date);
    if (!(await confirmModal(onAir ? T('Delete the playlist ON AIR?') : T('Delete playlist?'),
        onAir ? T('{date} is the broadcast day on air now. Deleting it puts the filler on air for the rest of the day.', { date: fmtDate(date) }) : T('This deletes the saved playlist for {date}. The filler will play if nothing replaces it.', { date: fmtDate(date) }),
        { ok: onAir ? T('Delete on air') : T('Delete'), danger: true, ...(onAir ? { requireText: 'DELETE' } : {}) }))) return;
    const btn = $('#pl-delete');
    if (btn.disabled) return;
    btn.disabled = true;
    let tok = null;
    try {
        tok = await undoPlBegin([date], T('Playlist deleted ({date})', { date: fmtDate(date) }));
        S.undoGroup = tok;
        await api('DELETE', `/api/playlist/${S.channelId}/${date}`);
        S.plDirty = false;
        // Its saved-block marks and pins go to data\block-placements-archive.json (kept, not deleted).
        let note = '';
        try { const r = await localJson('POST', '/local/blocks/placements/archive', { date }); if (r.archived) note = T(' Its {count} (and pins) moved to the placements archive.', { count: Tn('{n} block mark', '{n} block marks', r.archived) }); }
        catch (e) { note = T(' The block marks of this day could not be archived: {error}', { error: e.message }); }
        S.undoGroup = null;
        await undoPlCommit(tok, [date]);
        toast(T('Playlist deleted.{note}', { note }), 'ok');
        btn.disabled = false; // before the reload, which manages the buttons itself
        loadPlaylist();
        checkSchedule();
    } catch (e) { btn.disabled = false; toast(e.message, 'err'); } finally { S.undoGroup = null; }
});

// Media sources: the media folder (read-only, via the panel server) or
// ffplayout's own storage (via the ffplayout file API).
S.mediaSource = 'share';
S.genFolders = new Set();
// Format filter for the share browser and Generate. Empty set = all formats.
// Remembered per browser (a convenience only; safe to lose).
S.formats = new Set();
try { S.formats = new Set(JSON.parse(localStorage.getItem('cr_formats') || '[]')); } catch { /* storage unavailable */ }
S.formatInfo = null;

function saveFormats() { try { localStorage.setItem('cr_formats', JSON.stringify([...S.formats])); } catch { /* ignore */ } }

async function renderFormats() {
    const wrap = $('#br-formats');
    if (S.mediaSource !== 'share') { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (!S.formatInfo) {
        try { S.formatInfo = await localJson('GET', '/local/media/formats'); } catch { S.formatInfo = { supported: [], counts: {} }; }
    }
    const present = Object.entries(S.formatInfo.counts).sort((a, b) => b[1].files - a[1].files);
    for (const f of [...S.formats]) if (!S.formatInfo.counts[f]) S.formats.delete(f);
    const toggle = (ext) => {
        if (ext === null) S.formats.clear();
        else if (S.formats.has(ext)) S.formats.delete(ext);
        else S.formats.add(ext);
        if (S.formats.size === present.length) S.formats.clear();
        saveFormats();
        renderFormats();
        browse(S.browsePath);
        updateSelectionCount();
    };
    wrap.replaceChildren(
        h('button', { class: 'fmt' + (S.formats.size ? '' : ' on'), 'aria-pressed': String(!S.formats.size), onclick: () => toggle(null) }, T('All formats')),
        ...present.map(([ext, c]) => h('button', {
            class: 'fmt' + (S.formats.has(ext) ? ' on' : ''), 'aria-pressed': String(S.formats.has(ext)),
            title: T('{count} · {hours} h in the library', { count: plural(c.files, 'file', 'files'), hours: c.hours }), onclick: () => toggle(ext),
        }, ext, h('span', { class: 'n' }, c.files))),
    );
}
const formatParam = () => [...S.formats].join(',');

async function localJson(method, url, body) {
    const r = await netFetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.detail || T('HTTP {status}', { status: r.status })), { status: r.status, code: j.code });
    return j;
}

// Keyboard access for clickable non-button elements: focusable, Enter/Space act like a click.
const kbd = (fn) => ({ tabindex: 0, onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); fn(e); } } });

function renderGenFolders() {
    const wrap = $('#gen-folders');
    const list = [...S.genFolders];
    wrap.replaceChildren(...(list.length
        ? list.map((f) => h('span', { class: 'chip' }, f || T('Media (all)'), h('button', { title: T('Remove'), onclick: () => { S.genFolders.delete(f); renderGenFolders(); browse(S.browsePath); } }, '✕')))
        : [h('span', { class: 'muted small' }, T('No folders ticked yet.'))]));
    updateSelectionCount();
}

// "N clips · H hours" for the ticked folders × selected formats (× skip flagged).
// Counts come from library.csv; overlapping folders are counted once.
async function updateSelectionCount() {
    const el = $('#gen-count');
    const folders = [...S.genFolders];
    if (!folders.length) { el.textContent = ''; return; }
    const seq = (updateSelectionCount.seq = (updateSelectionCount.seq || 0) + 1);
    el.textContent = T('Counting…');
    try {
        const skip = $('#gen-skip-flagged').checked;
        const cleared = $('#gen-cleared').checked;
        const r = await localJson('POST', '/local/media/count', { folders, extensions: [...S.formats], skip_flagged: skip, require_cleared: cleared, skip_issues: $('#gen-skip-issues').checked, only_169: $('#gen-169').checked, date: $('#pl-date').value });
        if (seq !== updateSelectionCount.seq) return;
        const fmts = Object.entries(r.by_format).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(' · ');
        el.replaceChildren(...[
            h('b', {}, Tn('{n} clip', '{n} clips', r.clips)), T(' · {hours} h available', { hours: r.hours }),
            fmts ? h('div', { class: 'small' }, fmts) : null,
            h('div', { class: 'small' }, skip
                ? T('{count} excluded', { count: plural(r.skipped_flagged, 'flagged clip', 'flagged clips') })
                : T('{flagged} of them flagged for conforming', { flagged: r.flagged }),
                r.no_duration ? T(' · {no_duration} without a duration', { no_duration: r.no_duration }) : ''),
            h('div', { class: 'small' }, cleared
                ? T('{skipped_rights} not rights-cleared, excluded', { skipped_rights: r.skipped_rights })
                : T('{not_cleared} of them not rights-cleared', { not_cleared: r.not_cleared })),
            r.skipped_issues ? h('div', { class: 'small' }, T('{skipped_issues} with problems found by the analysis, excluded', { skipped_issues: r.skipped_issues })) : null,
            r.skipped_not_169 ? h('div', { class: 'small' }, T('{count} not 16:9, excluded', { count: n0(r.skipped_not_169) })) : null,
            r.skipped_hidden ? h('div', { class: 'small' }, T('{count} (Needs attention), excluded', { count: plural(r.skipped_hidden, 'hidden file', 'hidden files') })) : null,
        ].filter(Boolean));
        el.classList.toggle('muted', r.clips === 0);
    } catch (e) { if (seq === updateSelectionCount.seq) el.textContent = e.message; }
}
$('#gen-skip-flagged').addEventListener('change', updateSelectionCount);
$('#gen-cleared').addEventListener('change', updateSelectionCount);
$('#gen-skip-issues').addEventListener('change', () => { updateSelectionCount(); renderWindowHint(); });
$('#gen-169').addEventListener('change', updateSelectionCount);

// Generator settings shared by Generate and Fill.
// ---- broadcast window ----
// Full day (default): clips fill the whole broadcast day. Custom: clips fill only
// start–end; the rest of the day plays the off-air slate image, so the stream stays up
// and the playlist still covers the full day. ffplayout plays items in order from
// day_start, so the window is placed by putting a slate item of the right length first.
const OFFAIR_REL = 'offair\\offair_1080p.png';
const LIVE_REL = 'live\\live_standby_1080p.png';
const storageFile = (rel) => `${String(S.channel?.storage || '').replace(/[\\/]+$/, '')}\\${rel}`;
const offairSource = () => storageFile(OFFAIR_REL);
const liveSource = () => storageFile(LIVE_REL);
const isOffair = (src) => String(src || '').toLowerCase() === offairSource().toLowerCase();
const isLiveSlot = (src) => String(src || '').toLowerCase() === liveSource().toLowerCase();
// HH:MM of a time of day; times past midnight wrap (06:00 + 24 h = 06:00).
const fmtHM = (sec) => clockOf(sec).slice(0, 5);
function parseHM(s) {
    const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(String(s || '').trim());
    if (!m || Number(m[1]) > 24 || Number(m[2] || 0) > 59 || (Number(m[1]) === 24 && Number(m[2] || 0))) return null;
    return Number(m[1]) * 3600 + Number(m[2] || 0) * 60;
}
// Returns { custom, offset, len, dayLen, label, live } or throws with a readable message.
// Offsets are seconds from the broadcast day start. `live` is { offset, len, label } or null.
function genWindow() {
    const dayLen = parseHms(S.config.playlist.length) || 86400;
    const dayStart = parseHms(S.config.playlist.day_start) || 0;
    const rel = (t) => ((t - dayStart) % 86400 + 86400) % 86400;
    let w;
    if ($('#gen-window').value !== 'custom') w = { custom: false, offset: 0, len: dayLen, dayLen, label: T('full broadcast day, {time} → {time2}', { time: fmtHM(dayStart), time2: fmtHM(dayStart + dayLen) }) };
    else {
        const a = parseHM($('#gen-win-start').value), b = parseHM($('#gen-win-end').value);
        if (a == null || b == null) throw new Error(T('Window times must be HH:MM, e.g. 16:00 and 22:00.'));
        const offset = rel(a), len = ((b - a) % 86400 + 86400) % 86400;
        if (!len) throw new Error(T('The window end must be different from its start.'));
        if (offset + len > dayLen) throw new Error(T('The window must fit inside the broadcast day, which runs {time} → {time2}.', { time: fmtHM(dayStart), time2: fmtHM(dayStart + dayLen) }));
        w = { custom: true, offset, len, dayLen, label: `${fmtHM(a)}–${fmtHM(b)} (${fmtDur(len).slice(0, 5)} h)` };
    }
    w.live = null;
    if ($('#gen-live').checked) {
        const a = parseHM($('#gen-live-start').value), b = parseHM($('#gen-live-end').value);
        if (a == null || b == null) throw new Error(T('Live slot times must be HH:MM, e.g. 20:00 and 21:30.'));
        const offset = rel(a), len = ((b - a) % 86400 + 86400) % 86400;
        if (!len) throw new Error(T('The live slot end must be different from its start.'));
        if (offset < w.offset || offset + len > w.offset + w.len) throw new Error(T('The live slot must be inside the broadcast window.'));
        w.live = { offset, len, label: `${fmtHM(a)}–${fmtHM(b)}` };
    }
    return w;
}
const slateItem = (source, sec) => ({ in: 0, out: Number(sec.toFixed(3)), duration: Number(sec.toFixed(3)), source });

// ---- set a row's start time (Program table and block builder, day mode) ----
// ffplayout has no start field: a row starts when everything above it has played, so a
// new start time is made by changing what is above the row.
//   later:   an off-air slate of the difference goes in right above the row;
//   earlier: off-air slates right above the row are shortened or removed; what is still
//            missing is cut from the end of the clip right above (asked first).
// Everything below the row moves by the same amount. Rows that cannot move: the live
// slot, rows inside a saved block other than its first, and (today) the row on air and
// the rows before it. When the row is the first row of a pinned block, the pin follows.
const r3s = (n) => Math.round(Number(n) * 1000) / 1000;
const parseClockText = (v) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(v || '').trim()); if (!m) return null; const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0); return t < 86400 && Number(m[2]) < 60 && Number(m[3] || 0) < 60 ? t : null; };
function rowStartPlan(list, i, clockSec, { dayStart, bands = [], onAirIdx = null }) {
    if (i < 0 || i >= list.length) return { error: T('No such row.') };
    const cum = [0];
    for (const it of list) cum.push(cum[cum.length - 1] + itemDur(it));
    const it0 = list[i];
    if (isLiveSlot(it0.source)) return { error: T('The live slot is fixed in the day: change it from Generate.') };
    // A row inside a saved block (not its first row): the block cannot stay intact with a
    // slate inside it, so its mark is dropped for this day (the rows stay, as Detach does).
    const inside = bands.find((b) => i > b.from && i <= b.to) || null;
    if (inside) bands = bands.filter((b) => b !== inside);
    const bandAt = (j) => bands.find((b) => j >= b.from && j <= b.to) || null;
    const band = bandAt(i);
    if (onAirIdx != null && i <= onAirIdx) return { error: i === onAirIdx ? T('This row is on air now.') : T('This row has already played today.') };
    const wantOff = ((clockSec - dayStart) % 86400 + 86400) % 86400;
    const d = wantOff - cum[i];
    if (Math.abs(d) < 1) return { noop: true };
    const plan = { i, d, wantOff, clock: dayStart + wantOff, slate: 0, trims: [], removes: [], cut: null, shifts: [], pin: band && band.p.start ? band : null, detach: inside, steps: [] };
    if (d > 0) {
        plan.slate = d;
        plan.steps.push(T('An off-air slate of {duration} goes in above row {v}.', { duration: fmtDur(d), v: i + 1 }));
    } else {
        let need = -d, j = i - 1;
        // Slates directly above the row first (outside any block).
        const floor = onAirIdx == null ? -1 : onAirIdx; // rows at or before it have played
        while (need > 0.001 && j > floor && isOffair(list[j].source) && !bandAt(j)) {
            const dur = itemDur(list[j]);
            if (dur <= need + 0.5) { plan.removes.push(j); need -= dur; j--; }
            else { plan.trims.push({ j, newOut: r3s((Number(list[j].in) || 0) + dur - need) }); need = 0; }
        }
        if (plan.removes.length) plan.steps.push(T('{count} above the row removed.', { count: Tn('{n} off-air slate', '{n} off-air slates', plan.removes.length) }));
        if (plan.trims.length) plan.steps.push(T('The off-air slate above the row shortened by {duration}.', { duration: fmtDur(itemDur(list[plan.trims[0].j]) - (plan.trims[0].newOut - (Number(list[plan.trims[0].j].in) || 0))) }));
        if (need > 0.001) {
            if (j < 0) return { error: T('Nothing above row {v} to take {duration} from: the day starts at {time}.', { v: i + 1, duration: fmtDur(need), time: clockOf(dayStart) }) };
            if (j <= floor) return { error: T('The {duration} would have to come from a row that is on air or has already played.', { duration: fmtDur(need) }) };
            const prev = list[j];
            if (isLiveSlot(prev.source)) return { error: `The live slot is right above: it cannot be cut. Move the row instead.` };
            if (bandAt(j)) return { error: T('The block “{name}” is right above: its rows are not cut. Detach it first.', { name: bidiText(bandAt(j).p.name) }) };
            if (brandTypeOfSrc(prev.source)) return { error: T('A branding item ({v}) is right above: remove it or move the row instead.', { v: BRAND_INFO[brandTypeOfSrc(prev.source)]?.[0] || 'branding' }) };
            const dur = itemDur(prev);
            // The same rule as Generate: a clip never airs as a fragment under a minute.
            if (dur - need < 60) return { error: T('Not enough time above: cutting “{name}” ({duration}) would leave less than a minute of it. Remove rows above instead.', { name: bidiText(prev.title || baseName(prev.source)), duration: fmtDur(dur) }) };
            plan.cut = { j, title: prev.title || baseName(prev.source), secs: need, newOut: r3s((Number(prev.in) || 0) + dur - need), left: dur - need };
            plan.steps.push(T('The last {duration} of “{name}” is cut (it then ends after {duration2}).', { duration: fmtDur(need), name: bidiText(plan.cut.title), duration2: fmtDur(plan.cut.left) }));
        }
    }
    // Fixed points below that move with the rest.
    for (let j = i + 1; j < list.length; j++) {
        const b = bandAt(j);
        if (isLiveSlot(list[j].source)) plan.shifts.push(T('the live slot ({time} → {time2})', { time: clockOf(dayStart + cum[j]), time2: clockOf(dayStart + cum[j] + d) }));
        else if (b && b.from === j && b.p.start) plan.shifts.push(T('the block “{name}” pinned at {start} (→ {time})', { name: bidiText(b.p.name), start: b.p.start, time: clockOf(dayStart + cum[j] + d) }));
    }
    const n = list.length - i - 1;
    if (n) plan.steps.push(T('{count} below move {duration} {v}.', { count: Tn('{n} row', '{n} rows', n), duration: fmtDur(Math.abs(d)), v: d > 0 ? 'later' : 'earlier' }));
    if (plan.pin) plan.steps.push(T('The pin of “{name}” moves from {start} to {time}.', { name: bidiText(plan.pin.p.name), start: plan.pin.p.start, time: fmtHM(plan.clock) }));
    if (plan.detach) plan.steps.push(`Row ${i + 1} is inside the block “${bidiText(plan.detach.p.name)}”: the block mark${plan.detach.p.start ? T(' (and its pin)') : ''} is dropped for this day when you save; the rows stay.`);
    return plan;
}
// Applies a plan to the list (and the pinned placement when there is one).
function rowStartApply(list, plan) {
    if (plan.slate > 0) list.splice(plan.i, 0, slateItem(offairSource(), plan.slate));
    else {
        if (plan.cut) list[plan.cut.j].out = plan.cut.newOut;
        for (const t of plan.trims) { const it = list[t.j]; it.out = t.newOut; if (isOffair(it.source)) it.duration = t.newOut; }
        for (const j of plan.removes.slice().sort((a, b) => b - a)) list.splice(j, 1);
    }
    if (plan.pin) plan.pin.p.start = fmtHM(plan.clock);
}
// Asks for the change; resolves true when the user accepts.
function rowStartConfirm(plan, rowTitle) {
    const body = [
        T('Row “{name}” starts at {time} ({duration} {v}).', { name: bidiText(rowTitle), time: clockOf(plan.clock), duration: fmtDur(Math.abs(plan.d)), v: plan.d > 0 ? 'later' : 'earlier' }),
        h('ul', { class: 'small' }, ...plan.steps.map((t) => h('li', {}, t))),
        plan.shifts.length ? h('p', { class: 'warn' }, T('This also moves {v}.', { v: plan.shifts.join(', ') })) : null,
    ].filter(Boolean);
    return confirmModal(plan.cut ? T('Cut the clip above?') : T('Set the start time?'), body, { ok: plan.cut ? T('Cut and set') : T('Set time'), danger: !!plan.cut || plan.shifts.length > 0 });
}
// Turns a time cell into an editor; onApply(seconds of the day) runs on Enter.
function startCellEditor(cell, clockSec, onApply) {
    if (cell.querySelector('input')) return;
    const was = cell.textContent;
    const input = h('input', { class: 'mono start-edit', type: 'text', name: 'row-start-time', value: clockOf(clockSec), 'aria-label': T('Start time (HH:MM or HH:MM:SS)'), inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'data-form-type': 'other', 'data-lpignore': 'true' });
    const close = () => { cell.replaceChildren(was); cell.focus(); };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter') { e.preventDefault(); const t = parseClockText(input.value); if (t == null) return toast(T('Time as HH:MM or HH:MM:SS, e.g. 20:00.'), 'err'); onApply(t); }
        e.stopPropagation();
    });
    // In the builder the row is draggable: not while typing in it.
    const row = cell.closest('.bld-row');
    if (row) row.draggable = false;
    input.addEventListener('blur', () => setTimeout(() => { if (row) row.draggable = true; if (input.isConnected) close(); }, 150));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    cell.replaceChildren(input);
    input.focus(); input.select();
}

// Builds one day: clips in the gaps between the fixed segments (the live slot and the
// saved blocks pinned to this date, each at its time), the live standby image for the live
// slot, the pinned blocks' own items as they are (no branding is added inside them), and
// the off-air slate before and after the window. `plan` comes from /local/blocks/plan.
// Returns { program, stats, contentLen, clipsLen, clips, placements }.
async function buildDay(date, avoid, w, plan = { pins: [], branding_set: '' }) {
    const dayStart = parseHms(S.config.playlist.day_start) || 0;
    const rel = (t) => ((t - dayStart) % 86400 + 86400) % 86400;
    const bset = plan.branding_set || '';
    const fixed = [];
    if (w.live) fixed.push({ kind: 'live', offset: w.live.offset, len: w.live.len, label: T('the live slot {label}', { label: w.live.label }) });
    for (const pin of plan.pins || []) fixed.push({ kind: 'block', offset: rel(parseHM(pin.start)), len: pin.length_s, pin, label: T('the block “{name}” at {start}', { name: bidiText(pin.name), start: pin.start }) });
    fixed.sort((x, y) => x.offset - y.offset);
    const winEnd = w.offset + w.len;
    fixed.forEach((f, i) => {
        if (f.kind === 'block' && (f.offset < w.offset || f.offset + f.len > winEnd + 0.5)) throw new Error(T('{v}{v2} ({duration}) does not fit inside the broadcast window ({time} → {time2}).', { v: f.label[0].toUpperCase(), v2: f.label.slice(1), duration: fmtDur(f.len), time: fmtHM(dayStart + w.offset), time2: fmtHM(dayStart + winEnd) }));
        const nx = fixed[i + 1];
        if (nx && f.offset + f.len > nx.offset + 0.5) throw new Error(T('{v}{v2} runs until {time} and overlaps {label}. Change the times, then generate again.', { v: f.label[0].toUpperCase(), v2: f.label.slice(1), time: clockOf(dayStart + f.offset + f.len), label: nx.label }));
    });
    // Gaps between the fixed segments; the generator fills only these.
    const parts = [];
    let cur = w.offset;
    for (const f of fixed) { parts.push({ kind: 'gap', offset: cur, len: f.offset - cur }); parts.push(f); cur = f.offset + f.len; }
    parts.push({ kind: 'gap', offset: cur, len: winEnd - cur });
    let used = [...avoid], stats = null;
    // Live-show countdown (branding) right before the live slot: its time comes out of the gap before it.
    const li = parts.findIndex((x) => x.kind === 'live');
    if (li > 0 && $('#gen-brand').checked && bset !== 'none') {
        let countdown = null;
        try {
            const b = await localJson('GET', `/local/branding?set=${encodeURIComponent(bset)}`);
            const ok = (b.types.countdown || []).filter((x) => x.check?.ok && x.check.info.duration > 0);
            if (ok.length) { const x = ok[Math.floor(Math.random() * ok.length)]; countdown = slateItem(x.source, x.check.info.duration); }
        } catch { /* no branding */ }
        const g = parts[li - 1];
        if (countdown && g.len - itemDur(countdown) >= 60) { g.len -= itemDur(countdown); g.countdown = countdown; }
    }
    for (const [pi, g] of parts.entries()) {
        if (g.kind !== 'gap') continue;
        g.items = [];
        if (g.len < 1) continue;
        // Under a minute (e.g. between two pinned blocks): the off-air slate, not a cut clip.
        if (g.len < 60) { g.items = [slateItem(offairSource(), g.len)]; continue; }
        // No ident at the first position right after a pinned block.
        const r = await localJson('POST', '/local/media/generate', { ...genParams(date, used, g.len, g.offset, bset), after_block: parts[pi - 1]?.kind === 'block' });
        if (!r.program.length) throw new Error(noFilesMsg(r));
        g.items = r.program;
        // The last clip cut to fit: a fragment under a minute becomes the off-air slate.
        const last = g.items[g.items.length - 1];
        if (last && !brandTypeOfSrc(last.source) && itemDur(last) < 60 && Number(last.out) < Number(last.duration) - 0.01) {
            // Branding right before it (up-next, opener, stinger, ident…) goes too: no card right before the slate.
            let k = g.items.length - 1, secs = itemDur(last);
            while (k > 0 && brandTypeOfSrc(g.items[k - 1].source)) { k--; secs += itemDur(g.items[k]); }
            g.items.splice(k, g.items.length - k, slateItem(offairSource(), secs));
        }
        // Not enough clips for this gap: the off-air slate covers the rest, so what follows keeps its time.
        if (pi < parts.length - 1 && g.len - r.total > 1) g.pad = slateItem(offairSource(), g.len - r.total);
        used = [...new Set([...used, ...r.program.map((i) => i.source)])];
        if (!stats) stats = { ...r };
        else {
            // Counts describe the pool (same for every gap); time adds up.
            stats.total += r.total;
            stats.repeats = (stats.repeats || 0) + (r.repeats || 0);
            stats.brand_items = (stats.brand_items || 0) + (r.brand_items || 0);
            stats.brand_s = (stats.brand_s || 0) + (r.brand_s || 0);
            stats.brand_missing = [...new Set([...(stats.brand_missing || []), ...(r.brand_missing || [])])];
            if (r.by_category) for (const [c, x] of Object.entries(r.by_category)) {
                const was = stats.by_category?.[c];
                stats.by_category = { ...stats.by_category, [c]: { clips: x.clips, seconds: (was?.seconds || 0) + x.seconds } };
            }
        }
    }
    stats = stats || { total: 0, usable: 0, files: 0, formats: [], repeats: 0, pool_s: 0, brand_items: 0, brand_s: 0, brand_missing: [] };
    const program = [], placements = [];
    let at = 0;
    const push = (...items) => { for (const it of items) { program.push(it); at += itemDur(it); } };
    if (w.offset > 0) push(slateItem(offairSource(), w.offset));
    for (const part of parts) {
        if (part.kind === 'gap') { push(...part.items); if (part.pad) push(part.pad); if (part.countdown) push(part.countdown); }
        else if (part.kind === 'live') push(slateItem(liveSource(), part.len));
        else {
            const items = part.pin.items.map(toProgramItem);
            placements.push({ block_id: part.pin.block_id, name: part.pin.name, quiet: part.pin.quiet, start: part.pin.start, sources: items.map((i) => i.source), offset_s: Math.round(at * 1000) / 1000, refs: items });
            push(...items);
        }
    }
    const filled = program.reduce((s, i) => s + itemDur(i), 0);
    if (w.dayLen - filled > 1) program.push(slateItem(offairSource(), w.dayLen - filled));
    const clips = parts.filter((x) => x.kind === 'gap').flatMap((x) => x.items).filter((i) => !brandTypeOfSrc(i.source));
    return { program, stats, clips, placements, contentLen: parts.filter((x) => x.kind === 'gap').reduce((s, x) => s + Math.max(0, x.len), 0) };
}
// What Generate and Fill must respect on a date (occasion, branding set, pinned blocks).
// With "Only clips with YouTube rights cleared" ticked, pinned items not cleared are left out.
const loadPlan = (date) => localJson('GET', `/local/blocks/plan?date=${date}&day_start_s=${parseHms(S.config.playlist.day_start) || 0}&require_cleared=${$('#gen-cleared').checked ? 1 : 0}`);
const NO_PLAN = { pins: [], branding_set: '', problems: [], occasion: null, placement_pins: [], placed_n: 0, skipped: true };
// Plans for several dates. If the blocks / occasions / placements file is unreadable (503),
// asks whether to generate without them (the damaged file is left as it is); null = cancelled.
async function loadPlans(dates) {
    const plans = new Map();
    for (const d of dates) {
        try { plans.set(d, await loadPlan(d)); }
        catch (e) {
            if (e.status !== 503) throw new Error(`${fmtDate(d)}: ${e.message}`);
            const ok = await confirmModal(T('Saved blocks and occasions cannot be read'), [e.message,
                T('Generate without blocks and occasions? Pinned blocks and occasion branding sets are then NOT applied. The damaged file is not changed; restore it from its .bak copy to get them back.')],
            { ok: T('Generate without blocks and occasions'), danger: true });
            if (!ok) return null;
            for (const x of dates) plans.set(x, NO_PLAN);
            return plans;
        }
    }
    return plans;
}
const setLabel = (s) => (s === 'none' ? T('Quiet (no automatic branding)') : s || T('Default'));
function planLine(plan) {
    const pins = (plan.pins || []).map((p) => `${bidiText(p.name)} at ${p.start}`).join(', ');
    const off = $('#gen-brand').checked ? '' : T(' (Add branding is off)');
    if (plan.occasion) return `Occasion: ${bidiText(plan.occasion.name)} — branding: ${bidiText(setLabel(plan.branding_set))}${off}${pins ? T(', pinned: {pins}', { pins }) : ''}`;
    return pins ? `Pinned: ${pins}` : '';
}
const TYPE_LABEL = { missing: 'missing', hidden: 'hidden on Needs attention', explicit_window: 'explicit outside the allowed hours', not_cleared: 'not rights-cleared', moved: 'moved' };
// Items of pinned blocks left out or kept with a warning, one line per block.
function pinNotes(plan) {
    const out = [];
    for (const p of plan.pins || []) {
        const why = (list) => [...new Set(list.map((x) => TYPE_LABEL[x.type] || x.type))].join(', ');
        const names = (list) => list.slice(0, 4).map((x) => bidiText(x.title)).join(', ') + (list.length > 4 ? '…' : '');
        if (p.dropped?.length) out.push(T('“{name}” at {start}: {count} left out ({why}): {names}.', { name: bidiText(p.name), start: p.start, count: Tn('{n} item', '{n} items', p.dropped.length), why: why(p.dropped), names: names(p.dropped) }));
        if (p.warned?.length) out.push(T('“{name}” at {start}: {count} kept with a warning ({why}): {names}.', { name: bidiText(p.name), start: p.start, count: Tn('{n} item', '{n} items', p.warned.length), why: why(p.warned), names: names(p.warned) }));
    }
    return out;
}
// Plan summary for the Generate info: occasion line, problems, left-out items, and the
// pins this date has from "Insert at time" with a Remove pin button each.
function planInfo(plan, date) {
    const nodes = [];
    if (plan.skipped) nodes.push(h('div', { class: 'warn' }, T('Generated without saved blocks and occasions (their file could not be read).')));
    const pl = planLine(plan);
    if (pl) nodes.push(h('div', { class: 'gen-plan' }, pl));
    const notes = [...(plan.problems || []), ...pinNotes(plan)];
    if (notes.length) nodes.push(h('div', { class: 'warn' }, notes.join(' ')));
    for (const x of plan.placement_pins || []) {
        const row = h('div', { class: 'pin-row' }, T('Pinned on {date}: ', { date: fmtDate(date) }), bidiText(x.name), T(' at {start} ', { start: x.start }));
        row.append(h('button', { class: 'btn ghost small', title: T('Generate no longer places this block here; rows already in the playlist stay'), onclick: async () => {
            try {
                await localJson('POST', '/local/blocks/placements/unpin', { date, block_id: x.block_id, start: x.start });
                if (S.playlist?.date === date) for (const p of S.plPlacements) if (p.block_id === x.block_id && p.start === x.start) p.start = null;
                row.replaceChildren(`Pin removed: `, bidiText(x.name), T(' is no longer placed at {start} on {date}. Generate again.', { start: x.start, date: fmtDate(date) }));
                if (S.playlist?.date === date) renderPlaylist();
            } catch (e) { toast(e.message, 'err'); }
        } }, T('Remove pin')));
        nodes.push(row);
    }
    return nodes;
}

function renderWindowHint() {
    const custom = $('#gen-window').value === 'custom';
    $('#gen-window-times').hidden = !custom;
    $('#gen-live-times').hidden = !$('#gen-live').checked;
    let txt = '';
    try {
        const w = genWindow();
        txt = custom ? T('Clips play {label}. The rest of the broadcast day shows the off-air slate.', { label: w.label }) : T('Clips fill the {label}.', { label: w.label });
        if (w.live) txt += T(' Live slot {label}: the live standby image plays until the live source connects.', { label: w.live.label });
    } catch (e) { txt = e.message; }
    $('#gen-window-hint').textContent = txt;
    try {
        localStorage.setItem('cr_window', JSON.stringify({ mode: $('#gen-window').value, start: $('#gen-win-start').value, end: $('#gen-win-end').value,
            live: $('#gen-live').checked, liveStart: $('#gen-live-start').value, liveEnd: $('#gen-live-end').value,
            norepeat: $('#gen-norepeat').value, gap: $('#gen-artist-gap').value, source: $('#gen-source').value, skipIssues: $('#gen-skip-issues').checked }));
    } catch { /* ignore */ }
}
try {
    const w = JSON.parse(localStorage.getItem('cr_window') || 'null');
    if (w) {
        $('#gen-window').value = w.mode === 'custom' ? 'custom' : 'full';
        if (w.start) $('#gen-win-start').value = w.start;
        if (w.end) $('#gen-win-end').value = w.end;
        $('#gen-live').checked = !!w.live;
        if (w.liveStart) $('#gen-live-start').value = w.liveStart;
        if (w.liveEnd) $('#gen-live-end').value = w.liveEnd;
        if (w.norepeat != null) $('#gen-norepeat').value = w.norepeat;
        if (w.gap != null) $('#gen-artist-gap').value = w.gap;
        if (w.skipIssues != null) $('#gen-skip-issues').checked = !!w.skipIssues;
        S.savedSource = w.source || '';
    }
} catch { /* storage unavailable */ }
for (const id of ['#gen-window', '#gen-live']) $(id).addEventListener('change', renderWindowHint);
for (const id of ['#gen-win-start', '#gen-win-end', '#gen-live-start', '#gen-live-end', '#gen-norepeat', '#gen-artist-gap']) $(id).addEventListener('input', renderWindowHint);

