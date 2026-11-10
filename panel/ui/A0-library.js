// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part A0-library. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- library

S.lib = { offset: 0, limit: 100, data: null, ready: false, sort: '', dir: '' };
// Categories come from the server (config.json); filled by applyCategories() at start-up.
const CAT_LABEL = {};
function applyCategories(list) {
    for (const k of Object.keys(CAT_LABEL)) delete CAT_LABEL[k];
    for (const c of list || []) CAT_LABEL[c.code] = c.label;
    $('#meta-form').category.replaceChildren(h('option', { value: '' }, '—'), ...Object.entries(CAT_LABEL).map(([k, v]) => h('option', { value: k }, v)));
}
function ensureCategoryOption(c) {
    const sel = $('#meta-form').category;
    if (c && ![...sel.options].some((o) => o.value === c)) sel.append(h('option', { value: c }, CAT_LABEL[c] || c));
}
const ASPECT_LABEL = i18nLazy({ '16:9': '16:9', '4:3': '4:3', vertical: N_('Vertical'), square: N_('Square'), sd: 'SD', other: N_('Other shape') });
const rightsBadge = (c) => c.cleared ? h('span', { class: 'badge on', title: c.rights_expires ? T('Until {date}', { date: fmtDate(c.rights_expires) }) : '' }, T('Cleared'))
    : c.expired ? h('span', { class: 'badge warn', title: T('Expired {date}', { date: fmtDate(c.rights_expires) }) }, T('Expired'))
        : c.rights === 'blocked' ? h('span', { class: 'badge bad' }, T('Blocked'))
            : h('span', { class: 'badge' }, T('Unknown'));

function libQuery() {
    const q = new URLSearchParams({ q: $('#lib-q').value.trim(), folder: $('#lib-folder').value, type: $('#lib-type').value, rights: $('#lib-rights').value, category: $('#lib-cat').value, issue: $('#lib-issue').value, aspect: $('#lib-aspect').value, explicit: $('#lib-explicit').value, sort: S.lib.sort, dir: S.lib.dir, offset: S.lib.offset, limit: S.lib.limit });
    return '/local/meta/list?' + q;
}

async function renderLibrary() {
    pollScan(false);
    pollAnalysis();
    updatePlan();
    await loadLib();
}

