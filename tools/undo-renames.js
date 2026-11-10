// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// undo-renames — RETIRED (2026-11-01).
//
// The media share is read-only by policy; nothing renames files there any more, so there
// is nothing new to undo. Renames made by earlier runs are still recorded in
// C:\Playout\data\analysis\renames.jsonl (the panel reads it to find moved files).
// The original tool is kept in tools\_legacy\undo-renames.js. Running it would write to
// the share: do not run it without an explicit decision to do so.
'use strict';
console.error('undo-renames is retired: the media share is read-only. See tools\\_legacy\\undo-renames.js and data\\analysis\\renames.jsonl.');
process.exit(1);
