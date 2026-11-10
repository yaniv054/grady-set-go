// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part A6-asrun. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- as-run

const KIND_LABEL = i18nLazy({ filler: N_('Filler'), offair: N_('Off air'), live: N_('Live slot (standby)'), storage: N_('Channel asset'), unknown: N_('Not in library') });
function renderAsrun() {
    if (!$('#ar-date').value) $('#ar-date').value = isoDate(new Date());
    loadAsrun();
}
async function loadAsrun() {
    const d = $('#ar-date').value;
    $('#ar-export-day').href = `/local/asrun/export?from=${d}&to=${d}${$('#ar-all').checked ? '&all=1' : ''}`;
    $('#ar-export-json').href = `/local/asrun/export?from=${d}&to=${d}&format=json${$('#ar-all').checked ? '&all=1' : ''}`;
    const first = d.slice(0, 8) + '01';
    const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
    $('#ar-export-month').href = `/local/asrun/export?from=${first}&to=${last}${$('#ar-all').checked ? '&all=1' : ''}`;
    let r;
    try { r = await localJson('GET', `/local/asrun?date=${d}`); } catch (e) { return toast(e.message, 'err'); }
    if ($('#ar-date').value !== d) return;
    const all = $('#ar-all').checked;
    const rows = r.rows.filter((x) => all || x.kind === 'clip' || x.kind === 'unknown');
    const clipRows = r.rows.filter((x) => x.kind === 'clip' || x.kind === 'unknown');
    const sum = (list) => list.reduce((s, x) => s + x.aired_s, 0);
    const other = r.rows.filter((x) => !(x.kind === 'clip' || x.kind === 'unknown'));
    $('#ar-summary').replaceChildren(...[
        h('span', {}, T('Clips '), h('b', {}, clipRows.length), ` · ${fmtDur(sum(clipRows))}`),
        h('span', { class: 'muted' }, T('Filler / off-air {duration}', { duration: fmtDur(sum(other)) })),
        clipRows.some((x) => x.rights && x.rights !== 'cleared') ? h('span', { class: 'warn' }, T('{count} aired without cleared rights', { count: n0(clipRows.filter((x) => x.rights && x.rights !== 'cleared').length) })) : null,
    ].filter(Boolean));
    $('#ar-table tbody').replaceChildren(...(rows.length ? rows.map((x) => h('tr', { class: x.kind === 'clip' ? '' : 'dim' },
        h('td', { class: 'mono' }, x.time.slice(0, 8), x.playing ? h('span', { class: 'badge on', style: 'margin-left:6px' }, T('Now')) : null),
        h('td', { class: 'num mono' }, fmtDur(x.aired_s)),
        h('td', { class: 'bidi' }, x.kind === 'clip' || x.kind === 'unknown' ? playLink(x.title, x.source) : (KIND_LABEL[x.kind] || x.kind),
            (x.works || []).length ? h('div', { class: 'sub asrun-works' }, h('span', { class: 'muted' }, T('Songs: ')), ...x.works.map((w, i) => h('span', {},
                i ? ', ' : '', h('span', { class: 'bidi' }, bidiText(w.title)), w.work_no ? h('span', { class: 'muted mono' }, ` #${w.work_no}`) : null))) : null),
        h('td', { class: 'small bidi' }, x.performer),
        h('td', { class: 'small' }, CAT_LABEL[x.category] || ''),
        h('td', {}, x.kind === 'clip' ? rightsBadge({ cleared: x.rights === 'cleared', expired: x.rights === 'expired', rights: x.rights }) : ''),
        h('td', { class: 'muted small' }, bidiText(x.folder)),
    )) : [h('tr', {}, h('td', { colspan: 7, class: 'empty' }, T('Nothing aired on this date.')))]));
}
$('#ar-date').addEventListener('change', loadAsrun);
$('#ar-all').addEventListener('change', loadAsrun);
$('#ar-reload').addEventListener('click', loadAsrun);
$('#ar-prev').addEventListener('click', () => { $('#ar-date').value = addDays($('#ar-date').value, -1); loadAsrun(); });
$('#ar-next').addEventListener('click', () => { $('#ar-date').value = addDays($('#ar-date').value, 1); loadAsrun(); });

