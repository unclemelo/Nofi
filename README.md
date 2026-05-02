# Nofi (Electron + Vanilla JS)

Desktop Twitch notifications with a Steam-style visual overlay.

## Features

- Login with Twitch OAuth (implicit grant via loopback redirect)
- Chat notifications (IRC via `tmi.js`) with emote rendering
- Follow / sub / gift sub / bits / shared chat notifications (EventSub WebSocket)
- Dedicated click-through overlay window pinned to the screen edge
- Per-event type toggles (chat, follows, subs, gift subs, bits)
- Twitch badge rendering on notification titles
- Per-user name color accent (uses Twitch IRC color, falls back to chosen accent)
- Built-in notification sound (Web Audio API, no external audio file)
- Notification feed panel in the settings window with live preview
- Auto-connect on launch option
- Close to system tray option
- In-app update checker powered by `electron-updater` and GitHub Releases

### Appearance Settings

- Accent color picker
- Notification duration (slider, 2–12 s)
- Notification width (slider, 260–520 px)
- Notification corner radius (slider, 0–30 px)
- Notification position (bottom-right / bottom-left / top-right / top-left)
- Scrollbar style (Default / Colored / Hidden)
- Scrollbar color picker (active when Colored is selected)

## Setup

1. Create a Twitch app at https://dev.twitch.tv/console/apps
2. Set the OAuth Redirect URL to `http://127.0.0.1` (loopback, any port)
3. Copy your Client ID
4. Install and run:

```bash
npm install
npm start
```

The Client ID field is hidden automatically when a `.env` file bundling `TWITCH_CLIENT_ID` is present.

## Notes

- `channel.follow` requires moderator scope on the channel. If you are the broadcaster, Twitch still requires the moderator-capable token context.
- No client secret is used or stored. Tokens are saved in Electron `userData` as `session.json`.
- Settings are persisted in Electron `userData` as `settings.json`.

## Building a distributable

```bash
npm run build
```

Output goes to `dist/`. The installer is a one-click NSIS `.exe`.

## GitHub Releases / Auto-updater

The app uses `electron-updater` to check for and install updates from GitHub Releases.

### One-time setup

In `package.json` under `build.publish`, replace the placeholders with your details:

```json
"publish": [
  {
    "provider": "github",
    "owner": "YourGitHubUsername",
    "repo": "YourRepoName",
    "releaseType": "release"
  }
]
```

Set a `GH_TOKEN` environment variable (GitHub Personal Access Token with `repo` scope) before publishing:

```bash
$env:GH_TOKEN = "ghp_..."
npm run build
```

Upload the generated `dist/*.exe` and `dist/latest.yml` to a tagged GitHub Release.

### In-app updater

Users can:
- Check for updates manually from the Settings panel.
- Download updates automatically when one is found.
- Click **Restart to Install** once the download finishes.

> The updater only works in packaged installs. It is silently skipped in `npm start` dev mode.
