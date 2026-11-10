// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Contextual help layer and the first-steps tutorial.
// Loaded after the UI scripts (uses $, $$, h, S, localJson, toast, route and T from them).
//
// Help layer: when on, small "?" markers sit next to the main controls and page titles;
// click or hover one for a short explanation. Tutorial: a guided tour of the basic
// operations with a spotlight on each control. Both switches are kept in System settings
// (data\system.json: help_layer, tutorial_on_start) so they follow the installation, not
// the browser. The tutorial runs once per browser session when "show at start" is on.
'use strict';

const HELP_TOPICS = i18nLazy([
    // [selector, title, text]. Only elements that exist in index.html (not list rows).
    ['#view-dashboard h1', N_('Dashboard'), N_('The channel at a glance: engine state, active output, what is on air, and the process controls. Every Start, Stop and Restart from here is recorded for resume after a reboot.')],
    ['[data-process="start"]', N_('Start / Restart / Stop'), N_('Controls the playout engine. Restart is needed after some settings changes (the page says so). Stopping a stream asks first; going on air on PRODUCTION requires typing PRODUCTION.')],
    ['[data-control="reset"]', N_('Reset to schedule'), N_('Jumps to the item the clock says should be on air now, after Back/Next or a live show.')],
    ['#view-outputs h1', N_('Outputs & keys'), N_('One output is live at a time: local preview, YouTube TEST, YouTube PRODUCTION or a custom stream. Keys go straight to ffplayout and are never stored here.')],
    ['#view-program h1', N_('Program'), N_('One broadcast day at a time. Edit rows, set start times (double-click a time), insert saved blocks, generate or fill days. Nothing is written until Save.')],
    ['#pl-date', N_('Broadcast day'), N_('The day being edited. ◀ ▶ move a day; the calendar picks one. The day runs from the day start set on Channel & schedule (e.g. 06:00 to 06:00).')],
    ['#pl-save', N_('Save'), N_('Writes this day to the engine. Asks first when the day is short (filler loops), too long (last rows cut), in the past, has uncleared rights, or is on air right now.')],
    ['#pl-delete', N_('Delete'), N_('Removes the saved playlist for this day; the filler then plays. On the day on air it requires typing DELETE.')],
    ['#pl-builder', N_('Open in builder'), N_('The same day in the two-pane block builder, with search, drag and drop, trims and undo.')],
    ['#gen-run', N_('Generate'), N_('Builds the whole day from the ticked folders or a template, with the options above. Replaces the rows in the editor; press Save to keep it.')],
    ['#fill-run', N_('Fill empty days'), N_('Generates and saves playlists for N days ahead, only for days that have none. Pinned blocks and occasions keep their times.')],
    ['#view-library h1', N_('Library'), N_('Every clip on the share with its metadata (titles, rights, categories, documents) and the overnight analysis. Nothing on the share is changed; metadata lives on this PC.')],
    ['#an-start', N_('Overnight analysis'), N_('Checks audio, video, metadata, thumbnails and (optionally) timed text at low priority. "Clean titles" stores cleaned-up titles as metadata; files are never renamed.')],
    ['#view-asrun h1', 'As-run', N_('What actually aired, from the engine log, joined with clip details. Export a day or month as CSV, or a day as JSON, for royalty reports.')],
    ['#view-channel h1', N_('Channel & schedule'), N_('Channel settings, the broadcast day (start and length), filler, logo, loudness, the automation account and lower thirds.')],
    ['#auto-account-save', N_('Automation account'), N_('A separate ffplayout user the panel uses without a browser: lower thirds, and resuming the channel after a reboot. Needed for resume to work.')],
    ['#view-live h1', N_('Live input'), N_('Listeners for live sources: when one connects it takes over the playout; when it stops the schedule resumes. A camera on this PC can be sent to a listener from here.')],
    ['#view-branding h1', N_('Channel branding'), N_('Idents, stingers, openers, closers, up-next backgrounds and the off-air slate, per set. Rules decide what Generate inserts. Files are checked against the kit spec on upload.')],
    ['#view-attention h1', N_('Needs attention'), N_('Files that need a decision: problems from the analysis, identical copies, odd shapes. Hide takes a file out of the system; nothing on the share is changed.')],
    ['#view-hidden h1', N_('Hidden media'), N_('Files and file types hidden from the Library, Generate, the browser and the analysis. Unhide here.')],
    ['#view-system h1', N_('System settings'), N_('Decisions for the whole installation: what happens after a reboot, the help layer and the tutorial. Administrators only.')],
    ['#sys-resume', N_('Test resume now'), N_('Runs the resume decision exactly as the boot script does. It starts the channel only if it is stopped and the settings and last recorded state say so.')],
    ['#view-logs h1', N_('Logs'), N_('The engine log, by level and date.')],
    ['#undo-open', N_('Undo'), N_('Recent one-click changes (metadata, blocks, branding files, saved playlists) can be put back from here.')],
    ['#help-toggle', N_('Help layer'), N_('Shows or hides the ? markers. The switch is also in System settings.')],
]);

