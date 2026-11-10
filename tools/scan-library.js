// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Library scanner for the playout media share. READ-ONLY on the media root.
//
//   node scan-library.js                         metadata for every video file
//   node scan-library.js --loudness-all          + EBU R128 for everything (slow: decodes all audio)
//   options: --root <share> --out <csv> --bin <ffmpeg folder> --jobs 3 --force
//
// Output: C:\Playout\library.csv (UTF-8 with BOM). Rows for files whose size and
// modification time are unchanged (and that were read without error) are reused, so
// re-runs only probe new/changed files and loudness values accumulate across runs.
//
// Safety: library.csv is NOT rewritten when the share or any folder in it cannot be
// read, or when the new list has fewer than half the rows of the old one (a share
// that is half offline); --force overrides the second check. Only one scan runs at a
// time (library.csv.lock). Progress is saved to library.csv.partial every 200 files,
// so a crashed scan does not have to probe everything again.

'use strict';
const cfg = require('../panel/config');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// Logging must never kill the scan (the panel may close the pipe when it restarts).
process.stdout.on('error', () => { /* EPIPE etc.: ignore */ });
process.stderr.on('error', () => { /* EPIPE etc.: ignore */ });

// Below normal priority so playout keeps the CPU; each ffprobe/ffmpeg child too.
const LOW = os.constants.priority.PRIORITY_BELOW_NORMAL;
try { os.setPriority(0, LOW); } catch { /* not permitted: run at normal priority */ }

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const ROOT = opt('--root', cfg.mediaRoot);
const OUT = opt('--out', cfg.libraryCsv);
const BIN = opt('--bin', path.dirname(cfg.ffprobe));
const JOBS = Number(opt('--jobs', 3)) || 3;
const FORCE = args.includes('--force');
const PARTIAL = OUT + '.partial';
const LOCK = OUT + '.lock';
const CHECKPOINT_EVERY = 200;
const TARGET = { width: Number(opt('--width', 1920)), height: Number(opt('--height', 1080)), fps: Number(opt('--fps', 25)), lufs: Number(opt('--lufs', -23)) };
const LOUD_ALL = args.includes('--loudness-all');
const SKIP_DIRS = new Set(['@recycle', '#recycle', '$recycle.bin', '.@__thumb', '@eadir']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.mkv', '.m4v', '.avi', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.webm', '.wmv', '.flv']);

const COLS = ['path', 'folder', 'file', 'size_bytes', 'mtime', 'duration_s', 'width', 'height', 'fps', 'field_order', 'video_codec', 'pix_fmt',
    'audio_codec', 'audio_channels', 'sample_rate', 'audio_streams', 'integrated_lufs', 'true_peak_dbtp', 'needs_conform', 'issues', 'error'];

if (path.resolve(OUT).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase())) {
    console.error('Refusing to write output inside the media root.');
    process.exit(2);
}

// C:\Playout\app\bin\ffprobe.exe if it is there, otherwise ffprobe from PATH (as deep-scan.js).
const exe = (name) => {
    const p = path.join(BIN, name + (process.platform === 'win32' ? '.exe' : ''));
    return fs.existsSync(p) ? p : name;
};

function run(bin, argv, timeout = 120000) {
    return new Promise((resolve) => {
        const ch = execFile(exe(bin), argv, { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) =>
            resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
        try { os.setPriority(ch.pid, LOW); } catch { /* inherited, gone or not permitted */ }
    });
}

// Collects video files; folders that cannot be read are listed in `unreadable`.
async function walk(dir, out, unreadable) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { console.error(`unreadable: ${dir} (${e.code || e.message})`); unreadable.push(dir); return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase()) && !/^[.@#$]/.test(e.name)) await walk(full, out, unreadable); }
        else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
}

function fpsOf(s) { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : 0; }

async function probe(file) {
    const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    if (r.err) return { error: (r.stderr || r.err.message).split('\n')[0].slice(0, 200) };
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { error: 'ffprobe output could not be read' }; }
    const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const auds = (j.streams || []).filter((s) => s.codec_type === 'audio');
    const a = auds[0];
    return {
        duration_s: Number(j.format && j.format.duration || (v && v.duration) || 0).toFixed(3),
        width: v ? v.width : '', height: v ? v.height : '',
        fps: v ? fpsOf(v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate).toFixed(3) : '',
        field_order: v ? v.field_order || '' : '', video_codec: v ? v.codec_name : '', pix_fmt: v ? v.pix_fmt || '' : '',
        audio_codec: a ? a.codec_name : '', audio_channels: a ? a.channels : '', sample_rate: a ? a.sample_rate : '', audio_streams: auds.length,
    };
}

