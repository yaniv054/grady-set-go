// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. All rights reserved unless a LICENSE file says otherwise.
//
// Configuration loader. Every path and site-specific value lives in config.json (next to
// the panel folder) or in a PANEL_* environment variable; nothing is hard-coded.
// Precedence: environment variable > config.json > default derived from the install folder.
// Zero dependencies.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.PANEL_HOME || path.join(__dirname, '..'));   // install folder
const CONFIG_FILE = process.env.PANEL_CONFIG || path.join(ROOT, 'config.json');

function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
        return {};   // missing or unreadable: first-run setup screen takes over
    }
}

const file = readConfig();
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

// pick(envName, configKey, fallback): the first non-empty of env, config.json, fallback.
function pick(envName, key, fallback) {
    return str(process.env[envName]) || str(file[key]) || fallback;
}

const bin = (name) => path.join(ROOT, 'app', 'bin', name);

const cfg = {
    root: ROOT,
    configFile: CONFIG_FILE,
    configured: Boolean(str(file.media_root) || str(process.env.PANEL_MEDIA_ROOT)),
    port: Number(pick('PANEL_PORT', 'port', '8790')),
    engineUrl: pick('FFPLAYOUT_URL', 'engine_url', 'http://127.0.0.1:8787'),
    // Read-only media folder (local drive, NAS share or UNC path). Empty until setup is done.
    mediaRoot: pick('PANEL_MEDIA_ROOT', 'media_root', ''),
    ffprobe: pick('PANEL_FFPROBE', 'ffprobe', bin('ffprobe.exe')),
    vlc: pick('PANEL_VLC', 'vlc', 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'),
    dataDir: pick('PANEL_DATA', 'data_dir', path.join(ROOT, 'data')),
    logsDir: pick('PANEL_ENGINE_LOGS', 'logs_dir', path.join(ROOT, 'logs')),
    storageRoot: pick('PANEL_STORAGE_ROOT', 'storage_dir', path.join(ROOT, 'storage')),
    playlistsDir: pick('PANEL_PLAYLISTS', 'playlists_dir', path.join(ROOT, 'playlists')),
    publicRoot: pick('PANEL_PUBLIC_ROOT', 'public_dir', path.join(ROOT, 'public')),
    toolsDir: pick('PANEL_TOOLS', 'tools_dir', path.join(ROOT, 'tools')),
};

cfg.creditsLanguage = pick('PANEL_CREDITS_LANG', 'credits_language', 'en');
cfg.creditsContact = pick('PANEL_CREDITS_CONTACT', 'credits_contact', '');   // optional e-mail or URL for the MusicBrainz User-Agent
cfg.whisperModel = pick('WHISPER_MODEL_NAME', 'whisper_model', 'ggml-large-v3-turbo.bin');   // file name under tools/whisper/models
cfg.whisperLanguage = pick('WHISPER_LANGUAGE', 'whisper_language', 'auto');   // whisper.cpp -l value: 'auto', 'en', 'he', ...
cfg.updateCheck = pick('PANEL_UPDATE_CHECK', 'update_check', 'on');   // 'off' = never look for a newer release
cfg.updateRepo = pick('PANEL_UPDATE_REPO', 'update_repo', 'yaniv054/grady-set-go');
cfg.feedbackEndpoint = pick('PANEL_FEEDBACK_ENDPOINT', 'feedback_endpoint', '');   // https URL that receives the feedback (see tools/feedback-relay); empty = e-mail app / copy
cfg.feedbackEmail = pick('PANEL_FEEDBACK_EMAIL', 'feedback_email', '');   // address of the Send feedback button; empty = the button only copies the text
cfg.version = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return ''; } })();
cfg.libraryCsv = pick('PANEL_LIBRARY', 'library_csv', path.join(cfg.dataDir, 'library.csv'));
cfg.logFile = pick('PANEL_LOG', 'log_file', path.join(cfg.logsDir, 'panel.log'));
cfg.metaFile = pick('PANEL_META', 'meta_file', path.join(cfg.dataDir, 'clip-metadata.json'));
cfg.deepScan = pick('PANEL_DEEPSCAN', 'deep_scan', path.join(cfg.toolsDir, 'deep-scan.js'));
cfg.deepScanLog = pick('PANEL_DEEPSCAN_LOG', 'deep_scan_log', path.join(cfg.logsDir, 'deep-scan.log'));
cfg.scanner = pick('PANEL_SCANNER', 'scanner', path.join(cfg.toolsDir, 'scan-library.js'));
cfg.scanLog = pick('PANEL_SCAN_LOG', 'scan_log', path.join(cfg.logsDir, 'scan-library.log'));

// Clip categories: config.json "categories": [{ "code": "song", "label": "Song / clip", "concert": false }].
// "concert": true marks the categories that get the opener and closer around full concerts.
const DEFAULT_CATEGORIES = [
    { code: 'concert', label: 'Concert', concert: true }, { code: 'song', label: 'Song / clip' }, { code: 'podcast', label: 'Podcast' },
    { code: 'interview', label: 'Interview' }, { code: 'documentary', label: 'Documentary' }, { code: 'promo', label: 'Promo' },
    { code: 'ident', label: 'Ident / bumper' }, { code: 'other', label: 'Other' },
];
function readCategories() {
    const list = Array.isArray(file.categories) ? file.categories : null;
    if (!list) return DEFAULT_CATEGORIES;
    const seen = new Set();
    const out = [];
    for (const x of list) {
        const code = x && typeof x.code === 'string' ? x.code.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(code) || seen.has(code)) continue;   // invalid entries are ignored
        seen.add(code);
        out.push({ code, label: String(x.label || code).trim().slice(0, 60), concert: x.concert === true });
    }
    return out.length ? out : DEFAULT_CATEGORIES;
}
cfg.categories = readCategories();

// Optional rules that read the performer from folder or file names (used by the Clean titles check):
// config.json "performer_rules": [{ "folder": "^Artist\\s*-\\s*(.+)$", "file": "^(.+?)\\s+-\\s+(.+)$" }]
// Each regex has one capture group for the performer (the file rule: group 1). Empty by default.
cfg.performerRules = [];
for (const r of Array.isArray(file.performer_rules) ? file.performer_rules : []) {
    try {
        cfg.performerRules.push({ folder: r && r.folder ? new RegExp(String(r.folder), 'i') : null, file: r && r.file ? new RegExp(String(r.file), 'i') : null });
    } catch { /* an invalid pattern is ignored */ }
}

module.exports = cfg;
