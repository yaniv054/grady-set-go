// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Capture devices on this PC -> the channel's live input (used by server.js).
//
// Windows: ffmpeg's DirectShow input (dshow) lists the cameras and microphones, lists each
// camera's formats, grabs a low-rate preview (a JPEG every 0.5 s + L/R peak levels) and runs
// the "capture bridge": camera + microphone -> 1920x1080, 25 fps, yuv420p, 48 kHz stereo,
// H.264 veryfast/zerolatency ~6 Mbit/s, keyframe every 2 s -> FLV (RTMP) or MPEG-TS (SRT) to
// the live input listener of ffplayout. ffplayout then takes over the broadcast.
//
// Nothing here starts on its own: the bridge runs only after a person presses "Send to live
// input" (and confirms), and stops with Stop or when ffmpeg ends (a panel restart does not
// stop it; the next panel shows it with Stop).
// The stream URL (it holds the stream key) is never logged or returned: logs and errors
// show it masked.
//
// Tests (no DirectShow): PANEL_CAPTURE_MOCK=<folder> makes the device list and the format
// list come from recorded ffmpeg output in that folder (list-devices.txt, options-*.txt) and
// replaces the camera and microphone by a test pattern and a tone (lavfi).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const strip = (line) => String(line).replace(/^\s*\[[^\]]*\]\s?/, '');

// `ffmpeg -list_devices true -f dshow -i dummy` -> { video: [{ name, alt }], audio: [...] }.
// Handles both layouts: the "DirectShow video devices" sections (older ffmpeg) and
// `"Name" (video)` / `"Name" (audio)` / `"Name" (video, audio)` (ffmpeg 4.4 and later).
function parseDevices(text) {
    const video = [], audio = [];
    let section = null, last = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = strip(raw).trim();
        if (!line) continue;
        if (/^DirectShow video devices/i.test(line)) { section = 'video'; last = []; continue; }
        if (/^DirectShow audio devices/i.test(line)) { section = 'audio'; last = []; continue; }
        let m = /^Alternative name\s+"(.+)"$/i.exec(line);
        if (m) { for (const d of last) d.alt = m[1]; continue; }
        m = /^"(.+)"\s+\(([a-z ,]+)\)$/i.exec(line);
        if (m) {
            const kinds = m[2].toLowerCase();
            last = [];
            if (kinds.includes('video')) { const d = { name: m[1], alt: '' }; video.push(d); last.push(d); }
            if (kinds.includes('audio')) { const d = { name: m[1], alt: '' }; audio.push(d); last.push(d); }
            continue;
        }
        m = /^"(.+)"$/.exec(line);
        if (m && section) { const d = { name: m[1], alt: '' }; (section === 'video' ? video : audio).push(d); last = [d]; }
    }
    const error = !video.length && !audio.length && /could not enumerate|error|not found|unknown input format/i.test(text) ? (String(text).split(/\r?\n/).map(strip).find((l) => /could not|error|not found|unknown input/i.test(l)) || '').trim().slice(0, 200) : '';
    return { video, audio, error };
}

