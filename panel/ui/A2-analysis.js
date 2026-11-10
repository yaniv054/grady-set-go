// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// UI script part A2-analysis. All UI scripts share one global scope and load in the order of the file names (see index.html).
'use strict';
// ---- overnight analysis ----
const FLAG_INFO = i18nLazy({
    combed: [N_('Combed'), 'bad', N_('Interlace combing in the picture (file flagged progressive)')],
    silent: [N_('Silent'), 'bad', N_('No audible sound')], no_audio: [N_('No audio'), 'bad'], no_video: [N_('No video'), 'bad'],
    one_channel: [N_('One channel'), 'bad', N_('Sound on one side only')], check_failed: [N_('Check failed'), 'bad', 'ffmpeg could not read the file'],
    clipping: [N_('Clipping'), 'warn', N_('Samples at 0 dBFS')], quiet: [N_('Quiet'), 'warn', N_('Below −30 LUFS')], loud: [N_('Loud'), 'warn', N_('Above −9 LUFS')],
    dual_mono: [N_('Mono'), 'warn', N_('Both channels identical')], phase: [N_('Phase'), 'warn', N_('Channels out of phase')],
    long_silence: [N_('Long silence'), 'warn', '10 s or more of silence inside the clip'],
    head_black: [N_('Black start'), 'info'], tail_black: [N_('Black end'), 'info'], head_silence: [N_('Silent start'), 'info'], tail_silence: [N_('Silent end'), 'info'],
    static: [N_('Static picture'), 'info', N_('The sampled picture does not move (e.g. podcast with a still image)')],
});
function flagBadges(an) {
    if (!an || !an.checked) return h('span', { class: 'muted small' }, '—');
    if (!an.flags.length) return h('span', { class: 'badge on', title: T('Checked: {v}', { v: an.checks.join(', ') }) }, T('OK'));
    return h('span', { class: 'flags' }, ...an.flags.map((f) => {
        const [label, cls, tip] = FLAG_INFO[f] || [f, 'info'];
        return h('span', { class: `badge ${cls}`, title: tip || label }, label);
    }));
}
const fmtSpan = (s) => { s = Math.max(0, Math.round(s || 0)); const hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60); return hh ? `${hh} h ${mm} min` : `${mm} min`; };
const REASON = { complete: 'finished', stopped: 'stopped', until: 'reached the stop time', error: 'failed', 'ended unexpectedly': 'ended unexpectedly' };
async function pollAnalysis() {
    clearTimeout(pollAnalysis.t);
    let r;
    try { r = await localJson('GET', '/local/analysis'); } catch {
        // Keep polling (slower) while the Library is open or a run was going on.
        if (!$('#view-library').hidden || pollAnalysis.wasRunning) pollAnalysis.t = setTimeout(pollAnalysis, 15000);
        return;
    }
    const st = r.status;
    const running = !!st?.running;
    const state = $('#an-state');
    state.textContent = running ? (r.stop_requested ? T('Stopping…') : T('Running')) : T('Idle');
    state.className = 'badge' + (running ? ' on' : '');
    $('#an-start').disabled = running;
    $('#an-stop').disabled = !running || r.stop_requested;
    const bar = $('#an-progress');
    if (running) {
        bar.hidden = false;
        bar.firstElementChild.style.width = `${st.total ? Math.round((st.done / st.total) * 100) : 0}%`;
        $('#an-line').textContent = T('{count} of {count2} checked this run', { count: n0(st.done), count2: Tn('{n} clip', '{n} clips', st.total) }) + (st.failed ? ` · ${Tn('{n} error', '{n} errors', st.failed)}` : '') + (st.renamed ? T(' · {count} renamed', { count: Tn('{n} file', '{n} files', st.renamed) }) : '') +
            (st.eta_s ? T(' · about {span} left', { span: fmtSpan(st.eta_s) }) : '') + (st.until ? T(' · stops at {until}', { until: st.until }) : '') + T(' · {count} of {count2} analysed in total', { count: n0(r.checked), count2: Tn('{n} clip', '{n} clips', r.clips) });
        $('#an-current').textContent = (st.current || []).map((p) => `▶ ${p}`).join('\n');
    } else {
        bar.hidden = true;
        $('#an-current').textContent = '';
        const last = st?.finished ? `Last run ${fmtStamp(st.finished)}: ${n0(st.done)} of ${Tn('{n} clip', '{n} clips', st.total)} checked${st.renamed ? T(', {count} renamed', { count: Tn('{n} file', '{n} files', st.renamed) }) : ''}, ${REASON[st.reason] || st.reason}${st.error ? ` (${st.error})` : ''}. ` : T('Not run yet. ');
        $('#an-line').textContent = last + `${n0(r.checked)} of ${Tn('{n} clip', '{n} clips', r.clips)} analysed; ${n0(r.clips - r.checked)} not checked yet.`;
    }
    if (running || !$('#view-library').hidden) pollAnalysis.t = setTimeout(pollAnalysis, running ? 5000 : 30000);
    if (pollAnalysis.wasRunning && !running) { loadLib(); updatePlan(); }
    pollAnalysis.wasRunning = running;
}
// Checks and mode chosen in the Overnight analysis card (also used by the bulk action).
const AN_CHECKS = ['audio', 'video', 'meta', 'thumb', 'transcript'];
const CHECK_LABEL = i18nLazy({ audio: N_('Audio'), video: N_('Video'), meta: N_('Metadata'), thumb: N_('Thumbnail'), transcript: N_('Timed text') });
// Clean titles is not a check of its own: it applies the Metadata check's title to clips
// whose title is still the raw file name, as metadata (the share is read-only).
const cleanTitles = () => $('#an-titles').checked && $('#an-meta').checked;
// Timed text options: whisper threads (remembered in this browser) and the credits lookup.
const TT_KEY = 'pcr.an.threads';
function ttOptions() {
    const on = $('#an-transcript').checked;
    $('#an-tt-opts').hidden = !on;
    const th = Number($('#an-threads').value);
    return on ? { threads: th > 0 ? Math.round(th) : 0, credits: $('#an-credits').checked } : {};
}
try { const v = localStorage.getItem(TT_KEY); if (v) $('#an-threads').value = v; } catch { /* no storage */ }
$('#an-threads').addEventListener('change', () => { try { localStorage.setItem(TT_KEY, $('#an-threads').value); } catch { /* no storage */ } });
$('#an-transcript').addEventListener('change', ttOptions);
const cardChecks = () => AN_CHECKS.filter((k) => $(`#an-${k}`).checked);
const cardMode = () => $('#an-mode').value;
const n0 = (n) => Number(n || 0).toLocaleString('en-US');
const planChecks = (p) => p.checks.filter((c) => p.per[c]).map((c) => `${CHECK_LABEL[c]} ${n0(p.per[c])}`).join(' · ');
const planEstimate = (p) => (p.est_s != null ? `about ${fmtSpan(p.est_s)}` : T('no time estimate yet (each ticked check is timed from now on)'));
const planTitles = (p) => (p.titles && cleanTitles() ? T('Clean titles: {count} {v} the cleaned-up title as metadata when the run ends ({n02} already have a title of their own). Files on the share are not renamed.', { count: n0(p.titles.would), v: p.titles.would === 1 ? 'clip gets' : 'clips get', n02: n0(p.titles.kept) }) : '');
async function updatePlan() {
    const seq = (updatePlan.seq = (updatePlan.seq || 0) + 1);
    const box = $('#an-plan');
    const checks = cardChecks();
    if (!checks.length) { box.textContent = T('Tick at least one check.'); return; }
    box.textContent = T('Counting…');
    let p;
    try { p = await localJson('POST', '/local/analysis/plan', { mode: cardMode(), checks }); } catch (e) { if (seq === updatePlan.seq) box.textContent = ''; return; }
    if (seq !== updatePlan.seq) return;
    if (p.cpu_threads && !$('#an-threads').value) $('#an-threads').placeholder = String(Math.max(1, Math.floor(p.cpu_threads / 2)));
    const tt = p.transcript && !p.transcript.ok ? h('div', { class: 'warn' }, T('Timed text cannot run yet: {why}', { why: p.transcript.why })) : null;
    box.replaceChildren(...(p.clips
        ? [h('b', {}, Tn('This run: {n} clip', 'This run: {n} clips', p.clips)), ` · ${planChecks(p)} · ${planEstimate(p)}`, planTitles(p) ? h('div', {}, planTitles(p)) : null, tt].filter(Boolean)
        : [p.mode === 'new' ? T('Nothing to do: every clip already has the ticked checks. Choose “Everything again” to redo them.') : T('No clips in the library.'), tt].filter(Boolean)));
}
for (const id of ['#an-mode', '#an-titles', ...AN_CHECKS.map((k) => `#an-${k}`)]) $(id).addEventListener('change', () => { updatePlan(); renderBulk(); });

