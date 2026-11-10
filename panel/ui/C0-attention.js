// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part C0-attention. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- needs attention
// Problem files, identical copies, same-length files and hidden files. Hide / Keep as
// is decisions are stored on this PC (data\attention.json); the share is not touched.
const ATTN_FLAG = i18nLazy({
    unreadable: [N_('Unreadable'), 'bad', N_('The library scan could not read this file')],
    no_duration: [N_('No length'), 'bad', N_('The file has no playable length')],
    too_short: [N_('Under 1 s'), 'bad', N_('Too short to schedule')],
});
const attnFlag = (f) => ATTN_FLAG[f] || FLAG_INFO[f] || [f, 'info'];
const ATTN_TABS = i18nLazy([
    ['problems', N_('Problem files'), N_('Files the analysis or the library scan found a problem in. Serious problems first (no sound, no picture, unreadable, combing), then warnings (level, clipping, mono). Hide the file, fix it on the share, or keep it as is.')],
    ['copies', N_('Identical copies'), N_('The same file (same size and length) in more than one place. Pick the copy to keep; the others are hidden as duplicates. The suggested copy needs no conforming, is 16:9 and is not in an old/backup folder.')],
    ['same', N_('Same length'), N_('Different files with exactly the same length (to the millisecond). Usually the same video in another format or export, e.g. an MXF master and its MP4. Look at the pictures, keep one, or mark them as not the same.')],
    ['scheduled', N_('Hidden but scheduled'), N_('Hidden files that are still in a saved playlist from today on. Saved playlists play them anyway: open the day and replace them, or unhide.')],
    ['accepted', N_('Kept as is'), N_('Items you cleared with “Keep as is” or “Not the same”. Undo returns an item to its list.')],
    ['songs', N_('Songs'), N_('Songs found inside clips from their timed text, with credits looked up in MusicBrainz (Wikidata when MusicBrainz has nothing). Nothing is confirmed automatically: accept a suggestion or a candidate, or edit the credits. Confirmed songs are added to the as-run report for the music rights society.')],
]);
S.attn = { tab: 'problems', shown: 50, sev: '', sel: new Set(), data: null };

async function pollAttnCount() {
    clearTimeout(pollAttnCount.t);
    try { setAttnCount(await localJson('GET', '/local/attention/count')); } catch { /* panel busy */ }
    pollAttnCount.t = setTimeout(pollAttnCount, 60000);
}
function setAttnCount(c) {
    const el = $('#attn-count');
    if (!c) return;
    el.hidden = !c.total;
    el.textContent = c.total > 999 ? '999+' : String(c.total);
    el.classList.toggle('bad', !!(c.problems_bad || c.scheduled));
    el.title = T('{count} ({count2} serious) · {count3} · {count4} · {n02} hidden but scheduled', { count: plural(c.problems, 'problem file', 'problem files'), count2: n0(c.problems_bad), count3: plural(c.copies, 'identical copy', 'identical copies'), count4: plural(c.same, 'same-length group', 'same-length groups'), n02: n0(c.scheduled) });
}

async function renderAttention() {
    // 'Loading…' only on the first load; later the current list stays until new data
    // arrives, and the scroll position is kept.
    if (!S.attn.data) $('#attn-list').replaceChildren(h('p', { class: 'muted' }, T('Loading…')));
    const seq = (renderAttention.seq = (renderAttention.seq || 0) + 1);
    let d;
    const src = S.current?.media?.source;
    S.onairSrc = src || '';
    loadSongs();
    try { d = await localJson('GET', `/local/attention?${new URLSearchParams({ ds: String(dayStartS()), ...(src ? { onair: src } : {}) })}`); } catch (e) { if (!S.attn.data) $('#attn-list').replaceChildren(); return toast(e.message, 'err'); }
    if (seq !== renderAttention.seq) return;
    const y = window.scrollY;
    S.attn.data = d;
    setAttnCount(d.counts);
    drawAttention();
    window.scrollTo(0, y);
}
function drawAttention() {
    const A = S.attn, d = A.data;
    if (A.tab === 'hidden') { A.tab = 'problems'; location.hash = 'hidden'; return; }
    if (!d) return;
    const c = d.counts;
    const sc = A.songsData?.counts;
    // Songs: open ones (missing or to confirm); with "On air soon", those in clips on air soon.
    const songsN = sc ? (A.soon === 'today' ? sc.soon_today : A.soon === 'week' ? sc.soon_week : sc.missing + sc.suggested) : 0;
    const filtered = (k) => (A.soon === 'all' ? null : (k === 'problems' ? d.problems : d[k]).filter((x) => soonMatch(k, x)).length);
    const num = { problems: filtered('problems') ?? c.problems, copies: filtered('copies') ?? c.copies, same: filtered('same') ?? c.same, scheduled: c.scheduled, hidden: d.hidden.length + (d.hidden_types || []).reduce((t, x) => t + x.files, 0), accepted: d.accepted.length, songs: songsN };
    $('#attn-tabs').replaceChildren(...ATTN_TABS.map(([k, label]) => h('button', {
        class: `attn-tab${A.tab === k ? ' active' : ''}${(k === 'scheduled' && num[k]) || (k === 'problems' && c.problems_bad) || (k === 'songs' && sc && (sc.soon_today || sc.on_air)) ? ' urgent' : ''}`,
        title: k === 'songs' && sc ? T('{count} missing credits · {n02} to confirm · {n03} open in clips on air today, {n04} in the next 7 days', { count: n0(sc.missing), n02: n0(sc.suggested), n03: n0(sc.soon_today), n04: n0(sc.soon_week) }) : undefined,
        onclick: () => { A.tab = k; A.shown = 50; A.sel.clear(); if (k === 'songs') loadSongs(); drawAttention(); },
    }, label, ' ', h('span', { class: 'n' }, n0(num[k])))));
    drawAttnFilters();
    const [, , intro] = ATTN_TABS.find((t) => t[0] === A.tab);
    $('#attn-intro').textContent = intro + (A.tab === 'problems' && d.analysed < d.clips ? ` The overnight analysis has checked ${n0(d.analysed)} of ${Tn('{n} clip', '{n} clips', d.clips)}; more problem files appear as it goes on.` : '');
    const list = $('#attn-list');
    if (A.tab === 'songs') { drawSongs(list); drawAttnBar([]); return; }
    const items = attnItems();
    const draw = { problems: attnProblem, copies: attnCopies, same: attnSame, scheduled: attnScheduled, hidden: attnHidden, accepted: attnAccepted }[A.tab];
    // Items on air now or soon carry a tag; the one on air now is highlighted.
    const drawOne = (x) => {
        const el = draw(x);
        if (!SOON_TABS.has(A.tab)) return el;
        const ids = itemIds(A.tab, x);
        const tag = soonTag(ids);
        if (tag) { (el.querySelector('.name') || el).append(' ', tag); if (isOnAir(ids)) el.classList.add('onair-hit'); }
        return el;
    };
    list.replaceChildren(...(A.tab === 'hidden' ? [attnTypesCard(d)] : []), ...(items.length ? items.slice(0, A.shown).map(drawOne) : [h('p', { class: 'muted attn-empty' }, A.tab === 'hidden' ? T('No single files hidden.') : A.soon !== 'all' && SOON_TABS.has(A.tab) ? T('Nothing here among the clips on air soon.') : T('Nothing here.'))]));
    $('#attn-more').hidden = items.length <= A.shown;
    $('#attn-more').textContent = T('Show more ({count} left)', { count: n0(items.length - A.shown) });
    drawAttnBar(items);
}
function attnItems() {
    const A = S.attn, d = A.data;
    const list = A.tab === 'problems' ? d.problems.filter((p) => !A.sev || p.severity === A.sev) : d[A.tab] || [];
    if (!SOON_TABS.has(A.tab)) return list;
    // The clip on air now first, then the others in their usual order.
    const out = list.filter((x) => soonMatch(A.tab, x));
    const air = out.filter((x) => isOnAir(itemIds(A.tab, x)));
    return air.length ? [...air, ...out.filter((x) => !air.includes(x))] : out;
}
const attnKey = (x) => x.key || x.path;
function selBox(x) {
    const k = attnKey(x);
    return h('input', { type: 'checkbox', class: 'attn-sel', 'aria-label': T('Select'), checked: S.attn.sel.has(k), onchange: (e) => { e.target.checked ? S.attn.sel.add(k) : S.attn.sel.delete(k); drawAttnBar(attnItems()); } });
}
function drawAttnBar(items) {
    const A = S.attn, bar = $('#attn-bar');
    const sel = items.filter((x) => A.sel.has(attnKey(x)));
    const parts = [];
    const selectAll = () => { for (const x of items.slice(0, A.shown)) A.sel.add(attnKey(x)); drawAttention(); };
    const selectNone = () => { A.sel.clear(); drawAttention(); };
    if (A.tab === 'songs') drawSongsBar(parts);
    if (A.tab === 'problems') {
        parts.push(h('select', { 'aria-label': T('Severity'), onchange: (e) => { A.sev = e.target.value; A.shown = 50; A.sel.clear(); drawAttention(); } },
            ...[['', T('All problems')], ['bad', T('Serious only')], ['warn', T('Warnings only')]].map(([v, t]) => h('option', { value: v, selected: A.sev === v }, t))));
    }
    if (['problems', 'hidden', 'accepted'].includes(A.tab) && items.length) {
        parts.push(h('button', { class: 'btn ghost small', onclick: selectAll }, T('Select shown')), h('button', { class: 'btn ghost small', onclick: selectNone, disabled: !sel.length }, T('Clear')));
        parts.push(h('span', { class: 'muted small' }, T('{count} selected', { count: n0(sel.length) })));
        if (A.tab === 'problems') {
            parts.push(h('button', { class: 'btn small', disabled: !sel.length, onclick: () => attnHide({ ids: sel.map((p) => p.clip.id) }, `${n0(sel.length)} clip${sel.length === 1 ? '' : 's'}`, 'bad') }, T('Hide selected…')));
            parts.push(h('button', { class: 'btn ghost small', disabled: !sel.length, onclick: () => attnAccept(sel.map((p) => ({ key: p.key, sig: p.sig, label: p.clip.file })), Tn('{n} problem file', '{n} problem files', sel.length)) }, T('Keep selected as is')));
        }
        if (A.tab === 'hidden') parts.push(h('button', { class: 'btn small', disabled: !sel.length, onclick: () => attnUnhide({ keys: sel.map((x) => x.key) }, `${n0(sel.length)} file${sel.length === 1 ? '' : 's'}`) }, T('Unhide selected')));
        if (A.tab === 'accepted') parts.push(h('button', { class: 'btn small', disabled: !sel.length, onclick: () => attnUnaccept(sel.map((x) => x.key)) }, T('Undo selected')));
    }
    if (A.tab === 'copies' && items.length) {
        parts.push(h('button', { class: 'btn small', onclick: () => attnKeepSuggested(items) }, T('Keep the suggested copy in {v}…', { v: items.length === 1 ? 'the 1 group' : `all ${n0(items.length)} groups` })));
    }
    if (A.tab === 'same' && items.length) {
        const shown = items.slice(0, A.shown);
        const missing = shown.flatMap((g) => g.clips).filter((c) => !c.thumb);
        if (missing.length) parts.push(h('button', { class: 'btn ghost small', onclick: (e) => attnMakeThumbs(missing, e.target), title: T('{count} on this page without a thumbnail', { count: plural(missing.length, 'clip', 'clips') }) }, T('Create Thumbnails')));
    }
    bar.replaceChildren(...parts);
    bar.hidden = !parts.length;
}

