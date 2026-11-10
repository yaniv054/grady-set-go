// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Send feedback (bug, feature request or question). With feedback_endpoint set the panel sends it itself;
// otherwise it opens the e-mail app (feedback_email) or copies the text.
'use strict';

async function openFeedback() {
    let about = { name: 'Grady Set Go - Playout App', version: '', feedback_email: '', feedback_send: false };
    try { const r = await fetch('/about.json', { cache: 'no-cache' }); if (r.ok) about = await r.json(); } catch { /* offline panel: keep defaults */ }
    const kinds = [['bug', T('Bug report')], ['feature', T('Feature request')], ['question', T('Question')], ['other', T('Other')]];
    const kind = h('select', { 'aria-label': T('Type') }, kinds.map(([v, l]) => h('option', { value: v }, l)));
    const text = h('textarea', { rows: 7, placeholder: T('What happened, or what would you like? For a bug: what you did, what you expected, what you saw.') });
    const withInfo = h('input', { type: 'checkbox', checked: true });
    const info = () => [
        `${about.name} ${about.version}`.trim(),
        `${T('Browser')}: ${navigator.userAgent}`,
        `${T('Language')}: ${I18N.lang}`,
        `${T('Screen')}: ${location.hash || '#'}`,
    ].join('\n');
    const preview = h('pre', { class: 'small muted', style: 'white-space:pre-wrap;max-height:8em;overflow:auto' }, info());
    withInfo.addEventListener('change', () => { preview.hidden = !withInfo.checked; });
    const content = [
        h('p', {}, about.feedback_send ? T('Sent directly from the panel. Nothing else is included besides what is listed below.') : about.feedback_email ? T('Opens your e-mail app with a prepared message to {email}. You read it and send it yourself.', { email: about.feedback_email }) : T('No feedback address is set (feedback_email in config.json). The text is copied so you can send it yourself.')),
        h('label', {}, T('Type'), kind), h('label', {}, T('Message'), text),
        h('label', { class: 'check' }, withInfo, ' ', T('Include system information (shown below; no files, paths or passwords)')),
        preview,
    ];
    const ok = await confirmModal(T('Send feedback'), content, { ok: about.feedback_send ? T('Send') : about.feedback_email ? T('Open e-mail') : T('Copy text') });
    if (!ok) return;
    const kindLabel = kinds.find(([v]) => v === kind.value)[1];
    const subject = `[${about.name} ${about.version}] ${kindLabel}`.replace(/\s+/g, ' ');
    const body = `${text.value.trim()}\n\n${withInfo.checked ? '---\n' + info() : ''}`.trim();
    if (about.feedback_send) {
        if (!text.value.trim()) return toast(T('Write a message first.'), 'err');
        try { await api('POST', '/local/feedback', { kind: kind.value, message: text.value.trim(), info: withInfo.checked ? info() : '' }); toast(T('Feedback sent. Thank you.'), 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        return;
    }
    if (about.feedback_email) {
        const url = `mailto:${about.feedback_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        if (url.length < 1900) { location.href = url; return; }
    }
    try { await navigator.clipboard.writeText(`${subject}\n\n${body}`); toast(T('Text copied. Paste it into an e-mail.')); }
    catch { toast(T('Could not copy the text. Select it in the message box and copy it by hand.')); }
}

document.addEventListener('click', (e) => { if (e.target.closest('#feedback-open')) { e.preventDefault(); openFeedback(); } });
