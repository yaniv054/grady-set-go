// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 60-outputs. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- outputs

function outputRow(name) { return S.outputs.find((o) => o.name === name); }
function parseJson(s, d = {}) { try { return typeof s === 'string' ? JSON.parse(s || '{}') : s || d; } catch { return d; } }

function outputFromRow(row) {
    return {
        id: row.id,
        mode: row.name,
        stream_url: row.stream_url || '',
        stream_type: row.stream_type || 'rtmp',
        stream_format: row.stream_format || '',
        hls_playlist_name: row.hls_playlist_name || 'stream',
        hls_segment_duration: row.hls_segment_duration ?? 6,
        hls_list_size: row.hls_list_size ?? 600,
        desktop_fullscreen: !!row.desktop_fullscreen,
        width: row.width,
        height: row.height,
        fps: row.fps,
        video_codec: row.video_codec || 'libx264',
        video_options: parseJson(row.video_options),
        protocol_options: parseJson(row.protocol_options),
        muxer_options: parseJson(row.muxer_options),
        metadata_options: parseJson(row.metadata_options),
        audio_codec: row.audio_codec || 'aac',
        audio_options: parseJson(row.audio_options),
        audio_bitrate: row.audio_bitrate ?? 128,
        hls_variants: (row.hls_variants || '').split(';').filter(Boolean),
    };
}

const PRESETS = [
    { label: '1080p 25 fps', width: 1920, height: 1080, fps: 25 },
    { label: '1080p 30 fps', width: 1920, height: 1080, fps: 30 },
    { label: '720p 25 fps', width: 1280, height: 720, fps: 25 },
    { label: '720p 30 fps', width: 1280, height: 720, fps: 30 },
];

function codecSettingsFields(target, codecName, values, prefix) {
    const codec = (S.codecs?.[target]?.video || []).find((c) => c.name === codecName);
    if (!codec) return h('p', { class: 'hint' }, T('No settings for this codec.'));
    const wrap = h('div', { class: 'grid2' });
    const refresh = () => {
        for (const s of codec.settings) {
            const el = wrap.querySelector(`[data-opt="${s.key}"]`);
            if (!s.visible_when) continue;
            const ctl = wrap.querySelector(`[name="${prefix}${s.visible_when.key}"]`);
            el.hidden = ctl && ctl.value !== s.visible_when.value;
        }
    };
    for (const s of codec.settings) {
        const v = values[s.key] ?? s.default;
        const ctl = s.kind === 'select'
            ? h('select', { name: prefix + s.key, onchange: refresh }, ...s.choices.map((c) => h('option', { value: c.value, selected: c.value === v }, c.label)))
            : h('input', { name: prefix + s.key, type: 'number', value: v, min: s.minimum ?? undefined, max: s.maximum ?? undefined, step: 'any' });
        wrap.append(h('label', { 'data-opt': s.key }, s.label, ctl));
    }
    refresh();
    return wrap;
}

function collectCodecOptions(card, prefix) {
    const out = {};
    for (const el of $$(`[data-opt] [name^="${prefix}"]`, card)) {
        if (el.closest('[data-opt]')?.hidden) continue;
        out[el.name.slice(prefix.length)] = String(el.value);
    }
    return out;
}

function renderOutputs() {
    const wrap = $('#outputs-cards');
    wrap.replaceChildren(previewCard(), ytCard('yt-test'), ytCard('yt-prod'));
    renderOutHealth();
}

