// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 30-start. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- gate

function showGate(which) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#login-form').hidden = which !== 'login';
    $('#setup-form').hidden = which !== 'setup';
    $('#check-form').hidden = which !== 'check';
    $('#login-form').password.type = 'password';
}
// Once signed in, the hidden sign-in form keeps no password field: with one in the page,
// Chrome offers to "save a password" after typing into unrelated fields (e.g. a start time).
function hideGate() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    const f = $('#login-form');
    f.password.value = '';
    f.password.type = 'text';
}

$('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $('#login-msg');
    msg.textContent = '';
    msg.className = 'form-msg';
    try {
        let r, j;
        if (!$('#login-2fa').hidden && f.code.value) {
            r = await netFetch('/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, code: f.code.value }) });
        } else {
            r = await netFetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
        }
        const text = await r.text();
        try { j = JSON.parse(text); } catch { j = text; }
        if (!r.ok) throw new Error((j && j.detail) || text || T('Login failed'));
        if (j && j.access) {
            tokens.set(j.access, j.refresh);
            f.password.value = '';
            await startApp();
        } else {
            $('#login-2fa').hidden = false;
            msg.textContent = typeof j === 'string' ? j : T('Enter the verification code.');
        }
    } catch (err) {
        msg.textContent = err.message;
        msg.className = 'form-msg err';
    }
});

fetch('/local/paths').then((r) => r.json()).then((p) => {
    for (const k of ['playlists', 'public', 'logs', 'storage']) { const el = $('#setup-form')[k]; if (el && !el.value) el.value = p[k] || ''; }
}).catch(() => {});

// Shows the problem while typing instead of after pressing Complete setup.
{
    const f = $('#setup-form'), err = $('#setup-pw-err');
    const check = () => {
        let text = '';
        if (f.password.value && f.password.value.length < 8) text = T('Use at least 8 characters.');
        else if (f.password2.value && f.password.value !== f.password2.value) text = T('Passwords do not match.');
        err.textContent = text ? `✖ ${text}` : '';
        err.hidden = !text;
        f.password2.setAttribute('aria-invalid', text === T('Passwords do not match.') ? 'true' : 'false');
        f.password.setAttribute('aria-invalid', f.password.value && f.password.value.length < 8 ? 'true' : 'false');
    };
    f.password.addEventListener('input', check);
    f.password2.addEventListener('input', check);
}

$('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $('#setup-msg');
    msg.className = 'form-msg';
    if (f.password.value !== f.password2.value) { msg.textContent = T('Passwords do not match.'); msg.className = 'form-msg err'; return; }
    const body = {
        username: f.username.value.trim(), mail: f.mail.value.trim(), password: f.password.value, two_factor: false,
        logs: f.logs.value.trim(), playlists: f.playlists.value.trim(), public: f.public.value.trim(), storage: f.storage.value.trim(),
        shared: false, smtp_server: '', smtp_user: '', smtp_password: '', smtp_starttls: false, smtp_port: 465,
    };
    const ok = await confirmModal(T('Complete setup?'), [
        h('p', {}, T('These folders are fixed after setup:')),
        h('dl', { class: 'kv' }, ...['playlists', 'public', 'logs', 'storage'].flatMap((k) => [h('dt', {}, k), h('dd', {}, h('code', {}, body[k]))])),
    ], { ok: T('Create admin') });
    if (!ok) return;
    try {
        const r = await netFetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const t = await r.text();
        if (!r.ok) throw new Error(t);
        f.password.value = f.password2.value = '';
        toast(T('Setup complete. Sign in with your new admin account.'), 'ok');
        showGate('login');
        $('#login-form').username.value = body.username;
    } catch (err) {
        msg.textContent = err.message;
        msg.className = 'form-msg err';
    }
});

$('#logout').addEventListener('click', async () => {
    if (tokens.refresh) await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: tokens.refresh }) }).catch(() => {});
    tokens.clear();
    location.hash = '';
    location.reload();
});

// ---------------------------------------------------------------- boot

async function boot() {
    await I18N.ready;   // the language is loaded before the first screen is drawn
    if (await setupGate()) return;   // first run or ffplayout missing: the setup screen (32-setup.js)
    try {
        const s = await (await fetch('/api/setup')).json();
        if (s.required) return showGate('setup');
    } catch {
        document.body.replaceChildren(h('div', { class: 'gate' }, h('div', { class: 'gate-card' }, h('h1', {}, T('ffplayout is not running')), h('p', { class: 'muted' }, T('Start it with start-ffplayout.ps1 from the install folder, then reload this page.')))));
        return;
    }
    if (!tokens.access) return showGate('login');
    try { await startApp(); } catch (e) { if (e.message !== 'Signed out') toast(e.message, 'err'); }
}

