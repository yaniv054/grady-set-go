// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const R = require('./registry');

// --- release documents ------------------------------------------------------

const CLIP_ID_RE = /^c[0-9a-f]{15}$/;
function docDir(id) {
    if (!CLIP_ID_RE.test(String(id || ''))) throw Object.assign(new Error('bad clip id'), { status: 400 });
    return path.join(R.core.RELEASES_ROOT, id);
}
// Keeps letters (including Hebrew), digits and common punctuation; drops path parts
// and characters Windows forbids. The extension must be an allowed document type.
function safeDocName(name) {
    let n = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC')
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 150);
    const ext = path.extname(n).toLowerCase();
    if (!n || !R.core.DOC_TYPES[ext]) throw Object.assign(new Error(`Allowed document types: ${Object.keys(R.core.DOC_TYPES).join(' ')}`), { status: 400 });
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
    return n;
}
function listDocs(id) {
    const dir = docDir(id);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.filter((e) => e.isFile() && R.core.DOC_TYPES[path.extname(e.name).toLowerCase()]).map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, size: st.size, uploaded: st.mtime.toISOString() };
    }).sort((a, b) => a.uploaded.localeCompare(b.uploaded));
}
// Clip IDs that have at least one document (one directory read, refreshed every 10 s).
let docIndex = { at: 0, counts: new Map() };
function docCounts() {
    if (Date.now() - docIndex.at < 10000) return docIndex.counts;
    const counts = new Map();
    let dirs = [];
    try { dirs = fs.readdirSync(R.core.RELEASES_ROOT, { withFileTypes: true }); } catch { /* none yet */ }
    for (const d of dirs) {
        if (!d.isDirectory() || !CLIP_ID_RE.test(d.name)) continue;
        const n = listDocs(d.name).length;
        if (n) counts.set(d.name, n);
    }
    docIndex = { at: Date.now(), counts };
    return counts;
}
function uniqueName(dir, name) {
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
    return candidate;
}
// Streams the request body to a temp file, then renames it into place.
function saveDoc(req, id, name) {
    return new Promise((resolve, reject) => {
        const dir = docDir(id);
        const clean = safeDocName(name);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.upload-${process.pid}-${Date.now()}.part`);
        const out = fs.createWriteStream(tmp, { flags: 'wx' });
        let size = 0, failed = false;
        // The temp file is removed once its handle is closed (Windows cannot delete an open file).
        const fail = (err) => { if (failed) return; failed = true; if (out.closed) fs.unlink(tmp, () => {}); else { out.once('close', () => fs.unlink(tmp, () => {})); out.destroy(); } reject(err); };
        req.on('data', (c) => {
            size += c.length;
            if (size > R.core.DOC_MAX_BYTES) { fail(Object.assign(new Error(`File is larger than ${R.core.DOC_MAX_BYTES / 1024 / 1024} MB`), { status: 413 })); req.destroy(); }
        });
        req.on('error', fail);
        req.on('close', () => { if (!req.complete) fail(new Error('Upload cancelled')); });
        out.on('error', fail);
        out.on('close', () => {
            if (failed) return;
            try {
                if (!size) throw Object.assign(new Error('Empty file'), { status: 400 });
                const final = uniqueName(dir, clean);
                R.core.renameRetry(tmp, path.join(dir, final));
                docIndex.at = 0;
                resolve({ name: final, size });
            } catch (e) { fs.unlink(tmp, () => {}); reject(e); }
        });
        req.pipe(out);
    });
}
function removeDoc(id, name) {
    const dir = docDir(id);
    const clean = path.basename(String(name || ''));
    if (!clean || clean === '.' || clean === '..' || clean !== name) throw Object.assign(new Error('document not found'), { status: 404 });
    const src = path.join(dir, clean);
    let st = null;
    try { st = fs.statSync(src); } catch { /* not there */ }
    if (!st || !st.isFile()) throw Object.assign(new Error('document not found'), { status: 404 });
    const binDir = path.join(R.core.RELEASES_ROOT, '_removed', id);
    fs.mkdirSync(binDir, { recursive: true });
    const dest = path.join(binDir, `${R.core.stamp()} ${clean}`);
    R.core.renameRetry(src, dest);
    docIndex.at = 0;
    return { moved_to: dest };
}

// --- library rescan -----------------------------------------------------------

const scan = { running: false, started: null, finished: null, progress: '', result: null, error: null };
function startScan() {
    if (scan.running) throw Object.assign(new Error('A library scan is already running.'), { status: 409 });
    if (!fs.existsSync(R.core.SCANNER)) throw Object.assign(new Error(`Scanner not found: ${R.core.SCANNER}`), { status: 404 });
    const before = new Set(R.media.library().keys());
    const hadIds = new Set(R.media.libraryById().keys());
    Object.assign(scan, { running: true, started: new Date().toISOString(), finished: null, progress: 'Starting…', result: null, error: null });
    try { fs.mkdirSync(path.dirname(R.core.SCAN_LOG), { recursive: true }); } catch { /* reported by the stream */ }
    const log = fs.createWriteStream(R.core.SCAN_LOG, { flags: 'a' });
    // The scan log is a convenience: if it cannot be written, the scan still runs.
    let logFailed = false;
    log.on('error', (e) => { if (!logFailed) console.error('scan log', e.message); logFailed = true; });
    log.write(`\r\n=== Rescan from the panel ${scan.started} ===\r\n`);
    const child = spawn(process.execPath, [R.core.SCANNER], { cwd: path.dirname(R.core.SCANNER), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (buf) => {
        const text = buf.toString('utf8');
        log.write(text);
        tail = (tail + text).slice(-4000);
        const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length) scan.progress = lines[lines.length - 1].slice(0, 300);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { scan.running = false; scan.finished = new Date().toISOString(); scan.error = e.message; log.end(); });
    child.on('close', (code) => {
        log.end();
        scan.running = false;
        scan.finished = new Date().toISOString();
        if (code !== 0) { scan.error = `Scanner exited with code ${code}. See ${R.core.SCAN_LOG}.`; return; }
        R.media.libCache.mtime = 0; R.media.libChecked = 0; // force reload
        const after = R.media.library();
        let added = 0, removed = 0;
        for (const k of after.keys()) if (!before.has(k)) added++;
        let moved = 0;
        for (const k of before) {
            if (after.has(k)) continue;
            removed++;
            if (R.media.rowForId(R.media.pathHistory()[k]?.id)) moved++;
        }
        let newClips = 0, newHours = 0;
        for (const [id, rows] of R.media.libraryById()) if (!hadIds.has(id)) { newClips++; newHours += (Number(rows[0].duration_s) || 0) / 3600; }
        const summary = (/Wrote .*$/m.exec(tail) || [''])[0];
        scan.result = { files: after.size, added_files: added, removed_files: removed, moved_files: moved, new_clips: newClips, new_hours: Number(newHours.toFixed(1)), summary };
    });
    return { ...scan };
}

// --- channel logo -------------------------------------------------------------
// Saved in ffplayout storage as 00-assets\channel-logo.png; a previous logo is kept as
// channel-logo-<time>.png. The browser then points ffplayout's logo setting at it.
const LOGO_REL = '00-assets/channel-logo.png';
function saveLogo(req) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0, failed = false;
        req.on('data', (c) => { if (failed) return; size += c.length; if (size > 10 * 1024 * 1024) { failed = true; reject(Object.assign(new Error('Logo is larger than 10 MB'), { status: 413 })); req.destroy(); } else chunks.push(c); });
        req.on('error', (e) => { failed = true; reject(e); });
        req.on('end', () => {
            if (failed) return;
            const buf = Buffer.concat(chunks);
            if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return reject(Object.assign(new Error('The logo must be a PNG file.'), { status: 400 }));
            const file = path.join(R.core.STORAGE_ROOT, ...LOGO_REL.split('/'));
            const tmp = `${file}.${process.pid}.${Date.now()}.part`;
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(tmp, buf, { flag: 'wx' });
                let previous = null;
                if (fs.existsSync(file)) { previous = file.replace(/\.png$/, `-${R.core.stamp()}.png`); R.core.renameRetry(file, previous); }
                R.core.renameRetry(tmp, file);
                resolve({ logo: LOGO_REL, size: buf.length, undo: { replaced: [{ target: file, previous, hash: R.undo.fileHash(file) }] } });
            } catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } reject(e); }
        });
    });
}


// ---- exports (read by the other modules through R.librarytools) ----
R.librarytools = module.exports;
Object.assign(module.exports, { CLIP_ID_RE, docDir, safeDocName, listDocs, docCounts, uniqueName, saveDoc, removeDoc, scan, startScan, LOGO_REL, saveLogo });
Object.defineProperty(module.exports, 'docIndex', { get: () => docIndex, set: (v) => { docIndex = v; }, enumerable: true });
