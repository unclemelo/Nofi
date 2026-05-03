const { app, BrowserWindow, ipcMain, shell, screen, Tray, Menu, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { TwitchService } = require("./twitchService");

const SESSION_FILE = "session.json";

let tray = null;
let isQuitting = false;

// Load .env from project root (dev) or resources folder (packaged build)
const ENV_BUNDLED_CLIENT_ID = (function loadEnv() {
  const candidates = [
    path.join(process.resourcesPath || "", ".env"),
    path.join(app.getAppPath(), ".env")
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eqIdx = trimmed.indexOf("=");
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "TWITCH_CLIENT_ID") return val;
      }
    } catch {
      // Try next candidate.
    }
  }
  return "";
})();
const TWITCH_AUTH_BASE = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_USERS_URL = "https://api.twitch.tv/helix/users";

let mainWindow;
let overlayWindow;
let twitchService;
let updaterInitialized = false;

let updateStatus = {
  state: "idle",
  message: "Update status unavailable.",
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: null,
  canInstall: false,
  isSupported: false
};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    frame: false,
    icon: path.join(__dirname, "img", "icon.png"),
    backgroundColor: "#0f1a22",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("maximize", () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("window:maximizeChange", true);
  });
  mainWindow.on("unmaximize", () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("window:maximizeChange", false);
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    const settings = loadSettingsFile();
    if (settings?.closeToTray === false) {
      // User wants real close: destroy overlay and let app quit.
      isQuitting = true;
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
      return;
    }
    // Default: hide to tray.
    event.preventDefault();
    mainWindow.hide();
    if (!settings?.hasSeenTrayNotice && tray) {
      try {
        tray.displayBalloon({
          iconType: "info",
          title: "Nofi",
          content: "Still running in the background. Right-click the tray icon to quit."
        });
      } catch { /* displayBalloon is Windows-only */ }
      writeSettingsFile({ ...(settings || {}), hasSeenTrayNotice: true });
    }
  });
}

function createOverlayWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const height = 240;

  overlayWindow = new BrowserWindow({
    x: area.x,
    y: area.y + area.height - height,
    width: area.width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  overlayWindow.once("ready-to-show", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive();
      overlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
    }
  });

  // Periodically re-assert always-on-top so Windows doesn't drop it behind other apps.
  setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
    }
  }, 2000);
}

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createOverlayWindow();
    }
  });

  screen.on("display-metrics-changed", () => { repositionOverlayWindow(); });
  screen.on("display-added", () => { repositionOverlayWindow(); });
  screen.on("display-removed", () => { repositionOverlayWindow(); });
});

app.on("before-quit", () => { isQuitting = true; });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("auth:getSession", async () => {
  return loadSession();
});

ipcMain.handle("updater:getStatus", async () => {
  return updateStatus;
});

ipcMain.handle("updater:check", async () => {
  await checkForAppUpdates({ manual: true });
  return updateStatus;
});

ipcMain.handle("updater:install", async () => {
  if (!updateStatus.canInstall) {
    return { ok: false, message: "No downloaded update is ready yet." };
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });

  return { ok: true };
});

ipcMain.handle("config:getClientId", () => {
  return ENV_BUNDLED_CLIENT_ID || "";
});

ipcMain.handle("auth:logout", async () => {
  await stopTwitchService();
  saveSession(null);
  return { ok: true };
});

ipcMain.handle("auth:start", async (_event, config) => {
  // Use bundled .env client ID if the renderer didn't supply one
  const clientId = String(config?.clientId || ENV_BUNDLED_CLIENT_ID || "").trim();
  const scopes = Array.isArray(config?.scopes)
    ? config.scopes.map((value) => String(value).trim()).filter(Boolean)
    : [];

  if (!clientId) {
    throw new Error("Missing Twitch Client ID.");
  }

  const auth = await runImplicitAuth({ clientId, scopes });
  const session = { auth };
  saveSession(session);
  return auth;
});

