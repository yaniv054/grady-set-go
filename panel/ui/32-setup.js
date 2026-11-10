// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 32-setup. First-run setup screen: lists what this PC has and lacks, with the steps to fix it.
'use strict';

const CHK_LINKS = {
    node: 'https://nodejs.org/',
    engine: 'https://github.com/ffplayout/ffplayout/releases',
    ffprobe: 'https://ffmpeg.org/download.html',
    ffmpeg: 'https://ffmpeg.org/download.html',
    vlc: 'https://www.videolan.org/vlc/',
};

// Title, status text and (when something is wrong) the steps, per check.
function chkText(c) {
    // Versions, paths and addresses are isolated so they keep their own direction inside right-to-left sentences.
    const iso = (x) => `\u2068${x}\u2069`;
    const v = { v: iso(c.version || c.value), path: iso(c.value), url: iso(c.value) };
    switch (c.id) {
    case 'node':
        return { title: 'Node.js', text: c.level === 'ok' ? T('Version {v} is installed.', v) : T('Version {v} is older than 18. Install the current LTS version.', v) };
    case 'engine':
        return { title: T('ffplayout (the playout engine)'), text: c.level === 'ok' ? T('Reachable at {url}.', v)
            : c.exe && c.libs_missing ? T('Not reachable at {url}. ffplayout is installed but cannot start: it needs the FFmpeg program libraries (DLL files) next to it, and the FFmpeg you installed does not include them. Press the button to download them.', v)
                : c.exe ? T('Not reachable at {url}. ffplayout is installed but not running. Press Start ffplayout.', v)
                : T('Not reachable at {url}. ffplayout.exe was not found in app\\bin. Run 00 START HERE.cmd, or download ffplayout 2.6.0 from its releases page, unzip it and put ffplayout.exe into app\\bin.', v) };
    case 'media':
        return { title: T('Media folder'), text: c.level === 'ok' ? T('Folder found: {path}.', v)
            : c.state === 'unset' ? T('Enter the folder that holds your video files.')
                : c.state === 'unreadable' ? T('This folder cannot be read: {path}.', v) : T('This folder does not exist: {path}.', v) };
    case 'ffprobe':
        return { title: 'ffprobe', text: c.level === 'ok' ? T('Version {v} found: {path}.', v) : T('Not found. The media library needs it. Install FFmpeg (it includes ffprobe) or enter the program path under Advanced.') };
    case 'ffmpeg':
        return { title: 'ffmpeg', text: c.level === 'ok' ? T('Version {v} found: {path}.', v) : T('Not found next to ffprobe. Needed for thumbnails, loudness checks and live input.') };
    case 'data':
        return { title: T('Data and log folders'), text: c.level === 'ok' ? T('They can be written.') : T('The panel cannot write to {path}. Check the folder permissions.', v) };
    case 'vlc':
        return { title: 'VLC', text: c.level === 'ok' ? T('Found: {path}.', v) : T('Optional. Only used by the buttons that play a file on this PC. Install VLC.') };
    case 'whisper':
        return { title: T('Speech-to-text tools'), text: c.level === 'ok' ? T('Found.') : T('Optional. Detects songs from the audio of your clips. It needs the whisper.cpp program (small) and a speech model (about 1.6 GB). Press the button: it downloads both here and shows the progress. For a Hebrew model run tools\\whisper\\setup-whisper.ps1 -Language he and set whisper_model and whisper_language in config.json.') };
    }
    return { title: c.id, text: '' };
}

let chkAuto = true, chkJob = false, chkPicking = false;

// Progress of the speech-to-text download, shown under its button.
function chkWhisperProgress(j) {
    const box = $('#chk-whisper-progress'), btn = $('#chk-whisper-get'), bar = $('#chk-whisper-bar'), txt = $('#chk-whisper-txt');
    if (!j || (!j.running && !j.error)) { box.hidden = true; btn.hidden = false; return; }
    const mb = (n) => Math.round(n / 1048576).toLocaleString();
    box.hidden = false;
    if (j.error) {
        btn.hidden = false; bar.hidden = true;
        txt.textContent = T('The download stopped: {error}. Press the button to continue where it stopped.', { error: `\u2068${j.error}\u2069` });
        return;
    }
    btn.hidden = true; bar.hidden = false;
    if (j.phase === 'model' && j.total) {
        const pct = Math.min(100, Math.floor((j.done / j.total) * 100));
        bar.max = 100; bar.value = pct;
        txt.textContent = T('Downloading the speech model: {done} of {total} MB ({pct}%)', { done: mb(j.done), total: mb(j.total), pct });
    } else {
        bar.removeAttribute('value');
        txt.textContent = j.phase === 'model' ? T('Starting the model download ...') : T('Downloading the speech-to-text program ...');
    }
}

