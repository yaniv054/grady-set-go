// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Finishes an install: downloads ffplayout into app\bin when it is missing, starts ffplayout and the
// panel and opens the browser. 00 START HERE.cmd runs this after installing Node.js, FFmpeg and VLC.
//   node tools\install.js [--ffplayout-from <folder or ffplayout.exe>] [--no-start] [--check]
// --check only reports what is present. Nothing outside the install folder is changed.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'app', 'bin');
const WANT_VERSION = '2.6.0';
// ffplayout 2.6 is linked against the FFmpeg program libraries (avcodec-63.dll ...), which neither the winget FFmpeg
// (static build) nor the ffplayout zip contains. Without them ffplayout.exe stops at once without any message.
const LIBS_URL = process.env.GSG_FFMPEG_LIBS_URL || 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip';
const API = process.env.GSG_GITHUB_API || 'https://api.github.com/repos/ffplayout/ffplayout/releases?per_page=50';
const EXE = process.platform === 'win32' ? 'ffplayout.exe' : 'ffplayout';
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(n);
const say = (m) => console.log(m);
const stop = (m) => { console.error(`\n${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, { json = false, file = null, hops = 0 } = {}) {
    return new Promise((resolve, reject) => {
        if (hops > 6) return reject(new Error('too many redirects'));
        const lib = url.startsWith('https:') ? https : http;
        lib.get(url, { headers: { 'User-Agent': 'grady-set-go-installer', Accept: json ? 'application/vnd.github+json' : '*/*' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, { json, file, hops: hops + 1 })); }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
            if (file) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const w = fs.createWriteStream(file), total = Number(res.headers['content-length']) || 0;
                let got = 0, shown = 0;
                res.on('data', (c) => { got += c.length; if (total && shown < 0.9 && got / total >= shown + 0.1) { shown = Math.floor((got / total) * 10) / 10; process.stdout.write(`  ${Math.round(shown * 100)}%\r`); } });
                res.on('error', reject); res.pipe(w); w.on('finish', () => { if (total) process.stdout.write('  100%\n'); resolve(file); }); w.on('error', reject); return;
            }
            const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); try { resolve(json ? JSON.parse(t) : t); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// Windows 10+ includes bsdtar, which reads zip files. A "tar" earlier on the PATH (Git for Windows ships GNU tar) cannot, so the system one is used.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
function extractZip(zip, dest) {
    fs.mkdirSync(dest, { recursive: true });
    if (process.platform === 'win32') execFileSync(TAR, ['-xf', zip, '-C', dest], { windowsHide: true });
    else execFileSync('unzip', ['-qo', zip, '-d', dest]);
}

function findFile(dir, name) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
    return null;
}

// The ffplayout package is bin\ffplayout.exe plus assets\ (subtitle placeholder, logo, default config). The whole
// package goes into app\ so that the engine, started from app\, finds its assets next to bin\.
function installFrom(src) {
    let exe = src;
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) exe = findFile(src, EXE);
    if (!exe || !fs.existsSync(exe)) stop(`${EXE} was not found in ${src}`);
    const binDir = path.dirname(exe);
    const pkg = path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : null;
    fs.mkdirSync(BIN, { recursive: true });
    if (pkg) fs.cpSync(pkg, path.join(ROOT, 'app'), { recursive: true, filter: (f) => !/[\\/]docker([\\/]|$)/i.test(f) });
    else for (const f of fs.readdirSync(binDir)) { const from = path.join(binDir, f); if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(BIN, f)); }
}

async function downloadFfplayout() {
    say(`Looking for ffplayout ${WANT_VERSION} on GitHub ...`);
    const releases = await get(API, { json: true });
    const rel = (Array.isArray(releases) ? releases : [releases]).find((r) => new RegExp(`(^|[^0-9.])v?${WANT_VERSION.replace(/\./g, '\\.')}$`).test(r.tag_name || ''));
    if (!rel) throw new Error(`no release ${WANT_VERSION} was found. Releases seen: ${(Array.isArray(releases) ? releases : []).slice(0, 8).map((r) => r.tag_name).join(', ') || 'none'}`);
    const assets = rel.assets || [];
    const win = assets.filter((a) => /win/i.test(a.name) && /\.zip$/i.test(a.name));
    if (win.length !== 1) throw new Error(`could not pick one Windows zip from: ${assets.map((a) => a.name).join(', ') || 'no files'}`);
    const tmp = path.join(ROOT, 'app', '_download');
    const zip = path.join(tmp, win[0].name);
    say(`Downloading ${win[0].name} (${Math.round((win[0].size || 0) / 1048576)} MB) ...`);
    await get(win[0].browser_download_url, { file: zip });
    extractZip(zip, path.join(tmp, 'x'));
    installFrom(path.join(tmp, 'x'));
    fs.rmSync(tmp, { recursive: true, force: true });
}

function which(name) {
    try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { return ''; }
}

function libsPresent() {
    try { if (fs.readdirSync(BIN).some((f) => /^avcodec-63\.dll$/i.test(f))) return true; } catch { /* no bin folder yet */ }
    return Boolean(which('avcodec-63.dll'));
}

async function ensureFfmpegLibs() {
    if (process.platform !== 'win32' || libsPresent()) return;
    const tmp = path.join(ROOT, 'app', '_download_libs');
    const zip = path.join(tmp, 'ffmpeg-shared.zip');
    say('\nffplayout needs the FFmpeg program libraries (DLL files). Downloading them (about 86 MB) ...');
    await get(LIBS_URL, { file: zip });
    const x = path.join(tmp, 'x');
    try { fs.mkdirSync(x, { recursive: true }); execFileSync(TAR, ['-xf', zip, '-C', x, '--include', '*/bin/*.dll'], { windowsHide: true }); }
    catch { extractZip(zip, x); }
    let dll = findFile(x, 'avcodec-63.dll');
    if (!dll) { extractZip(zip, x); dll = findFile(x, 'avcodec-63.dll'); }
    if (!dll) throw new Error('avcodec-63.dll was not found in the downloaded FFmpeg archive');
    fs.mkdirSync(BIN, { recursive: true });
    for (const f of fs.readdirSync(path.dirname(dll))) if (/\.dll$/i.test(f)) fs.copyFileSync(path.join(path.dirname(dll), f), path.join(BIN, f));
    fs.rmSync(tmp, { recursive: true, force: true });
    say(`FFmpeg libraries are in ${BIN}`);
}

function reachable(url) {
    return new Promise((resolve) => { const r = http.get(url, { timeout: 2500 }, (res) => { res.resume(); resolve(res.statusCode < 500); }); r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); }); });
}

(async () => {
    // Another copy of the program is already installed on this PC: do not install a second one over it.
    const existing = await require('./find-install').findExisting(ROOT);
    if (existing) {
        console.error(`\nGrady Set Go is already installed on this PC${existing.folder ? `: ${existing.folder}` : ''} (${existing.how}).\n\nDo not install it again. To upgrade, run  01 UPDATE.cmd  from this download:\nyour settings and data are kept and the old version is backed up.\n(Installing a second, separate copy is not supported yet.)`);
        process.exit(2);
    }
    if (flag('--check-existing')) return;
    if (flag('--ffmpeg-libs')) {
        try {
            await ensureFfmpegLibs();
            if (!(await reachable('http://127.0.0.1:8787/api/setup'))) { say('Starting ffplayout ...'); require('./start-direct').startEngine(ROOT); }
            say('\nDone. This window closes in 10 seconds; the setup page turns green by itself.');
            await sleep(10000);
        } catch (e) { say(`\nFailed: ${e.message}\nThis window closes in 60 seconds.`); await sleep(60000); process.exit(1); }
        return;
    }
    say(`Install folder: ${ROOT}`);
    const have = {
        'Node.js': process.version, ffprobe: which('ffprobe'), ffmpeg: which('ffmpeg'),
        ffplayout: fs.existsSync(path.join(BIN, EXE)) ? path.join(BIN, EXE) : '',
    };
    for (const [k, v] of Object.entries(have)) say(`  ${v ? 'found  ' : 'MISSING'} ${k}${v ? `  ${v}` : ''}`);
    if (flag('--check')) return;
    if (!have.ffprobe) say('\nffprobe/ffmpeg are not on the PATH. Install FFmpeg (winget install Gyan.FFmpeg), open a new window and run this again. Continuing without it.');

    if (!have.ffplayout) {
        if (opt('--ffplayout-from')) installFrom(path.resolve(opt('--ffplayout-from')));
        else {
            try { await downloadFfplayout(); } catch (e) {
                stop(`ffplayout could not be downloaded automatically: ${e.message}\nDownload the Windows zip of ffplayout ${WANT_VERSION} yourself from https://github.com/ffplayout/ffplayout/releases,\nunzip it, and run:  node tools\\install.js --ffplayout-from "<unzipped folder>"`);
            }
        }
        if (!fs.existsSync(path.join(BIN, EXE))) stop(`${EXE} is still missing in ${BIN}.`);
        say(`ffplayout is in ${BIN}`);
    }
    try { await ensureFfmpegLibs(); } catch (e) { say(`\nThe FFmpeg libraries could not be downloaded: ${e.message}\nDownload ${LIBS_URL}, unzip it and copy all .dll files from its bin folder into ${BIN}, then run this again.`); }
    for (const d of ['logs', 'data', 'playlists', 'storage', 'public']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });   // the start scripts write their logs here
    if (flag('--no-start')) return say('Done (not started, as asked).');

    const direct = require('./start-direct');
    if (!(await reachable('http://127.0.0.1:8787/api/setup')) && process.platform === 'win32') {
        say('Starting ffplayout ...');
        direct.startEngine(ROOT);
        let engineUp = false;
        for (let i = 0; i < 20 && !engineUp; i++) { engineUp = await reachable('http://127.0.0.1:8787/api/setup'); if (!engineUp) await sleep(1000); }
        const tailOf = (f) => { try { return fs.readFileSync(path.join(ROOT, 'logs', f), 'utf8').split(/\r?\n/).filter(Boolean).slice(-10).join('\n'); } catch { return ''; } };
        if (engineUp) say('ffplayout answers.');
        else say(`\nffplayout did not answer within 20 seconds (the panel will say so too).\n--- logs\\stderr.log ---\n${tailOf('stderr.log') || '(empty)'}\n--- logs\\stdout.log ---\n${tailOf('stdout.log') || '(empty)'}\nContinuing with the panel.`);
    }
    if (!(await reachable('http://127.0.0.1:8790/about.json'))) { say('Starting the panel ...'); direct.startPanel(ROOT); }
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = await reachable('http://127.0.0.1:8790/about.json'); if (!up) await sleep(1000); }
    if (!up) {
        const tail = (f) => { try { return fs.readFileSync(path.join(ROOT, 'logs', f), 'utf8').split(/\r?\n/).filter(Boolean).slice(-15).join('\n'); } catch { return '(no file)'; } };
        stop(`The panel did not answer within 40 seconds.\n--- logs\\panel.err.log ---\n${tail('panel.err.log')}\n--- logs\\panel.out.log ---\n${tail('panel.out.log')}\n---\nSend me these lines, or run  node panel\\server.js  in this folder and send what it prints.`);
    }
    say('\nThe panel is running: http://127.0.0.1:8790\nThe page shows what is left to set up (your media folder). Opening it now ...');
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:8790'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    say('\nTo start everything automatically with Windows: run install-autostart.ps1 as Administrator.');
    // This window closes by itself once the setup page shows everything required in green (the panel keeps running).
    say('\nThis window closes by itself when every required item on the setup page is green. You can also close it now; the panel keeps running.');
    const status = () => new Promise((resolve) => { const r = http.get('http://127.0.0.1:8790/local/setup/status', { timeout: 3000 }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); });
    for (let i = 0; i < 900; i++) {   // up to 30 minutes
        const st = await status();
        if (st && (st.ready || st.needed === false)) { say('\nAll set. Closing this window.'); await sleep(2500); return; }
        await sleep(2000);
    }
})().catch((e) => stop(e.stack || e.message));
