// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part A4-library-docs. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---- release documents (per clip, stored on this PC) ----
// File sizes on the share (GB for video files).
const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtSize = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
async function loadDocs(id) {
    try {
        const r = await localJson('GET', `/local/meta/docs?id=${encodeURIComponent(id)}`);
        if (S.editing?.id === id) renderDocs(r.docs);
    } catch (e) { toast(e.message, 'err'); }
}
function renderDocs(docs) {
    const id = S.editing?.id;
    $('#meta-docs').replaceChildren(...(docs.length ? docs.map((d) => h('li', {},
        h('span', {}, '📄'),
        h('a', { href: `/local/meta/doc?id=${encodeURIComponent(id)}&name=${encodeURIComponent(d.name)}`, target: '_blank', rel: 'noopener' }, d.name),
        h('span', { class: 'muted small' }, `${fmtSize(d.size)} · ${fmtStamp(d.uploaded)}`),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => removeDoc(id, d.name) }, T('Remove')),
    )) : [h('li', { class: 'muted small' }, T('No documents attached.'))]));
}
async function removeDoc(id, name) {
    if (!(await confirmModal(T('Remove document?'), T('Remove “{name}” from this clip? The file is moved to the _removed folder, not deleted.', { name }), { ok: T('Remove') }))) return;
    try {
        const r = await localJson('PUT', `/local/meta/docs?id=${encodeURIComponent(id)}`, { name });
        S.docsChanged = true;
        if (S.editing?.id === id) renderDocs(r.docs);
        toast(T('Document removed (moved to _removed).'), 'ok');
    } catch (e) { toast(e.message, 'err'); }
}
$('#meta-doc-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const id = S.editing?.id;
    if (!id || !files.length) return;
    let ok = 0;
    const failed = [];
    const status = $('#meta-doc-status');
    for (const [i, file] of files.entries()) {
        if (file.size > 50 * 1024 * 1024) { failed.push(T('{name}: larger than 50 MB', { name: file.name })); continue; }
        try {
            status.textContent = T('Uploading {v}/{count}: {name}…', { v: i + 1, count: files.length, name: file.name });
            const r = await netFetch(`/local/meta/docs?id=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.detail || T('HTTP {status}', { status: r.status }));
            ok++;
            S.docsChanged = true;
            if (S.editing?.id === id) renderDocs(j.docs);
        } catch (err) { failed.push(`${file.name}: ${err.message}`); }
    }
    status.textContent = '';
    if (failed.length) toast(T('{count} attached; {count2} failed. {v}', { count: plural(ok, 'document', 'documents'), count2: failed.length, v: failed.join('; ') }), 'err');
    else if (ok) toast(T('{count} attached.', { count: plural(ok, 'document', 'documents') }), 'ok');
});

// ---- library rescan (runs tools\scan-library.js on this PC; read-only on the share) ----
function renderScan(st) {
    if (typeof st.library_empty === 'boolean') renderScan.first = st.library_empty;
    const el = $('#scan-status');
    const btn = $('#scan-run');
    btn.disabled = !!st.running;
    btn.textContent = st.running ? T('Scanning…') : renderScan.first ? T('First scan') : T('Rescan library');
    el.classList.toggle('run', !!st.running);
    if (st.running) { el.hidden = false; el.textContent = T('Scanning the share… {v}', { v: st.progress || '' }); return; }
    if (st.error) { el.hidden = false; el.textContent = T('Last scan failed: {error}', { error: st.error }); return; }
    if (st.result) {
        const r = st.result;
        el.hidden = false;
        el.textContent = T('Last scan {time}: {count} · {count2} ({new_hours} h) · {count3} added, {count4} no longer on the share.', { time: fmtStamp(st.finished), count: plural(r.files, 'file', 'files'), count2: plural(r.new_clips, 'new clip', 'new clips'), new_hours: r.new_hours, count3: plural(r.added_files, 'file', 'files'), count4: n0(r.removed_files) });
        return;
    }
    el.hidden = true;
}
async function pollScan(announce) {
    try {
        const st = await localJson('GET', '/local/library/rescan');
        renderScan(st);
        pollScan.wasRunning = !!st.running;
        if (st.running) { clearTimeout(pollScan.t); pollScan.t = setTimeout(() => pollScan(true), 2000); return; }
        if (announce) {
            if (st.error) toast(st.error, 'err');
            else if (st.result) toast(T('Library rescanned: {count}, {count2} no longer on the share', { count: Tn('{n} new clip', '{n} new clips', st.result.new_clips), count2: Tn('{n} file', '{n} files', st.result.removed_files) }) + (st.result.moved_files ? T(' ({count} of them renamed or moved)', { count: n0(st.result.moved_files) }) : '') + '.', 'ok');
            S.formatInfo = null;
            loadLib();
            // A rescan is when renamed/moved files show up: offer to fix saved playlists.
            if (!st.error && st.result) repairPlaylists({ quiet: true }).catch(() => {});
        }
    } catch {
        // Keep polling (slower) while the Library is open or a scan was running.
        if (!$('#view-library').hidden || pollScan.wasRunning) { clearTimeout(pollScan.t); pollScan.t = setTimeout(() => pollScan(announce || pollScan.wasRunning), 15000); }
    }
}
$('#scan-run').addEventListener('click', async () => {
    if (!(await confirmModal(renderScan.first ? T('Scan the media folder?') : T('Rescan the library?'), [T('Reads the media folder and updates library.csv: new and changed videos are probed, removed ones drop out. Nothing on the share is changed. Clip metadata and documents are kept.'), T('This takes a few minutes for new files; unchanged files are skipped quickly.')], { ok: renderScan.first ? T('Scan') : T('Rescan') }))) return;
    try { renderScan(await localJson('POST', '/local/library/rescan', {})); pollScan(true); }
    catch (e) { toast(e.message, 'err'); }
});
$('#meta-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const exp = $('.date-txt[data-for="meta-expires"]');
    if (exp.value.trim() && !parseDate(exp.value)) { exp.classList.add('bad'); return toast(T('Rights expiry: use the date format {format}.', { format: dateHint() }), 'err'); }
    const fields = Object.fromEntries(['title', 'performer', 'songwriters', 'category', 'rights', 'rights_expires', 'rights_note', 'language', 'tags', 'notes'].map((k) => [k, f[k].value]));
    fields.explicit = f.explicit.checked ? 'yes' : '';
    // An unchanged default title (the file name) is not stored.
    if (fields.title.trim() === S.editing.file.replace(/\.[^.]+$/, '')) fields.title = '';
    try {
        const r = await localJson('PUT', '/local/meta/clip', { id: S.editing.id, fields });
        S.metaSaved = !!r.changed;
        $('#meta-dlg').close();
        toast(r.changed ? T('Saved.') : T('No changes.'), 'ok');
    } catch (err) { toast(err.message, 'err'); }
});

// Import: read the file as strict UTF-8 (Excel's plain "CSV" is not UTF-8 and would
// garble Hebrew), dry-run on the server, show what would change, then apply.
$('#meta-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { return toast(T('This file is not UTF-8, so Hebrew would be garbled. In Excel use Save As → "CSV UTF-8 (Comma delimited)", then import again.'), 'err'); }
    try {
        const dry = await localJson('POST', '/local/meta/import', { csv: text, dry_run: true });
        if (dry.errors?.length) {
            return confirmModal(T('Import refused'), [T(`Nothing was imported. Fix these rows and try again:`), h('ul', { class: 'small' }, ...dry.errors.map((x) => h('li', {}, x)))], { ok: T('OK') });
        }
        if (!dry.changed) return toast(T('No changes in {name} ({count} matched{v}).', { name: file.name, count: plural(dry.matched, 'clip', 'clips'), v: dry.unknown_ids ? T(', {unknown_ids} unknown IDs ignored', { unknown_ids: dry.unknown_ids }) : '' }));
        const ok = await confirmModal(T('Import metadata?'), [
            T('{name}: {count}, {count2} matched, {count3} will change.', { name: file.name, count: Tn('{n} row', '{n} rows', dry.rows), count2: Tn('{n} clip', '{n} clips', dry.matched), count3: n0(dry.changed) }),
            dry.unknown_ids ? `${dry.unknown_ids === 1 ? '1 row has an ID that is' : T('{count} rows have IDs that are', { count: n0(dry.unknown_ids) })} not in the library and will be ignored.` : '',
            T('Columns read: {v}. An empty cell clears that field. A backup is kept.', { v: dry.columns.join(', ') }),
        ].filter(Boolean), { ok: T('Import {changed} changes', { changed: dry.changed }) });
        if (!ok) return;
        const r = await localJson('POST', '/local/meta/import', { csv: text, dry_run: false });
        toast(r.applied ? T('Imported: {count} changed.', { count: plural(r.changed, 'clip', 'clips') }) : T('Nothing imported.'), r.applied ? 'ok' : 'err');
        loadLib();
    } catch (err) { toast(err.message, 'err'); }
});

