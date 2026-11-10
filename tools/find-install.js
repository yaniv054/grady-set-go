// Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Finds an existing install on this PC. Read-only: it asks the running panel and the Windows
// autostart task where they run from; it changes nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const PORT = process.env.GSG_PANEL_PORT || '8790';
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInstall = (d) => { try { return fs.existsSync(path.join(d, 'panel', 'server.js')) || fs.existsSync(path.join(d, 'server.js')); } catch { return false; } };

// Folder the running panel was started from: a string ('' when an older version does not report it), or null when no panel answers.
function panelRoot() {
    return new Promise((resolve) => {
        const r = http.get(`http://127.0.0.1:${PORT}/about.json`, { timeout: 2500 }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; });
            res.on('end', () => { try { resolve(String(JSON.parse(b).root || '')); } catch { resolve(''); } });
        });
        r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    });
}

// Folder the Windows autostart task ("Playout boot") points to, or ''.
function taskRoot() {
    if (process.platform !== 'win32') return '';
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-ScheduledTask -TaskName 'Playout boot' -ErrorAction SilentlyContinue).Actions | ForEach-Object { $_.Arguments }; exit 0"], { encoding: 'utf8', timeout: 15000 });
        const m = out.match(/"([^"]*?)[\\/]boot-playout\.ps1"/i);
        return m ? m[1] : '';
    } catch { return ''; }
}

// exclude: a folder that does not count (the folder being installed from). Returns null or
// { folder, how }: folder is '' when something is running but its folder is not known.
async function findExisting(exclude) {
    const running = await panelRoot();
    const task = taskRoot();
    const cand = [];
    if (running) cand.push({ folder: running, how: 'its panel is running' });
    if (task && isInstall(task)) cand.push({ folder: task, how: 'Windows starts it automatically at boot' });
    for (const c of cand) if (!exclude || !same(c.folder, exclude)) return c;
    if (running === '' ) return { folder: '', how: 'a panel is already answering on port ' + PORT };
    return null;
}

module.exports = { findExisting, panelRoot, taskRoot, isInstall };
