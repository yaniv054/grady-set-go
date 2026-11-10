// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part B2-live. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- live

function parseListener(l) {
    const m = /^(\w+):\/\/(\[[^\]]+\]|[^:/]+):(\d+)(?:\/([^/]*)\/?(.*))?$/.exec(l.identifier || '');
    return { host: m ? m[2] : '127.0.0.1', port: m ? Number(m[3]) : 1936, app: m ? m[4] || 'live' : 'live', key: m ? m[5] || '' : '' };
}
function randomKey() { const a = new Uint8Array(9); crypto.getRandomValues(a); return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14); }

let liveRows = [];
function renderLive() {
    liveRows = (S.config.ingest.listeners || []).map((l) => ({ ...l, ...parseListener(l) }));
    drawLive();
    renderCapture();
}
function drawLive() {
    const tbody = $('#live-table tbody');
    tbody.replaceChildren();
    if (!liveRows.length) tbody.append(h('tr', {}, h('td', { colspan: 9, class: 'empty' }, T('No live listeners.'))));
    liveRows.forEach((r, i) => {
        const upd = (k) => (e) => { r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value; drawLive(); };
        const sendTo = r.backend === 'srt' ? `srt://<this-pc>:${r.port}` : `rtmp://<this-pc>:${r.port}/${r.app}`;
        const n = r.name || `listener ${i + 1}`;
        // The ingest key is masked like the YouTube key: a password field whose value is set
        // as a property (never as an attribute), a show toggle and a copy button.
        const keyIn = h('input', { type: 'password', autocomplete: 'new-password', 'data-lpignore': 'true', 'data-1p-ignore': 'true', spellcheck: 'false', 'aria-label': T('Stream key, {n}', { n }), style: 'width:140px', onchange: upd('key') });
        keyIn.value = r.key || '';
        const copyKey = async () => { try { await navigator.clipboard.writeText(r.key || ''); toast(T('Stream key copied.'), 'ok'); } catch { toast(T('Copy is not available here: press show and copy the key from the field.'), 'err'); } };
        tbody.append(h('tr', {},
            h('td', {}, h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': T('Enabled, {n}', { n }), onchange: upd('enabled') })),
            h('td', {}, h('input', { value: r.name, placeholder: T('Studio'), 'aria-label': T('Name, listener {v}', { v: i + 1 }), onchange: upd('name') })),
            h('td', {}, h('select', { onchange: upd('backend'), 'aria-label': T('Type, {n}', { n }) }, h('option', { value: 'rtmp', selected: r.backend === 'rtmp' }, T('RTMP')), h('option', { value: 'srt', selected: r.backend === 'srt' }, T('SRT')))),
            h('td', {}, h('select', { onchange: upd('host'), 'aria-label': T('Listen on, {n}', { n }) }, h('option', { value: '127.0.0.1', selected: r.host === '127.0.0.1' }, T('This PC only')), h('option', { value: '0.0.0.0', selected: r.host === '0.0.0.0' }, T('All interfaces')))),
            h('td', {}, h('input', { type: 'number', min: 1024, max: 65535, value: r.port, style: 'width:90px', 'aria-label': T('Port, {n}', { n }), onchange: upd('port') })),
            h('td', {}, r.backend === 'rtmp'
                ? h('span', { class: 'inline' }, h('input', { value: r.app, style: 'width:70px', 'aria-label': T('App, {n}', { n }), onchange: upd('app') }), '/', keyIn,
                    h('button', { type: 'button', class: 'btn ghost small', onclick: (e) => { const show = keyIn.type === 'password'; keyIn.type = show ? 'text' : 'password'; e.target.textContent = show ? T('hide') : T('show'); } }, T('show')),
                    h('button', { type: 'button', class: 'btn ghost small', title: T('New random key'), 'aria-label': T('New random key'), onclick: () => { r.key = randomKey(); drawLive(); } }, '↻'))
                : h('span', { class: 'muted small' }, T('set options in ffplayout UI'))),
            h('td', {}, h('input', { type: 'number', min: 0, max: 100, value: r.priority, style: 'width:70px', 'aria-label': T('Priority, {n}', { n }), onchange: upd('priority') })),
            h('td', { class: 'small' }, h('code', {}, sendTo), r.backend === 'rtmp' ? h('div', { class: 'muted' }, T('Stream key: '), h('code', {}, r.key ? '••••••••' : '—'), r.key ? h('button', { type: 'button', class: 'btn ghost small', style: 'margin-left:6px', onclick: copyKey }, T('copy')) : null) : null),
            h('td', {}, h('button', { class: 'btn ghost icon', title: T('Remove'), 'aria-label': T('Remove {n}', { n }), onclick: () => { liveRows.splice(i, 1); drawLive(); } }, '✕')),
        ));
    });
    $('#live-add').disabled = liveRows.length >= 8;
}
$('#live-add').addEventListener('click', () => {
    const used = new Set(liveRows.map((r) => r.port));
    let port = 1936; while (used.has(port)) port++;
    liveRows.push({ id: 0, priority: 50, enabled: true, name: '', backend: 'rtmp', host: '127.0.0.1', port, app: 'live', key: randomKey(), options: {}, demuxer_options: {} });
    drawLive();
});
$('#live-save').addEventListener('click', async () => {
    const msg = $('#live-msg');
    msg.className = 'form-msg';
    try {
        const cfg = structuredClone((S.config = await api('GET', `/api/playout/config/${S.channelId}`)));
        cfg.ingest.listeners = liveRows.map((r) => ({
            id: r.id || 0, priority: r.priority, enabled: r.enabled, name: r.name, backend: r.backend,
            identifier: r.backend === 'srt' ? `srt://${r.host}:${r.port}` : `rtmp://${r.host}:${r.port}/${r.app || 'live'}/${r.key || 'stream'}`,
            options: r.options || {}, demuxer_options: r.demuxer_options || {},
        }));
        const res = await api('PUT', `/api/playout/config/${S.channelId}`, cfg);
        await loadChannel();
        renderLive();
        msg.textContent = res?.requires_restart && S.process === 'active' ? T('Saved. Restart the playout to apply.') : T('Saved.');
        msg.className = 'form-msg ok';
    } catch (e) { msg.textContent = e.message; msg.className = 'form-msg err'; }
});

// ---------------------------------------------------------------- capture devices
// Camera + microphone on this PC -> a live input listener. Preview in the browser
// (getUserMedia; the panel runs at 127.0.0.1, a secure context) when the browser's device
// labels match the DirectShow names, otherwise a preview made by the panel (a picture every
// 0.5 s and the L/R levels). Browser devices are released before the bridge starts
// (Windows capture devices are often exclusive).
const CAPS = { devices: null, formats: [], stream: null, ctx: null, an: null, mono: false, mode: 'none', levels: { l: -120, r: -120 }, hold: { l: { v: -120, at: 0 }, r: { v: -120, at: 0 } }, status: null, raf: 0, seq: 0 };
const CAP_KEY = 'pcr.capture';
const capPrefs = () => { try { return JSON.parse(localStorage.getItem(CAP_KEY) || '{}'); } catch { return {}; } };
const capSavePrefs = () => { try { localStorage.setItem(CAP_KEY, JSON.stringify({ video: $('#cap-video').value, audio: $('#cap-audio').value, format: $('#cap-format').value, target: $('#cap-target').value })); } catch { /* no storage */ } };
const capMsg = (t, cls = '') => { const el = $('#cap-msg'); el.textContent = t; el.className = `small ${cls}`; };
async function renderCapture() {
    capTargets();
    await capLoadDevices(false);
    capPoll();
}
function capTargets() {
    const sel = $('#cap-target'), prev = sel.value || capPrefs().target;
    const ls = (S.config?.ingest?.listeners || []).map((l, i) => ({ ...l, i, ...parseListener(l) }));
    sel.replaceChildren(...(ls.length ? ls.map((l) => h('option', { value: String(l.i), selected: String(l.i) === prev }, T('{v} · {v2} port {port}{v3}', { v: l.name || `Listener ${l.i + 1}`, v2: l.backend.toUpperCase(), port: l.port, v3: l.enabled ? '' : T(' (switched off)') }))) : [h('option', { value: '' }, T('No live input listener'))]));
    capTargetNote();
}
function capTarget() { const i = Number($('#cap-target').value); return Number.isFinite(i) ? (S.config?.ingest?.listeners || [])[i] || null : null; }
function capTargetNote() {
    const t = capTarget(), note = $('#cap-target-note');
    if (!t) { note.replaceChildren(h('span', { class: 'warn' }, T('Add a live input listener above first.'))); return; }
    if (t.enabled) { note.replaceChildren(h('span', { class: 'muted' }, T('ffplayout takes over the broadcast while this listener receives a stream.'))); return; }
    note.replaceChildren(h('span', { class: 'warn' }, T('This listener is switched off in ffplayout. ')),
        h('button', { class: 'btn ghost small', onclick: capEnableListener }, T('Enable it…')));
}
async function capEnableListener() {
    const i = Number($('#cap-target').value);
    if (!(await confirmModal(T('Enable this live input listener?'), [T('It is switched on in the channel configuration. ffplayout uses it only after the channel playback is restarted; this does not restart anything. Start the broadcast yourself when you are ready.')], { ok: T('Enable') }))) return;
    try {
        const cfg = structuredClone((S.config = await api('GET', `/api/playout/config/${S.channelId}`)));
        if (!cfg.ingest?.listeners?.[i]) throw new Error(T('The listener is no longer in the configuration.'));
        cfg.ingest.listeners[i].enabled = true;
        await api('PUT', `/api/playout/config/${S.channelId}`, cfg);
        await loadChannel();
        renderLive();
        toast(T('Listener enabled. It takes effect after the channel playback is restarted.'), 'ok');
    } catch (e) { toast(e.message, 'err'); }
}
async function capLoadDevices(refresh) {
    capMsg(refresh ? T('Looking for devices…') : '');
    let d;
    try { d = await localJson('GET', `/local/capture/devices${refresh ? '?refresh=1' : ''}`); } catch (e) { capMsg(e.message, 'err'); return; }
    CAPS.devices = d;
    const p = capPrefs();
    const fill = (sel, list, keep, none) => sel.replaceChildren(h('option', { value: '' }, none), ...list.map((x) => h('option', { value: x.name, selected: x.name === keep }, x.name)));
    const keepV = $('#cap-video').value || p.video, keepA = $('#cap-audio').value || p.audio;
    fill($('#cap-video'), d.video, keepV, d.video.length ? T('Choose a camera') : T('No camera found'));
    fill($('#cap-audio'), d.audio, keepA, d.audio.length ? T('No microphone (silence)') : T('No microphone found (silence)'));
    if (!$('#cap-video').value && d.video.length === 1) $('#cap-video').value = d.video[0].name;
    if (!$('#cap-audio').value && d.audio.length === 1) $('#cap-audio').value = d.audio[0].name;
    capMsg(d.error ? d.error : T('{count} and {count2} found{v}.', { count: Tn('{n} camera', '{n} cameras', d.video.length), count2: Tn('{n} microphone', '{n} microphones', d.audio.length), v: d.mock ? T(' (test devices)') : '' }), d.error ? 'warn' : 'muted');
    await capLoadFormats();
}
async function capLoadFormats() {
    const name = $('#cap-video').value, sel = $('#cap-format');
    CAPS.formats = [];
    if (!name) { sel.replaceChildren(h('option', { value: '' }, '—')); capPreview(); return; }
    sel.replaceChildren(h('option', { value: '' }, T('Reading formats…')));
    let r;
    try { r = await localJson('GET', `/local/capture/options?video=${encodeURIComponent(name)}`); } catch (e) { sel.replaceChildren(h('option', { value: '' }, T('Device default'))); capMsg(e.message, 'err'); capPreview(); return; }
    CAPS.formats = r.formats;
    const keep = capPrefs().format;
    const pick = r.formats.findIndex((f) => capFmtKey(f) === keep);
    sel.replaceChildren(...(r.formats.length ? r.formats.map((f, i) => h('option', { value: capFmtKey(f), selected: pick >= 0 ? i === pick : i === r.default }, f.label)) : [h('option', { value: '' }, T('Device default'))]));
    capPreview();
}
const capFmtKey = (f) => `${f.kind}:${f.value}:${f.w}x${f.h}:${f.fps_min}-${f.fps_max}`;
const capFormat = () => CAPS.formats.find((f) => capFmtKey(f) === $('#cap-format').value) || null;
for (const id of ['#cap-video', '#cap-audio', '#cap-format', '#cap-target']) {
    $(id).addEventListener('change', () => { capSavePrefs(); if (id === '#cap-video') capLoadFormats(); else if (id === '#cap-target') capTargetNote(); else capPreview(); });
}
$('#cap-refresh').addEventListener('click', () => capLoadDevices(true));

// ---- preview
async function capRelease() {
    CAPS.seq++;
    if (CAPS.stream) { for (const t of CAPS.stream.getTracks()) t.stop(); CAPS.stream = null; }
    if (CAPS.ctx) { try { await CAPS.ctx.close(); } catch { /* closed */ } CAPS.ctx = null; CAPS.an = null; }
    const v = $('#cap-preview'); v.srcObject = null; v.hidden = true;
    clearInterval(CAPS.imgT);
    $('#cap-img').hidden = true;
    if (CAPS.mode === 'server') { try { await localJson('POST', '/local/capture/preview/stop', {}); } catch { /* panel busy */ } }
    CAPS.mode = 'none';
    $('#cap-nopic').hidden = false;
}
// Browser and DirectShow name the same device a little differently ("Default - ", "(046d:0825)").
const capNorm = (t) => String(t || '').toLowerCase().replace(/^(default|communications) - /, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/, '').trim();
function capMatch(list, name) {
    const n = capNorm(name);
    return list.find((d) => capNorm(d.label) === n) || list.find((d) => capNorm(d.label).startsWith(n) || n.startsWith(capNorm(d.label)) && capNorm(d.label).length > 3) || null;
}
async function capPreview() {
    if (CAPS.status?.running) return;
    await capRelease();
    const seq = CAPS.seq;
    const vName = $('#cap-video').value, aName = $('#cap-audio').value;
    if (!vName && !aName) { $('#cap-prev-note').textContent = ''; return; }
    const note = $('#cap-prev-note');
    // 1. In the browser.
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error(T('no getUserMedia'));
        let devs = await navigator.mediaDevices.enumerateDevices();
        if (!devs.some((d) => d.label)) {
            const s0 = await navigator.mediaDevices.getUserMedia({ video: !!vName, audio: !!aName });
            for (const t of s0.getTracks()) t.stop();
            devs = await navigator.mediaDevices.enumerateDevices();
        }
        const vd = vName ? capMatch(devs.filter((d) => d.kind === 'videoinput'), vName) : null;
        const ad = aName ? capMatch(devs.filter((d) => d.kind === 'audioinput'), aName) : null;
        if ((vName && !vd) || (aName && !ad)) throw new Error('label');
        const f = capFormat();
        const stream = await navigator.mediaDevices.getUserMedia({
            video: vd ? { deviceId: { exact: vd.deviceId }, ...(f ? { width: { ideal: f.w }, height: { ideal: f.h } } : {}) } : false,
            audio: ad ? { deviceId: { exact: ad.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } : false,
        });
        if (seq !== CAPS.seq) { for (const t of stream.getTracks()) t.stop(); return; }
        CAPS.stream = stream;
        if (vd) { const v = $('#cap-preview'); v.srcObject = stream; v.hidden = false; $('#cap-nopic').hidden = true; }
        if (ad) {
            const ctx = new AudioContext();
            const src = ctx.createMediaStreamSource(stream);
            const split = ctx.createChannelSplitter(2);
            const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 2048; return a; };
            const l = mk(), r = mk();
            src.connect(split); split.connect(l, 0); split.connect(r, 1);
            CAPS.ctx = ctx; CAPS.an = { l, r, buf: new Float32Array(2048) };
            CAPS.mono = (stream.getAudioTracks()[0]?.getSettings().channelCount || 2) === 1;
        }
        CAPS.mode = 'browser';
        note.textContent = T('Preview in this browser.');
        capLoop();
        return;
    } catch (e) {
        if (CAPS.stream) { for (const t of CAPS.stream.getTracks()) t.stop(); CAPS.stream = null; }
        note.textContent = e.message === 'label' ? T('The browser names this device differently: the panel makes the preview instead (a picture every half second).')
            : T('The browser cannot use the device (permission or busy): the panel makes the preview instead (a picture every half second).');
    }
    if (seq !== CAPS.seq) return;
    // 2. Made by the panel (ffmpeg).
    try {
        await localJson('POST', '/local/capture/preview/start', { video: vName, audio: aName, format: capFormat() });
        CAPS.mode = 'server';
        if (vName) {
            const img = $('#cap-img');
            const load = () => { if (CAPS.mode === 'server') img.src = `/local/capture/preview.jpg?t=${Date.now()}`; };
            img.onload = () => { img.hidden = false; $('#cap-nopic').hidden = true; };
            img.onerror = () => {};
            load();
            CAPS.imgT = setInterval(load, 500);
        }
        capLoop();
    } catch (err) { note.textContent = T('No preview: {error}', { error: err.message }); }
}

