// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Overnight library analysis for Grady Set Go - Playout App.
//
// READ-ONLY on the media share: ffmpeg only reads the files and writes to the null
// muxer. Results are appended to C:\Playout\data\analysis\results.jsonl (one line per
// clip and check), progress is written to status.json. The run stops cleanly when
// data\analysis\STOP appears (the panel's Stop button creates it), at the --until time,
// or when every queued clip is done. A stopped run loses only the clip in progress.
//
//   node deep-scan.js [--mode new|all] [--checks audio,video,meta] [--until 07:00] [--jobs 1]
//                     [--ids-file queue.json] [--threads N] [--credits]
//
// --threads   CPU threads for the Timed text check (whisper; default half of the CPU threads)
// --credits   after Timed text, look up the credits of the songs found (MusicBrainz, then Wikidata)
//
// --mode new  checks clips that have no result yet for a check (or an older check version);
//             a check that failed is tried again, up to 3 failures in a row per clip and version
// --mode all  checks everything again
// --ids-file  JSON list of clip IDs: only those clips (with --mode new, only the checks they still need)
//
// Checks are modules in tools\analyzers\*.js exporting { id, version, label, run(ctx) }.
// run() returns a plain object (with an optional `flags` array) or throws. New checks
// (for example song or artist recognition) are added by dropping in another module.

'use strict';
const cfg = require('../panel/config');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA = path.resolve(opt('--data', cfg.dataDir));
const DIR = path.join(DATA, 'analysis');
const LIBRARY = opt('--library', cfg.libraryCsv);
const BIN = opt('--bin', path.dirname(cfg.ffprobe));
const MODE = opt('--mode', 'new') === 'all' ? 'all' : 'new';
const UNTIL = opt('--until', '');
const JOBS = Math.max(1, Math.min(4, Number(opt('--jobs', 1)) || 1));
const ONLY = String(opt('--checks', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const IDS_FILE = opt('--ids-file', '');
const PLAYLISTS = opt('--playlists', cfg.playlistsDir);
const THREADS = Math.max(0, Number(opt('--threads', 0)) || 0);
const CREDITS = args.includes('--credits');
let ONLY_IDS = null;   // read at startup (main): an unreadable --ids-file ends the run with reason "error"
const RESULTS = path.join(DIR, 'results.jsonl');
const STATUS = path.join(DIR, 'status.json');
const STOP = path.join(DIR, 'STOP');

// Run below normal priority so playout keeps the CPU. Child processes inherit it on
// Windows; it is also set on each child explicitly.
const LOW = os.constants.priority.PRIORITY_BELOW_NORMAL;
try { os.setPriority(0, LOW); } catch { /* not permitted: run at normal priority */ }

const exe = (name) => {
    const p = path.join(BIN, name + (process.platform === 'win32' ? '.exe' : ''));
    return fs.existsSync(p) ? p : name;
};

// --- library.csv ---------------------------------------------------------------
function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
        else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
        else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const [head, ...data] = rows.filter((r) => r.length > 1 || r[0]);
    return head ? data.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^\uFEFF/, ''), r[i] ?? '']))) : [];
}
// Same clip ID as the panel: content fingerprint, not path. Must stay identical to
// clipId() in panel\server.js (and parseCsv above to its parseCsv).
const clipId = (r) => 'c' + crypto.createHash('sha1').update(`${r.size_bytes}:${Number(r.duration_s || 0).toFixed(3)}`).digest('hex').slice(0, 15);

// --- results ---------------------------------------------------------------------
// id|analyzer -> version that needs no new run: the latest line is a result, or the
// check failed MAX_FAILS times in a row for that version (a broken file is not retried
// forever). Other failed checks are tried again in mode "new".
const MAX_FAILS = 3;
function readDone() {
    const state = new Map();
    let text = '';
    try { text = fs.readFileSync(RESULTS, 'utf8'); } catch { return new Map(); }
    for (const line of text.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; /* partial line */ }
        if (!e || !e.id || !e.analyzer) continue;
        const key = `${e.id}|${e.analyzer}`, prev = state.get(key);
        if (e.error === undefined || e.error === null) state.set(key, { version: e.version, fails: 0 });
        else state.set(key, { version: e.version, fails: prev && prev.version === e.version && prev.fails > 0 ? prev.fails + 1 : 1 });
    }
    const done = new Map();
    for (const [key, st] of state) if (st.fails === 0 || st.fails >= MAX_FAILS) done.set(key, st.version);
    return done;
}
// Appends one line; retried briefly when the file is locked (EPERM/EBUSY on Windows,
// e.g. while the panel or a virus scanner reads it). Throws if it still fails.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function append(obj) {
    const line = JSON.stringify(obj) + '\n';
    for (let i = 0; ; i++) {
        try { fs.appendFileSync(RESULTS, line, 'utf8'); return; } catch (e) {
            if (i >= 9 || !(e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) throw e;
            sleepSync(200 * (i + 1));
        }
    }
}
// A previous run that was killed mid-write can leave a partial last line: start on a new line.
function endWithNewline() {
    try {
        const fd = fs.openSync(RESULTS, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            if (!size) return;
            const b = Buffer.alloc(1);
            fs.readSync(fd, b, 0, 1, size - 1);
            if (b[0] === 0x0a) return;
        } finally { fs.closeSync(fd); }
        fs.appendFileSync(RESULTS, '\n', 'utf8');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

let lastStatus = {};
function writeStatus(patch) {
    lastStatus = { ...lastStatus, ...patch, updated: new Date().toISOString() };
    const tmp = STATUS + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(lastStatus, null, 1), 'utf8'); fs.renameSync(tmp, STATUS); } catch { /* reader busy: next update */ }
}

