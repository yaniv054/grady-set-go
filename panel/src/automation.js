// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const R = require('./registry');

// --- schedule feed --------------------------------------------------------------
// The browser builds the 7-day schedule (it has the channel settings) and stores it
// here as data\feed\schedule.json and schedule.xml (XMLTV).
function saveFeed({ json, xml }) {
    if (typeof json !== 'string' || typeof xml !== 'string') throw Object.assign(new Error('json and xml are required'), { status: 400 });
    try { JSON.parse(json); } catch { throw Object.assign(new Error('json is not valid JSON'), { status: 400 }); }
    if (!/^<\?xml[\s\S]*<tv[\s>]/.test(xml)) throw Object.assign(new Error('xml is not XMLTV'), { status: 400 });
    for (const [name, body] of [['schedule.json', json], ['schedule.xml', xml]]) R.core.writeTextAtomic(path.join(R.core.FEED_DIR, name), body);
    return { saved: [path.join(R.core.FEED_DIR, 'schedule.json'), path.join(R.core.FEED_DIR, 'schedule.xml')] };
}

// --- automation: lower thirds with a dedicated ffplayout account -----------------
// The panel server signs in to ffplayout with its own account (stored on this PC in
// data\panel-secrets.json) so overlays keep working with no browser open. At each new
// clip it shows "now" for a few seconds, and "next" shortly before the clip ends.
// Filler, off-air and live standby items are skipped.
const AUTO_DEFAULTS = {
    lower_third: { enabled: false, now_label: 'NOW', next_label: 'NEXT', show_s: 10, next_before_s: 30, font_family: 'DejaVu Sans', font_size: 40, position_x: 'end:96', position_y: 'end:96', background_opacity: 0.7 },
    // Live branding text (Channel Branding page). One text layer at a time: on an explicit
    // clip the tag shows first and the lower third follows it.
    branding_live: { explicit_enabled: false, explicit_text: 'Explicit language', explicit_s: 30, upnext_enabled: false, upnext_label: 'NEXT' },
};
function readAutomation() {
    try { const j = JSON.parse(fs.readFileSync(R.core.AUTOMATION_FILE, 'utf8')); return { lower_third: { ...AUTO_DEFAULTS.lower_third, ...(j.lower_third || {}) }, branding_live: { ...AUTO_DEFAULTS.branding_live, ...(j.branding_live || {}) } }; }
    catch { return structuredClone(AUTO_DEFAULTS); }
}
function writeAutomation(input) {
    const cur = readAutomation();
    const lt = { ...cur.lower_third, ...(input.lower_third || {}) };
    const bl = { ...cur.branding_live, ...(input.branding_live || {}) };
    const out = {
        lower_third: {
            enabled: !!lt.enabled,
            now_label: String(lt.now_label || '').slice(0, 40), next_label: String(lt.next_label || '').slice(0, 40),
            show_s: Math.min(120, Math.max(3, Number(lt.show_s) || 10)), next_before_s: Math.min(300, Math.max(5, Number(lt.next_before_s) || 30)),
            font_family: String(lt.font_family || 'DejaVu Sans').slice(0, 80), font_size: Math.min(120, Math.max(12, Number(lt.font_size) || 40)),
            position_x: String(lt.position_x || 'end:96').slice(0, 30), position_y: String(lt.position_y || 'end:96').slice(0, 30),
            background_opacity: Math.min(1, Math.max(0, Number(lt.background_opacity) || 0)),
        },
        branding_live: {
            explicit_enabled: !!bl.explicit_enabled, explicit_text: String(bl.explicit_text || '').slice(0, 60) || 'Explicit language',
            explicit_s: Math.min(300, Math.max(5, Number(bl.explicit_s) || 30)),
            upnext_enabled: !!bl.upnext_enabled, upnext_label: String(bl.upnext_label || '').slice(0, 40),
        },
    };
    R.core.writeJsonAtomic(R.core.AUTOMATION_FILE, out, 1);
    return out;
}
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(R.core.SECRETS_FILE, 'utf8')); } catch { return null; } };