let chkParts = null;
function chkRender(st) {
    chkParts = chkParts || { media: $('#chk-media-box'), ffprobe: $('#chk-ffprobe-adv'), engineBtn: $('#chk-engine-actions'), engineLibs: $('#chk-engine-libs-actions'), engineAdv: $('#chk-engine-adv'), whisper: $('#chk-whisper-actions') };
    const label = { ok: T('OK'), fail: T('Missing'), warn: T('Optional') };
    const mark = { ok: '✔', fail: '✖', warn: '!' };
    $('#chk-list').replaceChildren(...st.checks.map((c) => {
        const t = chkText(c);
        const link = c.level !== 'ok' && CHK_LINKS[c.id] ? h('a', { href: CHK_LINKS[c.id], target: '_blank', rel: 'noopener noreferrer' }, CHK_LINKS[c.id]) : null;
        const body = h('div', { class: 'chk-body' }, h('strong', {}, t.title), ' ', h('span', { class: 'chk-state' }, label[c.level]), h('div', { class: 'muted' }, t.text), link ? h('div', { dir: 'ltr' }, link) : null);
        // Inputs and buttons live in the row they belong to.
        if (c.id === 'media') body.append(chkParts.media);
        if (c.id === 'ffprobe') body.append(chkParts.ffprobe);
        if (c.id === 'engine') {
            if (c.level !== 'ok' && c.exe && c.can_start && c.libs_missing) body.append(chkParts.engineLibs);
            else if (c.level !== 'ok' && c.exe && c.can_start) body.append(chkParts.engineBtn);
            body.append(chkParts.engineAdv);
            chkParts.engineAdv.querySelector('#chk-engine-save-start').hidden = !c.can_start;
        }
        if (c.id === 'whisper' && c.level !== 'ok' && c.can_run) body.append(chkParts.whisper);
        return h('li', { class: `chk ${c.level}` }, h('span', { class: 'chk-mark', 'aria-hidden': 'true' }, mark[c.level]), body);
    }));
    chkWhisperProgress(st.whisper_job);
    // The page re-checks by itself only while something is still missing (and while a download runs).
    chkAuto = st.checks.some((c) => c.level === 'fail');
    chkJob = Boolean(st.whisper_job && st.whisper_job.running);
    const media = st.checks.find((c) => c.id === 'media');
    $('#chk-save').disabled = !(media && media.level === 'ok');
    $('#chk-save').textContent = st.configured ? T('Continue') : T('Save and continue');
}

async function chkFetch(check) {
    const f = $('#check-form');
    const q = check ? `?check=1&media_root=${encodeURIComponent(f.media_root.value)}&engine_url=${encodeURIComponent(f.engine_url.value)}&ffprobe=${encodeURIComponent(f.ffprobe.value)}` : '';
    return (await fetch(`/local/setup/status${q}`)).json();
}

let chkTimer = null;
async function chkRefresh(quiet) {
    quiet = quiet === true;   // quiet: background update (no sweep, no busy button)
    const btn = $('#chk-recheck'), bar = $('#chk-progress');
    const label = btn.textContent;
    const rows = [...document.querySelectorAll('#chk-list > .chk')];
    let sweep = Promise.resolve();
    if (!quiet) {
        btn.disabled = true; btn.textContent = T('Checking ...'); bar.hidden = false;
        // A light highlight moves down the list, one row at a time (slowly enough to follow), while the checks run.
        sweep = (async () => {
            for (const row of rows) {
                row.classList.add('testing');
                await new Promise((r) => setTimeout(r, 500));
                row.classList.remove('testing');
            }
        })();
    }
    try {
        const [st] = await Promise.all([chkFetch(true), sweep]);
        if (!st.needed) { location.reload(); return; }
        chkRender(st);
    } catch { /* panel restarting: the next round tries again */ }
    finally { if (!quiet) { rows.forEach((r) => r.classList.remove('testing')); btn.disabled = false; btn.textContent = label; bar.hidden = true; } }
}

