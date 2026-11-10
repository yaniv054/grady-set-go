# Changelog

## 0.1.0 (unreleased)


First public preparation of Grady Set Go - Playout App.

- Interface in English, Spanish, Arabic, Hebrew, Chinese, Russian and Japanese (right-to-left layout, local date formats). More languages can be added without changing the program.
- First-run setup screen: checks Node.js, ffplayout, FFmpeg/ffprobe, the media folder and write access, and explains what to install.
- Settings for the application name, the sidebar and sign-in logos, and the accent colour.
- Send feedback button (opens an e-mail with the system information you choose to include).
- One-click installer (00 START HERE.cmd + tools/install.js).
- The installer stops when this PC already has an install (running panel or autostart task in another folder) and points to the update. One-click update: `01 UPDATE.cmd` finds the install, asks to confirm, then runs the update tool.
- Uninstall: `99 UNINSTALL.cmd` stops what runs from the folder, can remove the autostart tasks, and can move the whole install to the Recycle Bin (asks first).
- The installer and the setup screen start the panel and ffplayout straight from Node and write their output to `logs\` (a PowerShell step that failed silently left no log at all).
- Setup screen: Browse button next to the media folder lists the folders of this PC (drives first on Windows) so the path need not be pasted.
- ffplayout 2.6 needs the FFmpeg program libraries (avcodec-63.dll ...) next to it; the winget FFmpeg is a static build without them, so ffplayout.exe exited silently. The installer downloads the BtbN shared build (about 86 MB) and copies its DLLs into app\bin; the setup screen shows a Download button when they are missing.
- Installer: the whole ffplayout package (bin and assets) goes into app, downloads show progress, the system tar is used to unzip (Git for Windows ships a tar that cannot read zip), and the installer waits for ffplayout to answer and prints its logs and exit code when it does not.
- Setup screen: the media folder button opens the Windows folder window ("Select Folder"; the in-page folder list is the fallback), the speech-to-text download runs in the panel with a progress bar and resumes after an interruption, "Check again" moves slowly down the list, automatic re-checking stops when nothing is missing, and the admin-account form shows a password mismatch while typing. The installer window closes by itself when the required items are green. The uninstaller asks again after a wrong choice.
- Update tool with backup and restore (tools/update.js).
- Panel split into modules; configuration through `config.json`.
- Song credits from MusicBrainz; as-run export as English CSV and JSON.
- Update notice: administrators see a badge in the menu when a newer GitHub release exists (checked at start and daily; `update_check: "off"` disables it; nothing about the installation is sent).
- Settings: changing the date order no longer resets unsaved fields (language, on-boot); the colour picker no longer reopens when clicking outside it.
- Feedback: with `feedback_endpoint` set, the panel sends the message itself (relay script in `tools/feedback-relay/feedback.php`); otherwise e-mail app or copy.
- Library: the scan button reads "First scan" while the library is empty.
- Appearance: logo size and colour guidelines, previews on both the dark and the light theme, and a warning when a chosen logo is too small or nearly black/white.
