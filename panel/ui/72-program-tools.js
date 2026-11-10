// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 72-program-tools. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---- templates (weighted category mix) ----
S.templates = [];
const currentTemplate = () => S.templates.find((t) => t.id === $('#gen-source').value) || null;
async function loadTemplates() {
    try { S.templates = (await localJson('GET', '/local/templates')).templates; } catch { S.templates = []; }
    const sel = $('#gen-source');
    const cur = sel.value || S.savedSource || '';
    sel.replaceChildren(h('option', { value: '' }, T('Ticked folders')), ...S.templates.map((t) => h('option', { value: t.id }, T('Template: {name}', { name: t.name }))));
    sel.value = S.templates.some((t) => t.id === cur) ? cur : '';
    renderSourceMode();
}
function renderSourceMode() {
    const t = currentTemplate();
    $('#gen-folders-box').hidden = !!t;
    $('#gen-tpl-hint').hidden = !t;
    if (t) {
        const sum = t.items.reduce((s, x) => s + x.weight, 0);
        $('#gen-tpl-hint').textContent = T('Mix: {v}. Uses every library clip in these categories; ticked folders are ignored.', { v: t.items.map((x) => `${CAT_LABEL[x.category] || x.category} ${Math.round((x.weight / sum) * 100)}%`).join(' · ') });
    }
    renderWindowHint();
}
$('#gen-source').addEventListener('change', renderSourceMode);

S.tplEdit = null;
function tplDraw() {
    const list = S.tplEdit;
    const sel = $('#tpl-pick');
    const idx = Math.min(Number(sel.dataset.idx || 0), Math.max(0, list.length - 1));
    sel.replaceChildren(...(list.length ? list.map((t, i) => h('option', { value: i }, t.name || T('Template {v}', { v: i + 1 }))) : [h('option', { value: '' }, T('No templates yet'))]));
    sel.value = list.length ? String(idx) : '';
    sel.dataset.idx = idx;
    const t = list[idx];
    $('#tpl-name').disabled = !t;
    $('#tpl-name').value = t ? t.name : '';
    const cats = Object.keys(CAT_LABEL);
    const weights = Object.fromEntries((t?.items || []).map((x) => [x.category, x.weight]));
    const sum = Object.values(weights).reduce((s, x) => s + x, 0);
    $('#tpl-rows tbody').replaceChildren(...(t ? cats.map((c) => h('tr', { class: weights[c] ? '' : 'dim' },
        h('td', {}, CAT_LABEL[c]),
        h('td', { class: 'num' }, h('input', { type: 'number', min: 0, max: 1000, value: weights[c] || 0, oninput: (e) => {
            const v = Math.max(0, Math.round(Number(e.target.value) || 0));
            t.items = cats.map((k) => ({ category: k, weight: k === c ? v : (t.items.find((x) => x.category === k)?.weight || 0) })).filter((x) => x.weight > 0);
            tplDraw(); $(`#tpl-rows input[data-c="${c}"]`)?.focus();
        }, 'data-c': c, 'aria-label': T('Weight, {v}', { v: CAT_LABEL[c] }) })),
        h('td', { class: 'num muted' }, sum && weights[c] ? `${Math.round((weights[c] / sum) * 100)}%` : ''),
    )) : [h('tr', {}, h('td', { colspan: 3, class: 'empty' }, T('Press New to create a template.')))]));
}
$('#tpl-edit').addEventListener('click', () => { S.tplEdit = structuredClone(S.templates); $('#tpl-pick').dataset.idx = Math.max(0, S.templates.findIndex((t) => t.id === $('#gen-source').value)); tplDraw(); $('#tpl-dlg').showModal(); });
$('#tpl-pick').addEventListener('change', (e) => { e.target.dataset.idx = e.target.value; tplDraw(); });
$('#tpl-name').addEventListener('input', (e) => { const t = S.tplEdit[Number($('#tpl-pick').dataset.idx)]; if (t) { t.name = e.target.value; $('#tpl-pick').selectedOptions[0].textContent = t.name || '…'; } });
$('#tpl-new').addEventListener('click', () => {
    S.tplEdit.push({ id: '', name: 'New template', items: Object.keys(CAT_LABEL).slice(0, 3).map((category, i) => ({ category, weight: [50, 30, 20][i] })) });
    $('#tpl-pick').dataset.idx = S.tplEdit.length - 1; tplDraw(); $('#tpl-name').select();
});
$('#tpl-del').addEventListener('click', () => { const i = Number($('#tpl-pick').dataset.idx); if (S.tplEdit[i]) { S.tplEdit.splice(i, 1); $('#tpl-pick').dataset.idx = Math.max(0, i - 1); tplDraw(); } });
$('#tpl-cancel').addEventListener('click', () => $('#tpl-dlg').close());
$('#tpl-save').addEventListener('click', async () => {
    try {
        const r = await localJson('PUT', '/local/templates', { templates: S.tplEdit });
        S.templates = r.templates;
        const pick = S.templates[Number($('#tpl-pick').dataset.idx)];
        await loadTemplates();
        if (pick) { $('#gen-source').value = pick.id; renderSourceMode(); }
        $('#tpl-dlg').close();
        toast(T('Templates saved.'), 'ok');
    } catch (e) { toast(e.message, 'err'); }
});