// ---- items
// File date on the share as dd.mm.yy (earliest of the copies).
function shortDate(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}` : '';
}
function attnThumb(c, cls = 'thumb attn-pic') {
    const pic = c.thumb && c.id ? h('img', { class: cls, src: `/local/thumb/${c.id}.jpg`, loading: 'lazy', alt: '' })
        : h('span', { class: `${cls} none`, title: T('No picture yet') });
    const day = shortDate(c.made);
    return h('span', { class: `attn-tw${cls.includes('attn-big') ? ' big' : ''}` }, pic, day ? h('span', { class: 'attn-date', title: T('File date on the share') }, day) : null);
}
const clipFacts = (c) => [fmtDur(c.duration), c.size ? fmtBytes(c.size) : '', c.res && c.res.replace('x', '×'), c.aspect && c.aspect !== '16:9' ? ASPECT_LABEL[c.aspect] : '', c.fps && `${Number(Number(c.fps).toFixed(2))} fps`, c.ext && c.ext.toUpperCase()].filter(Boolean).join(' · ');
const fileActs = (p) => [
    h('button', { class: 'btn ghost small', onclick: () => playLocal(p) }, T('Play in VLC')),
    h('button', { class: 'btn ghost small', onclick: () => attnReveal(p) }, T('Show in folder')),
];
function attnProblem(p) {
    const c = p.clip;
    return h('div', { class: `attn-item sev-${p.severity}` }, selBox(p), attnThumb(c),
        h('div', { class: 'attn-main' },
            h('div', { class: 'name' }, bidiText(c.title || c.file)),
            h('div', { class: 'muted small path' }, bidiText(`${c.folder}\\${c.file}`), c.copies > 1 ? Tn('  (+{n} identical copy)', '  (+{n} identical copies)', c.copies - 1) : ''),
            h('div', { class: 'small' }, clipFacts(c), c.conform ? h('span', { class: 'badge warn', title: T('Needs conforming before air') }, T('Conform')) : null),
            h('div', { class: 'flags' }, ...p.flags.map((f) => { const [label, cls, tip] = attnFlag(f); return h('span', { class: `badge ${cls}`, title: tip || label }, label); })),
            h('div', { class: 'acts' }, ...fileActs(c.path),
                h('button', { class: 'btn ghost small', onclick: () => editClip(c) }, T('Edit details')),
                h('button', { class: 'btn small', onclick: () => attnHide({ ids: [c.id] }, c.file, p.severity === 'bad' ? 'bad' : 'fix') }, T('Hide…')),
                h('button', { class: 'btn ghost small', onclick: () => attnAccept([{ key: p.key, sig: p.sig, label: c.file }], c.file) }, T('Keep as is')))));
}
function attnCopies(g) {
    const c = g.clip;
    const vis = c.all_rows.filter((r) => !r.hidden);
    return h('div', { class: 'attn-group' },
        h('div', { class: 'attn-ghead' }, attnThumb(c),
            h('div', {}, h('div', { class: 'name' }, bidiText(c.title || c.file)), h('div', { class: 'muted small' }, T('Same file in {count} places · {clipFacts}', { count: vis.length, clipFacts: clipFacts(c) }))),
            h('span', { class: 'acts' },
                h('button', { class: 'btn ghost small', onclick: () => attnAccept([{ key: g.key, sig: g.sig, label: T('{file} ({count} copies)', { file: c.file, count: vis.length }) }], 'these copies') }, T('Keep all copies')),
                h('button', { class: 'btn ghost small danger', title: T('None of the copies is fit for broadcast: hide every copy'), onclick: () => attnHideGroup({ ids: [c.id] }, `all ${vis.length} copies`) }, T('Hide all copies')))),
        ...vis.map((r) => h('div', { class: `attn-copy${r.path === g.keep ? ' keep' : ''}` },
            h('div', { class: 'path' }, h('span', { class: 'muted' }, bidiText(`${r.folder}\\`)), playLink(bidiText(r.file), r.path, T('Play in VLC')),
                r.size ? h('span', { class: 'muted small attn-size' }, fmtBytes(r.size)) : null,
                r.mtime ? h('span', { class: 'muted small attn-size', title: T('Last modified (file date on the share)') }, T('modified {time}', { time: fmtStamp(r.mtime) })) : null,
                r.path === g.keep ? h('span', { class: 'badge on' }, T('Suggested')) : null),
            h('div', { class: 'acts' },
                h('button', { class: 'btn ghost small', title: T('Open the containing folder in Explorer'), onclick: () => attnReveal(r.path) }, T('Open folder')),
                h('button', { class: 'btn small', onclick: () => attnHide({ paths: vis.filter((x) => x.path !== r.path).map((x) => x.path) }, Tn('the other {n} copy', 'the other {n} copies', vis.length - 1), 'duplicate', true) }, T('Keep only this one'))))));
}
function attnSame(g) {
    return h('div', { class: 'attn-group' },
        h('div', { class: 'attn-ghead' }, h('div', {}, h('div', { class: 'name' }, T('{count} files, each {duration} ({v} s)', { count: g.clips.length, duration: fmtDur(g.duration), v: g.duration.toFixed(3) })), h('div', { class: 'muted small' }, T('Different files with exactly the same length.'))),
            h('span', { class: 'acts' },
                h('button', { class: 'btn ghost small', onclick: () => attnAccept([{ key: g.key, sig: g.sig, label: g.clips.map((c) => c.file).join(' / ') }], 'this group') }, T('Not the same')),
                h('button', { class: 'btn ghost small danger', title: T('None of these files is fit for broadcast: hide all of them'), onclick: () => attnHideGroup({ ids: g.clips.map((c) => c.id) }, `all ${g.clips.length} files`) }, T('Hide all of them')))),
        h('div', { class: 'attn-cards' }, ...g.clips.map((c) => h('div', { class: `attn-card${c.id === g.keep ? ' keep' : ''}`, 'data-id': c.id },
            attnThumb(c, 'thumb attn-big'),
            h('div', { class: 'name' }, bidiText(c.title || c.file), c.id === g.keep ? h('span', { class: 'badge on' }, T('Suggested')) : null),
            h('div', { class: 'muted small path' }, bidiText(`${c.folder}\\${c.file}`), c.copies > 1 ? T('  (+{v} identical)', { v: c.copies - 1 }) : ''),
            h('div', { class: 'small' }, clipFacts(c), c.conform ? h('span', { class: 'badge warn' }, T('Conform')) : null),
            h('div', { class: 'acts' }, ...fileActs(c.path),
                h('button', { class: 'btn small', onclick: () => attnHide({ ids: g.clips.filter((x) => x.id !== c.id).map((x) => x.id) }, Tn('the other {n} file', 'the other {n} files', g.clips.length - 1), 'duplicate', true) }, T('Keep only this one')),
                h('button', { class: 'btn ghost small', onclick: () => attnHide({ ids: [c.id] }, c.file, 'duplicate') }, T('Hide this one…')))))));
}
function attnScheduled(x) {
    return h('div', { class: 'attn-item sev-bad' },
        h('div', { class: 'attn-main' },
            h('div', { class: 'name path' }, bidiText(x.path), x.size ? h('span', { class: 'muted small attn-size' }, fmtBytes(x.size)) : null),
            h('div', { class: 'small' }, T('In the saved playlist of '), ...x.dates.flatMap((d, i) => [i ? ', ' : '', h('a', { href: '#program', onclick: () => { $('#pl-date').value = d; } }, fmtDate(d))])),
            h('div', { class: 'acts' }, x.by === 'type'
                // Hidden because its whole file type is hidden: unhide the type, not the file.
                ? h('span', { class: 'muted small' }, T('Hidden by file type · '), h('a', { href: '#hidden' }, T('Hidden file types')))
                : h('button', { class: 'btn ghost small', onclick: () => attnUnhide(x.by === 'whole' && x.id ? { ids: [x.id] } : { keys: [x.path.toLowerCase()] }, baseName(x.path)) }, T('Unhide')))));
}
const HIDDEN_STATE = i18nLazy({ hidden: '', moved: N_('Moved to another folder (still hidden: same content)'), changed: N_('The file at this path has changed: shown again'), missing: N_('Not found at this path (moved, renamed or deleted)') });
function attnHidden(x, sel = selBox) {
    return h('div', { class: `attn-item${x.state === 'hidden' || x.state === 'moved' ? '' : ' stale'}`, 'data-key': x.key }, sel(x),
        attnThumb(x),
        h('div', { class: 'attn-main' },
            h('div', { class: 'name' }, bidiText(x.file), ' ', h('span', { class: 'badge' }, x.reason_label), x.whole ? h('span', { class: 'badge', title: T('Every copy of this clip is hidden') }, T('All copies')) : null),
            h('div', { class: 'muted small path' }, bidiText(x.folder)),
            h('div', { class: 'small' }, T('Hidden {day}', { day: fmtDay(x.at) }), x.size ? ` · ${fmtBytes(x.size)}` : '', x.note ? h('span', {}, ' · ', h('span', { class: 'bidi' }, x.note)) : null, HIDDEN_STATE[x.state] ? h('span', { class: 'warn' }, ` · ${HIDDEN_STATE[x.state]}`) : null),
            h('div', { class: 'acts' }, ...(x.state === 'missing' ? [] : fileActs(x.path)),
                h('button', { class: 'btn ghost small', onclick: () => attnUnhide({ keys: [x.key] }, x.file) }, x.state === 'hidden' || x.state === 'moved' ? T('Unhide') : T('Remove mark')))));
}
// Whole file types hidden (every file with that extension, including files added later).
function attnTypesCard(d) {
    const types = d.hidden_types || [];
    const free = (d.types_in_library || []).filter((t) => !types.some((x) => x.ext === t));
    const pick = h('select', { 'aria-label': T('Hide a file type') }, h('option', { value: '' }, T('Hide a file type…')), ...free.map((t) => h('option', { value: t }, t.toUpperCase())));
    pick.addEventListener('change', async () => {
        const t = pick.value;
        if (!t) return;
        if (!(await confirmModal(T('Hide all {v} files?', { v: t.toUpperCase() }), [T('Every .{t} file on the share is left out of the Library, Generate, the folder browser and the overnight analysis, including {v} files added later. Clips that exist only as {v2} disappear from the system until you unhide the type. Nothing on the share changes.', { t, v: t.toUpperCase(), v2: t.toUpperCase() })], { ok: T('Hide {v}', { v: t.toUpperCase() }) }))) { pick.value = ''; return; }
        await attnPost('types', { types: [...types.map((x) => x.ext), t] }, () => T('{v} files hidden.', { v: t.toUpperCase() }));
    });
    return h('div', { class: 'attn-item attn-types' },
        h('div', { class: 'attn-main' },
            h('div', { class: 'name' }, T('Hidden file types')),
            types.length ? types.map((x) => h('div', { class: 'attn-type' },
                h('span', { class: 'badge' }, x.ext.toUpperCase()),
                h('span', { class: 'small' }, T(' {count} · {v} only in this format and {v2} out of the system ', { count: plural(x.files, 'file', 'files'), v: x.clips_only === 1 ? '1 clip exists' : T('{count} clips exist', { count: n0(x.clips_only) }), v2: x.clips_only === 1 ? 'is' : 'are' })),
                h('button', { class: 'btn ghost small', onclick: () => attnPost('types', { types: types.filter((y) => y.ext !== x.ext).map((y) => y.ext) }, () => T('{v} files shown again.', { v: x.ext.toUpperCase() })) }, T('Unhide type')))) : h('div', { class: 'muted small' }, T('None.')),
            h('div', { class: 'acts' }, pick)));
}
// ---------------------------------------------------------------- hidden media
// Every hidden file and hidden file type (moved here from Needs attention). Search, filter
// by reason and folder, unhide one or many. The data is the Needs attention report.
S.hid = { q: '', reason: '', folder: '', sel: new Set(), shown: 100, data: null };
async function renderHiddenMedia() {
    if (!S.hid.data) $('#hid-list').replaceChildren(h('p', { class: 'muted' }, T('Loading…')));
    const seq = (renderHiddenMedia.seq = (renderHiddenMedia.seq || 0) + 1);
    let d;
    try { d = await localJson('GET', `/local/attention?ds=${dayStartS()}`); } catch (e) { toast(e.message, 'err'); return; }
    if (seq !== renderHiddenMedia.seq) return;
    const y = window.scrollY;
    S.hid.data = d; S.attn.data = d;
    setAttnCount(d.counts);
    drawHiddenMedia();
    window.scrollTo(0, y);
}
function hidItems() {
    const H = S.hid, d = H.data;
    const q = H.q.trim().toLowerCase();
    return d.hidden.filter((x) => (!H.reason || x.reason === H.reason) && (!H.folder || x.folder === H.folder || x.folder.startsWith(H.folder + '\\') || x.folder.startsWith(H.folder + '/'))
        && (!q || `${x.file} ${x.folder} ${x.note}`.toLowerCase().includes(q)));
}
const hidSelBox = (x) => h('input', { type: 'checkbox', class: 'attn-sel', 'aria-label': T('Select'), checked: S.hid.sel.has(x.key), onchange: (e) => { e.target.checked ? S.hid.sel.add(x.key) : S.hid.sel.delete(x.key); drawHidBar(hidItems()); } });
function drawHidBar(items) {
    const H = S.hid;
    const sel = items.filter((x) => H.sel.has(x.key));
    $('#hid-bar').replaceChildren(
        h('button', { class: 'btn ghost small', disabled: !items.length, onclick: () => { for (const x of items.slice(0, H.shown)) H.sel.add(x.key); drawHiddenMedia(); } }, T('Select shown')),
        h('button', { class: 'btn ghost small', disabled: !sel.length, onclick: () => { H.sel.clear(); drawHiddenMedia(); } }, T('Clear')),
        h('span', { class: 'muted small' }, T('{count} selected', { count: n0(sel.length) })),
        h('button', { class: 'btn small', disabled: !sel.length, onclick: () => attnUnhide({ keys: sel.map((x) => x.key) }, `${n0(sel.length)} file${sel.length === 1 ? '' : 's'}`) }, T('Unhide selected')));
}
function drawHiddenMedia() {
    const H = S.hid, d = H.data;
    if (!d) return;
    const top = (f) => String(f || '').split(/[\\/]/)[0];
    const folders = [...new Set(d.hidden.map((x) => top(x.folder)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const counts = {};
    for (const x of d.hidden) counts[x.reason] = (counts[x.reason] || 0) + 1;
    const search = h('input', { type: 'search', dir: 'auto', placeholder: T('Search file, folder or note'), 'aria-label': T('Search hidden files'), value: H.q,
        oninput: (e) => { H.q = e.target.value; H.shown = 100; clearTimeout(drawHiddenMedia.t); drawHiddenMedia.t = setTimeout(() => { drawHiddenMedia(); const el = $('#hid-filters input[type=search]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); } });
    $('#hid-filters').replaceChildren(search,
        h('select', { 'aria-label': T('Reason'), onchange: (e) => { H.reason = e.target.value; H.shown = 100; drawHiddenMedia(); } },
            h('option', { value: '' }, T('All reasons ({count})', { count: n0(d.hidden.length) })), ...Object.entries(d.reasons || {}).map(([k, v]) => h('option', { value: k, selected: H.reason === k }, `${v} (${n0(counts[k] || 0)})`))),
        h('select', { 'aria-label': T('Folder'), onchange: (e) => { H.folder = e.target.value; H.shown = 100; drawHiddenMedia(); } },
            h('option', { value: '' }, T('All folders')), ...folders.map((f) => h('option', { value: f, selected: H.folder === f }, bidiText(f)))));
    const items = hidItems();
    $('#hid-types').replaceChildren(attnTypesCard(d));
    $('#hid-count').textContent = `${Tn('{n} hidden file', '{n} hidden files', items.length)}${items.length !== d.hidden.length ? ` of ${n0(d.hidden.length)}` : ''}`;
    $('#hid-list').replaceChildren(...(items.length ? items.slice(0, H.shown).map((x) => attnHidden(x, hidSelBox)) : [h('p', { class: 'muted attn-empty' }, d.hidden.length ? T('No hidden file matches.') : T('No single files hidden.'))]));
    $('#hid-more').hidden = items.length <= H.shown;
    $('#hid-more').textContent = T('Show more ({count} left)', { count: n0(items.length - H.shown) });
    drawHidBar(items);
}
$('#hid-more').addEventListener('click', () => { S.hid.shown += 100; drawHiddenMedia(); });
$('#hid-reload').addEventListener('click', renderHiddenMedia);

const ACC_KIND = i18nLazy({ p: N_('Problem kept as is'), c: N_('Copies kept'), l: N_('Not the same content') });
function attnAccepted(x) {
    return h('div', { class: 'attn-item' }, selBox(x),
        h('div', { class: 'attn-main' },
            h('div', { class: 'name' }, bidiText(x.label)),
            h('div', { class: 'muted small' }, `${ACC_KIND[x.kind] || ''} · ${fmtDay(x.at)}`, x.note ? ` · ${x.note}` : ''),
            h('div', { class: 'acts' }, h('button', { class: 'btn ghost small', onclick: () => attnUnaccept([x.key]) }, T('Undo')))));
}

// ---- actions
async function attnPost(op, body, done) {
    try {
        const r = await localJson('POST', `/local/attention/${op}`, body);
        setAttnCount(r.counts);
        toast(done(r), 'ok');
        S.attn.sel.clear();
        S.hid.sel.clear();
        // Refresh the page the action came from.
        if (!$('#view-hidden').hidden) await renderHiddenMedia(); else await renderAttention();
        return r;
    } catch (e) { toast(e.message, 'err'); }
}
async function attnHide(target, what, reason = 'duplicate', quick = false) {
    const sel = h('select', {}, ...Object.entries(S.attn.data?.reasons || { duplicate: T('Duplicate') }).map(([k, v]) => h('option', { value: k, selected: k === reason }, v)));
    const note = h('input', { placeholder: T('Note (optional)'), 'aria-label': T('Note (optional)'), maxlength: '500', dir: 'auto' });
    const scope = target.ids ? T('Every copy of the clip is hidden.') : T('Only these files are hidden; other copies stay.');
    if (!quick) {
        const ok = await confirmModal(T('Hide {what}?', { what }), [T('Hidden files are left out of the Library, Generate, the folder browser and the overnight analysis. {scope} Nothing on the share changes; unhide any time on this page. Saved playlists that already contain the file still play it.', { scope }), h('label', {}, T('Reason '), sel), h('label', {}, note)], { ok: T('Hide') });
        if (!ok) return;
    }
    await attnPost('hide', { ...target, reason: sel.value, note: note.value.trim() }, (r) => `${Tn('{n} file', '{n} files', r.hidden)} hidden.`);
}
// A whole group none of which is fit for broadcast: every file hidden as "Not for air".
async function attnHideGroup(target, what) {
    const ok = await confirmModal(T('Hide {what}?', { what }), [T('Use this when none of these files is fit for broadcast. They are left out of the Library, Generate, the folder browser and the overnight analysis, with the reason “Not for air”. Nothing on the share changes; Undo or unhide on the Hidden media page.')], { ok: T('Hide all'), danger: true });
    if (!ok) return;
    await attnPost('hide', { ...target, reason: 'not_for_air', note: T('group hidden: none fit for broadcast') }, (r) => `${Tn('{n} file', '{n} files', r.hidden)} hidden.`);
}
async function attnKeepSuggested(groups) {
    const paths = groups.flatMap((g) => g.clip.all_rows.filter((r) => !r.hidden && r.path !== g.keep).map((r) => r.path));
    if (!(await confirmModal(T('Keep the suggested copy in {count}?', { count: plural(groups.length, 'group', 'groups') }), [T('{count} hidden as duplicates. Nothing on the share changes; each one can be unhidden on the Hidden files tab.', { count: plural(paths.length, 'extra copy is', 'extra copies are') })], { ok: T('Hide {count}', { count: plural(paths.length, 'copy', 'copies') }) }))) return;
    await attnPost('hide', { paths, reason: 'duplicate', note: T('Suggested copy kept') }, (r) => `${Tn('{n} copy', '{n} copies', r.hidden)} hidden.`);
}
const attnUnhide = (body, what) => attnPost('unhide', body, (r) => (r.unhidden ? `${what} unhidden.` : T('Nothing to unhide.')));
const attnAccept = (items, what) => attnPost('accept', { items }, () => T('{v}{v2}: kept as is.', { v: what[0].toUpperCase(), v2: what.slice(1) }));
const attnUnaccept = (keys) => attnPost('unaccept', { keys }, (r) => Tn('{n} item back on the list.', '{n} items back on the list.', r.removed));
async function attnReveal(p) {
    try { await localJson('POST', '/local/reveal', { path: p }); } catch (e) { toast(e.message, 'err'); }
}
async function attnMakeThumbs(clips, btn) {
    btn.disabled = true;
    let done = 0;
    for (const c of clips) {
        if ($('#view-attention').hidden) break;
        btn.textContent = T('Creating thumbnails {v}/{count}…', { v: done + 1, count: clips.length });
        try { await localJson('POST', '/local/thumb', { id: c.id }); c.thumb = true; } catch { /* unreadable: no picture */ }
        done++;
        for (const el of $$('.attn-card .thumb.none')) {
            const card = el.closest('.attn-card');
            if (card && card.dataset.id === c.id && c.thumb) el.closest('.attn-tw').replaceWith(attnThumb(c, 'thumb attn-big'));
        }
    }
    drawAttention();
}
// ---- "On air soon" filter (Problem files, Identical copies, Same length, Songs)
// Clips in saved playlists from today to 6 days ahead; the clip on air now always shows,
// first and highlighted. The choice is remembered in this browser.
const SOON_KEY = 'pcr.attn.soon';
// "Today" is the broadcast day: the server needs ffplayout's day start for that.
const dayStartS = () => { const n = parseHms(S.config?.playlist?.day_start); return Number.isFinite(n) && n >= 0 && n < 86400 ? Math.floor(n) : 0; };
const SOON_TABS = new Set(['problems', 'copies', 'same', 'songs']);
S.attn.soon = (() => { try { const v = localStorage.getItem(SOON_KEY); return v === 'today' || v === 'week' ? v : 'all'; } catch { return 'all'; } })();
function setSoon(v) {
    S.attn.soon = v;
    try { localStorage.setItem(SOON_KEY, v); } catch { /* private window: this page only */ }
    S.attn.shown = 50; S.attn.sel.clear();
    S.attn.songsLimit = 30;
    loadSongs();
    drawAttention();
}
const itemIds = (tab, x) => (tab === 'same' ? x.clips.map((c) => c.id) : x.clip ? [x.clip.id] : []);
function soonFirst(ids) {
    const soon = S.attn.data?.soon || {};
    let first = null;
    for (const id of ids) { const l = soon[id]; if (l && l[0] && (!first || l[0] < first)) first = l[0]; }
    return first;
}
const isOnAir = (ids) => !!S.attn.data?.on_air_id && ids.includes(S.attn.data.on_air_id);
function soonMatch(tab, x) {
    if (!SOON_TABS.has(tab) || S.attn.soon === 'all') return true;
    const ids = itemIds(tab, x);
    if (isOnAir(ids)) return true;
    const f = soonFirst(ids);
    return S.attn.soon === 'today' ? f === S.attn.data.today : !!f;
}
const dm = (iso) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${m[2]}.${m[1]}` : ''; };
function soonTag(ids, date) {
    if (isOnAir(ids)) return h('span', { class: 'badge live soon-tag', title: T('This clip is on air now') }, T('Now on air'));
    const f = date || soonFirst(ids);
    if (!f) return null;
    return h('span', { class: 'badge warn soon-tag', title: T('In a saved playlist') }, f === S.attn.data?.today ? T('On air today') : T('On air {dm}', { dm: dm(f) }));
}
function drawAttnFilters() {
    const A = S.attn;
    const used = SOON_TABS.has(A.tab);
    $('#attn-filters').replaceChildren(...[
        h('label', { class: 'small' }, T('On air soon '),
            h('select', { id: 'attn-soon', 'aria-label': T('On air soon'), onchange: (e) => setSoon(e.target.value) },
                ...[['all', T('All')], ['today', T('Today')], ['week', T('Next 7 days')]].map(([v, t]) => h('option', { value: v, selected: A.soon === v }, t)))),
        !used && A.soon !== 'all' ? h('span', { class: 'muted small' }, T('Not used on this tab.')) : null,
        used && A.soon !== 'all' ? h('span', { class: 'muted small' }, T('Clips in saved playlists from today on; the clip on air now always shows first.')) : null].filter(Boolean));
}

