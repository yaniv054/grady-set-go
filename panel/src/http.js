// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const R = require('./registry');

// --- proxy ----------------------------------------------------------------

// Process commands (start/stop/restart) are the one proxied body the panel looks at: the
// command is recorded for resume-after-boot once ffplayout has accepted it. Bodies of all
// other proxied calls (sign-in, outputs with stream keys) are passed through untouched.
const PROCESS_ROUTE = /^\/api\/control\/\d+\/process$/;
function proxy(req, res, body = null) {
    const pathname = req.url.split('?')[0];
    if (body === null && req.method === 'POST' && PROCESS_ROUTE.test(pathname)) {
        R.core.readBody(req, 4096).then((text) => proxy(req, res, text)).catch((e) => { R.core.log(req, e.status || 400); R.core.send(res, e.status || 400, { detail: e.message }); });
        return;
    }
    let command = null;
    if (body !== null) { try { command = String(JSON.parse(body).command || ''); } catch { /* not JSON: ffplayout answers */ } }
    const headers = { ...req.headers, host: R.core.UPSTREAM.host };
    delete headers.origin;
    delete headers.referer;
    if (body !== null) { headers['content-length'] = String(Buffer.byteLength(body)); delete headers['transfer-encoding']; }
    const up = http.request(
        { hostname: R.core.UPSTREAM.hostname, port: R.core.UPSTREAM.port, path: req.url, method: req.method, headers },
        (ur) => {
            if (command && ur.statusCode >= 200 && ur.statusCode < 300) R.system.recordProcessCommand(command);
            res.writeHead(ur.statusCode, ur.headers);
            ur.on('error', () => res.destroy());
            if (command === 'status' && ur.statusCode === 200) {
                // The status answer is tiny ("active"/"stopped"): read it on the way through.
                const chunks = [];
                ur.on('data', (c) => { if (chunks.length < 4) chunks.push(c); });
                ur.on('end', () => { try { R.system.noteProcessStatus(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* not JSON */ } });
            }
            ur.pipe(res);
            R.core.log(req, ur.statusCode);
        },
    );
    // The browser went away before the reply finished: stop the upstream request too.
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) { clientGone = true; up.destroy(); } });
    up.on('error', () => {
        if (clientGone) return;
        R.core.log(req, 502);
        if (!res.headersSent) R.core.send(res, 502, { detail: 'ffplayout is not reachable on ' + R.core.UPSTREAM.origin });
        else res.end();
    });
    if (body !== null) up.end(body);
    else req.pipe(up);
}

