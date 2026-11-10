// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 40-status. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- system settings
const isAdmin = () => S.isAdmin === true;
async function renderSystem() {
    if (!isAdmin()) { location.hash = 'dashboard'; return; }
    const f = $('#sys-form');
    let r;
    try { r = await localJson('GET', '/local/system'); } catch (e) { return toast(e.message, 'err'); }
    // A redraw caused by a display-language or date-order change must not throw away what is typed but not saved yet.
    const keep = f.dataset.dirty === '1' ? { on_boot: f.on_boot.value, age: f.resume_max_age_h.value, lang: f.default_language.value } : null;
    f.on_boot.value = keep ? keep.on_boot : r.settings.on_boot;
    f.resume_max_age_h.value = keep ? keep.age : r.settings.resume_max_age_h;
    fillLanguageSelects();
    f.default_language.value = keep ? keep.lang : (r.settings.default_language || 'auto');
    if (typeof helpSyncSystem === 'function') helpSyncSystem(r.settings);
    const st = r.state;
    const rows = [
        [T('Last channel command'), st ? `${st.command} · ${st.on_air ? T('on air') : T('stopped')} · ${PROFILE_NAMES[st.profile] || st.profile || ''} · ${fmtStamp(st.at)}` : T('none recorded yet')],
        [T('Would resume now'), st?.on_air && r.settings.on_boot === 'continue' ? T('yes') : T('no')],
        [T('Automation account'), r.automation.account ? T('set ({status})', { status: r.automation.status }) : T('not set — needed for resume')],
        [T('Media share'), r.share_reachable ? T('reachable') : T('NOT reachable')],
        [T('Panel'), T('pid {pid} · node {node} · up {span} · {rss_mb} MB', { pid: r.panel.pid, node: r.panel.node, span: fmtSpan(r.panel.uptime_s), rss_mb: r.panel.rss_mb })],
        [T('File-lock waits'), r.panel.rename_stalls ? T('{rename_stalls} ({rename_stall_ms} ms total) since start', { rename_stalls: r.panel.rename_stalls, rename_stall_ms: r.panel.rename_stall_ms }) : T('none since start')],
    ];
    $('#sys-status').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}
$('#sys-reload').addEventListener('click', () => { $('#sys-form').dataset.dirty = ''; renderSystem(); });
$('#sys-form').addEventListener('change', (e) => { if (e.target.id !== 'sys-dateorder') e.currentTarget.dataset.dirty = '1'; });
$('#sys-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, msg = $('#sys-msg');
    const body = { on_boot: f.on_boot.value, resume_max_age_h: Number(f.resume_max_age_h.value), default_language: f.default_language.value };
    if (body.on_boot === 'stop' && !(await confirmModal(T('Stay off after a restart?'), T('After a reboot or an engine crash the channel will stay off air until someone signs in and presses Start.'), { ok: T('Stay off'), danger: true }))) return;
    msg.textContent = '';
    try { await api('PUT', '/local/system', body); f.dataset.dirty = ''; msg.className = 'form-msg ok'; msg.textContent = T('Saved.'); renderSystem(); } // api(): the token proves the admin role
    catch (err) { msg.className = 'form-msg err'; msg.textContent = err.message; }
});
$('#sys-resume').addEventListener('click', async () => {
    const out = $('#sys-action');
    if (!(await confirmModal(T('Run the resume decision now?'), T('This does exactly what the boot script does: if the settings and the last recorded state say so, the channel is started now.'), { ok: T('Run') }))) return;
    try { const r = await localJson('POST', '/local/system/resume', { why: 'test' }); out.className = 'form-msg ok'; out.textContent = `${r.action}: ${r.detail}`; renderSystem(); poll(); }
    catch (e) { out.className = 'form-msg err'; out.textContent = e.message; }
});
$('#sys-restart').addEventListener('click', async () => {
    if (!(await confirmModal(T('Restart the panel?'), T('The panel exits now and the boot watchdog starts it again within two to three minutes (not while the file data\\WATCHDOG_OFF exists). The stream and any capture bridge keep running; this page will show "Connection lost" meanwhile.'), { ok: T('Restart panel'), danger: true }))) return;
    try { await api('POST', '/local/system/restart', {}); toast(T('Panel restarting…')); } catch (e) { toast(e.message, 'err'); }
});

// ---------------------------------------------------------------- status

function activeProfile() {
    const mode = S.config?.output?.mode;
    if (mode === 'hls') return 'preview';
    if (mode === 'stream') return S.local?.activeProfile === 'yt-prod' ? 'yt-prod' : S.local?.activeProfile === 'yt-test' ? 'yt-test' : 'stream';
    return mode || '';
}
const PROFILE_NAMES = i18nLazy({ preview: N_('HLS preview'), 'yt-test': N_('YouTube TEST'), 'yt-prod': N_('YouTube PRODUCTION'), stream: N_('Stream (custom)'), desktop: N_('Desktop window') });