// `ffmpeg -list_options true -f dshow -i video="Name"` -> formats, largest first.
function parseOptions(text) {
    const out = [], seen = new Set();
    const re = /(vcodec|pixel_format)=(\S+)\s+min s=(\d+)x(\d+) fps=([\d.]+)\s+max s=(\d+)x(\d+) fps=([\d.]+)/;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const m = re.exec(strip(raw));
        if (!m) continue;
        const f = { kind: m[1], value: m[2], w: Number(m[6]), h: Number(m[7]), fps_min: Number(m[5]), fps_max: Number(m[8]) };
        if (!(f.w > 0 && f.h > 0 && f.fps_max > 0)) continue;
        const k = `${f.kind}:${f.value}:${f.w}x${f.h}:${f.fps_min}-${f.fps_max}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(f);
    }
    out.sort((a, b) => b.w * b.h - a.w * a.h || b.fps_max - a.fps_max || (a.kind === 'vcodec' ? -1 : 1));
    return out;
}
// The frame rate to ask for: 25 when the format allows it, else the nearest it offers.
const fpsFor = (f) => (f.fps_min <= 25 && f.fps_max >= 25 ? 25 : f.fps_max < 25 ? f.fps_max : f.fps_min);
// Closest to 1920x1080 at 25 fps (size first, then frame rate, then compressed over raw).
function pickDefault(formats) {
    let best = -1, bestScore = Infinity;
    formats.forEach((f, i) => {
        const fps = fpsFor(f);
        const score = (Math.abs(f.w - 1920) + Math.abs(f.h - 1080)) * 10 + Math.abs(fps - 25) * 3 + (fps < 24 ? 500 : 0) + (f.kind === 'vcodec' ? 0 : 1);
        if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
}
const formatLabel = (f) => `${f.w}×${f.h} · ${Number(fpsFor(f).toFixed(2))} fps · ${f.kind === 'vcodec' ? f.value.toUpperCase() : f.value}`;

// dshow input names: the device name, or its alternative name when the name has a colon
// (the separator between video= and audio=).
const devName = (d) => (d && d.name && d.name.includes(':') && d.alt ? d.alt : d && d.name);
function inputArgs({ video, audio, format, mock }) {
    const w = format?.w || 1920, h = format?.h || 1080, fps = format ? fpsFor(format) : 25;
    if (mock) {
        const args = ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`];
        if (audio) args.push('-re', '-f', 'lavfi', '-i', 'sine=frequency=880:beep_factor=4:sample_rate=48000');
        return { args, v: video ? '0:v' : null, a: audio ? '1:a' : null };
    }
    const args = ['-f', 'dshow', '-rtbufsize', '256M'];
    if (video && format) {
        if (format.kind === 'vcodec') args.push('-vcodec', format.value); else args.push('-pixel_format', format.value);
        args.push('-video_size', `${w}x${h}`, '-framerate', String(fps));
    }
    const spec = [video && `video=${devName(video)}`, audio && `audio=${devName(audio)}`].filter(Boolean).join(':');
    args.push('-i', spec);
    return { args, v: video ? '0:v' : null, a: audio ? '0:a' : null };
}
// L/R sample peak every ~0.1 s, printed to stderr by ametadata.
const METER = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,astats=metadata=1:reset=5:measure_perchannel=Peak_level:measure_overall=none,ametadata=mode=print';
function bridgeArgs(src, out) {
    const vin = src.v ? `[${src.v}]` : null;
    const ain = src.a ? `[${src.a}]` : null;
    const pre = ain ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
    const silentIdx = src.args.filter((a) => a === '-i').length;
    const graph = [
        `${vin}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p[v]`,
        `${ain || `[${silentIdx}:a]`}aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit[a][m]`,
        `[m]${METER.split(',').slice(2).join(',')},anullsink`,
    ].join(';');
    // No -nostdin: "q" on stdin is the clean stop.
    return ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-stats_period', '1',
        ...src.args, ...pre, '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
        '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        ...out];
}
// Output: FLV to an RTMP listener, MPEG-TS to an SRT listener, or (tests) a file / nothing.
function outputArgs(url) {
    if (!url) return ['-f', 'null', '-'];
    if (/^srt:/i.test(url)) return ['-f', 'mpegts', url];
    if (/^rtmps?:/i.test(url)) return ['-f', 'flv', url];
    return ['-f', 'flv', '-y', url];
}
function previewArgs(src, jpg) {
    const graph = [];
    const maps = [];
    if (src.v) { graph.push(`[${src.v}]fps=2,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[pv]`); maps.push('-map', '[pv]', '-f', 'image2', '-update', '1', '-q:v', '6', '-y', jpg); }
    if (src.a) { graph.push(`[${src.a}]${METER}[pa]`); maps.push('-map', '[pa]', '-f', 'null', '-'); }
    return ['-hide_banner', '-loglevel', 'info', '-nostats', ...src.args, '-filter_complex', graph.join(';'), ...maps];
}