// Minimal ffplayout API client for the server side (own account, own tokens).
const ff = { access: null, refresh: null, refreshing: null };
function ffRaw(method, p, body, token) {
    return new Promise((resolve, reject) => {
        // Settles exactly once: on the full reply, an error, a dropped connection or after 10 s.
        let done = false;
        const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const r = http.request({ hostname: R.core.UPSTREAM.hostname, port: R.core.UPSTREAM.port, path: p, method, timeout: 10000,
            headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
                settle(resolve, { status: res.statusCode, body: j });
            });
            const dropped = () => settle(reject, new Error('ffplayout closed the connection'));
            res.on('aborted', dropped);
            res.on('error', dropped);
            res.on('close', dropped);
        });
        const timer = setTimeout(() => { r.destroy(); settle(reject, new Error('ffplayout timeout')); }, 10000);
        r.on('timeout', () => r.destroy(new Error('ffplayout timeout')));
        r.on('error', (e) => settle(reject, e));
        if (data) r.write(data);
        r.end();
    });
}
async function ffLogin(creds = readSecrets()) {
    if (!creds?.username || !creds?.password) throw Object.assign(new Error('No automation account is set.'), { status: 400 });
    const r = await ffRaw('POST', '/auth/login', { username: creds.username, password: creds.password });
    if (r.status !== 200 || !r.body?.access) throw Object.assign(new Error(r.status === 200 ? 'This account needs two-factor sign-in; use an account without it.' : `ffplayout refused the sign-in (HTTP ${r.status}).`), { status: 400 });
    ff.access = r.body.access; ff.refresh = r.body.refresh;
    return true;
}
async function ffRefresh() {
    if (!ff.refreshing) {
        ff.refreshing = (async () => {
            if (ff.refresh) {
                const r = await ffRaw('POST', '/auth/refresh', { refresh: ff.refresh });
                if (r.status === 200 && r.body?.access) { ff.access = r.body.access; ff.refresh = r.body.refresh; return; }
            }
            await ffLogin();
        })().finally(() => { ff.refreshing = null; });
    }
    return ff.refreshing;
}
async function ffApi(method, p, body) {
    if (!ff.access) await ffLogin();
    let sent = ff.access;
    let r = await ffRaw(method, p, body, sent);
    if (r.status === 401) { if (ff.access === sent) await ffRefresh(); sent = ff.access; r = await ffRaw(method, p, body, sent); }
    if (r.status >= 400) throw Object.assign(new Error(`ffplayout ${method} ${p}: HTTP ${r.status}`), { status: 502 });
    return r.body;
}