function renderOnAir() {
    const p = activeProfile();
    const running = S.process === 'active';
    const el = $('#onair');
    const dot = $('#brand-dot');
    dot.className = 'dot' + (running ? (p === 'yt-prod' ? ' air' : ' ok') : '');
    if (running && (p === 'yt-test' || p === 'yt-prod')) {
        el.hidden = false;
        el.className = 'onair ' + (p === 'yt-prod' ? 'prod' : 'test');
        el.replaceChildren(h('span', { class: 'dot air' }), p === 'yt-prod' ? T('ON AIR: YouTube PRODUCTION') : T('Streaming to YouTube TEST (personal channel)'));
    } else el.hidden = true;
}

async function poll() {
    if ($('#app').hidden || poll.busy) return;
    // Every 15 s instead of 3 s while the tab is in the background.
    if (document.hidden && Date.now() - (poll.at || 0) < 15000) return;
    poll.busy = true;
    poll.at = Date.now();
    try {
        const [proc, cur] = await Promise.all([
            api('POST', `/api/control/${S.channelId}/process`, { command: 'status' }, { timeout: 10000 }),
            api('GET', `/api/control/${S.channelId}/media/current`, undefined, { timeout: 10000 }).catch(() => null),
        ]);
        S.process = proc;
        S.current = cur;
        S.curAt = Date.now();
        renderOnAir();
        renderSchedAlert();
        pollOutHealth();
        if (!$('#view-dashboard').hidden) renderStatus();
        if (!$('#view-program').hidden) markNowPlaying();
        // A capture device sent to the live input: the LIVE mark next to "Live input" (every 15 s).
        if (!poll.capAt || Date.now() - poll.capAt > 15000) { poll.capAt = Date.now(); localJson('GET', '/local/capture/status').then((r) => { if ($('#view-live').hidden) { CAPS.status = r; $('#cap-nav').hidden = !r.running; } capAlert(r); }).catch(() => {}); }
        // Needs attention highlights the clip on air now: refresh when it changes.
        if ((cur?.media?.source || '') !== (S.onairSrc || '') && !$('#view-attention').hidden && S.attn.data) renderAttention();
    } catch { /* transient */ } finally { poll.busy = false; }
}

// ---------------------------------------------------------------- output health
// What this PC can see of the stream: whether the encoder reports trouble sending it
// (from the engine log). What YouTube does with it shows only in YouTube Studio.
S.outHealth = null;
async function pollOutHealth() {
    const p = activeProfile();
    if (!['yt-test', 'yt-prod', 'stream'].includes(p)) { S.outHealth = null; renderOutHealth(); return; }
    if (S.outHealthAt && Date.now() - S.outHealthAt < 8000) { renderOutHealth(); return; }
    S.outHealthAt = Date.now();
    try { S.outHealth = await localJson('GET', '/local/output-health'); } catch { /* keep the last one */ }
    renderOutHealth();
}
const hhmm = (at) => { const d = new Date(at); const t = d.toTimeString().slice(0, 5); return isoDate(d) === isoDate(new Date()) ? t : `${fmtDate(isoDate(d))} ${t}`; };
function outHealthState() {
    const p = activeProfile();
    if (!['yt-test', 'yt-prod', 'stream'].includes(p)) return null;
    const h = S.outHealth;
    if (S.process !== 'active') return { cls: 'off', text: T('Not sending: the playout is stopped.') };
    if (!h) return { cls: 'off', text: T('Checking the encoder…') };
    if (!h.log) return { cls: 'warn', text: T('The engine log was not found, so the panel cannot tell whether the stream is leaving this PC.') };
    const last = h.last_error;
    if (last && Date.now() - last.at < 120000) {
        const first = (h.recent || []).find((e) => Date.now() - e.at < 120000) || last;
        return { cls: 'bad', text: T('Problem sending since {hhmm}: {text}', { hhmm: hhmm(first.at), text: last.text }), title: (h.recent || []).map((e) => `${hhmm(e.at)}  ${e.text}`).join('\n') };
    }
    if (last) return { cls: 'warn', text: T('Sending. Last error at {hhmm} ({error_count} since the playout started), none in the last 2 minutes: {text}', { hhmm: hhmm(last.at), error_count: h.error_count, text: last.text }), title: (h.recent || []).map((e) => `${hhmm(e.at)}  ${e.text}`).join('\n') };
    return { cls: 'ok', text: T('Sending from this PC{v}; the encoder reports no errors. Whether YouTube receives it shows in YouTube Studio → Stream health.', { v: h.started_at ? T(' since {hhmm}', { hhmm: hhmm(h.started_at) }) : '' }) };
}
function renderOutHealth() {
    const st = outHealthState();
    for (const el of $$('.out-health')) {
        el.hidden = !st;
        if (!st) continue;
        el.className = `out-health ${st.cls}`;
        el.textContent = st.text;
        el.title = st.title || '';
    }
}

