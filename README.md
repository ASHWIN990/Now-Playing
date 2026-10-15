# Now-Playing

A tiny web app that shows what's currently playing on your Spotify account — album art, title, artist, album, a live progress bar and the playing device. Built to run as an always-on display on an old Android phone, served locally from the phone itself with Termux.

No build step, no dependencies: plain HTML, CSS and JavaScript.

## Features

- Current track or podcast episode, polled every 3 s, with a smoothly interpolated progress bar
- Three background modes, cycled with a **double tap**:
  - **Black** — pure black, ideal for OLED screens
  - **Album blur** — blurred album art behind everything
  - **Greyscale** — black background, greyscale art and accents
- **Synced lyrics** — **long press** to toggle a lyrics view with the current line highlighted and auto-scrolled (from [LRCLIB](https://lrclib.net); falls back to plain lyrics, and marks instrumentals)
- **Single tap** toggles fullscreen
- Portrait and landscape layouts
- Keeps the screen awake while visible (Screen Wake Lock API, where supported)
- Backs off polling while hidden and honours Spotify rate limits

## How it works

The app signs in with Spotify's **Authorization Code flow with PKCE**, entirely in the browser — no backend and no client secret. Tokens are stored in the browser's `localStorage` and refreshed automatically. Playback comes from [`GET /v1/me/player`](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback).

Spotify's API doesn't provide lyrics, so they come from [LRCLIB](https://lrclib.net), a free, open lyrics database (no key needed). Lyrics are matched by title, artist, album and duration, and synced to the locally interpolated playback position. Coverage depends on LRCLIB.

## Setup

### 1. Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and **Create app**.
2. Add the redirect URI **`http://127.0.0.1:8080/`** (exactly, including the trailing slash).
3. Tick **Web API** and save.
4. Copy the **Client ID**. The client secret is not needed.

> Spotify requires the owner of a development-mode app to have a Premium account.

### 2. Set the Client ID

Edit `DEFAULT_CLIENT_ID` near the top of `app.js`, or leave it empty and paste your Client ID into the setup screen on first launch. A Client ID is not a secret, but use your own rather than the one in this repo.

### 3a. Run on a computer

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://127.0.0.1:8080/> and click **Connect Spotify**.

### 3b. Run on an Android phone (Termux)

1. Install [Termux](https://github.com/termux/termux-app/releases) (and optionally [Termux:Boot](https://github.com/termux/termux-boot/releases) — both from the same source, GitHub or F-Droid, since their signatures must match).
2. Copy the app to the phone:
   ```sh
   adb shell mkdir -p /sdcard/spotify-monitor
   adb push index.html style.css app.js manifest.json icon.svg /sdcard/spotify-monitor/
   adb push termux/setup.sh termux/boot-setup.sh /sdcard/
   ```
3. Give Termux storage access (`termux-setup-storage`, or `adb shell pm grant com.termux android.permission.READ_EXTERNAL_STORAGE`).
4. In Termux, run:
   ```sh
   bash /sdcard/setup.sh
   ```
   This installs Python, creates `~/start-spotify-monitor.sh`, and starts the server on `127.0.0.1:8080` — reachable only from the phone itself. It also adds a line to `~/.bashrc` so the server starts whenever Termux is opened.
5. Open <http://127.0.0.1:8080/> in the phone's browser and connect Spotify.

#### Start on boot (optional)

With Termux:Boot installed and opened once, run in Termux:

```sh
bash /sdcard/boot-setup.sh
```

This installs `~/.termux/boot/start-spotify-monitor`, which starts the server when the phone boots.

On Huawei/EMUI and other aggressive battery managers, also allow Termux and Termux:Boot to auto-launch and run in the background (**Settings → Battery → App launch → Manage manually**), or the boot script won't run.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure: setup, login and player views |
| `style.css` | Layout, background modes, portrait/landscape |
| `app.js` | PKCE auth, token refresh, polling, rendering, gestures |
| `manifest.json`, `icon.svg` | Web app manifest and icon |
| `termux/setup.sh` | One-time Termux setup and server start |
| `termux/boot-setup.sh` | Installs the Termux:Boot start script |