const auto = { status: 'off', error: null, lastText: null, lastAt: null, channelId: null, config: null, configAt: 0, item: null, timers: [] };
function textPreset(text, lt) {
    return {
        name: 'Lower third', text, use_filename: false, persistent: false, filename_regex: '',
        font_family: lt.font_family, font_weight: 'bold', font_size: lt.font_size, line_spacing: 4,
        position_x: lt.position_x, position_y: lt.position_y,
        text_color: '#ffffff', text_opacity: 1, opacity: 1,
        background_enabled: lt.background_opacity > 0, background_color: '#000000', background_opacity: lt.background_opacity, background_padding: 14,
        scroll_direction: 'none', scroll_speed: 100, scroll_repeat: -1, fade_in_seconds: 0.5, fade_out_seconds: 0.5,
    };
}
async function sendText(text, lt) {
    await ffApi('POST', `/api/control/${auto.channelId}/text`, textPreset(text, lt));
    auto.lastText = text; auto.lastAt = new Date().toISOString();
}
const lineFor = (label, src) => {
    const row = R.media.library().get(String(src).toLowerCase());
    const m = row ? R.metadata.metaOf(row.id, row) : { title: path.basename(String(src)).replace(/\.[^.]+$/, '') };
    return [label, [m.title, m.performer].filter(Boolean).join(' · ')].filter(Boolean).join(': ');
};
// Cancels pending text changes; with `lt`, also takes any text still on air off.
function clearTimers(lt) {
    for (const t of auto.timers) clearTimeout(t);
    auto.timers = [];
    if (lt && auto.lastText && auto.channelId) sendText('', lt).catch(() => {});
}
async function autoTick() {
    const am = readAutomation(), lt = am.lower_third, bl = am.branding_live;
    if (!lt.enabled && !bl.explicit_enabled && !bl.upnext_enabled) { if (auto.status !== 'off') { clearTimers(readSecrets() ? lt : null); auto.status = 'off'; auto.item = null; } return; }
    if (!readSecrets()) { auto.status = 'no account'; return; }
    try {
        if (!auto.channelId) { const ch = await ffApi('GET', '/api/channels'); auto.channelId = ch?.[0]?.id; }
        if (!auto.config || Date.now() - auto.configAt > 10 * 60000) { auto.config = await ffApi('GET', `/api/playout/config/${auto.channelId}`); auto.configAt = Date.now(); }
        const cur = await ffApi('GET', `/api/control/${auto.channelId}/media/current`);
        const fetchedAt = Date.now();
        auto.status = 'running'; auto.error = null;
        const src = cur?.media?.source;
        const key = src ? `${cur.index}|${src}` : null;
        if (key === auto.item) return;
        auto.item = key;
        clearTimers();
        // Takes off a text left on air by the previous item (its timed clear was cancelled).
        const blank = () => { if (auto.lastText) return sendText('', lt).catch(() => {}); };
        if (!src || cur.ingest) return blank();
        // Item length; without one, the library length; without that, no timed texts.
        let len = Number(cur.media.out ?? cur.media.duration) - Number(cur.media.in || 0);
        if (!(Number.isFinite(len) && len > 0)) len = Number(R.media.library().get(String(src).toLowerCase())?.duration_s) || NaN;
        const timed = Number.isFinite(len) && len > 0;
        const elapsed0 = Number(cur.played ?? cur.elapsed ?? 0) || 0;
        // Seconds left in this item, counted from when `cur` was fetched.
        const remaining = () => len - elapsed0 - (Date.now() - fetchedAt) / 1000;
        const dayStart = parseHms(auto.config?.playlist?.day_start) || 0;
        // Wall-clock broadcast day (the same rule as the rest of the panel; DST-safe).
        const date = R.songs.broadcastToday();
        // The playing day's program, fetched at most once per new item.
        let progP = null;
        const getProgram = () => (progP = progP || ffApi('GET', `/api/playlist/${auto.channelId}?date=${date}`).then((p) => (Array.isArray(p?.program) ? p.program : null)).catch(() => null));
        const loadNext = async () => (await getProgram())?.[Number(cur.index) + 1];
        // Inside a quiet saved block: no lower third, explicit tag or up-next text, and any text on air is taken off.
        if (await R.blocks.quietItem(date, cur.index, src, dayStart, getProgram)) return blank();
        // Up-next background playing: draw "next: title" in the middle for its length.
        if (R.branding.brandTypeOf(src) === 'upnext') {
            if (!bl.upnext_enabled || !timed) return blank();
            const n = await loadNext();
            if (!n || R.asrun.STORAGE_KIND(n.source) || await R.blocks.quietItem(date, Number(cur.index) + 1, n.source, dayStart, getProgram)) return blank();
            await sendText(lineFor(bl.upnext_label, n.source), { ...lt, font_size: Math.round(lt.font_size * 1.4), position_x: 'center:0', position_y: 'center:0', background_opacity: 0 });
            auto.timers.push(setTimeout(() => sendText('', lt).catch(() => {}), Math.max(1, remaining() - 0.3) * 1000));
            return;
        }
        if (R.asrun.STORAGE_KIND(src)) return blank();
        // Explicit-language tag first (top corner), then the lower third.
        let delay = 0;
        const row = R.media.library().get(String(src).toLowerCase());
        if (bl.explicit_enabled && row && R.metadata.metaOf(row.id, row).explicit === 'yes') {
            await sendText(bl.explicit_text, { ...lt, font_size: Math.round(lt.font_size * 0.8), position_x: 'end:96', position_y: 'start:60' });
            auto.timers.push(setTimeout(() => sendText('', lt).catch(() => {}), bl.explicit_s * 1000));
            delay = bl.explicit_s + 1;
        }
        if (!lt.enabled) { if (!delay) blank(); return; }
        if (delay) auto.timers.push(setTimeout(() => sendText(lineFor(lt.now_label, src), lt).catch(() => {}), delay * 1000));
        else await sendText(lineFor(lt.now_label, src), lt);
        auto.timers.push(setTimeout(() => sendText('', lt).catch(() => {}), (delay + lt.show_s) * 1000));
        // "Next": the following playlist item, shown next_before_s before this one ends.
        if (!timed) return;
        const nxt = await loadNext();
        const wait = (remaining() - lt.next_before_s) * 1000;
        // No "next" line announcing an item of a quiet block.
        if (nxt && !R.asrun.STORAGE_KIND(nxt.source) && wait > lt.show_s * 1000 && !(await R.blocks.quietItem(date, Number(cur.index) + 1, nxt.source, dayStart, getProgram))) {
            auto.timers.push(setTimeout(() => sendText(lineFor(lt.next_label, nxt.source), lt).catch(() => {}), wait));
            auto.timers.push(setTimeout(() => sendText('', lt).catch(() => {}), wait + lt.show_s * 1000));
        }
    } catch (e) { auto.status = 'error'; auto.error = e.message; auto.item = null; }
}
function parseHms(s) { const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN; }
// autoBusy = start time of the running tick. A tick stuck for over 30 s is abandoned
// (it can no longer clear the flag of the tick that replaced it).
let autoBusy = 0;
setInterval(() => {
    if (autoBusy) {
        if (Date.now() - autoBusy < 30000) return;
        console.error('automation: a check has been stuck for 30 s; starting a new one');
    }
    const mine = autoBusy = Date.now();
    autoTick().finally(() => { if (autoBusy === mine) autoBusy = 0; });
}, 2000);
// Adds clip IDs to archived as-run entries written before IDs were stored (once at start).
function backfillAsrunIds() {
    let files = [];
    try { files = fs.readdirSync(R.core.ASRUN_DIR).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch { return; }
    for (const f of files) {
        const file = path.join(R.core.ASRUN_DIR, f);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        let changed = 0;
        const out = lines.map((l) => {
            if (!l) return l;
            let e; try { e = JSON.parse(l); } catch { return l; }
            if (e.id || R.asrun.STORAGE_KIND(e.source)) return l;
            const id = R.media.idForPath(e.source);
            if (!id) return l;
            changed++;
            return JSON.stringify({ ...e, id });
        });
        if (changed) { fs.writeFileSync(file + '.tmp', out.join('\n'), 'utf8'); R.core.renameRetry(file + '.tmp', file); }
    }
}
setTimeout(() => { try { backfillAsrunIds(); } catch (e) { console.error('as-run backfill', e.message); } }, 3000);

// Keep the as-run archive current even when nobody opens the page.
setInterval(() => { try { R.asrun.syncAsrun(true); } catch (e) { console.error('as-run sync', e.message); } }, 5 * 60000);


// ---- exports (read by the other modules through R.automation) ----
R.automation = module.exports;
Object.assign(module.exports, { saveFeed, AUTO_DEFAULTS, readAutomation, writeAutomation, readSecrets, ff, ffRaw, ffLogin, ffRefresh, ffApi, auto, textPreset, sendText, lineFor, clearTimers, autoTick, parseHms, backfillAsrunIds });
Object.defineProperty(module.exports, 'autoBusy', { get: () => autoBusy, set: (v) => { autoBusy = v; }, enumerable: true });
