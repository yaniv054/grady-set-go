// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const R = require('./registry');

// --- overnight analysis -----------------------------------------------------------
// results.jsonl has one line per clip and check; the latest line wins. New lines are
// read incrementally (only the bytes added since the last read).
const PROBLEM_FLAGS = new Set(['combed', 'silent', 'no_audio', 'no_video', 'one_channel', 'clipping', 'quiet', 'loud', 'dual_mono', 'phase', 'long_silence', 'check_failed']);
// Clips with these are left out by Generate when "skip problem clips" is on.
const SKIP_FLAGS = new Set(['combed', 'silent', 'no_audio', 'no_video', 'one_channel', 'check_failed']);
const ISSUE_GROUPS = {
    problems: (f) => f.some((x) => PROBLEM_FLAGS.has(x)),
    level: (f) => f.includes('quiet') || f.includes('loud'),
    mono: (f) => f.includes('dual_mono') || f.includes('one_channel') || f.includes('phase'),
    edges: (f) => ['head_black', 'tail_black', 'head_silence', 'tail_silence'].some((x) => f.includes(x)),
};
let an = { size: 0, map: new Map(), rest: Buffer.alloc(0) }, anChecked = 0;
function analysisIndex() {
    // Checked at most once a second: the clip list calls this for every clip.
    if (Date.now() - anChecked < 1000) return an.map;
    anChecked = Date.now();
    let st;
    try { st = fs.statSync(R.core.ANALYSIS_RESULTS); } catch { if (an.size) an = { size: 0, map: new Map(), rest: Buffer.alloc(0) }; return an.map; }
    if (st.size < an.size) an = { size: 0, map: new Map(), rest: Buffer.alloc(0) };
    if (st.size > an.size) {
        const fd = fs.openSync(R.core.ANALYSIS_RESULTS, 'r');
        try {
            const buf = Buffer.alloc(st.size - an.size);
            fs.readSync(fd, buf, 0, buf.length, an.size);
            an.size = st.size;
            const all = Buffer.concat([an.rest, buf]);
            const cut = all.lastIndexOf(0x0a);
            an.rest = cut >= 0 ? all.subarray(cut + 1) : all;
            if (cut >= 0) {
                for (const line of all.subarray(0, cut).toString('utf8').split('\n')) {
                    if (!line) continue;
                    let e; try { e = JSON.parse(line); } catch { continue; }
                    if (!e.id || !e.analyzer) continue;
                    const cur = an.map.get(e.id) || {};
                    cur[e.analyzer] = { version: e.version, at: e.at, secs: e.secs ?? null, result: e.result || null, error: e.error || null };
                    an.map.set(e.id, cur);
                }
            }
        } finally { fs.closeSync(fd); }
    }
    return an.map;
}
// Checks that only produce a by-product (thumbnail, timed text) do not count as "checked".
const INFO_ANALYZERS = new Set(['thumb', 'transcript']);
function analysisSummary(id) {
    const e = analysisIndex().get(id);
    const checks = e ? Object.keys(e).filter((k) => !INFO_ANALYZERS.has(k)) : [];
    if (!checks.length) return { checked: false, flags: [] };
    const flags = new Set();
    for (const k of checks) {
        const a = e[k];
        if (a.error) flags.add('check_failed');
        for (const f of a.result?.flags || []) flags.add(f);
    }
    return { checked: true, checks, flags: [...flags] };
}
const hasSkipIssue = (id) => analysisSummary(id).flags.some((f) => SKIP_FLAGS.has(f));
function matchIssue(s, issue) {
    if (issue === 'unchecked') return !s.checked;
    if (!s.checked) return false;
    if (issue === 'ok') return !s.flags.some((f) => PROBLEM_FLAGS.has(f));
    if (ISSUE_GROUPS[issue]) return ISSUE_GROUPS[issue](s.flags);
    return s.flags.includes(issue);
}
// Full details for the clip editor, with derived suggestions.
function analysisDetail(id) {
    const e = analysisIndex().get(id) || {};
    const a = e.audio?.result, v = e.video?.result;
    const trim = {};
    // Trim only where the picture is black AND the sound is silent.
    if (a && v) {
        if (a.head_silence >= 0.5 && v.head_black >= 0.5) trim.in = Math.min(a.head_silence, v.head_black);
        if (a.tail_silence != null && v.tail_black != null) trim.out = Math.max(a.tail_silence, v.tail_black);
    }
    const last = Object.entries(e).filter(([k]) => !INFO_ANALYZERS.has(k)).map(([, x]) => x.at).filter(Boolean).sort().pop() || null;
    return { checks: e, last_checked: last, summary: analysisSummary(id), gain_to_minus14: a && a.lufs != null && a.lufs > -60 ? Math.round((-14 - a.lufs) * 10) / 10 : null, trim };
}
function analysisStatus() {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(R.core.ANALYSIS_STATUS, 'utf8')); } catch { /* never run */ }
    if (st && st.running) {
        let alive = false;
        try { process.kill(st.pid, 0); alive = true; } catch { /* gone */ }
        if (!alive) { st.running = false; st.reason = st.reason || 'ended unexpectedly'; }
    }
    const idx = analysisIndex();
    let checked = 0;
    for (const id of R.media.libraryById().keys()) if (idx.has(id) && analysisSummary(id).checked) checked++;
    return { status: st, clips: R.media.libraryById().size, checked, stop_requested: fs.existsSync(R.core.ANALYSIS_STOP) };
}
// The check modules (id, version) as the runner will load them. When any of them changes
// on disk, all are loaded again.
let analyzerSig = '';
function analyzerModules() {
    const dir = path.join(path.dirname(R.core.DEEP_SCAN), 'analyzers');
    const out = new Map();
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { return out; }
    const sig = files.map((f) => { try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`; } catch { return f; } }).join('|');
    if (sig !== analyzerSig) {
        if (analyzerSig) for (const k of Object.keys(require.cache)) if (path.dirname(k) === dir) delete require.cache[k];
        analyzerSig = sig;
    }
    for (const f of files) {
        try { const m = require(path.join(dir, f)); if (m && m.id && typeof m.run === 'function') out.set(m.id, m); } catch (e) { console.error('analyzer', f, e.message); }
    }
    return out;
}
// What a run would do, without running it: clips per check, an estimate from the
// measured time per check, and how many clips would get a cleaned-up title.
function analysisPlan({ mode, checks, ids }) {
    const mods = analyzerModules();
    const want = (Array.isArray(checks) ? checks : []).map(String).filter((c) => mods.has(c));
    const all = mode === 'all';
    const idx = analysisIndex();
    // Clips hidden on the Needs attention page are not checked.
    const off = R.attention.hiddenClipIds();
    const pool = (Array.isArray(ids) ? ids.filter((id) => R.media.libraryById().has(id)) : [...R.media.libraryById().keys()]).filter((id) => !off.has(id));
    const per = Object.fromEntries(want.map((c) => [c, 0]));
    const needs = new Map();
    let trIds = null;
    const haveTr = () => trIds || (trIds = new Set((() => { try { return fs.readdirSync(R.songs.TRANSCRIPTS_DIR); } catch { return []; } })().map((n) => /^(c[0-9a-f]{15})\.json$/.exec(n)?.[1]).filter(Boolean)));
    for (const id of pool) {
        const rows = R.media.libraryById().get(id);
        if (!rows || Number(rows[0].duration_s) < 1) continue;
        const e = idx.get(id) || {};
        // Timed text imported or made earlier (a transcript file exists) is not done again in mode "new".
        const todo = want.filter((c) => all || (e[c]?.version !== mods.get(c).version && !(c === 'transcript' && haveTr().has(id))));
        if (!todo.length) continue;
        needs.set(id, todo);
        for (const c of todo) per[c]++;
    }
    // Average seconds per clip for each check, from recorded runs (at least 5 clips).
    const sum = {}, cnt = {};
    for (const e of idx.values()) for (const [c, x] of Object.entries(e)) if (x.secs != null) { sum[c] = (sum[c] || 0) + x.secs; cnt[c] = (cnt[c] || 0) + 1; }
    const avg = Object.fromEntries(Object.keys(sum).filter((c) => cnt[c] >= 5).map((c) => [c, sum[c] / cnt[c]]));
    // Timed text before any recorded run: whisper does about 1.8x real time with 6 threads.
    if (want.includes('transcript') && avg.transcript == null && per.transcript) {
        let secs = 0;
        for (const [id, todo] of needs) if (todo.includes('transcript')) secs += Number(R.media.libraryById().get(id)[0].duration_s) || 0;
        avg.transcript = secs / 1.8 / per.transcript;
    }
    const known = want.filter((c) => per[c]).every((c) => avg[c] != null);
    const est_s = known ? Math.round(want.reduce((t, c) => t + per[c] * (avg[c] || 0), 0)) : null;
    let transcript = null;
    if (want.includes('transcript')) { const m = mods.get('transcript'); try { transcript = m.available ? m.available() : { ok: true }; } catch (e) { transcript = { ok: false, why: e.message }; } }
    // Clean titles (metadata): how many clips in this run still carry the raw file name as
    // their title and would get the cleaned-up one from the Metadata check.
    let titles = null;
    if (want.includes('meta')) {
        const store = R.metadata.loadMeta();
        titles = { would: 0, kept: 0 };
        for (const [id, todo] of needs) { if (!todo.includes('meta')) continue; if (store.clips[id]?.title) titles.kept++; else titles.would++; }
    }
    return { mode: all ? 'all' : 'new', checks: want, pool: pool.length, clips: needs.size, per, avg_s: avg, est_s, titles, transcript: transcript && { ok: !!transcript.ok, why: transcript.why || '' }, cpu_threads: os.cpus().length };
}
// The runner writes status.json only once it is under way: a second start in the
// meantime (double-click) is refused for 15 s, or while the started process is alive.
let analysisStarting = { at: 0, pid: null };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function startAnalysis({ mode, checks, until, jobs, ids, threads, credits, titles }) {
    // The media share is read-only: no check may change a file on it. The former
    // "Change file name" check is refused here whatever the caller sends.
    if ((Array.isArray(checks) ? checks : []).map(String).includes('rename')) throw Object.assign(new Error('Files on the share are never renamed. Use "Clean titles" to store the cleaned-up title as metadata instead.'), { status: 400 });
    const cur = analysisStatus().status;
    // Just started and the runner has not written its status yet (double-click, two tabs).
    const starting = analysisStarting.pid && Date.now() - analysisStarting.at < 60000 && cur?.pid !== analysisStarting.pid && pidAlive(analysisStarting.pid);
    if (cur?.running || starting) throw Object.assign(new Error('The analysis is already running. Wait for it to finish or press Stop in the Library first.'), { status: 409 });
    if (!fs.existsSync(R.core.DEEP_SCAN)) throw Object.assign(new Error(`Not found: ${R.core.DEEP_SCAN}`), { status: 404 });
    const list = (Array.isArray(checks) ? checks : []).map(String).filter((c) => /^[a-z0-9_-]{1,30}$/.test(c));
    const u = String(until || '').trim();
    if (u && !/^\d{1,2}:\d{2}$/.test(u)) throw Object.assign(new Error('Stop time must be HH:MM.'), { status: 400 });
    fs.mkdirSync(R.core.ANALYSIS_DIR, { recursive: true });
    try { fs.unlinkSync(R.core.ANALYSIS_STOP); } catch { /* none */ }
    const argv = [R.core.DEEP_SCAN, '--mode', mode === 'all' ? 'all' : 'new', '--data', R.core.DATA_DIR, '--library', R.core.LIBRARY_CSV, '--jobs', String(Math.min(4, Math.max(1, Number(jobs) || 1)))];
    if (list.length) argv.push('--checks', list.join(','));
    // Selected clips only (bulk action or "Check again" in the clip editor).
    const off = R.attention.hiddenClipIds();
    if (!Array.isArray(ids) && off.size) ids = [...R.media.libraryById().keys()].filter((id) => !off.has(id));
    if (Array.isArray(ids)) {
        const known = ids.filter((id) => R.media.libraryById().has(id) && !off.has(id));
        if (!known.length) throw Object.assign(new Error('None of these clips is in the library.'), { status: 400 });
        const qf = path.join(R.core.ANALYSIS_DIR, 'queue.json');
        fs.writeFileSync(qf, JSON.stringify(known), 'utf8');
        argv.push('--ids-file', qf);
    }
    if (u) argv.push('--until', u);
    argv.push('--playlists', R.core.PLAYLISTS_DIR);
    // Timed text: whisper threads, and the credits lookup after it.
    const th = Math.round(Number(threads) || 0);
    if (th > 0) argv.push('--threads', String(Math.min(os.cpus().length, th)));
    if (credits && list.includes('transcript')) argv.push('--credits');
    if (process.env.PANEL_FFMPEG_BIN) argv.push('--bin', process.env.PANEL_FFMPEG_BIN);
    const logFd = fs.openSync(R.core.DEEP_SCAN_LOG, 'a');
    // Detached, so a panel restart does not stop an overnight run.
    let child;
    try { child = spawn(process.execPath, argv, { cwd: path.dirname(R.core.DEEP_SCAN), detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd] }); }
    finally { fs.closeSync(logFd); }
    child.on('error', () => {});
    child.unref();
    analysisStarting = { at: Date.now(), pid: child.pid || null };
    // Clean titles once the run has ended (needs the Metadata check in this run).
    if (titles && list.includes('meta')) R.core.writeJsonAtomic(TITLES_AFTER, { pid: child.pid || null, ids: Array.isArray(ids) ? ids : null, at: new Date().toISOString() }, 1);
    else { try { fs.unlinkSync(TITLES_AFTER); } catch { /* none */ } }
    return { started: true, pid: child.pid };
}
// Clean titles: when a run was started with "titles" and it has ended, every clip it
// checked whose title is still the raw file name gets the cleaned-up title from the
// Metadata check, stored as metadata (the file on the share is never renamed).
// The request is kept in data\analysis\titles-after.json so it survives a panel restart.
const TITLES_AFTER = path.join(R.core.ANALYSIS_DIR, 'titles-after.json');
function applyTitlesAfterRun() {
    let want;
    try { want = JSON.parse(fs.readFileSync(TITLES_AFTER, 'utf8')); } catch { return; }
    let st;
    try { st = JSON.parse(fs.readFileSync(R.core.ANALYSIS_STATUS, 'utf8')); } catch { return; }
    if (st.running) return;
    // The runner identifies itself by pid in status.json. A request older than 2 days whose
    // run never wrote a status (failed to start) is dropped.
    if (st.pid !== want.pid) { if (Date.now() - Date.parse(want.at) > 2 * 86400e3) { try { fs.unlinkSync(TITLES_AFTER); } catch { /* gone */ } } return; }
    if (!st.finished) return;
    const ids = Array.isArray(want.ids) ? want.ids : [...R.media.libraryById().keys()];
    try {
        const r = R.attention.applySuggestions(ids, ['title']);
        console.log(`clean titles after run ${st.started}: ${r.changed} of ${r.matched} clips`);
    } catch (e) { console.error('clean titles', e.message); }
    try { fs.unlinkSync(TITLES_AFTER); } catch { /* gone */ }
}
setInterval(applyTitlesAfterRun, 60000).unref();


// ---- exports (read by the other modules through R.analysis) ----
R.analysis = module.exports;
Object.assign(module.exports, { PROBLEM_FLAGS, SKIP_FLAGS, ISSUE_GROUPS, analysisIndex, INFO_ANALYZERS, analysisSummary, hasSkipIssue, matchIssue, analysisDetail, analysisStatus, analyzerModules, analysisPlan, pidAlive, startAnalysis, TITLES_AFTER, applyTitlesAfterRun });
Object.defineProperty(module.exports, 'an', { get: () => an, set: (v) => { an = v; }, enumerable: true });
Object.defineProperty(module.exports, 'anChecked', { get: () => anChecked, set: (v) => { anChecked = v; }, enumerable: true });
Object.defineProperty(module.exports, 'analyzerSig', { get: () => analyzerSig, set: (v) => { analyzerSig = v; }, enumerable: true });
Object.defineProperty(module.exports, 'analysisStarting', { get: () => analysisStarting, set: (v) => { analysisStarting = v; }, enumerable: true });