// Returns true when the setup screen took over.
async function setupGate() {
    let st;
    try { st = await (await fetch('/local/setup/status')).json(); } catch { return false; }
    if (!st || !st.needed) return false;
    const f = $('#check-form');
    f.media_root.value = st.suggest.media_root;
    f.ffprobe.value = st.suggest.ffprobe;
    f.engine_url.value = st.suggest.engine_url;
    showGate('check');
    chkRender(st);
    $('#chk-recheck').addEventListener('click', () => chkRefresh());
    const runAction = async (action, doing) => {
        const msg = $('#chk-msg');
        msg.className = 'form-msg';
        try {
            const body = { action };
            if (action === 'start_engine' && f.engine_url.value.trim() && f.engine_url.value.trim() !== st.suggest.engine_url) body.engine_url = f.engine_url.value.trim();
            const r = await fetch('/local/setup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(T(j.detail || 'The action failed.'));
            msg.textContent = doing;
            if (action === 'get_whisper') { chkJob = true; chkRefresh(true); }   // follow the download second by second
            else setTimeout(() => chkRefresh(), 4000);
        } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
    };
    $('#chk-engine-start').addEventListener('click', () => runAction('start_engine', T('Starting ffplayout ... this line turns green when it answers.')));
    $('#chk-engine-save-start').addEventListener('click', () => runAction('start_engine', T('Address saved. Starting ffplayout ... this line turns green when it answers.')));
    $('#chk-engine-libs').addEventListener('click', () => runAction('get_ffmpeg_libs', T('A window opened and is downloading. ffplayout starts by itself when it is finished.')));
    $('#chk-whisper-get').addEventListener('click', () => runAction('get_whisper', T('The download started. The progress is shown below; this line turns green when it is finished.')));
    f.media_root.addEventListener('change', () => chkRefresh());
    // Folder browser: lists the folders of this PC so the path does not have to be typed or pasted.
    const showBrowse = async (start) => {
        const box = $('#chk-browser'), list = $('#chk-browser-list'), msg = $('#chk-msg');
        let r = await fetch(`/local/setup/browse?path=${encodeURIComponent(start || '')}`);
        if (!r.ok && start) r = await fetch('/local/setup/browse?path=');
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = T(j.detail || 'That folder cannot be opened.'); msg.className = 'form-msg err'; return; }
        msg.textContent = '';
        box.hidden = false;
        $('#chk-browser-path').textContent = j.path || T('This PC');
        const up = $('#chk-browser-up');
        up.disabled = j.parent === null; up.dataset.path = j.parent || '';
        $('#chk-browser-use').disabled = !j.path; $('#chk-browser-use').dataset.path = j.path;
        list.replaceChildren(...(j.dirs.length ? j.dirs.map((d) => h('li', {}, h('button', { type: 'button', dir: 'ltr', onclick: () => showBrowse(d.path) }, d.name))) : [h('li', { class: 'muted small' }, T('No subfolders here.'))]));
    };
    // The Windows folder window ("Select Folder"); when it cannot be opened, the page's own folder list is used.
    $('#chk-browse').addEventListener('click', async () => {
        const btn = $('#chk-browse'), msg = $('#chk-msg'), label = btn.textContent;
        chkPicking = true; btn.disabled = true; btn.textContent = T('Folder window open ...');
        msg.textContent = T('The folder window is open. If you do not see it, look in the taskbar.'); msg.className = 'form-msg';
        try {
            const r = await fetch('/local/setup/pick-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: f.media_root.value.trim(), title: T('Select the media folder') }) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.detail || 'failed');
            msg.textContent = '';
            if (j.path) { f.media_root.value = j.path; chkRefresh(); }
        } catch { msg.textContent = ''; await showBrowse(f.media_root.value.trim()); }
        finally { chkPicking = false; btn.disabled = false; btn.textContent = label; }
    });
    $('#chk-browser-up').addEventListener('click', (e) => showBrowse(e.currentTarget.dataset.path));
    $('#chk-browser-use').addEventListener('click', (e) => { f.media_root.value = e.currentTarget.dataset.path; $('#chk-browser').hidden = true; chkRefresh(); });
    $('#chk-browser-close').addEventListener('click', () => { $('#chk-browser').hidden = true; });
    chkTimer = setInterval(() => { if (chkAuto && !chkPicking && $('#chk-browser').hidden && (!f.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON')) chkRefresh(true); }, 5000);
    setInterval(() => { if (chkJob) chkRefresh(true); }, 1000);   // a running download updates every second
    f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('#chk-msg');
        msg.className = 'form-msg';
        if (st.configured && !f.media_root.value) { location.reload(); return; }
        try {
            const cur = await chkFetch(false);
            if (cur.configured) { location.reload(); return; }
            const r = await fetch('/local/setup/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_root: f.media_root.value.trim(), ffprobe: f.ffprobe.value.trim(), engine_url: f.engine_url.value.trim() }) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(T(j.detail || 'Saving failed.'));
            clearInterval(chkTimer);
            msg.textContent = T('Saved. Restarting the panel...');
            // Wait for the new panel process, then load the page again.
            for (let i = 0; i < 40; i++) {
                await new Promise((ok) => setTimeout(ok, 1000));
                try { const s = await chkFetch(false); if (s.configured) { location.reload(); return; } } catch { /* still restarting */ }
            }
            msg.textContent = T('The panel did not come back. Start it again from the install folder, then reload this page.');
            msg.className = 'form-msg err';
        } catch (err) {
            msg.textContent = err.message;
            msg.className = 'form-msg err';
        }
    });
    return true;
}

// Messages the panel server can return from the setup routes (translated when shown).
const CHK_SERVER_MESSAGES = [
    N_('The media folder does not exist or cannot be read.'), N_('That folder cannot be opened.'), N_('tools\\install.js is missing.'), N_('The engine address is not a valid URL.'),
    N_('The engine address must start with http:// or https://.'), N_('ffprobe could not be started from that path.'), N_('ffplayout.exe was not found in app\\bin. Run 00 START HERE.cmd or put it there.'),
    N_('tools\\whisper\\setup-whisper.ps1 is missing.'), N_('Unknown action.'), N_('This button works on Windows only.'),
];