// --- stopping ------------------------------------------------------------------------
let stopping = null;
const children = new Set();
function untilTime() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(UNTIL.trim());
    if (!m) return null;
    const t = new Date(); t.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t.getTime();
}
const UNTIL_AT = untilTime();
function stop(reason) {
    if (stopping) return;
    stopping = reason;
    for (const ch of children) { try { ch.kill(); } catch { /* gone */ } }
}
setInterval(() => {
    if (fs.existsSync(STOP)) stop('stopped');
    else if (UNTIL_AT && Date.now() >= UNTIL_AT) stop('until');
}, 2000).unref();
process.on('SIGINT', () => stop('stopped'));
process.on('SIGTERM', () => stop('stopped'));

// Runs ffmpeg/ffprobe, collecting stderr (and stdout). Rejects if the run is stopped.
function run(bin, argv, { timeout = 60 * 60e3 } = {}) {
    return new Promise((resolve, reject) => {
        if (stopping) return reject(new Error('stopped'));
        const ch = spawn(exe(bin), argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(ch);
        try { os.setPriority(ch.pid, LOW); } catch { /* inherited or not permitted */ }
        let out = '', err = '';
        ch.stdout.on('data', (d) => { if (out.length < 4e6) out += d; });
        ch.stderr.on('data', (d) => { err += d; if (err.length > 8e6) err = err.slice(-4e6); });
        const timer = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, timeout);
        ch.on('error', (e) => { clearTimeout(timer); children.delete(ch); reject(e); });
        ch.on('close', (code) => {
            clearTimeout(timer);
            children.delete(ch);
            if (stopping) return reject(new Error('stopped'));
            resolve({ code, stdout: out, stderr: err });
        });
    });
}