ipcMain.handle("twitch:connect", async (_event, settings) => {
  const session = loadSession();
  if (!session?.auth?.accessToken || !session?.auth?.clientId) {
    throw new Error("No Twitch session found. Please login first.");
  }

  if (!settings?.channel) {
    throw new Error("Channel is required.");
  }

  await stopTwitchService();

  twitchService = new TwitchService({
    clientId: session.auth.clientId,
    token: session.auth.accessToken,
    login: session.auth.login,
    channel: settings.channel,
    eventFilters: settings.eventFilters || {},
    onEvent: (payload) => {
      broadcastOverlayEvent(payload);
    },
    onTokenExpired: () => {
      broadcastOverlayEvent({
        type: "system",
        title: "Session Expired",
        message: "Your Twitch token expired. Please login again."
      });
    }
  });

  await twitchService.start();

  return {
    ok: true,
    channel: settings.channel
  };
});

ipcMain.handle("twitch:disconnect", async () => {
  await stopTwitchService();
  return { ok: true };
});

ipcMain.handle("overlay:testNotification", async () => {
  const payload = {
    type: "chat",
    title: "Test Notification",
    message: "This is your click-through bottom overlay test.",
    actorName: "Test Viewer",
    profileImageUrl: "../img/icon.png"
  };
  broadcastOverlayEvent(payload);
  return { ok: true };
});

ipcMain.handle("overlay:testNotificationByType", async (_event, type) => {
  const normalizedType = String(type || "chat").toLowerCase();
  const profileImageUrl = "../img/icon.png";

  const templates = {
    chat: {
      type: "chat",
      title: "#channel Chat",
      message: "TestViewer: hello chat this is a test message!",
      actorName: "TestViewer",
      actorColor: "#00c7ac"
    },
    follow: {
      type: "follow",
      title: "New Follow",
      message: "FollowTester followed your channel.",
      actorName: "FollowTester"
    },
    sub: {
      type: "sub",
      title: "New Subscriber",
      message: "SubTester subscribed at tier 1000.",
      actorName: "SubTester"
    },
    gift: {
      type: "gift",
      title: "Gift Subs",
      message: "GiftTester gifted 5 subscription(s)!",
      actorName: "GiftTester"
    },
    bits: {
      type: "bits",
      title: "Bits Cheer",
      message: "CheerTester cheered 500 bits! PogChamp",
      actorName: "CheerTester",
      actorColor: "#ff7f50"
    },
    shared: {
      type: "chat",
      title: "SharedViewer",
      message: "hey this message is from a shared chat!",
      actorName: "SharedViewer",
      actorColor: "#b16cff",
      sourceChannelLogin: "otherstreamer",
      sourceChannelImageUrl: "../img/icon.png"
    },
    redeem: {
      type: "redeem",
      title: "Hydrate!",
      message: "RedeemTester redeemed for 500 points",
      actorName: "RedeemTester",
      actorColor: "#f5a623"
    }
  };

  const payload = {
    ...(templates[normalizedType] || templates.chat),
    profileImageUrl
  };

  broadcastOverlayEvent(payload);
  return { ok: true, type: payload.type };
});

async function stopTwitchService() {
  if (twitchService) {
    await twitchService.stop();
    twitchService = null;
  }
}

