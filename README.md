# Grady Set Go - Playout App

Run a 24/7 TV-style channel from a Windows PC.

Grady Set Go is a browser control panel for [ffplayout](https://github.com/ffplayout/ffplayout) 2.6.0, the open-source playout engine. ffplayout plays the files and sends out the stream. Grady Set Go is where you plan what goes on air and keep track of it:

- **Program planner:** build the day's rundown from your clips, with timings, gaps and overruns shown as you work.
- **Block builder:** reusable blocks (a show, a promo break, a filler loop) that you drop into any day.
- **Clip library:** scans your media folder (read-only), reads duration, format and loudness, makes thumbnails, and keeps titles and other metadata without renaming your files. Optional speech-to-text (whisper.cpp) and song-credit lookup (MusicBrainz / Wikidata).
- **As-run log:** what actually went on air, exported as CSV or JSON.
- **Outputs, live input and branding:** HLS preview and RTMP test/production outputs (stream keys are never stored), live inputs (RTMP, SRT) and capture devices that take over the schedule, and branding sets (idents, stingers, up-next, slates) with insertion rules.
- **Needs attention:** one list of files that need a decision (problem files from the analysis, duplicates, odd picture shapes, songs to confirm).
- **System tools:** logs, undo, autostart after a reboot, and an update notice when a new version is released.
- **Seven interface languages:** English, Spanish, Arabic, Hebrew, Chinese, Russian and Japanese, with right-to-left layout and local date formats. You can add more languages without changing the program.

The panel runs on the same PC as ffplayout and only listens on `127.0.0.1`, so it can't be reached from the network.

Created by Yaniv Grady. MIT License (see `LICENSE`). **Status: 0.1.0, first pre-release.** It is tested in the developer's sandbox but not yet on many PCs. Expect rough edges, and please send feedback.

## Requirements

- Windows 10 or 11 (64-bit), with `winget` (App Installer, included in current Windows).
- An internet connection for the first install.
- A folder of video files to play out (local disk or network share; the panel only reads it).

The installer gets these for you. To install them by hand instead, see the last section.

| Program | Why | Source |
| --- | --- | --- |
| Node.js LTS (18 or newer) | Runs the panel. No other packages needed. | https://nodejs.org/ |
| ffplayout 2.6.0 | The playout engine. | https://github.com/ffplayout/ffplayout/releases |
| FFmpeg with ffprobe | Reads your files, makes thumbnails, measures loudness. | https://ffmpeg.org/download.html |
| FFmpeg shared libraries (about 86 MB) | ffplayout 2.6 needs the FFmpeg DLLs next to it. | https://github.com/BtbN/FFmpeg-Builds/releases |
| VLC (optional) | Only for the buttons that play a file on the PC. | https://www.videolan.org/vlc/ |

None of these are included in the download. Each is downloaded from its own source and keeps its own license (see `NOTICE`).

## Setup

### 1. Download

1. Open the **[Releases](../../releases)** page of this repository and choose the newest release.
2. Under **Assets**, download `grady-set-go-<version>.zip`.
   Use this zip, not the green **Code > Download ZIP** button. That one gives you the source tree, not the packaged app.
3. Right-click the zip, choose **Properties**, tick **Unblock** if it is shown, and press OK. Windows then won't warn about each script it contains.

### 2. Unzip

Unzip to a folder **without spaces** in its path, for example `C:\Playout`. The folder must contain `00 START HERE.cmd` directly, not inside a second subfolder.

### 3. Run the installer

Double-click **`00 START HERE.cmd`**. It does the following:

1. Checks that this PC doesn't already have an install. If it does, it stops and points you to updating (step 7).
2. Installs Node.js, FFmpeg and VLC with winget if they are missing. Windows asks for permission once.
3. Downloads ffplayout 2.6.0 and the FFmpeg shared libraries into `app\` inside the install folder, showing progress.
4. Starts ffplayout and the panel. Their output goes to `logs\`.
5. Opens http://127.0.0.1:8790 in your browser.

It is safe to run again; it skips what is already installed. If Windows shows "Windows protected your PC", choose **More info > Run anyway** (the scripts are plain text you can read first).

If the ffplayout download fails, the installer says so: download the Windows zip of ffplayout 2.6.0 yourself, unzip it, and run
`node tools\install.js --ffplayout-from "<unzipped folder>"` from the install folder.

### 4. First-start setup screen

The panel opens on a setup screen that checks each part (Node.js, ffplayout, FFmpeg/ffprobe, the FFmpeg libraries, write access, and optionally VLC and the speech-to-text model) and shows what is missing, with a button where a download can fix it.

1. Press **Browse** next to the media folder and choose the folder with your video files.
2. Press **Save and continue**. The panel restarts itself with the new settings.

The installer window closes by itself once the required items are green.

### 5. Admin account

On a fresh ffplayout the next screen creates the administrator account. Choose a user name and password, then sign in. Then:

- **Library > First scan** reads your media folder.
- **System settings** sets the interface language, date format, application name, logos and accent colour.
- **Help** (also `MANUAL.md`) is the full operator manual, with a short tutorial.

### 6. Start automatically with Windows (optional)

To keep the channel running after a reboot, run `install-autostart.ps1` once in an **Administrator** PowerShell from the install folder. The manual, section 5, explains the start order and recovery.

### 7. Updating

When a new release is out, administrators see an update badge in the panel menu. The panel checks GitHub once a day and sends nothing about your install; set `"update_check": "off"` in `config.json` to turn this off.

1. Download the new release zip and unzip it to a **temporary folder**, not over the install folder.
2. Double-click **`01 UPDATE.cmd`** in that temporary folder. It finds your install, asks you to confirm, and updates it.
3. The update stops only the panel; ffplayout keeps playing. It moves the old program files to `backup\update-<time>\`, installs the new ones, and checks that the panel answers. If it doesn't answer within 40 seconds, the old version is put back automatically.

By hand: `node <temp>\tools\update.js --root C:\Playout --package <temp>` (add `--dry-run` first).
To go back: `node tools\update.js --root C:\Playout --restore latest` (`--list` shows backups, `--with-data` also restores the saved data files).

Your settings and data (`config.json`, `data\`, `playlists\`, `storage\`, `logs\`, `library.csv`, `panel\state.json`) are never replaced.

### 8. Uninstalling

Double-click **`99 UNINSTALL.cmd`** in the install folder and press Yes when Windows asks for administrator rights. It asks which install folder to remove, lists what runs from it, and offers three choices:

- stop those programs;
- stop them and remove the Windows autostart tasks;
- remove the install completely (the folder, with its settings and data, goes to the Recycle Bin).

It asks before changing anything and never touches your media folder. Stopping ffplayout ends any stream that is on air.

## Installing by hand (without winget)

1. Install Node.js 18 or newer and FFmpeg (with ffprobe), and optionally VLC.
2. Put ffplayout 2.6.0 (`ffplayout.exe` and its files) into `app\bin\` in the install folder, together with the FFmpeg shared DLLs (`avcodec-*.dll` and the rest).
3. Right-click `start-ffplayout.ps1` and choose **Run with PowerShell**, then do the same for `start-panel.ps1`. If a script is blocked, run it as `powershell -ExecutionPolicy Bypass -File start-panel.ps1`.
4. Open http://127.0.0.1:8790 and continue with step 4 above.

## Configuration

`config.json` in the install folder is written by the setup screen. `config.example.json` lists the main keys:

| Key | Meaning |
| --- | --- |
| `media_root` | Folder with your video files (read only). |
| `port` | Panel port, default 8790. |
| `engine_url` | ffplayout address, default `http://127.0.0.1:8787`. |
| `feedback_email` / `feedback_endpoint` | Where the **Send feedback** button sends to. Without either, it copies the message for you to send. |
| `update_check` | `on` (default) or `off`. |

## Your data stays on your PC

Settings, library, clip metadata, playlists and logs live in the install folder (`config.json`, `data\`, `playlists\`, `storage\`, `logs\`). The download contains none of them, and the panel sends none of them anywhere. Optional lookups (song credits, update check) send only the search itself.

## Documents

- `MANUAL.md`: the operator manual (also on the panel's Help page).
- `CHANGELOG.md`: what changed in each version.
- `tools/i18n/TRANSLATING.md`: how to correct a translation or add a language.
- `NOTICE`: third-party software and licenses.

## Notes

- The machine-translated interface languages still need review by native speakers.
- ffplayout, FFmpeg, VLC and other names belong to their owners. This project is not affiliated with them.
