# USB Recorder

Record from USB mics/interfaces, or import any audio file, and process it non-destructively:
input trim, high-pass, low-pass, spectral noise reduction (learned noise profile), noise gate, output level.
The original audio is never changed; settings are stored per take and applied on playback and export (24-bit WAV).

- `web/` — the app itself (also works as a PWA on any HTTPS host)
- `android/` — native Android wrapper (WebView) with mic permission, file import, Save dialog and "Share to / Open with" for audio files

## Getting the APK
Push this repo to GitHub. The **Build APK** workflow builds it and attaches `USB-Recorder.apk` to the **latest** release.
On your phone open the release, download the APK and install it (allow "Install unknown apps" for your browser when asked).

Or open `android/` in Android Studio and press Run.

## Using it on other audio files
- Tap **Import audio file** (WAV, MP3, M4A/AAC, OGG/Opus, FLAC), or share an audio file to USB Recorder from any app.
- Imported files get your current settings. Use **Copy** / **Paste** in Processing to move a chain between takes.
- Select a stretch of pure background noise → **Learn noise from selection** for the best noise reduction.

## License
[CC0 1.0 Universal](LICENSE) — public domain dedication. Do whatever you like with it.
