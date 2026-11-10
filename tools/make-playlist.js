// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Writes a ffplayout playlist JSON for a date using the panel's read-only share
// generator (panel must be running on 127.0.0.1:8790).
//   node make-playlist.js 2026-10-06 [--ext mp4,mov] [--keep-flagged] [--ordered] folder1 folder2 ...
// Output: C:\Playout\playlists\YYYY\MM\YYYY-MM-DD.json (refuses to overwrite unless --force).
'use strict';
const cfg = require('../panel/config');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const date = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const extIdx = argv.indexOf('--ext');
const extensions = extIdx >= 0 ? String(argv[extIdx + 1] || '').split(',').filter(Boolean) : [];
const folders = argv.filter((a, i) => a !== date && !a.startsWith('--') && i !== extIdx + 1);
const force = argv.includes('--force');
const channel = process.env.CHANNEL_NAME || 'Channel 1';
if (!date || !folders.length) { console.error('usage: node make-playlist.js YYYY-MM-DD [--force] [--keep-flagged] [--ordered] folder...'); process.exit(2); }

const [y, m] = date.split('-');
const out = path.join(cfg.playlistsDir, y, m, `${date}.json`);
if (fs.existsSync(out) && !force) { console.error(`exists, not overwriting: ${out} (use --force)`); process.exit(3); }

(async () => {
    const r = await fetch('http://127.0.0.1:8790/local/media/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders, extensions, shuffle: !argv.includes('--ordered'), skip_flagged: !argv.includes('--keep-flagged'), length_s: 86400 }),
    });
    const g = await r.json();
    if (!r.ok || !g.program?.length) { console.error('generate failed', g); process.exit(1); }
    const missing = g.program.filter((it) => !fs.existsSync(it.source)).length;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ channel, date, program: g.program }, null, 4));
    const total = g.program.reduce((s, it) => s + (it.out - it.in), 0);
    const uniq = new Set(g.program.map((it) => it.source)).size;
    console.log(`${out}\n  formats ${g.formats.join(',')}; items ${g.program.length} (${uniq} unique files), total ${(total / 3600).toFixed(3)} h, usable pool ${g.usable}, skipped: format ${g.skipped_format}, flagged ${g.skipped_flagged}, no duration ${g.skipped_no_duration}; missing on disk ${missing}`);
})();