// ---- level meter (ATEM-style: dBFS scale, green to -18, yellow to -6, red above, 1.5 s peak hold)
const METER_TICKS = [0, -6, -10, -18, -20, -30, -40, -50, -60];
function capPeaks() {
    if (CAPS.mode === 'browser' && CAPS.an) {
        const peak = (a) => { a.getFloatTimeDomainData(CAPS.an.buf); let m = 0; for (const x of CAPS.an.buf) { const v = Math.abs(x); if (v > m) m = v; } return m > 0 ? 20 * Math.log10(m) : -120; };
        const l = peak(CAPS.an.l);
        CAPS.levels = { l, r: CAPS.mono ? l : peak(CAPS.an.r) };
    }
    return CAPS.levels;
}
function capDrawMeter() {
    const c = $('#cap-meter'), g = c.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    const W = c.width, H = c.height, top = 26, bot = H - 10, y = (db) => top + (Math.min(0, Math.max(-60, db)) / -60) * (bot - top);
    g.clearRect(0, 0, W, H);
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = col('--muted', '#999');
    g.textAlign = 'right';
    for (const t of METER_TICKS) { g.fillText(String(t), 30, y(t) + 4); g.fillRect(34, y(t), 4, 1); }
    const lv = capPeaks(), now = Date.now();
    const bars = [['l', 'L', 50], ['r', 'R', 100]];
    for (const [k, name, x] of bars) {
        const v = lv[k] ?? -120, bw = 36;
        g.fillStyle = col('--panel-2', '#222'); g.fillRect(x, top, bw, bot - top);
        const seg = (from, to, color) => { const a = Math.max(from, -60), b = Math.min(to, v); if (b <= a) return; g.fillStyle = color; g.fillRect(x, y(b), bw, y(a) - y(b)); };
        seg(-60, -18, '#2fbf71'); seg(-18, -6, '#e0c22b'); seg(-6, 0, '#ef4b4b');
        const hold = CAPS.hold[k];
        if (v >= hold.v || now - hold.at > 1500) { hold.v = v; hold.at = now; }
        if (hold.v > -60) { g.fillStyle = hold.v > -6 ? '#ef4b4b' : hold.v > -18 ? '#e0c22b' : '#2fbf71'; g.fillRect(x, y(hold.v) - 1, bw, 2); }
        g.fillStyle = col('--text', '#eee'); g.textAlign = 'center';
        g.fillText(name, x + bw / 2, H - 0.5);
        g.fillText(hold.v <= -119 ? '−∞' : hold.v.toFixed(1).replace('-', '−'), x + bw / 2, 14);
        g.textAlign = 'right';
    }
}
let capLevelsAt = 0;
function capLoop() {
    cancelAnimationFrame(CAPS.raf);
    const step = async () => {
        if ($('#view-live').hidden) return;
        // Server preview and the running bridge: levels from the panel (about 7 per second).
        if ((CAPS.mode === 'server' || CAPS.status?.running) && Date.now() - capLevelsAt > 140) {
            capLevelsAt = Date.now();
            try {
                const r = CAPS.status?.running ? null : await localJson('GET', '/local/capture/preview');
                if (r) {
                    CAPS.levels = r.levels || CAPS.levels;
                    if (!r.running && CAPS.mode === 'server') capServerPaused(r);
                }
            } catch { /* panel busy */ }
        }
        capDrawMeter();
        CAPS.raf = requestAnimationFrame(step);
    };
    CAPS.raf = requestAnimationFrame(step);
}
function capServerPaused(r) {
    CAPS.mode = 'paused';
    clearInterval(CAPS.imgT);
    CAPS.levels = { l: -120, r: -120 };
    $('#cap-prev-note').replaceChildren(r.error ? T('Preview stopped: {error} ', { error: r.error }) : T('Preview paused. '), h('button', { class: 'btn ghost small', onclick: capPreview }, T('Resume preview')));
}
// Activity keeps the panel's preview going (it stops after 2 minutes without any).
for (const ev of ['pointerdown', 'keydown']) $('#cap-card').addEventListener(ev, () => { if (CAPS.mode === 'server') localJson('POST', '/local/capture/preview/touch', {}).catch(() => {}); });

