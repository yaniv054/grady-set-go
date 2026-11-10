// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Metadata suggestions from the file and folder names (no media decoding):
// a cleaned-up title (show and artist names kept) and, where the folder structure
// tells it, the performer.
// Suggestions are only shown in the panel; nothing is applied automatically.
'use strict';

// Encoder/export junk. v4: resolutions only as 1080p/1080i/720p/4K/UHD or 1920x1080
// (a bare "720" can be part of a title), and export words only at the end of the name.
const JUNK = [
    /[_ ]*MainConcept.*$/i,
    /\b(internet|youtube|web)\s*hd\b.*$/i,
    /\b(2160|1080|720|576|480)[pi]\b/gi,
    /\b\d{3,4}\s*x\s*\d{3,4}(?:[- ]?\d{2,3}[pi])?\b/gi,      // 1920x1080, 1920x1080-50i
    /\b(4k|uhd)\b/gi,
    /\bv\d+\b/gi,
    /\(\d+\)\s*$/,
];
// "... final", "..._final_v2", "... - copy 2", "... HD": only as the last word(s), after a
// space, "_" or "-" (underscores are already spaces here). "The Final Countdown" and
// "Master Class - ..." keep their words. Applied until nothing more comes off.
const TRAILING = /[\s-]+(final|finished|export(?:ed)?|render(?:ed)?|master|copy|hd)(?:[\s-]*v?\d+)?[\s\-–.,]*$/i;
const IGNORE_FOLDERS = /^(mp4|mov|stream|upload|export|exports|final|render|renders|\d[\d.\s-]*|temp)$/i;

function tidy(s) {
    return String(s || '')
        .replace(/[_]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–.,]+|[\s\-–.,]+$/g, '')
        .trim();
}

// Dates in a file name are kept exactly as written (Grady, 10/10/26): they are set
// aside before the clean-up and put back after it.
const DATE_RES = [
    /(?<!\d)(?:19|20)\d{2}[-._/ ]\d{1,2}[-._/ ]\d{1,2}(?!\d)/g,      // 2023-05-12
    /(?<!\d)\d{1,2}[-._/ ]\d{1,2}[-._/ ](?:\d{4}|\d{2})(?!\d)/g,      // 12.05.2023, 12.05.23
    /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g, // 20230512
    /(?<!\d)(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)?\d{2}(?!\d)/g, // 12052023, 120523
    /\((?:19|20)\d{2}\)/g,                                               // (2023)
    /(?<![\d.x])(?:19|20)\d{2}(?![\d.x])/gi,                            // 2023 (not 1920x1080)
];
function protectDates(s) {
    const kept = [];
    for (const re of DATE_RES) s = s.replace(re, (m) => { kept.push(m); return `\uE000${String.fromCharCode(0xE010 + kept.length - 1)}\uE001`; });
    return { s, restore: (t) => t.replace(/\uE000(.)\uE001/g, (_, c) => kept[c.charCodeAt(0) - 0xE010] ?? '') };
}

function suggest(row) {
    const base = String(row.file || '').replace(/\.[^.]+$/, '');
    const parts = String(row.folder || '').split(/[\\/]/).filter(Boolean);
    let performer = '';
    // Folder rules from config.json "performer_rules" (any depth), deepest first.
    const rules = require('../../panel/config').performerRules;
    for (const p of [...parts].reverse()) {
        for (const r of rules) {
            const m = r.folder && r.folder.exec(p.trim());
            if (m && m[1] && !IGNORE_FOLDERS.test(m[1].trim())) { performer = tidy(m[1]); break; }
        }
        if (performer) break;
    }
    // Title: the file name with encoder/export junk removed. The show name and the
    // artist name stay in the title.
    const dates = protectDates(base);
    let title = dates.s.replace(/_/g, ' ');
    for (const re of JUNK) title = title.replace(re, ' ');
    for (let i = 0, t = ''; i < 5 && t !== title; i++) { t = title; title = title.replace(TRAILING, '').replace(/\(\d+\)\s*$/, ''); }
    title = dates.restore(tidy(title));
    // File rules: the artist is read for the performer field only.
    if (!performer) for (const r of rules) { const m = r.file && r.file.exec(title); if (m && m[1]) { performer = tidy(m[1]); break; } }
    if (!title) title = tidy(base);
    return { title, performer };
}

module.exports = {
    id: 'meta',
    version: 4,
    label: 'Metadata',
    suggest,
    async run(ctx) {
        const s = suggest(ctx.row);
        return { title: s.title, performer: s.performer, flags: [] };
    },
};