// --- server ---------------------------------------------------------------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${R.core.PORT}`, `localhost:${R.core.PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    // Only answer requests addressed to this panel (blocks DNS-rebinding pages), and
    // accept non-GET local calls only with a JSON (or, for uploads, octet-stream) body and
    // no foreign Origin (blocks other websites posting to 127.0.0.1 in the background).
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) { R.core.log(req, 421); return R.core.send(res, 421, { detail: 'wrong host' }); }
    if (pathname.startsWith('/local/') && req.method !== 'GET') {
        const origin = req.headers.origin;
        // JSON for everything, except raw-byte uploads (documents, logo, branding files). Both
        // content types make a cross-site browser request preflight, which this server never answers.
        const ctype = String(req.headers['content-type'] || '');
        const json = /^application\/json\b/i.test(ctype) || (['/local/meta/docs', '/local/logo', '/local/branding/upload', '/local/appbrand/logo'].includes(pathname) && req.method === 'POST' && /^application\/octet-stream\b/i.test(ctype));
        if ((origin && !ALLOWED_ORIGINS.has(origin)) || !json) { R.core.log(req, 403); return R.core.send(res, 403, { detail: 'forbidden' }); }
    }
    // The same rule for calls passed on to ffplayout: a page on another origin may not
    // post to it through this panel (sign-in attempts, playlist writes, process control).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) { R.core.log(req, 403); return R.core.send(res, 403, { detail: 'forbidden' }); }
    try {
        if (R.core.PROXY_PREFIXES.some((p) => pathname.startsWith(p))) return proxy(req, res);
        await R.undo.undoBegin(req, res, pathname);
        if (pathname.startsWith('/local/capture/')) {
            const q = new URL(req.url, 'http://x').searchParams;
            const op = `${req.method} ${pathname.slice(15)}`;
            let r;
            if (op === 'GET devices') r = await R.capture.captureDevices(q.get('refresh') === '1');
            else if (op === 'GET options') r = await R.capture.captureOptions(String(q.get('video') || ''));
            else if (op === 'POST preview/start') r = await R.capture.previewStart(await R.core.parseJsonBody(req));
            else if (op === 'POST preview/stop') r = await R.capture.previewStop('stopped');
            else if (op === 'POST preview/touch') { if (R.capture.cap.preview) R.capture.cap.preview.touched = Date.now(); r = R.capture.previewState(); }
            else if (op === 'GET preview') r = R.capture.previewState();
            else if (op === 'GET preview.jpg') {
                if (R.capture.cap.preview) R.capture.cap.preview.polled = Date.now();
                if (!fs.existsSync(R.capture.PREVIEW_JPG)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'no picture yet' }); }
                R.core.log(req, 200);
                return R.core.send(res, 200, fs.readFileSync(R.capture.PREVIEW_JPG), 'image/jpeg');
            }
            else if (op === 'POST start') r = await R.capture.bridgeStart(await R.core.parseJsonBody(req, 64 * 1024));
            else if (op === 'POST stop') r = await R.capture.bridgeStop(await R.core.parseJsonBody(req));
            else if (op === 'GET status') r = R.capture.bridgeState();
            else { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'not found' }); }
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/undo' && req.method === 'GET') { const r = R.undo.undoList(new URL(req.url, 'http://x').searchParams); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/undo' && req.method === 'POST') { const b = await R.core.parseJsonBody(req); const r = await R.undo.undoApply(String(b.id || ''), { confirm: b.confirm }); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/undo/playlist' && req.method === 'POST') { const r = R.undo.undoPlaylist(await R.core.parseJsonBody(req, 64 * 1024), res); R.core.log(req, 200); return R.core.send(res, 200, r); }

        // Interface languages: list and catalogs (public like the UI itself; they hold no secrets).
        if (req.method === 'GET' && pathname === '/brand.json') { R.core.log(req, 200); return R.core.send(res, 200, R.appbrand.publicInfo()); }
        if (req.method === 'GET' && /^\/brand\/logo\/(sidebar|signin)$/.test(pathname)) {
            if (R.appbrand.sendLogo(res, pathname.split('/')[3])) { R.core.log(req, 200); return; }
            R.core.log(req, 404); return R.core.send(res, 404, { detail: 'no logo' });
        }
        if (pathname === '/local/appbrand' && req.method === 'PUT') { await R.system.requireAdmin(req); const r = R.appbrand.writeSettings(await R.core.parseJsonBody(req)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/appbrand/logo' && req.method === 'POST') {
            await R.system.requireAdmin(req);
            const slot = new URL(req.url, 'http://x').searchParams.get('slot');
            const r = await R.appbrand.saveLogo(req, slot); R.core.log(req, 200); return R.core.send(res, 200, r);
        }
        if (pathname === '/local/appbrand/reset' && req.method === 'POST') { await R.system.requireAdmin(req); const b = await R.core.parseJsonBody(req); const r = R.appbrand.resetLogo(String(b.slot || '')); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (req.method === 'GET' && pathname === '/about.json') { R.core.log(req, 200); return R.core.send(res, 200, { name: 'Grady Set Go - Playout App', version: R.core.cfg.version, root: path.resolve(__dirname, '..', '..'), feedback_email: R.core.cfg.feedbackEmail, feedback_send: !!R.core.cfg.feedbackEndpoint }); }
        if (req.method === 'GET' && pathname === '/locales/index.json') { R.core.log(req, 200); return R.core.send(res, 200, R.locales.listLocales()); }
        if (req.method === 'GET' && /^\/locales\/[a-z0-9-]+\.json$/.test(pathname)) {
            const l = R.locales.readLocale(pathname.slice(9, -5));
            if (!l) return R.core.send(res, 404, { detail: 'unknown language' });
            R.core.log(req, 200);
            return R.core.send(res, 200, l);
        }
        // UI scripts: /ui/<name>.js from panel/ui (index.html loads them in file-name order).
        if (req.method === 'GET' && /^\/ui\/[A-Za-z0-9-]+\.js$/.test(pathname)) {
            const file = path.join(R.core.ROOT, 'ui', pathname.slice(4));
            if (!fs.existsSync(file)) return R.core.send(res, 404, { detail: 'not found' });
            R.core.log(req, 200);
            return R.core.send(res, 200, fs.readFileSync(file), 'text/javascript; charset=utf-8');
        }
        if (req.method === 'GET' && R.core.STATIC[pathname]) {
            const [file, type] = R.core.STATIC[pathname];
            R.core.log(req, 200);
            return R.core.send(res, 200, fs.readFileSync(path.join(R.core.ROOT, file)), type);
        }

        if (pathname === '/local/state') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, R.library.readState()); }
            if (req.method === 'PUT') {
                const clean = R.library.sanitiseState(await R.core.parseJsonBody(req));
                R.core.writeJsonAtomic(R.core.STATE_FILE, clean, 2);
                R.core.log(req, 200);
                return R.core.send(res, 200, clean);
            }
        }

        if (pathname === '/local/media/browse' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const r = await R.media.browseMedia(q.get('path') || '', R.media.extFilter(q.get('ext')));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/media/count' && req.method === 'POST') {
            const r = R.media.countSelection((await R.core.parseJsonBody(req, 1024 * 1024)));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/preview/clean' && req.method === 'POST') {
            const r = await R.core.cleanPreview();
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/attention' && req.method === 'GET') {
            // "On air soon": clips in saved playlists from today to 6 days ahead, and the clip on air now.
            const q = new URL(req.url, 'http://x').searchParams;
            R.songs.noteDayStart(q.get('ds'));
            const r = { ...R.attention.attentionReport(), soon: R.songs.soonClips(), today: R.songs.broadcastToday(), on_air_id: R.songs.onAirId(q.get('onair')) };
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/attention/count' && req.method === 'GET') { const c = R.attention.attentionReport().counts; R.core.log(req, 200); return R.core.send(res, 200, c); }
        if (pathname.startsWith('/local/attention/') && req.method === 'POST') {
            const op = { hide: R.attention.hideFiles, unhide: R.attention.unhideFiles, accept: R.attention.acceptItems, unaccept: R.attention.unacceptItems, types: R.attention.setHiddenTypes }[pathname.slice(17)];
            if (!op) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'not found' }); }
            const r = op((await R.core.parseJsonBody(req, 4 * 1024 * 1024)));
            R.core.log(req, 200);
            return R.core.send(res, 200, { ...r, counts: R.attention.attentionReport().counts });
        }
        if (pathname === '/local/songs' && req.method === 'GET') { const r = R.songs.songsList(new URL(req.url, 'http://x').searchParams); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (/^\/local\/songs\/c[0-9a-f]{15}$/.test(pathname) && req.method === 'GET') {
            const r = R.songs.songsClip(pathname.slice(13), new URL(req.url, 'http://x').searchParams.get('lines') === '1');
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/songs/update' && req.method === 'POST') { const r = await R.songs.songUpdate(await R.core.parseJsonBody(req, 256 * 1024)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/songs/lookup' && req.method === 'POST') { const r = await R.songs.songLookup(await R.core.parseJsonBody(req)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/songs/detect' && req.method === 'POST') { const r = await R.songs.songDetect(await R.core.parseJsonBody(req)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/reveal' && req.method === 'POST') {
            const r = R.attention.revealFile((await R.core.parseJsonBody(req)).path);
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/play' && req.method === 'POST') {
            const b = await R.core.parseJsonBody(req);
            const r = R.media.playInVlc(b.path, b.start, b.stop);
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/media/formats' && req.method === 'GET') {
            R.core.log(req, 200);
            return R.core.send(res, 200, R.media.formatCounts());
        }

        if (pathname === '/local/media/probe' && req.method === 'GET') {
            // Starts ffprobe on the share: the panel's own pages only.
            const site = req.headers['sec-fetch-site'];
            if (site && site !== 'same-origin' && site !== 'none') { R.core.log(req, 403); return R.core.send(res, 403, { detail: 'forbidden' }); }
            const full = R.media.mediaPath(new URL(req.url, 'http://x').searchParams.get('path') || '');
            if (!R.core.VIDEO_EXT.has(path.extname(full).toLowerCase())) { R.core.log(req, 400); return R.core.send(res, 400, { detail: 'not a video file' }); }
            await R.media.probeLimited(full);
            R.core.log(req, 200);
            return R.core.send(res, 200, { path: full, ...R.media.fileInfo(full) });
        }

        if (pathname === '/local/media/generate' && req.method === 'POST') {
            const r = await R.media.generateFromMedia((await R.core.parseJsonBody(req, 4 * 1024 * 1024)));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/meta/list' && req.method === 'GET') {
            const r = R.metadata.listClips(new URL(req.url, 'http://x').searchParams);
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/meta/clip' && req.method === 'PUT') {
            const { id, fields } = (await R.core.parseJsonBody(req));
            if (!R.media.libraryById().has(id)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'unknown clip id' }); }
            const changed = R.metadata.applyFields(id, R.metadata.cleanFields(fields || {}));
            if (changed) R.metadata.saveMeta();
            R.core.log(req, 200);
            return R.core.send(res, 200, { changed, clip: R.metadata.clipView(id, R.media.libraryById().get(id), R.metadata.today()) });
        }

        if (pathname === '/local/meta/bulk' && req.method === 'PUT') {
            const { ids, fields } = (await R.core.parseJsonBody(req, 1024 * 1024));
            const clean = R.metadata.cleanFields(fields || {});
            if (!Object.keys(clean).length) { R.core.log(req, 400); return R.core.send(res, 400, { detail: 'no fields' }); }
            const known = (Array.isArray(ids) ? ids : []).filter((id) => R.media.libraryById().has(id));
            let changed = 0;
            R.metadata.loadMeta();
            for (const id of known) if (R.metadata.applyFields(id, clean)) changed++;
            if (changed) {
                R.metadata.backupMeta('before-bulk');
                R.metadata.saveMeta();
            }
            R.core.log(req, 200);
            return R.core.send(res, 200, { matched: known.length, changed });
        }

        if (pathname === '/local/meta/export' && req.method === 'GET') {
            const csv = R.metadata.exportCsv();
            R.core.log(req, 200);
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="clip-metadata-${R.metadata.today()}.csv"`, 'Cache-Control': 'no-store' });
            return res.end(csv);
        }

        if (pathname === '/local/meta/import' && req.method === 'POST') {
            const { csv, dry_run } = (await R.core.parseJsonBody(req, 32 * 1024 * 1024));
            const r = R.metadata.importCsv(csv, dry_run !== false);
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/meta/docs') {
            const q = new URL(req.url, 'http://x').searchParams;
            const id = q.get('id');
            if (req.method === 'GET') { R.librarytools.docDir(id); const r = R.librarytools.listDocs(id); R.core.log(req, 200); return R.core.send(res, 200, { docs: r }); }
            if (req.method === 'POST') {
                if (!R.media.libraryById().has(id)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'unknown clip id' }); }
                const r = await R.librarytools.saveDoc(req, id, q.get('name'));
                R.core.log(req, 200);
                return R.core.send(res, 200, { saved: r, docs: R.librarytools.listDocs(id) });
            }
            if (req.method === 'PUT') {
                const { name } = (await R.core.parseJsonBody(req));
                const r = R.librarytools.removeDoc(id, name);
                R.undo.undoFiles(res, { moves: [{ from: path.join(R.librarytools.docDir(id), name), to: r.moved_to }] });
                R.core.log(req, 200);
                return R.core.send(res, 200, { ...r, docs: R.librarytools.listDocs(id) });
            }
        }

        if (pathname === '/local/meta/doc' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const dir = R.librarytools.docDir(q.get('id'));
            const name = path.basename(String(q.get('name') || ''));
            const ext = path.extname(name).toLowerCase();
            const file = path.join(dir, name);
            if (name !== q.get('name') || !R.core.DOC_TYPES[ext] || !fs.existsSync(file)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'document not found' }); }
            R.core.log(req, 200);
            res.writeHead(200, {
                'Content-Type': R.core.DOC_TYPES[ext], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
                'Content-Disposition': `${R.core.DOC_INLINE.has(ext) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
            });
            // A read error mid-stream (file locked or removed) must not become an uncaught
            // exception that ends the panel: the connection is dropped instead.
            const stream = fs.createReadStream(file);
            stream.on('error', (e) => { console.error('document read', e.message); res.destroy(); });
            res.on('close', () => stream.destroy());
            return stream.pipe(res);
        }

        // Newer release known? (administrators only see the badge)
        if (pathname === '/local/update' && req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, require('./updatecheck').state()); }

        // Feedback: the panel posts the message itself to the configured relay (https only, short timeout).
        if (pathname === '/local/feedback' && req.method === 'POST') {
            const url = R.core.cfg.feedbackEndpoint;
            if (!/^https:\/\//i.test(url || '')) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'No feedback endpoint is configured.' }); }
            const j = await R.core.parseJsonBody(req, 16 * 1024);
            const payload = JSON.stringify({ app: 'Grady Set Go - Playout App', version: R.core.cfg.version, kind: String(j.kind || '').slice(0, 20), message: String(j.message || '').slice(0, 8000), info: String(j.info || '').slice(0, 2000), website: '' });
            if (!payload || !String(j.message || '').trim()) { R.core.log(req, 400); return R.core.send(res, 400, { detail: 'The message is empty.' }); }
            try {
                const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
                const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: ctl.signal }); clearTimeout(t);
                if (!r.ok) throw new Error(`the server answered ${r.status}`);
            } catch (e) { R.core.log(req, 502); return R.core.send(res, 502, { detail: `Could not send: ${e.name === 'AbortError' ? 'no answer within 10 seconds' : e.message}` }); }
            R.core.log(req, 200); return R.core.send(res, 200, { ok: true });
        }

        if (pathname === '/local/library/rescan') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, { ...R.librarytools.scan, library_empty: R.media.library().size === 0 }); }
            if (req.method === 'POST') { const r = R.librarytools.startScan(); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }

        // Thumbnails (not logged: a page shows many). By clip ID, or by playlist source
        // path (channel images in storage are shown as they are).
        const thumbM = /^\/local\/thumb\/(c[0-9a-f]{15})\.jpg$/.exec(pathname);
        if (thumbM && req.method === 'GET') {
            const file = path.join(R.core.THUMB_DIR, `${thumbM[1]}.jpg`);
            if (!fs.existsSync(file)) return R.core.send(res, 404, { detail: 'no thumbnail' });
            return R.attention.sendImage(req, res, file, 'image/jpeg');
        }
        if (pathname === '/local/thumb' && req.method === 'GET') {
            const src = String(new URL(req.url, 'http://x').searchParams.get('path') || '');
            const ext = path.extname(src).toLowerCase();
            if (R.asrun.STORAGE_KIND(src) && R.attention.IMAGE_TYPES[ext]) {
                const full = path.resolve(src);
                if (full.toLowerCase().startsWith(R.core.STORAGE_ROOT.toLowerCase() + path.sep) && fs.existsSync(full)) return R.attention.sendImage(req, res, full, R.attention.IMAGE_TYPES[ext]);
                return R.core.send(res, 404, { detail: 'image not found' });
            }
            const id = R.media.idForPath(src);
            const file = id && path.join(R.core.THUMB_DIR, `${id}.jpg`);
            if (!file || !fs.existsSync(file)) return R.core.send(res, 404, { detail: 'no thumbnail' });
            return R.attention.sendImage(req, res, file, 'image/jpeg');
        }
        if (pathname === '/local/thumb' && req.method === 'POST') {
            const { id } = (await R.core.parseJsonBody(req));
            if (!/^c[0-9a-f]{15}$/.test(String(id))) { R.core.log(req, 400); return R.core.send(res, 400, { detail: 'bad clip id' }); }
            let r;
            try { r = await R.attention.makeThumb(id); } catch (e) { throw Object.assign(new Error(`Thumbnail failed: ${String(e.message || e).slice(0, 200)}`), { status: e.status || 422 }); }
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/playlists/resolve' && req.method === 'POST') {
            const { sources } = (await R.core.parseJsonBody(req, 4 * 1024 * 1024));
            R.core.log(req, 200);
            return R.core.send(res, 200, R.media.resolveSources(sources));
        }

        if (pathname === '/local/analysis' && req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, R.analysis.analysisStatus()); }
        if (pathname === '/local/analysis/plan' && req.method === 'POST') {
            const r = R.analysis.analysisPlan((await R.core.parseJsonBody(req, 4 * 1024 * 1024)));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/analysis/start' && req.method === 'POST') {
            const r = R.analysis.startAnalysis((await R.core.parseJsonBody(req, 4 * 1024 * 1024)));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/analysis/stop' && req.method === 'POST') {
            fs.mkdirSync(R.core.ANALYSIS_DIR, { recursive: true });
            fs.writeFileSync(R.core.ANALYSIS_STOP, new Date().toISOString());
            R.core.log(req, 200);
            return R.core.send(res, 200, { stop_requested: true });
        }
        if (pathname === '/local/analysis/clip' && req.method === 'GET') {
            const id = new URL(req.url, 'http://x').searchParams.get('id');
            if (!R.media.libraryById().has(id)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'unknown clip id' }); }
            R.core.log(req, 200);
            return R.core.send(res, 200, R.analysis.analysisDetail(id));
        }
        if (pathname === '/local/analysis/apply' && req.method === 'POST') {
            const { ids, fields } = (await R.core.parseJsonBody(req, 1024 * 1024));
            const r = R.attention.applySuggestions(ids, fields);
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/asrun' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const from = R.metadata.normDate(q.get('from') || q.get('date')) || R.metadata.today();
            const to = R.metadata.normDate(q.get('to') || q.get('date')) || from;
            const rows = R.asrun.asrunRange(from, to).map(R.asrun.asrunView);
            R.core.log(req, 200);
            return R.core.send(res, 200, { from, to, rows });
        }

        if (pathname === '/local/branding' && req.method === 'GET') {
            const set = R.branding.requireBrandSet(String(new URL(req.url, 'http://x').searchParams.get('set') || ''));
            R.core.log(req, 200);
            return R.core.send(res, 200, R.branding.listBranding(set));
        }
        if (pathname === '/local/branding/sets') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, { sets: R.branding.listBrandSets() }); }
            if (req.method === 'POST') { const r = R.branding.createBrandSet((await R.core.parseJsonBody(req)).name); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        if (pathname === '/local/branding/upload' && req.method === 'POST') {
            const q = new URL(req.url, 'http://x').searchParams;
            const r = R.undo.takeUndo(res, await R.branding.saveBrandUpload(req, String(q.get('type') || ''), String(q.get('name') || ''), String(q.get('set') || '')));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        // Saved blocks, their placements in saved days, and occasions.
        if (pathname === '/local/blocks') {
            if (req.method === 'GET') {
                const id = new URL(req.url, 'http://x').searchParams.get('id');
                if (id) { const b = R.blocks.getBlock(id); R.core.log(req, 200); return R.core.send(res, 200, { block: b, summary: R.blocks.blockSummary(b) }); }
                const blocks = R.blocks.readBlocks().blocks;
                const names = new Set([...blocks.map((b) => b.occasion), ...R.blocks.readOccasions().occasions.map((o) => o.name)].filter(Boolean));
                R.core.log(req, 200);
                return R.core.send(res, 200, { blocks: blocks.map(R.blocks.blockSummary), occasion_names: [...names].sort() });
            }
            if (req.method === 'POST') { const r = R.blocks.saveBlock((await R.core.parseJsonBody(req, 4 * 1024 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        if (pathname === '/local/blocks/remove' && req.method === 'POST') { const r = R.blocks.removeBlock((await R.core.parseJsonBody(req)).id); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/blocks/used' && req.method === 'POST') { const r = R.blocks.markBlockUsed((await R.core.parseJsonBody(req)).id); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/blocks/check' && req.method === 'POST') { const r = await R.blocks.checkBlocks((await R.core.parseJsonBody(req, 4 * 1024 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/blocks/plan' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const ds = Number(q.get('day_start_s'));
            const r = await R.blocks.blockPlan(R.blocks.checkIsoDate(q.get('date')), Number.isFinite(ds) && ds >= 0 && ds < 86400 ? ds : 0, { requireCleared: q.get('require_cleared') === '1' });
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/blocks/placements') {
            if (req.method === 'GET') { const date = R.blocks.checkIsoDate(new URL(req.url, 'http://x').searchParams.get('date')); R.core.log(req, 200); return R.core.send(res, 200, { date, placements: R.blocks.readPlacements()[date] || [] }); }
            if (req.method === 'POST') { const r = R.blocks.writePlacements((await R.core.parseJsonBody(req, 4 * 1024 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        if (pathname === '/local/blocks/placements/archive' && req.method === 'POST') { const r = R.blocks.archiveDayPlacements((await R.core.parseJsonBody(req))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/blocks/placements/unpin' && req.method === 'POST') { const r = R.blocks.unpinPlacement((await R.core.parseJsonBody(req))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        // Block builder (read-only lookups).
        if (pathname === '/local/builder/search' && req.method === 'GET') { const r = R.builder.builderSearch(new URL(req.url, 'http://x').searchParams); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/builder/info' && req.method === 'POST') { const r = R.builder.builderInfo((await R.core.parseJsonBody(req, 4 * 1024 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/builder/related' && req.method === 'GET') { const r = R.builder.builderRelated(new URL(req.url, 'http://x').searchParams); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/builder/related' && req.method === 'POST') { const r = R.builder.builderRelated((await R.core.parseJsonBody(req, 256 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/builder/fill' && req.method === 'POST') { const r = R.builder.builderFill((await R.core.parseJsonBody(req, 256 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/builder/clip' && req.method === 'GET') {
            const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
            if (!R.media.libraryById().has(id)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'This clip is not in the library.' }); }
            const rows = R.attention.visibleRows(R.media.libraryById().get(id));
            R.core.log(req, 200);
            return R.core.send(res, 200, R.metadata.clipView(id, rows.length ? rows : R.media.libraryById().get(id), R.metadata.today()));
        }
        if (pathname === '/local/occasions') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, { occasions: R.blocks.readOccasions().occasions }); }
            if (req.method === 'POST') { const r = R.blocks.saveOccasion((await R.core.parseJsonBody(req, 512 * 1024))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        if (pathname === '/local/occasions/remove' && req.method === 'POST') { const r = R.blocks.removeOccasion((await R.core.parseJsonBody(req)).id); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/occasions/upcoming' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const days = Math.min(31, Math.max(1, Math.floor(Number(q.get('days')) || 7)));
            const r = R.blocks.upcomingOccasions(R.blocks.checkIsoDate(q.get('from'), 'from'), days);
            R.core.log(req, 200);
            return R.core.send(res, 200, { dates: r });
        }
        if (pathname === '/local/branding/remove' && req.method === 'POST') { const r = R.undo.takeUndo(res, R.branding.removeBrandFile((await R.core.parseJsonBody(req)).rel)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/branding/use' && req.method === 'POST') { const b = (await R.core.parseJsonBody(req)); const r = R.undo.takeUndo(res, R.branding.useBrandFile(b.rel, b.as)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        if (pathname === '/local/branding/thumb' && req.method === 'GET') {
            const t = await R.branding.brandThumb(String(new URL(req.url, 'http://x').searchParams.get('rel') || '')).catch(() => null);
            if (!t) return R.core.send(res, 404, { detail: 'no picture' });
            return R.attention.sendImage(req, res, t.file, t.type);
        }
        if (pathname === '/local/branding/rules') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, R.branding.readBrandRules()); }
            if (req.method === 'PUT') { const r = R.branding.writeBrandRules((await R.core.parseJsonBody(req))); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        if (pathname === '/local/output-health' && req.method === 'GET') {
            return R.core.send(res, 200, R.asrun.outputHealth());
        }
        if (pathname === '/local/asrun/export' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const from = R.metadata.normDate(q.get('from')) || R.metadata.today();
            const to = R.metadata.normDate(q.get('to')) || from;
            const json = q.get('format') === 'json';
            const body = json ? R.asrun.asrunJson(from, to, q.get('all') === '1') : R.asrun.asrunCsv(from, to, q.get('all') === '1');
            R.core.log(req, 200);
            res.writeHead(200, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="as-run-${from}${to !== from ? '_' + to : ''}.${json ? 'json' : 'csv'}"`, 'Cache-Control': 'no-store' });
            return res.end(body);
        }

        if (pathname === '/local/templates') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, { templates: R.metadata.readTemplates() }); }
            if (req.method === 'PUT') { const r = R.metadata.writeTemplates((await R.core.parseJsonBody(req, 256 * 1024)).templates); R.core.log(req, 200); return R.core.send(res, 200, { templates: r }); }
        }

        if (pathname === '/local/meta/lookup' && req.method === 'POST') {
            const { sources } = (await R.core.parseJsonBody(req, 4 * 1024 * 1024));
            const out = {};
            for (const src of Array.isArray(sources) ? sources : []) {
                const row = R.media.library().get(String(src).toLowerCase());
                const m = row ? R.metadata.metaOf(row.id, row) : null;
                out[src] = m ? { title: m.title, performer: m.performer, category: m.category, language: m.language } : null;
            }
            R.core.log(req, 200);
            return R.core.send(res, 200, { items: out });
        }

        if (pathname === '/local/feed' && req.method === 'POST') {
            const r = R.automation.saveFeed((await R.core.parseJsonBody(req, 16 * 1024 * 1024)));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if ((pathname === '/local/feed/schedule.json' || pathname === '/local/feed/schedule.xml') && req.method === 'GET') {
            const file = path.join(R.core.FEED_DIR, path.basename(pathname));
            if (!fs.existsSync(file)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'No schedule exported yet.' }); }
            R.core.log(req, 200);
            return R.core.send(res, 200, fs.readFileSync(file), pathname.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8');
        }

        // Images from ffplayout storage (branding previews). Read-only, images only.
        if (pathname === '/local/storage/image' && req.method === 'GET') {
            const rel = String(new URL(req.url, 'http://x').searchParams.get('path') || '');
            const full = path.resolve(R.core.STORAGE_ROOT, rel.replace(/^[\\/]+/, ''));
            const ext = path.extname(full).toLowerCase();
            if (rel.split(/[\\/]/).includes('..') || !full.toLowerCase().startsWith(R.core.STORAGE_ROOT.toLowerCase() + path.sep) || !R.attention.IMAGE_TYPES[ext] || !fs.existsSync(full)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'image not found' }); }
            R.core.log(req, 200);
            return R.core.send(res, 200, fs.readFileSync(full), R.attention.IMAGE_TYPES[ext]);
        }

        if (pathname === '/local/logo/preview' && req.method === 'GET') {
            const file = path.join(R.core.STORAGE_ROOT, ...R.librarytools.LOGO_REL.split('/'));
            if (!fs.existsSync(file)) { R.core.log(req, 404); return R.core.send(res, 404, { detail: 'no logo' }); }
            R.core.log(req, 200);
            return R.core.send(res, 200, fs.readFileSync(file), 'image/png');
        }

        if (pathname === '/local/logo' && req.method === 'POST') {
            const r = R.undo.takeUndo(res, await R.librarytools.saveLogo(req));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }

        if (pathname === '/local/categories' && req.method === 'GET') {
            R.core.log(req, 200);
            return R.core.send(res, 200, { categories: R.core.cfg.categories });
        }

        // First-run setup: checks are read-only; saving is open only until the panel is configured, then admin only.
        if (pathname === '/local/setup/status' && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const r = await R.setup.status(q.get('check') === '1' ? { media_root: q.get('media_root'), engine_url: q.get('engine_url'), ffprobe: q.get('ffprobe') } : {});
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/setup/browse' && req.method === 'GET') {
            if (R.core.cfg.configured) await R.system.requireAdmin(req);
            const r = R.setup.browse(new URL(req.url, 'http://x').searchParams.get('path') || '');
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/setup/pick-folder' && req.method === 'POST') {
            if (R.core.cfg.configured) await R.system.requireAdmin(req);
            const b = await R.core.parseJsonBody(req, 4 * 1024);
            const r = await R.setup.pickFolder(b.start, b.title);
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/setup/run' && req.method === 'POST') {
            if (R.core.cfg.configured) await R.system.requireAdmin(req);
            const r = await R.setup.runAction(await R.core.parseJsonBody(req, 4 * 1024));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        if (pathname === '/local/setup/save' && req.method === 'POST') {
            if (R.core.cfg.configured) await R.system.requireAdmin(req);
            const r = await R.setup.save(await R.core.parseJsonBody(req, 16 * 1024));
            R.core.log(req, 200);
            R.core.send(res, 200, { saved: r, restarting: true });
            R.setup.respawn();
            return;
        }

        if (pathname === '/local/paths' && req.method === 'GET') {
            R.core.log(req, 200);
            return R.core.send(res, 200, { playlists: R.core.cfg.playlistsDir, public: R.core.cfg.publicRoot, logs: R.core.cfg.logsDir, storage: R.core.cfg.storageRoot, data: R.core.cfg.dataDir, root: R.core.cfg.root, configured: R.core.cfg.configured });
        }

        if (pathname === '/local/system') {
            if (req.method === 'GET') { R.core.log(req, 200); return R.core.send(res, 200, R.system.systemStatus()); }
            if (req.method === 'PUT') { await R.system.requireAdmin(req); const r = R.system.writeSystem(await R.core.parseJsonBody(req)); R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        // Help layer and tutorial switches: any signed-in operator.
        if (pathname === '/local/system/ui' && req.method === 'PUT') {
            const b = await R.core.parseJsonBody(req);
            const r = R.system.writeSystem(Object.fromEntries(R.system.SYSTEM_UI_KEYS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])), { uiOnly: true });
            R.core.log(req, 200);
            return R.core.send(res, 200, Object.fromEntries(R.system.SYSTEM_UI_KEYS.map((k) => [k, r[k]])));
        }
        // Boot script and watchdog (no browser, no token): resume the channel per the settings.
        if (pathname === '/local/system/resume' && req.method === 'POST') {
            const b = await R.core.parseJsonBody(req);
            const r = await R.system.systemResume(String(b.why || 'boot').slice(0, 40));
            R.core.log(req, 200);
            return R.core.send(res, 200, r);
        }
        // Restart the panel (admin): it exits after replying; the boot watchdog starts it again
        // within two minutes. ffplayout, the stream and a capture bridge are not touched.
        if (pathname === '/local/system/restart' && req.method === 'POST') {
            await R.system.requireAdmin(req);
            R.core.lifeLine('restart requested from the System page');
            R.core.log(req, 200);
            R.core.send(res, 200, { restarting: true });
            setTimeout(() => process.exit(0), 300);
            return;
        }
        if (pathname === '/local/automation') {
            if (req.method === 'GET') {
                const sec = R.automation.readSecrets();
                R.core.log(req, 200);
                return R.core.send(res, 200, { ...R.automation.readAutomation(), account: sec ? { username: sec.username } : null, status: R.automation.auto.status, error: R.automation.auto.error, last_text: R.automation.auto.lastText, last_at: R.automation.auto.lastAt });
            }
            if (req.method === 'PUT') { const r = R.automation.writeAutomation((await R.core.parseJsonBody(req))); R.automation.auto.item = null; R.core.log(req, 200); return R.core.send(res, 200, r); }
        }
        if (pathname === '/local/automation/account' && req.method === 'PUT') {
            const { username, password } = (await R.core.parseJsonBody(req));
            const creds = { username: String(username || '').trim(), password: String(password || '') };
            await R.automation.ffLogin(creds); // only stored if ffplayout accepts it
            fs.mkdirSync(R.core.DATA_DIR, { recursive: true });
            fs.writeFileSync(R.core.SECRETS_FILE, JSON.stringify(creds), { encoding: 'utf8', mode: 0o600 });
            R.automation.auto.channelId = null; R.automation.auto.config = null; R.automation.auto.item = null;
            R.core.log(req, 200);
            return R.core.send(res, 200, { account: { username: creds.username } });
        }

        if (pathname === '/local/meta/check' && req.method === 'POST') {
            const { sources, date } = (await R.core.parseJsonBody(req, 4 * 1024 * 1024));
            const r = R.metadata.checkSources(Array.isArray(sources) ? sources : [], R.metadata.normDate(date) || R.metadata.today());
            R.core.log(req, 200);
            return R.core.send(res, 200, { not_cleared: r });
        }

        R.core.log(req, 404);
        R.core.send(res, 404, { detail: 'not found' });
    } catch (e) {
        const status = e.status || (e.code === 'ENOENT' ? 404 : 500);
        R.core.log(req, status);
        if (status === 500) console.error(e);
        R.core.send(res, status, { detail: status === 500 ? 'panel error' : e.message, ...(e.uiCode ? { code: e.uiCode } : {}) });
    }
});

server.listen(R.core.PORT, R.core.HOST, () => {
    console.log(`Grady Set Go on http://${R.core.HOST}:${R.core.PORT}  ->  ffplayout ${R.core.UPSTREAM.origin}`);
    require('./updatecheck').start();
});


// ---- exports (read by the other modules through R.http) ----
R.http = module.exports;
Object.assign(module.exports, { PROCESS_ROUTE, proxy, ALLOWED_HOSTS, ALLOWED_ORIGINS, server });