$('#an-start').addEventListener('click', async () => {
    const checks = cardChecks();
    if (!checks.length) return toast(T('Pick at least one check.'), 'err');
    const mode = cardMode();
    const until = $('#an-until').value.trim();
    if (until && !parseHM(until) && until !== '00:00') return toast(T('Stop time must be HH:MM, e.g. 07:00.'), 'err');
    let p;
    try { p = await localJson('POST', '/local/analysis/plan', { mode, checks }); } catch (e) { return toast(e.message, 'err'); }
    if (!p.clips) return toast(T('Nothing to do: every clip already has the ticked checks.'), 'ok');
    if (mode === 'all' && !(await confirmModal(T('Check everything again?'), [T('{count} checked again, including those already analysed: {planChecks}.', { count: plural(p.clips, 'clip is', 'clips are'), planChecks: planChecks(p) }), `${p.est_s != null ? T('Estimated time: about {span}', { span: fmtSpan(p.est_s) }) : T('No time estimate yet')}.`], { ok: T('Start') }))) return;
    try {
        await localJson('POST', '/local/analysis/start', { mode, checks, until, titles: cleanTitles(), ...ttOptions() });
        toast(T('Analysis started: {count}.', { count: plural(p.clips, 'clip', 'clips') }), 'ok');
        setTimeout(pollAnalysis, 1500);
    } catch (e) { toast(e.message, 'err'); }
});
$('#an-stop').addEventListener('click', async () => {
    try { await localJson('POST', '/local/analysis/stop', {}); toast(T('Stopping after the current file…')); pollAnalysis(); }
    catch (e) { toast(e.message, 'err'); }
});

