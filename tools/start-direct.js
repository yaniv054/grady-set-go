// Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Starts the panel and ffplayout straight from Node (no PowerShell in between), with their output
// written to logs\ so a failed start can be read. The .ps1 scripts remain for the boot task.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Keep the previous run's output: file -> file.1 ... file.5
function rotate(file, keep = 5) {
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
        for (let i = keep - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        fs.renameSync(file, `${file}.1`);
    } catch { /* a log that cannot be rotated is simply overwritten */ }
}

function launch(exe, args, { cwd, env, out, err }) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    rotate(out); rotate(err);
    const o = fs.openSync(out, 'w'), e = fs.openSync(err, 'w');
    const child = spawn(exe, args, { cwd, env: env || process.env, detached: true, stdio: ['ignore', o, e], windowsHide: true });
    child.on('exit', (code, sig) => { try { fs.appendFileSync(err, `${path.basename(exe)} exited with code ${code === null ? sig : `${code} (0x${(code >>> 0).toString(16)})`}\n`); } catch { /* ignore */ } });
    child.on('error', (ex) => { try { fs.appendFileSync(err, `could not start ${exe}: ${ex.message}\n`); } catch { /* ignore */ } });
    child.unref();
    fs.closeSync(o); fs.closeSync(e);
    return child;
}

function startPanel(root) {
    return launch(process.execPath, [path.join(root, 'panel', 'server.js')], { cwd: path.join(root, 'panel'), out: path.join(root, 'logs', 'panel.out.log'), err: path.join(root, 'logs', 'panel.err.log') });
}

// Same settings as start-ffplayout.ps1: ffplayout reads PUBLIC as its HLS folder, and Windows always sets it to C:\Users\Public.
function startEngine(root) {
    let listen = '127.0.0.1:8787';
    try { const m = String(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).engine_url || '').match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/); if (m) listen = `127.0.0.1:${m[1]}`; } catch { /* default */ }
    for (const d of ['public', 'data', 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const exe = path.join(root, 'app', 'bin', process.platform === 'win32' ? 'ffplayout.exe' : 'ffplayout');
    return launch(exe, ['--db', path.join(root, 'data', 'ffplayout.db'), '--logs', path.join(root, 'logs'), '-l', listen], {
        cwd: path.join(root, 'app'), env: { ...process.env, PUBLIC: path.join(root, 'public') },
        out: path.join(root, 'logs', 'stdout.log'), err: path.join(root, 'logs', 'stderr.log'),
    });
}

module.exports = { startPanel, startEngine };
