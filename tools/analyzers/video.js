// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Video check on samples (does not decode the whole file): interlace combing baked into
// "progressive" files (idet on three 10-second samples), black at the start and end,
// and static picture (freezedetect).
'use strict';

const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

async function decode(ctx, start, len, filters) {
    const r = await ctx.run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'info', '-threads', '2',
        '-ss', start.toFixed(2), '-t', String(len), '-i', ctx.file, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filters, '-f', 'null', '-'], { timeout: 10 * 60e3 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/).pop() || `ffmpeg exit ${r.code}`);
    return r.stderr;
}
const blacks = (text) => [...text.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

module.exports = {
    id: 'video',
    version: 1,
    label: 'Video',
    async run(ctx) {
        const row = ctx.row;
        if (!row.video_codec) return { flags: ['no_video'] };
        const d = Number(row.duration_s) || 0;
        const len = d > 40 ? 10 : Math.max(1, Math.min(30, d));
        const starts = d > 40 ? [0.1, 0.5, 0.85].map((f) => Math.max(0, Math.min(d - len, d * f))) : [0];
        let tff = 0, bff = 0, prog = 0, frozen = 0;
        for (const s of starts) {
            const t = await decode(ctx, s, len, 'idet,freezedetect=n=-60dB:d=4');
            const m = [...t.matchAll(/Multi frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)/g)].pop();
            if (m) { tff += Number(m[1]); bff += Number(m[2]); prog += Number(m[3]); }
            for (const f of t.matchAll(/freeze_duration:\s*([\d.]+)/g)) frozen += Number(f[1]);
            const open = /freeze_start:\s*([\d.]+)(?![\s\S]*freeze_end)/.exec(t);
            if (open) frozen += Math.max(0, len - Number(open[1]));
        }
        const decided = tff + bff + prog;
        const combed = decided >= 50 ? (tff + bff) / decided : null;

        // Black at the start (first 20 s) and at the end (last 20 s).
        const headLen = Math.min(20, d || 20);
        const head = blacks(await decode(ctx, 0, headLen, 'blackdetect=d=0.5:pix_th=0.10'));
        const headBlack = head.length && head[0][0] <= 0.2 ? head[0][1] : 0;
        let tailBlack = null;
        if (d > 25) {
            const from = d - 20;
            const t = await decode(ctx, from, 20, 'blackdetect=d=0.5:pix_th=0.10');
            const b = blacks(t);
            const lastB = b[b.length - 1];
            if (lastB && lastB[1] >= 19.3) tailBlack = from + lastB[0];
            else {
                const openB = /black_start:\s*(-?[\d.]+)(?![\s\S]*black_end)/.exec(t);
                if (openB) tailBlack = from + Number(openB[1]);
            }
        }

        const flags = [];
        // Real interlaced footage has one consistent field order (TFF or BFF); fast
        // progressive motion fools idet in both directions, so require a dominant order.
        const dominant = tff + bff ? Math.max(tff, bff) / (tff + bff) : 0;
        if (combed !== null && combed >= 0.3 && dominant >= 0.85) flags.push('combed');
        if (headBlack >= 1) flags.push('head_black');
        if (tailBlack !== null && d - tailBlack >= 1) flags.push('tail_black');
        if (frozen >= starts.length * len * 0.8) flags.push('static');
        return {
            combed_ratio: combed === null ? null : Math.round(combed * 100) / 100, idet: { tff, bff, progressive: prog },
            head_black: r1(headBlack), tail_black: tailBlack === null ? null : r1(tailBlack),
            static_s: r1(frozen), sampled_s: starts.length * len,
            flags,
        };
    },
};
