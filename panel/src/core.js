// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const R = require('./registry');









const cfg = require('../config');
const PORT = cfg.port;
const HOST = '127.0.0.1';
const UPSTREAM = new URL(cfg.engineUrl);
const ROOT = path.resolve(__dirname, '..');   // the panel folder (this file is in panel/src)
const STATE_FILE = process.env.PANEL_STATE || path.join(ROOT, 'state.json');
const LIBRARY_CSV = cfg.libraryCsv;
const PROXY_PREFIXES = ['/api/', '/auth/', '/public/', '/data/', '/file/'];
// Media share: READ-ONLY (policy decided 2026-11-01). The panel, the scanner and every
// analyzer only list and probe files here; nothing creates, writes, renames, moves,
// copies or deletes anything under this root. Clean titles live in clip-metadata.json,
// never in the file name. startAnalysis refuses the former "rename" check.
const MEDIA_ROOT = (cfg.mediaRoot ? path.resolve(cfg.mediaRoot).replace(/[\\/]+$/, '') : '');
const FFPROBE = cfg.ffprobe;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.mkv', '.m4v', '.avi', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.webm', '.wmv', '.flv']);
const SKIP_DIRS = new Set(['@recycle', '#recycle', '$recycle.bin', '.@__thumb', '@eadir']);
// NAS system folders (snapshots, recycle bins, thumbnails) start with one of these.
const isSystemDir = (name) => SKIP_DIRS.has(name.toLowerCase()) || /^[.@#$]/.test(name);
const STORAGE_ROOT = path.resolve(cfg.storageRoot);
const VLC = cfg.vlc;
const LOG_FILE = cfg.logFile;
// ffplayout engine logs (read-only) and the panel's own as-run archive.
const ENGINE_LOG_DIR = path.resolve(cfg.logsDir);
const DATA_DIR = path.resolve(cfg.dataDir);
const ASRUN_DIR = path.join(DATA_DIR, 'asrun');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const FEED_DIR = path.join(DATA_DIR, 'feed');
const AUTOMATION_FILE = path.join(DATA_DIR, 'automation.json');
// A fresh install has none of these folders yet: create them before anything is written.
for (const dir of [path.dirname(LOG_FILE), DATA_DIR, ENGINE_LOG_DIR]) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported when a write fails */ } }
const SECRETS_FILE = path.join(DATA_DIR, 'panel-secrets.json');
// Overnight analysis (tools\deep-scan.js): results, progress and the stop request.
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');
const ANALYSIS_RESULTS = path.join(ANALYSIS_DIR, 'results.jsonl');
const ANALYSIS_STATUS = path.join(ANALYSIS_DIR, 'status.json');
const ANALYSIS_STOP = path.join(ANALYSIS_DIR, 'STOP');
const DEEP_SCAN = cfg.deepScan;
// Thumbnails: data\thumbs\<clip id>.jpg, made by tools\analyzers\thumb.js (overnight or on demand).
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const PLAYLISTS_DIR = cfg.playlistsDir;
const FFMPEG_DIR = process.env.PANEL_FFMPEG_BIN || path.dirname(FFPROBE);
const DEEP_SCAN_LOG = cfg.deepScanLog;
const PUBLIC_ROOT = path.resolve(cfg.publicRoot);
const PREVIEW_EXT = new Set(['.m3u8', '.ts', '.m4s', '.vtt']);
// Clip metadata lives on this PC, never on the share. Each write keeps the previous
// file as .bak; imports and bulk edits also keep a timestamped copy in meta-backups.
const META_FILE = cfg.metaFile;
const META_BACKUPS = path.join(path.dirname(META_FILE), 'meta-backups');
// Release documents per clip: <RELEASES_ROOT>\<clip id>\<file>. "Remove" moves a file to
// <RELEASES_ROOT>\_removed\<clip id>\ instead of deleting it.
const RELEASES_ROOT = path.resolve(process.env.PANEL_RELEASES || path.join(path.dirname(META_FILE), 'releases'));
const DOC_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain; charset=utf-8',
    '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook' };
const DOC_INLINE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt']);
const DOC_MAX_BYTES = 50 * 1024 * 1024;
// Library rescan: runs the existing scanner (read-only on the share; it writes library.csv only).
const SCANNER = cfg.scanner;
const SCAN_LOG = cfg.scanLog;

// Remove leftover HLS preview files (only HLS file types, only under PUBLIC_ROOT).
async function cleanPreview() {
    let removed = 0;
    async function walk(dir) {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (e.isFile() && PREVIEW_EXT.has(path.extname(e.name).toLowerCase())) {
                try { await fs.promises.unlink(full); removed++; } catch { /* in use: skip */ }
            }
        }
    }
    await walk(PUBLIC_ROOT);
    return { removed };
}

const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/help.js': ['help.js', 'text/javascript; charset=utf-8'],
    '/vendor/hls.min.js': ['vendor/hls.min.js', 'text/javascript; charset=utf-8'],   // hls.js 1.5.20 (Apache-2.0), bundled: no CDN
    '/vendor/hls.js-LICENSE.txt': ['vendor/hls.js-LICENSE.txt', 'text/plain; charset=utf-8'],
};

const DEFAULT_STATE = {
    activeProfile: 'preview',
    profiles: {
        'yt-test': { label: 'YouTube TEST (personal)', server: 'rtmp://a.rtmp.youtube.com/live2' },
        'yt-prod': { label: 'YouTube PRODUCTION', server: 'rtmp://a.rtmp.youtube.com/live2' },
    },
};

