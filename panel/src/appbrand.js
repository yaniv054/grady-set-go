// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const R = require('./registry');

// --- the look of the panel itself: name, logos, accent colour (admin only) ------------
// data\appbrand\settings.json   { app_name, accent }
// data\appbrand\sidebar.<ext>   logo at the top of the menu
// data\appbrand\signin.<ext>    logo on the sign-in page
// A replaced or reset logo is moved to data\appbrand\_replaced\, never deleted.
// Not to be confused with "Channel branding" (idents and stingers for the broadcast).
const DIR = path.join(R.core.DATA_DIR, 'appbrand');
const SETTINGS = path.join(DIR, 'settings.json');
const SLOTS = ['sidebar', 'signin'];
const MAX_LOGO = 1024 * 1024;
const DEFAULT_NAME = 'Grady Set Go';

function kindOf(buf) {
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return { ext: '.png', type: 'image/png' };
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', type: 'image/jpeg' };
    if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: '.webp', type: 'image/webp' };
    if (buf.length > 6 && /^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) return { ext: '.gif', type: 'image/gif' };
    const head = buf.toString('utf8', 0, 1024).trimStart();
    if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return { ext: '.svg', type: 'image/svg+xml' };
    return null;
}
function readSettings() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* defaults */ }
    return { app_name: typeof s.app_name === 'string' ? s.app_name : '', accent: /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent.toLowerCase() : '' };
}
function logoFile(slot) {
    if (!SLOTS.includes(slot) || !fs.existsSync(DIR)) return null;
    const f = fs.readdirSync(DIR).find((n) => new RegExp('^' + slot + '\\.(png|jpg|webp|gif|svg)$').test(n));
    return f ? path.join(DIR, f) : null;
}
function publicInfo() {
    const s = readSettings();
    const v = (slot) => { const f = logoFile(slot); try { return f ? String(Math.round(fs.statSync(f).mtimeMs)) : ''; } catch { return ''; } };
    return { app_name: s.app_name || DEFAULT_NAME, default_name: DEFAULT_NAME, custom_name: s.app_name, accent: s.accent, logos: { sidebar: v('sidebar'), signin: v('signin') } };
}
function writeSettings(input) {
    const cur = readSettings();
    const out = { ...cur };
    if (input.app_name !== undefined) {
        const n = String(input.app_name).replace(/[\u0000-\u001f<>]/g, '').trim();
        if (n.length > 40) throw R.blocks.reqErr('The name may have at most 40 characters.');
        out.app_name = n;
    }
    if (input.accent !== undefined) {
        const a = String(input.accent).trim();
        if (a && !/^#[0-9a-f]{6}$/i.test(a)) throw R.blocks.reqErr('The accent colour must look like #2f6fe0.');
        out.accent = a.toLowerCase();
    }
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.bak');
    R.core.writeJsonAtomic(SETTINGS, out, 1);
    R.core.lifeLine(`appbrand settings ${JSON.stringify(out)}`);
    return publicInfo();
}
function moveAside(slot) {
    const f = logoFile(slot);
    if (!f) return;
    const aside = path.join(DIR, '_replaced');
    fs.mkdirSync(aside, { recursive: true });
    R.core.renameRetry(f, path.join(aside, `${path.basename(f, path.extname(f))}-${R.core.stamp()}${path.extname(f)}`));
}
function saveLogo(req, slot) {
    return new Promise((resolve, reject) => {
        if (!SLOTS.includes(slot)) return reject(Object.assign(new Error('Unknown logo place.'), { status: 400 }));
        const chunks = []; let size = 0, failed = false;
        req.on('data', (c) => { if (failed) return; size += c.length; if (size > MAX_LOGO) { failed = true; req.pause(); reject(Object.assign(new Error('The logo is larger than 1 MB.'), { status: 413 })); } else chunks.push(c); });
        req.on('error', (e) => { failed = true; reject(e); });
        req.on('end', () => {
            if (failed) return;
            try {
                const buf = Buffer.concat(chunks);
                const kind = kindOf(buf);
                if (!kind) return reject(Object.assign(new Error('The logo must be a PNG, JPEG, WebP, GIF or SVG picture.'), { status: 400 }));
                fs.mkdirSync(DIR, { recursive: true });
                const target = path.join(DIR, slot + kind.ext);
                const tmp = `${target}.${process.pid}.${Date.now()}.part`;
                fs.writeFileSync(tmp, buf, { flag: 'wx' });
                moveAside(slot);
                R.core.renameRetry(tmp, target);
                R.core.lifeLine(`appbrand logo ${slot} ${kind.type} ${buf.length} bytes`);
                resolve(publicInfo());
            } catch (e) { reject(e); }
        });
    });
}
function resetLogo(slot) {
    if (!SLOTS.includes(slot)) throw R.blocks.reqErr('Unknown logo place.');
    moveAside(slot);
    R.core.lifeLine(`appbrand logo ${slot} reset`);
    return publicInfo();
}
// A logo is served with headers that stop a script inside an SVG from running when the file is opened directly.
function sendLogo(res, slot) {
    const f = logoFile(slot);
    if (!f) return false;
    const buf = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': (kindOf(buf) || { type: 'application/octet-stream' }).type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
    res.end(buf);
    return true;
}

R.appbrand = module.exports;
Object.assign(module.exports, { DIR, SLOTS, DEFAULT_NAME, readSettings, publicInfo, writeSettings, saveLogo, resetLogo, sendLogo });