const TOUR_STEPS = i18nLazy([
    { view: 'dashboard', sel: '.cards3', title: N_('The channel at a glance'), text: N_('Engine state, active output and what is on air. This is the page to leave open during the day.') },
    { view: 'dashboard', sel: '[data-process="start"]', title: N_('Start, Restart, Stop'), text: N_('The engine process. Restart applies settings changes with a short interruption. Stopping a stream asks first.') },
    { view: 'outputs', sel: '#view-outputs h1', title: N_('Outputs & keys'), text: N_('Choose the live output: local preview for checking, YouTube TEST, or PRODUCTION. Stream keys are sent straight to the engine and never stored.') },
    { view: 'program', sel: '#pl-date', title: N_('Pick the broadcast day'), text: N_('The Program page edits one day at a time. Use the arrows or the calendar. The day starts at the time set on Channel & schedule.') },
    { view: 'program', sel: '#pl-table', title: N_('The playlist'), text: N_('Rows play back to back. Tick rows to move or remove them, double-click a start time to set it, and watch the summary line for gaps or overruns.') },
    { view: 'program', sel: '#gen-run', title: N_('Generate a day'), text: N_('Tick folders in the media list (or pick a template), set the options, Generate. Review the result, then Save.') },
    { view: 'program', sel: '#fill-run', title: N_('Keep days ahead filled'), text: N_('Fill creates and saves playlists for the next N days that have none. Run it once a week.') },
    { view: 'program', sel: '#pl-save', title: N_('Save'), text: N_('Nothing reaches the engine until Save. The panel warns about short or long days, rights, and changes to the day on air.') },
    { view: 'library', sel: '#view-library h1', title: N_('Library'), text: N_('Titles, performers, rights and documents for every clip, plus the overnight analysis. Metadata is kept on this PC; the share is never changed.') },
    { view: null, sel: '.nav-attn', title: N_('Needs attention'), text: N_('New problems and duplicates land here. Decide, then they stay out of the way.') },
    { view: null, sel: '#help-toggle', title: N_('Help when you need it'), text: N_('Turn the help layer on for ? markers next to the main controls. The tutorial can be run again from System settings.') },
]);

const HELPS = { on: false, tutorialOnStart: true, loaded: false, pop: null, tour: null };