// --- main ------------------------------------------------------------------------------
(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    try { fs.unlinkSync(STOP); } catch { /* none */ }
    const analyzers = fs.readdirSync(path.join(__dirname, 'analyzers'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => require(path.join(__dirname, 'analyzers', f)))
        // Opt-in checks run only when named in --checks. Modules without `run` (the removed
        // "rename" check: the share is read-only) are never executed, however they are named.
        .filter((a) => a && a.id && typeof a.run === 'function' && !a.removed && (ONLY.length ? ONLY.includes(a.id) : !a.optIn))
        .sort((x, y) => (x.order ?? 50) - (y.order ?? 50));
    const started = new Date().toISOString();
    if (IDS_FILE) {
        let ids;
        try { ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch (e) { ids = e; }
        if (!Array.isArray(ids)) {
            const msg = `Cannot use --ids-file ${IDS_FILE}: ${ids instanceof Error ? ids.message : 'not a JSON list of clip IDs'}`;
            writeStatus({ running: false, pid: process.pid, mode: MODE, started, finished: new Date().toISOString(), reason: 'error', error: msg.slice(0, 300),
                total: 0, done: 0, failed: 0, renamed: 0, current: [], eta_s: null, until: UNTIL || null });
            console.error(msg);
            process.exit(1);
        }
        ONLY_IDS = new Set(ids.map(String));
    }
    endWithNewline();
    writeStatus({ running: true, pid: process.pid, mode: MODE, threads: THREADS || null, credits: CREDITS, checks: analyzers.map((a) => a.id), versions: Object.fromEntries(analyzers.map((a) => [a.id, a.version])),
        renamed: 0, until: UNTIL || null, targeted: ONLY_IDS ? ONLY_IDS.size : null, started, finished: null, reason: null, total: 0, done: 0, failed: 0, current: [], eta_s: null, avg_s: null });

    const rows = parseCsv(fs.readFileSync(LIBRARY, 'utf8'));
    // Files renamed by an earlier run, before library.csv was rescanned: use the new name.
    const moved = new Map();
    try {
        for (const l of fs.readFileSync(path.join(DIR, 'renames.jsonl'), 'utf8').split('\n')) {
            try { const e = JSON.parse(l); moved.set(e.from.toLowerCase(), e.to); } catch { /* blank/partial */ }
        }
    } catch { /* no renames yet */ }
    const clips = new Map();
    for (const r of rows) {
        if (!r.path || Number(r.duration_s) < 1) continue;
        for (let i = 0, k = r.path.toLowerCase(); moved.has(k) && i < 20; i++, k = r.path.toLowerCase()) {
            const to = moved.get(k);
            if (!fs.existsSync(to)) break;
            r.path = to; r.file = path.basename(to);
        }
        const id = clipId(r);
        if (!clips.has(id)) clips.set(id, { id, row: r, rows: [] });
        clips.get(id).rows.push(r);
    }
    // Selected clips (--ids-file) follow the mode too: "new" runs only the checks they still need.
    const done = MODE === 'all' ? new Map() : readDone();
    const queue = [];
    for (const c of clips.values()) {
        if (ONLY_IDS && !ONLY_IDS.has(c.id)) continue;
        const todo = analyzers.filter((a) => done.get(`${c.id}|${a.id}`) !== a.version);
        if (todo.length) queue.push({ ...c, todo });
    }
    console.log(`${new Date().toISOString()} deep scan: mode ${MODE}, checks ${analyzers.map((a) => a.id).join(',')}, ${queue.length} of ${clips.size} clips to check` + (UNTIL ? `, stop at ${UNTIL}` : ''));
    let finished = 0, failed = 0, renamed = 0;
    const total = queue.length, times = [], current = new Map();
    writeStatus({ total, clips: clips.size, targeted: ONLY_IDS ? ONLY_IDS.size : null });

    async function worker(n) {
        while (queue.length && !stopping) {
            const c = queue.shift();
            current.set(n, c.row.path);
            writeStatus({ current: [...current.values()] });
            const t0 = Date.now();
            let ok = true;
            for (const a of c.todo) {
                if (stopping) { ok = false; break; }
                try {
                    const t1 = Date.now();
                    const result = await a.run({ file: c.row.path, row: c.row, rows: c.rows, run, id: c.id, dataDir: DATA, playlistsDir: PLAYLISTS, force: MODE === 'all', runId: started,
                        libraryCsv: LIBRARY, threads: THREADS, lookupCredits: CREDITS, isStopping: () => !!stopping });
                    const secs = Math.round((Date.now() - t1) / 100) / 10;
                    if (result && result.renamed && result.renamed.length) { renamed += result.renamed.length; writeStatus({ renamed }); }
                    // "Try again next run" (e.g. a clip skipped because it is scheduled): not recorded.
                    if (result && result.retry) continue;
                    append({ id: c.id, path: c.row.path, analyzer: a.id, version: a.version, at: new Date().toISOString(), secs, result });
                } catch (e) {
                    if (stopping) { ok = false; break; }
                    failed++;
                    try {
                        append({ id: c.id, path: c.row.path, analyzer: a.id, version: a.version, at: new Date().toISOString(), error: String(e && e.message || e).slice(0, 300) });
                    } catch (e2) { console.log(`${new Date().toISOString()} could not record the failure in ${RESULTS}: ${e2.code || e2.message}`); }
                    console.log(`${new Date().toISOString()} ${a.id} failed: ${c.row.path}: ${String(e && e.message || e).slice(0, 200)}`);
                }
            }
            current.delete(n);
            if (!ok) break;
            finished++;
            times.push((Date.now() - t0) / 1000);
            const recent = times.slice(-50);
            const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
            writeStatus({ done: finished, failed, current: [...current.values()], avg_s: Number(avg.toFixed(1)), eta_s: Math.round((avg * (total - finished)) / JOBS) });
        }
    }
    await Promise.all(Array.from({ length: JOBS }, (_, i) => worker(i)));
    const reason = stopping || 'complete';
    writeStatus({ running: false, finished: new Date().toISOString(), reason, current: [], done: finished, failed });
    try { fs.unlinkSync(STOP); } catch { /* none */ }
    console.log(`${new Date().toISOString()} deep scan ended (${reason}): ${finished} of ${total} clips checked, ${failed} check errors`);
    process.exit(0);
})().catch((e) => {
    stop('error');   // kill running ffmpeg/ffprobe children before exiting
    writeStatus({ running: false, finished: new Date().toISOString(), reason: 'error', error: String(e && e.message || e).slice(0, 300), current: [] });
    console.error(e);
    process.exit(1);
});
