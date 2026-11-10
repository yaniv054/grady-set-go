// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const R = require('./registry');

// --- branding library -----------------------------------------------------------
// Files live in ffplayout storage: storage\branding\<type>\<file>. Uploads stream to
// disk, are checked against the branding kit spec (picture, frame rate, sound,
// loudness), and replaced or removed files are moved to storage\branding\_replaced or
// _removed, never deleted. Off-air / live-standby slates and the channel logo are fixed
// paths: "Use as …" copies a checked file there and keeps the previous one.
const BRAND_DIR = path.join(R.core.STORAGE_ROOT, 'branding');
const BRAND_TYPES = {
    ident: { kind: 'video', max_s: 10 }, stinger: { kind: 'video', max_s: 3 }, upnext: { kind: 'video', max_s: 15 },
    opener: { kind: 'video', max_s: 15 }, closer: { kind: 'video', max_s: 15 }, promo: { kind: 'video', max_s: 60 },
    countdown: { kind: 'video', max_s: 60 }, advisory: { kind: 'video', max_s: 10 },
    slate: { kind: 'still' }, logo: { kind: 'logo' }, font: { kind: 'font' }, sonic: { kind: 'audio' },
};
const BRAND_EXT = { video: ['.mp4', '.mov'], still: ['.png'], logo: ['.png'], font: ['.ttf', '.otf'], audio: ['.wav'] };
const BRAND_CHECKS = path.join(R.core.DATA_DIR, 'branding-checks.json');
const BRAND_THUMBS = path.join(R.core.THUMB_DIR, 'branding');
const SLATE_TARGETS = { offair: 'offair/offair_1080p.png', live: 'live/live_standby_1080p.png' };
let brandChecks = null;
const brandCheckStore = () => { if (!brandChecks) { try { brandChecks = JSON.parse(fs.readFileSync(BRAND_CHECKS, 'utf8')); } catch { brandChecks = {}; } } return brandChecks; };
function saveBrandChecks() {
    try { R.core.writeJsonAtomic(BRAND_CHECKS, brandChecks || {}); } catch (e) { console.error('branding checks', e.message); }
}
// Branding sets ("sub-branding", e.g. for a memorial day): the Default set is
// storage\branding\<type>\ as before; a named set is storage\branding\_sets\<set>\<type>\.
// Its replaced or removed files go to branding\_replaced\_sets\<set>\<type> and
// branding\_removed\_sets\<set>\<type>, never deleted. "none" is reserved (no branding).
const BRAND_SETS_DIR = path.join(BRAND_DIR, '_sets');
const SET_NAME_RE = /^[\p{L}\p{N} _-]{1,40}$/u;
function checkSetName(v) {
    const s = String(v ?? '').normalize('NFC');
    if (!SET_NAME_RE.test(s) || s !== s.trim() || /\s\s/.test(s) || /^(none|con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) throw Object.assign(new Error('A branding set name has 1–40 letters, digits, spaces, - or _ (and is not "none").'), { status: 400 });
    return s;
}
function listBrandSets() {
    let dirs = [];
    try { dirs = fs.readdirSync(BRAND_SETS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none yet */ }
    const ok = (n) => { try { return checkSetName(n) === n; } catch { return false; } };
    return dirs.filter(ok).sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);
}
// The set's folder name as stored (matched without regard to case): '' = Default, null = no such set.
function findBrandSet(set) {
    if (!set) return '';
    const s = checkSetName(set).toLowerCase();
    return listBrandSets().find((n) => n.toLowerCase() === s) ?? null;
}
function requireBrandSet(set) {
    const s = findBrandSet(set);
    if (s === null) throw Object.assign(new Error(`Branding set "${set}" not found.`), { status: 404 });
    return s;
}
const brandSetDir = (set) => (set ? path.join(BRAND_SETS_DIR, set) : BRAND_DIR);
function createBrandSet(name) {
    const s = checkSetName(String(name ?? '').trim());
    if (findBrandSet(s) !== null) throw Object.assign(new Error(`A branding set "${s}" already exists.`), { status: 409 });
    fs.mkdirSync(path.join(BRAND_SETS_DIR, s), { recursive: true });
    return { name: s, sets: listBrandSets() };
}
// A file inside the branding folder from a "type/name" reference (Default set) or a
// "_sets/<set>/type/name" one ({ type, name, set, rel, file }), or an error. The name must
// have an extension allowed for that type.
function brandPath(rel) {
    const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
    let set = '', rest = parts;
    if (parts[0] === '_sets' && parts.length === 4) {
        set = findBrandSet(parts[1]);
        if (!set) throw Object.assign(new Error('bad branding file'), { status: 400 });
        rest = parts.slice(2);
    }
    const [type, name] = rest;
    const t = BRAND_TYPES[type];
    if (rest.length !== 2 || !t || !name || name === '.' || name === '..' || !BRAND_EXT[t.kind].includes(path.extname(name).toLowerCase())) throw Object.assign(new Error('bad branding file'), { status: 400 });
    return { type, name, set, rel: set ? `_sets/${set}/${type}/${name}` : `${type}/${name}`, file: path.join(brandSetDir(set), type, name) };
}
// Where replaced / removed branding files of a set and type are kept.
const brandAsideDir = (kind, set, type) => (set ? path.join(BRAND_DIR, kind, '_sets', set, type) : path.join(BRAND_DIR, kind, type));
// Checks and video thumbnails run one at a time (each starts ffprobe/ffmpeg).
let brandChain = Promise.resolve();
const brandQueue = (fn) => { const job = brandChain.then(fn); brandChain = job.catch(() => {}); return job; };
// Dates of saved playlists (yesterday on) that play this file; refuses to move it aside if any.
function refuseIfScheduled(file, label) {
    const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase();
    const k = norm(file), dates = [];
    R.attention.forEachSavedPlaylist(R.metadata.yesterday(), (date, pl) => { if ((pl.program || []).some((it) => it && norm(it.source) === k)) dates.push(date); });
    if (dates.length) throw Object.assign(new Error(`${label} is in the saved playlist of ${dates.sort().map(R.metadata.fmtDate).join(', ')}; replace it there first.`), { status: 409 });
}
const brandRel = (full) => path.relative(BRAND_DIR, full).split(path.sep).join('/');
const isBrandSource = (src) => { const low = String(src || '').toLowerCase(); const b = BRAND_DIR.toLowerCase(); return low.startsWith(b + path.sep) || low.startsWith(b + '/'); };
const brandTypeOf = (src) => { if (!isBrandSource(src)) return null; const p = brandRel(src).split('/'); return p[0] === '_sets' ? p[2] || null : p[0]; };

function probeJson(file) {
    return new Promise((resolve, reject) => {
        execFile(R.core.FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
            (err, out) => { if (err) return reject(new Error('ffprobe could not read the file')); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
}
async function loudnessOf(file) {
    const r = await R.attention.runTool('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeout: 10 * 60e3 });
    const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
    const num = (re) => { const m = re.exec(tail); return m ? Number(m[1]) : null; };
    return { lufs: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/), true_peak: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) };
}
const rate = (s) => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : a || 0; };
// Checks one file against the kit spec. errors = will not be used by playlist rules.
async function checkBrandFile(type, file) {
    const t = BRAND_TYPES[type];
    const errors = [], warnings = [], info = {};
    if (t.kind === 'font') { info.name = path.basename(file); return { ok: true, errors, warnings, info }; }
    let p;
    try { p = await probeJson(file); } catch (e) { return { ok: false, errors: [e.message], warnings, info }; }
    const v = (p.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = (p.streams || []).find((s) => s.codec_type === 'audio');
    info.duration = Number(p.format?.duration) || null;
    if (v) Object.assign(info, { width: v.width, height: v.height, codec: v.codec_name, pix_fmt: v.pix_fmt, fps: Number(rate(v.r_frame_rate).toFixed(3)), field_order: v.field_order || '' });
    if (a) Object.assign(info, { audio: a.codec_name, sample_rate: Number(a.sample_rate), channels: a.channels });
    if (t.kind === 'video') {
        if (!v) errors.push('No picture');
        else {
            if (v.width !== 1920 || v.height !== 1080) errors.push(`Picture is ${v.width}×${v.height}; must be 1920×1080`);
            if (Math.abs(rate(v.r_frame_rate) - 25) > 0.01) errors.push(`Frame rate is ${info.fps}; must be 25`);
            if (v.field_order && !['progressive', 'unknown'].includes(v.field_order)) errors.push('Interlaced; must be progressive');
            if (v.codec_name !== 'h264') warnings.push(`Video codec ${v.codec_name}; the playout file should be H.264 MP4`);
            if (v.pix_fmt && v.pix_fmt !== 'yuv420p') warnings.push(`Pixel format ${v.pix_fmt}; should be 4:2:0 (yuv420p)`);
        }
        if (info.duration) {
            const frames = info.duration * 25;
            if (Math.abs(frames - Math.round(frames)) > 0.6) warnings.push('Length is not a whole number of frames');
            if (t.max_s && info.duration > t.max_s + 0.5) warnings.push(`Longer than the ${t.max_s} s in the kit spec`);
        }
        if (!a) warnings.push('No sound track (add a silent one if the asset is meant to be silent)');
        else {
            if (Number(a.sample_rate) !== 48000) warnings.push(`Sound at ${a.sample_rate} Hz; should be 48 kHz`);
            if (a.channels !== 2) warnings.push(`${a.channels} sound channel(s); should be stereo`);
        }
    }
    if (t.kind === 'still') {
        if (!v) errors.push('Not an image');
        else {
            if (v.width !== 1920 || v.height !== 1080) errors.push(`Image is ${v.width}×${v.height}; must be 1920×1080`);
            if (/a/.test(String(v.pix_fmt).replace('gray', ''))) warnings.push('Has transparency; slates should be fully opaque');
        }
    }
    if (t.kind === 'logo') {
        if (!v) errors.push('Not an image');
        else {
            if (v.width > 240 || v.height > 120) warnings.push(`Logo is ${v.width}×${v.height}; the kit spec is at most 240×120`);
            if (!/rgba|ya8|pal8/.test(String(v.pix_fmt))) warnings.push('No transparency (needs a PNG with alpha)');
        }
    }
    if (t.kind === 'audio' && a && Number(a.sample_rate) !== 48000) warnings.push(`Sound at ${a.sample_rate} Hz; should be 48 kHz`);
    if (a && (t.kind === 'video' || t.kind === 'audio')) {
        try {
            const l = await loudnessOf(file);
            Object.assign(info, l);
            if (l.lufs !== null && Number.isFinite(l.lufs) && (l.lufs < -15 || l.lufs > -13)) warnings.push(`Loudness ${l.lufs} LUFS; the kit spec is −14 (±1)`);
            if (l.true_peak !== null && l.true_peak > -1) warnings.push(`Peak ${l.true_peak} dBFS; should be −1 or lower`);
        } catch { warnings.push('Loudness could not be measured'); }
    }
    return { ok: !errors.length, errors, warnings, info };
}
// Cached check for a file (re-run when the file changes).
const brandChecking = new Map();
function brandCheck(type, file, st) {
    const rel = brandRel(file), store = brandCheckStore(), c = store[rel];
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.result;
    if (!brandChecking.has(rel)) {
        brandChecking.set(rel, brandQueue(() => checkBrandFile(type, file))
            .then((result) => { store[rel] = { size: st.size, mtime: st.mtimeMs, result }; saveBrandChecks(); return result; })
            .finally(() => brandChecking.delete(rel)));
    }
    return null;
}
// Files of one branding type (of one set; '' = Default) with their (cached) check.
function listBrandType(type, set = '') {
    const t = BRAND_TYPES[type];
    const cmp = new Intl.Collator(undefined, { numeric: true }).compare;
    const dir = path.join(brandSetDir(set), type);
    const prefix = set ? `_sets/${set}/${type}` : type;
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => BRAND_EXT[t.kind].includes(path.extname(n).toLowerCase())); } catch { /* none yet */ }
    return names.sort(cmp).map((n) => {
        const full = path.join(dir, n);
        let st; try { st = fs.statSync(full); } catch { return null; }
        if (!st.isFile()) return null;
        const check = brandCheck(type, full, st);
        return { rel: `${prefix}/${n}`, name: n, source: full, size: st.size, mtime: st.mtimeMs, check, checking: !check };
    }).filter(Boolean);
}
function listBranding(set = '') {
    const out = {};
    for (const type of Object.keys(BRAND_TYPES)) out[type] = listBrandType(type, set);
    const inUse = {};
    for (const [k, rel] of Object.entries(SLATE_TARGETS)) { try { inUse[k] = fs.statSync(path.join(R.core.STORAGE_ROOT, ...rel.split('/'))).mtimeMs; } catch { inUse[k] = null; } }
    return { types: out, kinds: Object.fromEntries(Object.entries(BRAND_TYPES).map(([k, t]) => [k, t.kind])), slates: SLATE_TARGETS, in_use: inUse, set, sets: listBrandSets() };
}
// Playable assets of one type for the playlist rules: checked, without errors, with a length.
// set: '' = Default, 'none' = nothing, otherwise a named set (a set without that type,
// or a set that does not exist, gives nothing: no fallback to the Default set).
function brandPool(type, set = '') {
    if (set === 'none') return [];
    const s = set ? findBrandSet(set) : '';
    const list = BRAND_TYPES[type] && s !== null ? listBrandType(type, s) : [];
    return list.filter((x) => x.check && x.check.ok && x.check.info.duration > 0).map((x) => ({ source: x.source, duration: x.check.info.duration, name: x.name }));
}
function saveBrandUpload(req, type, name, set = '') {
    return new Promise((resolve, reject) => {
        const t = BRAND_TYPES[type];
        if (!t) return reject(Object.assign(new Error('Unknown branding type'), { status: 400 }));
        try { set = requireBrandSet(set); } catch (e) { return reject(e); }
        const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 140);
        const ext = path.extname(base).toLowerCase();
        if (!base || !BRAND_EXT[t.kind].includes(ext)) return reject(Object.assign(new Error(`${type} takes ${BRAND_EXT[t.kind].join(', ')} files`), { status: 400 }));
        const dir = path.join(brandSetDir(set), type);
        const file = path.join(dir, base), label = set ? `${set}: ${type}/${base}` : `${type}/${base}`;
        // A file that would be replaced while a saved playlist still plays it: refused before
        // anything is received (and checked again before replacing).
        try { if (fs.existsSync(file)) refuseIfScheduled(file, label); } catch (e) { return reject(e); }
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.part`;
        const ws = fs.createWriteStream(tmp, { flags: 'wx' });
        let size = 0, failed = false;
        const unlinkTmp = () => { try { fs.unlinkSync(tmp); } catch { /* none */ } };
        // The temp file is removed once its handle is closed (Windows cannot delete an open file).
        const fail = (e) => { if (failed) return; failed = true; if (ws.closed) unlinkTmp(); else { ws.once('close', unlinkTmp); ws.destroy(); } reject(e); };
        req.on('data', (c) => { size += c.length; if (size > 4 * 1024 ** 3) { req.destroy(); fail(Object.assign(new Error('File is larger than 4 GB'), { status: 413 })); } });
        req.on('error', fail);
        req.on('close', () => { if (!req.complete) fail(new Error('Upload cancelled')); });
        ws.on('error', fail);
        ws.on('close', async () => {
            if (failed) return;
            try {
                // Checked before it replaces anything.
                const result = await brandQueue(() => checkBrandFile(type, tmp));
                if (result.info && result.info.name) result.info.name = base;
                let previous = null;
                if (fs.existsSync(file)) {
                    refuseIfScheduled(file, label);
                    const old = brandAsideDir('_replaced', set, type);
                    fs.mkdirSync(old, { recursive: true });
                    previous = path.join(old, base.replace(/(\.[^.]+)$/, `-${R.core.stamp()}$1`));
                    R.core.renameRetry(file, previous);
                }
                R.core.renameRetry(tmp, file);
                // Undo: a new file is moved aside (to _removed); a replaced one gets its previous version back.
                const undoRec = { replaced: [{ target: file, previous, hash: R.undo.fileHash(file), aside: brandAsideDir(previous ? '_replaced' : '_removed', set, type) }] };
                const st = fs.statSync(file);
                brandCheckStore()[brandRel(file)] = { size: st.size, mtime: st.mtimeMs, result };
                saveBrandChecks();
                resolve({ rel: brandRel(file), name: base, size: st.size, check: result, undo: undoRec });
            } catch (e) { failed = true; unlinkTmp(); reject(e); }
        });
        req.pipe(ws);
    });
}
function removeBrandFile(rel) {
    const b = brandPath(rel);
    if (!fs.existsSync(b.file)) throw Object.assign(new Error('File not found'), { status: 404 });
    refuseIfScheduled(b.file, b.rel);
    const dir = brandAsideDir('_removed', b.set, b.type);
    fs.mkdirSync(dir, { recursive: true });
    const to = path.join(dir, b.name.replace(/(\.[^.]+)$/, `-${R.core.stamp()}$1`));
    R.core.renameRetry(b.file, to);
    return { removed: b.rel, undo: { moves: [{ from: b.file, to }] } };
}
// Copies a checked slate or logo to the fixed path the playout uses; the old file is kept.
function useBrandFile(rel, as) {
    const { file, type, rel: key, set } = brandPath(rel);
    // Off-air / live standby / channel logo come from the Default set only.
    if (set) throw Object.assign(new Error('Only files of the Default set can be used as the off-air or live-standby slate or the channel logo. Upload it to the Default set first.'), { status: 400 });
    if (!fs.existsSync(file)) throw Object.assign(new Error('File not found'), { status: 404 });
    const c = brandCheckStore()[key]?.result;
    let target;
    if (as === 'logo') { if (type !== 'logo') throw Object.assign(new Error('Only a logo can be the channel logo'), { status: 400 }); target = path.join(R.core.STORAGE_ROOT, ...R.librarytools.LOGO_REL.split('/')); }
    else if (SLATE_TARGETS[as]) {
        if (type !== 'slate') throw Object.assign(new Error('Only a slate can be used here'), { status: 400 });
        if (!c || !c.ok) throw Object.assign(new Error('This slate did not pass the check (it must be a 1920×1080 PNG)'), { status: 400 });
        target = path.join(R.core.STORAGE_ROOT, ...SLATE_TARGETS[as].split('/'));
    } else throw Object.assign(new Error('unknown use'), { status: 400 });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let previous = null;
    if (fs.existsSync(target)) { previous = target.replace(/(\.[^.]+)$/, `-${R.core.stamp()}$1`); R.core.renameRetry(target, previous); }
    fs.copyFileSync(file, target);
    return { used: key, as, target: path.relative(R.core.STORAGE_ROOT, target), undo: { replaced: [{ target, previous, hash: R.undo.fileHash(target) }] } };
}
// Thumbnail for a branding file: the image itself, or one frame of a video (cached).
const brandThumbJobs = new Map();
async function brandThumb(ref) {
    const { file, rel } = brandPath(ref);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png') return { file, type: 'image/png' };
    if (!BRAND_EXT.video.includes(ext)) return null;
    const st = fs.statSync(file);
    const out = path.join(BRAND_THUMBS, crypto.createHash('sha1').update(`${rel}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20) + '.jpg');
    if (!fs.existsSync(out)) {
        // One job per file; repeated requests share it.
        if (!brandThumbJobs.has(rel)) {
            brandThumbJobs.set(rel, brandQueue(async () => {
                if (fs.existsSync(out)) return true;
                fs.mkdirSync(BRAND_THUMBS, { recursive: true });
                const dur = brandCheckStore()[rel]?.result?.info?.duration || 2;
                const r = await R.attention.runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-ss', Math.min(1, dur / 2).toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', out], { timeout: 60000 });
                return r.code === 0 && fs.existsSync(out);
            }).finally(() => brandThumbJobs.delete(rel)));
        }
        if (!(await brandThumbJobs.get(rel))) return null;
    }
    return { file: out, type: 'image/jpeg' };
}
// Playlist rules for branding (data\branding-rules.json).
const BRAND_RULES_FILE = path.join(R.core.DATA_DIR, 'branding-rules.json');
const BRAND_RULES_DEFAULTS = { hourly_ident: true, ident_every_min: 20, stingers: true, stinger_max_clip_min: 10, upnext_min_clip_min: 20, concert_wrap: true, advisory: true, explicit_after: '' };
const readBrandRules = () => { try { return { ...BRAND_RULES_DEFAULTS, ...JSON.parse(fs.readFileSync(BRAND_RULES_FILE, 'utf8')) }; } catch { return { ...BRAND_RULES_DEFAULTS }; } };
function writeBrandRules(input) {
    const r = { ...readBrandRules(), ...(input || {}) };
    const num = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
    const out = {
        hourly_ident: !!r.hourly_ident, ident_every_min: num(r.ident_every_min, 0, 240, 20), stingers: !!r.stingers,
        stinger_max_clip_min: num(r.stinger_max_clip_min, 1, 60, 10), upnext_min_clip_min: num(r.upnext_min_clip_min, 0, 240, 20),
        concert_wrap: !!r.concert_wrap, advisory: !!r.advisory,
        explicit_after: /^\d{1,2}:\d{2}$/.test(String(r.explicit_after || '').trim()) ? String(r.explicit_after).trim() : '',
    };
    R.core.writeJsonAtomic(BRAND_RULES_FILE, out, 1);
    return out;
}


// ---- exports (read by the other modules through R.branding) ----
R.branding = module.exports;
Object.assign(module.exports, { BRAND_DIR, BRAND_TYPES, BRAND_EXT, BRAND_CHECKS, BRAND_THUMBS, SLATE_TARGETS, brandCheckStore, saveBrandChecks, BRAND_SETS_DIR, SET_NAME_RE, checkSetName, listBrandSets, findBrandSet, requireBrandSet, brandSetDir, createBrandSet, brandPath, brandAsideDir, brandQueue, refuseIfScheduled, brandRel, isBrandSource, brandTypeOf, probeJson, loudnessOf, rate, checkBrandFile, brandChecking, brandCheck, listBrandType, listBranding, brandPool, saveBrandUpload, removeBrandFile, useBrandFile, brandThumbJobs, brandThumb, BRAND_RULES_FILE, BRAND_RULES_DEFAULTS, readBrandRules, writeBrandRules });
Object.defineProperty(module.exports, 'brandChecks', { get: () => brandChecks, set: (v) => { brandChecks = v; }, enumerable: true });
Object.defineProperty(module.exports, 'brandChain', { get: () => brandChain, set: (v) => { brandChain = v; }, enumerable: true });