// ---- help layer ----
function helpInit() {
    localJson('GET', '/local/system').then((r) => {
        HELPS.loaded = true;
        HELPS.tutorialOnStart = r.settings.tutorial_on_start !== false;
        setHelpLayer(!!r.settings.help_layer, false);
        let shown = false;
        try { shown = sessionStorage.getItem('cr_tour_shown') === '1'; } catch { /* no storage */ }
        if (HELPS.tutorialOnStart && !shown) setTimeout(startTour, 600);
    }).catch(() => { helpRefresh(); });
}
function setHelpLayer(on, persist = true) {
    HELPS.on = !!on;
    document.body.classList.toggle('help-on', HELPS.on);
    const t = $('#help-toggle');
    if (t) { t.classList.toggle('on', HELPS.on); t.setAttribute('aria-pressed', String(HELPS.on)); t.title = HELPS.on ? T('Help layer is on: click to hide the ? markers') : T('Show ? markers with short explanations'); }
    if (!HELPS.on) helpHide();
    helpRefresh();
    if (persist) localJson('PUT', '/local/system/ui', { help_layer: HELPS.on }).catch((e) => toast(e.message, 'err'));
}
// Markers live in a fixed layer and are placed over their control's box (top-right
// corner; next to the text for headings), so the page layout never moves when help is on.
function helpRefresh() {
    let layer = $('#help-marks');
    if (!layer) { layer = h('div', { id: 'help-marks' }); document.body.append(layer); }
    layer.replaceChildren();
    clearInterval(HELPS.timer); HELPS.timer = null;
    if (!HELPS.on) return;
    HELPS.marks = [];
    for (const [sel, title, text] of HELP_TOPICS) {
        const el = $(sel);
        if (!el) continue;
        const mark = h('button', { class: 'hq', type: 'button', 'aria-label': T('Help: {title}', { title }), onclick: (e) => { e.preventDefault(); e.stopPropagation(); helpShow(mark, title, text); }, onmouseenter: () => helpShow(mark, title, text, true), onfocus: () => helpShow(mark, title, text, true) }, '?');
        layer.append(mark);
        HELPS.marks.push({ el, mark, heading: /^h[12]$/i.test(el.tagName) });
    }
    helpPlace();
    HELPS.timer = setInterval(helpPlace, 500);
    window.addEventListener('scroll', helpPlace, true);
    window.addEventListener('resize', helpPlace);
}
function helpPlace() {
    for (const m of HELPS.marks || []) {
        const vis = m.el.isConnected && !m.el.closest('[hidden]') && m.el.offsetParent;
        m.mark.hidden = !vis;
        if (!vis) continue;
        const r = m.el.getBoundingClientRect();
        if (m.heading) {
            // After the heading text (the box may be wider than the text).
            const range = document.createRange(); range.selectNodeContents(m.el);
            const tr = range.getBoundingClientRect();
            m.mark.style.left = `${(tr.width ? tr.right : r.right) + 8}px`; m.mark.style.top = `${r.top + r.height / 2 - 9}px`;
        } else { m.mark.style.left = `${r.right - 9}px`; m.mark.style.top = `${r.top - 9}px`; }
    }
}
function helpShow(mark, title, text, soft = false) {
    let pop = HELPS.pop;
    if (!pop) {
        pop = HELPS.pop = h('div', { class: 'help-pop', role: 'dialog', 'aria-live': 'polite' });
        document.body.append(pop);
        document.addEventListener('click', (e) => { if (!pop.contains(e.target) && !e.target.classList?.contains('hq')) helpHide(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') helpHide(); });
        window.addEventListener('scroll', helpHide, true);
    }
    pop.replaceChildren(h('b', {}, title), h('p', {}, text), soft ? null : h('button', { class: 'btn ghost small', onclick: helpHide }, T('Got it')));
    pop.hidden = false;
    pop.classList.toggle('soft', soft);
    const r = mark.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 8;
    pop.style.width = `${w}px`; pop.style.left = `${Math.max(12, left)}px`; pop.style.top = `${top}px`;
    const ph = pop.offsetHeight;
    if (top + ph > window.innerHeight - 12) pop.style.top = `${Math.max(12, r.top - ph - 8)}px`;
    if (soft) { mark.addEventListener('mouseleave', helpHide, { once: true }); mark.addEventListener('blur', helpHide, { once: true }); }
}
function helpHide() { if (HELPS.pop) HELPS.pop.hidden = true; }

// ---- tutorial ----
function startTour() {
    if (HELPS.tour) return;
    try { sessionStorage.setItem('cr_tour_shown', '1'); } catch { /* no storage */ }
    const steps = TOUR_STEPS.filter((s) => !s.view || VIEWS.includes(s.view));
    const t = HELPS.tour = { i: -1, steps, from: location.hash };
    t.spot = h('div', { class: 'tour-spot' });
    t.card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
    t.root = h('div', { class: 'tour' }, t.spot, t.card);
    document.body.append(t.root);
    document.body.classList.add('tour-on');
    // Enter is left to the focused Next/Done button (handling it here as well would advance twice).
    t.onKey = (e) => { if (e.key === 'Escape') endTour(); else if (e.key === 'ArrowRight') tourGo(1); else if (e.key === 'ArrowLeft') tourGo(-1); };
    t.onMove = () => tourPlace();
    document.addEventListener('keydown', t.onKey);
    window.addEventListener('resize', t.onMove);
    window.addEventListener('scroll', t.onMove, true);
    tourGo(1);
}
async function tourGo(d) {
    const t = HELPS.tour;
    if (!t) return;
    let i = t.i + d;
    while (i >= 0 && i < t.steps.length) {
        const s = t.steps[i];
        if (s.view && location.hash.slice(1) !== s.view) { location.hash = s.view; await new Promise((r) => setTimeout(r, 350)); }
        if (HELPS.tour !== t) return; // Skip or Esc while the page was changing
        const el = $(s.sel);
        if (el && el.offsetParent) { t.i = i; t.el = el; break; }
        i += d; // a control that is not on screen for this user is skipped
    }
    if (i < 0) { t.i = -1; return tourGo(1); }
    if (i >= t.steps.length) return endTour(true);
    if (HELPS.tour !== t) return;
    t.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tourDraw();
    setTimeout(tourPlace, 400);
}
function tourDraw() {
    const t = HELPS.tour, s = t.steps[t.i];
    const last = t.i === t.steps.length - 1;
    t.card.replaceChildren(
        h('div', { class: 'tour-step' }, T('Tutorial · step {v} of {count}', { v: t.i + 1, count: t.steps.length })),
        h('h2', { id: 'tour-title' }, s.title),
        h('p', {}, s.text),
        h('label', { class: 'check small tour-again' }, h('input', { type: 'checkbox', checked: HELPS.tutorialOnStart, onchange: (e) => setTutorialOnStart(e.target.checked) }), T('Show this tutorial next time the system starts')),
        h('div', { class: 'tour-btns' },
            h('button', { class: 'btn ghost small', onclick: () => endTour() }, T('Skip')),
            h('span', { class: 'grow' }),
            t.i > 0 ? h('button', { class: 'btn ghost small', onclick: () => tourGo(-1) }, T('Back')) : null,
            h('button', { class: 'btn primary small', onclick: () => (last ? endTour(true) : tourGo(1)), autofocus: true }, last ? T('Done') : T('Next'))),
    );
    tourPlace();
    const btn = t.card.querySelector('.btn.primary'); if (btn) btn.focus();
}
function tourPlace() {
    const t = HELPS.tour;
    if (!t || !t.el) return;
    const r = t.el.getBoundingClientRect(), pad = 8;
    Object.assign(t.spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const cw = Math.min(360, window.innerWidth - 24), ch = t.card.offsetHeight || 180;
    let left = r.left, top = r.bottom + pad + 12;
    if (top + ch > window.innerHeight - 12) top = r.top - ch - pad - 12;
    if (top < 12) { top = Math.max(12, Math.min(r.top, window.innerHeight - ch - 12)); left = r.right + pad + 12; }
    if (left + cw > window.innerWidth - 12) left = Math.max(12, window.innerWidth - cw - 12);
    Object.assign(t.card.style, { width: `${cw}px`, left: `${left}px`, top: `${top}px` });
}
function endTour(done = false) {
    const t = HELPS.tour;
    if (!t) return;
    document.removeEventListener('keydown', t.onKey);
    window.removeEventListener('resize', t.onMove);
    window.removeEventListener('scroll', t.onMove, true);
    t.root.remove();
    document.body.classList.remove('tour-on');
    HELPS.tour = null;
    if (done) toast(T('Tutorial finished. It can be run again from System settings.'), 'ok');
}
function setTutorialOnStart(on, persist = true) {
    HELPS.tutorialOnStart = !!on;
    const c = $('#sys-tutorial'); if (c) c.checked = HELPS.tutorialOnStart;
    if (persist) localJson('PUT', '/local/system/ui', { tutorial_on_start: HELPS.tutorialOnStart }).catch((e) => toast(e.message, 'err'));
}

// ---- wiring ----
$('#help-toggle')?.addEventListener('click', () => setHelpLayer(!HELPS.on));
$('#help-tour')?.addEventListener('click', (e) => { e.preventDefault(); startTour(); });
$('#sys-help')?.addEventListener('change', (e) => setHelpLayer(e.target.checked));
$('#sys-tutorial')?.addEventListener('change', (e) => setTutorialOnStart(e.target.checked));
$('#sys-tour-now')?.addEventListener('click', () => { location.hash = 'dashboard'; setTimeout(startTour, 300); });
// Called by app.js after each page change, and by the System page after loading the settings.
function helpOnRoute() { helpHide(); setTimeout(helpRefresh, 50); }
function helpSyncSystem(settings) {
    const hc = $('#sys-help'), tc = $('#sys-tutorial');
    if (hc) hc.checked = !!settings.help_layer;
    if (tc) tc.checked = settings.tutorial_on_start !== false;
}
