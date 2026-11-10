// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Timed text: reading whisper.cpp output and the panel's transcript format.
//
// data\transcripts\<clip id>.json = {
//   version: 1, model, created, language, duration_s,
//   lines: [{ s, e, text, flags: [] }],     s/e in seconds (3 decimals)
//   no_speech: bool,                        more than 80% of the lines are flagged
//   flagged: n, source: 'whisper-json' | 'srt'
// }
//
// whisper's -ojf JSON can hold raw control characters and broken UTF-8 inside token
// texts, so JSON.parse fails on it. readWhisperJson() decodes with replacement, escapes
// control characters inside strings and parses; if that still fails it pulls the
// segment-level offsets and texts out with a pattern; the caller falls back to the SRT.
//
// Known whisper failure over music or silence: it invents parliament phrases ("חבר הכנסת",
// "אדוני היושב-ראש"...), repeats words, or writes "תודה רבה" every 30 seconds. Such lines are
// FLAGGED, never removed: flags are 'knesset', 'repeated_words', 'empty', 'thanks_loop'.
'use strict';

const VERSION = 1;
const FORMAT_CONTROLS = /[‎‏‪-‮⁦-⁩﻿]/g;

const cleanText = (t) => String(t || '').replace(FORMAT_CONTROLS, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// Escapes raw control characters that appear inside JSON strings.
function sanitizeJsonText(s) {
    let out = '', inStr = false, esc = false, last = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === 0x5c) { esc = true; continue; }
            if (c === 0x22) { inStr = false; continue; }
            if (c < 0x20) { out += s.slice(last, i) + ' '; last = i + 1; }
        } else if (c === 0x22) inStr = true;
    }
    return out + s.slice(last);
}

// Buffer (or string) of whisper -ojf output -> [{ s, e, text }] or null.
function readWhisperJson(buf) {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    let j = null;
    try { j = JSON.parse(text); } catch { try { j = JSON.parse(sanitizeJsonText(text)); } catch { j = null; } }
    if (j && Array.isArray(j.transcription)) {
        return j.transcription.map((x) => ({ s: Number(x?.offsets?.from) / 1000, e: Number(x?.offsets?.to) / 1000, text: cleanText(x?.text) }))
            .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e));
    }
    // Last resort: segment objects have "offsets" followed by "text" at segment level.
    const out = [];
    const re = /"offsets"\s*:\s*\{\s*"from"\s*:\s*(\d+)\s*,\s*"to"\s*:\s*(\d+)\s*\}\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"tokens"/g;
    let m;
    while ((m = re.exec(text))) {
        let t = m[3];
        try { t = JSON.parse(sanitizeJsonText(`"${t}"`)); } catch { /* keep raw */ }
        out.push({ s: Number(m[1]) / 1000, e: Number(m[2]) / 1000, text: cleanText(t) });
    }
    return out.length ? out : null;
}

const srtTime = (t) => { const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(t); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : NaN; };
function readSrt(text) {
    const out = [];
    const blocks = String(text || '').replace(/^﻿/, '').split(/\r?\n\s*\r?\n/);
    for (const b of blocks) {
        const lines = b.split(/\r?\n/);
        const i = lines.findIndex((l) => l.includes('-->'));
        if (i < 0) continue;
        const [a, z] = lines[i].split('-->');
        const s = srtTime(a), e = srtTime(z);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        out.push({ s, e, text: cleanText(lines.slice(i + 1).join(' ')) });
    }
    return out;
}

// ---- hallucination flags --------------------------------------------------------------
const KNESSET = ['חבר הכנסת', 'חברי הכנסת', 'חברת הכנסת', 'כנסת נכבדה', 'אדוני היושב-ראש', 'אדוני היושב ראש', 'היושב-ראש', 'היושב ראש'];
const norm = (t) => cleanText(t).replace(/[״"'׳.,!?;:()\-–—…]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t) => norm(t).split(' ').filter(Boolean);
const knessetHits = (t) => { const x = cleanText(t); let n = 0; for (const p of KNESSET) { let i = -1; while ((i = x.indexOf(p, i + 1)) >= 0) n++; } return n; };
const THANKS = new Set(['תודה רבה', 'תודה רבה לכם', 'תודה רבה לך']);

function flagLines(lines) {
    for (const l of lines) l.flags = Array.isArray(l.flags) ? l.flags.filter((f) => !['knesset', 'repeated_words', 'empty', 'thanks_loop'].includes(f)) : [];
    const kn = lines.map((l) => knessetHits(l.text));
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const w = words(l.text);
        if (!w.length) { l.flags.push('empty'); continue; }
        if ((w.length > 6 && new Set(w).size / w.length < 0.35) || (w.length >= 3 && new Set(w).size === 1)) l.flags.push('repeated_words');
        if (kn[i]) {
            // A real podcast can talk about the Knesset: only repeated parliament phrases count.
            let near = 0;
            for (let k = 0; k < lines.length; k++) if (kn[k] && Math.abs(lines[k].s - l.s) <= 180) near++;
            const selfRepeat = kn[i] >= 2 || (i > 0 && norm(lines[i - 1].text) === norm(l.text)) || (i + 1 < lines.length && norm(lines[i + 1].text) === norm(l.text));
            if (near >= 2 || selfRepeat) l.flags.push('knesset');
        }
    }
    // "תודה רבה" written on exact 30-second steps (whisper's window over music or silence).
    const th = lines.map((l, i) => (THANKS.has(norm(l.text)) ? i : -1)).filter((i) => i >= 0);
    for (const i of th) {
        const on30 = th.some((k) => k !== i && (() => { const d = Math.abs(lines[k].s - lines[i].s); return d >= 29.9 && Math.abs(d / 30 - Math.round(d / 30)) * 30 < 0.06; })());
        if (on30) lines[i].flags.push('thanks_loop');
    }
    const flagged = lines.filter((l) => l.flags.length).length;
    return { flagged, no_speech: !lines.length || flagged / lines.length > 0.8 };
}

const r3 = (x) => Math.round(x * 1000) / 1000;
// Segments -> the stored transcript object.
function build(segments, { model = '', created = new Date().toISOString(), source = 'whisper-json', duration_s = null, language = 'auto' } = {}) {
    const lines = (segments || []).map((x) => ({ s: r3(Math.max(0, x.s)), e: r3(Math.max(x.s, x.e)), text: cleanText(x.text), flags: [] }));
    lines.sort((a, b) => a.s - b.s);
    const f = flagLines(lines);
    return { version: VERSION, model, created, language, duration_s, source, lines, flagged: f.flagged, no_speech: f.no_speech };
}

// whisper output files (prefix.json / prefix.srt) -> transcript object, or null.
function fromWhisperFiles(fs, prefix, opts = {}) {
    let segs = null, source = 'whisper-json';
    try { segs = readWhisperJson(fs.readFileSync(prefix + '.json')); } catch { segs = null; }
    if (!segs || !segs.length) {
        try { const s = readSrt(fs.readFileSync(prefix + '.srt', 'utf8')); if (s.length || segs) { segs = s; source = 'srt'; } } catch { /* none */ }
    }
    if (!segs) return null;
    return build(segs, { ...opts, source });
}

module.exports = { VERSION, cleanText, sanitizeJsonText, readWhisperJson, readSrt, flagLines, build, fromWhisperFiles, words, norm };
