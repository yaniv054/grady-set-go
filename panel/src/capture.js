// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const R = require('./registry');

// --- capture devices -> live input (panel\capture.js) ------------------------------------------
// Device list and formats (DirectShow), a server-side preview while choosing (JPEG every
// 0.5 s + L/R peaks; only while the page asks for it, at most 2 minutes without a touch),
// and the capture bridge to the live input. The bridge never starts by itself (not at panel
// start, not by the boot watchdog); it stops with Stop or when ffmpeg ends. A panel restart
// or crash does not stop it: the next panel finds it (red bar with Stop). Its log is logs\capture.log; the stream URL is never logged or sent to the page.
const CAP = require('./capture.js');
const CAPTURE_DIR = path.join(R.core.DATA_DIR, 'capture');
const CAPTURE_LOG = process.env.PANEL_CAPTURE_LOG || path.join(path.dirname(R.core.LOG_FILE), 'capture.log');
const CAPTURE_MOCK = process.env.PANEL_CAPTURE_MOCK || '';
const CAPTURE_SINK = process.env.PANEL_CAPTURE_SINK || '';   // tests: write the bridge output here instead of the live input
const ffmpegExe = () => { const exe = path.join(R.core.FFMPEG_DIR, 'ffmpeg' + (process.platform === 'win32' ? '.exe' : '')); return fs.existsSync(exe) ? exe : 'ffmpeg'; };
// Stream keys masked in any RTMP/SRT form (path after the app, key=/streamid=/passphrase= queries).
const maskStream = (t) => CAP.maskUrl(R.asrun.maskKeys(String(t)));
function capLog(text) {
    try { fs.mkdirSync(path.dirname(CAPTURE_LOG), { recursive: true }); fs.appendFileSync(CAPTURE_LOG, `${new Date().toISOString()} ${maskStream(text)}\n`); } catch { /* log unavailable */ }
}
function capRun(argv, timeout = 20000) {
    return new Promise((resolve) => {
        let err = '';
        const ch = spawn(ffmpegExe(), argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        ch.stderr.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
        const t = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, timeout);
        ch.on('error', (e) => { clearTimeout(t); resolve(`error: ${e.message}`); });
        ch.on('close', () => { clearTimeout(t); resolve(err); });
    });
}
let capDevices = { at: 0, value: null };
async function captureDevices(refresh) {
    if (!refresh && capDevices.value && Date.now() - capDevices.at < 60000) return capDevices.value;
    let text;
    if (CAPTURE_MOCK) { try { text = fs.readFileSync(path.join(CAPTURE_MOCK, 'list-devices.txt'), 'utf8'); } catch { text = ''; } }
    else if (process.platform !== 'win32') text = 'error: DirectShow capture devices exist on Windows only.';
    else text = await capRun(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    const r = CAP.parseDevices(text);
    const value = { ...r, error: r.error || (!r.video.length && !r.audio.length ? (/^error: /.test(text) ? text.slice(7) : 'No capture devices found.') : ''), mock: !!CAPTURE_MOCK };
    capDevices = { at: Date.now(), value };
    return value;
}
const findDev = (list, name) => list.find((d) => d.name === name) || null;
async function captureOptions(name) {
    const devs = await captureDevices(false);
    const d = findDev(devs.video, name);
    if (!d) throw R.blocks.reqErr('This camera is not in the device list. Press Refresh.', 404);
    let text;
    if (CAPTURE_MOCK) {
        const f = path.join(CAPTURE_MOCK, `options-${name.replace(/[^\w-]+/g, '_')}.txt`);
        try { text = fs.readFileSync(fs.existsSync(f) ? f : path.join(CAPTURE_MOCK, 'options-default.txt'), 'utf8'); } catch { text = ''; }
    } else text = await capRun(['-hide_banner', '-list_options', 'true', '-f', 'dshow', '-i', `video=${CAP.devName(d)}`]);
    const formats = CAP.parseOptions(text).map((f) => ({ ...f, fps: CAP.fpsFor(f), label: CAP.formatLabel(f) }));
    return { name, formats, default: CAP.pickDefault(formats) };
}
// The request's choice -> devices and format, checked against the device list.
async function captureChoice(body) {
    const devs = await captureDevices(false);
    const video = body.video ? findDev(devs.video, String(body.video)) : null;
    const audio = body.audio ? findDev(devs.audio, String(body.audio)) : null;
    if (body.video && !video) throw R.blocks.reqErr('The camera is not in the device list any more. Press Refresh.', 409);
    if (body.audio && !audio) throw R.blocks.reqErr('The microphone is not in the device list any more. Press Refresh.', 409);
    const f = body.format && typeof body.format === 'object' ? body.format : null;
    const format = f && /^(vcodec|pixel_format)$/.test(f.kind) && /^[\w-]{1,30}$/.test(String(f.value)) && f.w > 0 && f.h > 0
        ? { kind: f.kind, value: String(f.value), w: Math.round(f.w), h: Math.round(f.h), fps_min: Number(f.fps_min) || 25, fps_max: Number(f.fps_max) || 25 } : null;
    return { video, audio, format };
}

// ---- preview (server side, when the browser cannot preview the device itself)
const cap = { preview: null, bridge: null, orphan: null };
const PREVIEW_JPG = path.join(CAPTURE_DIR, 'preview.jpg');
async function previewStart(body) {
    if (cap.bridge) throw R.blocks.reqErr('The capture bridge is running: the devices are in use.', 409);
    const ch = await captureChoice(body);
    if (!ch.video && !ch.audio) throw R.blocks.reqErr('Choose a camera or a microphone.');
    await previewStop('restart');
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    try { fs.unlinkSync(PREVIEW_JPG); } catch { /* none */ }
    const src = CAP.inputArgs({ ...ch, mock: !!CAPTURE_MOCK });
    const p = { levels: { l: -120, r: -120, at: 0 }, started: Date.now(), touched: Date.now(), polled: Date.now(), error: '', ended: null, video: ch.video?.name || '', audio: ch.audio?.name || '' };
    p.proc = CAP.startFfmpeg(ffmpegExe(), CAP.previewArgs(src, PREVIEW_JPG), {
        onLine: (l) => { if (!CAP.parsePeakLine(l, p.levels) && /error|could not|cannot|failed|busy/i.test(l)) p.error = maskStream(l.replace(/^\[[^\]]*\]\s*/, '')).slice(0, 200); },
        onExit: (code) => { p.ended = { at: Date.now(), code }; if (cap.preview === p) p.proc = null; },
    });
    cap.preview = p;
    return previewState();
}
// Resolves once the preview's ffmpeg has exited (killed after 1.5 s), so the device is free.
async function previewStop(why) {
    const p = cap.preview;
    if (!p) return { stopped: false };
    cap.preview = null;
    p.stopReason = why;
    if (p.proc) await CAP.stopFfmpeg(p.proc, 1500);
    return { stopped: true };
}
function previewState() {
    const p = cap.preview;
    if (!p) return { running: false };
    p.polled = Date.now();
    return { running: !!p.proc, levels: p.levels, frame_at: (() => { try { return fs.statSync(PREVIEW_JPG).mtimeMs; } catch { return null; } })(), error: p.error, ended: p.ended, idle_stop_in_s: Math.max(0, Math.round((p.touched + 120000 - Date.now()) / 1000)) };
}
// Page closed (no poll for 10 s) or 2 minutes without a touch: the preview stops.
setInterval(() => {
    const p = cap.preview;
    if (p && (Date.now() - p.polled > 10000 || Date.now() - p.touched > 120000)) previewStop(Date.now() - p.polled > 10000 ? 'page closed' : 'idle');
}, 2000).unref();

