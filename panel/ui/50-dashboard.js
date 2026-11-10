// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 50-dashboard. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- dashboard

let hls = null, hlsRetry = null, nativeHls = false;
function stopPlayer() {
    clearTimeout(hlsRetry);
    hlsRetry = null;
    if (hls) { hls.destroy(); hls = null; }
    if (nativeHls) { const v = $('#player'); v.removeAttribute('src'); v.load(); nativeHls = false; }
}
function renderDashboard() {
    renderStatus();
    loadSystem();
    const url = `/public/${S.channelId}/live/${S.config.output.hls_playlist_name || 'stream'}.m3u8`;
    $('#hls-url').textContent = location.origin + url;
    setupPlayer(url);
}

// Elapsed / remaining for the clip on air. ffplayout's media/current reports `elapsed`
// (seconds into the clip, on the same scale as media.out); between polls it is advanced
// locally every second.
function renderNowTime() {
    const c = S.current;
    const box = $('#now-time');
    const out = Number(c?.media?.out);
    // ffplayout reports the position as `played` (newer builds) or `elapsed`; both count
    // from the clip's in point.
    const el = Number(c?.played ?? c?.elapsed);
    if (S.process !== 'active' || !c?.media || c.ingest || !Number.isFinite(out) || !Number.isFinite(el) || out <= 0) { box.hidden = true; return; }
    const start = Number(c.media.in) || 0;
    const len = Math.max(0, out - start);
    const pos = Math.min(len, Math.max(0, el + (Date.now() - (S.curAt || Date.now())) / 1000));
    const left = Math.max(0, len - pos);
    box.hidden = false;
    $('#now-progress').firstElementChild.style.width = `${Math.min(100, Math.max(0, (pos / Math.max(1, len)) * 100))}%`;
    $('#now-elapsed').textContent = `${fmtDur(pos)} / ${fmtDur(len)}`;
    $('#now-remaining').textContent = `−${fmtDur(left)}`;
    // Real time of day: when this clip started and when it ends.
    const clock = (d) => d.toTimeString().slice(0, 8);
    $('#now-started').textContent = T('started {clock}', { clock: clock(new Date(Date.now() - pos * 1000)) });
    $('#now-ends').textContent = T('ends {clock}', { clock: clock(new Date(Date.now() + left * 1000)) });
}
setInterval(() => { if (!$('#view-dashboard').hidden) renderNowTime(); }, 1000);

function renderStatus() {
    const running = S.process === 'active';
    $('#st-process').textContent = running ? T('Running') : S.process ? T('Stopped') : '—';
    $('#st-process').style.color = running ? 'var(--ok)' : 'var(--muted)';
    const p = activeProfile();
    $('#st-output').textContent = PROFILE_NAMES[p] || p;
    $('#st-output').style.color = p === 'yt-prod' ? 'var(--air)' : '';
    const c = S.current;
    $('#st-ingest').textContent = c?.ingest ? T('LIVE: {v}', { v: c.ingest_listener_name || c.ingest_listener_backend || 'input' }) : T('Idle');
    $('#st-ingest').style.color = c?.ingest ? 'var(--air)' : 'var(--muted)';
    renderNowTime();
    const nowSrc = c?.media?.source || '';
    // Preview off (a YouTube output is active): show a still of the current clip behind the message.
    const still = $('#player-still');
    const stillSrc = running && activeProfile() !== 'preview' ? nowSrc : '';
    if (still.dataset.src !== stillSrc) {
        still.dataset.src = stillSrc;
        still.hidden = true;
        if (stillSrc) {
            const bt = brandTypeOfSrc(stillSrc);
            still.onload = () => { still.hidden = false; };
            still.onerror = () => { still.hidden = true; };
            still.src = bt ? brandThumbUrl(stillSrc) : `/local/thumb?path=${encodeURIComponent(stillSrc)}`;
        } else still.removeAttribute('src');
    }
    const nimg = $('#now-thumb');
    if (nimg.dataset.src !== nowSrc) {
        nimg.dataset.src = nowSrc;
        nimg.hidden = true;
        if (nowSrc) { nimg.onload = () => { nimg.hidden = false; }; nimg.onerror = () => { nimg.hidden = true; }; nimg.src = `/local/thumb?path=${encodeURIComponent(nowSrc)}`; }
        else nimg.removeAttribute('src');
    }
    if (c && c.media && c.media.source) {
        $('#now-title').textContent = bidiText(c.media.title || baseName(c.media.source));
        $('#now-meta').textContent = T('Item {v} · {duration} · {name}{v2}', { v: Number(c.index) + 1, duration: fmtDur((c.media.out || 0) - (c.media.in || 0)), name: bidiText(dirName(c.media.source)), v2: c.media.ad ? T(' · AD') : '' });
    } else {
        $('#now-title').textContent = running ? T('Starting…') : T('Nothing playing');
        $('#now-meta').textContent = '';
    }
    $$('[data-process]').forEach((b) => (b.disabled = (b.dataset.process === 'start') === running));
    $$('[data-control]').forEach((b) => (b.disabled = !running));
    // Start (or stop) the preview when the playout was started, stopped or switched elsewhere.
    const want = running && activeProfile() === 'preview';
    // Only once renderDashboard has set the stream URL.
    if (setupPlayer.url && !$('#view-dashboard').hidden && !hlsRetry && want !== (!!hls || nativeHls)) setupPlayer();
}

