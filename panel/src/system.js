// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const path = require('path');
const fs = require('fs');
const R = require('./registry');

// --- system settings and state (cross-app decisions, admin only) -----------------
// data\system.json: settings an administrator decides for the whole installation.
//   on_boot            'continue' (default): after a reboot or an engine restart the channel
//                      is started again when it was on air before; 'stop': it stays off until
//                      someone presses Start.
//   resume_max_age_h   a recorded "on air" older than this is not resumed (default 168 = 7 days):
//                      a PC that was off for weeks must not push a stale output to YouTube.
// data\system-state.json: what the panel last did to the channel (start/stop/restart), written
// when a process command passes through the proxy and ffplayout accepts it. Boot and the
// watchdog read it through POST /local/system/resume.
const SYSTEM_FILE = path.join(R.core.DATA_DIR, 'system.json');
const SYSTEM_STATE = path.join(R.core.DATA_DIR, 'system-state.json');
const SYSTEM_DEFAULTS = { on_boot: 'continue', resume_max_age_h: 168, help_layer: false, tutorial_on_start: true, default_language: 'auto' };
// Switches any signed-in operator may flip (the ? markers and the tutorial); the rest is admin only.
const SYSTEM_UI_KEYS = ['help_layer', 'tutorial_on_start'];
const PANEL_STARTED = Date.now();
function readSystem() {
    try { return { ...SYSTEM_DEFAULTS, ...JSON.parse(fs.readFileSync(SYSTEM_FILE, 'utf8')) }; } catch { return { ...SYSTEM_DEFAULTS }; }
}
function writeSystem(input, { uiOnly = false } = {}) {
    const cur = readSystem();
    const out = { ...cur };
    if (input.on_boot !== undefined) { if (!['continue', 'stop'].includes(input.on_boot)) throw R.blocks.reqErr('on_boot must be "continue" or "stop".'); out.on_boot = input.on_boot; }
    if (input.resume_max_age_h !== undefined) { const n = Number(input.resume_max_age_h); if (!Number.isFinite(n) || n < 1 || n > 24 * 365) throw R.blocks.reqErr('resume_max_age_h must be between 1 and 8760 hours.'); out.resume_max_age_h = Math.round(n); }
    if (input.default_language !== undefined) { if (!/^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/.test(String(input.default_language))) throw R.blocks.reqErr('default_language must be "auto" or a language code.'); out.default_language = String(input.default_language); }
    for (const k of SYSTEM_UI_KEYS) if (input[k] !== undefined) out[k] = input[k] === true;
    // Help/tutorial toggles do not touch the .bak of the admin's decisions, nor the lifeline.
    if (!uiOnly && fs.existsSync(SYSTEM_FILE)) fs.copyFileSync(SYSTEM_FILE, SYSTEM_FILE + '.bak');
    R.core.writeJsonAtomic(SYSTEM_FILE, out, 1);
    if (!uiOnly) R.core.lifeLine(`system settings ${JSON.stringify(out)}`);
    return out;
}
function readSystemState() { try { return JSON.parse(fs.readFileSync(SYSTEM_STATE, 'utf8')); } catch { return null; } }
// Called by the proxy after ffplayout accepted a process command from the panel.
function recordProcessCommand(command) {
    if (!['start', 'stop', 'restart'].includes(command)) return;
    const st = { on_air: command !== 'stop', command, profile: R.library.readState().activeProfile, at: new Date().toISOString(), seen_at: new Date().toISOString() };
    try { R.core.writeJsonAtomic(SYSTEM_STATE, st, 1); } catch (e) { console.error('system state', e.message); }
    R.core.lifeLine(`channel ${command} (${st.profile})`);
}
// Called by the proxy with ffplayout's answer to a status poll: while the channel is on
// air, seen_at is refreshed (at most once a minute) so the resume age limit measures
// time since the channel was last seen running, not time since the last Start click.
let seenWritten = 0;
function noteProcessStatus(status) {
    if (status !== 'active' || Date.now() - seenWritten < 60000) return;
    const st = readSystemState();
    if (!st || !st.on_air) return;
    seenWritten = Date.now();
    try { R.core.writeJsonAtomic(SYSTEM_STATE, { ...st, seen_at: new Date().toISOString() }, 1); } catch { /* next minute */ }
}
// A request's caller must be a ffplayout global admin (checked with its own token).
async function requireAdmin(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw R.blocks.reqErr('Sign in first.', 401);
    // Capability check instead of reading a role field (its name and presence differ
    // between ffplayout builds): listing users is allowed to global admins only.
    let r;
    try { r = await R.automation.ffRaw('GET', '/api/users', undefined, m[1]); } catch { throw R.blocks.reqErr('ffplayout is not reachable.', 502); }
    if (r.status === 401) throw R.blocks.reqErr('Sign in first.', 401);
    if (r.status !== 200) throw R.blocks.reqErr('Only an administrator can change system settings.', 403);
    return true;
}
// Resume after boot or an engine restart: starts the channel when the settings say so and
// the last recorded state was on air. Idempotent: a running channel is left alone.
let resumeBusy = null;
async function systemResume(why = 'boot') {
    if (resumeBusy) return resumeBusy;
    resumeBusy = (async () => {
        const settings = readSystem();
        const st = readSystemState();
        const out = { why, on_boot: settings.on_boot, last: st, action: 'none', detail: '' };
        if (settings.on_boot !== 'continue') {
            // "Stop" is enforced, not only "not started": an engine that brings the channel up
            // by itself at start is stopped again (never from the Test button on the page).
            if (why !== 'test' && R.automation.readSecrets()) {
                if (!R.automation.auto.channelId) { const ch = await R.automation.ffApi('GET', '/api/channels'); R.automation.auto.channelId = ch?.[0]?.id; }
                const state = await R.automation.ffApi('POST', `/api/control/${R.automation.auto.channelId}/process`, { command: 'status' });
                if (state === 'active') { await R.automation.ffApi('POST', `/api/control/${R.automation.auto.channelId}/process`, { command: 'stop' }); out.action = 'stopped'; out.detail = 'System settings say Stop after a restart: the channel, which the engine had started by itself, was stopped.'; R.core.lifeLine(`RESUME ${why}: channel stopped per on_boot=stop`); return out; }
            }
            out.detail = 'System settings: the channel stays stopped after a restart.'; return out;
        }
        if (!st || !st.on_air) { out.detail = st ? `The channel was stopped by hand on ${st.at}.` : 'No recorded state yet.'; return out; }
        const ageH = (Date.now() - Date.parse(st.seen_at || st.at)) / 3600e3;
        if (!(ageH <= settings.resume_max_age_h)) { out.detail = `The last "on air" is ${Math.round(ageH)} h old, over the ${settings.resume_max_age_h} h limit: not resumed.`; return out; }
        if (!R.automation.readSecrets()) { out.detail = 'No automation account is set (Channel & schedule page): the panel cannot start the channel by itself.'; return out; }
        if (!R.automation.auto.channelId) { const ch = await R.automation.ffApi('GET', '/api/channels'); R.automation.auto.channelId = ch?.[0]?.id; }
        const state = await R.automation.ffApi('POST', `/api/control/${R.automation.auto.channelId}/process`, { command: 'status' });
        if (state === 'active') { out.action = 'already running'; out.detail = `The channel is already on air (${state}).`; return out; }
        await R.automation.ffApi('POST', `/api/control/${R.automation.auto.channelId}/process`, { command: 'start' });
        out.action = 'started'; out.detail = `Channel started (${st.profile || 'profile unknown'}, last on air ${st.at}).`;
        R.core.lifeLine(`RESUME ${why}: channel started`);
        return out;
    })().finally(() => { resumeBusy = null; });
    return resumeBusy;
}
function systemStatus() {
    return {
        settings: readSystem(), state: readSystemState(),
        panel: { pid: process.pid, node: process.version, started: new Date(PANEL_STARTED).toISOString(), uptime_s: Math.round((Date.now() - PANEL_STARTED) / 1000), rename_stalls: R.core.renameRetry.stalls, rename_stall_ms: R.core.renameRetry.stallMs, rss_mb: Math.round(process.memoryUsage().rss / 1048576) },
        automation: { account: !!R.automation.readSecrets(), status: R.automation.auto.status },
        share_reachable: fs.existsSync(R.core.MEDIA_ROOT),
    };
}


// ---- exports (read by the other modules through R.system) ----
R.system = module.exports;
Object.assign(module.exports, { SYSTEM_FILE, SYSTEM_STATE, SYSTEM_DEFAULTS, SYSTEM_UI_KEYS, PANEL_STARTED, readSystem, writeSystem, readSystemState, recordProcessCommand, noteProcessStatus, requireAdmin, systemResume, systemStatus });
Object.defineProperty(module.exports, 'seenWritten', { get: () => seenWritten, set: (v) => { seenWritten = v; }, enumerable: true });
Object.defineProperty(module.exports, 'resumeBusy', { get: () => resumeBusy, set: (v) => { resumeBusy = v; }, enumerable: true });