const genParams = (date, avoid = [], length_s, start_off = 0, branding_set = '') => ({
    folders: [...S.genFolders], shuffle: $('#gen-shuffle').checked, skip_flagged: $('#gen-skip-flagged').checked,
    require_cleared: $('#gen-cleared').checked, extensions: [...S.formats], date, avoid, length_s,
    template: currentTemplate(), no_repeat_days: Math.max(0, Number($('#gen-norepeat').value) || 0),
    artist_gap_s: Math.max(0, Number($('#gen-artist-gap').value) || 0) * 3600,
    skip_issues: $('#gen-skip-issues').checked,
    only_169: $('#gen-169').checked,
    branding: $('#gen-brand').checked,
    branding_set,
    start_s: ((parseHms(S.config.playlist.day_start) || 0) + start_off) % 86400,
    day_start_s: parseHms(S.config.playlist.day_start) || 0,
});
try { $('#gen-brand').checked = localStorage.getItem('cr_gen_brand') === '1'; } catch { /* storage unavailable */ }
$('#gen-brand').addEventListener('change', () => { try { localStorage.setItem('cr_gen_brand', $('#gen-brand').checked ? '1' : '0'); } catch { /* storage unavailable */ } });
const needSource = () => (!currentTemplate() && !S.genFolders.size ? T('Tick at least one folder in the media list, or pick a template.') : null);
const noFilesMsg = (r) => T('No usable files: {v} found, {v2} not in the selected formats ({v3}), {v4} without a duration (run the library scan), {v5} skipped as flagged, {v6} not rights-cleared', { v: r.files ?? 0, v2: r.skipped_format ?? 0, v3: (r.formats || []).join(', ') || 'all', v4: r.skipped_no_duration ?? 0, v5: r.skipped_flagged ?? 0, v6: r.skipped_rights ?? 0 }) +
    (r.skipped_no_category ? T(', {skipped_no_category} not in the template\'s categories', { skipped_no_category: r.skipped_no_category }) : '') +
    (r.skipped_issues ? T(', {skipped_issues} with problems found by the analysis', { skipped_issues: r.skipped_issues }) : '') +
    (r.skipped_not_169 ? T(', {skipped_not_169} not 16:9', { skipped_not_169: r.skipped_not_169 }) : '') +
    (r.skipped_hidden ? T(', {skipped_hidden} hidden (Needs attention)', { skipped_hidden: r.skipped_hidden }) : '') +
    (r.skipped_rights ? T(' (mark clips as cleared in Library, or untick “Only clips with YouTube rights cleared”).') : '.');