async function loudness(file) {
    const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-threads', '2', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], 6 * 3600 * 1000);
    const sum = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
    const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(sum);
    const p = /True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(sum);
    return { integrated_lufs: i ? i[1] : '', true_peak_dbtp: p ? p[1] : '' };
}

function assess(row) {
    const issues = [];
    if (row.error) issues.push('unreadable');
    else {
        if (!row.video_codec) issues.push('no video');
        if (row.width && (Number(row.width) !== TARGET.width || Number(row.height) !== TARGET.height)) issues.push(`res ${row.width}x${row.height}`);
        if (row.fps && Math.abs(Number(row.fps) - TARGET.fps) > 0.05) issues.push(`fps ${Number(row.fps).toFixed(2)}`);
        if (row.field_order && !['progressive', 'unknown'].includes(row.field_order)) issues.push(`interlaced (${row.field_order})`);
        if (row.pix_fmt && row.pix_fmt !== 'yuv420p') issues.push(`pix ${row.pix_fmt}`);
        if (!row.audio_codec) issues.push('no audio');
        else {
            if (Number(row.audio_channels) !== 2) issues.push(`${row.audio_channels}ch audio`);
            if (Number(row.audio_streams) > 1) issues.push(`${row.audio_streams} audio streams`);
            if (row.sample_rate && Number(row.sample_rate) !== 48000) issues.push(`${row.sample_rate} Hz`);
        }
        if (Number(row.duration_s) < 1) issues.push('zero length');
        if (row.integrated_lufs !== '' && row.integrated_lufs !== undefined) {
            const l = Number(row.integrated_lufs);
            if (!Number.isFinite(l)) issues.push('silent');
            else if (Math.abs(l - TARGET.lufs) > 2) issues.push(`loudness ${l} LUFS`);
            if (Number(row.true_peak_dbtp) > -1) issues.push(`true peak ${row.true_peak_dbtp}`);
        }
    }
    row.needs_conform = issues.length ? 'yes' : 'no';
    row.issues = issues.join('; ');
    return row;
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function readCsv(file) {
    if (!fs.existsSync(file)) return new Map();
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
        else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
        else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const [head, ...data] = rows;
    if (!head) return new Map();
    return new Map(data.filter((r) => r.length >= head.length).map((r) => { const o = Object.fromEntries(head.map((h, i) => [h, r[i]])); return [o.path, o]; }));
}

function writeCsv(file, rows) {
    const sorted = rows.slice().sort((a, b) => a.path.localeCompare(b.path));
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, '\uFEFF' + [COLS.join(','), ...sorted.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n', 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) { try { fs.unlinkSync(tmp); } catch { /* not written */ } throw e; }
}

// One scan at a time: library.csv.lock holds the PID of the running scan. A lock left by
// a scan that no longer runs is taken over.
function takeLock() {
    for (let i = 0; i < 2; i++) {
        try {
            const fd = fs.openSync(LOCK, 'wx');
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let pid = 0;
            try { pid = Number(fs.readFileSync(LOCK, 'utf8').trim()) || 0; } catch { /* just removed */ }
            let alive = false;
            if (pid && pid !== process.pid) { try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; } }
            // No PID yet: another scan has just created the lock and is about to write it.
            if (!pid) { try { alive = Date.now() - fs.statSync(LOCK).mtimeMs < 10000; } catch { /* just removed */ } }
            // A live PID on a lock not refreshed for 30 min is a reused PID (Windows reuses them).
            if (alive) { try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30 * 60e3) alive = false; } catch { /* just removed */ } }
            if (alive) { console.error(`Another library scan is running (PID ${pid}); not starting a second one. (${LOCK})`); return false; }
            console.log(`Removing a stale lock from PID ${pid || '?'}.`);
            try { fs.unlinkSync(LOCK); } catch { /* someone else did */ }
        }
    }
    console.error(`Could not take the lock ${LOCK}.`);
    return false;
}
let haveLock = false;
process.on('exit', () => releaseLock());
function releaseLock() {
    if (!haveLock) return;
    haveLock = false;
    try { if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* gone */ }
}

