// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
// First-run setup: checks what the panel needs (read-only probes), and writes the few
// settings the setup screen is allowed to change into config.json. Nothing is installed here;
// the screen tells the user what to install and re-checks on request.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const R = require('./registry');

const run = (file, args, ms = 5000) => new Promise((resolve) => {
    try { execFile(file, args, { timeout: ms, windowsHide: true }, (err, out) => resolve(err ? null : String(out))); } catch { resolve(null); }
});

// First line of "<tool> -version", e.g. "ffprobe version 7.0.2 ...". Null when it cannot run.
async function toolVersion(exe) {
    const out = await run(exe, ['-version']);
    const m = out && /^(ffprobe|ffmpeg) version (\S+)/m.exec(out);
    return m ? m[2] : null;
}

// Absolute path of a program found on PATH (null when none).
async function whichExe(name) {
    const out = await run(process.platform === 'win32' ? 'where' : 'which', [name]);
    const line = out && out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return line || null;
}

function findFile(dir, re) {
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { const r = findFile(p, re); if (r) return r; } else if (re.test(e.name)) return p;
        }
    } catch { /* folder missing */ }
    return null;
}

function dirState(p) {
    try {
        if (!p || !fs.statSync(p).isDirectory()) return 'missing';
    } catch { return 'missing'; }
    try { fs.accessSync(p, fs.constants.R_OK); } catch { return 'unreadable'; }
    return 'ok';
}

function writable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(f, 'x');
        fs.unlinkSync(f);
        return true;
    } catch { return false; }
}

async function engineCheck(url) {
    try {
        const r = await fetch(new URL('/api/setup', url), { signal: AbortSignal.timeout(2500) });
        return r.status < 500;
    } catch { return false; }
}