// ---- Songs tab
S.attn.songsFilter = 'missing';
S.attn.songClip = '';
S.attn.songsData = null;
S.attn.songsLimit = 30;
S.attn.focus = null;
S.attn.lines = new Map();
const SONG_FILTERS = i18nLazy([['missing', N_('Missing credits')], ['suggested', N_('Suggested, to confirm')], ['confirmed', N_('Confirmed')], ['closed', N_('Not a song')], ['all', N_('All')]]);
async function loadSongs() {
    const A = S.attn;
    const q = new URLSearchParams({ filter: A.songsFilter, range: A.soon, limit: String(A.songsLimit), ds: String(dayStartS()) });
    if (A.songClip) q.set('clip', A.songClip);
    const src = S.current?.media?.source;
    if (src) q.set('onair', src);
    const seq = (loadSongs.seq = (loadSongs.seq || 0) + 1);
    let d;
    try { d = await localJson('GET', `/local/songs?${q}`); } catch (e) { if (seq === loadSongs.seq) { A.songsErr = e.message; if (A.tab === 'songs') drawAttention(); } return; }
    if (seq !== loadSongs.seq) return;
    A.songsErr = '';
    A.songsData = d;
    if (!$('#view-attention').hidden) drawAttention();
}
// "m:ss" / "h:mm:ss" <-> seconds.
function fmtClock(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
function parseClock(v) {
    const t = String(v || '').trim();
    if (!t) return NaN;
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return NaN;
    return t.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
}
const SONG_KIND = i18nLazy({ missing: [N_('Missing'), 'bad'], suggested: [N_('To confirm'), 'warn'], confirmed: [N_('Confirmed'), 'on'], closed: [N_('Not a song'), 'info'] });
const people = (list) => (list || []).map((p) => p.name).filter(Boolean);
// Credits as separate units: English labels and the (often Hebrew) names never share a text node.
function creditLine(c, cls = 'song-credit') {
    const parts = [h('span', { class: 'bidi name-val' }, bidiText(c.title || ''))];
    const add = (label, names) => { if (names.length) parts.push(h('span', { class: 'muted' }, ` · ${label} `), h('span', { class: 'bidi' }, bidiText(names.join(', ')))); };
    add('lyrics', people(c.lyricists));
    add('music', people(c.composers));
    if ((c.others || []).length) add('also', people(c.others));
    if (c.work_no) parts.push(h('span', { class: 'muted mono' }, ` · #${c.work_no}`));
    if (c.source === 'wikidata') parts.push(h('span', { class: 'badge info', title: T('From Wikidata: no ISWC') }, T('Wikidata')));
    return h('div', { class: cls }, ...parts);
}
function songRow(g, s) {
    const A = S.attn;
    const [kl, kc] = SONG_KIND[s.kind] || [s.kind, 'info'];
    const hint = h('input', { class: 'song-hint', dir: 'auto', value: s.hint || '', placeholder: T('Real title or a performer'), 'aria-label': T('Hint for the search'), maxlength: '200', 'data-act': 'hint',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); songSearch(g, s, hint.value, e.target.nextElementSibling); } } });
    const btn = (act, label, fn, cls = 'btn ghost small', title = '') => h('button', { class: cls, 'data-act': act, title, onclick: (e) => { A.focus = { song: s.id, act }; fn(e); } }, label);
    const open = s.kind === 'missing' || s.kind === 'suggested';
    const cands = open || s.kind === 'confirmed' ? (s.candidates || []).filter((c) => !s.credits || c.work_no !== s.credits.work_no || c.title !== s.credits.title) : [];
    const lk = s.looked_up;
    const lkText = !lk ? T('Not looked up yet.') : lk.result === 'none' ? T('No match found.') : lk.result === 'ambiguous' ? T('Several possible works: pick one, or give a hint.') : lk.result === 'suggested' ? '' : lk.result === 'nothing to search' ? T('Nothing to search with: give a hint.') : '';
    return h('div', { class: `song-row kind-${s.kind}`, tabindex: '0', 'data-song': s.id, 'data-clip': g.clip.id },
        h('div', { class: 'song-time mono', title: T('{time} to {time2}', { time: fmtClock(s.s), time2: fmtClock(s.e) }) }, `${fmtClock(s.s)}–${fmtClock(s.e)}`, h('div', { class: 'muted small', title: T('Length') }, fmtClock(s.e - s.s))),
        h('div', { class: 'song-main' },
            h('div', { class: 'song-title' },
                s.title_heard ? h('span', { class: 'name bidi' }, bidiText(s.title_heard)) : h('span', { class: 'muted' }, T('No title heard')),
                h('span', { class: `badge ${kc}` }, kl),
                s.source === 'person' && s.kind !== 'confirmed' ? h('span', { class: 'badge info', title: T('Changed by a person: song detection keeps it as it is') }, T('Edited')) : null),
            s.first_line ? h('div', { class: 'muted small bidi song-line', title: s.first_line }, bidiText(s.first_line.length > 90 ? s.first_line.slice(0, 88) + '…' : s.first_line)) : null,
            (s.writers_heard || []).length ? h('div', { class: 'small' }, h('span', { class: 'muted' }, T('Heard: ')), h('span', { class: 'bidi' }, bidiText(s.writers_heard.join(', ')))) : null,
            s.credits ? h('div', { class: 'small song-cred' }, h('span', { class: 'muted' }, s.kind === 'confirmed' ? T('Credits: ') : T('Suggested: ')), creditLine(s.credits, 'song-credit inline'),
                s.kind === 'confirmed' && s.confirmed_by ? h('span', { class: 'muted' }, T(' · confirmed by {confirmed_by}', { confirmed_by: s.confirmed_by })) : null)
                : s.kind !== 'closed' && lkText ? h('div', { class: 'small muted' }, lkText) : null,
            s.credits && lkText && open ? h('div', { class: 'muted small' }, lkText) : null,
            cands.length ? h('ol', { class: 'song-cands small' }, ...cands.map((c) => {
                const idx = s.candidates.indexOf(c);
                return h('li', {}, creditLine(c), h('span', { class: 'muted', title: (c.why || []).join(', ') }, ` ${Math.round((c.score || 0) * 100)}%`),
                    h('button', { class: 'btn ghost small', 'data-act': `cand${idx}`, onclick: () => { A.focus = { song: s.id, act: `cand${idx}` }; songAccept(g, s, idx); } }, T('Accept this')));
            })) : null,
            s.notes ? h('div', { class: 'small' }, h('span', { class: 'muted' }, T('Notes: ')), h('span', { class: 'bidi' }, s.notes)) : null,
            h('div', { class: 'acts' },
                btn('play', T('Play from here'), () => playLocal(g.clip.path, s.s, s.e), 'btn ghost small', T('Opens VLC at the start of the song (P)')),
                s.kind === 'suggested' ? btn('accept', T('Accept'), () => songAccept(g, s, 'suggestion'), 'btn small primary', T('Confirm the suggested credits (A)')) : null,
                s.kind !== 'closed' ? btn('edit', T('Edit…'), () => songEdit(g, s), 'btn ghost small', T('Title, writers, work ID (ISWC), notes (E)')) : null,
                s.kind !== 'closed' ? h('span', { class: 'song-hintbox' }, hint, btn('search', T('Search again'), (e) => songSearch(g, s, hint.value, e.target), 'btn ghost small', T('Store the hint and look this song up now'))) : null,
                btn('times', T('Adjust times…'), () => songAdjust(g, s), 'btn ghost small', T('Start, end, or split in two (T)')),
                s.kind === 'closed' || s.kind === 'confirmed' ? btn('reopen', T('Reopen'), () => songUpdate(g, s, { action: 'reopen' }, T('Back on the list.')), 'btn ghost small')
                    : btn('notsong', T('Not a song'), () => songUpdate(g, s, { action: 'not_a_song' }, T('Marked as not a song. It is under “Not a song” to reopen.')), 'btn ghost small', T('Talk, applause or noise (N)')))));
}
function songGroup(g) {
    const c = g.clip;
    return h('div', { class: `attn-group song-group${g.on_air ? ' onair-hit' : ''}`, 'data-clip': c.id },
        h('div', { class: 'attn-ghead' }, attnThumb(c),
            h('div', {},
                h('div', { class: 'name' }, bidiText(c.title || c.file), soonTag([c.id], g.soon && g.soon[0])),
                h('div', { class: 'muted small path' }, c.missing ? T('This clip is no longer in the library.') : bidiText(`${c.folder}\\${c.file}`)),
                h('div', { class: 'muted small' }, T('{duration} · {count} found', { duration: fmtDur(c.duration), count: plural(g.total_songs, 'song', 'songs') }))),
            h('button', { class: 'btn ghost small', title: T('Find the songs again from the timed text. Confirmed and edited songs stay as they are.'), onclick: () => songDetect(c) }, T('Detect again'))),
        ...g.songs.map((s) => songRow(g, s)));
}
function drawSongs(list) {
    const A = S.attn, d = A.songsData;
    if (A.songsErr) return list.replaceChildren(h('p', { class: 'muted attn-empty' }, A.songsErr));
    if (!d) return list.replaceChildren(h('p', { class: 'muted' }, T('Loading…')));
    const notes = [];
    if (d.tools?.lookup && d.tools.lookup.ok === false) notes.push(h('div', { class: 'conn' }, T('The last credits lookup stopped: {detail} Lookups need an update of tools\\credits before they work again.', { detail: d.tools.lookup.detail })));
    if (d.damaged?.length) notes.push(h('div', { class: 'conn' }, T('{count} damaged and left as they are (data\\songs). Repair or move them aside.', { count: plural(d.damaged.length, 'songs file is', 'songs files are') })));
    if (!d.transcripts) notes.push(h('p', { class: 'muted' }, T('No clip has timed text yet. Tick “Timed text” in the Overnight analysis card (Library), or import the test transcripts (tools\\whisper\\import-test.js).')));
    if (d.tools?.whisper && !d.tools.whisper.ok) notes.push(h('p', { class: 'muted small' }, T('Timed text cannot run on this PC yet: {why}', { why: d.tools.whisper.why })));
    const groups = d.groups.map(songGroup);
    list.replaceChildren(...notes, ...(groups.length ? groups : [h('p', { class: 'muted attn-empty' }, A.songClip ? T('No songs of this kind in this clip.') : T('Nothing here.'))]));
    $('#attn-more').hidden = d.total_groups <= d.groups.length;
    $('#attn-more').textContent = T('Show more clips ({count} left)', { count: n0(d.total_groups - d.groups.length) });
    if (A.focus) {
        const el = list.querySelector(`[data-song="${A.focus.song}"] [data-act="${A.focus.act}"]`) || list.querySelector(`[data-song="${A.focus.song}"]`);
        if (el) el.focus({ preventScroll: false });
        A.focus = null;
    }
}
function drawSongsBar(parts) {
    const A = S.attn, c = A.songsData?.counts || {};
    const n = { missing: c.missing, suggested: c.suggested, confirmed: c.confirmed, closed: c.closed, all: c.all };
    parts.push(h('select', { 'aria-label': T('Which songs'), onchange: (e) => { A.songsFilter = e.target.value; A.songsLimit = 30; loadSongs(); } },
        ...SONG_FILTERS.map(([v, t]) => h('option', { value: v, selected: A.songsFilter === v }, `${t} (${n0(n[v])})`))));
    if (A.songClip) {
        const g = A.songsData?.groups?.[0];
        parts.push(h('span', { class: 'chip' }, T('One clip only'), g ? h('span', { class: 'bidi' }, ` ${bidiText(g.clip.title)}`) : null,
            h('button', { class: 'btn ghost small', 'aria-label': T('Show all clips'), onclick: () => { A.songClip = ''; loadSongs(); } }, '×')));
    }
    parts.push(h('span', { class: 'muted small' }, T('On air soon, still open: {count} today, {n02} in the next 7 days.', { count: n0(c.soon_today), n02: n0(c.soon_week) })));
    parts.push(h('span', { class: 'muted small keys-hint' }, T('Keys on a song: P play · A accept · E edit · H hint · T times · N not a song · ↑↓ next song')));
}