async function loadSystem() {
    try {
        const s = await api('GET', `/api/system/${S.channelId}`);
        const gb = (b) => (b / 1e9).toFixed(1) + ' GB';
        $('#sys').replaceChildren(
            h('dt', {}, T('CPU')), h('dd', {}, T('{v}% of {cores} cores', { v: s.cpu.usage.toFixed(0), cores: s.cpu.cores })),
            h('dt', {}, T('Memory')), h('dd', {}, `${gb(s.memory.used)} / ${gb(s.memory.total)}`),
            h('dt', {}, T('Storage free')), h('dd', {}, `${gb(s.storage.free)} / ${gb(s.storage.total)}`),
            h('dt', {}, 'ffplayout'), h('dd', {}, T('v{ffp_version} on {name} {version}', { ffp_version: s.system.ffp_version, name: s.system.name, version: s.system.version })),
        );
    } catch { /* optional */ }
}

function setupPlayer(url) {
    const video = $('#player');
    const msg = $('#player-msg');
    url = url || setupPlayer.url;
    setupPlayer.url = url;
    stopPlayer();
    if (activeProfile() !== 'preview' || S.process !== 'active') {
        msg.hidden = false;
        msg.textContent = activeProfile() !== 'preview'
            ? T('Preview is off while the output is {v}. Watch it on YouTube Studio instead.', { v: PROFILE_NAMES[activeProfile()] || activeProfile() })
            : T('Start the playout to see the preview.');
        return;
    }
    msg.hidden = true;
    if (window.Hls && Hls.isSupported()) {
        hls = new Hls({ liveSyncDurationCount: 3 });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, d) => {
            if (!d.fatal) return;
            msg.hidden = false;
            msg.textContent = T('Waiting for the first HLS segments…');
            clearTimeout(hlsRetry);
            hlsRetry = setTimeout(() => { hlsRetry = null; if (!$('#view-dashboard').hidden) setupPlayer(); }, 4000);
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        nativeHls = true;
    } else {
        msg.hidden = false;
        msg.textContent = T('This browser cannot play HLS (hls.js did not load).');
    }
}

$$('[data-process]').forEach((b) => b.addEventListener('click', async () => {
    const cmd = b.dataset.process;
    const p = activeProfile();
    if (cmd !== 'stop' && p === 'yt-prod' && !(await confirmModal(T('Go on air?'), T('This sends the program to the PRODUCTION YouTube channel.'), { ok: T('Go on air'), danger: true, requireText: 'PRODUCTION' }))) return;
    // Any output other than the local preview is a stream somebody may be watching.
    if (cmd === 'stop' && p !== 'preview' && S.process !== 'stopped' && !(await confirmModal(T('Stop playout?'), T('This ends the stream to {v}.', { v: PROFILE_NAMES[p] || 'the configured output' }), { ok: T('Stop'), danger: true }))) return;
    try { await api('POST', `/api/control/${S.channelId}/process`, { command: cmd }); toast(T('Playout: {cmd}', { cmd }), 'ok'); [600, 1500, 3000].forEach((ms) => setTimeout(poll, ms)); setTimeout(() => { if (!$('#view-dashboard').hidden) setupPlayer(); }, 2500); }
    catch (e) { toast(e.message, 'err'); }
}));
$$('[data-control]').forEach((b) => b.addEventListener('click', async () => {
    try {
        const r = await api('POST', `/api/control/${S.channelId}/playout`, { control: b.dataset.control });
        toast(r && r.operation === 'ignored' ? T('Ignored: a live input is on air') : T('Playout: {control}', { control: b.dataset.control }), r && r.operation === 'ignored' ? 'err' : 'ok');
        // The engine moves at once: refresh the position quickly, then again as it settles.
        [300, 1200, 2500].forEach((ms) => setTimeout(poll, ms));
    } catch (e) { toast(e.message, 'err'); }
}));