// "Check again now" in the clip editor: runs the analysis for this one clip and
// refreshes the editor when the run ends.
S.clipCheck = null;
$('#meta-an-run').addEventListener('click', async () => {
    const id = S.editing?.id;
    if (!id) return;
    try {
        await localJson('POST', '/local/analysis/start', { ids: [id], mode: 'all', checks: ['audio', 'video', 'meta', 'thumb'] });
    } catch (e) { return toast(e.message, 'err'); }
    S.clipCheck = { id, started: Date.now() };
    $('#meta-an-run').disabled = true;
    $('#meta-an-last').textContent = T('Checking… (audio reads the whole file; long files take a few minutes)');
    const tick = async () => {
        let r;
        try { r = await localJson('GET', '/local/analysis'); } catch { r = null; }
        if (r?.status?.running) { S.clipCheck.t = setTimeout(tick, 3000); return; }
        const done = S.clipCheck;
        S.clipCheck = null;
        if (S.editing?.id === done.id && $('#meta-dlg').open) { await loadClipAnalysis(done.id); showClipThumb(done.id, true); toast(T('Check finished.'), 'ok'); }
        if (!$('#view-library').hidden) loadLib();
    };
    S.clipCheck.t = setTimeout(tick, 2000);
});

async function loadClipAnalysis(id) {
    const box = $('#meta-analysis');
    box.textContent = T('Loading…');
    let d;
    try { d = await localJson('GET', `/local/analysis/clip?id=${encodeURIComponent(id)}`); } catch (e) { box.textContent = e.message; return; }
    if (S.editing?.id !== id) return;
    if (!S.clipCheck || S.clipCheck.id !== id) {
        $('#meta-an-last').textContent = d.last_checked ? T('Last checked {time}', { time: fmtStamp(d.last_checked) }) : T('Not checked yet');
        $('#meta-an-run').disabled = false;
    }
    const a = d.checks.audio?.result, v = d.checks.video?.result, m = d.checks.meta?.result;
    const rn = d.checks.rename?.result;
    if (!a && !v && !m && !Object.keys(d.checks).some((k) => k !== 'thumb' && k !== 'rename')) { box.textContent = T('Not checked yet. Run the overnight analysis from the Library page.'); return; }
    const rows = [];
    const fmt = (x, unit) => (x === null || x === undefined ? '—' : `${x}${unit}`);
    if (a) {
        rows.push([T('Loudness'), T('{fmt} · range {fmt2} · true peak {fmt3}', { fmt: fmt(a.lufs, T(' LUFS')), fmt2: fmt(a.lra, T(' LU')), fmt3: fmt(a.true_peak, ' dBTP') }) + (d.gain_to_minus14 !== null ? T(' · {v}{gain_to_minus14} dB to reach −14 LUFS', { v: d.gain_to_minus14 > 0 ? '+' : '', gain_to_minus14: d.gain_to_minus14 }) : '')]);
        rows.push([T('Channels'), `${a.channels}` + (a.ch_rms?.length ? T(' · levels {v}', { v: a.ch_rms.map((x) => fmt(x, ' dB')).join(' / ') }) : '') + (a.side_db !== null ? ` · L−R ${a.side_db} dB` : '')]);
        if (a.silences?.length) rows.push([T('Silences'), a.silences.map(([s1, s2]) => `${fmtDur(s1)}–${fmtDur(s2)}`).join(', ')]);
    }
    if (v) rows.push([T('Picture'), `combing ${v.combed_ratio === null ? '—' : Math.round(v.combed_ratio * 100) + '%'}` + (v.head_black ? T(' · black start {head_black} s', { head_black: v.head_black }) : '') + (v.tail_black !== null ? T(' · black from {duration}', { duration: fmtDur(v.tail_black) }) : '') + (v.static_s ? T(' · static {static_s} of {sampled_s} s sampled', { static_s: v.static_s, sampled_s: v.sampled_s }) : '')]);
    if (d.trim.in || d.trim.out) rows.push([T('Suggested trim'), `${d.trim.in ? `in ${fmtDur(d.trim.in)}` : ''}${d.trim.in && d.trim.out ? ' · ' : ''}${d.trim.out ? `out ${fmtDur(d.trim.out)}` : ''} (black and silent)`]);
    if (rn?.renamed?.length) rows.push([T('File name'), T('renamed {day} from “{file}”', { day: fmtDay(d.checks.rename.at), file: baseName(rn.renamed[0].from) })]);
    for (const [k, x] of Object.entries(d.checks)) if (x.error) rows.push([`${k} check`, `failed: ${x.error}`]);
    const f = $('#meta-form');
    const sug = (field, value) => value && f[field].value.trim() !== value
        ? h('div', { class: 'an-sug' }, T('Suggested {field}: ', { field }), h('b', {}, value), h('button', { type: 'button', class: 'btn ghost small', onclick: (e) => { f[field].value = value; e.target.parentElement.remove(); } }, T('Use')))
        : null;
    box.replaceChildren(...[
        flagBadges(d.summary),
        rows.length ? h('dl', { class: 'an-grid' }, ...rows.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])) : null,
        m ? sug('title', m.title) : null,
        m ? sug('performer', m.performer) : null,
    ].filter(Boolean));
}

