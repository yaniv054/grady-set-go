// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
//
// Local panel for ffplayout. Zero dependencies. Serves the UI and proxies ffplayout's API so
// the browser talks to one origin. Binds to localhost only.
//
// The code lives in src/, one module per area. They share one table (src/registry.js) and are
// loaded in this order, which is also the order their start-up code runs. The last one starts
// the HTTP server.
'use strict';

for (const name of [
    'core',          // settings, atomic file writes, logging, HTTP helpers
    'library',       // library.csv and saved panel state
    'media',         // the read-only media folder: browsing, probing, playlist generation
    'asrun',         // what aired: engine-log import, archive, exports
    'metadata',      // clip metadata, templates
    'librarytools',  // release documents, library rescan, channel logo
    'branding',      // branding kit files
    'blocks',        // saved blocks, placements, occasions
    'builder',       // block builder search and suggestions
    'automation',    // schedule feed and lower thirds
    'analysis',      // overnight analysis jobs
    'attention',     // thumbnails, problem files, copies, hidden files
    'songs',         // songs inside clips and their credits
    'capture',       // capture devices to live input
    'undo',          // undo of panel changes
    'system',        // system settings and boot resume
    'appbrand',      // name, logos and accent colour of the panel
    'setup',         // first-run checks and the setup screen's settings
    'locales',       // interface languages (catalogs)
    'http',          // proxy to ffplayout, routes, server start
]) require('./src/' + name);
