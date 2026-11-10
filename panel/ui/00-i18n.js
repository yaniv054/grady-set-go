// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Interface language: message catalogs, plurals, numbers, dates, text direction.
'use strict';
//
// How it works
// - The English text in the code IS the message key: T('Save'), T('Open {name}', { name }),
//   Tn('{n} clip', '{n} clips', n). A catalog (panel/locales/<code>.json) maps English text to
//   the translation. A missing entry shows the English text, so nothing is ever blank.
// - Catalog files hold { _meta: { code, name, english_name, tag, dir }, messages: { ... } }.
//   Plural entries are objects keyed by CLDR plural category (zero, one, two, few, many, other),
//   stored under the singular English text. Context for ambiguous words: T('Open', null, 'verb')
//   looks up "Open##verb".
// - Dates follow the language (order and separator come from Intl, digits are always 0-9 so
//   typing and parsing stay predictable); the browser can override the order. Internally and
//   towards ffplayout dates stay YYYY-MM-DD. Times are always 24-hour (a playout tool).
// - Adding a language = adding locales/<code>.json (or data/locales/<code>.json, which survives
//   updates and may override single messages of a shipped language). No code change.

const I18N = {
    lang: 'en', tag: 'en', dir: 'ltr', messages: {}, langs: [], dateOrder: 'auto', ready: null,
    storeKey: 'cr_lang', dateKey: 'cr_date_order',
};
const I18N_CTX = '##';

function i18nInterpolate(s, params) {
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}
// N_('text') marks a text in a top-level table (evaluated before the catalog is loaded): it returns the
// text unchanged and only tells the extractor about it. Translate it where it is shown: T(row.title).
const N_ = (s) => s;
// i18nLazy(table): a read-only view of a top-level table of texts. Every text read from it is translated
// at that moment, so a table defined at load time follows the language. Nested objects and arrays work too.
function i18nLazy(value) {
    if (value === null || typeof value !== 'object') return value;
    return new Proxy(value, {
        get(target, key, receiver) {
            const v = Reflect.get(target, key, receiver);
            if (typeof key === 'symbol') return v;
            if (typeof v === 'string') return T(v);
            if (v && typeof v === 'object') return i18nLazy(v);
            return v;
        },
    });
}
// T('Save'), T('Open {name}', { name }), T('Open', null, 'verb')
function T(src, params, ctx) {
    const hit = I18N.messages[ctx ? src + I18N_CTX + ctx : src];
    const msg = typeof hit === 'string' ? hit : (hit && typeof hit.other === 'string' ? hit.other : src);
    return i18nInterpolate(msg, params);
}
// Tn('{n} clip', '{n} clips', count, extraParams): picks the plural form of the active language.
function Tn(one, many, n, params) {
    const num = Number(n || 0);
    const p = { ...(params || {}), n: fmtNum(num) };
    const entry = I18N.messages[one];
    if (entry && typeof entry === 'object') {
        let cat = 'other';
        try { cat = new Intl.PluralRules(I18N.tag).select(num); } catch { /* keep other */ }
        const form = entry[cat] ?? entry.other;
        if (typeof form === 'string') return i18nInterpolate(form, p);
    }
    return i18nInterpolate(num === 1 ? one : many, p);
}

// ---- numbers and dates -------------------------------------------------------------------
const I18N_NU = '-u-nu-latn-ca-gregory';   // Latin digits, Gregorian calendar, in every language
function i18nFmt(kind, opts) {
    const key = kind + JSON.stringify(opts) + I18N.tag;
    i18nFmt.cache = i18nFmt.cache || new Map();
    if (!i18nFmt.cache.has(key)) {
        let f;
        try { f = kind === 'num' ? new Intl.NumberFormat(I18N.tag + I18N_NU, opts) : new Intl.DateTimeFormat(I18N.tag + I18N_NU, opts); }
        catch { f = kind === 'num' ? new Intl.NumberFormat('en-US', opts) : new Intl.DateTimeFormat('en-GB', opts); }
        i18nFmt.cache.set(key, f);
    }
    return i18nFmt.cache.get(key);
}
const fmtNum = (n, opts) => i18nFmt('num', opts || {}).format(Number(n || 0));
// Weekday names from the language: 0 = Sunday.
const weekdayName = (i, style = 'long') => i18nFmt('date', { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + (i % 7))));
const monthName = (i, style = 'long') => i18nFmt('date', { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, i % 12, 1)));

