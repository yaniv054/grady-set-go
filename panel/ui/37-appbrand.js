// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Name, logos and accent colour of the panel (System settings -> Appearance).
'use strict';

const AB = { info: null };

function abInk(hex) {   // black or white text on top of the accent colour
    const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.4 ? '#111' : '#fff';
}
function abApply(info) {
    AB.info = info;
    document.title = info.app_name;
    document.querySelectorAll('.brand-name').forEach((el) => { el.textContent = info.app_name; });
    for (const slot of ['sidebar', 'signin']) {
        const img = document.getElementById(`brand-logo-${slot}`), dot = document.getElementById(slot === 'sidebar' ? 'brand-dot' : 'brand-dot-signin');
        if (!img) continue;
        const has = Boolean(info.logos[slot]);
        if (has) img.src = `/brand/logo/${slot}?v=${info.logos[slot]}`;
        img.hidden = !has;
        if (dot && has) dot.hidden = true; else if (dot) dot.hidden = false;
    }
    const root = document.documentElement.style;
    if (info.accent) { root.setProperty('--accent', info.accent); root.setProperty('--accent-fill', info.accent); root.setProperty('--accent-ink', abInk(info.accent)); }
    else for (const k of ['--accent', '--accent-fill', '--accent-ink']) root.removeProperty(k);
    abFillForm();
}
function abFillForm() {
    const info = AB.info; if (!info || !document.getElementById('ab-name')) return;
    document.getElementById('ab-name').value = info.custom_name || '';
    document.getElementById('ab-name').placeholder = info.default_name;
    document.getElementById('ab-accent').value = info.accent || '#2f6fe0';
    for (const slot of ['sidebar', 'signin']) {
        for (const p of document.querySelectorAll(`img[data-prev="${slot}"]`)) {
            p.hidden = !info.logos[slot];
            if (info.logos[slot]) p.src = `/brand/logo/${slot}?v=${info.logos[slot]}`;
        }
    }
}
async function abLoad() {
    try { const r = await fetch('/brand.json', { cache: 'no-cache' }); if (r.ok) abApply(await r.json()); } catch { /* defaults stay */ }
}
abLoad();

// Looks at a chosen logo before it is saved and returns a warning text (or '') about size and colour.
async function abCheckLogo(file) {
    try {
        const url = URL.createObjectURL(file);
        const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
        URL.revokeObjectURL(url);
        const w = img.naturalWidth, hh = img.naturalHeight;
        const notes = [];
        if (hh && w / hh < 1.2) notes.push(T('The picture is nearly square or tall; it will be small. A wide picture works better.'));
        if (hh && hh < 36) notes.push(T('The picture is only {h} pixels high and will look soft.', { h: hh }));
        const c = document.createElement('canvas'); const k = Math.min(1, 64 / Math.max(w, hh)); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hh * k));
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
        const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0, lum = 0, opaque = 0;
        for (let i = 0; i < d.length; i += 4) { opaque += d[i + 3] > 200 ? 1 : 0; if (d[i + 3] > 40) { n++; lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; } }
        if (n) {
            const avg = lum / n;
            if (opaque / (d.length / 4) < 0.97 && avg < 40) notes.push(T('The logo is almost black and will not show on the dark theme. Check the previews.'));
            else if (opaque / (d.length / 4) < 0.97 && avg > 225) notes.push(T('The logo is almost white and will not show on the light theme. Check the previews.'));
        }
        return notes.join(' ');
    } catch { return ''; }
}

(function wire() {
    const msg = (text, ok) => { const m = document.getElementById('ab-msg'); m.className = 'form-msg ' + (ok ? 'ok' : 'err'); m.textContent = text; };
    let accentChanged = false;
    const acc = document.getElementById('ab-accent');
    acc.addEventListener('input', () => { accentChanged = true; });
    // Closing the colour popup (a click outside it) keeps the colour; the field then leaves focus so the popup does not reopen.
    acc.addEventListener('change', () => acc.blur());
    document.getElementById('ab-accent-reset').addEventListener('click', () => { accentChanged = false; document.getElementById('ab-accent').value = '#2f6fe0'; document.getElementById('ab-accent').dataset.reset = '1'; });
    document.getElementById('ab-save').addEventListener('click', async () => {
        const accent = document.getElementById('ab-accent');
        const body = { app_name: document.getElementById('ab-name').value };
        if (accentChanged) body.accent = accent.value; else if (accent.dataset.reset) body.accent = '';
        try { abApply(await api('PUT', '/local/appbrand', body)); accent.dataset.reset = ''; accentChanged = false; msg(T('Saved.'), true); } catch (e) { msg(e.message, false); }
    });
    for (const slot of ['sidebar', 'signin']) {
        document.getElementById(`ab-file-${slot}`).addEventListener('change', async (e) => {
            const file = e.target.files[0]; e.target.value = '';
            if (!file) return;
            const hint = await abCheckLogo(file);
            try { abApply(await api('POST', `/local/appbrand/logo?slot=${slot}`, file)); msg(hint ? T('Logo saved.') + ' ' + hint : T('Logo saved.'), !hint); } catch (err) { msg(err.message, false); }
        });
        document.getElementById(`ab-reset-${slot}`).addEventListener('click', async () => {
            try { abApply(await api('POST', '/local/appbrand/reset', { slot })); msg(T('Default logo restored.'), true); } catch (err) { msg(err.message, false); }
        });
    }
})();
