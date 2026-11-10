// Grady Set Go - Playout App
// Created by Yaniv Grady. Copyright (c) 2026 Yaniv Grady. MIT License (see LICENSE).
// Change file name — REMOVED (2026-11-01).
//
// The media folder is read-only by policy: no tool renames,
// moves, writes or deletes anything on it. The cleaned-up title from the Metadata check
// is stored as clip metadata instead (panel: Overnight analysis > "Clean titles";
// stored in C:\Playout\data\clip-metadata.json).
//
// This module stays so that nothing which still lists analyzers\*.js breaks, but it has
// no `run`, so deep-scan.js never executes it, and the panel refuses "rename" in --checks.
// The original is kept in tools\_legacy\rename.js for reference only.
'use strict';

module.exports = {
    id: 'rename',
    version: 1,
    label: 'Change file name (removed: the share is read-only)',
    optIn: true,
    removed: true,
};