async function songCall(url, body) {
    return localJson('POST', url, { by: S.user?.username || '', ...body });
}
async function songUpdate(g, s, body, okMsg) {
    try {
        const r = await songCall('/local/songs/update', { clip: g.clip.id, song: s.id, ...body });
        if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
        await loadSongs();
        if ($('#meta-dlg').open && S.editing?.id === g.clip.id) loadClipSongs(g.clip.id);
        return r;
    } catch (e) { toast(e.message, 'err'); return null; }
}
const songAccept = (g, s, candidate) => songUpdate(g, s, { action: 'accept', candidate }, (r) => `Credits confirmed.${r.aliases ? T(' {count} saved for later lookups.', { count: Tn('{n} spelling', '{n} spellings', r.aliases) }) : ''}`);
async function songSearch(g, s, hint, btn) {
    if (btn) { btn.disabled = true; btn.textContent = T('Searching…'); }
    try {
        const r = await songCall('/local/songs/lookup', { clip: g.clip.id, song: s.id, hint: String(hint || '').trim() });
        const res = r.song?.looked_up?.result;
        toast(res === 'suggested' ? T('A suggestion was found: check it and accept.') : res === 'ambiguous' ? T('Several possible works: pick one from the list.') : res === 'none' ? T('No match. Try the real title or a performer as the hint.') : T('Lookup done.'), res === 'none' ? '' : 'ok');
        S.attn.focus = { song: s.id, act: 'search' };
    } catch (e) { toast(e.message, 'err'); }
    await loadSongs();
    if ($('#meta-dlg').open && S.editing?.id === g.clip.id) loadClipSongs(g.clip.id);
}
async function songDetect(c) {
    try {
        const r = await songCall('/local/songs/detect', { clip: c.id });
        toast(T('{count} in this clip ({count2} kept as a person left them{v}).', { count: plural(r.songs, 'song', 'songs'), count2: n0(r.kept), v: r.archived ? T(', {count} earlier suggestions archived', { count: n0(r.archived) }) : '' }), 'ok');
    } catch (e) { toast(e.message, 'err'); }
    await loadSongs();
}
// Enter in a field of the dialog presses its OK button.
const enterOk = (el) => { el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') { e.preventDefault(); $('#modal-ok').click(); } }); return el; };
async function songEdit(g, s) {
    const base = s.credits || (s.candidates || [])[0] || { title: s.title_heard };
    const f = (v, attrs = {}) => enterOk(h('input', { dir: 'auto', value: v || '', ...attrs }));
    const title = f(base.title, { 'aria-label': T('Title') });
    const work = f(base.work_no, { 'aria-label': T('Work ID (ISWC)'), dir: 'ltr' });
    const ly = f(people(base.lyricists).join(', '), { 'aria-label': T('Lyricists') });
    const co = f(people(base.composers).join(', '), { 'aria-label': T('Composers') });
    const notes = h('textarea', { rows: '2', dir: 'auto', 'aria-label': T('Notes') }, s.notes || '');
    const heard = s.title_heard || (s.writers_heard || []).length;
    const ok = await confirmModal(T('Song credits'), [
        heard ? h('p', { class: 'small' }, h('span', { class: 'muted' }, T('Heard: ')), h('span', { class: 'bidi' }, bidiText([s.title_heard, ...(s.writers_heard || [])].filter(Boolean).join(' · ')))) : null,
        h('label', {}, T('Title'), title), h('label', {}, T('Work ID (ISWC)'), work),
        h('label', {}, T('Lyricists (comma-separated)'), ly), h('label', {}, T('Composers (comma-separated)'), co),
        h('label', {}, T('Notes'), notes),
        h('p', { class: 'muted small' }, T('Saving confirms these credits. Names and titles that differ from what was heard are kept as spellings for later lookups.')),
    ].filter(Boolean), { ok: T('Confirm credits') });
    if (!ok) return;
    S.attn.focus = { song: s.id, act: 'edit' };
    await songUpdate(g, s, { action: 'edit', title: title.value, work_no: work.value.trim(), lyricists: ly.value, composers: co.value, notes: notes.value }, (r) => `Credits confirmed.${r.aliases ? T(' {count} saved for later lookups.', { count: Tn('{n} spelling', '{n} spellings', r.aliases) }) : ''}`);
}
async function clipLines(id) {
    if (S.attn.lines.has(id)) return S.attn.lines.get(id);
    try { const r = await localJson('GET', `/local/songs/${id}?lines=1`); S.attn.lines.set(id, r.lines || []); return r.lines || []; } catch { return []; }
}
async function songAdjust(g, s) {
    const start = enterOk(h('input', { value: fmtClock(s.s), inputmode: 'numeric', 'aria-label': T('Start'), dir: 'ltr' }));
    const end = enterOk(h('input', { value: fmtClock(s.e), inputmode: 'numeric', 'aria-label': T('End'), dir: 'ltr' }));
    const split = enterOk(h('input', { value: '', inputmode: 'numeric', placeholder: T('optional'), 'aria-label': T('Split at'), dir: 'ltr' }));
    const lines = await clipLines(g.clip.id);
    const pick = (from, to, field, key) => lines.filter((l) => l.s >= from && l.s <= to).slice(0, 12).map((l) =>
        h('li', {}, h('button', { type: 'button', class: 'btn ghost small mono', title: T('Use this time'), onclick: () => { field.value = fmtClock(l[key]); } }, fmtClock(l[key])),
            h('span', { class: `bidi${l.flags.length ? ' muted' : ''}` }, ' ', bidiText(l.text.slice(0, 80) || '…'))));
    const near = (label, items) => (items.length ? h('div', { class: 'small' }, h('div', { class: 'muted' }, label), h('ul', { class: 'song-lines' }, ...items)) : null);
    const ok = await confirmModal(T('Song times'), [
        h('div', { class: 'grid3' }, h('label', {}, T('Start'), start), h('label', {}, T('End'), end), h('label', {}, T('Split at'), split)),
        h('p', { class: 'muted small' }, T('Times as m:ss or h:mm:ss. “Split at” makes two songs; the second gets its own credits.')),
        near(T('Timed text around the start (click a time to use it)'), pick(s.s - 90, s.s + 30, start, 's')),
        near(T('Timed text around the end'), pick(s.e - 40, s.e + 90, end, 'e')),
    ].filter(Boolean), { ok: T('Save times') });
    if (!ok) return;
    // A field left as shown keeps the exact stored time (the display is rounded to seconds).
    const a = start.value.trim() === fmtClock(s.s) ? s.s : parseClock(start.value), b = end.value.trim() === fmtClock(s.e) ? s.e : parseClock(end.value), at = parseClock(split.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return toast(T('Times must be m:ss or h:mm:ss.'), 'err');
    S.attn.focus = { song: s.id, act: 'times' };
    if (a !== s.s || b !== s.e) { const r = await songUpdate(g, s, { action: 'adjust', s: a, e: b }, T('Times saved.')); if (!r) return; s = r.song; }
    if (split.value.trim()) {
        if (!Number.isFinite(at)) return toast(T('“Split at” must be m:ss or h:mm:ss.'), 'err');
        await songUpdate(g, s, { action: 'split', at }, T('Split in two songs.'));
    }
}
// Keys on a song row: P play, A accept, E edit, H hint, T times, N not a song, arrows move.
$('#attn-list').addEventListener('keydown', (e) => {
    if (S.attn.tab !== 'songs' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest('input, textarea, select, [contenteditable]')) return;
    const row = t.closest('.song-row');
    if (!row) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowdown' || k === 'arrowup') {
        const rows = $$('#attn-list .song-row');
        const i = rows.indexOf(row) + (k === 'arrowdown' ? 1 : -1);
        if (rows[i]) { e.preventDefault(); rows[i].focus(); }
        return;
    }
    if (t.tagName === 'BUTTON' && (k === 'enter' || k === ' ')) return;
    const act = { p: 'play', a: 'accept', e: 'edit', h: 'hint', t: 'times', n: 'notsong' }[k];
    if (!act) return;
    const el = row.querySelector(`[data-act="${act}"]`);
    if (!el) return;
    e.preventDefault();
    if (act === 'hint') el.focus(); else el.click();
});

// ---- Songs in the clip details dialog
async function loadClipSongs(id) {
    const box = $('#meta-songs');
    let d;
    try { d = await localJson('GET', `/local/songs/${id}`); } catch (e) { box.textContent = e.message; return; }
    if (S.editing?.id !== id) return;
    const tr = d.transcript;
    const head = !tr ? T('No timed text yet (tick “Timed text” in the Overnight analysis card).')
        : tr.damaged ? T('The timed text file is damaged and left as it is.')
            : `Timed text: ${Tn('{n} line', '{n} lines', tr.lines)}${tr.no_speech ? ', no usable speech' : ''}${tr.model ? ` (${tr.model})` : ''}.`;
    const g = { clip: d.clip, soon: d.soon, songs: d.songs, total_songs: d.songs.length };
    const toTab = () => { $('#meta-dlg').close(); S.attn.tab = 'songs'; S.attn.songsFilter = 'all'; S.attn.songClip = id; S.attn.songsLimit = 30; if (location.hash === '#attention') { renderAttention(); } else location.hash = 'attention'; };
    box.replaceChildren(
        h('div', { class: 'row-between' }, h('span', { class: 'muted' }, head),
            d.songs.length ? h('button', { type: 'button', class: 'btn ghost small', onclick: toTab }, T('Review in Needs attention')) : null,
            tr && !tr.damaged ? h('button', { type: 'button', class: 'btn ghost small', onclick: async () => { await songDetect(d.clip); loadClipSongs(id); } }, T('Detect songs again')) : null),
        d.songs.length ? h('ul', { class: 'meta-songs' }, ...d.songs.map((s) => {
            const [kl, kc] = SONG_KIND[s.kind] || [s.kind, 'info'];
            return h('li', {},
                h('span', { class: 'mono' }, `${fmtClock(s.s)}–${fmtClock(s.e)} `),
                s.credits ? creditLine(s.credits, 'song-credit inline') : s.title_heard ? h('span', { class: 'bidi' }, bidiText(s.title_heard)) : h('span', { class: 'muted' }, T('No title heard')),
                h('span', { class: `badge ${kc}` }, kl),
                h('span', { class: 'acts' },
                    h('button', { type: 'button', class: 'btn ghost small', onclick: () => playLocal(d.clip.path, s.s, s.e) }, T('Play from here')),
                    s.kind === 'suggested' ? h('button', { type: 'button', class: 'btn small', onclick: () => songAccept(g, s, 'suggestion') }, T('Accept')) : null));
        })) : tr && !tr.damaged ? h('div', { class: 'muted' }, T('No songs found in this clip.')) : null);
}
$('#attn-more').addEventListener('click', () => { if (S.attn.tab === 'songs') { S.attn.songsLimit += 30; loadSongs(); return; } S.attn.shown += 50; drawAttention(); });
$('#attn-reload').addEventListener('click', renderAttention);

// Upload buttons are <label class="file-btn"> around a hidden file input: Enter/Space opens it.
document.addEventListener('keydown', (e) => {
    const l = e.target.closest?.('label.file-btn');
    if (!l || e.target !== l || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    l.querySelector('input[type=file]')?.click();
});

boot();

