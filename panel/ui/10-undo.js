// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part 10-undo. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- undo
// The server names a recorded action in X-Undo-Id. The next toast of that action gets the
// Undo button; if the action shows no toast, one is shown for it.
S.undoPending = null;
S.undoGroup = null;
function noteUndo(id, label, mut) {
    S.undoPending = { id, label, at: Date.now(), mut };
    setTimeout(() => { if (S.undoPending && S.undoPending.id === id) toast(`${label}.`, 'ok'); }, 700);
}
// Undoing a playlist of the day on air, or one that had no earlier version, is asked first.
const UNDO_ASK = i18nLazy({
    confirm_on_air: [N_('Change the playlist on air?'), N_('This changes the playlist that is on air now: the earlier version of today\'s playlist is put back.'), N_('Put it back')],
    confirm_day_empty: [N_('Leave this day without a playlist?'), N_('There was no earlier playlist for this day. Undo moves the current one aside (to playlists\\_previous, not deleted) and the day has no playlist.'), N_('Move it aside')],
});
async function runUndo(id, label, confirm = []) {
    try {
        let r;
        try { r = await localJson('POST', '/local/undo', { id, confirm }); }
        catch (e) {
            const ask = UNDO_ASK[e.code];
            if (!ask) throw e;
            // Asked in the dialog: the Undo… list closes first (one dialog at a time).
            if ($('#modal').open && $('#undo-list')) $('#modal-ok').click();
            if (!(await confirmModal(ask[0], [ask[1]], { ok: ask[2], danger: true }))) return false;
            return runUndo(id, label, [...confirm, e.code.replace(/^confirm_/, '')]);
        }
        S.undoPending = null;
        toast(T('Undone: {label}.', { label }), 'ok');
        // Show the restored state: a playlist that was undone is reloaded if it has no unsaved edits.
        if (r.playlists?.length && S.playlist && r.playlists.includes(S.playlist.date) && !S.plDirty) S.playlist = null;
        refreshAfterUndo();
        if ($('#modal').open && $('#undo-list')) drawUndoList();
        return true;
    } catch (e) { toast(e.message, 'err'); if ($('#modal').open && $('#undo-list')) drawUndoList(); return false; }
}
function refreshAfterUndo() {
    const v = route.cur;
    if (v === 'builder') return;
    if (v === 'program' && !S.plDirty) { loadPlaylist(); return; }
    route();
}
// Playlists are written through ffplayout: the server keeps each day's previous file first.
async function undoPlBegin(dates, label) {
    try { return (await localJson('POST', '/local/undo/playlist', { stage: 'begin', dates, label })).token; } catch { return null; }
}
async function undoPlCommit(token, dates) {
    if (!token) return;
    try { await localJson('POST', '/local/undo/playlist', { stage: 'commit', token, dates, session: PANEL_SESSION }); } catch { /* not recorded */ }
}
async function drawUndoList(box = $('#undo-list')) {
    if (!box) return;
    const all = box.parentNode?.querySelector('#undo-all')?.checked;
    let d;
    try { d = await localJson('GET', `/local/undo?session=${encodeURIComponent(PANEL_SESSION)}&limit=20${all ? '&all=1' : ''}`); } catch (e) { box.textContent = e.message; return; }
    box.replaceChildren(...(d.entries.length ? d.entries.map((e) => h('li', { class: e.undone_at ? 'done' : '' },
        h('span', { class: 'mono small' }, fmtStamp(e.at)), ' ', h('span', {}, e.label),
        e.undone_at ? h('span', { class: 'badge' }, T('Undone'))
            : e.blocked ? null : h('button', { class: 'btn ghost small', title: T('Put back what this action changed'), onclick: () => runUndo(e.id, e.label) }, T('Undo')),
        e.blocked ? h('div', { class: 'muted small' }, T('Cannot be undone: {blocked}', { blocked: e.blocked })) : null)) : [h('li', { class: 'muted' }, all ? T('Nothing recorded yet.') : T('Nothing changed in this browser session yet.'))]));
}
async function openUndoList() {
    const list = h('ul', { id: 'undo-list', class: 'undo-list' }, h('li', { class: 'muted' }, T('Loading…')));
    const all = h('input', { type: 'checkbox', id: 'undo-all', onchange: () => drawUndoList(list) });
    const p = confirmModal(T('Undo'), [h('p', { class: 'muted small' }, T('The last 20 changes made in this browser session, newest first. Undo puts back what an action changed, unless something newer changed the same thing (then undo that first).')),
        h('label', { class: 'check small' }, all, T(' Show changes from all sessions')), list], { ok: T('Close') });
    drawUndoList(list);
    await p;
}
$('#undo-open').addEventListener('click', (e) => { e.preventDefault(); openUndoList(); });

// Confirms are queued: a second call waits until the open one is answered.
let modalQueue = Promise.resolve();
function confirmModal(...args) {
    const run = modalQueue.then(() => showConfirm(...args));
    modalQueue = run.catch(() => {});
    return run;
}
function showConfirm(title, content, { ok = 'OK', danger = false, requireText = null } = {}) {
    const dlg = $('#modal');
    $('#modal-title').textContent = title;
    const body = $('#modal-text');
    body.replaceChildren(...(Array.isArray(content) ? content : [content]).map((c) => (typeof c === 'string' ? h('p', {}, c) : c)));
    const okBtn = $('#modal-ok');
    okBtn.textContent = ok;
    okBtn.className = 'btn ' + (danger ? 'air' : 'primary');
    let input = null;
    if (requireText) {
        input = h('input', { placeholder: requireText, autocomplete: 'off' });
        body.append(h('label', {}, T('Type {requireText} to confirm', { requireText }), input));
        okBtn.disabled = true;
        input.addEventListener('input', () => (okBtn.disabled = input.value.trim() !== requireText));
    } else okBtn.disabled = false;
    dlg.showModal();
    if (input) input.focus();
    // Resolve from the buttons directly; the dialog 'close' event is not reliable in every embedded browser.
    return new Promise((resolve) => {
        const done = (result) => (e) => {
            if (e) e.preventDefault();
            okBtn.onclick = $('#modal-cancel').onclick = dlg.oncancel = null;
            dlg.close();
            resolve(result);
        };
        okBtn.onclick = done(true);
        $('#modal-cancel').onclick = done(false);
        dlg.oncancel = done(false);
    });
}

