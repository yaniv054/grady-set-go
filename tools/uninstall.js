// Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
//
// Stops the programs that run from THIS install folder and, if asked, removes the autostart tasks and
// moves the whole folder to the Recycle Bin. Only processes whose program or command line is inside
// this folder are touched (panel, ffplayout, ffmpeg and the start scripts). Your media folder, other
// installs and other programs are never touched. Nothing is changed before you confirm.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

const SELF = path.resolve(__dirname, '..');   // the folder this script is in
let ROOT = SELF;                               // the folder being uninstalled (asked below; default: this one)
const win = process.platform === 'win32';
const lc = (s) => String(s || '').toLowerCase();
const NAMES = /^(cmd|node|ffplayout|ffmpeg|ffprobe|whisper-cli|powershell|pwsh)(\.exe)?$/i;
const TASKS = ['Playout boot', 'Playout panel'];
const say = (m = '') => console.log(m);
const psq = (s) => String(s).replace(/'/g, "''");

function processes() {
    if (win) {
        const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        let a = JSON.parse(out); if (!Array.isArray(a)) a = [a];
        return a.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name || '', exe: p.ExecutablePath || '', cmd: p.CommandLine || '' }));
    }
    return execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
        .map((m) => ({ pid: +m[1], ppid: +m[2], name: m[3], exe: '', cmd: m[4] }));
}

// Programs running from this folder, never this script itself or the windows that started it.
function ours() {
    const all = processes(), byPid = new Map(all.map((p) => [p.pid, p]));
    const skip = new Set();
    for (let p = byPid.get(process.pid); p && !skip.has(p.pid); p = byPid.get(p.ppid)) skip.add(p.pid);
    const root = lc(ROOT);
    return all.filter((p) => !skip.has(p.pid) && NAMES.test(p.name) && (lc(p.exe).startsWith(root) || lc(p.cmd).includes(root)));
}

function stopAll() {
    const list = ours();
    if (!list.length) { say('  nothing from this folder is running.'); return true; }
    let ok = true;
    for (const p of list) {
        try { process.kill(p.pid, 'SIGKILL'); say(`  stopped ${p.name} (${p.pid})`); }
        catch (e) { ok = false; say(`  could not stop ${p.name} (${p.pid}): ${e.code === 'EPERM' ? 'it runs as administrator. Run this again as administrator.' : e.message}`); }
    }
    return ok;
}