// ---- the bridge
// data\capture-bridge.json: the running bridge's process id and start time. After a panel
// that was killed (Task Manager, a crash), the bridge can still be sending: on start-up the
// panel checks that process (still ffmpeg, same start time, sending FLV/MPEG-TS) and shows a
// red warning with Stop on every page. restart-panel.ps1 stops it only with -StopCapture.
const BRIDGE_PID = path.join(R.core.DATA_DIR, 'capture-bridge.json');
// { name, start (ms), cmd } of a running process; { gone: true } when the system says there
// is no such process; { unknown: true } when it could not be checked (PowerShell error or
// timeout): then nothing is concluded.
function procInfo(pid) {
    return new Promise((resolve) => {
        pid = Number(pid);
        if (!(pid > 0)) return resolve({ gone: true });
        if (process.platform === 'win32') {
            const ps = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { 'FOUND'; $p.Name; $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine } else { 'NONE' }`;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
                const lines = String(out || '').split(/\r?\n/);
                if (err) return resolve({ unknown: true, why: err.killed ? 'timeout' : String(err.message).slice(0, 120) });
                if (lines[0].trim() === 'NONE') return resolve({ gone: true });
                if (lines[0].trim() !== 'FOUND') return resolve({ unknown: true, why: 'unexpected answer' });
                resolve({ name: lines[1].trim(), start: Date.parse(lines[2].trim()) || null, cmd: lines.slice(3).join(' ') });
            });
            return;
        }
        if (!fs.existsSync(`/proc/${pid}`)) return resolve({ gone: true });
        try {
            const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
            const btime = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]);
            resolve({ name: path.basename(cmd.split(' ')[0]), start: (btime + ticks / 100) * 1000, cmd });
        } catch (e) { resolve(fs.existsSync(`/proc/${pid}`) ? { unknown: true, why: e.message } : { gone: true }); }
    });
}
// 'yes': the recorded bridge is still that ffmpeg (same start time, still pushing to the live
// input); 'no': it is not (ended, or the id now belongs to another process); 'unknown'.
async function isOurBridge(rec) {
    if (process.env.PANEL_CAPTURE_CHECK_FAIL) return 'unknown';   // tests: the system check fails
    const info = rec ? await procInfo(rec.pid) : { gone: true };
    if (info.unknown) return 'unknown';
    if (info.gone || !/ffmpeg/i.test(info.name)) return 'no';
    if (info.cmd && (!/-f (flv|mpegts)\b/.test(info.cmd) || /-listen\b/.test(info.cmd) || (rec.hostport && !info.cmd.includes(rec.hostport)))) return 'no';
    const want = rec.os_start || Date.parse(rec.started);
    return !(info.start && want) || Math.abs(info.start - want) < (rec.os_start ? 5000 : 30000) ? 'yes' : 'no';
}
// Run at start-up, and every 15 s while the answer is "unknown" or a leftover is shown.
async function checkLeftoverBridge() {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(BRIDGE_PID, 'utf8')); } catch { cap.orphan = null; return; }
    if (cap.bridge && cap.bridge.proc && rec.pid === cap.bridge.proc.pid) return;
    const r = await isOurBridge(rec);
    if (r === 'yes') {
        if (!cap.orphan || cap.orphan.unknown) capLog(`the capture bridge from before (pid ${rec.pid}, since ${rec.started}) is still sending to the live input`);
        cap.orphan = rec;
    } else if (r === 'unknown') {
        // Could not check: keep the record and say the camera MAY still be sending.
        if (!cap.orphan) capLog(`could not check the capture bridge from before (pid ${rec.pid}); checking again every 15 s`);
        cap.orphan = { ...rec, unknown: true };
    } else {
        // Definitely not running any more: the record is moved aside (kept for the log).
        cap.orphan = null;
        try { R.core.renameRetry(BRIDGE_PID, `${BRIDGE_PID}.ended-${R.core.stamp()}`); } catch { /* gone */ }
    }
}
setInterval(() => { if (cap.orphan) checkLeftoverBridge().catch((e) => console.error('capture check', e.message)); }, 15000).unref();
setTimeout(() => { checkLeftoverBridge().catch((e) => console.error('capture check', e.message)); }, 500);
// Live input listener -> the URL to push to (from ffplayout's config through the automation
// account when there is one, else from the page's copy of the config). Never logged.
async function liveTarget(body) {
    let listeners = null;
    if (R.automation.readSecrets()) {
        try {
            if (!R.automation.auto.channelId) { const ch = await R.automation.ffApi('GET', '/api/channels'); R.automation.auto.channelId = ch?.[0]?.id; }
            const cfg = await R.automation.ffApi('GET', `/api/playout/config/${R.automation.auto.channelId}`);
            listeners = cfg?.ingest?.listeners || null;
        } catch { listeners = null; }
    }
    const want = body.listener;
    let l = null;
    if (listeners) l = listeners.find((x) => String(x.id) === String(want?.id) && (x.name || '') === (want?.name || '')) || listeners.find((x) => String(x.id) === String(want?.id)) || null;
    if (!l && want && typeof want.identifier === 'string') l = want;
    if (!l) throw R.blocks.reqErr('Choose the live input listener to send to.');
    if (!l.enabled) throw Object.assign(R.blocks.reqErr('This live input listener is switched off in ffplayout. Enable it first; it takes effect after the channel playback is restarted.', 409), { code: 'LISTENER_OFF' });
    const id = String(l.identifier || '');
    let url = id.replace('://0.0.0.0', '://127.0.0.1');
    if (/^srt:/i.test(url) && !/mode=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'mode=caller';
    if (!/^(rtmps?|srt):\/\//i.test(url)) throw R.blocks.reqErr('The listener has no usable address.');
    const port = /:(\d+)/.exec(url.slice(6))?.[1] || '';
    return { url, label: `${(l.backend || url.slice(0, 4)).toUpperCase()} listener${l.name ? ` “${l.name}”` : ''}${port ? ` on port ${port}` : ''}` };
}
async function bridgeStart(body) {
    if (cap.bridge) throw R.blocks.reqErr('The capture bridge is already running.', 409);
    if (cap.orphan) throw R.blocks.reqErr(`A capture bridge from before the panel restart is still running (process ${cap.orphan.pid}). Stop it first.`, 409);
    if (body.confirm !== true) throw R.blocks.reqErr('Confirm first.');
    const ch = await captureChoice(body);
    if (!ch.video) throw R.blocks.reqErr('Choose a camera.');
    const target = await liveTarget(body);
    // The preview's ffmpeg must have let go of the devices first.
    await previewStop('bridge');
    const src = CAP.inputArgs({ ...ch, mock: !!CAPTURE_MOCK });
    const out = CAPTURE_SINK ? CAP.outputArgs(CAPTURE_SINK === 'null' ? '' : CAPTURE_SINK) : CAP.outputArgs(target.url);
    const b = { started: Date.now(), video: ch.video.name, audio: ch.audio?.name || '', format: ch.format ? CAP.formatLabel(ch.format) : 'device default', target: target.label,
        stats: {}, levels: { l: -120, r: -120, at: 0 }, input_dropped: 0, errors: [], ended: null, stopping: false };
    capLog(`START ${b.video}${b.audio ? ` + ${b.audio}` : ' (no microphone: silence)'} · ${b.format} -> ${target.label}${CAPTURE_SINK ? ` (test sink ${CAPTURE_SINK})` : ''}`);
    // Started once more after 1 s when DirectShow reports the device busy right away (a
    // preview or a video app that is still letting go of it).
    const launch = (attempt) => new Promise((resolve) => {
    let early = '';
    // Once the launch has been reported as running (2.5 s), a busy exit is a normal end:
    // the retry path only exists while the caller is still waiting for the first answer.
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const testBusy = attempt === 1 && process.env.PANEL_CAPTURE_BUSY_ONCE;
    const proc = CAP.startFfmpeg(testBusy ? process.execPath : ffmpegExe(), testBusy ? ['-e', "console.error('[dshow @ 0000] Could not run graph (sometimes caused by a device already in use by other application)'); process.exit(1)"] : CAP.bridgeArgs(src, out), {
        onOut: (t) => CAP.parseProgress(t, b.stats),
        onLine: (l) => {
            if (Date.now() - b.started < 4000) early += l + '\n';
            if (CAP.parsePeakLine(l, b.levels)) return;
            if (/real-time buffer .*full|frame dropped/i.test(l)) { b.input_dropped++; return; }
            if (/error|could not|cannot|failed|refused|broken pipe|i\/o error|busy/i.test(l)) {
                const msg = maskStream(l.replace(/^\[[^\]]*\]\s*/, '')).slice(0, 240);
                b.errors.push({ at: Date.now(), msg }); if (b.errors.length > 20) b.errors.shift();
                capLog(`ffmpeg: ${msg}`);
            }
        },
        onExit: (code, err) => {
            if (!settled && attempt === 1 && !b.stopping && Date.now() - b.started < 4000 && CAP.isBusy(early)) {
                capLog(`device busy (exit ${code}): trying again in 1 s`);
                return settle('busy');
            }
            b.ended = { at: Date.now(), code, error: err ? maskStream(err) : null };
            capLog(`END exit ${code}${b.stopping ? ' (stopped)' : ''} after ${Math.round((Date.now() - b.started) / 1000)} s, ${b.stats.frames || 0} frames`);
            try { R.core.renameRetry(BRIDGE_PID, `${BRIDGE_PID}.ended-${R.core.stamp()}`); } catch { /* none */ }
            if (cap.bridge === b) { cap.bridge = null; cap.last = b; }
            settle('ended');
        },
    });
    b.proc = proc;
    fs.mkdirSync(R.core.DATA_DIR, { recursive: true });
    // host:port of the live input (never the key): restart-panel.ps1 -StopCapture matches it in the command line.
    const rec = { pid: proc.pid, started: new Date().toISOString(), target: target.label, hostport: CAPTURE_SINK ? '' : (/^\w+:\/\/([^/?\s]+)/.exec(target.url)?.[1] || '') };
    if (proc.pid) {
        R.core.writeJsonAtomic(BRIDGE_PID, rec, 1);
        // The process's own start time (from the system) makes the record unambiguous.
        procInfo(proc.pid).then((info) => { if (info && info.start && cap.bridge && cap.bridge.proc === proc) { try { R.core.writeJsonAtomic(BRIDGE_PID, { ...rec, os_start: info.start }, 1); } catch { /* next time */ } } });
    }
    cap.bridge = b;
    setTimeout(() => settle('running'), 2500);
    });
    let r = await launch(1);
    if (r === 'busy') { cap.bridge = null; await new Promise((x) => setTimeout(x, 1000)); b.started = Date.now(); r = await launch(2); }
    return bridgeState();
}
async function bridgeStop(body = {}) {
    if (body.orphan && cap.orphan) {
        const rec = cap.orphan;
        // Only that ffmpeg, checked again now (process ids are reused).
        const r = await isOurBridge(rec);
        if (r === 'unknown') throw R.blocks.reqErr(`The panel could not check process ${rec.pid}. Look in Task Manager: if ffmpeg.exe ${rec.pid} is still running, end it there (or run restart-panel.ps1 -StopCapture as Administrator).`, 503);
        if (r === 'yes') { try { process.kill(rec.pid); } catch { /* gone */ } capLog(`STOP leftover bridge (pid ${rec.pid})`); }
        else capLog(`leftover bridge (pid ${rec.pid}) had already ended`);
        cap.orphan = null;
        try { R.core.renameRetry(BRIDGE_PID, `${BRIDGE_PID}.ended-${R.core.stamp()}`); } catch { /* none */ }
        return { stopped: true };
    }
    const b = cap.bridge;
    if (!b) return { stopped: false };
    b.stopping = true;
    capLog('STOP requested');
    CAP.stopFfmpeg(b.proc);
    return { stopped: true };
}
function bridgeState() {
    const b = cap.bridge || cap.last;
    const s = b ? {
        running: !!cap.bridge, stopping: !!(cap.bridge && b.stopping), started: b.started, video: b.video, audio: b.audio, format: b.format, target: b.target,
        fps: b.stats.fps ?? null, frames: b.stats.frames ?? 0, dropped: (b.stats.dropped_out || 0) + b.input_dropped, dup: b.stats.dup || 0, bitrate_kbps: b.stats.bitrate_kbps ?? null, speed: b.stats.speed ?? null,
        levels: b.levels, errors: b.errors.slice(-5), ended: b.ended,
    } : { running: false };
    return { ...s, orphan: cap.orphan ? { pid: cap.orphan.pid, started: cap.orphan.started, unknown: !!cap.orphan.unknown } : null, preview: previewState(), mock: !!CAPTURE_MOCK };
}
// On exit only the preview is stopped. A bridge keeps sending (a live show is never cut by a
// panel crash or restart); the next panel finds it and shows it with Stop.
process.on('exit', () => { try { if (cap.preview?.proc) cap.preview.proc.kill(); } catch { /* gone */ } });


// ---- exports (read by the other modules through R.capture) ----
R.capture = module.exports;
Object.assign(module.exports, { CAP, CAPTURE_DIR, CAPTURE_LOG, CAPTURE_MOCK, CAPTURE_SINK, ffmpegExe, maskStream, capLog, capRun, captureDevices, findDev, captureOptions, captureChoice, cap, PREVIEW_JPG, previewStart, previewStop, previewState, BRIDGE_PID, procInfo, isOurBridge, checkLeftoverBridge, liveTarget, bridgeStart, bridgeStop, bridgeState });
Object.defineProperty(module.exports, 'capDevices', { get: () => capDevices, set: (v) => { capDevices = v; }, enumerable: true });
