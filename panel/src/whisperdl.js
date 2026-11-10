// Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Downloads the speech-to-text tools (whisper.cpp program + speech model) into tools/whisper with progress the
// setup screen can show. Resumable: an interrupted model download continues where it stopped.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');

const MODEL_MULTI = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
const MODEL_HE = 'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin';
const GB = 1024 * 1024 * 1024;

const job = { running: false, finished: false, phase: '', done: 0, total: 0, error: '' };
const state = () => ({ ...job });

function request(url, { headers = {}, hops = 0 } = {}) {
    return new Promise((resolve, reject) => {
        if (hops > 6) return reject(new Error('too many redirects'));
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': 'grady-set-go', ...headers } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(request(new URL(res.headers.location, url).href, { headers, hops: hops + 1 })); }
            resolve(res);
        });
        req.setTimeout(60000, () => req.destroy(new Error('the connection timed out')));
        req.on('error', reject);
    });
}

async function getJson(url) {
    const res = await request(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode} for ${url}`); }
    const chunks = []; for await (const c of res) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Appends to dest when it already holds part of the file (Range request); starts over when the server ignores Range.
async function download(url, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const res = await request(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
    if (res.statusCode === 416 && have) { res.resume(); job.done = job.total = have; return; }   // already complete
    if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error(`HTTP ${res.statusCode} for ${url}`); }
    const resumed = res.statusCode === 206 && have > 0;
    const len = Number(res.headers['content-length']) || 0;
    job.done = resumed ? have : 0;
    job.total = len ? len + (resumed ? have : 0) : 0;
    await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
        res.on('data', (c) => { job.done += c.length; });
        res.on('error', (e) => { w.destroy(); reject(e); });
        res.on('aborted', () => reject(new Error('the connection was interrupted')));
        w.on('error', reject); w.on('finish', resolve);
        res.pipe(w);
    });
}

function extractZip(zip, dest) {
    fs.mkdirSync(dest, { recursive: true });
    if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest], { windowsHide: true });
    else execFileSync('unzip', ['-qo', zip, '-d', dest]);
}

function findFile(dir, re) {
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { const r = findFile(p, re); if (r) return r; } else if (re.test(e.name)) return p;
        }
    } catch { /* missing folder */ }
    return null;
}

async function run(cfg) {
    const dir = path.join(cfg.toolsDir, 'whisper'), bin = path.join(dir, 'bin'), models = path.join(dir, 'models');
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(models, { recursive: true });
    const CLI = /^whisper-cli(\.exe)?$/i;
    if (!findFile(bin, CLI)) {
        job.phase = 'program'; job.done = job.total = 0;
        const rels = await getJson(process.env.GSG_WHISPER_API || 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30');
        let rel = null, asset = null;
        for (const r of Array.isArray(rels) ? rels : []) {
            if (r.draft || r.prerelease) continue;
            const a = (r.assets || []).find((x) => x.name === 'whisper-bin-x64.zip');
            if (a) { rel = r; asset = a; break; }
        }
        if (!asset) throw new Error('No recent whisper.cpp release has a Windows build (whisper-bin-x64.zip)');
        const zip = path.join(dir, asset.name);
        try { fs.rmSync(zip, { force: true }); } catch { /* ignore */ }
        await download(asset.browser_download_url, zip);
        extractZip(zip, bin);
        fs.rmSync(zip, { force: true });
        if (!findFile(bin, CLI)) throw new Error('the download has no whisper-cli.exe');
        fs.writeFileSync(path.join(dir, 'version.txt'), `whisper.cpp ${rel.tag_name}\n`);
    }
    const target = path.join(models, cfg.whisperModel), min = Number(process.env.GSG_WHISPER_MIN_BYTES) || GB;
    if (!(fs.existsSync(target) && fs.statSync(target).size > min)) {
        job.phase = 'model'; job.done = job.total = 0;
        const part = `${target}.part`;
        await download(process.env.GSG_WHISPER_MODEL_URL || (/ivrit/i.test(cfg.whisperModel) ? MODEL_HE : MODEL_MULTI), part);
        if (fs.statSync(part).size < min) throw new Error('the model download is incomplete');
        fs.renameSync(part, target);
    }
}

function start(cfg) {
    if (job.running) return { already: true };
    Object.assign(job, { running: true, finished: false, phase: 'program', done: 0, total: 0, error: '' });
    run(cfg).catch((e) => { job.error = String((e && e.message) || e); })
        .finally(() => { job.running = false; job.finished = !job.error; });
    return { started: true };
}

module.exports = { start, state };