function removeTasks() {
    if (!win) { say('  autostart tasks exist on Windows only.'); return true; }
    const script = `$r='${psq(lc(ROOT))}'; foreach($n in ${TASKS.map((t) => `'${t}'`).join(',')}){ $t=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; if(-not $t){continue}; $a=(($t.Actions|ForEach-Object{$_.Arguments}) -join ' ').ToLower(); if($a.Contains($r)){ try{ Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop; Write-Output ('  removed autostart task: '+$n) }catch{ Write-Output ('  could not remove task '+$n+': run this again as administrator.') } } else { Write-Output ('  task '+$n+' points to another folder: left alone.') } }; exit 0`;
    try { const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim(); say(out || '  no autostart tasks found.'); return !/could not/.test(out); }
    catch (e) { say(`  could not read the autostart tasks: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return false; }
}

// Other programs (archivers, editors ...) that were opened with this folder in their command line.
function mentions() {
    const root = lc(ROOT), skip = new Set([process.pid]);
    return processes().filter((p) => !skip.has(p.pid) && !NAMES.test(p.name) && (lc(p.exe).startsWith(root) || lc(p.cmd).includes(root)));
}

// To the Recycle Bin, not deleted. The folder this script runs from can only go after the script has exited.
function recycleFolder() {
    if (!win) { say('  moving to the Recycle Bin works on Windows only. Delete the folder by hand.'); return; }
    const body = `$p='${psq(ROOT)}'; Add-Type -AssemblyName Microsoft.VisualBasic; for($i=0;$i -lt 8;$i++){ try{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin'); exit 0 }catch{ $e=$_.Exception.Message; Start-Sleep -Seconds 2 } }; Write-Output $e; exit 1`;
    if (lc(ROOT) === lc(SELF)) {
        spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep -Seconds 2; ${body}`], { cwd: require('os').tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return say('  The folder moves to the Recycle Bin a few seconds after this window closes its files.');
    }
    try { execFileSync('powershell', ['-NoProfile', '-Command', body], { encoding: 'utf8', timeout: 120000 }); say('  Moved to the Recycle Bin.'); }
    catch (e) {
        say(`  Windows would not move the folder: ${String(e.stdout || e.message).trim().split('\n')[0]}`);
        const m = mentions();
        if (m.length) say(`  Programs that were opened with this folder: ${m.map((p) => `${p.name} (${p.pid})`).join(', ')}. Close them and run this again.`);
        say('  Also close any Explorer or command window that is open inside the folder, then run this again. If it still fails, restart the PC and run this first.');
    }
}

// One reader for all questions, so lines typed or piped ahead of a question are not lost.
const lines = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const ask = async (q) => { process.stdout.write(q); const r = await lines.next(); return r.done ? '' : r.value.trim(); };

(async () => {
    // Any install folder can be removed from here (for example old test copies whose own folder cannot be deleted).
    const isInstall = (d) => fs.existsSync(path.join(d, 'panel', 'server.js'));
    for (;;) {
        const given = (await ask(`Folder to uninstall (press Enter for this folder: ${SELF})\nYou can paste a path; "Copy as path" in Explorer works: `)).replace(/^"+|"+$/g, '');
        if (!given) break;
        const target = path.resolve(given);
        const inner = (() => { try { return fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory() && isInstall(path.join(target, e.name))); } catch { return []; } })();
        if (!fs.existsSync(target)) { say('That folder does not exist. Try again, or press Enter for this folder.\n'); continue; }
        if (!isInstall(target) && !inner.length) { say('That folder is not a Grady Set Go install (no panel folder in it or directly below it). Try again.\n'); continue; }
        if (lc(SELF).startsWith(lc(target) + path.sep) && lc(SELF) !== lc(target)) { say('That folder contains the copy you are running this from. Choose another one.\n'); continue; }
        ROOT = target;
        break;
    }
    let version = ''; try { version = ` (version ${fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()})`; } catch { /* none */ }
    say(`\nGrady Set Go - uninstall\nFolder: ${ROOT}${version}\n`);
    const running = ours();
    say(running.length ? `Running from this folder now: ${[...new Set(running.map((p) => p.name))].join(', ')}.` : 'Nothing from this folder is running now.');
    say(`
  1  Stop the programs that run from this folder.
  2  Stop them and remove the Windows autostart tasks that point here.
  3  Remove this install completely: do 1 and 2, then move the whole folder, with its settings,
     playlists and data, to the Recycle Bin.

Stopping ffplayout ends any stream that is on air. Your media folder is never touched.`);
    let choice;
    for (;;) {
        choice = await ask('\nChoose 1, 2 or 3 (Enter cancels): ');
        if (choice === '') return say('Cancelled. Nothing was changed.');
        if (!['1', '2', '3'].includes(choice)) { say(`"${choice}" is not one of the choices. Type 1, 2 or 3, or press Enter to cancel.`); continue; }
        if (choice === '3') { if ((await ask('Type DELETE to move this whole install to the Recycle Bin: ')) === 'DELETE') break; say('Not confirmed. Choose again.'); }
        else if (/^y/i.test(await ask('Stop everything that runs from this folder? [y/N] '))) break;
        else say('Not confirmed. Choose again.');
    }
    say('\nStopping programs ...');
    let ok = stopAll();
    if (choice !== '1') { say('\nAutostart tasks ...'); ok = removeTasks() && ok; }
    if (choice === '3') {
        if (!ok) return say('\nSome programs or tasks could not be stopped, so the folder was not removed. Run this again as administrator.');
        say('\nMoving the folder to the Recycle Bin ...');
        recycleFolder();
    }
    say('\nDone.');
})().then(() => process.exit(0)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