async function main() {
    const t0 = Date.now();
    if (!takeLock()) { process.exitCode = 3; return; }
    haveLock = true;
    try { fs.accessSync(ROOT); } catch (e) {
        console.error(`Cannot read the media root ${ROOT} (${e.code || e.message}). ${OUT} was not changed.`);
        process.exitCode = 1; return;
    }
    const files = [], unreadable = [];
    await walk(ROOT, files, unreadable);
    // The root or a top-level folder unreadable: the share is probably offline, keep the CSV.
    // A deeper folder (permissions, broken link): keep its previous rows and carry on.
    const top = unreadable.filter((d) => d === ROOT || path.dirname(d) === ROOT);
    if (top.length) {
        console.error(`${top.length} top-level folder(s) could not be read (first: ${top[0]}). ${OUT} was not changed; check the share and scan again.`);
        process.exitCode = 1; return;
    }
    const prev = readCsv(OUT);
    if (unreadable.length) {
        const listed = new Set(files);
        let kept = 0;
        for (const d of unreadable) {
            const pre = d.toLowerCase() + path.sep;
            for (const k of prev.keys()) if (k.toLowerCase().startsWith(pre) && !listed.has(k)) { files.push(k); listed.add(k); kept++; }
        }
        console.error(`${unreadable.length} folder(s) could not be read (first: ${unreadable[0]}); their ${kept} previous rows are kept.`);
    }
    const prevCount = prev.size;
    // Rows saved by an interrupted scan (newer than library.csv) are used as a cache too.
    try {
        const pst = fs.statSync(PARTIAL);
        let ost = null; try { ost = fs.statSync(OUT); } catch { /* no CSV yet */ }
        if (!ost || pst.mtimeMs > ost.mtimeMs) {
            const part = readCsv(PARTIAL);
            for (const [k, v] of part) prev.set(k, v);
            console.log(`Using ${part.size} rows saved by an interrupted scan (${PARTIAL}).`);
        }
    } catch { /* no partial file */ }
    console.log(`${files.length} video files under ${ROOT}; ${prevCount} rows in existing CSV`);
    if (prevCount && files.length < prevCount / 2 && !FORCE) {
        console.error(`Only ${files.length} files found, fewer than half of the ${prevCount} rows in ${OUT}: is part of the share offline? ${OUT} was not changed. Use --force to write it anyway.`);
        process.exitCode = 1; return;
    }

    const rows = [];
    let done = 0, probed = 0, measured = 0;
    const queue = files.slice();

    async function worker() {
        while (queue.length) {
            const file = queue.shift();
            const old = prev.get(file);
            let st;
            try { st = await fs.promises.stat(file); } catch {
                // Listed but not stat-able right now: keep what we knew about it.
                if (old) rows.push(assess({ ...old }));
                done++;
                continue;
            }
            const key = { path: file, folder: path.relative(ROOT, path.dirname(file)), file: path.basename(file), size_bytes: st.size, mtime: st.mtime.toISOString() };
            // Reuse only rows that were read without error and have a duration.
            const reusable = old && old.size_bytes === String(st.size) && old.mtime === key.mtime && !old.error && Number(old.duration_s) > 0;
            let row = reusable ? { ...old } : null;
            if (!row) { row = { ...key, ...(await probe(file)) }; probed++; }
            if (LOUD_ALL && !row.error && row.audio_codec && (row.integrated_lufs === '' || row.integrated_lufs == null)) {
                Object.assign(row, await loudness(file)); measured++;
            }
            rows.push(assess(row));
            if (++done % 50 === 0) { try { const now = new Date(); fs.utimesSync(LOCK, now, now); } catch { /* lock gone */ } }
            if (done % 50 === 0 || done === files.length) console.log(`${done}/${files.length}  probed ${probed}  loudness ${measured}  ${Math.round((Date.now() - t0) / 1000)}s`);
            if (done % CHECKPOINT_EVERY === 0 && probed + measured) {
                try { writeCsv(PARTIAL, rows); } catch (e) { console.error(`checkpoint not saved: ${e.code || e.message}`); }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, JOBS) }, worker));

    if (prevCount && rows.length < prevCount / 2 && !FORCE) {
        console.error(`Only ${rows.length} rows, fewer than half of the ${prevCount} rows in ${OUT}. ${OUT} was not changed. Use --force to write it anyway.`);
        process.exitCode = 1; return;
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    writeCsv(OUT, rows);
    try { fs.unlinkSync(PARTIAL); } catch { /* none */ }

    const flagged = rows.filter((r) => r.needs_conform === 'yes');
    const tally = {};
    for (const r of flagged) for (const i of r.issues.split('; ')) { const k = i.replace(/ \S+$|\(.*\)/g, '').replace(/[\d.x-]+/g, '#').trim(); tally[k] = (tally[k] || 0) + 1; }
    console.log(`\nWrote ${OUT}: ${rows.length} files, ${flagged.length} flagged for conforming, ${rows.filter((r) => r.error).length} unreadable`);
    console.log('Issue counts:', JSON.stringify(tally));
    console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main()
    .catch((e) => { console.error('Library scan failed:', e && e.stack || e); process.exitCode = 1; })
    .finally(releaseLock);