// ---- sending
async function capStart() {
    const t = capTarget();
    const vName = $('#cap-video').value, aName = $('#cap-audio').value;
    if (!vName) return toast(T('Choose a camera first.'), 'err');
    if (!t) return toast(T('Add a live input listener first.'), 'err');
    if (!t.enabled) return capEnableListener();
    const playing = S.process === 'active';
    const ok = await confirmModal(playing ? T('Put the camera on air now?') : T('Send the camera to the live input?'), [
        playing ? h('p', { class: 'warn' }, h('b', {}, T('This puts the camera on air now, replacing the playlist.')), T(' The playlist continues when you press Stop.'))
            : h('p', {}, T('The playout is not running now. The camera goes on air as soon as the broadcast is started, until you press Stop.')),
        h('p', { class: 'small' }, h('span', { class: 'muted' }, T('Camera: ')), h('span', { class: 'bidi' }, vName)),
        h('p', { class: 'small' }, h('span', { class: 'muted' }, T('Microphone: ')), aName ? h('span', { class: 'bidi' }, aName) : h('span', {}, T('none (silence)'))),
        h('p', { class: 'small' }, h('span', { class: 'muted' }, T('Format: ')), capFormat()?.label || T('device default'), h('span', { class: 'muted' }, T(' → 1920×1080, 25 fps'))),
    ], { ok: playing ? T('Put on air') : T('Send to live input'), danger: true });
    if (!ok) return;
    $('#cap-start').disabled = true;
    await capRelease();
    await new Promise((r) => setTimeout(r, 300));
    try {
        const r = await localJson('POST', '/local/capture/start', { video: vName, audio: aName, format: capFormat(), confirm: true,
            listener: { id: t.id, name: t.name || '', identifier: t.identifier, enabled: t.enabled, backend: t.backend } });
        CAPS.status = r;
        toast(T('Sending to the live input.'), 'ok');
    } catch (e) { toast(e.message, 'err'); capPreview(); }
    $('#cap-start').disabled = false;
    capDrawState();
    capPoll();
}
$('#cap-start').addEventListener('click', capStart);
$('#cap-stop').addEventListener('click', async () => {
    if (!(await confirmModal(T('Stop sending the camera?'), [T('The live input stops; ffplayout goes back to the playlist.')], { ok: T('Stop') }))) return;
    try { await localJson('POST', '/local/capture/stop', {}); toast(T('Stopping…'), 'ok'); } catch (e) { toast(e.message, 'err'); }
    capPoll();
});
async function capPoll() {
    clearTimeout(capPoll.t);
    let r = null;
    try { r = await localJson('GET', '/local/capture/status'); } catch { /* panel busy */ }
    if (r) {
        const was = CAPS.status?.running;
        CAPS.status = r;
        if (r.running) CAPS.levels = r.levels || CAPS.levels;
        if (was && !r.running && !$('#view-live').hidden) { toast(r.ended?.code ? T('The capture bridge stopped (ffmpeg exit {code}). See logs\\capture.log.', { code: r.ended.code }) : T('Capture stopped.'), r.ended?.code ? 'err' : 'ok'); capPreview(); }
        capDrawState();
    }
    const live = !$('#view-live').hidden;
    if (live || r?.running) capPoll.t = setTimeout(capPoll, r?.running ? 500 : 2000);
}
// A bridge left running by a panel that was killed: red bar on every page, with Stop.
async function capStopLeftover() {
    if (!(await confirmModal(T('Stop the camera?'), [T('A capture bridge started before the panel was restarted is still sending to the live input. Stopping it ends the live picture; ffplayout goes back to the playlist.')], { ok: T('Stop'), danger: true }))) return;
    try { await localJson('POST', '/local/capture/stop', { orphan: true }); toast(T('Stopped.'), 'ok'); } catch (e) { toast(e.message, 'err'); }
    const r = await localJson('GET', '/local/capture/status').catch(() => null);
    if (r) { CAPS.status = r; capAlert(r); if (!$('#view-live').hidden) capDrawState(); }
}
function capAlert(st) {
    const el = $('#cap-alert');
    el.hidden = !st?.orphan;
    if (st?.orphan?.unknown) el.replaceChildren(h('b', {}, T('Camera may still be sending to the live input: check')), ` (ffmpeg process ${st.orphan.pid}, started ${fmtStamp(st.orphan.started)}; the panel could not check it and tries again every 15 s). `,
        h('button', { class: 'btn small danger', onclick: capStopLeftover }, T('Stop')));
    else if (st?.orphan) el.replaceChildren(h('b', {}, T('Camera still sending to the live input')), T(' (started {time}, before the panel was restarted). ', { time: fmtStamp(st.orphan.started) }),
        h('button', { class: 'btn small danger', onclick: capStopLeftover }, T('Stop')));
}
function capDrawState() {
    const st = CAPS.status || {};
    capAlert(st);
    $('#cap-nav').hidden = !st.running;
    $('#cap-onair').hidden = !st.running;
    $('#cap-send').hidden = !!st.running;
    for (const id of ['#cap-video', '#cap-audio', '#cap-format', '#cap-refresh']) $(id).disabled = !!st.running;
    const o = $('#cap-orphan');
    o.hidden = !st.orphan;
    if (st.orphan) o.replaceChildren(h('b', {}, st.orphan.unknown ? T('Camera may still be sending to the live input: check') : T('Camera still sending to the live input')), T(' (process {pid}, started {time}, before the panel was restarted). ', { pid: st.orphan.pid, time: fmtStamp(st.orphan.started) }),
        h('button', { class: 'btn small danger', onclick: capStopLeftover }, T('Stop')));
    $('#cap-nopic').textContent = st.running ? T('No preview while the camera is being sent (the device is in use).') : T('No preview');
    if (!st.running) return;
    $('#cap-onair-what').replaceChildren(h('span', { class: 'bidi' }, st.video), st.audio ? h('span', {}, ' + ', h('span', { class: 'bidi' }, st.audio)) : T(' (no microphone)'), h('span', { class: 'muted' }, ` → ${st.target}`));
    const on = Math.round((Date.now() - st.started) / 1000);
    $('#cap-health').textContent = [T('{v}on air {duration}', { v: st.stopping ? T('Stopping… · ') : '', duration: fmtDur(on) }), `fps ${st.fps != null ? st.fps.toFixed(1) : '—'}`, `dropped ${n0(st.dropped)}`, `${st.bitrate_kbps != null ? `${Math.round(st.bitrate_kbps)} kb/s` : T('— kb/s')}`, `speed ${st.speed != null ? `${st.speed.toFixed(2)}x` : '—'}`].join(' · ');
    $('#cap-errors').textContent = (st.errors || []).slice(-2).map((e) => e.msg).join(' · ');
    if ($('#view-live').hidden === false) capLoop();
}

