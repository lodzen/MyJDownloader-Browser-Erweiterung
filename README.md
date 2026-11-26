# MyJDownloader Browser Erweiterung

Browser extension (Manifest V3) that connects Chrome/Edge to
[MyJDownloader](https://my.jdownloader.org) — remote control for a locally
running [JDownloader](https://jdownloader.org).

## Features

- **Click'n'Load interception** — CNL links (classic and encrypted
  `addcrypted2`) are captured before they reach the local client; a queue
  entry is created and you pick the target JDownloader in the extension
  popup, which opens automatically.
- **Add links** — send the current page, a link, a selection, or clipboard
  content to any of your connected JDownloaders, with optional package name,
  passwords, destination folder, priorities, and more.
- **Device overview** — see your connected JDownloaders, their status
  (online/captchas/premium), running downloads, and control basic actions
  (start/stop, pause, play state).
- **Light/dark theme** with a manual toggle.

## Install (development / unpacked)

There is no build step — the repository *is* the unpacked extension.

1. Clone the repository.
2. Open `chrome://extensions` (or `edge://extensions`) and enable
   **Developer mode**.
3. **Load unpacked** and select the repository folder.

## Usage notes

- A running JDownloader on the same machine is auto-detected
  (`127.0.0.1:9666`); log in with your MyJDownloader account in the popup to
  use remote devices instead.
- The badge counter on the toolbar icon shows queued (not yet sent)
  Click'n'Load/link requests.
- Options (countdown behavior, clipboard observer, default device, …) are in
  the popup's settings page.

## Development

See [`AGENTS.md`](AGENTS.md) for architecture notes and how to test/debug the
extension locally (CDP-driven Chrome, service worker inspection). The
MV2→MV3 migration history is documented in
[`MIGRATION_PLAN.md`](MIGRATION_PLAN.md).

## License

License to be determined — the original MyJDownloader extension is a product
of AppWork GmbH. Until a license file is added, all rights are reserved.
