// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
// Grady Set Go - Playout App: front end. Talks to ffplayout through the local proxy.
//
// Stream-key rules enforced here:
//  * a stored stream_url is never written to the DOM; only maskUrl() output is
//  * key inputs are never prefilled and are cleared right after Apply
//  * profile settings saved to /local/state never include the URL path/key

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
};

const S = {
    channelId: null,
    channel: null,
    config: null,
    outputs: [],
    codecs: null,
    local: null,
    user: null,
    process: '',
    current: null,
    playlist: null,
    plDirty: false,
    browsePath: '',
    unlockedProd: false,
};

// ---------------------------------------------------------------- utilities

const pad = (n) => String(n).padStart(2, '0');
function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
function parseHms(s) {
    const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}
function clockOf(sec) { return fmtDur(((sec % 86400) + 86400) % 86400); }
const baseName = (p) => String(p).split(/[\\/]/).pop();
// Mixed Hebrew/English paths and file names: each path part and the file extension are
// isolated so the parts keep their order (Unicode isolate marks, invisible).
const bidiText = (t) => String(t ?? '').split(/([\\/])/).map((seg) => (/^[\\/]$/.test(seg) || !seg ? seg : `\u2068${seg.replace(/(\.[A-Za-z0-9]{2,4})$/, '\u2069\u2066$1\u2069\u2068')}\u2069`)).join('');
const dirName = (p) => { const parts = String(p).split(/[\\/]/); parts.pop(); return parts.pop() || ''; };
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Date display follows the interface language (order and separator; see 00-i18n.js), e.g.
// dd/mm/yy, mm/dd/yy or yyyy/mm/dd. Internally (and towards ffplayout) dates stay YYYY-MM-DD.
function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    const L = dateLayout();
    const part = { y: L.yearDigits === 4 ? m[1] : m[1].slice(2), m: m[2], d: m[3] };
    return L.order.split('').map((c) => part[c]).join(L.sep);
}
const fmtDates = (list) => list.map(fmtDate).join(', ');
// Server timestamps are UTC ISO strings: shown in local time (date, then 24-hour HH:MM).
function fmtStamp(iso) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return fmtDate(iso);
    const d = new Date(iso);
    return iso && !Number.isNaN(d.getTime()) ? `${fmtDate(isoDate(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}` : String(iso || '');
}
function fmtDay(iso) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return fmtDate(iso);
    const d = new Date(iso);
    return iso && !Number.isNaN(d.getTime()) ? fmtDate(isoDate(d)) : String(iso || '');
}
// "1 clip", "2 clips" (plural forms and digit grouping follow the language). Kept for old call sites:
// new code calls Tn('{n} clip', '{n} clips', n) so the text can be translated.
const plural = (n, one, many) => Tn(`{n} ${one}`, `{n} ${many}`, n);
// Weekday names in the interface language (index 0 = Sunday); WEEKDAY[i] keeps working.
const WEEKDAY = new Proxy([], { get: (_, i) => (/^[0-6]$/.test(String(i)) ? weekdayName(Number(i)) : undefined) });
// Accepts the language's order (d/m/yy, dd/mm/yyyy, m/d/yy, yyyy/mm/dd; separators / . -) and always YYYY-MM-DD.
function parseDate(s) {
    s = String(s || '').trim();
    let m, y, mo, d;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [, y, mo, d] = m;
    else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s)) && dateLayout().order !== 'ymd') {
        if (dateLayout().order === 'mdy') [, mo, d, y] = m; else [, d, mo, y] = m;
        if (y.length === 2) y = '20' + y;
    } else if ((m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(s))) [, y, mo, d] = m;
    else if ((m = /^(\d{2})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(s)) && dateLayout().order === 'ymd') { [, y, mo, d] = m; y = '20' + y; }
    else return null;
    const iso = `${y}-${pad(mo)}-${pad(d)}`;
    const t = new Date(iso + 'T12:00:00');
    return !Number.isNaN(t.getTime()) && isoDate(t) === iso ? iso : null;
}