async function loadLib() {
    const seq = (loadLib.seq = (loadLib.seq || 0) + 1);
    let d;
    try { d = await localJson('GET', libQuery()); } catch (e) { return toast(e.message, 'err'); }
    if (seq !== loadLib.seq) return;
    // The page is past the end (e.g. after a filter or bulk change): go to the last page.
    if (d.total && d.offset >= d.total) {
        const last = Math.floor((d.total - 1) / S.lib.limit) * S.lib.limit;
        if (last !== S.lib.offset) { S.lib.offset = last; return loadLib(); }
    }
    S.lib.data = d;
    if (!S.lib.ready) {
        S.lib.ready = true;
        $('#lib-folder').append(...d.folders.map((f) => h('option', { value: f }, f)));
        $('#lib-type').append(...d.types.map((t) => h('option', { value: t.ext }, `${t.ext.toUpperCase()} (${t.clips})`)));
        $('#lib-cat').append(...d.categories.map((c) => h('option', { value: c }, CAT_LABEL[c] || c)));
        d.categories.forEach(ensureCategoryOption);
    }
    const sm = d.summary;
    if (!sm.clips) {
        $('#lib-summary').replaceChildren(h('span', { class: 'warn' }, T('library.csv is empty or missing. Run tools\\scan-library.js first.')));
    } else {
        $('#lib-summary').replaceChildren(...[
            h('span', {}, T('Clips '), h('b', {}, sm.clips), ` · ${sm.hours} h`),
            h('span', { class: 'ok' }, T('Cleared '), h('b', {}, sm.cleared), ` · ${sm.cleared_hours} h`),
            h('span', {}, T('Unknown '), h('b', {}, sm.unknown)),
            sm.blocked ? h('span', { class: 'bad' }, T('Blocked '), h('b', {}, sm.blocked)) : null,
            sm.expired ? h('span', { class: 'warn' }, T('Expired '), h('b', {}, sm.expired)) : null,
            h('span', { class: 'muted' }, T('Analysed '), h('b', {}, sm.checked), T(' of {clips}', { clips: sm.clips })),
            sm.problems ? h('span', { class: 'warn' }, T('Problems '), h('b', {}, sm.problems)) : null,
        ].filter(Boolean));
    }
    const end = Math.min(d.offset + d.rows.length, d.total);
    $('#lib-count').textContent = d.total ? T('{count}–{n02} of {count2}', { count: n0(d.offset + 1), n02: n0(end), count2: plural(d.total, 'clip', 'clips') }) : T('No clips match.');
    $('#lib-prev').disabled = d.offset <= 0;
    $('#lib-next').disabled = end >= d.total;
    const tbody = $('#lib-table tbody');
    tbody.replaceChildren(...(d.rows.length ? d.rows.map((c) => h('tr', {},
        h('td', {}, h('div', { class: 'with-thumb' },
            c.thumb ? h('img', { class: 'thumb', src: `/local/thumb/${c.id}.jpg`, loading: 'lazy', alt: '' }) : h('span', { class: 'thumb none', title: T('No thumbnail yet: made by the analysis or when the clip is opened') }),
            h('div', {}, h('span', { class: 'bidi' }, playLink(c.title, c.path, T('Play in VLC'))), c.explicit === 'yes' ? h('span', { class: 'badge bad expl', title: T('Explicit language') }, 'E') : null,
                c.performer ? h('div', { class: 'sub bidi' }, c.performer) : null,
                c.title !== c.file.replace(/\.[^.]+$/, '') ? h('div', { class: 'sub bidi' }, bidiText(c.file)) : null))),
        h('td', { class: 'muted small' }, bidiText(c.folder), c.hidden ? h('span', { class: 'badge', title: T('Hidden on the Needs attention page') }, T('Hidden')) : null,
            c.hidden_copies && !c.hidden ? h('div', { class: 'sub', title: T('Copies hidden on the Needs attention page') }, Tn('{n} hidden copy', '{n} hidden copies', c.hidden_copies)) : null, c.copies > 1 ? h('div', { class: 'sub', title: T('Identical copies elsewhere on the share share this record{v}', { v: c.size ? T(' ({size} each)', { size: fmtBytes(c.size) }) : '' }) }, Tn('+{n} copy', '+{n} copies', c.copies - 1)) : null),
        h('td', {}, c.ext ? h('span', { class: 'badge ext' }, c.ext) : '', c.aspect && c.aspect !== '16:9' ? h('span', { class: 'badge warn ar', title: `${c.res}${c.aspect === 'sd' ? T(' (SD: 4:3 or 16:9)') : ''}` }, ASPECT_LABEL[c.aspect]) : null,
            c.res ? h('div', { class: 'sub' }, `${c.res.replace('x', '×')}${c.fps ? T(' · {Number} fps', { Number: Number(c.fps.toFixed(2)) }) : ''}`) : null),
        h('td', { class: 'num mono' }, fmtDur(c.duration)),
        h('td', { class: 'small' }, CAT_LABEL[c.category] || ''),
        h('td', {}, rightsBadge(c), c.docs ? h('span', { class: 'doc-badge', title: Tn('{n} release document', '{n} release documents', c.docs) }, `📎 ${c.docs}`) : null),
        h('td', {}, flagBadges(c.an)),
        h('td', { class: 'acts' }, h('button', { class: 'btn ghost small', onclick: () => editClip(c) }, T('Edit'))),
    )) : [h('tr', {}, h('td', { colspan: 8, class: 'empty' }, T('No clips match these filters.')))]));
    renderBulk();
}

