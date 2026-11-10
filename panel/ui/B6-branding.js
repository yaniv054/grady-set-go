// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part B6-branding. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---------------------------------------------------------------- channel branding
// Files per type (storage\branding\<type>), each checked against the kit spec on upload.
const BRAND_INFO = i18nLazy({
    ident: [N_('Idents'), N_('BR-03, BR-04'), N_('Channel signature, 3–8 s. Used at the top of each hour and every N minutes.')],
    stinger: [N_('Stingers'), 'BR-05', N_('1–2 s cut between two short clips.')],
    upnext: [N_('Up-next backgrounds'), 'BR-06', N_('Before long clips; the next title is drawn on top live (Live text).')],
    opener: [N_('Openers'), N_('BR-07, BR-08'), N_('Before full concerts.')],
    closer: [N_('Closers'), 'BR-08', N_('After full concerts.')],
    advisory: [N_('Explicit-language cards'), 'BR-15', N_('Before clips marked explicit.')],
    countdown: [N_('Live-show countdowns'), 'BR-10', N_('Right before a live slot (Program → Live slot).')],
    promo: [N_('Promos'), N_('BR-09, BR-11'), N_('Stored for now; not inserted automatically yet.')],
    slate: [N_('Slates'), N_('BR-12 – BR-14'), N_('Still 1920×1080 PNG. “Use as” replaces the off-air or live-standby slate (the old one is kept).')],
    logo: [N_('Logo bug'), 'BR-01', N_('PNG with transparency, at most 240×120. “Use as channel logo” replaces the on-screen logo; turn the logo on in Channel & schedule.')],
    font: [N_('Fonts'), 'kit fonts', N_('TTF or OTF for on-screen text. Stored for the designer and future text styles.')],
    sonic: [N_('Sonic logo'), 'BR-18', N_('WAV masters. Stored only; not played on their own.')],
});
const BRAND_ACCEPT = { video: '.mp4,.mov', still: '.png', logo: '.png', font: '.ttf,.otf', audio: '.wav' };
// Thumbnail of a branding file, from its full path (…\branding\<type>\file) or its rel path.
const brandThumbUrl = (src, v) => `/local/branding/thumb?rel=${encodeURIComponent(String(src).split(/[\\/]branding[\\/]/i).pop().replace(/\\/g, '/'))}${v != null ? `&v=${v}` : ''}`;
// Default set: …\branding\<type>\file; a named set: …\branding\_sets\<set>\<type>\file.
const brandTypeOfSrc = (src) => { const m = /[\\/]branding[\\/](?:_sets[\\/][^\\/]+[\\/])?([a-z]+)[\\/]/i.exec(String(src || '')); return m ? m[1].toLowerCase() : null; };
function brandCheckBadge(x) {
    if (!x.check) return h('span', { class: 'badge' }, T('Checking…'));
    const c = x.check;
    const tip = [...c.errors, ...c.warnings].join('\n');
    if (!c.ok) return h('span', { class: 'badge bad', title: tip }, T('Fails ({count})', { count: c.errors.length }));
    if (c.warnings.length) return h('span', { class: 'badge warn', title: tip }, Tn('{n} warning', '{n} warnings', c.warnings.length));
    return h('span', { class: 'badge on' }, T('OK'));
}
function brandInfoLine(x) {
    const i = x.check?.info || {};
    return [i.width && `${i.width}×${i.height}`, i.fps && `${i.fps} fps`, i.duration && fmtDur(i.duration).replace(/^00:/, ''), i.lufs != null && `${i.lufs} LUFS`, fmtSize(x.size)].filter(Boolean).join(' · ');
}
function uploadBrand(type, file, onProgress, set = '') {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/local/branding/upload?type=${encodeURIComponent(type)}&name=${encodeURIComponent(file.name)}&set=${encodeURIComponent(set)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        xhr.onload = () => { let j = null; try { j = JSON.parse(xhr.responseText); } catch { /* not json */ } xhr.status < 300 ? resolve(j) : reject(new Error(j?.detail || T('Upload failed (HTTP {status})', { status: xhr.status }))); };
        xhr.onerror = () => reject(new Error(T('Upload failed (connection)')));
        xhr.send(file);
    });
}
// Branding set shown on this page ('' = Default), remembered per browser (a convenience).
S.brandSet = '';
try { S.brandSet = localStorage.getItem('cr_brand_set') || ''; } catch { /* storage unavailable */ }
function setBrandSet(set) { S.brandSet = set || ''; try { localStorage.setItem('cr_brand_set', S.brandSet); } catch { /* ignore */ } }
async function renderBranding() {
    clearTimeout(renderBranding.t);
    let d, rules, am;
    const set = S.brandSet;
    try { [d, rules, am] = await Promise.all([localJson('GET', `/local/branding?set=${encodeURIComponent(set)}`), localJson('GET', '/local/branding/rules'), localJson('GET', '/local/automation')]); }
    catch (e) {
        // The remembered set is gone (renamed or moved aside): back to the Default set.
        if (set && /not found/i.test(e.message)) { setBrandSet(''); return renderBranding(); }
        return toast(e.message, 'err');
    }
    if (set !== S.brandSet) return;
    const ss = $('#brand-set');
    ss.replaceChildren(h('option', { value: '' }, T('Default')), ...(d.sets || []).map((n) => h('option', { value: n }, n)));
    ss.value = d.set || '';
    $('#brand-set-hint').textContent = d.set
        ? T('Set “{name}”: used for automatic branding on occasion days that choose it (Program → Occasions). A type with no files here gets no branding on those days; the Default set is not used instead. Files: {name2}.', { name: bidiText(d.set), name2: bidiText(`storage\\branding\\_sets\\${d.set}`) })
        : T('The Default set is used on every day that is not an occasion with its own set. Upload, check and remove work per set; “Use as” (off-air, live standby, channel logo) is only for the Default set.');
    const rf = $('#brand-rules');
    if (!rf.dataset.loaded) {
        for (const [k, v] of Object.entries(rules)) { const el = rf.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
        const lf = $('#brand-live'), bl = am.branding_live || {};
        for (const [k, v] of Object.entries(bl)) { const el = lf.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
        rf.dataset.loaded = '1';
    }
    const wrap = $('#brand-types');
    const order = ['ident', 'stinger', 'upnext', 'opener', 'closer', 'advisory', 'countdown', 'promo', 'slate', 'logo', 'font', 'sonic'];
    let pending = false;
    wrap.replaceChildren(...order.map((type) => {
        const [title, ids, note] = BRAND_INFO[type];
        const items = d.types[type] || [];
        const kind = d.kinds[type];
        const input = h('input', { type: 'file', multiple: true, hidden: true, accept: BRAND_ACCEPT[kind] });
        const status = h('span', { class: 'muted small' });
        input.addEventListener('change', async () => {
            const files = [...input.files];
            input.value = '';
            if (!files.length) return;
            // Progress goes to the card's status line; one summary toast at the end.
            const failed = [], fails = [], warns = [];
            let passed = 0;
            for (const [i, f] of files.entries()) {
                try {
                    const r = await uploadBrand(type, f, (p) => { status.textContent = T('Uploading {v}/{count}: {name} {v2}%', { v: i + 1, count: files.length, name: f.name, v2: Math.round(p * 100) }); }, d.set || '');
                    const c = r?.check;
                    if (c && !c.ok) fails.push(f.name); else if (c?.warnings?.length) warns.push(f.name); else passed++;
                } catch (e) { failed.push(`${f.name}: ${e.message}`); }
            }
            status.textContent = '';
            const up = files.length - failed.length;
            const msg = [
                up ? `${Tn('{n} file', '{n} files', up)} uploaded` + (fails.length || warns.length ? ` (${[passed ? `${n0(passed)} passed` : '', warns.length ? T('{count} with warnings: {v}', { count: n0(warns.length), v: warns.join(', ') }) : '', fails.length ? T('{count} failing the check: {v}', { count: n0(fails.length), v: fails.join(', ') }) : ''].filter(Boolean).join('; ')})` : ', all passed the check') : '',
                failed.length ? `${Tn('{n} upload', '{n} uploads', failed.length)} failed: ${failed.join('; ')}` : '',
            ].filter(Boolean).join('. ') + '.';
            toast(msg, failed.length || fails.length || warns.length ? 'err' : 'ok');
            renderBranding();
        });
        if (items.some((x) => !x.check)) pending = true;
        return h('div', { class: 'card brand-card' },
            h('div', { class: 'head' }, h('h2', {}, title), h('span', { class: 'muted small' }, `${Tn('{n} file', '{n} files', items.length)} · ${ids}`)),
            h('p', { class: 'muted small spec' }, note),
            h('label', { class: 'btn small file-btn brand-up', tabindex: 0, role: 'button' }, T('Upload…'), input), status,
            h('div', { class: 'brand-list' }, ...(items.length ? items.map((x) => {
                const pic = ['video', 'still', 'logo'].includes(kind) ? h('img', { src: brandThumbUrl(x.rel, Math.round(x.mtime)), loading: 'lazy', alt: '', onerror: (e) => e.target.replaceWith(h('div', { class: 'noimg' })) }) : h('div', { class: 'noimg' });
                const c = x.check;
                const acts = [];
                if (type === 'slate' && !d.set) {
                    acts.push(h('button', { class: 'btn ghost small', onclick: () => useBrand(x, 'offair', 'off-air slate') }, T('Use as off-air')));
                    acts.push(h('button', { class: 'btn ghost small', onclick: () => useBrand(x, 'live', 'live-standby slate') }, T('Use as live standby')));
                }
                if (type === 'logo' && !d.set) acts.push(h('button', { class: 'btn ghost small', onclick: () => useBrand(x, 'logo', 'channel logo') }, T('Use as channel logo')));
                if (kind === 'video') acts.push(h('button', { class: 'btn ghost small', onclick: () => playLocal(x.source) }, T('Play in VLC')));
                acts.push(h('button', { class: 'btn ghost small', onclick: () => removeBrand(x) }, T('Remove')));
                return h('div', { class: 'brand-row' }, pic, h('div', {},
                    h('div', { class: 'name' }, x.name, ' ', brandCheckBadge(x)),
                    h('div', { class: 'muted small' }, brandInfoLine(x)),
                    c && (c.errors.length || c.warnings.length) ? h('ul', { class: 'small' }, ...c.errors.map((t) => h('li', { class: 'bad' }, t)), ...c.warnings.map((t) => h('li', { class: 'warn' }, t))) : null,
                    h('div', { class: 'acts' }, ...acts)));
            }) : [h('div', { class: 'muted small' }, T('No files yet.'))])));
    }));
    if (pending && !$('#view-branding').hidden) renderBranding.t = setTimeout(renderBranding, 4000);
}
async function useBrand(x, as, label) {
    if (!(await confirmModal(T('Use as {label}?', { label }), T('{name} replaces the current {label}. The current file is kept with a date in its name.{v}', { name: x.name, label, v: as === 'logo' ? '' : T(' It shows the next time the slate plays.') }), { ok: T('Use it') }))) return;
    try { await localJson('POST', '/local/branding/use', { rel: x.rel, as }); toast(T('{name} is now the {label}.', { name: x.name, label }), 'ok'); }
    catch (e) { toast(e.message, 'err'); }
}
async function removeBrand(x) {
    const aside = x.rel.startsWith('_sets/') ? `storage\\branding\\_removed\\_sets\\${x.rel.split('/')[1]}` : 'storage\\branding\\_removed';
    if (!(await confirmModal(T('Remove this file?'), T('{name} is moved to {aside} and is no longer used by the playlist rules. Saved playlists that already contain it keep playing it.', { name: x.name, aside }), { ok: T('Remove') }))) return;
    try { await localJson('POST', '/local/branding/remove', { rel: x.rel }); toast(T('Removed.'), 'ok'); renderBranding(); }
    catch (e) { toast(e.message, 'err'); }
}
$('#brand-set').addEventListener('change', (e) => { setBrandSet(e.target.value); renderBranding(); });
$('#brand-set-new').addEventListener('click', async () => {
    const input = h('input', { maxlength: 40, placeholder: T('e.g. Memorial Day'), dir: 'auto', autocomplete: 'off' });
    const asked = confirmModal(T('New branding set'), [
        T('A set holds its own idents, stingers, countdowns and so on for occasion days. On a day that uses the set, a type with no files in it gets no branding (the Default set is not used instead).'),
        h('label', {}, T('Name (letters, digits, spaces, - and _)'), input)], { ok: T('Create set') });
    setTimeout(() => input.focus(), 50);
    if (!(await asked)) return;
    try {
        const r = await localJson('POST', '/local/branding/sets', { name: input.value.trim() });
        setBrandSet(r.name);
        toast(T('Branding set “{name}” created. Upload its files below.', { name: bidiText(r.name) }), 'ok');
        renderBranding();
    } catch (err) { toast(err.message, 'err'); }
});
$('#brand-rules').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = f.elements.explicit_after.value.trim();
    // HH:MM (or H:MM), 00:00–23:59; empty = any time.
    const hmMin = (x) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || '').trim()); return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? Number(m[1]) * 60 + Number(m[2]) : null; };
    if (v && hmMin(v) === null) return toast(T('Explicit clips time must be HH:MM between 00:00 and 23:59, e.g. 22:00.'), 'err');
    const body = {};
    for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    try {
        const r = await localJson('PUT', '/local/branding/rules', body);
        const got = String(r.explicit_after ?? '').trim();
        f.elements.explicit_after.value = got;
        if ((v ? hmMin(v) : null) !== (got ? hmMin(got) : null)) toast(T('Saved, but the server stored “{v}” for explicit clips instead of “{v2}”. Check the time and save again.', { v: got || 'any time', v2: v || 'any time' }), 'err');
        else toast(T('Branding rules saved. They apply to playlists built from now on.'), 'ok');
    } catch (err) { toast(err.message, 'err'); }
});
$('#brand-live').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const bl = {};
    for (const el of f.elements) if (el.name) bl[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    try { await localJson('PUT', '/local/automation', { branding_live: bl }); toast(T('Live text saved. It applies from the next clip.'), 'ok'); }
    catch (err) { toast(err.message, 'err'); }
});

