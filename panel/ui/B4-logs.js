// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part B4-logs. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- logs

async function loadLogs() {
    const box = $('#logbox');
    box.textContent = T('Loading…');
    try {
        const d = $('#log-date').value;
        const today = isoDate(new Date());
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const raw = await api('GET', `/api/log/${S.channelId}?timezone=${encodeURIComponent(tz)}${d && d !== today ? `&date=${d}` : ''}`, undefined, { raw: true });
        const doc = new DOMParser().parseFromString(`<pre>${raw}</pre>`, 'text/html');
        const lines = maskText(doc.body.textContent).split('\n').filter(Boolean);
        const lvl = $('#log-level').value;
        const keep = lines.filter((l) => !lvl || (lvl === 'ERROR' ? /\[ERROR\]/.test(l) : /\[(ERROR| WARN)\]/.test(l)));
        box.replaceChildren(...keep.map((l) => h('div', { class: (/\[ERROR\]/.test(l) && 'ERROR') || (/\[ WARN\]/.test(l) && 'WARN') || (/\[DEBUG\]/.test(l) && 'DEBUG') || '' }, l)));
        if (!keep.length) box.textContent = T('No log lines.');
        box.scrollTop = box.scrollHeight;
    } catch (e) { box.textContent = e.message; }
}
$('#log-reload').addEventListener('click', loadLogs);
$('#log-level').addEventListener('change', loadLogs);
$('#log-date').addEventListener('change', loadLogs);

window.addEventListener('beforeunload', (e) => { if (S.plDirty || B?.dirty) { e.preventDefault(); e.returnValue = ''; } });