function previewCard() {
    const row = outputRow('hls');
    const active = activeProfile() === 'preview';
    const o = row ? outputFromRow(row) : {};
    const card = h('div', { class: 'card out-card' },
        h('div', { class: 'out-head' }, h('h2', {}, T('HLS preview')), h('span', { class: 'badge' + (active ? ' on' : '') }, active ? T('Active') : T('Standby'))),
        h('p', { class: 'muted small' }, T('Local only. Plays in the dashboard player. Use it to check the schedule without going public.')),
        resolutionFields(o, 'pv'),
        h('details', { class: 'adv' }, h('summary', {}, T('Encoder settings')), codecSettingsFields('hls', o.video_codec || 'libx264', o.video_options || {}, 'pv_')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary wide', onclick: () => applyProfile('preview', card) }, active ? T('Apply changes') : T('Switch to preview')),
    );
    return card;
}

function resolutionFields(o, prefix) {
    const cur = PRESETS.findIndex((p) => p.width === o.width && p.height === o.height && Number(p.fps) === Number(o.fps));
    const sel = h('select', { name: `${prefix}-res` },
        ...PRESETS.map((p, i) => h('option', { value: i, selected: i === cur }, p.label)),
        cur < 0 ? h('option', { value: 'keep', selected: true }, T('{v}×{v2} {v3} fps (current)', { v: o.width || '?', v2: o.height || '?', v3: o.fps || '?' })) : null);
    return h('div', { class: 'grid2' },
        h('label', {}, T('Resolution'), sel),
        h('label', {}, T('Audio bitrate (kbit/s)'), h('input', { name: `${prefix}-abr`, type: 'number', min: 64, max: 512, step: 32, value: o.audio_bitrate || 128 })));
}

function ytCard(id) {
    const prod = id === 'yt-prod';
    const prof = S.local.profiles[id] || {};
    const row = outputRow('stream');
    const live = activeProfile() === id;
    const keyStored = live && row && hasYoutubeKey(row.stream_url);
    const locked = prod && !S.unlockedProd;
    const base = row ? outputFromRow(row) : {};
    const o = { ...base, width: prof.width ?? 1920, height: prof.height ?? 1080, fps: prof.fps ?? 25, audio_bitrate: prof.audio_bitrate ?? 160 };
    const vopts = prof.video_options || { preset: 'veryfast', rate_control: 'cbr', maxrate: '6000' };
    const p = prod ? 'pd' : 'yt';

    // new-password: browsers do not autofill a saved login password into it.
    const keyInput = h('input', { name: `${p}-key`, type: 'password', autocomplete: 'new-password', 'data-lpignore': 'true', 'data-1p-ignore': 'true', spellcheck: 'false', oninput: (e) => e.target.classList.remove('need'), placeholder: keyStored ? T('Leave empty to keep the stored key') : T('Paste the stream key from YouTube Studio') });
    const eye = h('button', { type: 'button', class: 'btn ghost small', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, T('show'));

    const body = h('div', { class: locked ? 'locked-body' : '' },
        h('label', {}, T('RTMP server'), h('input', { name: `${p}-server`, value: prof.server || 'rtmp://a.rtmp.youtube.com/live2' })),
        h('label', { class: 'key-field' }, T('Stream key'), keyInput, eye),
        h('div', { class: 'key-state' + (keyStored ? ' ok' : '') }, keyStored ? T('✓ Key stored in ffplayout · {maskUrl}', { maskUrl: maskUrl(row.stream_url) }) : live ? T('No YouTube key stored.') : T('Not active. The key is needed each time you switch here.')),
        live ? h('div', { class: 'out-health', hidden: true }) : null,
        resolutionFields(o, p),
        h('details', { class: 'adv' }, h('summary', {}, T('Encoder settings')), codecSettingsFields('rtmp', 'libx264', vopts, `${p}_`),
            h('p', { class: 'hint' }, T('YouTube: use CBR. 1080p is typically 4.5–9 Mbit/s, 720p 2.5–6 Mbit/s. Check Stream Health in YouTube Studio during the test.'))),
    );

    const card = h('div', { class: 'card out-card' + (prod ? ' prod' : '') },
        h('div', { class: 'out-head' }, h('h2', {}, prod ? T('YouTube PRODUCTION') : T('YouTube TEST')),
            h('span', { class: 'badge' + (live ? ' on' + (prod ? ' prod' : '') : locked ? ' lock' : '') }, live ? T('Active') : locked ? T('Locked') : T('Standby'))),
        h('p', { class: 'muted small' }, prod ? T('The real channel. Locked until you unlock it here; going live needs typed confirmation.') : T('Your personal channel for the safe run. Set the YouTube event to Unlisted or Private.')),
        locked
            ? h('button', { class: 'btn small', onclick: async () => {
                if (await confirmModal(T('Unlock production output?'), T('This only unlocks the form. Nothing is sent until you press Apply and confirm.'), { ok: T('Unlock') })) { S.unlockedProd = true; renderOutputs(); }
            } }, T('Unlock'))
            : null,
        body,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn wide ' + (prod ? 'air' : 'primary'), disabled: locked, onclick: () => applyProfile(id, card) }, live ? T('Apply changes') : prod ? T('Switch to PRODUCTION…') : T('Switch to YouTube TEST')),
    );
    return card;
}

function readResolution(card, prefix, fallback) {
    const v = $(`[name="${prefix}-res"]`, card).value;
    const preset = v === 'keep' ? fallback : PRESETS[Number(v)];
    return { width: preset.width, height: preset.height, fps: Number(preset.fps), audio_bitrate: Number($(`[name="${prefix}-abr"]`, card).value) || 128 };
}

async function applyProfile(id, card) {
    const running = S.process === 'active';
    let typedKey = '';
    try {
        // Always start from fresh server data.
        [S.config, S.outputs] = await Promise.all([api('GET', `/api/playout/config/${S.channelId}`), api('GET', `/api/playout/outputs/${S.channelId}`)]);
        const cfg = structuredClone(S.config);
        let out;

        if (id === 'preview') {
            const row = outputRow('hls');
            if (!row) throw new Error(T('This channel has no HLS output.'));
            out = outputFromRow(row);
            Object.assign(out, readResolution(card, 'pv', out));
            out.video_options = collectCodecOptions(card, 'pv_');
        } else {
            const p = id === 'yt-prod' ? 'pd' : 'yt';
            const row = outputRow('stream');
            if (!row) throw new Error(T('This channel has no stream output.'));
            out = outputFromRow(row);
            const server = $(`[name="${p}-server"]`, card).value.trim().replace(/\/+$/, '');
            const keyEl = $(`[name="${p}-key"]`, card);
            const key = keyEl.value.trim();
            typedKey = key;
            if (!/^rtmps?:\/\/[^/]+\/[^/]+$/i.test(server)) throw new Error(T('RTMP server must look like rtmp://a.rtmp.youtube.com/live2'));
            if (/[\s/]/.test(key)) throw new Error(T('The stream key must not contain spaces or slashes.'));
            if (key) out.stream_url = `${server}/${key}`;
            else if (S.local.activeProfile === id && hasYoutubeKey(row.stream_url) && row.stream_url.startsWith(server + '/')) { /* keep stored key */ }
            else {
                const other = id === 'yt-prod' ? 'yt' : 'pd';
                const stray = $(`[name="${other}-key"]`)?.value.trim();
                keyEl.classList.add('need');
                keyEl.focus();
                throw new Error(stray
                    ? T('The Stream key field in this card ({v}) is empty. A key is typed in the {v2} card instead; paste the key into this card.', { v: PROFILE_NAMES[id], v2: PROFILE_NAMES[id === 'yt-prod' ? 'yt-test' : 'yt-prod'] })
                    : T('Paste the stream key into the Stream key field of this card ({v}).', { v: PROFILE_NAMES[id] }));
            }
            out.stream_type = 'rtmp';
            out.mode = 'stream';
            const res = readResolution(card, p, { width: out.width, height: out.height, fps: out.fps });
            Object.assign(out, res);
            out.video_codec = 'libx264';
            out.video_options = collectCodecOptions(card, `${p}_`);
            if (id === 'yt-prod' && !(await confirmModal(T('Switch to PRODUCTION?'), [
                T('The program will go to the PRODUCTION YouTube channel') + (running ? ' as soon as the playout restarts.' : ' when you start the playout.'),
                h('p', { class: 'muted small' }, T('Did the safe run on the TEST channel look right (picture, sound, loudness, schedule)?')),
            ], { ok: T('Switch to production'), danger: true, requireText: 'PRODUCTION' }))) { keyEl.value = ''; return; }
            keyEl.value = '';
            S.local.profiles[id] = {
                ...S.local.profiles[id], server, width: res.width, height: res.height, fps: res.fps,
                audio_bitrate: res.audio_bitrate, video_codec: 'libx264', video_options: out.video_options,
            };
            // Verbose FFmpeg logging may print the RTMP path; keep it at ERROR while streaming.
            if (!['ERROR', 'FATAL', 'PANIC', 'QUIET'].includes(String(cfg.logging.ffmpeg_level).toUpperCase())) cfg.logging.ffmpeg_level = 'ERROR';
        }

        cfg.output = out;
        if (cfg.recording?.enable && cfg.recording.source !== 'encode') cfg.recording.source_output_id = out.id;
        const r = await api('PUT', `/api/playout/config/${S.channelId}`, cfg);
        // Leaving the preview: remove its leftover HLS files so they can't be mistaken for what's on air.
        if (id !== 'preview') localJson('POST', '/local/preview/clean', {}).catch(() => {});
        S.local.activeProfile = id;
        await localState.save();
        await loadChannel();
        renderOutputs();
        if (r?.requires_restart && running) {
            if (await confirmModal(T('Restart playout now?'), T(`The change takes effect after a restart. Viewers will see a short interruption.`), { ok: T('Restart now'), danger: id === 'yt-prod' })) {
                await api('POST', `/api/control/${S.channelId}/process`, { command: 'restart' });
                toast(T('Restarted on {v}', { v: PROFILE_NAMES[id] }), 'ok');
                setTimeout(poll, 2500);
                return;
            }
        }
        toast(T('{v} saved{v2}', { v: PROFILE_NAMES[id], v2: running ? '' : '. Start the playout from the dashboard.' }), 'ok');
    } catch (e) {
        const keyEl = card.querySelector('input[name$="-key"]');
        if (keyEl && typedKey) keyEl.value = '';
        toast(typedKey ? e.message.split(typedKey).join('••••••••') : e.message, 'err');
    }
}

