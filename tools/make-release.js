// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Builds the download package: dist/grady-set-go-<version>/ and a .zip next to it.
// Usage: node tools/make-release.js        (run from anywhere; no dependencies)
// Only the program is packed. Site data (data, logs, config.json, playlists, storage, state.json) never is.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const name = `grady-set-go-${version}`;
const dist = path.join(ROOT, 'dist');
const out = path.join(dist, name);

const INCLUDE = ['panel', 'tools', 'LICENSE', 'NOTICE', 'VERSION', 'MANUAL.md', 'README.md', 'CHANGELOG.md', 'config.example.json',
    '00 START HERE.cmd', '01 UPDATE.cmd', '99 UNINSTALL.cmd', 'boot-playout.ps1', 'install-autostart.ps1', 'rescan-library.ps1', 'restart-panel.ps1', 'start-ffplayout.ps1', 'start-panel.ps1'];
// Skipped anywhere in the tree (matched against the path relative to the install folder, with forward slashes).
const SKIP = [/(^|\/)state\.json$/, /\.bak(-.*)?$/, /(^|\/)node_modules(\/|$)/, /^tools\/_legacy(\/|$)/, /^tools\/whisper\/(bin|models)(\/|$)/,
    /^tools\/whisper\/(.*-test\.js|run-test\.ps1|test-list\.txt|version\.txt)$/, /(^|\/)\.git(\/|$)/, /(^|\/)\.DS_Store$/];

function copy(rel) {
    const src = path.join(ROOT, rel);
    if (SKIP.some((re) => re.test(rel.replace(/\\/g, '/')))) return;
    const st = fs.statSync(src);
    if (st.isDirectory()) { for (const f of fs.readdirSync(src)) copy(path.join(rel, f)); return; }
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(out, rel));
}

fs.rmSync(out, { recursive: true, force: true });
for (const rel of INCLUDE) { if (fs.existsSync(path.join(ROOT, rel))) copy(rel); else console.warn(`missing, not packed: ${rel}`); }
for (const d of ['data', 'logs']) fs.mkdirSync(path.join(out, d), { recursive: true });

const zip = path.join(dist, `${name}.zip`);
fs.rmSync(zip, { force: true });
try {
    if (process.platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', zip, '-C', dist, name]);   // Windows 10+ bsdtar writes zip
    else execFileSync('zip', ['-qr', zip, name], { cwd: dist });
    console.log(`built ${zip}`);
} catch (e) {
    console.log(`folder built: ${out}\nzip it yourself (${e.message.split('\n')[0]})`);
}
