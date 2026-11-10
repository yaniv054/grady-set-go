// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
// Language picker (side bar) and the language controls in System settings. The runtime is in 00-i18n.js.

function fillLanguageSelects() {
    const side = $('#lang-select');
    side.replaceChildren(...I18N.langs.map((l) => h('option', { value: l.code }, l.name || l.english_name || l.code)));
    side.value = I18N.lang;
    const sys = $('#sys-lang');
    if (sys) {
        const cur = sys.value;
        sys.replaceChildren(h('option', { value: 'auto' }, T('Follow the browser language')), ...I18N.langs.map((l) => h('option', { value: l.code }, l.name || l.english_name || l.code)));
        sys.value = cur || 'auto';
    }
    const order = $('#sys-dateorder');
    if (order) order.value = I18N.dateOrder;
}
$('#lang-select').addEventListener('change', (e) => { i18nSet(e.target.value); });
$('#sys-dateorder').addEventListener('change', (e) => { i18nSetDateOrder(e.target.value); });
// A language or date-order change redraws the screen that is open (labels, dates, placeholders).
document.addEventListener('i18n-changed', () => {
    fillLanguageSelects();
    if (typeof route === 'function' && route.cur && !$('#app').hidden) { try { route(); } catch (e) { console.warn(e); } }
});
I18N.ready.then(fillLanguageSelects);