function runImplicitAuth({ clientId, scopes }) {
  return new Promise((resolve, reject) => {
    const state = randomBase64Url(18);

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url, "http://localhost:5555");

        // Step 1: Twitch redirects here with token in the URL fragment.
        // The HTTP server can't read the fragment, so serve a small HTML
        // page that moves it into a query param and calls /token.
        if (requestUrl.pathname === "/callback") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body><script>
            const hash = location.hash.slice(1);
            if (hash) {
              location.replace('/token?' + hash);
            } else {
              document.body.textContent = 'No token received.';
            }
          <\/script></body></html>`);
          return;
        }

        // Step 2: HTML page redirected here with token as query params.
        if (requestUrl.pathname === "/token") {
          const accessToken = requestUrl.searchParams.get("access_token");
          const incomingState = requestUrl.searchParams.get("state");
          const error = requestUrl.searchParams.get("error");

          if (error) {
            throw new Error(`OAuth error: ${error} — ${requestUrl.searchParams.get("error_description") || ""}`);
          }

          if (!accessToken) {
            throw new Error("No access token received from Twitch.");
          }

          if (incomingState !== state) {
            throw new Error("OAuth state mismatch. Possible CSRF attempt.");
          }

          const user = await fetchMe(clientId, accessToken);

          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Login complete — Nofi</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Segoe UI", "Trebuchet MS", sans-serif;
    background: linear-gradient(135deg, #0b1218 0%, #111d26 60%, #0d171f 100%);
    color: #dfe9ef;
  }
  .card {
    text-align: center;
    padding: 52px 56px;
    border: 1px solid #264559;
    border-radius: 16px;
    background: linear-gradient(180deg, #12212bcc, #101c24cc);
    box-shadow: 0 24px 60px rgba(0,0,0,0.55);
    backdrop-filter: blur(6px);
    max-width: 440px;
    width: 90vw;
    animation: fadeUp 420ms ease both;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(18px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .check-ring {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: #1a3a28;
    border: 2px solid #66d08f;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 26px;
    font-size: 2rem;
    color: #66d08f;
  }
  h1 {
    font-size: 1.45rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin-bottom: 10px;
  }
  p {
    color: #8ca3b6;
    font-size: 0.95rem;
    line-height: 1.6;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 28px;
    padding: 7px 16px;
    border-radius: 999px;
    background: #1a1a2e;
    border: 1px solid #9147ff55;
    color: #bf94ff;
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.06em;
  }
  .badge svg { width: 14px; height: 14px; fill: #9147ff; }
</style>
</head>
<body>
  <div class="card">
    <div class="check-ring">&#10003;</div>
    <h1>Logged in successfully</h1>
    <p>You're connected to Twitch.<br />You can close this tab and return to Steam&nbsp;Noti&nbsp;Overlay.</p>
    <div class="badge">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M11.64 5.93h1.43v4.28h-1.43m3.93-4.28H17v4.28h-1.43M7 2L3.43 5.57v12.86h4.28V22l3.58-3.57h2.85L20.57 12V2m-1.43 9.29-2.85 2.85h-2.86l-2.5 2.5v-2.5H7.71V3.43h11.43z"/>
      </svg>
      TWITCH
    </div>
  </div>
</body>
</html>`);

          const auth = {
            clientId,
            accessToken,
            refreshToken: null,
            scope: (requestUrl.searchParams.get("scope") || "").split("+"),
            obtainedAt: Date.now(),
            userId: user.id,
            login: user.login,
            displayName: user.display_name,
            profileImageUrl: user.profile_image_url
          };

          resolve(auth);
          server.close();
          return;
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(String(error.message || error));
        reject(error);
        server.close();
      }
    });

    server.on("error", reject);

    server.listen(5555, "127.0.0.1", () => {
      const authUrl = new URL(TWITCH_AUTH_BASE);
      authUrl.searchParams.set("response_type", "token");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", "http://localhost:5555/callback");
      authUrl.searchParams.set("scope", scopes.join(" "));
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("force_verify", "true");

      shell.openExternal(authUrl.toString());
    });
  });
}

