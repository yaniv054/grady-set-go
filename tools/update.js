// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
//
// Updates the program files of an install, with a backup that can be restored.
//
//   01 UPDATE.cmd   (finds the install, asks to confirm; the unzipped new version is the folder it runs from)
//   node update.js --root C:\Playout --package C:\Temp\grady-set-go-0.2.0 [--config <file>] [--dry-run] [--yes]
//   node update.js --root C:\Playout --restore latest [--with-data]
//   node update.js --root C:\Playout --list
//
// --package   the unzipped new version (a folder that contains panel\ and VERSION)
// --config    a config.json to install when the install has none (never replaces an existing one)
// --restore   puts the program files of a backup back ("latest" or a folder name under backup\)
//
// Replaced: panel\ (except state.json), tools\ (except whisper\bin and whisper\models), the .ps1 scripts
// and the documents in the install folder. Never touched: config.json, data\, logs\, playlists\, storage\,
// public\, app\ (ffplayout), library.csv, backup\. Old program files are MOVED into
// backup\update-<time>\program\, nothing is deleted. ffplayout is never stopped: the channel stays on air.
// If the new panel does not answer within 40 seconds, the old files are put back automatically.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
const die = (m) => { console.error(`\nStopped: ${m}`); process.exit(1); };

const ROOT_SCRIPTS = /\.(ps1|cmd)$/i;
const ROOT_DOCS = new Set(['MANUAL.md', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'VERSION', 'config.example.json']);
const isRootProgramFile = (name) => ROOT_SCRIPTS.test(name) || ROOT_DOCS.has(name);
// Paths (relative, forward slashes) that are never moved or replaced inside panel\ and tools\.
const PROTECTED = [/^panel\/state\.json$/, /^tools\/whisper\/(bin|models)(\/|$)/, /\.bak(-.*)?$/i];
const protectedPath = (rel) => PROTECTED.some((re) => re.test(rel));

function walk(dir, base, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = path.posix.join(base, e.name);
        if (protectedPath(rel)) continue;
        if (e.isDirectory()) walk(abs, rel, out); else out.push(rel);
    }
    return out;
}

// Relative paths of the program files in a folder (an install or an unzipped package).
function programFiles(dir) {
    const out = [];
    for (const top of ['panel', 'tools']) { const d = path.join(dir, top); if (fs.existsSync(d)) walk(d, top, out); }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile() && isRootProgramFile(e.name)) out.push(e.name);
    return out;
}

const readVersion = (dir) => { try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch { return 'legacy'; } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function moveFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch { fs.copyFileSync(from, to); fs.unlinkSync(from); }   // across drives: copy, then remove the original
}
function copyFile(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }

function pruneEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name));
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function panelPort(root) {
    if (process.env.PANEL_PORT) return Number(process.env.PANEL_PORT);
    try { const c = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); if (c.port) return Number(c.port); } catch { /* none */ }
    return 8790;
}

function listenerPids(port) {
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
            return [...new Set(out.split(/\r?\n/).filter((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l)).map((l) => l.trim().split(/\s+/).pop()))].filter(Boolean);
        }
        const out = execFileSync('sh', ['-c', `fuser ${port}/tcp 2>/dev/null || true`], { encoding: 'utf8' });
        return out.split(/\s+/).filter((x) => /^\d+$/.test(x));
    } catch { return []; }
}

async function stopPanel(port) {
    for (const pid of listenerPids(port)) {
        log(`  stopping the panel (PID ${pid}); ffplayout is not touched`);
        try {
            if (process.platform === 'win32') execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true, stdio: 'ignore' });
            else process.kill(Number(pid));
        } catch { /* already gone */ }
    }
    for (let i = 0; i < 20; i++) { if (listenerPids(port).length === 0) return true; await sleep(500); }
    return false;
}