// Open a file in VLC on this PC via the panel server.
async function playLocal(file, start, stop) {
    try { const r = await localJson('POST', '/local/play', { path: file, ...(start != null ? { start, stop } : {}) }); toast(T('Opening in VLC: {playing}{v}', { playing: r.playing, v: start != null ? T(' from {time}', { time: fmtClock(start) }) : '' })); }
    catch (e) { toast(e.message, 'err'); }
}
const playLink = (label, file, title) => h('a', { class: 'play', href: '#', title: title || T('Play in VLC'), onclick: (e) => { e.preventDefault(); e.stopPropagation(); playLocal(file); } }, label);

$('#gen-run').addEventListener('click', async () => {
    const date = $('#pl-date').value;
    const miss = needSource();
    if (miss) return toast(miss, 'err');
    if ((S.playlist.program.length || S.plDirty) && !(await confirmModal(T('Replace playlist?'), T('The playlist for {date} will be replaced by a generated one. Nothing is saved until you press Save.', { date: fmtDate(date) }), { ok: T('Generate') }))) return;
    let plan = null;
    const btn = $('#gen-run');
    if (btn.disabled) return; // a second click while a build runs
    btn.disabled = true;
    const label = btn.textContent; btn.textContent = T('Generating…');
    try {
        const w = genWindow();
        const plans = await loadPlans([date]);
        if (!plans) return;
        plan = plans.get(date);
        const { program, stats: r, clips, placements } = await buildDay(date, [], w, plan);
        S.playlist = { channel: S.channel.name, date, program };
        S.plDirty = true;
        S.plRights = new Map();
        // Pinned blocks get their bands; the marks are stored when the day is saved.
        S.plPlacements = placements.map((p) => ({ ...p, saved: false }));
        renderPlaylist();
        refreshRights();
        const t = currentTemplate();
        $('#gen-info').textContent = (w.custom ? `Window ${w.label}: ` : '') + (w.live ? T('live slot {label}, ', { label: w.live.label }) : '') +
            `${Tn('{n} clip', '{n} clips', clips.length)} from ${Tn('{n} usable file', '{n} usable files', r.usable)} (${t ? T('template “{name}”', { name: t.name }) : S.formats.size ? (r.formats || []).join(', ') : 'all formats'})` +
            (r.by_category ? ` · ${Object.entries(r.by_category).map(([c, x]) => `${CAT_LABEL[c] || c} ${fmtDur(x.seconds).slice(0, 5)}`).join(', ')}` : '') +
            (r.missing_categories?.length ? T(' · no clips for: {v}', { v: r.missing_categories.map((c) => CAT_LABEL[c] || c).join(', ') }) : '') +
            (r.recently_aired ? T(' · {recently_aired} aired recently (used last)', { recently_aired: r.recently_aired }) : '') +
            ((r.skipped_format ?? 0) ? T(' · {count} in other formats left out', { count: Tn('{n} file', '{n} files', r.skipped_format) }) : '') +
            (r.skipped_no_duration ? T(' · {skipped_no_duration} skipped (no duration yet)', { skipped_no_duration: r.skipped_no_duration }) : '') +
            (r.skipped_flagged ? T(' · {skipped_flagged} skipped (flagged)', { skipped_flagged: r.skipped_flagged }) : '') +
            (r.skipped_rights ? T(' · {skipped_rights} skipped (rights not cleared)', { skipped_rights: r.skipped_rights }) : '') +
            (r.skipped_not_169 ? T(' · {count} not 16:9', { count: n0(r.skipped_not_169) }) : '') +
            (r.skipped_duplicates ? T(' · {count} ignored', { count: Tn('{n} duplicate copy', '{n} duplicate copies', r.skipped_duplicates) }) : '');
        if ($('#gen-brand').checked) {
            const miss = (r.brand_missing || []).map((t) => BRAND_INFO[t]?.[0] || t);
            $('#gen-info').append(Tn(' · branding: {n} item, {duration}', ' · branding: {n} items, {duration}', r.brand_items || 0, { duration: fmtDur(r.brand_s || 0) }),
                miss.length ? h('div', { class: 'warn' }, T('No usable files for: {v}. Upload them on the Channel branding page (files that fail the check are not used).', { v: miss.join(', ') })) : '');
        }
        $('#gen-info').prepend(...planInfo(plan, date));
        const dropped = (plan.pins || []).reduce((n, p) => n + (p.dropped?.length || 0), 0) + (plan.problems?.length || 0);
        if (r.repeats) {
            const warn = Tn('{n} clip plays more than once: the usable clips add up to only {duration} for {duration2} of airtime. Add folders or categories, or relax the options, for more variety.', '{n} clips play more than once: the usable clips add up to only {duration} for {duration2} of airtime. Add folders or categories, or relax the options, for more variety.', r.repeats, { duration: fmtDur(r.pool_s), duration2: fmtDur(clips.reduce((t, i) => t + itemDur(i), 0)) });
            $('#gen-info').prepend(h('div', { class: 'warn' }, warn));
        }
        if (dropped) toast(T('Generated, but pinned blocks had items left out or problems (listed under the Generate button). Review it, then press Save.'), 'err');
        else if (r.repeats) toast(T('Generated, with repeats: {count} more than once. Review it, then press Save.', { count: plural(r.repeats, 'clip plays', 'clips play') }), 'err');
        else toast(T('Generated. Review it, then press Save.'), 'ok');
    } catch (e) {
        toast(e.message, 'err');
        // Pins can be the cause (overlap): list them with Remove pin.
        if (plan) $('#gen-info').replaceChildren(h('div', { class: 'bad' }, e.message), ...planInfo(plan, date));
    } finally { btn.disabled = !!loadPlaylist.pending; btn.textContent = label; }
});

