// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Update notice: administrators see a badge in the menu when a newer release is published.
'use strict';

async function updateNotice() {
    const badge = $('#update-badge');
    badge.hidden = true;
    if (!isAdmin()) return;
    let u;
    try { u = await localJson('GET', '/local/update'); } catch { return; }
    if (!u.available) return;
    badge.textContent = T('Update {version} available', { version: u.latest });
    badge.hidden = false;
    badge.onclick = async (e) => {
        e.preventDefault();
        const notes = (u.notes || '').trim();
        const ok = await confirmModal(T('Update {version} is available', { version: u.latest }), [
            h('p', {}, T('You have version {current}. Your settings, media and playlists are kept by the update.', { current: u.current })),
            h('ol', {}, [
                h('li', {}, T('Download the zip from the release page.')),
                h('li', {}, T('Extract it to a new folder.')),
                h('li', {}, T('Run "01 UPDATE.cmd" in that folder and follow the questions.')),
            ]),
            notes ? h('pre', { class: 'small muted', style: 'white-space:pre-wrap;max-height:10em;overflow:auto' }, notes) : null,
        ].filter(Boolean), { ok: T('Open release page') });
        if (ok) window.open(u.url, '_blank', 'noopener');
    };
}
// Look again every six hours while the panel stays open.
setInterval(() => { if (typeof updateNotice === 'function' && !$('#app').hidden) updateNotice(); }, 6 * 3600 * 1000);
