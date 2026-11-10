# Grady Set Go - Playout App

A control panel for 24/7 TV playout on Windows. It runs on top of [ffplayout](https://github.com/ffplayout/ffplayout) 2.6.0 and adds a planner, a block builder, a clip library, an as-run log, live input and system tools, in seven interface languages (English, Spanish, Arabic, Hebrew, Chinese, Russian, Japanese).

Created by Yaniv Grady. MIT License (see `LICENSE`). Status: pre-release, not yet v1.0.

## What you install yourself

| Program | Why | Where to get it |
| --- | --- | --- |
| Node.js 18 or newer (LTS) | Runs the panel. The panel has no other dependencies. | https://nodejs.org/ |
| ffplayout 2.6.0 | The playout engine. | https://github.com/ffplayout/ffplayout/releases |
| FFmpeg (with ffprobe) | Reads your files, makes thumbnails and loudness checks. | https://ffmpeg.org/download.html |
| VLC (optional) | Only for the buttons that play a file on the PC. | https://www.videolan.org/vlc/ |

Nothing is installed for you. The first start tells you what is missing.

## Install (automatic)

1. Unzip the download to a folder without spaces, for example `C:\Playout`.
2. Double-click `00 START HERE.cmd`.
   It installs Node.js, FFmpeg and VLC with winget (Windows asks for permission once), downloads ffplayout into `app\bin`, starts ffplayout and the panel, and opens http://127.0.0.1:8790.
3. The setup screen lists what is found and what is missing. Enter your media folder (the folder with your video files; the panel only reads it) and press Save and continue.
4. On a brand-new ffplayout the next screen creates the admin account. Then sign in.

If the automatic ffplayout download fails, the installer says so and shows what to do: download the Windows zip of ffplayout 2.6.0 from its releases page, unzip it, and run `node tools\install.js --ffplayout-from "<unzipped folder>"`.
`00 START HERE.cmd` can be run again at any time; it skips what is already installed.

## Install (by hand)

1. Install Node.js 18 or newer, FFmpeg (with ffprobe) and, optionally, VLC.
2. Put `ffplayout.exe` (2.6.0) into `app\bin\` inside the install folder.
3. Right-click `start-ffplayout.ps1`, then `start-panel.ps1`: Run with PowerShell. Open http://127.0.0.1:8790.
4. Continue with step 3 above.

If a script is blocked, run it as `powershell -ExecutionPolicy Bypass -File start-panel.ps1`.

To start everything automatically when the PC starts, run `install-autostart.ps1` once in an Administrator PowerShell. See the manual, section 5.

## Updating

1. Download the new version and unzip it to a temporary folder (not into the install folder).
2. Double-click `01 UPDATE.cmd` in that folder. It finds your install, asks you to confirm, and updates it.
   (By hand: `node <temporary folder>\tools\update.js --root C:\Playout --package <temporary folder>`; add `--dry-run` first to see what would happen.)
3. The tool stops only the panel (ffplayout keeps playing), moves the old program files into `backup\update-<time>\`, installs the new files, starts the panel and checks that it answers. If it does not answer within 40 seconds, the old version is put back automatically.
4. To go back later: `node tools\update.js --root C:\Playout --restore latest` (`--list` shows the backups, `--with-data` also restores the data files saved in the backup).

Settings and data (`config.json`, `data\`, `playlists\`, `storage\`, `logs\`, `library.csv`, `panel\state.json`) are never replaced.

If you run `00 START HERE.cmd` on a PC that already has an install, it stops with a message and points here; nothing is installed or changed. A second, separate copy on the same PC is not supported yet.

## Uninstalling

Double-click `99 UNINSTALL.cmd` in the install folder (it asks Windows for administrator rights itself; press Yes). It first asks which folder to uninstall (press Enter for the folder it is in, or paste the path of another install, for example an old test copy). It lists what runs from that folder and offers three choices:
stop those programs; stop them and remove the Windows autostart tasks that point to the folder; or remove the install
completely (the whole folder, with its settings, playlists and data, is moved to the Recycle Bin, not deleted). It asks
before it changes anything, never touches your media folder, and only stops programs that run from its own folder.
Stopping ffplayout ends any stream that is on air.

## Documents

- `MANUAL.md`: the operator manual (also at the Help page of the panel).
- `CHANGELOG.md`: what changed in each version.
- `tools/i18n/TRANSLATING.md`: how to correct a translation or add a language.

## Your data stays on your PC

Settings, library, clip metadata, playlists and logs live in `config.json`, `data\`, `playlists\`, `storage\` and `logs\` inside the install folder. The download contains none of them. Updating means replacing the program files and keeping those folders.

## Notes

- The panel listens on 127.0.0.1 only. It is not reachable from the network.
- ffplayout, FFmpeg, VLC and other names belong to their owners; this project is not affiliated with them.
- Machine-translated interface languages are marked for review by native speakers before v1.0.