// Date layout: { order: 'dmy'|'mdy'|'ymd', sep: '/' , yearDigits: 2|4 } from the language, unless overridden.
function dateLayout() {
    const pick = I18N.dateOrder !== 'auto' ? I18N.dateOrder : null;
    if (dateLayout.cache && dateLayout.cache.tag === I18N.tag && dateLayout.cache.pick === pick) return dateLayout.cache.v;
    let order = 'dmy', sep = '/';
    try {
        const parts = new Intl.DateTimeFormat(I18N.tag + I18N_NU, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2023, 10, 25)));
        const o = parts.filter((p) => ['day', 'month', 'year'].includes(p.type)).map((p) => p.type[0]).join('');
        if (['dmy', 'mdy', 'ymd'].includes(o)) order = o;
        const lit = parts.find((p) => p.type === 'literal' && /[/.\-]/.test(p.value));
        if (lit) sep = lit.value.trim().slice(0, 1);
    } catch { /* defaults */ }
    if (pick) order = pick;
    if (!/^[/.\-]$/.test(sep)) sep = '/';
    const v = { order, sep, yearDigits: order === 'ymd' ? 4 : 2 };
    dateLayout.cache = { tag: I18N.tag, pick, v };
    return v;
}
// The date format as a hint for input fields, e.g. "dd/mm/yy": letters come from the catalog.
function dateHint() {
    const L = dateLayout();
    const letter = { d: T('dd', null, 'date'), m: T('mm', null, 'date'), y: L.yearDigits === 4 ? T('yyyy', null, 'date') : T('yy', null, 'date') };
    return L.order.split('').map((c) => letter[c]).join(L.sep);
}

// ---- loading -------------------------------------------------------------------------------
function i18nPickLanguage(available) {
    const codes = new Set(available.map((l) => l.code));
    let saved = '';
    try { saved = localStorage.getItem(I18N.storeKey) || ''; } catch { /* storage blocked */ }
    if (saved && codes.has(saved)) return saved;
    for (const l of navigator.languages || [navigator.language || 'en']) {
        const base = String(l).toLowerCase();
        if (codes.has(base)) return base;
        const primary = base.split('-')[0];
        if (codes.has(primary)) return primary;
    }
    return 'en';
}
async function i18nLoad(code) {
    const r = await fetch(`/locales/${encodeURIComponent(code)}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`locale ${code}: HTTP ${r.status}`);
    const j = await r.json();
    if (!j || typeof j !== 'object' || typeof j.messages !== 'object') throw new Error(`locale ${code}: bad file`);
    return j;
}
function i18nApplyDocument() {
    document.documentElement.lang = I18N.tag;
    document.documentElement.dir = I18N.dir;
    // Static text in index.html: data-i18n="text", data-i18n-attr="title:..;placeholder:.." (attribute text is the English original).
    // The key is the original text with whitespace collapsed. An element whose text was changed by the
    // program since the last translation (live status text) is left alone.
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        if (el.dataset.i18nSrc === undefined) { el.dataset.i18nSrc = el.textContent.trim().replace(/\s+/g, ' '); el.dataset.i18nLast = el.textContent; }
        if (el.textContent !== el.dataset.i18nLast) return;
        const text = T(el.dataset.i18nSrc, null, el.dataset.i18nCtx);
        el.textContent = text;
        el.dataset.i18nLast = text;
    });
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
        for (const pair of el.dataset.i18nAttr.split(';')) {
            const name = pair.trim();
            if (!name) continue;
            const key = `i18nSrc_${name.replace(/-/g, '_')}`;
            if (el.dataset[key] === undefined) el.dataset[key] = el.getAttribute(name) || '';
            el.setAttribute(name, T(el.dataset[key]));
        }
    });
    document.querySelectorAll('.date-txt').forEach((el) => { el.placeholder = dateHint(); });
}
async function i18nInit() {
    let manifest = { default: 'en', languages: [{ code: 'en', name: 'English', english_name: 'English', tag: 'en', dir: 'ltr' }] };
    try { const r = await fetch('/locales/index.json', { cache: 'no-cache' }); if (r.ok) manifest = await r.json(); } catch { /* English only */ }
    I18N.langs = manifest.languages;
    try { I18N.dateOrder = localStorage.getItem(I18N.dateKey) || 'auto'; } catch { /* storage blocked */ }
    await i18nSet(i18nPickLanguage(I18N.langs), { save: false });
}
async function i18nSet(code, { save = true } = {}) {
    let file = null;
    if (code !== 'en') { try { file = await i18nLoad(code); } catch (e) { console.warn(e.message); code = 'en'; } }
    I18N.lang = code;
    I18N.messages = file ? file.messages : {};
    I18N.tag = (file && file._meta && file._meta.tag) || code;
    I18N.dir = (file && file._meta && file._meta.dir) === 'rtl' ? 'rtl' : 'ltr';
    if (save) { try { localStorage.setItem(I18N.storeKey, code); } catch { /* storage blocked */ } }
    dateLayout.cache = null;
    i18nApplyDocument();
    document.dispatchEvent(new CustomEvent('i18n-changed'));
}
function i18nSetDateOrder(order) {
    I18N.dateOrder = ['dmy', 'mdy', 'ymd'].includes(order) ? order : 'auto';
    try { localStorage.setItem(I18N.dateKey, I18N.dateOrder); } catch { /* storage blocked */ }
    dateLayout.cache = null;
    i18nApplyDocument();
    document.dispatchEvent(new CustomEvent('i18n-changed'));
}
I18N.ready = i18nInit();