function ask(port, p = '/about.json') {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
        req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function startPanel(root) {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    const out = fs.openSync(path.join(root, 'logs', 'panel.out.log'), 'a');
    const err = fs.openSync(path.join(root, 'logs', 'panel.err.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'panel', 'server.js')], { cwd: path.join(root, 'panel'), detached: true, stdio: ['ignore', out, err], windowsHide: true });
    child.unref();
}

async function waitUp(port, secs) {
    for (let i = 0; i < secs * 2; i++) { if (await ask(port)) return true; await sleep(500); }
    return false;
}

// Moves the current program files into `aside`, then moves the files of `fromDir` (relative list) back in.
function swapProgram(root, aside, restoreFrom) {
    const current = programFiles(root);
    for (const rel of current) moveFile(path.join(root, rel), path.join(aside, rel));
    if (restoreFrom) for (const rel of restoreFrom.files) moveFile(path.join(restoreFrom.dir, rel), path.join(root, rel));
    for (const top of ['panel', 'tools']) pruneEmptyDirs(path.join(root, top));
}

async function restore(root, backupDir, { withData, why }) {
    const man = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    const port = panelPort(root);
    log(`Restoring the program files of ${path.basename(backupDir)} (version ${man.from_version})${why ? ` - ${why}` : ''}`);
    if (!(await stopPanel(port))) die('the panel is still running; stop it and run the restore again.');
    const aside = path.join(backupDir, `replaced-by-restore-${stamp()}`);
    swapProgram(root, aside, { dir: path.join(backupDir, 'program'), files: man.files });
    if (man.created_config && fs.existsSync(path.join(root, 'config.json'))) moveFile(path.join(root, 'config.json'), path.join(aside, 'config.json'));
    if (withData && fs.existsSync(path.join(backupDir, 'data-json'))) {
        for (const f of fs.readdirSync(path.join(backupDir, 'data-json'))) copyFile(path.join(backupDir, 'data-json', f), path.join(root, 'data', f));
        log('  data files restored from the backup');
    }
    startPanel(root);
    const up = await waitUp(port, 40);
    log(up ? '  the panel answers again.' : '  the panel did not answer: start it with start-panel.ps1 and check logs\\panel.err.log.');
    log(`The files of the version that was removed are in ${aside}`);
    return up;
}

function backups(root) {
    const d = path.join(root, 'backup');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((n) => /^update-/.test(n) && fs.existsSync(path.join(d, n, 'manifest.json'))).sort();
}

async function update(root, pkg) {
    if (!fs.existsSync(path.join(pkg, 'panel', 'server.js')) || !fs.existsSync(path.join(pkg, 'VERSION'))) die('the package folder does not contain panel\\server.js and VERSION. Unzip the download first and give the unzipped folder.');
    if (path.resolve(pkg) === path.resolve(root)) die('the package folder is the install folder.');
    const newFiles = programFiles(pkg);
    const oldVersion = readVersion(root), newVersion = readVersion(pkg);
    const port = panelPort(root);
    log(`Install folder: ${root}\nUpdate: ${oldVersion} -> ${newVersion}  (${newFiles.length} program files)`);
    const hasConfig = fs.existsSync(path.join(root, 'config.json'));
    const cfgFile = opt('--config');
    if (!hasConfig) log(cfgFile ? '  no config.json here: the one given with --config will be installed.' : '  no config.json here: the setup screen will ask for the basics after the update.');
    if (cfgFile && !fs.existsSync(cfgFile)) die(`--config file not found: ${cfgFile}`);
    if (flag('--dry-run')) { log('Dry run: nothing was changed.'); return; }

    const backupDir = path.join(root, 'backup', `update-${stamp()}`);
    const oldFiles = programFiles(root);
    const pause = path.join(root, 'data', 'WATCHDOG_OFF');
    const createdPause = !fs.existsSync(pause);
    if (createdPause) { fs.mkdirSync(path.dirname(pause), { recursive: true }); fs.writeFileSync(pause, 'update in progress\n'); }
    try {
        log('1/4 Backing up the data files and settings');
        fs.mkdirSync(backupDir, { recursive: true });
        const dataDir = path.join(root, 'data');
        if (fs.existsSync(dataDir)) for (const f of fs.readdirSync(dataDir)) if (/\.json$/i.test(f) && f !== 'panel-secrets.json') copyFile(path.join(dataDir, f), path.join(backupDir, 'data-json', f));
        for (const f of ['config.json']) if (hasConfig) copyFile(path.join(root, f), path.join(backupDir, 'settings', f));
        if (fs.existsSync(path.join(root, 'panel', 'state.json'))) copyFile(path.join(root, 'panel', 'state.json'), path.join(backupDir, 'settings', 'state.json'));
        fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ from_version: oldVersion, to_version: newVersion, time: new Date().toISOString(), files: oldFiles, created_config: !hasConfig && Boolean(cfgFile) }, null, 2));

        log('2/4 Stopping the panel');
        if (!(await stopPanel(port))) throw new Error('the panel could not be stopped');

        log('3/4 Moving the old program files into the backup and installing the new ones');
        swapProgram(root, path.join(backupDir, 'program'), null);
        for (const rel of newFiles) copyFile(path.join(pkg, rel), path.join(root, rel));
        if (!hasConfig && cfgFile) copyFile(cfgFile, path.join(root, 'config.json'));

        log('4/4 Starting the new panel');
        startPanel(root);
        if (!(await waitUp(port, 40))) throw new Error('the new panel did not answer within 40 seconds');
    } catch (e) {
        console.error(`\nThe update failed: ${e.message}\nPutting the old version back.`);
        const ok = fs.existsSync(path.join(backupDir, 'program')) ? await restore(root, backupDir, { withData: false, why: 'automatic' }) : false;
        if (createdPause) try { fs.unlinkSync(pause); } catch { /* ignore */ }
        process.exit(ok ? 2 : 3);
    }
    if (createdPause) try { fs.unlinkSync(pause); } catch { /* ignore */ }
    log(`\nDone. Version ${newVersion} is running.\nBackup of version ${oldVersion}: ${backupDir}\nTo go back:  node tools\\update.js --root "${root}" --restore latest`);
}