// Level: ok | warn | fail. "blocking" items must be ok before the panel can be used.
async function status(opts = {}) {
    const cfg = R.core.cfg;
    const mediaRoot = String(opts.media_root || cfg.mediaRoot || '');
    const engineUrl = String(opts.engine_url || cfg.engineUrl);
    let probe = String(opts.ffprobe || cfg.ffprobe);
    let probeVer = await toolVersion(probe);
    let probeFound = null;
    if (!probeVer) {
        probeFound = await whichExe('ffprobe');
        if (probeFound) { probeVer = await toolVersion(probeFound); if (probeVer) probe = probeFound; }
    }
    const ffmpegPath = path.join(path.dirname(path.isAbsolute(probe) ? probe : (probeFound || probe)), 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
    const ffmpegVer = path.isAbsolute(ffmpegPath) ? await toolVersion(ffmpegPath) : null;
    const media = dirState(mediaRoot);
    const engine = await engineCheck(engineUrl);
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    const vlcOk = Boolean(cfg.vlc) && fs.existsSync(cfg.vlc);
    const whisperDir = path.join(cfg.toolsDir, 'whisper');
    const whisperModel = path.join(whisperDir, 'models', cfg.whisperModel);
    const whisperCli = findFile(path.join(whisperDir, 'bin'), /^whisper-cli(\.exe)?$/i);
    const engineExe = path.join(path.dirname(cfg.dataDir), 'app', 'bin', process.platform === 'win32' ? 'ffplayout.exe' : 'ffplayout');
    const binDir = path.join(path.dirname(cfg.dataDir), 'app', 'bin');
    const libsMissing = process.platform === 'win32' && fs.existsSync(engineExe) && !(fs.existsSync(binDir) && fs.readdirSync(binDir).some((f) => /^avcodec-63\.dll$/i.test(f))) && !(await whichExe('avcodec-63.dll'));
    const checks = [
        { id: 'node', level: nodeMajor >= 18 ? 'ok' : 'warn', blocking: false, value: process.versions.node },
        { id: 'engine', level: engine ? 'ok' : 'fail', blocking: true, value: engineUrl, exe: fs.existsSync(engineExe), can_start: process.platform === 'win32', libs_missing: libsMissing },
        { id: 'media', level: media === 'ok' ? 'ok' : 'fail', blocking: true, value: mediaRoot, state: mediaRoot ? media : 'unset' },
        { id: 'ffprobe', level: probeVer ? 'ok' : 'fail', blocking: false, value: probeVer ? probe : '', version: probeVer || '' },
        { id: 'ffmpeg', level: ffmpegVer ? 'ok' : 'warn', blocking: false, value: ffmpegVer ? ffmpegPath : '', version: ffmpegVer || '' },
        { id: 'data', level: writable(cfg.dataDir) && writable(cfg.logsDir) ? 'ok' : 'fail', blocking: true, value: cfg.dataDir },
        { id: 'vlc', level: vlcOk ? 'ok' : 'warn', blocking: false, value: vlcOk ? cfg.vlc : '' },
        { id: 'whisper', level: whisperCli && fs.existsSync(whisperModel) ? 'ok' : 'warn', blocking: false, value: cfg.whisperModel, missing: !whisperCli ? 'program' : (!fs.existsSync(whisperModel) ? 'model' : ''), can_run: process.platform === 'win32' },
    ];
    return {
        configured: cfg.configured,
        platform: process.platform,
        ready: checks.filter((c) => c.blocking).every((c) => c.level === 'ok'),
        // The setup screen opens on a first run, or when the engine cannot be reached.
        needed: !cfg.configured || !engine,
        suggest: { media_root: mediaRoot, engine_url: engineUrl, ffprobe: probe },
        checks,
        whisper_job: require('./whisperdl').state(),
    };
}

// Writes the allowed keys into config.json (merged, atomic) after validating them.
async function save(body) {
    const cfg = R.core.cfg;
    const out = {};
    const media = String(body.media_root || '').trim();
    if (!media || dirState(media) !== 'ok') throw R.blocks.reqErr('The media folder does not exist or cannot be read.');
    out.media_root = media;
    if (body.engine_url) {
        let u;
        try { u = new URL(String(body.engine_url).trim()); } catch { throw R.blocks.reqErr('The engine address is not a valid URL.'); }
        if (!/^https?:$/.test(u.protocol)) throw R.blocks.reqErr('The engine address must start with http:// or https://.');
        out.engine_url = u.origin;
    }
    if (body.ffprobe) {
        const p = String(body.ffprobe).trim();
        if (!(await toolVersion(p))) throw R.blocks.reqErr('ffprobe could not be started from that path.');
        out.ffprobe = p;
    }
    let cur = {};
    try { const j = JSON.parse(fs.readFileSync(cfg.configFile, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch { /* new file */ }
    if (fs.existsSync(cfg.configFile)) fs.copyFileSync(cfg.configFile, cfg.configFile + '.bak');
    R.core.writeJsonAtomic(cfg.configFile, { ...cur, ...out }, 1);
    R.core.lifeLine(`setup saved: ${Object.keys(out).join(', ')}`);
    return out;
}

// Buttons of the setup screen: start ffplayout (optionally saving its address first) or download the speech-to-text tools.
// Both run the install folder's own scripts; the download runs in a visible window so its progress can be seen.
async function runAction(body) {
    const cfg = R.core.cfg;
    const installRoot = path.dirname(cfg.dataDir);
    const dry = process.env.GSG_SETUP_DRYRUN === '1';   // tests: report the command instead of running it
    if (process.platform !== 'win32' && !dry && !process.env.GSG_WHISPER_TEST) throw R.blocks.reqErr('This button works on Windows only.');
    const ps = (file, extra = []) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...extra];
    let cmd;
    if (body.action === 'start_engine') {
        if (body.engine_url) {
            let u;
            try { u = new URL(String(body.engine_url).trim()); } catch { throw R.blocks.reqErr('The engine address is not a valid URL.'); }
            if (!/^https?:$/.test(u.protocol)) throw R.blocks.reqErr('The engine address must start with http:// or https://.');
            mergeConfig({ engine_url: u.origin });
        }
        const exe = path.join(installRoot, 'app', 'bin', 'ffplayout.exe');
        if (!fs.existsSync(exe) && !dry) throw R.blocks.reqErr('ffplayout.exe was not found in app\\bin. Run 00 START HERE.cmd or put it there.');
        cmd = { file: 'powershell', args: ps(path.join(installRoot, 'start-ffplayout.ps1')), visible: false };
    } else if (body.action === 'get_ffmpeg_libs') {
        const script = path.join(installRoot, 'tools', 'install.js');
        if (!fs.existsSync(script) && !dry) throw R.blocks.reqErr('tools\\install.js is missing.');
        cmd = { file: process.execPath, args: [script, '--ffmpeg-libs'], visible: true, own: true };
    } else if (body.action === 'get_whisper') {   // runs inside the panel; progress is in the status (whisper_job)
        if (dry) return { dry: true, action: 'get_whisper' };
        const r = require('./whisperdl').start(cfg);
        R.core.lifeLine(`setup action: ${body.action}`);
        return r;
    } else throw R.blocks.reqErr('Unknown action.');
    if (dry) return { dry: true, ...cmd };
    if (body.action === 'start_engine') {   // straight from Node, output in logs\stdout.log / stderr.log
        require(path.join(installRoot, 'tools', 'start-direct.js')).startEngine(installRoot);
        R.core.lifeLine(`setup action: ${body.action}`);
        return { started: true };
    }
    const opts = { cwd: installRoot, detached: true, stdio: 'ignore', windowsHide: !cmd.visible };
    if (cmd.own) { spawn(cmd.file, cmd.args, { cwd: installRoot, detached: true, stdio: 'ignore', windowsHide: false }).unref(); R.core.lifeLine(`setup action: ${body.action}`); return { started: true }; }
    const child = cmd.visible ? spawn('cmd', ['/c', 'start', '', cmd.file, ...cmd.args], opts) : spawn(cmd.file, cmd.args, opts);
    child.unref();
    R.core.lifeLine(`setup action: ${body.action}`);
    return { started: true };
}

function mergeConfig(out) {
    const cfg = R.core.cfg;
    let cur = {};
    try { const j = JSON.parse(fs.readFileSync(cfg.configFile, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch { /* new file */ }
    if (fs.existsSync(cfg.configFile)) fs.copyFileSync(cfg.configFile, cfg.configFile + '.bak');
    R.core.writeJsonAtomic(cfg.configFile, { ...cur, ...out }, 1);
}

// Starts a fresh panel process after this one has released its port, then exits.
function respawn() {
    const code = 'setTimeout(()=>{require("child_process").spawn(process.argv[1],JSON.parse(process.argv[2]),{detached:true,stdio:"ignore",windowsHide:true,cwd:process.argv[3]}).unref();process.exit(0)},1500)';
    const child = spawn(process.execPath, ['-e', code, process.execPath, JSON.stringify(process.argv.slice(1)), process.cwd()], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    R.core.lifeLine('restart after setup');
    setTimeout(() => process.exit(0), 300);
}

// Folder browser for the setup screen: subfolders of one folder, or the drives when no folder is given (Windows).
function browse(p) {
    const win = process.platform === 'win32';
    if (!p && win) {
        const dirs = [];
        for (let c = 65; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { if (fs.existsSync(d)) dirs.push({ name: d.slice(0, 2), path: d }); } catch { /* skip */ } }
        return { path: '', parent: null, dirs };
    }
    const dir = path.resolve(p || '/');
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw R.blocks.reqErr('That folder cannot be opened.'); }
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const up = path.dirname(dir);
    return { path: dir, parent: up !== dir ? up : (win ? '' : null), dirs };
}

// Windows folder window ("Select Folder" button). The panel runs on this PC, so the window opens here.
// A small PowerShell script shows the system folder picker (IFileOpenDialog); anything that goes wrong is
// reported so the page can fall back to its own folder list.
const PICKER_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GsgFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialogCom {}
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr t);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint o);
    void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem s);
    void SetFolder(IShellItem s);
    void GetFolder(out IShellItem s);
    void GetCurrentSelection(out IShellItem s);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem s);
    void AddPlace(IShellItem s, uint fp);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string e);
    void Close(int hr);
    void SetClientGuid(ref Guid g);
    void ClearClientData();
    void SetFilter(IntPtr f);
    void GetResults(out IntPtr r);
    void GetSelectedItems(out IntPtr r);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attr);
    void Compare(IShellItem psi, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc, ref Guid riid, out IShellItem item);
  public static string Pick(IntPtr owner, string title, string start) {
    IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogCom();
    dlg.SetOptions(0x20 | 0x40 | 0x800);   // pick folders, file system only, path must exist
    dlg.SetTitle(title);
    if (!String.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
      Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
      IShellItem folder; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
      dlg.SetFolder(folder);
    }
    int hr = dlg.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return "";   // cancelled
    Marshal.ThrowExceptionForHR(hr);
    IShellItem item; dlg.GetResult(out item);
    string path; item.GetDisplayName(0x80058000, out path);   // file system path
    return path;
  }
}
"@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; $owner.Opacity = 0
$owner.StartPosition = 'Manual'; $owner.Location = New-Object System.Drawing.Point(-32000, -32000); $owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
try { $r = [GsgFolderPicker]::Pick($owner.Handle, $env:GSG_PICK_TITLE, $env:GSG_PICK_START) } finally { $owner.Close() }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.Write([string]$r)
`;

function pickFolder(start, title) {
    return new Promise((resolve, reject) => {
        if (process.platform !== 'win32') return reject(R.blocks.reqErr('The folder window works on Windows only.'));
        const enc = Buffer.from(PICKER_PS, 'utf16le').toString('base64');
        require('child_process').execFile('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
            { timeout: 5 * 60 * 1000, windowsHide: true, encoding: 'utf8', env: { ...process.env, GSG_PICK_START: String(start || ''), GSG_PICK_TITLE: String(title || 'Select folder') } },
            (err, stdout, stderr) => {
                if (err) return reject(R.blocks.reqErr(`The folder window could not be opened: ${String(stderr || err.message).trim().split(/\r?\n/)[0]}`));
                resolve({ path: String(stdout || '').replace(/^﻿/, '').trim() });
            });
    });
}

R.setup = module.exports;
Object.assign(module.exports, { status, save, runAction, browse, pickFolder, respawn, toolVersion, dirState });