function renderBulk() {
    const n = S.lib.data?.total || 0;
    const opts = [
        ['', `For ${n === 1 ? 'the 1 matching clip' : T('all {count} matching clips', { count: n0(n) })}…`],
        ['rights:cleared', T('Set rights: Cleared')], ['rights:blocked', T('Set rights: Blocked')], ['rights:unknown', T('Set rights: Unknown')],
        ...Object.entries(CAT_LABEL).map(([k, v]) => [`category:${k}`, T('Set category: {v}', { v })]), ['category:', T('Clear category')],
        ['explicit:yes', T('Mark: explicit language')], ['explicit:', T('Clear: explicit language')],
        ['suggest:', T('Fill empty title & performer from suggestions')],
        ['analyse:', cardChecks().length
            ? T('Check these clips: {v} ({v2})', { v: cardChecks().map((c) => CHECK_LABEL[c]).join(', '), v2: cardMode() === 'new' ? 'only what is not checked yet' : 'everything again' })
            : T('Check these clips (tick checks in the Overnight analysis card first)')],
    ];
    const sel = $('#lib-bulk');
    const cur = sel.value;
    sel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = cur;
}

let libTimer;
$('#lib-q').addEventListener('input', () => { clearTimeout(libTimer); libTimer = setTimeout(() => { S.lib.offset = 0; loadLib(); }, 250); });
for (const id of ['#lib-folder', '#lib-type', '#lib-rights', '#lib-cat', '#lib-issue', '#lib-aspect', '#lib-explicit']) $(id).addEventListener('change', () => { S.lib.offset = 0; loadLib(); });
// Column headers: each click cycles ascending → descending → unsorted (folder, file order).
function renderSortHeads() {
    $$('#lib-table th[data-sort]').forEach((th) => {
        const on = th.dataset.sort === S.lib.sort;
        th.classList.toggle('sorted', on);
        th.classList.toggle('asc', on && S.lib.dir === 'asc');
        th.classList.toggle('desc', on && S.lib.dir === 'desc');
        th.title = !on ? T('Sort ascending') : S.lib.dir === 'asc' ? T('Sort descending') : T('Remove sorting');
        th.setAttribute('aria-sort', !on ? 'none' : S.lib.dir === 'asc' ? 'ascending' : 'descending');
    });
}
$$('#lib-table th[data-sort]').forEach((th) => {
    th.tabIndex = 0;
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); } });
});
$$('#lib-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (S.lib.sort !== k) { S.lib.sort = k; S.lib.dir = 'asc'; }
    else if (S.lib.dir === 'asc') S.lib.dir = 'desc';
    else { S.lib.sort = ''; S.lib.dir = ''; }
    S.lib.offset = 0;
    renderSortHeads();
    loadLib();
}));
renderSortHeads();
$('#lib-prev').addEventListener('click', () => { S.lib.offset = Math.max(0, S.lib.offset - S.lib.limit); loadLib(); });
$('#lib-next').addEventListener('click', () => { S.lib.offset += S.lib.limit; loadLib(); });

