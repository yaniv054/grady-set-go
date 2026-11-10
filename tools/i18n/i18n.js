// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
//
// Translation tool. Zero dependencies.
//   node tools/i18n/i18n.js extract        write panel/locales/_template.json (every English text in the app)
//   node tools/i18n/i18n.js check          compare every catalog with the code: missing, unused, bad placeholders, plural forms
//   node tools/i18n/i18n.js sync <code>    add the missing texts of the template to panel/locales/<code>.json (empty = not translated yet)
//   node tools/i18n/i18n.js prune         remove texts from the catalogs that the code no longer uses
//   node tools/i18n/i18n.js pseudo         write data/locales/xx-pseudo.json (accented, padded text for layout tests)
// "check" exits with 1 when a catalog has a broken placeholder or plural entry, so it can run in CI.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PANEL = path.join(ROOT, 'panel');
const LOCALES = path.join(PANEL, 'locales');
const CTX = '##';

const STR = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`(?:[^`\\\\$]|\\\\.)*`';
const unlit = (lit) => { try { return new Function(`return ${lit}`)(); } catch { return null; } };

function listJs(dir) { return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)); }
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// key -> { plural: bool, many: string, where: [file:line] }
function collect() {
    const found = new Map();
    const add = (key, where, extra) => {
        if (!key || !/\p{L}/u.test(key)) return;
        const e = found.get(key) || { where: [] };
        if (extra) Object.assign(e, extra);
        if (e.where.length < 3) e.where.push(where);
        found.set(key, e);
    };
    const reT = new RegExp(String.raw`\b(?:T|N_)\(\s*(${STR})(?:\s*,\s*(?:null|\{[^}]*\})\s*,\s*(${STR}))?`, 'g');
    const reTn = new RegExp(String.raw`\bTn\(\s*(${STR})\s*,\s*(${STR})`, 'g');
    for (const file of [...listJs(path.join(PANEL, 'ui')), path.join(PANEL, 'help.js')]) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        let m;
        while ((m = reTn.exec(src))) { const one = unlit(m[1]); const many = unlit(m[2]); if (one !== null) add(one, `${rel}:${lineOf(src, m.index)}`, { plural: true, many }); }
        while ((m = reT.exec(src))) { const k = unlit(m[1]); const c = m[2] ? unlit(m[2]) : ''; if (k !== null) add(c ? k + CTX + c : k, `${rel}:${lineOf(src, m.index)}`); }
    }
    // Texts the server sends to the screen: detail: '...' / error: '...' / message: '...'
    const reSrv = new RegExp(String.raw`\b(?:detail|error|message)\s*:\s*(${STR})`, 'g');
    for (const file of listJs(path.join(PANEL, 'src'))) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file).replace(/\\/g, '/');
        let m;
        while ((m = reSrv.exec(src))) { const k = unlit(m[1]); if (k && /\s/.test(k.trim()) || (k && /^[A-Z]/.test(k))) add(k, `${rel}:${lineOf(src, m.index)}`); }
    }
    // index.html
    const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
    const norm = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    const reEl = /<([a-zA-Z0-9]+)([^>]*\sdata-i18n(?=[\s=>])[^>]*)>([^<]*)<\/\1>/g;
    let m;
    while ((m = reEl.exec(html))) {
        const ctx = (m[2].match(/data-i18n-ctx="([^"]*)"/) || [])[1];
        const k = norm(m[3]);
        add(ctx ? k + CTX + ctx : k, `panel/index.html:${lineOf(html, m.index)}`);
    }
    const reTag = /<[a-zA-Z0-9]+[^>]*\sdata-i18n-attr="([^"]*)"[^>]*>/g;
    while ((m = reTag.exec(html))) {
        for (const a of m[1].split(';').map((x) => x.trim()).filter(Boolean)) {
            const v = (m[0].match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1];
            if (v) add(norm(v), `panel/index.html:${lineOf(html, m.index)}`);
        }
    }
    return found;
}

const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
const readCatalog = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), 'utf8'));
const catalogCodes = () => fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.slice(0, -5));
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');

function cmdExtract() {
    const found = collect();
    const messages = {};
    for (const [k, e] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) messages[k] = e.plural ? { _many: e.many } : '';
    writeJson(path.join(LOCALES, '_template.json'), { _meta: { note: 'All English texts of the app. Copy to <code>.json and translate. Plural entries: translate each CLDR form of the language (one, few, many, other ...) and remove _many.' }, messages });
    console.log(`template: ${found.size} texts`);
}

// CLDR plural categories of a language, from Intl.
function pluralCategories(tag) { try { return new Intl.PluralRules(tag).resolvedOptions().pluralCategories; } catch { return ['one', 'other']; } }

function cmdCheck() {
    const found = collect();
    let bad = 0;
    console.log(`texts in code: ${found.size}`);
    for (const code of catalogCodes()) {
        if (code === 'en') continue;
        const cat = readCatalog(code);
        const msgs = cat.messages || {};
        const tag = (cat._meta && cat._meta.tag) || code;
        const cats = pluralCategories(tag);
        let missing = 0, unused = 0, ph = 0, plural = 0, empty = 0;
        for (const [k, e] of found) {
            const v = msgs[k];
            if (v === undefined || v === '') { missing++; continue; }
            if (e.plural) {
                if (typeof v !== 'object') { plural++; console.log(`  [${code}] plural entry must be an object: ${k}`); continue; }
                for (const c of cats) if (typeof v[c] !== 'string' || !v[c]) { plural++; console.log(`  [${code}] plural form "${c}" missing: ${k}`); break; }
                for (const c of Object.keys(v)) if (typeof v[c] === 'string' && placeholders(v[c]) !== placeholders(e.many.includes('{n}') ? '{n}' : '')) { /* n may be dropped in some forms */ }
            } else if (typeof v === 'string') {
                if (placeholders(v) !== placeholders(k)) { ph++; console.log(`  [${code}] placeholders differ: ${k}  ->  ${v}`); }
            }
        }
        for (const k of Object.keys(msgs)) if (!found.has(k)) unused++;
        for (const v of Object.values(msgs)) if (v === '') empty++;
        console.log(`${code}: ${found.size - missing}/${found.size} translated, missing ${missing}, unused ${unused}, bad placeholders ${ph}, bad plurals ${plural}`);
        bad += ph + plural;
    }
    process.exit(bad ? 1 : 0);
}

function cmdSync(code) {
    if (!code) { console.error('usage: sync <code>'); process.exit(2); }
    const file = path.join(LOCALES, `${code}.json`);
    const cat = fs.existsSync(file) ? readCatalog(code) : { _meta: { code, name: code, english_name: code, tag: code, dir: 'ltr' }, messages: {} };
    const found = collect();
    let added = 0;
    for (const [k, e] of found) if (cat.messages[k] === undefined) { cat.messages[k] = e.plural ? { _many: e.many } : ''; added++; }
    writeJson(file, cat);
    console.log(`${code}: ${added} texts added`);
}

function cmdPrune() {
    const found = collect();
    for (const code of catalogCodes()) {
        if (code === 'en') continue;
        const cat = readCatalog(code);
        let n = 0;
        for (const k of Object.keys(cat.messages)) if (!found.has(k)) { delete cat.messages[k]; n++; }
        writeJson(path.join(LOCALES, `${code}.json`), cat);
        console.log(`${code}: ${n} unused texts removed`);
    }
}

function cmdPseudo() {
    const map = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Å', E: 'É', I: 'Î', O: 'Ö', U: 'Ü', c: 'ç', n: 'ñ', y: 'ý' };
    const conv = (s) => '[' + s.replace(/\{\w+\}|[A-Za-z]/g, (c) => (c[0] === '{' ? c : map[c] || c)) + ' ~~]';
    const found = collect();
    const messages = {};
    for (const [k, e] of found) {
        const plain = k.split(CTX)[0];
        if (e.plural) messages[k] = { one: conv(plain), other: conv(e.many), few: conv(e.many), many: conv(e.many) };
        else messages[k] = conv(plain);
    }
    fs.mkdirSync(path.join(ROOT, 'data', 'locales'), { recursive: true });
    writeJson(path.join(ROOT, 'data', 'locales', 'xx-pseudo.json'), { _meta: { code: 'xx-pseudo', name: 'Pseudo (test)', english_name: 'Pseudo-locale for layout tests', tag: 'en', dir: 'ltr' }, messages });
    console.log(`pseudo-locale: ${found.size} texts`);
}

const cmd = process.argv[2];
({ extract: cmdExtract, check: cmdCheck, sync: () => cmdSync(process.argv[3]), prune: cmdPrune, pseudo: cmdPseudo }[cmd] || (() => { console.error('usage: node tools/i18n/i18n.js extract|check|sync <code>|prune|pseudo'); process.exit(2); }))();