// Fill empty days: generate and save a playlist for each day in the range that has
// none. Never overwrites: existence is checked before asking and again before saving.
$('#fill-run').addEventListener('click', async () => {
    const btn = $('#fill-run');
    const miss = needSource();
    if (miss) return toast(miss, 'err');
    const n = Math.min(31, Math.max(1, Math.floor(Number($('#fill-days').value) || 0)));
    const start = $('#pl-date').value;
    const dates = Array.from({ length: n }, (_, i) => addDays(start, i));
    let w;
    try { w = genWindow(); } catch (e) { return toast(e.message, 'err'); }
    btn.disabled = true;
    btn.textContent = T('Checking…');
    try {
        const have = await Promise.all(dates.map(playlistExists));
        const todo = dates.filter((_, i) => !have[i]);
        const kept = dates.filter((_, i) => have[i]);
        if (!todo.length) return toast(T('All {n} days from {date} already have a playlist. Nothing to do.', { n, date: fmtDate(start) }));
        const t = currentTemplate();
        const plans = await loadPlans(todo);
        if (!plans) return;
        const occDays = todo.filter((d) => plans.get(d).occasion);
        const pinDays = todo.filter((d) => plans.get(d).pins.length && !plans.get(d).occasion);
        const pinWarn = todo.flatMap((d) => [...(plans.get(d).problems || []), ...pinNotes(plans.get(d))].map((x) => `${fmtDate(d)}: ${x}`));
        const ok = await confirmModal(T('Fill empty days?'), [
            Tn('Create and save playlists for {n} day: {dates}.', 'Create and save playlists for {n} days: {dates}.', todo.length, { dates: fmtDates(todo) }),
            kept.length ? Tn('{n} day already has a playlist and stays unchanged: {dates}.', '{n} days already have a playlist and stay unchanged: {dates}.', kept.length, { dates: fmtDates(kept) }) : '',
            `${t ? `Template: ${t.name}` : `From: ${[...S.genFolders].map((f) => f || T('Media (all)')).join(', ')}`}. ${$('#gen-cleared').checked ? T('Only rights-cleared clips.') : T('Rights are NOT checked.')}`,
            (w.custom ? `Broadcast window ${w.label}; off-air slate outside it.` : T('Full broadcast day.')) + (w.live ? T(' Live slot {label} every day.', { label: w.live.label }) : ''),
            occDays.length ? `Occasion days (their branding set and pinned blocks are used): ${occDays.map((d) => `${bidiText(plans.get(d).occasion.name)} ${fmtDate(d)}`).join(', ')}.` : '',
            pinDays.length ? `Days with pinned blocks: ${pinDays.map((d) => `${fmtDate(d)} (${plans.get(d).pins.map((p) => `${bidiText(p.name)} at ${p.start}`).join(', ')})`).join('; ')}.` : '',
            plans.get(todo[0]).skipped ? h('p', { class: 'warn' }, T('Without saved blocks and occasions (their file could not be read).')) : '',
            pinWarn.length ? h('div', { class: 'warn small' }, h('b', {}, T('Pinned blocks: ')), h('ul', {}, ...pinWarn.slice(0, 12).map((x) => h('li', {}, x)), pinWarn.length > 12 ? h('li', {}, T('…and {v} more', { v: pinWarn.length - 12 })) : null)) : '',
        ].filter(Boolean), { ok: T('Create {count}', { count: todo.length }), danger: !$('#gen-cleared').checked || pinWarn.length > 0 });
        if (!ok) return;
        const created = [], skipped = [], short = [], repeated = [], problems = [];
        let avoid = [];
        // Undo: the new days (and their block marks) are moved aside together.
        const tok = await undoPlBegin(todo, T('Empty days filled ({count})', { count: Tn('{n} day', '{n} days', todo.length) }));
        S.undoGroup = tok;
        try {
        for (const d of todo) {
            btn.textContent = `${fmtDate(d)}…`;
            const plan = plans.get(d);
            const day = await buildDay(d, avoid, w, plan).catch((e) => { throw new Error(`${fmtDate(d)}: ${e.message}`); });
            if (await playlistExists(d)) { skipped.push(d); continue; }
            try { await api('POST', `/api/playlist/${S.channelId}`, { channel: S.channel.name, date: d, program: day.program }); }
            catch (e) { if (e.status === 409) { skipped.push(d); continue; } throw e; }
            created.push(d);
            for (const p of [...(plan.problems || []), ...pinNotes(plan)]) problems.push(`${fmtDate(d)}: ${p}`);
            try { if (day.placements.length || plan.placed_n) await savePlacements(d, day.placements); } catch (e) { problems.push(T('{date}: the saved-block marks could not be stored ({error})', { date: fmtDate(d), error: e.message })); }
            if (day.stats.total < day.contentLen - 1) short.push(d);
            if (day.stats.repeats) repeated.push(d);
            avoid = [...new Set([...avoid, ...day.clips.map((i) => i.source)])];
        }
        } finally { S.undoGroup = null; await undoPlCommit(tok, created); }
        toast(`Created ${created.length} playlist${created.length === 1 ? '' : 's'}` +
            (skipped.length ? `; ${skipped.length} skipped (created meanwhile)` : '') +
            (short.length ? `; short (not enough clips): ${fmtDates(short)}` : '') +
            (repeated.length ? `; clips repeat within the day on ${fmtDates(repeated)} (not enough usable clips)` : '') + '.' +
            (problems.length ? ` ${problems.join(' ')}` : ''), short.length || repeated.length || problems.length ? 'err' : 'ok');
        checkSchedule();
        if (created.includes(S.playlist?.date) && !S.plDirty) loadPlaylist();
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = !!loadPlaylist.pending; btn.textContent = T('Fill'); }
});