// "lavfi.astats.1.Peak_level=-12.3" lines -> { l, r } (dBFS; -inf for silence).
function parsePeakLine(line, cur) {
    const m = /lavfi\.astats\.([12])\.Peak_level=(-?inf|-?[\d.]+)/.exec(line);
    if (!m) return false;
    const v = /inf/.test(m[2]) ? -120 : Math.max(-120, Number(m[2]));
    if (m[1] === '1') cur.l = v; else cur.r = v;
    cur.at = Date.now();
    return true;
}
// -progress key=value blocks -> stats.
function parseProgress(text, st) {
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^(\w+)=(.*)$/.exec(line.trim());
        if (!m) continue;
        const [, k, v] = m;
        if (k === 'fps') st.fps = Number(v) || 0;
        else if (k === 'frame') st.frames = Number(v) || 0;
        else if (k === 'drop_frames') st.dropped_out = Number(v) || 0;
        else if (k === 'dup_frames') st.dup = Number(v) || 0;
        else if (k === 'bitrate') st.bitrate_kbps = /([\d.]+)kbits/.test(v) ? Number(/([\d.]+)kbits/.exec(v)[1]) : null;
        else if (k === 'speed') st.speed = /([\d.]+)x/.test(v) ? Number(/([\d.]+)x/.exec(v)[1]) : null;
        else if (k === 'out_time_us' || k === 'out_time_ms') st.out_s = Math.round(Number(v) / 1e6);
        else if (k === 'progress') st.progress_at = Date.now();
    }
}

// Starts ffmpeg; feeds stdout to onOut, stderr lines to onErr; resolves nothing (events).
function startFfmpeg(exe, argv, { onOut, onLine, onExit }) {
    const ch = spawn(exe, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Below normal priority, like the overnight analysis: ffplayout keeps the CPU.
    try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ }
    let rest = '';
    ch.stdout.on('data', (d) => onOut && onOut(String(d)));
    ch.stderr.on('data', (d) => {
        rest += d;
        const lines = rest.split(/\r?\n|\r/);
        rest = lines.pop();
        if (rest.length > 8192) rest = '';
        for (const l of lines) if (l) onLine && onLine(l);
    });
    ch.on('error', (e) => onExit && onExit(-1, e.message));
    ch.on('close', (code) => onExit && onExit(code, null));
    return ch;
}
// Clean stop: "q" on stdin lets ffmpeg finish the stream; killed if still running after
// `killAfter` ms. Resolves when the process has exited (so the device is free again).
function stopFfmpeg(ch, killAfter = 3000) {
    return new Promise((resolve) => {
        if (!ch || ch.exitCode !== null || ch.signalCode !== null) return resolve();
        ch.once('close', () => resolve());
        try { ch.stdin.write('q'); ch.stdin.end(); } catch { /* closed */ }
        const t = setTimeout(() => { if (ch.exitCode === null) { try { ch.kill(); } catch { /* gone */ } } }, killAfter);
        t.unref();
        // Never wait forever (a process that ignores the kill): give up after 5 s more.
        setTimeout(resolve, killAfter + 5000).unref();
    });
}
// DirectShow refusing a device another program still holds.
const isBusy = (text) => /could not run graph|already in use|device.*busy|busy.*device|i\/o error|error opening input.*(video|audio)=|could not set video options|could not find video device|could not enumerate/i.test(String(text || ''));
// Stream keys in any RTMP/SRT form: the path after the app, and key/streamid/passphrase queries.
function maskUrl(t) {
    return String(t)
        .replace(/(rtmps?:\/\/[^\s"'/]+\/[^\s"'/?]+\/)[^\s"']+/gi, '$1••••')
        // rtmp://host:port/KEY (no app path): everything after the host.
        .replace(/(rtmps?:\/\/[^\s"'/]+\/)(?!••••)([^\s"'/?]+)(?=$|[\s"'?])/gi, (m, a, b) => (/^(live|live2|app)$/i.test(b) ? m : `${a}••••`))
        .replace(/((?:rtmps?|srt):\/\/[^\s"']*?[?&](?:key|streamid|passphrase|pass|password|token|secret)=)[^&\s"']+/gi, '$1••••')
        .replace(/([?&](?:key|streamid|passphrase|pass|password|token|secret)=)[^&\s"']+/gi, '$1••••')
        .replace(/(live2\/)[^\s"'<:]+/gi, '$1••••');
}

module.exports = { isBusy, maskUrl, parseDevices, parseOptions, pickDefault, fpsFor, formatLabel, inputArgs, bridgeArgs, outputArgs, previewArgs, parsePeakLine, parseProgress, startFfmpeg, stopFfmpeg, devName, METER };
