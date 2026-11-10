// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Timed text (opt-in; off unless "Timed text" is ticked in the Overnight analysis card).
//
// Transcribes the clip's sound with whisper.cpp (model and language from config.json
// "whisper_model" and "whisper_language"; default: automatic language), then finds
// the songs in it (tools\songs\detect-songs.js) and, when the run was started with
// "Look up credits", looks their credits up (tools\credits\lookup-credits.js).
//
// READ-ONLY on the media share: ffmpeg reads the clip and writes a 16 kHz mono WAV to
// data\transcripts\_tmp (deleted after the clip, also when the run is stopped).
// Output: data\transcripts\<clip id>.json (+ .srt) and data\songs\<clip id>.json.
// whisper runs below normal priority with the thread count set in the card (default: half
// of the CPU threads). A STOP request kills whisper at once; that clip is done again next run.
// When whisper-cli.exe or the model is missing, the clip is skipped (tried again next run)
// and the log says what to install.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const T = require('../whisper/transcript-format');
const D = require('../songs/detect-songs');
const store = require('../songs/song-store');

const TOOLS = path.dirname(__dirname);
const WHISPER = path.join(TOOLS, 'whisper');
const MODEL_NAME = require('../../panel/config').whisperModel;

function findCli(dir, depth = 0) {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 6) { const r = findCli(p, depth + 1); if (r) return r; }
        else if (/^whisper-cli(\.exe)?$/i.test(e.name)) return p;
    }
    return null;
}
// { ok, cli, model, why }: what the run needs, found or not.
function available() {
    const cli = process.env.WHISPER_CLI || findCli(path.join(WHISPER, 'bin'));
    const model = process.env.WHISPER_MODEL || path.join(WHISPER, 'models', MODEL_NAME);
    if (!cli) return { ok: false, why: `whisper-cli.exe not found under ${path.join(WHISPER, 'bin')}. Run tools\\whisper\\setup-whisper.ps1.` };
    if (!fs.existsSync(model)) return { ok: false, why: `Model not found: ${model}. Run tools\\whisper\\setup-whisper.ps1.` };
    return { ok: true, cli, model };
}
let warned = false;
let creditsClient = null, creditsOff = false, clipCtx = null, tmpCleaned = false;

module.exports = {
    id: 'transcript',
    version: 1,
    label: 'Timed text',
    optIn: true,
    order: 90,
    available,
    async run(ctx) {
        const row = ctx.row;
        if (!row.audio_codec) return { skipped: 'no audio' };
        const out = store.transcriptFile(ctx.dataDir, ctx.id);
        if (!ctx.force && fs.existsSync(out)) return { file: path.basename(out), existing: true };
        const w = available();
        if (!w.ok) {
            if (!warned) { console.log(`${new Date().toISOString()} Timed text skipped: ${w.why}`); warned = true; }
            return { retry: true };
        }
        const tmpDir = path.join(store.dirs(ctx.dataDir).transcripts, '_tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        // Once per run: WAV files left by a run that was killed (power cut, Task Manager).
        if (!tmpCleaned) {
            tmpCleaned = true;
            try { for (const n of fs.readdirSync(tmpDir)) if (/\.wav$/i.test(n)) { try { fs.unlinkSync(path.join(tmpDir, n)); } catch { /* in use */ } } } catch { /* none */ }
        }
        const base = path.join(tmpDir, `${ctx.id}.${process.pid}`);
        const wav = base + '.wav';
        const cores = os.cpus().length || 2;
        const threads = Math.max(1, Math.min(cores, Number(ctx.threads) || Math.floor(cores / 2) || 1));
        const dur = Number(row.duration_s) || 3600;
        const t0 = Date.now();
        try {
            const a = await ctx.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', ctx.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeout: Math.max(10 * 60e3, dur * 1000) });
            if (a.code !== 0 || !fs.existsSync(wav)) throw new Error(`audio extraction failed: ${a.stderr.trim().split(/\r?\n/).pop() || `ffmpeg exit ${a.code}`}`);
            const r = await ctx.run(w.cli, ['-m', w.model, '-f', wav, '-l', require('../../panel/config').whisperLanguage, '-t', String(threads), '-ojf', '-osrt', '-of', base], { timeout: Math.max(60 * 60e3, dur * 2000 + 20 * 60e3) });
            if (r.code !== 0) throw new Error(`whisper failed (exit ${r.code}): ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 250)}`);
            const tr = T.fromWhisperFiles(fs, base, { model: path.basename(w.model, '.bin'), duration_s: dur, language: require('../../panel/config').whisperLanguage });
            if (!tr) throw new Error('whisper wrote no readable output');
            tr.threads = threads;
            tr.work_s = Math.round((Date.now() - t0) / 1000);
            store.writeTranscript(ctx.dataDir, ctx.id, tr);
            try { fs.copyFileSync(base + '.srt', path.join(store.dirs(ctx.dataDir).transcripts, `${ctx.id}.srt`)); } catch { /* no srt */ }
            // Songs: confirmed and edited songs stay as they are.
            const auto = D.detect(tr);
            let songs = 0;
            try {
                const doc = store.updateSongs(ctx.dataDir, ctx.id, (cur) => D.merge(cur, auto, { clipId: ctx.id }));
                songs = doc.songs.length;
            } catch (e) { console.log(`${new Date().toISOString()} songs for ${ctx.id} not saved: ${e.message}`); }
            let credits = null;
            if (ctx.lookupCredits && !creditsOff && songs) {
                try {
                    const L = require('../credits/lookup-credits');
                    creditsClient = creditsClient || L.createClient({ dataDir: ctx.dataDir });
                    clipCtx = clipCtx || L.clipContext(ctx.libraryCsv || require('../../panel/config').libraryCsv, path.join(ctx.dataDir, 'clip-metadata.json'));
                    credits = await L.lookupClip(ctx.dataDir, ctx.id, clipCtx.get(ctx.id) || { title: row.file, folder: row.folder }, creditsClient, { stop: () => !!(ctx.isStopping && ctx.isStopping()) });
                } catch (e) {
                    credits = { error: e.message.slice(0, 200) };
                    console.log(`${new Date().toISOString()} credits lookup: ${e.message}`);
                    // "format changed": no more lookups in this run (no guessing).
                    // Provider busy (429/503/redirect): also no more lookups this run; the CLI or the next run catches up.
                    if (e.code === 'CREDITS_FORMAT' || e.code === 'CREDITS_UNAVAILABLE') creditsOff = true;
                }
            }
            return { lines: tr.lines.length, flagged: tr.flagged, no_speech: tr.no_speech, songs, threads, audio_s: Math.round(dur), credits };
        } finally {
            for (const ext of ['.wav', '.json', '.srt']) { try { fs.unlinkSync(base + ext); } catch { /* none */ } }
        }
    },
};