// ---- playlists pointing at renamed/moved files ----
// Saved playlists store file paths. After a file is renamed or moved on the share (and
// the library rescanned), the panel finds its new path by clip ID and offers to update
// the saved playlists from today's broadcast day on. Nothing changes without a yes.
// Runs fn over items with at most `limit` calls at a time; results keep the order.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
async function repairPlaylists({ quiet = false } = {}) {
    const start = broadcastDate();
    const days = Array.from({ length: 32 }, (_, i) => addDays(start, i));
    const lists = await mapLimit(days, 4, (d) => api('GET', `/api/playlist/${S.channelId}?date=${d}`).catch(() => null));
    const sources = [...new Set(lists.flatMap((p) => (p?.program || []).map((i) => i.source)))];
    if (!sources.length) { if (!quiet) toast(T('No saved playlists from today on.')); return; }
    const r = await localJson('POST', '/local/playlists/resolve', { sources });
    const moved = Object.entries(r.map);
    if (!moved.length) {
        if (r.missing.length) toast(Tn('{n} playlist item points to a file that is not on the share and could not be traced: {names}{more}', '{n} playlist items point to files that are not on the share and could not be traced: {names}{more}', r.missing.length, { names: r.missing.slice(0, 3).map(baseName).join(', '), more: r.missing.length > 3 ? '…' : '' }), 'err');
        else if (!quiet) toast(T('All files in the saved playlists were found.'), 'ok');
        return;
    }
    const affected = days.filter((d, i) => (lists[i]?.program || []).some((it) => r.map[it.source]));
    const ok = await confirmModal(T('Update playlists for moved files?'), [
        T('{files} in {playlists} ({dates}) renamed or moved on the share:', { files: Tn('{n} file was', '{n} files were', moved.length), playlists: Tn('{n} saved playlist', '{n} saved playlists', affected.length), dates: fmtDates(affected) }),
        h('ul', { class: 'small' }, ...moved.slice(0, 8).map(([a, b]) => h('li', {}, `${baseName(a)} → ${b}`)), moved.length > 8 ? h('li', {}, T('…and {v} more', { v: moved.length - 8 })) : null),
        T('Update those playlists to the new paths?'),
        r.missing.length ? Tn('{n} other item could not be traced and stays as it is.', '{n} other items could not be traced and stay as they are.', r.missing.length) : '',
    ].filter(Boolean), { ok: T('Update playlists') });
    if (!ok) return;
    let n = 0;
    const tok = await undoPlBegin(affected, T('Playlists updated for moved files ({count})', { count: Tn('{n} day', '{n} days', affected.length) }));
    const updated = [];
    try {
        for (let i = 0; i < days.length; i++) {
            const p = lists[i];
            if (!p?.program?.some((it) => r.map[it.source])) continue;
            const program = p.program.map((it) => (r.map[it.source] ? { ...it, source: r.map[it.source] } : it));
            await api('POST', `/api/playlist/${S.channelId}`, { ...p, channel: S.channel.name, date: days[i], program });
            updated.push(days[i]);
            n++;
        }
    } finally { await undoPlCommit(tok, updated); }
    toast(T('{count} updated.', { count: plural(n, 'playlist', 'playlists') }), 'ok');
    if (S.playlist && affected.includes(S.playlist.date) && !S.plDirty) loadPlaylist();
}
$('#pl-fix-paths').addEventListener('click', () => repairPlaylists().catch((e) => toast(e.message, 'err')));

