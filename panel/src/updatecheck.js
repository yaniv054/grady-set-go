// Grady Set Go - Playout App. Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Looks up the newest published release on GitHub (once at start, then every 24 hours) so the panel can tell an
// administrator that an update exists. Sends nothing about the installation. Fails silently when offline.
// Off with "update_check": "off" in config.json (or PANEL_UPDATE_CHECK=off).
'use strict';
const https = require('https');
const R = require('./registry');

const DAY = 24 * 3600 * 1000;
const st = { current: '', latest: '', available: false, url: '', notes: '', checked: 0, enabled: true };

// "v1.2.3-rc1" -> [1,2,3]; a prerelease suffix sorts below the plain version.
function parse(v) { const m = /^v?(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(String(v || '').trim()); return m ? [+m[1], +m[2], +m[3], m[4] ? 0 : 1] : null; }
function newer(a, b) { const x = parse(a), y = parse(b); if (!x || !y) return false; for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }

function fetchLatest(repo) {
    return new Promise((resolve, reject) => {
        const req = https.get(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'grady-set-go', Accept: 'application/vnd.github+json' }, timeout: 8000 }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; if (body.length > 256 * 1024) req.destroy(new Error('too large')); });
            res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function check() {
    const cfg = R.core.cfg;
    st.current = cfg.version; st.enabled = String(cfg.updateCheck).toLowerCase() !== 'off';
    if (!st.enabled) return;
    try {
        const j = await fetchLatest(cfg.updateRepo);
        const tag = String(j.tag_name || '');
        st.latest = tag.replace(/^v/, ''); st.available = newer(tag, cfg.version);
        st.url = /^https:\/\/github\.com\//.test(j.html_url || '') ? j.html_url : `https://github.com/${cfg.updateRepo}/releases`;
        st.notes = String(j.body || '').slice(0, 4000);
        st.checked = Date.now();
    } catch { st.checked = Date.now(); /* offline or repo not public yet: no badge */ }
}

function start() { check(); setInterval(check, DAY).unref(); }
const state = () => ({ ...st });
module.exports = { start, state, check, newer };
