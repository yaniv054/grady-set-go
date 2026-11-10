// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part B0-channel. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- logo + automation

S.logoUploaded = null;
function renderLogoPreview() {
    const logo = S.logoUploaded || S.config?.processing?.logo;
    const box = $('#logo-preview');
    if (!logo) { box.textContent = T('No logo uploaded'); return; }
    const img = h('img', { alt: T('Channel logo'), src: `/local/logo/preview?ts=${Date.now()}` });
    img.onerror = () => { box.textContent = logo; };
    box.replaceChildren(img);
}
$('#logo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const r = await netFetch('/local/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.detail || T('HTTP {status}', { status: r.status }));
        S.logoUploaded = j.logo;
        renderLogoPreview();
        toast(T('Logo uploaded. Tick “Show logo” and press Save channel to put it on air.'), 'ok');
    } catch (err) { toast(err.message, 'err'); }
});

async function loadAutomation() {
    let a;
    try { a = await localJson('GET', '/local/automation'); } catch { return; }
    const f = $('#auto-form');
    const lt = a.lower_third;
    f.enabled.checked = !!lt.enabled;
    for (const k of ['now_label', 'next_label', 'show_s', 'next_before_s', 'font_family', 'font_size', 'position_x', 'position_y', 'background_opacity']) f[k].value = lt[k];
    if (a.account) $('#auto-account').username.value = a.account.username;
    $('#auto-account-msg').textContent = a.account ? T('Saved account: {username}', { username: a.account.username }) : T('No account saved yet.');
    $('#auto-status').textContent = T('Status: {status}{v}{v2}', { status: a.status, v: a.error ? ` (${a.error})` : '', v2: a.last_text ? T(' · last overlay “{last_text}” at {v}', { last_text: a.last_text, v: new Date(a.last_at).toTimeString().slice(0, 8) }) : '' });
    if (!$('#font-list').children.length) {
        try { const fonts = await api('GET', '/api/text/fonts'); $('#font-list').replaceChildren(...(Array.isArray(fonts) ? fonts : []).map((x) => h('option', { value: typeof x === 'string' ? x : x.family || x.name }))); } catch { /* optional */ }
    }
}
$('#auto-account-save').addEventListener('click', async () => {
    const f = $('#auto-account');
    const msg = $('#auto-account-msg');
    if (!f.username.value.trim() || !f.password.value) { msg.textContent = T('Enter username and password.'); msg.className = 'form-msg err'; return; }
    msg.textContent = T('Testing…'); msg.className = 'form-msg';
    try {
        await localJson('PUT', '/local/automation/account', { username: f.username.value.trim(), password: f.password.value });
        f.password.value = '';
        msg.textContent = T('Signed in and saved.'); msg.className = 'form-msg ok';
    } catch (e) { msg.textContent = e.message; msg.className = 'form-msg err'; }
});
$('#auto-save').addEventListener('click', async () => {
    const f = $('#auto-form');
    const msg = $('#auto-msg');
    const lower_third = { enabled: f.enabled.checked };
    for (const k of ['now_label', 'next_label', 'font_family', 'position_x', 'position_y']) lower_third[k] = f[k].value;
    for (const k of ['show_s', 'next_before_s', 'font_size', 'background_opacity']) lower_third[k] = Number(f[k].value);
    try {
        await localJson('PUT', '/local/automation', { lower_third });
        msg.textContent = T('Saved.'); msg.className = 'form-msg ok';
        setTimeout(loadAutomation, 2500);
    } catch (e) { msg.textContent = e.message; msg.className = 'form-msg err'; }
});

// ---------------------------------------------------------------- channel

function renderChannel() {
    const f = $('#channel-form');
    const c = S.config;
    f.name.value = S.channel.name;
    f.timezone.value = S.channel.timezone || '';
    f.mode.value = c.processing.mode;
    f.add_logo.checked = !!c.processing.add_logo;
    f.logo_position.value = c.processing.logo_position || '';
    f.logo_opacity.value = c.processing.logo_opacity ?? '';
    f.logo_scale.value = c.processing.logo_scale || '';
    renderLogoPreview();
    loadAutomation();
    f.day_start.value = c.playlist.day_start;
    f.length.value = c.playlist.length;
    f.infinit.checked = !!c.playlist.infinit;
    f.filler.value = c.storage.filler;
    f.extensions.value = (c.storage.extensions || []).join(', ');
    f.shuffle.checked = !!c.storage.shuffle;
    f.loudness_scope.value = c.audio.loudness_scope;
    f.loudness_target_lufs.value = c.audio.loudness_target_lufs;
    f.loudness_true_peak_ceiling_dbtp.value = c.audio.loudness_true_peak_ceiling_dbtp;
    if (!$('#tz-list').children.length && Intl.supportedValuesOf) $('#tz-list').replaceChildren(...Intl.supportedValuesOf('timeZone').map((z) => h('option', { value: z })));
    $('#channel-msg').textContent = '';
}