// ---- schedule feed: next 7 days as JSON and XMLTV ----
const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function xmltvTime(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())} ${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}
$('#feed-export').addEventListener('click', async () => {
    const btn = $('#feed-export');
    btn.disabled = true;
    try {
        const start = broadcastDate();
        const dayStart = parseHms(S.config.playlist.day_start) || 0;
        const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
        const lists = await Promise.all(days.map((d) => api('GET', `/api/playlist/${S.channelId}?date=${d}`).catch(() => null)));
        const raw = [];
        days.forEach((d, i) => {
            const prog = lists[i]?.program || [];
            let t = new Date(`${d}T00:00:00`).getTime() + dayStart * 1000;
            for (const it of prog) {
                const len = itemDur(it);
                const kind = isOffair(it.source) ? 'offair' : isLiveSlot(it.source) ? 'live' : inStorage(it.source) ? 'filler' : 'clip';
                if (kind === 'clip' || kind === 'live') raw.push({ start: t, end: t + len * 1000, source: it.source, kind });
                t += len * 1000;
            }
        });
        const look = (await localJson('POST', '/local/meta/lookup', { sources: [...new Set(raw.filter((r) => r.kind === 'clip').map((r) => r.source))] })).items;
        const items = raw.map((r) => {
            const m = look[r.source] || {};
            return { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), live: r.kind === 'live',
                title: r.kind === 'live' ? T('Live') : m.title || baseName(r.source).replace(/\.[^.]+$/, ''), performer: m.performer || '', category: m.category ? CAT_LABEL[m.category] || m.category : '' };
        });
        const json = JSON.stringify({ channel: S.channel.name, generated: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, items }, null, 1);
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Grady Set Go - Playout App">\n  <channel id="channel-1"><display-name>${xmlEsc(S.channel.name)}</display-name></channel>\n` +
            items.map((it) => `  <programme start="${xmltvTime(new Date(it.start))}" stop="${xmltvTime(new Date(it.end))}" channel="channel-1">\n    <title>${xmlEsc(it.title)}</title>\n` +
                (it.performer ? `    <desc>${xmlEsc(it.performer)}</desc>\n` : '') + (it.category ? `    <category lang="en">${xmlEsc(it.category)}</category>\n` : '') + '  </programme>').join('\n') + '\n</tv>\n';
        await localJson('POST', '/local/feed', { json, xml });
        const missing = days.filter((_, i) => !lists[i]?.program?.length);
        toast(T('Schedule saved ({count}, {date}–{date2}) to the data\\feed folder.', { count: Tn('{n} item', '{n} items', items.length), date: fmtDate(days[0]), date2: fmtDate(days[6]) }) + (missing.length ? T(' No playlist for: {dates}.', { dates: fmtDates(missing) }) : ''), missing.length ? 'err' : 'ok');
        const a = h('a', { href: URL.createObjectURL(new Blob([xml], { type: 'application/xml' })), download: `schedule-${days[0]}.xml` });
        document.body.append(a); a.click(); a.remove();
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
});