async function fetchMe(clientId, accessToken) {
  const response = await fetch(TWITCH_USERS_URL, {
    headers: {
      "Client-Id": clientId,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load user profile: ${response.status} ${text}`);
  }

  const json = await response.json();
  if (!json?.data?.[0]) {
    throw new Error("No user profile returned by Twitch.");
  }

  return json.data[0];
}

function getSessionFilePath() {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

function loadSession() {
  try {
    const filePath = getSessionFilePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(session) {
  const filePath = getSessionFilePath();
  if (!session) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
}

function randomBase64Url(size) {
  return crypto.randomBytes(size).toString("base64url");
}

// ─── Settings persistence ─────────────────────────────────────────────────────

const SETTINGS_FILE = "settings.json";

function getSettingsFilePath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function loadSettingsFile() {
  try {
    const fp = getSettingsFilePath();
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, "utf8"));
    }
  } catch {
    // Ignore corrupt settings; fall back to defaults.
  }
  return null;
}

function writeSettingsFile(settings) {
  try {
    fs.writeFileSync(getSettingsFilePath(), JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // Ignore write errors.
  }
}

ipcMain.handle("settings:load", () => {
  return loadSettingsFile();
});

ipcMain.handle("settings:save", (_event, settings) => {
  if (!settings || typeof settings !== "object") return { ok: false };
  writeSettingsFile(settings);
  // Push live update to the overlay window so changes apply immediately.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("settings:update", settings);
  }
  return { ok: true };
});

// ─── Window control IPC ───────────────────────────────────────────────────────

ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
ipcMain.handle("window:maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); } else { mainWindow.maximize(); }
  return mainWindow.isMaximized();
});
ipcMain.handle("window:close", () => { mainWindow?.close(); });
ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createColorIcon(hex, size = 16) {
  const { deflateSync } = require("node:zlib");
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const row = y * rowLen;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 1 + x * 3 + 1] = g;
      raw[row + 1 + x * 3 + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, "img", "icon.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createFromBuffer(createColorIcon("#9147ff"));
  tray = new Tray(icon);
  tray.setToolTip("Nofi");
  const menu = Menu.buildFromTemplate([
    {
      label: "Show App",
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => { app.quit(); }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

function broadcastOverlayEvent(payload) {
  console.log("[main] broadcastOverlayEvent type=%s", payload.type);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("overlay:event", payload);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:event", payload);
  }
}

function broadcastUpdateStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("update:status", updateStatus);
}

function setUpdateStatus(patch) {
  updateStatus = {
    ...updateStatus,
    ...patch
  };
  broadcastUpdateStatus();
}

function setupAutoUpdater() {
  if (updaterInitialized) {
    return;
  }
  updaterInitialized = true;

  if (!app.isPackaged) {
    setUpdateStatus({
      state: "disabled",
      isSupported: false,
      canInstall: false,
      message: "Updates are available in installed builds."
    });
    return;
  }

  setUpdateStatus({
    isSupported: true,
    message: "Ready to check for updates."
  });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({
      state: "checking",
      availableVersion: null,
      progress: null,
      canInstall: false,
      message: "Checking GitHub for updates..."
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateStatus({
      state: "downloading",
      availableVersion: info?.version || null,
      canInstall: false,
      message: `Update ${info?.version || "available"} found. Downloading now...`
    });
  });

  autoUpdater.on("update-not-available", () => {
    setUpdateStatus({
      state: "up-to-date",
      availableVersion: null,
      progress: null,
      canInstall: false,
      message: "You are up to date."
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Number(progress?.percent || 0);
    setUpdateStatus({
      state: "downloading",
      progress: percent,
      canInstall: false,
      message: `Downloading update... ${percent.toFixed(1)}%`
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setUpdateStatus({
      state: "downloaded",
      availableVersion: info?.version || updateStatus.availableVersion,
      progress: 100,
      canInstall: true,
      message: "Update downloaded. Restart app to install."
    });
  });

  autoUpdater.on("error", (error) => {
    const message = error?.message || "Unknown updater error";
    setUpdateStatus({
      state: "error",
      canInstall: false,
      message: `Updater error: ${message}`
    });
  });

  checkForAppUpdates({ manual: false }).catch(() => {
    // Initial check failures are surfaced through status events.
  });
}

async function checkForAppUpdates({ manual }) {
  if (!app.isPackaged) {
    setUpdateStatus({
      state: "disabled",
      isSupported: false,
      canInstall: false,
      message: "Updates are available in installed builds."
    });
    return;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error?.message || "Could not check for updates.";
    setUpdateStatus({
      state: "error",
      canInstall: false,
      message: manual ? `Update check failed: ${message}` : `Updater error: ${message}`
    });
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function repositionOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const area = screen.getPrimaryDisplay().workArea;
  const height = 240;
  overlayWindow.setBounds({
    x: area.x,
    y: area.y + area.height - height,
    width: area.width,
    height
  });
}
