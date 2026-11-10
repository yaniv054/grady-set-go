// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Audio check: integrated loudness (EBU R128), loudness range, true peak, sample peak,
// per-channel levels, mono/one-channel detection, silences. Reads the whole audio track.
// v2: one-channel / dual-mono / phase use only the front pair (channels 1 and 2), so
// 5.1 with quiet surrounds is not flagged; "clipping" needs flat-topped peaks (several
// consecutive samples at the peak level) or, for lossy audio where flat tops are lost
// in decoding, sample peak >= 0 dBFS together with true peak above +0.5 dBTP.
'use strict';

const num = (s) => (s === undefined || s === null || /inf/i.test(s) ? null : Number(s));
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

module.exports = {
    id: 'audio',
    version: 2,
    label: 'Audio',
    async run(ctx) {
        const row = ctx.row;
        if (!row.audio_codec) return { flags: ['no_audio'] };
        const ch = Number(row.audio_channels) || 0;
        const duration = Number(row.duration_s) || 0;
        const main = 'ebur128=peak=true:framelog=verbose,silencedetect=n=-50dB:d=2,astats=metadata=0';
        // Side channel (L-R) level: very low means both channels carry the same signal.
        const fc = ch >= 2
            ? `[0:a:0]asplit=2[m][s];[m]${main}[o1];[s]pan=mono|c0=0.5*c0-0.5*c1,volumedetect[o2]`
            : `[0:a:0]${main}[o1]`;
        const maps = ch >= 2 ? ['-map', '[o1]', '-f', 'null', '-', '-map', '[o2]', '-f', 'null', '-'] : ['-map', '[o1]', '-f', 'null', '-'];
        const r = await ctx.run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'info', '-threads', '2', '-i', ctx.file, '-filter_complex', fc, ...maps]);
        const err = r.stderr;
        if (r.code !== 0) throw new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exit ${r.code}`);

        const sum = err.slice(err.lastIndexOf('Summary:'));
        const lufs = num((/I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(sum) || [])[1]);
        const lra = num((/LRA:\s+(-?[\d.]+)\s+LU/.exec(sum) || [])[1]);
        const truePeak = num((/True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(sum) || [])[1]);

        // astats: per-channel and overall sections.
        const chRms = [], chPeak = [], chPeakCount = [], chFlat = [];
        let section = null, overallRms = null, overallPeak = null;
        for (const line of err.split(/\r?\n/)) {
            if (!/Parsed_astats/.test(line)) continue;
            let m;
            if ((m = /\] Channel: (\d+)/.exec(line))) { section = Number(m[1]) - 1; continue; }
            if (/\] Overall/.test(line)) { section = 'all'; continue; }
            if ((m = /\] RMS level dB: (-?[\d.]+|-inf)/.exec(line))) { if (section === 'all') overallRms = num(m[1]); else if (section !== null) chRms[section] = num(m[1]); }
            if ((m = /\] Peak level dB: (-?[\d.]+|-inf)/.exec(line))) { if (section === 'all') overallPeak = num(m[1]); else if (section !== null) chPeak[section] = num(m[1]); }
            // Per channel: samples at its min/max level, and how flat those peaks are
            // (0 = never two equal peak samples in a row; > 0 = runs of them).
            if (typeof section === 'number' && (m = /\] Peak count: ([\d.]+)/.exec(line))) chPeakCount[section] = num(m[1]);
            if (typeof section === 'number' && (m = /\] Flat factor: (-?[\d.]+|-inf)/.exec(line))) chFlat[section] = num(m[1]);
        }
        const side = ch >= 2 ? num((/mean_volume: (-?[\d.]+|-inf) dB/.exec(err) || [])[1]) : null;

        // Silences of 2 s or more.
        const silences = [];
        let open = null;
        for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
            const t = Number(m[2]);
            if (m[1] === 'start') open = Math.max(0, t);
            else if (open !== null) { silences.push([open, t]); open = null; }
        }
        if (open !== null) silences.push([open, duration || open]);
        const headSilence = silences.length && silences[0][0] <= 0.2 ? silences[0][1] : 0;
        const last = silences[silences.length - 1];
        const tailSilence = last && duration && last[1] >= duration - 0.5 ? last[0] : null;
        const inner = silences.filter((s) => s[0] > 0.2 && !(duration && s[1] >= duration - 0.5));
        const longest = inner.reduce((mx, s) => Math.max(mx, s[1] - s[0]), 0);

        const flags = [];
        if (lufs === null || lufs <= -60) flags.push('silent');
        else {
            if (lufs < -30) flags.push('quiet');
            if (lufs > -9) flags.push('loud');
        }
        // Clipping: flat-topped peaks at full scale (channels peaking at -0.1 dBFS or more,
        // at least 10 samples at their peak level in total, some of them consecutive), or a
        // lossy decode that overshoots full scale clearly. Silent channels are ignored.
        const hot = chPeak.map((p, i) => i).filter((i) => chPeak[i] !== null && chPeak[i] !== undefined && chPeak[i] >= -0.1);
        const peakCount = hot.length ? hot.reduce((s, i) => s + (chPeakCount[i] || 0), 0) : null;
        const flatFactor = hot.length ? Math.max(...hot.map((i) => (chFlat[i] === null || chFlat[i] === undefined ? -Infinity : chFlat[i]))) : null;
        const flatTops = peakCount !== null && peakCount >= 10 && flatFactor !== null && flatFactor > 0;
        const overshoot = overallPeak !== null && overallPeak >= 0 && truePeak !== null && truePeak > 0.5;
        if (flatTops || overshoot) flags.push('clipping');
        // Front left/right only (channels 1 and 2): quiet surrounds in 5.1 are normal.
        const front = [chRms[0], chRms[1]];
        const frontKnown = front.filter((x) => x !== null && x !== undefined);
        // Level of the front pair (power average), the reference for the side (L-R) level.
        const frontRms = frontKnown.length ? 10 * Math.log10(frontKnown.reduce((s, x) => s + 10 ** (x / 10), 0) / 2) : null;
        if (ch >= 2 && chRms.length >= 2 && frontKnown.length >= 1) {
            const lo = Math.min(...front.map((x) => (x === null || x === undefined ? -200 : x))), hi = Math.max(...frontKnown);
            if (lo < -70 && hi > -45) flags.push('one_channel');
            else if (side !== null && frontRms !== null && (side <= -80 || side <= frontRms - 40)) flags.push('dual_mono');
            else if (side !== null && frontRms !== null && side > frontRms + 3) flags.push('phase');
        }
        if (longest >= 10) flags.push('long_silence');
        if (headSilence >= 3) flags.push('head_silence');
        if (tailSilence !== null && duration - tailSilence >= 3) flags.push('tail_silence');

        return {
            lufs: r1(lufs), lra: r1(lra), true_peak: r1(truePeak), peak_db: r1(overallPeak), rms_db: r1(overallRms), peak_count: peakCount, flat_factor: r1(flatFactor),
            channels: ch, ch_rms: chRms.map(r1), side_db: r1(side),
            head_silence: r1(headSilence), tail_silence: tailSilence === null ? null : r1(tailSilence), longest_silence: r1(longest),
            silences: silences.slice(0, 20).map(([a, b]) => [r1(a), r1(b)]),
            flags,
        };
    },
};
