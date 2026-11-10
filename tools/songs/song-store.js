// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Files for timed text, songs and credits (shared by the panel server and the tools).
//
//   data\transcripts\<clip id>.json   timed text (tools\whisper\transcript-format.js)
//   data\songs\<clip id>.json         songs found in the clip (tools\songs\detect-songs.js)
//   data\credits\musicbrainz-cache.json  MusicBrainz answers by query, reused for 30 days
//   data\credits\wikidata-cache.json  Wikidata answers by query
//   data\credits\aliases.json         heard spelling -> registered name / title
//
// Every write goes to a temp file that is flushed to disk and then renamed into place.
// A file that cannot be read (damaged JSON) is never overwritten: reads report it and
// writes refuse with status 503 until it is repaired or moved aside by hand.
// Several processes (the panel, the overnight run, the CLI) can write the same files:
// changes are made under a short lock (a folder created atomically) by re-reading the
// file, applying the change and writing it back.
'use strict';
const fs = require('fs');
const path = require('path');

const ID_RE = /^c[0-9a-f]{15}$/;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameRetry(from, to) {
    for (let i = 0; ; i++) {
        try { return fs.renameSync(from, to); }
        catch (e) { if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; sleepSync(200); }
    }
}
function writeJsonAtomic(file, obj, space) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now() % 100000}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(obj, null, space), null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { renameRetry(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
const damaged = (file, e) => Object.assign(new Error(`${file} is damaged (${e.message.slice(0, 120)}). It is left as it is: repair it or move it aside, then try again.`), { status: 503, damaged: true });

// { doc } when the file is readable, { doc: null } when it does not exist; throws `damaged`.
function readJson(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw damaged(file, e); }
}

// Cross-process lock: a folder next to the file. A lock older than 15 s is stale.
// withLock waits by blocking (tools: CLI, overnight run); withLockAsync waits without
// blocking the event loop (the panel) and gives up with 503 after `maxWaitMs`.
// Windows can answer EPERM/EACCES instead of EEXIST while another process is creating or
// removing the folder: treated as "busy" too.
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES']);
function tryLock(lock) {
    try { fs.mkdirSync(lock); return true; } catch (e) {
        if (!BUSY.has(e.code)) throw e;
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return false; /* just released: try again */ }
        if (age > 15000) { try { fs.rmdirSync(lock); } catch { /* another process took it */ } }
        return false;
    }
}
const busyErr = (file) => Object.assign(new Error(`${path.basename(file)} is busy (another process is writing it). Try again.`), { status: 503 });
function release(lock) { try { fs.rmdirSync(lock); } catch { /* gone */ } }
function withLock(file, fn, { maxWaitMs = 10000 } = {}) {
    const lock = file + '.lock';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t0 = Date.now();
    while (!tryLock(lock)) {
        if (Date.now() - t0 > maxWaitMs) throw busyErr(file);
        sleepSync(25);
    }
    try { return fn(); } finally { release(lock); }
}
async function withLockAsync(file, fn, { maxWaitMs = 3000 } = {}) {
    const lock = file + '.lock';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t0 = Date.now();
    while (!tryLock(lock)) {
        if (Date.now() - t0 > maxWaitMs) throw busyErr(file);
        await new Promise((r) => setTimeout(r, 25));
    }
    try { return fn(); } finally { release(lock); }
}

// Re-reads the file under the lock, applies fn(current or null) and writes its result
// (unless fn returns undefined). A damaged file is never replaced.
const applyUpdate = (file, fn, space) => () => {
    const cur = readJson(file);
    const next = fn(cur);
    if (next !== undefined) writeJsonAtomic(file, next, space);
    return next;
};
function updateJson(file, fn, space = 1) { return withLock(file, applyUpdate(file, fn, space)); }
function updateJsonAsync(file, fn, space = 1) { return withLockAsync(file, applyUpdate(file, fn, space)); }

const dirs = (dataDir) => ({
    transcripts: path.join(dataDir, 'transcripts'),
    songs: path.join(dataDir, 'songs'),
    credits: path.join(dataDir, 'credits'),
});
const checkId = (id) => { if (!ID_RE.test(String(id))) throw Object.assign(new Error('unknown clip id'), { status: 400 }); return String(id); };
const transcriptFile = (dataDir, id) => path.join(dirs(dataDir).transcripts, `${checkId(id)}.json`);
const songsFile = (dataDir, id) => path.join(dirs(dataDir).songs, `${checkId(id)}.json`);

function readSongs(dataDir, id) { return readJson(songsFile(dataDir, id)); }
function readTranscript(dataDir, id) { return readJson(transcriptFile(dataDir, id)); }
function writeTranscript(dataDir, id, tr) { writeJsonAtomic(transcriptFile(dataDir, id), tr); }
function updateSongs(dataDir, id, fn) { return updateJson(songsFile(dataDir, id), fn); }
function updateSongsAsync(dataDir, id, fn) { return updateJsonAsync(songsFile(dataDir, id), fn); }

// Clip ids with a songs file / a transcript (from the folder listing).
function listIds(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.map((n) => /^(c[0-9a-f]{15})\.json$/.exec(n)?.[1]).filter(Boolean);
}

module.exports = { ID_RE, writeJsonAtomic, readJson, withLock, withLockAsync, updateJson, updateJsonAsync, updateSongsAsync, dirs, transcriptFile, songsFile, readSongs, readTranscript, writeTranscript, updateSongs, listIds, renameRetry, sleepSync };
