// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./registry');

// Interface languages. Shipped catalogs live in panel/locales/<code>.json. A file with the same
// name in <data>/locales/ is merged over it (single messages can be corrected locally) and
// survives updates; a code that only exists there is a language of its own. Catalog format:
//   { "_meta": { "code", "name" (in its own language), "english_name", "tag" (BCP 47), "dir": "ltr"|"rtl" },
//     "messages": { "<English text>": "<translation>" | { "one": "...", "other": "..." } } }
const SHIPPED_DIR = path.join(R.core.ROOT, 'locales');
const LOCAL_DIR = path.join(R.core.DATA_DIR, 'locales');
const CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function codesIn(dir) {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((c) => CODE_RE.test(c)); } catch { return []; }
}
function validMessages(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    const out = {};
    for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'string') out[k] = v;
        else if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.other === 'string') {
            const forms = {};
            for (const c of ['zero', 'one', 'two', 'few', 'many', 'other']) if (typeof v[c] === 'string') forms[c] = v[c];
            out[k] = forms;
        }
    }
    return out;
}
function readLocale(code) {
    if (!CODE_RE.test(code)) return null;
    const a = readJson(path.join(SHIPPED_DIR, code + '.json'));
    const b = readJson(path.join(LOCAL_DIR, code + '.json'));
    if (!a && !b) return null;
    const meta = { ...((a && a._meta) || {}), ...((b && b._meta) || {}) };
    if (!meta.name) meta.name = meta.english_name || code;
    meta.code = code;
    meta.tag = typeof meta.tag === 'string' && /^[A-Za-z0-9-]{2,20}$/.test(meta.tag) ? meta.tag : code;
    meta.dir = meta.dir === 'rtl' ? 'rtl' : 'ltr';
    return { _meta: meta, messages: { ...validMessages(a && a.messages), ...validMessages(b && b.messages) } };
}
function listLocales() {
    const codes = [...new Set([...codesIn(SHIPPED_DIR), ...codesIn(LOCAL_DIR)])].sort();
    const languages = [];
    for (const code of codes) {
        const l = readLocale(code);
        if (l) languages.push({ ...l._meta, messages: Object.keys(l.messages).length });
    }
    // English first, then by English name.
    languages.sort((x, y) => (x.code === 'en' ? -1 : y.code === 'en' ? 1 : String(x.english_name || x.code).localeCompare(String(y.english_name || y.code))));
    const sys = R.system.readSystem();
    const def = sys.default_language && sys.default_language !== 'auto' && languages.some((l) => l.code === sys.default_language) ? sys.default_language : 'auto';
    return { default: def, languages };
}
R.locales = module.exports;
Object.assign(module.exports, { SHIPPED_DIR, LOCAL_DIR, CODE_RE, readLocale, listLocales });
