// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Song detection inside clips, from the timed text (data\transcripts\<clip id>.json).
//
// Pure functions (no file or network access); the panel server and the overnight run
// require this module. CLI for tests:  node detect-songs.js <transcript.json> [--json]
//
// data\songs\<clip id>.json = { version, clipId, updated, detector, songs: [song], archived: [] }
// song = { id, s, e, title_heard, titles_heard: [], writers_heard: [], first_line, chorus_line,
//          status: 'suggested'|'confirmed'|'rejected'|'not_a_song', credits: {...}|null,
//          candidates: [], source: 'auto'|'person', confidence, hint, notes, confirmed_by, confirmed_at }
//
// How it works:
// 1. Every line gets a talk score: announcement words ("השיר נקרא", "מילים של", "הלחנתי", "תודה"),
//    numbers, sentence punctuation in the middle of a line. Lines that repeat other lines
//    nearby (a chorus), long unpunctuated lines and slow lines count as sung. Lines flagged
//    as whisper inventions (music or silence) count as music, never as talk.
// 2. Uncertain lines take the side of their neighbours.
// 3. A song is a run of sung lines lasting at least 60 s; talk, applause and gaps over 60 s
//    end it. The talk just before (or, for an opening song, just after) gives the title
//    and the writers heard.
// 4. chorus_line = the most repeated line of the song; first_line = its first sung line.
'use strict';
const crypto = require('crypto');

const DETECTOR = 'songs-1';
const MIN_SONG_S = 60;
const MAX_GAP_S = 60;