$('#lib-bulk-run').addEventListener('click', async () => {
    const v = $('#lib-bulk').value;
    const d = S.lib.data;
    if (!v || !d?.total) return toast(T('Pick an action first.'), 'err');
    const [field, value] = v.split(':');
    const label = $('#lib-bulk').selectedOptions[0].textContent;
    if (field === 'analyse') {
        const checks = cardChecks(), mode = cardMode();
        if (!checks.length) return toast(T('Tick at least one check in the Overnight analysis card.'), 'err');
        let p;
        try { p = await localJson('POST', '/local/analysis/plan', { mode, checks, ids: d.ids }); } catch (e) { return toast(e.message, 'err'); }
        if (!p.clips) return toast(d.total === 1 ? T('Nothing to do: this clip already has the ticked checks.') : T('Nothing to do: these {count} clips already have the ticked checks.', { count: n0(d.total) }), 'ok');
        const lines = [
            (mode === 'new' ? T('{count} of {total} (all pages of the current filter) still need: {planChecks}.', { count: n0(p.clips), total: Tn('{n} matching clip', '{n} matching clips', d.total), planChecks: planChecks(p) }) : T('{count} of {total} (all pages of the current filter) will get: {planChecks}.', { count: n0(p.clips), total: Tn('{n} matching clip', '{n} matching clips', d.total), planChecks: planChecks(p) })),
            `${p.est_s != null ? T('Estimated time: about {span}', { span: fmtSpan(p.est_s) }) : T('No time estimate yet')}. Progress shows in the Overnight analysis card; Stop works as usual.`,
            ...(planTitles(p) ? [planTitles(p)] : []),
        ];
        if (!(await confirmModal(T('Check these clips now?'), lines, { ok: T('Check {count}', { count: n0(p.clips) }) }))) return;
        try {
            await localJson('POST', '/local/analysis/start', { ids: d.ids, checks, mode, titles: cleanTitles() });
            toast(T('Analysis started for {count}.', { count: plural(p.clips, 'clip', 'clips') }), 'ok');
            $('#lib-bulk').value = '';
            setTimeout(pollAnalysis, 1500);
        } catch (e) { toast(e.message, 'err'); }
        return;
    }
    if (!(await confirmModal(T('Apply to all matching clips?'), T('{label} for {count} (all pages of the current filter, not only this page). A backup of the metadata is kept.', { label, count: plural(d.total, 'clip', 'clips') }), { ok: T('Apply to {count}', { count: n0(d.total) }) }))) return;
    try {
        const r = field === 'suggest'
            ? await localJson('POST', '/local/analysis/apply', { ids: d.ids, fields: ['title', 'performer'] })
            : await localJson('PUT', '/local/meta/bulk', { ids: d.ids, fields: { [field]: value } });
        toast(T('{count} of {count2} changed.', { count: n0(r.changed), count2: plural(r.matched, 'clip', 'clips') }), 'ok');
        $('#lib-bulk').value = '';
        loadLib();
    } catch (e) { toast(e.message, 'err'); }
});

