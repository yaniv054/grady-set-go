// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Thumbnail: one 320-px-wide JPEG per clip in C:\Playout\data\thumbs\<clip id>.jpg,
// named by clip ID so it survives renames and moves. Reads 4 seconds of video at 10%
// of the clip (then 30/50/70% if that picture is nearly black) and keeps the most
// representative frame (ffmpeg "thumbnail" filter). Nothing is written to the share.
// Also used by the panel to make a thumbnail on demand (clip editor).
'use strict';
const fs = require('fs');
const path = require('path');

const DARK_YAVG = 28;  // average luma (8-bit, limited range: black = 16)

module.exports = {
    id: 'thumb',
    version: 1,
    label: 'Thumbnail',
    async run(ctx) {
        const row = ctx.row;
        if (!row.video_codec) return { skipped: 'no video' };
        const dir = path.join(ctx.dataDir, 'thumbs');
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, `${ctx.id}.jpg`);
        if (!ctx.force && fs.existsSync(out)) return { file: path.basename(out), existing: true };
        const d = Number(row.duration_s) || 0;
        const len = Math.max(0.5, Math.min(4, d || 4));
        const points = d > 8 ? [0.1, 0.3, 0.5, 0.7] : [0];
        let best = null;
        for (let i = 0; i < points.length; i++) {
            const at = d > 8 ? Math.max(0, Math.min(d - len, d * points[i])) : 0;
            const tmp = path.join(dir, `${ctx.id}.${process.pid}.${i}.tmp.jpg`);
            const r = await ctx.run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'info', '-threads', '2',
                '-ss', at.toFixed(2), '-t', String(len), '-i', ctx.file, '-map', '0:v:0', '-an', '-sn', '-dn',
                '-vf', 'yadif=deint=interlaced,thumbnail=50,scale=w=320:h=trunc(320/dar/2)*2,setsar=1,format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
                '-frames:v', '1', '-q:v', '4', '-update', '1', '-y', tmp], { timeout: 3 * 60e3 });
            if (r.code !== 0 || !fs.existsSync(tmp)) {
                try { fs.unlinkSync(tmp); } catch { /* none */ }
                if (i === points.length - 1 && !best) throw new Error(r.stderr.trim().split(/\r?\n/).pop() || `ffmpeg exit ${r.code}`);
                continue;
            }
            const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stderr);
            const yavg = m ? Number(m[1]) : null;
            if (!best || (yavg ?? 0) > (best.yavg ?? 0)) {
                if (best) try { fs.unlinkSync(best.tmp); } catch { /* gone */ }
                best = { tmp, at, yavg };
            } else {
                try { fs.unlinkSync(tmp); } catch { /* gone */ }
            }
            if (yavg === null || yavg >= DARK_YAVG) break;
        }
        try { fs.unlinkSync(out); } catch { /* none */ }
        fs.renameSync(best.tmp, out);
        return { file: path.basename(out), at_s: Math.round(best.at * 10) / 10, yavg: best.yavg === null ? null : Math.round(best.yavg), dark: best.yavg !== null && best.yavg < DARK_YAVG };
    },
};
