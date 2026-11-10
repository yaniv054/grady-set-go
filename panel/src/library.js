// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const fs = require('fs');
const R = require('./registry');

// --- state (non-secret) ---------------------------------------------------

const PROFILE_FIELDS = ['label', 'server', 'width', 'height', 'fps', 'video_codec', 'video_options', 'audio_bitrate'];

function looksSecret(v) {
    // Anything shaped like an RTMP URL with a path after the app name, or a
    // YouTube-style key, is refused rather than written to disk.
    return typeof v === 'string' && (/rtmps?:\/\/[^/]+\/[^/]+\/\S+/i.test(v) || /\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.test(v));
}

function sanitiseState(input) {
    const out = { activeProfile: 'preview', profiles: {} };
    if (['preview', 'yt-test', 'yt-prod'].includes(input.activeProfile)) out.activeProfile = input.activeProfile;
    for (const id of ['yt-test', 'yt-prod']) {
        const src = (input.profiles || {})[id] || {};
        const p = {};
        for (const f of PROFILE_FIELDS) {
            if (src[f] === undefined) continue;
            if (f === 'video_options') {
                p[f] = {};
                for (const [k, v] of Object.entries(src[f] || {})) if (!looksSecret(String(v))) p[f][k] = String(v);
            } else if (!looksSecret(String(src[f]))) {
                p[f] = src[f];
            }
        }
        out.profiles[id] = { ...R.core.DEFAULT_STATE.profiles[id], ...p };
    }
    return out;
}

function readState() {
    try { return sanitiseState(JSON.parse(fs.readFileSync(R.core.STATE_FILE, 'utf8'))); }
    catch { return sanitiseState(R.core.DEFAULT_STATE); }
}

// --- library.csv ----------------------------------------------------------

function parseCsv(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') q = false;
            else field += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const [head, ...data] = rows.filter((r) => r.length > 1 || r[0]);
    return head ? data.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^\uFEFF/, ''), r[i] ?? '']))) : [];
}


// ---- exports (read by the other modules through R.library) ----
R.library = module.exports;
Object.assign(module.exports, { PROFILE_FIELDS, looksSecret, sanitiseState, readState, parseCsv });