async function startApp() {
    S.user = await api('GET', '/api/user');
    // Global admin = allowed to list users (the role field differs between ffplayout builds).
    S.isAdmin = await api('GET', '/api/users').then(() => true).catch(() => false);
    const channels = await api('GET', '/api/channels');
    if (!channels.length) throw new Error(T('No channel available for this user.'));
    S.channelId = channels[0].id;
    applyCategories((await localJson('GET', '/local/categories')).categories);
    await Promise.all([loadChannel(), localState.load(), api('GET', `/api/playout/codecs/${S.channelId}`).then((c) => (S.codecs = c))]);
    hideGate();
    $('#who').textContent = T('Signed in as {username}', { username: S.user.username });
    // System settings: administrators only (ffplayout role 1; a build without role ids shows it).
    $('#nav-system').hidden = !isAdmin();
    updateNotice();
    const tomorrow = addDays(isoDate(new Date()), 1);
    $('#pl-date').value = tomorrow;
    $('#log-date').value = isoDate(new Date());
    route();
    poll();
    checkSchedule();
    pollAttnCount();
    if (typeof helpInit === 'function') helpInit();
    // startApp runs again after a re-login: listeners and timers are set up once.
    if (!startApp.started) {
        startApp.started = true;
        window.addEventListener('hashchange', route);
        setInterval(poll, 3000);
        setInterval(checkSchedule, 5 * 60 * 1000);
    }
}

async function loadChannel() {
    const id = S.channelId;
    [S.channel, S.config, S.outputs] = await Promise.all([
        api('GET', `/api/channel/${id}`),
        api('GET', `/api/playout/config/${id}`),
        api('GET', `/api/playout/outputs/${id}`),
    ]);
    $('#chan-name').textContent = S.channel.name;
    renderOnAir();
}

const VIEWS = ['dashboard', 'outputs', 'program', 'library', 'asrun', 'channel', 'live', 'logs', 'branding', 'attention', 'builder', 'hidden', 'system'];
// Old links to the former Needs attention > Hidden files tab open the Hidden media page.
const VIEW_ALIASES = { 'attention-hidden': 'hidden', 'attention/hidden': 'hidden', 'hidden-files': 'hidden', 'hidden-media': 'hidden' };
function route() {
    const alias = VIEW_ALIASES[location.hash.slice(1)];
    if (alias) { history.replaceState(null, '', `#${alias}`); }
    const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
    // Leaving the block builder (Back, a link, a typed address) with unsaved changes: asked
    // first; the builder stays until the answer. Leaving it without changes closes it.
    if (route.cur === 'builder' && v !== 'builder' && B) {
        if (B.dirty) {
            history.replaceState(null, '', '#builder');
            confirmModal(T('Leave the block builder?'), T('The changes in the block builder are not saved and will be lost.'), { ok: T('Discard changes'), danger: true })
                .then((ok) => { if (ok && B) { B = null; location.hash = v; } });
            return;
        }
        B = null;
    }
    // Leaving Live input: the browser's camera and microphone (or the panel's preview) are released.
    if (route.cur === 'live' && v !== 'live' && typeof capRelease === 'function') capRelease();
    route.cur = v;
    for (const name of VIEWS) $(`#view-${name}`).hidden = name !== v;
    $$('.side a[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    // The block builder takes the whole window (no side bar); it has no menu item.
    $('#app').classList.toggle('bld-open', v === 'builder');
    if (v !== 'dashboard') stopPlayer();
    // Coming back to Program for the same date keeps unsaved edits.
    const program = () => (S.plDirty && S.playlist?.date === $('#pl-date').value ? renderPlaylist() : loadPlaylist());
    ({ dashboard: renderDashboard, outputs: renderOutputs, program, library: renderLibrary, asrun: renderAsrun, channel: renderChannel, live: renderLive, logs: loadLogs, branding: renderBranding, attention: renderAttention, hidden: renderHiddenMedia, system: renderSystem,
        builder: () => (B ? renderBuilder() : (location.hash = 'program')) })[v]();
    if (typeof helpOnRoute === 'function') helpOnRoute();
}