// Each .date-native input keeps the YYYY-MM-DD value the code reads and writes;
// its .date-txt sibling shows and accepts dd/mm/yy. Writes to .value (from code)
// update the text automatically; typing a valid date updates the native input and
// fires its 'change' event; the 📅 button opens the native picker.
const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
function bindDateField(native) {
    const txt = document.querySelector(`.date-txt[data-for="${native.id}"]`);
    const btn = document.querySelector(`.date-pick[data-for="${native.id}"]`);
    if (!txt) return;
    Object.defineProperty(native, 'value', {
        get() { return NATIVE_VALUE.get.call(this); },
        set(v) { NATIVE_VALUE.set.call(this, v); txt.value = fmtDate(v); txt.classList.remove('bad'); },
    });
    const commit = (fire) => {
        const v = txt.value.trim();
        const iso = v ? parseDate(v) : '';
        if (iso === null) { txt.classList.add('bad'); return false; }
        txt.classList.remove('bad');
        if (iso !== native.value) { NATIVE_VALUE.set.call(native, iso); if (fire) native.dispatchEvent(new Event('change')); }
        return true;
    };
    // Inside a form (clip editor) keep the native value current while typing, so a
    // submit with Enter sees it. Elsewhere the value is committed on Enter/blur and
    // fires 'change' once (which reloads the playlist or log).
    if (native.form) txt.addEventListener('input', () => { if (txt.value.trim() === '' || parseDate(txt.value)) commit(false); });
    txt.addEventListener('change', () => { if (!commit(true)) { toast(T('Use the date format {format}.', { format: dateHint() }), 'err'); txt.value = fmtDate(native.value); txt.classList.remove('bad'); } else txt.value = fmtDate(native.value); });
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && native.form == null) { e.preventDefault(); txt.dispatchEvent(new Event('change')); } });
    native.addEventListener('change', () => { txt.value = fmtDate(native.value); txt.classList.remove('bad'); });
    if (btn) btn.addEventListener('click', () => { try { native.showPicker(); } catch { txt.focus(); } });
    txt.value = fmtDate(native.value);
}
document.querySelectorAll('.date-native').forEach(bindDateField);

function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDate(d); }

// Hide everything after the RTMP application name (i.e. the stream key).
function maskUrl(u) {
    if (!u) return '';
    return String(u).replace(/^(\w+:\/\/[^/]+\/[^/]+\/)(.+)$/, (_, a) => a + '••••••••');
}
function hasYoutubeKey(u) { return /^rtmps?:\/\/[^/]*youtube\.com\/live2\/.+/i.test(u || ''); }
function maskText(t) {
    return String(t).replace(/(rtmps?:\/\/[^/\s]+\/[^/\s]+\/)[^\s"'<]+/gi, '$1••••••••')
        .replace(/(live2\/)[^\s"'<]+/gi, '$1••••••••');
}

function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + kind;
    t.hidden = false;
    // The action just recorded for undo: an Undo button for 15 s.
    // Only while no newer change request was sent since (else the toast is about something else).
    const u = kind !== 'err' && S.undoPending && Date.now() - S.undoPending.at < 3000 && S.undoPending.mut === S.mutSeq ? S.undoPending : null;
    if (u) {
        S.undoPending = null;
        t.append(' ', h('button', { class: 'btn small undo-btn', onclick: () => runUndo(u.id, u.label) }, T('Undo')));
    }
    // A popover sits in the top layer, above open modal dialogs. Re-showing it moves it
    // above a dialog opened since. Without the Popover API it is a plain fixed element.
    if (t.showPopover) { try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch { /* not supported */ } }
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { try { if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); } catch { /* ignore */ } t.hidden = true; }, u ? 15000 : kind === 'err' ? 7000 : 3500);
}