$('#channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $('#channel-msg');
    msg.className = 'form-msg';
    try {
        if (!Number.isFinite(parseHms(f.day_start.value)) || !Number.isFinite(parseHms(f.length.value))) throw new Error(T('Times must be hh:mm:ss.'));
        [S.channel, S.config] = await Promise.all([api('GET', `/api/channel/${S.channelId}`), api('GET', `/api/playout/config/${S.channelId}`)]);
        if (f.name.value.trim() !== S.channel.name || (f.timezone.value.trim() || null) !== (S.channel.timezone || null)) {
            await api('PATCH', `/api/channel/${S.channelId}`, { ...S.channel, name: f.name.value.trim(), timezone: f.timezone.value.trim() || null });
        }
        const cfg = structuredClone(S.config);
        cfg.processing.mode = f.mode.value;
        cfg.processing.add_logo = f.add_logo.checked;
        cfg.processing.logo_position = f.logo_position.value.trim() || 'W-w-12:12';
        cfg.processing.logo_opacity = Math.min(1, Math.max(0, Number(f.logo_opacity.value) || 0));
        cfg.processing.logo_scale = f.logo_scale.value.trim();
        if (S.logoUploaded) cfg.processing.logo = S.logoUploaded;
        cfg.playlist.day_start = f.day_start.value;
        cfg.playlist.length = f.length.value;
        cfg.playlist.infinit = f.infinit.checked;
        cfg.storage.filler = f.filler.value.trim();
        cfg.storage.extensions = f.extensions.value.split(/[,;\s]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean);
        cfg.storage.shuffle = f.shuffle.checked;
        cfg.audio.loudness_scope = f.loudness_scope.value;
        cfg.audio.loudness_target_lufs = Number(f.loudness_target_lufs.value);
        cfg.audio.loudness_true_peak_ceiling_dbtp = Number(f.loudness_true_peak_ceiling_dbtp.value);
        const r = await api('PUT', `/api/playout/config/${S.channelId}`, cfg);
        await loadChannel();
        renderChannel();
        msg.textContent = r?.requires_restart && S.process === 'active' ? T('Saved. Restart the playout to apply.') : T('Saved.');
        msg.className = 'form-msg ok';
    } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
});

// Filler picker: choose a folder, or a single file.
$('#pick-filler').addEventListener('click', () => { pick(''); $('#picker').showModal(); });
$('#pk-cancel').addEventListener('click', () => $('#picker').close());
$('#pk-folder').addEventListener('click', () => { $('#channel-form').filler.value = pick.rel || ''; $('#picker').close(); });
async function pick(rel) {
    pick.rel = rel;
    $('#pk-folder').disabled = !rel;
    const list = $('#pk-list');
    try {
        const r = await api('POST', `/api/file/${S.channelId}/browse`, { source: rel ? '/' + rel : '', folders_only: false });
        renderCrumbs($('#pk-crumbs'), rel, pick);
        list.replaceChildren(
            ...(rel ? [((up) => h('li', { class: 'folder', onclick: up, ...kbd(up), 'aria-label': T('Up one folder') }, h('span', { class: 'name' }, '↩ ..')))(() => pick(rel.split('/').slice(0, -1).join('/')))] : []),
            ...(r.folders || []).map((f) => { const go = () => pick(rel ? `${rel}/${f}` : f); return h('li', { class: 'folder', onclick: go, ...kbd(go) }, h('span', {}, '📁'), h('span', { class: 'name' }, f)); }),
            ...(r.files || []).map((f) => h('li', {}, h('span', { class: 'name' }, f.name), h('span', { class: 'dur' }, fmtDur(f.duration)),
                h('button', { class: 'btn small', onclick: () => { $('#channel-form').filler.value = rel ? `${rel}/${f.name}` : f.name; $('#picker').close(); } }, T('Use')))),
        );
    } catch (e) { list.replaceChildren(h('li', { class: 'muted' }, e.message)); }
}