// File name time stamp, e.g. 2026-10-11T14-05-09.
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// Windows: antivirus or the indexer can hold a just-written file for a moment, so a
// rename that fails with EPERM/EBUSY/EACCES is retried with a short, growing wait.
// The wait is synchronous (the callers rely on the store being on disk when they return),
// so it is kept short: at most 50+100+150+200+250 = 750 ms, and only when a file is held.
// Each wait is counted in renameRetry.stalls so the cost shows up in /local/system/status.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(from, to) {
    for (let i = 0; ; i++) {
        try { return fs.renameSync(from, to); }
        catch (e) {
            if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
            renameRetry.stalls++; renameRetry.stallMs += 50 * (i + 1);
            sleepSync(50 * (i + 1));
        }
    }
}
renameRetry.stalls = 0; renameRetry.stallMs = 0;
// Writes text to a temp file, then renames it into place (never a half-written file).
function writeTextAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // Flushed to disk before the rename, so a power cut cannot leave an empty or partial file.
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { renameRetry(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
function writeJsonAtomic(file, obj, space) { writeTextAtomic(file, JSON.stringify(obj, null, space)); }

// panel.log over 10 MB is renamed to panel.log.1 (older copies shift to .2 and .3;
// the oldest .3 is replaced). Checked at start and hourly.
function rotateLog() {
    try {
        if (fs.statSync(LOG_FILE).size <= 10 * 1024 * 1024) return;
        for (const i of [2, 1]) { try { renameRetry(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch { /* none yet */ } }
        renameRetry(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* no log yet, or busy: next hour */ }
}
rotateLog();
setInterval(rotateLog, 3600e3).unref();

// Record why the panel stops (a crash or a normal exit). A process killed from outside
// (Task Manager, restart-panel.ps1) leaves no line: that absence is the answer.
function lifeLine(text) { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} PANEL ${text}\n`); } catch { /* log unavailable */ } }
process.on('uncaughtException', (e) => { lifeLine(`CRASH ${e && e.stack || e}`); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { lifeLine(`UNHANDLED REJECTION ${e && e.stack || e}`); console.error(e); });
process.on('exit', (code) => lifeLine(`exit code ${code}`));
lifeLine(`start pid ${process.pid} node ${process.version}`);

function log(req, status) {
    // Path only: query strings and bodies are never logged.
    const p = req.url.split('?')[0];
    const line = `${new Date().toISOString()} ${req.method} ${p} ${status}`;
    console.log(line);
    // Appended (not truncated on restart) so earlier requests survive a restart.
    // Status polls (every few seconds) stay out of the file unless they fail.
    if (status >= 400 || !/\/media\/current$|\/process$|\/api\/system\/|^\/local\/library\/rescan$|^\/local\/analysis$|^\/local\/meta\/list$|^\/local\/attention\/count$|^\/local\/capture\/(status|preview|preview\.jpg)$/.test(p)) fs.appendFile(LOG_FILE, line + '\n', () => {});
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    // A reply already under way (e.g. a failed download) cannot change status: drop the connection.
    if (res.headersSent) { res.destroy(); return; }
    // An action recorded for undo: the entry is written now and named in X-Undo-Id.
    if (res.undoCtx) R.undo.undoFinish(res, status);
    // 413: the rest of the upload is not read, so the connection is closed after the reply.
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}) });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
    // Already read before routing (actions recorded for undo).
    if (req._bodyText !== undefined) return req._bodyText.length > limit ? Promise.reject(Object.assign(new Error('The request is too large.'), { status: 413 })) : Promise.resolve(req._bodyText);
    return new Promise((resolve, reject) => {
        let size = 0, over = false;
        const chunks = [];
        req.on('data', (c) => {
            if (over) return;
            size += c.length;
            if (size > limit) { over = true; chunks.length = 0; req.pause(); reject(Object.assign(new Error('The request is too large.'), { status: 413 })); }
            else chunks.push(c);
        });
        req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
        req.on('error', reject);
    });
}
// Request body as a JSON object (400 if it is not one).
async function parseJsonBody(req, limit) {
    const text = await readBody(req, limit);
    let j;
    try { j = JSON.parse(text); } catch { throw Object.assign(new Error('The request is not valid JSON.'), { status: 400 }); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw Object.assign(new Error('The request must be a JSON object.'), { status: 400 });
    return j;
}


// ---- exports (read by the other modules through R.core) ----
R.core = module.exports;
Object.assign(module.exports, { cfg, PORT, HOST, UPSTREAM, ROOT, STATE_FILE, LIBRARY_CSV, PROXY_PREFIXES, MEDIA_ROOT, FFPROBE, VIDEO_EXT, SKIP_DIRS, isSystemDir, STORAGE_ROOT, VLC, LOG_FILE, ENGINE_LOG_DIR, DATA_DIR, ASRUN_DIR, TEMPLATES_FILE, FEED_DIR, AUTOMATION_FILE, SECRETS_FILE, ANALYSIS_DIR, ANALYSIS_RESULTS, ANALYSIS_STATUS, ANALYSIS_STOP, DEEP_SCAN, THUMB_DIR, PLAYLISTS_DIR, FFMPEG_DIR, DEEP_SCAN_LOG, PUBLIC_ROOT, PREVIEW_EXT, META_FILE, META_BACKUPS, RELEASES_ROOT, DOC_TYPES, DOC_INLINE, DOC_MAX_BYTES, SCANNER, SCAN_LOG, cleanPreview, STATIC, DEFAULT_STATE, stamp, sleepSync, renameRetry, writeTextAtomic, writeJsonAtomic, rotateLog, lifeLine, log, send, readBody, parseJsonBody });