const prompt = (q) => new Promise((resolve) => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); resolve(a.trim()); }); });

// Without --root: the install is found from the running panel or the autostart task, and the person confirms it.
async function chooseRoot(pkg) {
    const found = await require('./find-install').findExisting(pkg);
    let root = found && found.folder;
    if (root && !flag('--yes')) {
        const ans = await prompt(`Found an install in ${root}.\nUpdate it to version ${readVersion(pkg)}? Settings and data are kept. [y/N] `);
        if (!/^y/i.test(ans)) root = '';
    } else if (!root) {
        root = await prompt('Folder of the existing install (for example C:\\Playout): ');
    }
    root = root.replace(/^"|"$/g, '');
    if (!root) die('no install folder given. Nothing was changed.');
    return root;
}

(async () => {
    let root = opt('--root');
    if (!root) {
        if (flag('--list') || opt('--restore')) die('give the install folder with --root, for example --root C:\\Playout');
        const pkg = path.resolve(opt('--package') || path.join(__dirname, '..'));
        root = await chooseRoot(pkg);
    }
    if (!fs.existsSync(path.join(root, 'panel'))) die(`${root} does not look like an install (no panel folder).`);
    if (flag('--list')) { const b = backups(root); log(b.length ? b.join('\n') : 'no backups'); return; }
    if (opt('--restore')) {
        const b = backups(root);
        const name = opt('--restore') === 'latest' ? b[b.length - 1] : opt('--restore');
        if (!name || !fs.existsSync(path.join(root, 'backup', name, 'manifest.json'))) die('no such backup. List them with --list.');
        const wd = path.join(root, 'data', 'WATCHDOG_OFF'), made = !fs.existsSync(wd);
        if (made) { fs.mkdirSync(path.dirname(wd), { recursive: true }); fs.writeFileSync(wd, 'restore in progress\n'); }
        const ok = await restore(root, path.join(root, 'backup', name), { withData: flag('--with-data') });
        if (made) try { fs.unlinkSync(wd); } catch { /* ignore */ }
        process.exit(ok ? 0 : 3);
    }
    await update(path.resolve(root), path.resolve(opt('--package') || path.join(__dirname, '..')));
})().catch((e) => die(e.stack || e.message));
