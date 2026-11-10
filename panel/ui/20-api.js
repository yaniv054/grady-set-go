// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 20-api. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- API

// fetch() rejects with a bare "Failed to fetch" when the panel or ffplayout is
// briefly down (e.g. restarting). Turn that into a readable message and a banner
// that clears itself once requests succeed again.
function setConnection(ok) {
    const el = $('#conn');
    if (!el) return;
    el.hidden = ok;
}
// GET requests time out after 15 s (poll uses 10 s). Other methods have no timeout:
// uploads, Generate and analysis starts can take long.
// Panel actions carry this browser session's id (the Undo… list is per session), and, while a
// playlist save is recorded, the id of that undo entry (its block marks join the same entry).
// Requests the server may record for undo (the same routes as UNDO_ROUTES in server.js).
const UNDOABLE = /^\/local\/(attention\/|meta\/(clip|bulk|import|docs)|analysis\/apply|songs\/update|blocks($|\/remove|\/placements)|occasions($|\/remove)|branding\/(rules|remove|use|upload)|templates|automation$|state$|logo$|undo)/;
const PANEL_SESSION = (() => { try { let v = sessionStorage.getItem('pcr.session'); if (!v) { v = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('pcr.session', v); } return v; } catch { return Math.random().toString(36).slice(2, 12); } })();
async function netFetch(url, opts = {}, timeout = (!opts.method || opts.method === 'GET') ? 15000 : 0) {
    const ctl = timeout ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
    const local = String(url).startsWith('/local/') && opts.method && opts.method !== 'GET';
    // Each change request gets a number: an Undo button goes only to the toast of the request it belongs to.
    const mut = local && UNDOABLE.test(String(url)) ? (S.mutSeq = (S.mutSeq || 0) + 1) : S.mutSeq || 0;
    if (local) opts = { ...opts, headers: { ...(opts.headers || {}), 'X-Panel-Session': PANEL_SESSION, ...(S.undoGroup ? { 'X-Undo-Group': S.undoGroup } : {}) } };
    try {
        const r = await fetch(url, ctl ? { ...opts, signal: ctl.signal } : opts);
        setConnection(r.status !== 502);
        if (local && r.ok && r.headers.get('X-Undo-Id')) noteUndo(r.headers.get('X-Undo-Id'), decodeURIComponent(r.headers.get('X-Undo-Label') || T('Change')), mut);
        return r;
    } catch (e) {
        if (ctl?.signal.aborted) throw new Error(T('The panel server did not answer within {v} s. Try again in a moment.', { v: timeout / 1000 }));
        setConnection(false);
        throw new Error(T('Cannot reach the panel server. If something was just restarted, wait a few seconds and try again; otherwise run start-panel.ps1 from the install folder.'));
    } finally { clearTimeout(timer); }
}

const tokens = {
    get access() { return sessionStorage.getItem('cr_access'); },
    get refresh() { return sessionStorage.getItem('cr_refresh'); },
    set(a, r) { sessionStorage.setItem('cr_access', a); sessionStorage.setItem('cr_refresh', r); },
    clear() { sessionStorage.removeItem('cr_access'); sessionStorage.removeItem('cr_refresh'); },
};

// Single-flight: ffplayout rotates the refresh token on every refresh, so a
// second concurrent refresh with the old token gets 403 and would sign the
// user out. All callers that hit 401 together share one refresh.
let refreshInFlight = null;
function refreshTokens() {
    if (!refreshInFlight) {
        refreshInFlight = (async () => {
            if (!tokens.refresh) return false;
            const r = await netFetch('/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: tokens.refresh }) }, 15000);
            if (!r.ok) { tokens.clear(); return false; }
            const j = await r.json();
            tokens.set(j.access, j.refresh);
            return true;
        })().finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
}

async function api(method, path, body, { raw = false, timeout } = {}) {
    let sentWith = null;
    const go = () => {
        sentWith = tokens.access;
        const opts = {
            method,
            headers: { Authorization: `Bearer ${sentWith}`, ...(body !== undefined ? { 'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json' } : {}) },
            body: body === undefined ? undefined : (typeof body === 'string' || body instanceof Blob) ? body : JSON.stringify(body),
        };
        return timeout === undefined ? netFetch(path, opts) : netFetch(path, opts, timeout);
    };
    let r = await go();
    if (r.status === 401) {
        // If another call already refreshed while this one was in flight, just
        // retry with the new access token instead of refreshing again.
        const fresh = tokens.access && tokens.access !== sentWith;
        if (fresh || (await refreshTokens())) r = await go();
    }
    if (r.status === 401) { showGate('login'); throw new Error(T('Signed out')); }
    const text = await r.text();
    if (!r.ok) {
        let detail = text;
        try { const j = JSON.parse(text); detail = j.detail || j.message || text; } catch { /* plain text */ }
        throw Object.assign(new Error(T(maskText(typeof detail === 'string' ? detail : JSON.stringify(detail))) || T('HTTP {status}', { status: r.status })), { status: r.status });
    }
    if (raw) return text;
    try { return text ? JSON.parse(text) : null; } catch { return text; }
}

const localState = {
    async load() { S.local = await (await netFetch('/local/state')).json(); return S.local; },
    async save() {
        const r = await netFetch('/local/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.local) });
        S.local = await r.json();
    },
};