S.editing = null;
function editClip(c) {
    S.editing = c;
    const f = $('#meta-form');
    $('#meta-path').textContent = bidiText(c.path) + (c.copies > 1 ? Tn('  (+{n} identical copy)', '  (+{n} identical copies)', c.copies - 1) : '');
    // Other copies with their size (same content, so the same size: a different size would be a different file).
    $('#meta-copies').replaceChildren(...(c.other_copies || []).map((o) => h('li', {}, h('span', { class: 'bidi' }, bidiText(o.path)), h('span', { class: 'muted attn-size' }, fmtBytes(o.size)))));
    $('#meta-copies').hidden = !(c.other_copies || []).length;
    ensureCategoryOption(c.category);
    for (const k of ['title', 'performer', 'songwriters', 'category', 'rights', 'rights_expires', 'rights_note', 'language', 'tags', 'notes']) f[k].value = c[k] || '';
    f.explicit.checked = c.explicit === 'yes';
    $('#meta-format').textContent = [c.res && c.res.replace('x', '×'), c.aspect && ASPECT_LABEL[c.aspect], c.fps && `${Number(c.fps.toFixed(2))} fps`, c.ext && c.ext.toUpperCase()].filter(Boolean).join(' · ');
    S.docsChanged = false;
    renderDocs([]);
    loadDocs(c.id);
    loadClipAnalysis(c.id);
    $('#meta-songs').textContent = T('Loading…');
    loadClipSongs(c.id);
    showClipThumb(c.id, false, c.thumb);
    $('#meta-dlg').showModal();
    f.title.focus();
}
// Clip editor picture: the saved thumbnail, or one made now (a few seconds).
async function showClipThumb(id, reload, have = true) {
    const img = $('#meta-thumb'), msg = $('#meta-thumb-msg');
    const show = () => { if (S.editing?.id !== id) return; img.onload = () => { img.hidden = false; msg.textContent = ''; }; img.src = `/local/thumb/${id}.jpg?v=${Date.now()}`; };
    img.hidden = true;
    img.onerror = null;
    img.removeAttribute('src');
    if (have || reload) { msg.textContent = ''; img.onerror = () => make(); show(); return; }
    make();
    async function make() {
        img.onerror = null;
        if (S.editing?.id !== id) return;
        msg.textContent = T('Making thumbnail…');
        try { await localJson('POST', '/local/thumb', { id }); } catch (e) { if (S.editing?.id === id) msg.textContent = e.message; return; }
        S.thumbsMade = true;
        img.onerror = () => { if (S.editing?.id === id) msg.textContent = T('No picture'); };
        show();
    }
}
$('#meta-cancel').addEventListener('click', () => $('#meta-dlg').close());
// Text fields follow the direction of what is typed (Hebrew right-to-left, English left-to-right).
$$('#meta-form input:not([type]), #meta-form textarea').forEach((el) => { el.dir = 'auto'; });
// One close handler for the clip editor: refresh the open list only when something changed
// (saved details, documents, a new thumbnail); Cancel without changes re-renders nothing.
$('#meta-dlg').addEventListener('close', () => {
    const changed = S.metaSaved || S.docsChanged || S.thumbsMade;
    S.metaSaved = S.docsChanged = S.thumbsMade = false;
    if (!changed) return;
    if (!$('#view-library').hidden) loadLib();
    if (!$('#view-attention').hidden) renderAttention();
});

