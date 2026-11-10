# Grady Set Go - Playout App: Operator Manual

Grady Set Go is a control panel for the ffplayout playout engine. It adds what the engine
does not have: a program editor with blocks and automatic generation, a media library with
rights and metadata, branding, as-run reporting, live input from a camera, and boot and
resume logic. It runs on Windows and serves its pages to a browser on the same PC.

Created by Yaniv Grady. MIT License (see `LICENSE`).

Manual for version 0.1.x. This is the English master. Translations are named
`MANUAL.<language code>.md`; a page missing in a translation is read in English.

Paths in this manual are relative to the **install folder** (the folder that contains
`panel`, `app`, `data` and `config.json`). The folders can be moved with `config.json`
(see `config.example.json`).

---

## 1. The parts

| Part | What it is | Where |
| --- | --- | --- |
| ffplayout | The playout engine. Plays the daily playlist, streams the output, has its own UI and API. | `app\bin\ffplayout.exe`, UI at http://127.0.0.1:8787 |
| The panel | The program in this manual. One Node.js process without dependencies. Serves the pages and passes API calls on to ffplayout, so the browser talks to one address. | `panel\`, UI at **http://127.0.0.1:8790** |
| Media folder | The programme library: a local drive, a NAS share or a UNC path. **Read-only.** No part of the system writes, renames, moves or deletes anything there. | `media_root` in `config.json` |
| Library | One row per video file in the media folder: path, size, length, codec, loudness. Built by the library scan. | `data\library.csv` |
| Clip metadata | Titles, performers, rights, categories, notes and documents: everything about a clip that is not in the file. Stored on this PC under a fingerprint of the file (size and length), so it survives moving or renaming the file. | `data\clip-metadata.json` |
| Playlists | One JSON file per broadcast day. | `playlists\YYYY\MM\YYYY-MM-DD.json` |
| Storage | ffplayout's own folder: filler, off-air slate, live standby picture, branding, logo. | `storage\` |
| Logs | Engine, panel, boot, capture, scan and analysis logs. | `logs\` |
| Boot script | Starts everything when the PC starts and keeps it running. | `boot-playout.ps1` (scheduled task "Playout boot") |

Both servers listen on 127.0.0.1 only: they can be reached from this PC, not from the
network. The media folder is read-only by **policy** (the code never writes there); the
real enforcement is the permission of the Windows account on the share.

---

## First start on a new PC

The first time the panel opens, and whenever ffplayout cannot be reached, it shows a setup screen instead of the sign-in. It lists Node.js, ffplayout, the media folder, ffprobe, ffmpeg, write access to the data and log folders, and the optional VLC and speech-to-text tools. Each missing item shows what to install and where to get it. The list checks itself again every few seconds, so you can install a program and watch the line turn green.

Enter the media folder (read-only: the panel never changes it) and press **Save and continue**. The panel writes `config.json`, restarts itself and opens the sign-in. Once the panel is set up, the screen only returns when ffplayout is not reachable.

The Advanced section holds the path of ffprobe and the ffplayout address. Leave them as found unless they are wrong.

---

## 2. Signing in, language and formats

Open http://127.0.0.1:8790. Sign in with your ffplayout account. The credentials go to the
local ffplayout server; the panel does not store them. Two-factor codes are supported when
the account has them.

Roles come from ffplayout: a **global admin** sees every page, including System settings;
other roles see every page except System settings. The session lives in the browser tab.

### Interface language

The interface is available in English, Spanish (Español), Arabic (العربية), Hebrew (עברית),
Chinese (简体中文), Russian (Русский) and Japanese (日本語). The text direction follows the
language: Arabic and Hebrew mirror the layout from right to left.

- **Per browser**: the language list at the foot of the sidebar. The choice is kept in the
  browser. Without a choice, the first language of the browser that the app offers is used,
  otherwise English.
- **For the installation**: System settings → Language and formats → Default language.
  New browsers start with it. *Follow the browser language* is the default.
- A text that is not translated yet appears in English. Nothing is ever blank.
- Texts that come from ffplayout itself (engine messages, its log lines) stay in English.

### Dates and numbers

- Dates follow the language: Spanish and Russian show day, month, year (`25/11/26`), English
  (US) month first, Japanese and Chinese year first (`2026/11/25`). The same format is used in
  the date fields and in the tables, and the hint inside an empty date field shows it.
- **Date order** (System settings → Language and formats, per browser) can override the order:
  day-month-year, month-day-year or year-month-day. *Follow the language* is the default.
- Digits are always 0-9, also in Arabic. Times are always 24-hour (`18:30:00`).
- What is stored and sent to ffplayout is always `YYYY-MM-DD`; the display format never
  changes a file.
- The calendar pop-up of a date field is drawn by the browser and follows the browser's own
  language, not the panel's. Typing a date in the panel's format always works.

### Adding a language

Copy `panel\locales\_template.json` to `data\locales\<code>.json`, set `_meta` and translate.
Restart is not needed; reload the page. Files in `data\locales\` survive updates and may
also replace single texts of a shipped language. Details: `tools\i18n\TRANSLATING.md`.

---

## 3. The pages

### Dashboard

- **Playout**: Running or Stopped. **Active output**: the output profile that is live.
- **Now playing**: the clip on air, with elapsed and remaining time.
- **Start / Restart / Stop**: the engine process. Restart is needed after some settings
  changes (the page says so). Stopping any output other than the local preview asks first;
  going on air on the PRODUCTION output requires typing `PRODUCTION`.
- **Back / Next / Reset to schedule**: jump within the playlist. Reset returns to the item
  the clock says should be playing.
- **Preview**: the HLS preview of the output, available while the output is the local preview.
  While streaming to an external service, watch the stream there instead.

Every Start, Stop and Restart sent from this page is recorded for resume after a reboot
(see System settings).

### Outputs and keys

One output is live at a time:

- **HLS preview**: local only, for checking.
- **TEST** and **PRODUCTION** stream targets (RTMP) with the stored encoder settings
  (1920×1080, 25 fps, H.264 CBR 6 Mbit/s, 160 kbit/s audio).
- A custom stream target can also be configured.

Stream keys go straight to ffplayout when you press Apply and are never stored or shown by
the panel; the field is cleared after sending. Switching to PRODUCTION asks for confirmation
by typing `PRODUCTION`.

### Program

The playlist editor, one broadcast day at a time. Use the arrows or the date field to move
between days. The table shows every row with start time, title, folder and length. The
summary line compares the total with the day length of the channel and says whether there is
a gap (the filler covers it) or an overrun (the last rows are cut at the end of the day).

**Rows**

- Tick boxes select rows (Shift+click for a range). Selected rows can be moved, removed or
  saved as a block.
- The arrows move a row; the cross removes it.
- A green marker shows the row on air (only while the table matches the saved file; after any
  edit it disappears until you save or reload).
- Coloured bands mark saved blocks; the header row of a band shows the block name, a pin time
  if it is pinned, and Detach.

**Setting the start time of a row**

Double-click a start time (or focus it and press Enter or F2), type `HH:MM` or `HH:MM:SS`,
press Enter. Esc cancels.

The engine has no start-time field: a row starts when everything above it has finished. So
the panel changes what is above the row:

- **Later than now**: an off-air slate of exactly the difference is inserted above the row.
  Everything below moves later by the same amount.
- **Earlier than now**: off-air slates directly above the row are shortened or removed first.
  If that is not enough, the panel offers to cut the end of the clip directly above (never to
  less than one minute of it); you confirm the exact cut. Everything below moves earlier.

Before anything changes, a dialog lists every step and warns if a live slot or a pinned block
further down moves, with their new times. If the row is the first row of a pinned block, the
pin follows the new time.

Rows that cannot be moved this way: the live slot (change it in Generate), rows inside a block
other than its first row (set the time on the first row, or Detach the block), and, on today's
day, the row on air and the rows before it.

Nothing is saved until you press **Save**.

**Save, Reload, Delete**

- **Save** writes the day to the engine and the block marks to the panel. Before saving it asks
  when the date is in the past, when the playlist is short (the filler loops for the rest of the
  day), when it is too long (the last rows are cut), when clips are not rights-cleared, and, on
  the day that is on air now, that you are changing the playlist on air (the engine reloads the
  file immediately).
- **Reload** discards unsaved edits and reloads the saved day.
- **Delete** removes the saved playlist of the day (the filler then plays). On the day on air it
  requires typing `DELETE`.
- **Fix moved files**: after a library rescan, rows that point to files moved or renamed in the
  media folder are updated to the current path.
- **Export schedule**: writes the day as JSON and XMLTV to `data\feed` and downloads the XMLTV.
- **Save day as block**: saves the selected rows as a reusable block.
- **Open in builder**: the same day in the two-pane block builder.

**Generate**

Builds a full day from the media on the right. Choose the source (ticked folders in the media
list, or a template that mixes categories by weight), then the options: shuffle, skip files
flagged for conforming, only rights-cleared clips, skip clips with analysis problems, only 16:9,
add branding (rules on the Channel branding page), the broadcast window (full day, or a custom
start and end with the off-air slate outside it), an optional live slot inside the window,
"avoid clips aired in the last N days", and "same artist at least N hours apart".

**Generate for this date** replaces the day in the editor (nothing is saved until Save). The line
under the button explains what was used and what was skipped.

**Fill empty days** generates and saves playlists for N days from the chosen date, only for days
that have none. Blocks pinned to a date (from Insert at a time, or an occasion) keep their
times; clips fill around them.

**Saved blocks**: pre-edited sequences for reuse. Insert one before the selected row, at the end,
or **at a time** ("Replace the rows in that time range" keeps everything after it at its time). A
block inserted at a time is pinned to that time. **Quiet** blocks get no automatic branding or
live text inside.

**Occasions**: special days (a national day, an anniversary): enter each date, choose a branding
set, optionally place blocks at set times. Generate and Fill use them.

**Media**: browse the media folder (read-only) or ffplayout's storage. Tick folders to feed
Generate; click a file to play it in VLC; add files to the day.

### Block builder

A two-pane editor: sources on the left (Library search, Folders, Branding, Saved blocks,
Suggestions), the list on the right. In **day mode** the right pane is a whole broadcast day with
clock times, bands for blocks and the same start-time editing as the Program table (double-click
a time). In **block mode** it is a block with a target length.

Keyboard: Tab switches pane · Up/Down cursor · Space select · Ctrl/Shift+click multi-select ·
Enter or Insert add · Delete remove · Ctrl+Up/Down move · F3 play in VLC · F4 clip details ·
Ctrl+Z / Ctrl+Y undo and redo · Ctrl+F search. Drag from left to right to add, within the right
pane to reorder, from right to left to remove.

In and out points are edited in the row (mm:ss.f). **Suggestions** proposes clips or trims that
fill a gap (up to a target length, up to a pinned block, or to the end of the day) and related
media for the clip under the cursor.

Save day, Save block and Save as copy write the result; Close discards.

### Library

Every clip in `library.csv` with its metadata. Filters by folder, file type, rights, category,
analysis result, picture shape and language; search by title, performer or path.

- Click a clip for **Clip details**: title, performer, songwriters, category, rights for streaming
  (Unknown / Cleared / Blocked, with expiry and note), language, explicit flag, tags, notes, the
  analysis results, songs found inside, and release documents (attached files kept on this PC
  under `data\releases`).
- **Bulk** actions on all matching clips: set a field, fill empty titles and performers from the
  analysis suggestions, run the analysis for them.
- **Rescan library** scans the media folder again (read-only) and updates `library.csv`. New and
  moved files show up; the Program page then offers Fix moved files.
- **Export CSV / Import CSV**: edit metadata in a spreadsheet (save as CSV UTF-8) and import it
  back. A backup of the metadata is kept before every import.

**Overnight analysis** runs on this PC at low priority:

| Check | What it does |
| --- | --- |
| Audio | Reads each file completely: loudness, clipping, mono, one channel, phase, long silences, silent start or end. |
| Video | Three 10-second samples plus start and end: combing (interlace), black, static picture. |
| Metadata | Suggests a clean title and the performer from the file and folder names. |
| Thumbnail | One picture per clip, in `data\thumbs`. |
| Clean titles | After Metadata: clips whose title is still the raw file name get the cleaned-up title **as metadata**. Files are never renamed. |
| Timed text | Speech and lyrics as timed text (whisper.cpp), then the songs inside each clip, with credits looked up in MusicBrainz (Wikidata when MusicBrainz has none). Slow; the thread count is configurable. |

Timed text uses the whisper model and language set in `config.json` (`whisper_model`,
`whisper_language`; `auto` detects the language). Song detection currently recognises announcement
phrases in Hebrew; for other languages the timed text is stored and songs are not detected
automatically yet.

Choose "Clips not checked yet" or "Everything again", a stop time, and press Start. A stopped run
continues where it left off. Results feed the Library filters, the Clip details, Needs attention
and Generate's "skip clips with problems".

### As-run

What actually aired, from the engine log joined with the clip details, per day, with filler and
off-air rows optional. Kept permanently in `data\asrun`. Export a day or a month as CSV (UTF-8, opens
in a spreadsheet) or JSON; confirmed songs inside clips are included as works with their credits.

### Channel and schedule

- **Channel**: name, timezone, mode (playlist or folder loop), show logo.
- **Broadcast day**: day start (for example 06:00:00) and length (24:00:00). Everything in the
  panel counts the day from this start. The filler plays whenever the playlist runs out or a file
  fails.
- **Channel logo**: upload a PNG; position, opacity and scale. Needs a playout restart.
- **Loudness**: EBU R128 normalisation on the whole programme, on live input only, or off; target
  and true-peak ceiling.
- **Automation account**: a separate ffplayout user the panel uses when no browser is open, for
  lower thirds and for **resuming the channel after a reboot**. Create the user in the ffplayout
  UI (role User is enough), enter it here, Test and save. Stored in `data\panel-secrets.json` on
  this PC.
- **Lower thirds (now / next)**: automatic "now" at the start of each clip and "next" before its
  end, with font and position settings. The labels are free text in your language.

### Live input

- **Listeners**: up to 8 live inputs the engine accepts (RTMP, SRT and the like). When a source
  connects it takes over the playout; when it disconnects the schedule resumes. "This PC only"
  accepts local sources; "All interfaces" accepts the network (allow the port in Windows Firewall).
- **Capture devices on this PC**: send a camera and microphone connected to this PC to a listener.
  Pick the devices like in a video call, check the preview, press **Send to live input**. The bridge
  keeps running even if the panel restarts; the next panel shows it with a Stop button. Log:
  `logs\capture.log`.

### Channel branding

Branding files per **set** (Default plus any you create, for example for occasions): idents,
stingers, up-next backgrounds, openers, closers, the explicit-language card, the off-air slate. Each
upload is checked against the kit specification (1920×1080, 25 fps progressive, 48 kHz stereo,
-14 LUFS); only files that pass are used. Replaced or removed files are moved aside, never deleted.

**Playlist rules** decide what Generate inserts when "Add branding" is ticked: ident at the top of
the hour or every N minutes, stinger between two short clips, up-next before long clips, opener and
closer around full concerts, the explicit card before explicit clips, and the hours when explicit
clips may air.

**Live text**: the explicit-language tag and the up-next line drawn by the engine over the picture,
using the automation account. The texts are free text; the defaults are English (`NEXT`,
`Explicit language`).

### Needs attention

Files that need a decision: problem files from the analysis, identical copies in several places,
odd shapes, songs to confirm, and so on. **Hide** takes a file out of the Library, Generate, the
browser and the analysis until you unhide it; **Keep as is** clears an item. Nothing in the media
folder is changed; to fix or delete a file use Show in folder and do it yourself.

### Send feedback

**Send feedback** (sidebar foot) is for bug reports, feature requests and questions. Choose the type, write the
message, and press **Open e-mail**: your e-mail app opens with a prepared message to the address in
`feedback_email` (`config.json`); you read it and send it yourself. The panel sends nothing. The optional system
information (version, browser, language, current page) is shown in the dialog before anything is prepared; it holds
no files, paths or passwords. When no address is configured, or the message is too long for an e-mail link, the
text is copied instead.

### Help layer and tutorial

- **Help** (sidebar foot, the ? button): turns the contextual help layer on or off. When on, small
  ? markers sit by the page titles and the main controls; hover or click one for a short
  explanation. The switch is shared by the installation (it is also in System settings).
- **Tutorial** (sidebar foot, or "Start the tutorial now" in System settings): a short guided tour of
  the basic operations: dashboard, outputs, picking a day, the playlist, Generate, Fill, Save,
  Library, Needs attention. Next and Back, Skip, or the arrow keys; Esc closes it. The checkbox in
  the tour, "Show this tutorial next time the system starts", is the same switch as in System
  settings; while it is on, the tour runs once per sign-in.

### Hidden media

The files and file types hidden from the system, with Unhide. A mark stays while the file at that
path has the same content; a file replaced by a fixed version shows again by itself.

### Undo

Most one-click changes (metadata, blocks, occasions, branding files, hidden marks, saved playlists)
can be undone from the toast right after the action, or later from the Undo list. A playlist of the
day on air is only put back after confirmation.

### Logs

The engine log, filtered by level and date.

### System settings (administrator)

Decisions that apply to the whole installation, stored in `data\system.json`:

- **After a reboot or an engine restart**: *Continue* (default) starts the channel again if it was on
  air before; *Stop* keeps it off until someone presses Start.
- **Do not resume if the last "on air" is older than N hours** (default 168, seven days): a PC that
  was off for weeks must not push a stale output to a stream target.
- **Help and tutorial**: the contextual help layer on or off, and whether the first-steps tutorial runs
  when the system starts; "Start the tutorial now".
- **Appearance**: the name shown at the top left and in the browser tab, the accent colour, and the two logos
  (menu and sign-in page: PNG, JPEG, WebP, GIF or SVG up to 1 MB; a wide picture with a transparent background
  about 40 pixels high works best). Empty name or *Use the default* returns to Grady Set Go. Stored in
  `data\appbrand\`; a replaced logo is kept in `data\appbrand\_replaced\`. This is the look of the panel, not
  the broadcast (that is Channel branding). The sign-in page shows the name and logo without sign-in.
- **Language and formats**: the default interface language of the installation, and the date order of
  this browser (section 2).

How resume works: the panel records every Start, Stop and Restart sent from the Dashboard in
`data\system-state.json`. At boot, and after the watchdog restarts a crashed engine, the boot script
asks the panel to resume; the panel starts the channel only when the setting says Continue, the last
recorded state was on air, it is within the age limit, and the automation account is set. Commands
given in ffplayout's own UI are not recorded.

The Status card shows the last recorded command, whether a resume would happen now, the automation
account, the media folder and the panel process. **Test resume now** runs the decision immediately (it
only acts if the channel is stopped). **Restart panel** ends the panel; the watchdog starts it again
within about two minutes; the stream and a running capture bridge are not touched.

---

## 4. Daily operation

**A normal day**

1. Dashboard: check that Playout is Running, the active output and Now playing.
2. Program: check that tomorrow has a playlist (Fill empty days keeps a week ahead).
3. Needs attention: look at new items from time to time.

**Changing today's programme**

Edit the day on the Program page and Save. The engine reloads the file at once, so the confirmation
says ON AIR. Rows before the one on air are not changed by the engine; the running clip and
everything after it follow the new list. Prefer editing rows that are still ahead.

**A live show**

Either an external encoder sends to a listener (Live input page), or a camera on this PC is sent with
Send to live input. The schedule resumes when the source stops. A live slot can be reserved in the day
with the live slot option of Generate: a standby picture holds the slot until the source connects.

**Going to the PRODUCTION output**

Outputs and keys → PRODUCTION profile → stream key → Apply (type `PRODUCTION`). Then Dashboard →
Restart. The panel records the start for resume.

---

## 5. Boot, restarts and recovery

**At PC start** (`boot-playout.ps1`, installed by `install-autostart.ps1`):

1. waits up to 5 minutes for the media folder;
2. starts ffplayout and waits until it answers;
3. starts the panel;
4. asks the panel to resume the channel according to System settings;
5. then, every minute: a stopped engine or panel is started again (and the panel is asked to resume
   after an engine restart); an engine that is running but has not answered for three checks is ended
   and started again.

Log: `logs\boot.log`. To pause the watchdog for maintenance, create the file `data\WATCHDOG_OFF`;
delete it to resume.

**Restarting only the panel** (after a change in `config.json` or an update): PowerShell as
Administrator, `restart-panel.ps1`, or Restart panel on the System settings page. ffplayout and the
stream are not touched.

**Restarting ffplayout by hand**: `start-ffplayout.ps1` (refuses if one is already running; `-Force` to
start anyway). The output of the previous run is kept as `logs\stderr.log.1` … `.5`.

**If the panel will not start**: look at `logs\panel.err.log` and the last `PANEL` lines in
`logs\panel.log` (`start`, `CRASH`, `exit code`).

**If clip metadata is damaged**: the panel refuses to start with an empty store. Restore
`data\clip-metadata.json` from `clip-metadata.json.bak` (kept before every save) or from
`data\meta-backups\`.

**If files were moved in the media folder**: Library → Rescan library, then Program → Fix moved files on
the affected days.

**Media folder not reachable**: the boot log says so; the Library and Generate show nothing from the
folder until it is back. Playlists keep playing as long as the engine can open the files.

---

## 6. Where things are

| Item | Path |
| --- | --- |
| Settings of the installation (folders, engine address, categories, languages of the tools) | `config.json` |
| Panel log (requests, start and crash lines) | `logs\panel.log` |
| Panel console output | `logs\panel.out.log` (previous runs `.1` to `.5`) |
| Engine log | `logs\ffplayout_1.log`, `stderr.log` |
| Boot and watchdog log | `logs\boot.log` |
| Capture bridge log | `logs\capture.log` |
| Library scan log | `logs\scan-library.log` |
| Overnight analysis log and results | `logs\deep-scan.log`, `data\analysis\` |
| System settings and last channel state | `data\system.json`, `data\system-state.json` |
| Automation account | `data\panel-secrets.json` |
| Blocks, placements, occasions, templates | `data\blocks.json`, `data\block-placements.json`, `data\occasions.json`, `data\templates.json` |
| Undo history | `data\undo.json` |
| Release documents | `data\releases\<clip id>\` |
| Branding files | `storage\branding\` |
| Added or changed interface languages | `data\locales\<code>.json` |
| Panel name, logos, accent colour | `data\appbrand\` |

---

## 7. Rules the system keeps

- The media folder is never written. Titles, rights and every other detail live in the panel's
  metadata, not in file names.
- Stream keys and passwords are never logged. The panel log holds method, path and status only.
- Files uploaded to the panel (branding, logo, documents) are moved aside when replaced or removed,
  never deleted.
- Every data store is written to a temporary file and renamed into place, so a power cut cannot leave a
  half-written file; most keep a `.bak` of the previous version.
- Playlist saves, deletes and block changes are recorded for Undo.
- The display language and date format never change stored data.