// ---------------------------------------------------------------- schedule alerts

// Broadcast date at a moment: before day_start it still belongs to the previous day.
function broadcastDate(d = new Date()) {
    const start = parseHms(S.config?.playlist?.day_start) || 0;
    // By the wall clock, as the server does: "now minus N seconds" is an hour off between
    // midnight and the day start on the night the clocks change.
    const x = new Date(d.getTime());
    if (x.getHours() * 3600 + x.getMinutes() * 60 + x.getSeconds() < start) x.setDate(x.getDate() - 1);
    return isoDate(x);
}
// True when a change to this date's playlist takes effect on air right now.
const isOnAirDay = (date) => S.process === 'active' && date === broadcastDate();

// The saved program of a date ([] when there is none).
async function savedProgram(date) {
    try {
        const p = await api('GET', `/api/playlist/${S.channelId}?date=${date}`);
        return p && Array.isArray(p.program) ? p.program : [];
    } catch (e) {
        if (/not found|no such|404/i.test(e.message)) return [];
        throw e;
    }
}
// A playlist counts as present when it has at least one item.
const playlistExists = async (date) => (await savedProgram(date)).length > 0;

S.missing = [];
S.occAlerts = [];
async function checkSchedule() {
    if (S.config?.processing?.mode !== 'playlist' || S.config?.playlist?.infinit) { S.missing = []; S.occAlerts = []; renderSchedAlert(); return; }
    const today = broadcastDate();
    const days = [today, addDays(today, 1)];
    // Each date's playlist is fetched once (today and tomorrow, plus occasion dates in the next 7 days).
    const progs = new Map();
    const prog = (d) => { if (!progs.has(d)) progs.set(d, savedProgram(d)); return progs.get(d); };
    try {
        const have = await Promise.all(days.map(async (d) => (await prog(d)).length > 0));
        S.missing = days.filter((_, i) => !have[i]);
    } catch { /* keep the previous state */ }
    // Occasion days coming up: their pinned blocks must be in the saved playlist.
    try {
        const up = (await localJson('GET', `/local/occasions/upcoming?from=${today}&days=7`)).dates;
        const lists = await Promise.all(up.map((o) => prog(o.date)));
        const alerts = [];
        up.forEach((o, i) => {
            const p = lists[i];
            if (!p.length) { alerts.push(`${bidiText(o.occasion)} on ${fmtDate(o.date)}: no saved playlist${o.pins.length ? ` (pinned: ${o.pins.map((x) => `“${bidiText(x.name)}” at ${x.start}`).join(', ')})` : ''}.`); return; }
            // All pins of the date at once: two pins with the same files need two occurrences.
            const ds = parseHms(S.config.playlist.day_start) || 0;
            const taken = new Uint8Array(p.length);
            const m = matchPlacements(p, o.pins.map((x) => ({ sources: x.sources, start: x.start })), ds, taken);
            o.pins.forEach((x, k) => {
                if (m[k] || x.alt.some((seq) => seq.length && matchPlacements(p, [{ sources: seq, start: x.start }], ds, taken)[0])) return;
                alerts.push(T('{name} on {date}: block “{name2}” not in the saved playlist.', { name: bidiText(o.occasion), date: fmtDate(o.date), name2: bidiText(x.name) }));
            });
        });
        S.occAlerts = alerts;
    } catch { /* keep the previous state */ }
    renderSchedAlert();
}

function fillerOnAir() {
    const src = S.current?.media?.source;
    const filler = S.config?.storage?.filler;
    if (S.process !== 'active' || !src || !filler || S.current?.ingest) return false;
    const norm = (x) => String(x).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
    const root = norm(S.channel?.storage || '');
    const f = norm(filler);
    const full = /^[a-z]:|^\\\\/.test(f) ? f : `${root}\\${f}`;
    const s = norm(src);
    return s === full || s.startsWith(full + '\\');
}

function renderSchedAlert() {
    const el = $('#sched-alert');
    const msgs = [];
    if (fillerOnAir()) msgs.push(T('The filler is on air: the schedule has a gap or a file failed.'));
    // Live slot reached but no live source connected (the standby image is on air).
    if (S.process === 'active' && isLiveSlot(S.current?.media?.source) && !S.current?.ingest) msgs.push(T('LIVE SLOT: no live signal — the standby image is on air. Check the encoder.'));
    const today = broadcastDate();
    for (const d of S.missing) msgs.push(T('No playlist for {v} ({date}).', { v: d === today ? 'today' : 'tomorrow', date: fmtDate(d) }));
    msgs.push(...S.occAlerts);
    el.hidden = !msgs.length;
    if (msgs.length) el.replaceChildren(h('b', {}, T('Schedule: ')), msgs.join(' '), ' ', h('a', { href: '#program' }, T('Open Program')));
}