$('#br-source').addEventListener('change', (e) => { S.mediaSource = e.target.value; renderFormats(); browse(''); });

async function browse(rel) {
    S.browsePath = rel;
    const list = $('#br-list');
    const share = S.mediaSource === 'share';
    list.replaceChildren(h('li', { class: 'muted' }, T('Loading…')));
    const baseHint = share ? T('Read-only. Durations come from library.csv; “?” files are probed on demand.') : T('ffplayout storage (filler, uploads).');
    $('#br-hint').textContent = baseHint;
    try {
        const r = share
            ? await localJson('GET', `/local/media/browse?path=${encodeURIComponent(rel)}&ext=${encodeURIComponent(formatParam())}`)
            : await api('POST', `/api/file/${S.channelId}/browse`, { source: rel ? '/' + rel : '', folders_only: false });
        renderCrumbs($('#br-crumbs'), rel, browse, share ? T('Media') : 'storage');
        const filter = $('#br-filter').value.toLowerCase();
        const items = [];
        const up = () => browse(rel.split('/').slice(0, -1).join('/'));
        if (rel) items.push(h('li', { class: 'folder', onclick: up, ...kbd(up), 'aria-label': T('Up one folder') }, h('span', { class: 'name' }, '↩ ..')));
        if (share) {
            items.push(h('li', {},
                h('input', { type: 'checkbox', title: T('Use this folder for Generate'), checked: S.genFolders.has(rel), onchange: (e) => { e.target.checked ? S.genFolders.add(rel) : S.genFolders.delete(rel); renderGenFolders(); } }),
                h('span', { class: 'name muted small' }, rel ? T('Use “{v}” for Generate', { v: rel.split('/').pop() }) : T('Use the whole share for Generate'))));
        }
        for (const f of r.folders || []) {
            if (filter && !f.toLowerCase().includes(filter)) continue;
            const sub = rel ? `${rel}/${f}` : f;
            items.push(h('li', { class: 'folder', onclick: (e) => { if (e.target.tagName !== 'INPUT') browse(sub); }, ...kbd(() => browse(sub)) },
                share ? h('input', { type: 'checkbox', title: T('Use for Generate'), checked: S.genFolders.has(sub), onchange: (e) => { e.target.checked ? S.genFolders.add(sub) : S.genFolders.delete(sub); renderGenFolders(); } }) : null,
                h('span', {}, '📁'), h('span', { class: 'name' }, f),
                share ? h('span', { class: 'cnt', title: T('Clips in this folder and its subfolders (current formats)') },
                    r.folder_counts?.[f] ? `${r.folder_counts[f].clips} · ${r.folder_counts[f].hours} h` : '0') : null));
        }
        for (const f of r.files || []) {
            if (filter && !f.name.toLowerCase().includes(filter)) continue;
            const dur = h('span', { class: 'dur' }, f.duration ? fmtDur(f.duration) : share ? '?' : '');
            items.push(h('li', {},
                h('span', { class: 'name' }, playLink(f.name, f.path || storagePath(rel ? `${rel}/${f.name}` : f.name),
                    [T('Play in VLC'), f.res, f.fps && `${f.fps} fps`, f.lufs && `${f.lufs} LUFS`].filter(Boolean).join(' · '))),
                f.conform ? h('span', { class: 'flag', title: f.issues }, '⚠') : null,
                dur,
                h('button', { class: 'btn small', title: T('Add to playlist'), onclick: () => addItem(rel, f, dur) }, '+')));
        }
        list.replaceChildren(...(items.length ? items : [h('li', { class: 'muted' }, T('Empty folder'))]));
        if (share && (r.hidden_by_format || r.hidden_marked)) $('#br-hint').textContent = [r.hidden_by_format ? T('{count} here hidden by the format filter.', { count: Tn('{n} file', '{n} files', r.hidden_by_format) }) : '', r.hidden_marked ? T('{hidden_marked} hidden on the Needs attention page.', { hidden_marked: r.hidden_marked }) : '', baseHint].filter(Boolean).join(' ');
    } catch (e) { list.replaceChildren(h('li', { class: 'muted' }, e.message)); }
}
$('#br-filter').addEventListener('input', () => browse(S.browsePath));

function renderCrumbs(el, rel, go, rootLabel = 'storage') {
    const parts = rel ? rel.split('/') : [];
    const link = (label, target) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); go(target); } }, label);
    el.replaceChildren(link(rootLabel, ''), ...parts.flatMap((p, i) => [' / ', link(p, parts.slice(0, i + 1).join('/'))]));
}

async function addItem(rel, f, durEl) {
    let duration = f.duration;
    if (!duration && f.path) {
        if (durEl) durEl.textContent = '…';
        try { duration = (await localJson('GET', `/local/media/probe?path=${encodeURIComponent(rel ? `${rel}/${f.name}` : f.name)}`)).duration; } catch { /* handled below */ }
        if (durEl) durEl.textContent = duration ? fmtDur(duration) : '✕';
    }
    if (!duration) return toast(T('This file has no readable duration and cannot be scheduled.'), 'err');
    const source = f.path || storagePath(rel ? `${rel}/${f.name}` : f.name);
    S.playlist.program.push({ in: 0, out: duration, duration, source });
    S.plDirty = true;
    renderPlaylist();
    toast(T('Added {name}{v}', { name: f.name, v: f.conform ? T(' (flagged: ') + f.issues + ')' : '' }));
}