// ---- Hebrew text helpers (shared with tools\credits\lookup-credits.js) -------------------
const NIQQUD = /[֑-ׇ]/g;
const FORMAT = /[‎‏‪-‮⁦-⁩﻿]/g;
// Lower-case, no niqqud, no punctuation or quotes, single spaces.
function normHe(t) {
    return String(t || '').replace(FORMAT, '').replace(NIQQUD, '').toLowerCase()
        .replace(/[״"“”„'׳`’‘]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
// Also drops a leading ב/ה/ו/ש/ל from each word longer than 3 letters (for title comparison).
function normTitle(t) {
    return normHe(t).split(' ').map((w) => (w.length > 3 ? w.replace(/^(ו?ש?ה|ו?ב|ו?ל|ו?ש|ו)(?=[א-ת]{3})/, '') : w)).join(' ');
}
const tokens = (t) => normHe(t).split(' ').filter(Boolean);

// ---- line features ------------------------------------------------------------------------
const STRONG = new Set(['השיר', 'שיר', 'שירים', 'נקרא', 'נקראת', 'שנקרא', 'שנקראת', 'הלחנתי', 'שהלחנתי', 'הלחין', 'הלחינה', 'מילים', 'המילים', 'למילים', 'לחן', 'הלחן',
    'תודה', 'מחיאות', 'כפיים', 'אלבום', 'האלבום', 'לאלבום', 'תקליט', 'התקליט', 'פסטיבל', 'בפסטיבל', 'ביצוע', 'הביצוע', 'להקה', 'בלהקה', 'הלהקה', 'נמשיך', 'במקור',
    'הקלטתי', 'שהקלטתי', 'בשבילכם', 'לכבוד', 'נשיר', 'שרנו', 'תרגם', 'תרגום', 'עיבוד', 'העיבוד', 'הנגנים', 'מופע', 'המופע', 'הופעה', 'ההופעה', 'פתחנו', 'בפייסבוק',
    'שלישיית', 'השלישייה', 'אהבתי', 'הטקסט', 'בטקסט', 'בדרך', 'ערב', 'שלום', 'לכולם', 'סליחה', 'רציתי', 'להודות', 'לסיום', 'סיום', 'אחרון', 'הבא', 'הבאה', 'כתב', 'כתבה', 'כתבתי']);
const WEAK = new Set(['אני', 'אנחנו', 'זוכר', 'זוכרת', 'רוצה', 'בעצם', 'אז', 'טוב', 'ככה', 'עכשיו', 'שנים', 'שנות', 'שנת', 'מאוד', 'יחסית', 'בדיוק', 'כזה', 'איתי', 'שלי',
    'היה', 'הייתי', 'היינו', 'הייתה', 'שהיה', 'שהוא', 'שהיא', 'קצת', 'פה', 'הזה', 'הזאת', 'אתם', 'אתכם', 'לכם', 'שלנו', 'נכון', 'יודעים', 'חושב', 'חושבת', 'כאילו', 'בגלל', 'אבל']);
// Lyric fillers: these never make a line talk.
const SUNG_FILLERS = /^(לה|לא|נה|אה|או|הו|יה|הי|דה|דם|בם|שבה|לי|ליי|הא|אוו|וו|יא)$/;

const ANNOUNCE = [
    /(?:^|\s)(?:ו?ה?שיר\s+(?:ה?זה\s+)?|הוא\s+|היא\s+|ש)?נקרא(?:ת)?\s*[:,]?\s*$/u,                                   // "...השיר נקרא" (title on the next line)
    /(?:^|\s)(?:ו?ה?שיר\s+(?:ה?זה\s+)?|הוא\s+|היא\s+|ש|ו)?נקרא(?:ת)?\s+(.+)/u,
    /(?:^|\s)פתחנו\s+(?:עם\s+|ב)(?:ה?שיר\s+)?(.+)/u,
    /(?:^|\s)(?:ו?אז\s+)?הנה\s+(.+)/u,
];
const WRITER_PATTERNS = [
    [/(?:^|\s)(?:לפי\s+|ל|ה|ו)?מילים\s+של\s+(.+)/u, 'lyricist'],
    [/(?:^|\s)(?:את\s+)?ה?מילים\s+(?:שלו\s+|שלה\s+)?כתב(?:ה)?\s+(.+)/u, 'lyricist'],
    [/(?:^|\s)(?:ש)?כתב(?:ה)?\s+(?:לו\s+|לי\s+|לה\s+)?את\s+ה?מילים\s+(.+)/u, 'lyricist'],
    [/(?:^|\s)(?:ה|ו)?לחן\s+(?:של\s+)(.+)/u, 'composer'],
    [/(?:^|\s)(?:ש)?הלחינ?(?:ה)?\s+(?:אותו\s+|אותה\s+|את\s+השיר\s+)?(.+)/u, 'composer'],
    [/(?:^|\s)תרגמ?(?:ה)?\s+(?:אותו\s+|אותה\s+)?(.+)/u, 'translator'],
    [/(?:^|\s)עיבוד\s+(?:של\s+)?(.+)/u, 'arranger'],
];
const TITLE_STOP = new Set(['שוב', 'מילים', 'המילים', 'לחן', 'של', 'זה', 'והוא', 'והיא', 'אז', 'ככה', 'ואני', 'כי', 'שהוא', 'שהיא', 'שאת', 'שזה', 'שיר', 'והשיר', 'השיר', 'ועכשיו', 'אבל', 'וזה', 'הוא', 'היא', 'מאת', 'בביצוע', 'לפי', 'שכתב', 'שכתבה', 'שהלחין', 'שהלחנתי', 'ובעצם', 'בעצם']);
const NAME_STOP = new Set(['ו', 'והשיר', 'השיר', 'והוא', 'והיא', 'שהוא', 'שהיא', 'סליחה', 'ושוב', 'זה', 'את', 'אותו', 'אותה', 'לשיר', 'בשנות', 'בשנת', 'לכבוד', 'ואני', 'והלחנתי', 'הלחנתי', 'שהלחנתי', 'אז', 'ככה', 'לי', 'לו', 'לנו', 'בשבילנו', 'עבור', 'במקור', 'בעצם', 'הבא', 'שלו', 'שלה', 'שלי', 'כבר', 'עם']);

const QUOTED = /["“”„״]([^"“”„״]{2,60})["“”„״]/gu;

// Up to `max` words of `text`, stopping at sentence punctuation or a stop word.
function phrase(text, max, stop, { leadStop = false } = {}) {
    const cut = String(text).split(/[.?!:;,()\n]|\s[-–—]\s/u)[0];
    const out = [];
    for (const w of cut.trim().split(/\s+/)) {
        const n = normHe(w);
        if (!n) continue;
        if (stop.has(n) && (out.length || leadStop)) break;
        out.push(w.replace(/["“”„״'׳]/g, ''));
        if (out.length >= max) break;
    }
    return out.join(' ').trim();
}

function lineTalk(line) {
    const raw = line.text || '';
    const w = tokens(raw);
    if (!w.length) return { talk: 0, w: 0 };
    let t = 0;
    for (const x of w) {
        const bare = x.length > 3 ? x.replace(/^[ושהבל]/, '') : x;
        if (STRONG.has(x) || STRONG.has(bare)) t += 2;
        else if (WEAK.has(x) || WEAK.has(bare)) t += 0.6;
    }
    // "ככה זה נשמע", "הוא הולך ככה", count-ins: the song starts right after.
    if (/(ככה\s+זה\s+(נשמע|הולך)|(זה|הוא|היא)\s+הולך\s+ככה|^\s*(וואן|ואן|תו|ת'רי|ורי|פור)[,.\s]|מינור|מז'ור|אקורד)/u.test(raw)) t += 3;
    if (/\d/.test(raw)) t += 2;
    if (/תודה\s+רבה/.test(raw)) t += 2;
    if (/(^|\s)(השיר|ה?שיר\s+ש)/.test(raw)) t += 1;
    // Sentence punctuation inside the line (speech is punctuated; whisper rarely does it in songs).
    const inner = raw.replace(/[.?!,\s]+$/, '');
    t += Math.min(3, (inner.match(/[.?!:]/g) || []).length * 1.2);
    if (/\?/.test(raw)) t += 0.8;
    if (ANNOUNCE.some((re) => re.test(raw)) || WRITER_PATTERNS.some(([re]) => re.test(raw))) t += 3;
    QUOTED.lastIndex = 0;
    if (QUOTED.test(raw)) t += 1;
    if (w.every((x) => SUNG_FILLERS.test(x))) t = 0;
    return { talk: t, w: w.length };
}

// Word 3-gram sets for repetition (a chorus repeats; talk rarely does).
function grams(w) {
    const g = new Set();
    for (let i = 0; i + 2 < w.length; i++) g.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    if (w.length === 2) g.add(w.join(' '));
    return g;
}

function classify(lines) {
    const L = lines.map((l) => {
        const w = tokens(l.text);
        const f = lineTalk(l);
        return { ...l, w, n: w.length, talk: f.talk, g: grams(w), dur: Math.max(0.1, l.e - l.s), flagged: !!(l.flags && l.flags.length) };
    });
    for (let i = 0; i < L.length; i++) {
        const a = L[i];
        if (a.flagged || !a.g.size) { a.rep = 0; continue; }
        let hit = 0;
        const own = new Set();
    // A line repeating itself (the same phrase twice in a row).
        for (let k = 0; k + 2 < a.w.length; k++) { const g = `${a.w[k]} ${a.w[k + 1]} ${a.w[k + 2]}`; if (own.has(g)) hit++; own.add(g); }
        for (const g of a.g) {
            for (let j = Math.max(0, i - 40); j < Math.min(L.length, i + 40); j++) {
                if (j === i || Math.abs(L[j].s - a.s) > 300) continue;
                if (L[j].g.has(g)) { hit++; break; }
            }
        }
        a.rep = Math.min(1, hit / a.g.size);
    }
    for (const a of L) {
        let sung = 0;
        if (a.rep >= 0.25) sung += 2.5 * Math.min(1, a.rep * 1.5);
        const punct = (a.text.match(/[.?!,:]/g) || []).length;
        if (a.n >= 14 && punct <= 1) sung += 1.5;
        const rate = a.n / a.dur;
        if (a.dur >= 5 && rate < 1.2) sung += a.dur >= 10 ? 1 : 0.6;
        // Speech is fast and comma-rich; singing in whisper's segments is rarely over 1.8 words/s.
        let speech = 0;
        if (a.n >= 3 && a.dur <= 12 && rate >= 1.8 && (punct || a.n >= 8)) speech += rate >= 2.3 ? 1.6 : 1;
        if (a.n >= 4 && punct / a.n >= 0.2 && a.rep < 0.25) speech += 0.6;
        a.score = a.talk + speech - sung;
        a.kind = a.flagged ? 'music' : a.score >= 2 ? 'talk' : a.score <= 0.6 ? 'sung' : '?';
    }
    // Uncertain lines follow their neighbours (talk wins only when both sides are talk).
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < L.length; i++) {
            if (L[i].kind !== '?') continue;
            const prev = L.slice(Math.max(0, i - 2), i).map((x) => x.kind), next = L.slice(i + 1, i + 3).map((x) => x.kind);
            const talkN = [...prev, ...next].filter((k) => k === 'talk').length, sungN = [...prev, ...next].filter((k) => k === 'sung' || k === 'music').length;
            // A tie goes to talk when the line before is talk and this one ends a sentence.
            const tieTalk = talkN === sungN && prev.at(-1) === 'talk' && /[.?!]\s*$/.test(L[i].text);
            if (talkN > sungN || tieTalk || (L[i].n <= 3 && talkN)) L[i].kind = 'talk';
            else if (sungN) L[i].kind = 'sung';
        }
    }
    for (const a of L) if (a.kind === '?') a.kind = a.score >= 1.4 ? 'talk' : 'sung';
    // A single talk-like line between sung lines (a lyric with "שלום" or "מילים" in it) is
    // sung, unless it announces something or thanks the audience.
    for (let i = 1; i + 1 < L.length; i++) {
        const a = L[i];
        if (a.kind !== 'talk' || L[i - 1].kind !== 'sung' || L[i + 1].kind !== 'sung') continue;
        if (a.s - L[i - 1].e > 15 || L[i + 1].s - a.e > 15) continue;
        const marked = ANNOUNCE.some((re) => re.test(a.text)) || WRITER_PATTERNS.some(([re]) => re.test(a.text)) || /תודה|מחיאות|\d/.test(a.text);
        if (!marked && a.score < 5) a.kind = 'sung';
    }
    // A short unmarked line right after "...השיר נקרא" is the title, i.e. talk.
    for (let i = 0; i + 1 < L.length; i++) {
        if (ANNOUNCE[0].test(L[i].text) && L[i + 1].n <= 6 && L[i + 1].s - L[i].e < 15) L[i + 1].kind = 'talk', L[i + 1].titleLine = true;
    }
    return L;
}

// Title and writers mentioned in a block of talk lines (nearest the song first).
function announcements(talkLines, { after = false } = {}) {
    const titles = [], writers = [];
    const add = (arr, v, w) => { v = v.trim(); if (!v || normHe(v).length < 2) return; const k = normTitle(v); const e = arr.find((x) => x.k === k); if (e) e.w += w; else arr.push({ v, k, w }); };
    const order = after ? talkLines : talkLines.slice().reverse();
    order.forEach((l, idx) => {
        const near = Math.max(0.3, 1 - idx * 0.12);
        const raw = l.text;
        if (l.titleLine && !after) add(titles, phrase(raw, 7, TITLE_STOP), 6 * near);
        QUOTED.lastIndex = 0;
        let m;
        const quoted = [];
        while ((m = QUOTED.exec(raw))) quoted.push(m[1]);
        for (const [i, re] of ANNOUNCE.entries()) {
            if (i === 0) continue;
            if (after && i !== 2) continue;
            if (!after && i === 2) continue;
            const x = re.exec(raw);
            if (!x) continue;
            const rest = x[1];
            const q = /^\s*["“”„״]([^"“”„״]{2,60})["“”„״]/u.exec(rest);
            add(titles, q ? q[1] : phrase(rest, 6, TITLE_STOP), (i === 3 ? 3 : 5) * near);
        }
        if (!after) for (const q of quoted) add(titles, q, 2.5 * near);
        if (!after) {
            for (const [re, role] of WRITER_PATTERNS) {
                const x = re.exec(raw);
                if (!x) continue;
                const name = phrase(x[1], 2, NAME_STOP, { leadStop: true });
                if (name && tokens(name).length >= 1 && !/^(אותו|אותה|את|לי|לו)$/.test(name)) writers.push({ name, role });
            }
            // "X, סליחה" corrects the name just said.
            const fix = /^\s*([א-ת]+\s+[א-ת]+)\s*,\s*סליחה/u.exec(raw);
            if (fix) writers.push({ name: fix[1], role: writers.at(-1)?.role || 'lyricist' });
        }
    });
    titles.sort((a, b) => b.w - a.w);
    return { titles: titles.map((t) => t.v), titleWeight: titles[0]?.w || 0, writers };
}

const r1 = (x) => Math.round(x * 10) / 10;
function newId() { return 's' + crypto.randomBytes(5).toString('hex'); }

// transcript -> auto-detected songs (no ids or user fields yet beyond defaults).
function detect(transcript, opts = {}) {
    const lines = (transcript && Array.isArray(transcript.lines) ? transcript.lines : []).filter((l) => Number.isFinite(l.s) && Number.isFinite(l.e));
    if (!lines.length || transcript.no_speech) return [];
    const L = classify(lines);
    // Runs of sung/music lines; talk lines or long gaps end a run.
    const runs = [];
    let cur = null;
    const close = () => { if (cur) runs.push(cur); cur = null; };
    for (let i = 0; i < L.length; i++) {
        const a = L[i];
        if (a.kind === 'talk') {
            // One short talk-like line inside a song does not end it when sung lines follow at once.
            const prevSung = cur && cur.lines.length >= 3;
            const nextSung = L[i + 1] && L[i + 1].kind !== 'talk' && L[i + 2] && L[i + 2].kind !== 'talk' && L[i + 1].s - a.e < 10;
            if (prevSung && nextSung && a.n <= 4 && a.talk < 4) { cur.lines.push({ ...a, kind: 'sung' }); continue; }
            close();
            continue;
        }
        if (cur && a.s - cur.lines.at(-1).e > MAX_GAP_S) close();
        if (!cur) cur = { lines: [] };
        cur.lines.push(a);
    }
    close();
    const songs = [];
    for (let r = 0; r < runs.length; r++) {
        const sung = runs[r].lines.filter((x) => x.kind === 'sung');
        if (!sung.length) continue;
        // A run starts and ends with real sung lines (invented lines over music do not extend it).
        const first = runs[r].lines.findIndex((x) => x.kind === 'sung');
        let last = runs[r].lines.length - 1;
        while (last > first && runs[r].lines[last].kind !== 'sung') last--;
        const body = runs[r].lines.slice(first, last + 1);
        const s = body[0].s, e = body.at(-1).e;
        const words = sung.reduce((t, x) => t + x.n, 0);
        if (e - s < MIN_SONG_S || words < 20) continue;
        // Songs repeat (a chorus, a refrain); a stretch of unmarked talk does not.
        const repFrac = sung.filter((x) => x.rep >= 0.25).length / sung.length;
        songs.push({ s, e, body, sung, repFrac });
    }
    // Talk before each song (after the previous song, at most 4 minutes) and after it.
    // Every line outside a song counts here (a quoted title can look like a sung line).
    const talkBetween = (from, to) => L.filter((x) => !x.flagged && x.s >= from - 0.01 && x.s < to && x.s >= to - 240);
    const out = [];
    for (let k = 0; k < songs.length; k++) {
        const sg = songs[k];
        const before = talkBetween(k ? songs[k - 1].e : 0, sg.s);
        const afterLines = L.filter((x) => !x.flagged && x.s >= sg.e && x.s < (songs[k + 1] ? songs[k + 1].s : Infinity) && x.s < sg.e + 240);
        let a = announcements(before);
        if (!a.titles.length) {
            const b = announcements(afterLines, { after: true });
            if (b.titles.length) a = { ...a, titles: b.titles, titleWeight: b.titleWeight };
        }
        // Most repeated sung line (the chorus); ties: the longer line.
        let chorus = null;
        for (const x of sg.sung) {
            if (x.n < 3) continue;
            const key = x.rep + Math.min(x.n, 20) / 200;
            if (!chorus || key > chorus.key) chorus = { key, text: x.text };
        }
        // Songs repeat; unmarked talk misread as sung does not. Announced songs need less.
        if (sg.repFrac < (a.titles.length ? 0.05 : 0.12)) continue;
        const firstLine = sg.sung.find((x) => x.n >= 3) || sg.sung[0];
        const sungFrac = sg.sung.length / sg.body.length;
        const confidence = Math.max(0.1, Math.min(0.99, 0.2 + 0.3 * sungFrac + Math.min(0.2, sg.repFrac * 0.4) + (before.length ? 0.1 : 0) + (a.titles.length ? 0.2 : 0)));
        out.push({
            s: r1(sg.s), e: r1(sg.e),
            title_heard: a.titles[0] || '', titles_heard: a.titles.slice(0, 4),
            writers_heard: [...new Set(a.writers.map((w) => w.name))].slice(0, 6),
            writers_roles: a.writers.slice(0, 8),
            talk_before: before.map((x) => x.text).join(' ').slice(-1500),
            first_line: String(firstLine.text).slice(0, 200), chorus_line: String(chorus ? chorus.text : firstLine.text).slice(0, 200),
            confidence: Math.round(confidence * 100) / 100,
        });
    }
    if (opts.debug) return { songs: out, lines: L };
    return out;
}

// ---- merging with what is stored -------------------------------------------------------
const overlap = (a, b) => Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));
const overlapFrac = (a, b) => overlap(a, b) / Math.max(1, Math.min(a.e - a.s, b.e - b.s));
// Songs a person touched (accepted, edited, hinted, rejected, "not a song") are kept exactly.
const isKept = (x) => x.source === 'person' || (x.status && x.status !== 'suggested') || !!x.hint || !!x.notes;

function emptySong(a) {
    return {
        id: newId(), s: a.s, e: a.e, title_heard: a.title_heard, titles_heard: a.titles_heard || [], writers_heard: a.writers_heard || [],
        writers_roles: a.writers_roles || [], talk_before: a.talk_before || '', first_line: a.first_line, chorus_line: a.chorus_line,
        status: 'suggested', credits: null, candidates: [], source: 'auto', confidence: a.confidence, hint: '', notes: '', confirmed_by: '', confirmed_at: '',
    };
}

// existing songs doc (or null) + newly detected auto songs -> the doc to store.
// Kept songs stay as they are; auto suggestions are updated in place (same id) when they
// overlap a new detection by half; new detections overlapping a kept song are dropped;
// old auto suggestions that are no longer found move to `archived` (never deleted, never trimmed).
function merge(doc, auto, { clipId, now = new Date().toISOString() } = {}) {
    const prev = doc && Array.isArray(doc.songs) ? doc.songs : [];
    const archived = doc && Array.isArray(doc.archived) ? doc.archived.slice() : [];
    const kept = prev.filter(isKept);
    const oldAuto = prev.filter((x) => !isKept(x));
    const used = new Set();
    const songs = kept.map((x) => ({ ...x }));
    for (const a of auto) {
        if (kept.some((k) => overlapFrac(k, a) >= 0.5)) continue;
        const match = oldAuto.find((o) => !used.has(o.id) && overlapFrac(o, a) >= 0.5);
        if (match) {
            used.add(match.id);
            const sameTitle = normTitle(match.title_heard) === normTitle(a.title_heard);
            songs.push({
                ...match, s: a.s, e: a.e, title_heard: a.title_heard, titles_heard: a.titles_heard || [], writers_heard: a.writers_heard || [],
                writers_roles: a.writers_roles || [], talk_before: a.talk_before || '', first_line: a.first_line, chorus_line: a.chorus_line, confidence: a.confidence,
                // A different title heard: the earlier lookup no longer applies.
                ...(sameTitle ? {} : { credits: null, candidates: [], looked_up: null }),
            });
        } else songs.push(emptySong(a));
    }
    for (const o of oldAuto) if (!used.has(o.id)) archived.push({ ...o, archived_at: now, archived_why: 'not found again by song detection' });
    songs.sort((x, y) => x.s - y.s);
    return { version: 1, clipId: clipId || doc?.clipId || '', updated: now, detector: DETECTOR, songs, archived };
}

module.exports = { DETECTOR, normHe, normTitle, tokens, classify, detect, merge, emptySong, isKept, overlap, overlapFrac, newId, announcements };

if (require.main === module) {
    const fs = require('fs');
    const file = process.argv[2];
    if (!file) { console.error('usage: node detect-songs.js <transcript.json> [--json] [--debug]'); process.exit(2); }
    const tr = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hms = (s) => new Date(s * 1000).toISOString().slice(11, 19);
    if (process.argv.includes('--debug')) {
        const r = detect(tr, { debug: true });
        for (const l of r.lines) console.log(hms(l.s), l.kind.padEnd(5), String(Math.round(l.score * 10) / 10).padStart(5), (l.rep || 0).toFixed(2), l.text.slice(0, 100));
        return;
    }
    const songs = detect(tr);
    if (process.argv.includes('--json')) console.log(JSON.stringify(songs, null, 1));
    else for (const x of songs) console.log(`${hms(x.s)}-${hms(x.e)}  ${x.title_heard || '(no title heard)'}  [${x.writers_heard.join(', ')}]  ${x.confidence}`);
}
