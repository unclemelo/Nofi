const authStatus = document.getElementById("authStatus");
const clientIdInput = document.getElementById("clientId");
const channelInput = document.getElementById("channelName");
const loginBtn = document.getElementById("loginBtn");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const logoutBtn = document.getElementById("logoutBtn");
const minimizeBtn = document.getElementById("minimizeBtn");
const maximizeBtn = document.getElementById("maximizeBtn");
const closeBtn = document.getElementById("closeBtn");
const testChatBtn = document.getElementById("testChatBtn");
const testFollowBtn = document.getElementById("testFollowBtn");
const testSubBtn = document.getElementById("testSubBtn");
const testGiftBtn = document.getElementById("testGiftBtn");
const testBitsBtn = document.getElementById("testBitsBtn");
const testSharedBtn = document.getElementById("testSharedBtn");
const testRedeemBtn = document.getElementById("testRedeemBtn");
const autoConnectToggle = document.getElementById("autoConnectToggle");
const soundToggle = document.getElementById("soundToggle");
const closeToTrayToggle = document.getElementById("closeToTrayToggle");
const nameColorAccentToggle = document.getElementById("nameColorAccentToggle");
const accentColorPicker = document.getElementById("accentColorPicker");
const durationSlider = document.getElementById("durationSlider");
const durationLabel = document.getElementById("durationLabel");
const widthSlider = document.getElementById("widthSlider");
const widthLabel = document.getElementById("widthLabel");
const radiusSlider = document.getElementById("radiusSlider");
const radiusLabel = document.getElementById("radiusLabel");
const positionSelect = document.getElementById("positionSelect");
const scrollbarModeSelect = document.getElementById("scrollbarModeSelect");
const scrollbarColorPicker = document.getElementById("scrollbarColorPicker");
const feed = document.getElementById("feed");
const checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
const installUpdateBtn = document.getElementById("installUpdateBtn");
const updateStatusText = document.getElementById("updateStatusText");
const updateVersionText = document.getElementById("updateVersionText");

const toggles = {
  chat: document.getElementById("chatEnabled"),
  follow: document.getElementById("followEnabled"),
  sub: document.getElementById("subEnabled"),
  gift: document.getElementById("giftEnabled"),
  bits: document.getElementById("bitsEnabled"),
  redeem: document.getElementById("redeemEnabled")
};

let session = null;
let disconnectOverlayEvents = null;
let disconnectUpdaterStatus = null;
let bundledClientId = "";
let isConnected = false;

const defaultScopes = [
  "chat:read",
  "moderator:read:followers",
  "channel:read:subscriptions",
  "bits:read",
  "channel:read:redemptions"
];

init();

async function init() {
  try {
    bundledClientId = await window.overlayAPI.getBundledClientId();

    if (bundledClientId) {
      clientIdInput.value = bundledClientId;
      const fieldEl = clientIdInput.closest(".field");
      if (fieldEl) fieldEl.classList.add("field--hidden");
    }

    session = await window.overlayAPI.getSession();
    if (!bundledClientId && session?.auth?.clientId) {
      clientIdInput.value = session.auth.clientId;
    }
    if (session?.auth?.login) {
      channelInput.value = session.auth.login;
    }
    renderAuthStatus();

    // Load persisted settings and apply to UI controls.
    const savedSettings = await window.overlayAPI.loadSettings();
    applySettingsToUI(savedSettings);

    // Auto-connect if the user enabled that option and a session exists.
    if (savedSettings?.autoConnect && session?.auth?.accessToken) {
      const channel = (savedSettings.lastChannel || session.auth.login || "").trim();
      if (channel) {
        const eventFilters = savedSettings.lastEventFilters ||
          { chat: true, follow: true, sub: true, gift: true, bits: true, redeem: true };
        channelInput.value = channel;
        if (eventFilters.chat !== undefined) toggles.chat.checked = eventFilters.chat;
        if (eventFilters.follow !== undefined) toggles.follow.checked = eventFilters.follow;
        if (eventFilters.sub !== undefined) toggles.sub.checked = eventFilters.sub;
        if (eventFilters.gift !== undefined) toggles.gift.checked = eventFilters.gift;
        if (eventFilters.bits !== undefined) toggles.bits.checked = eventFilters.bits;
        if (eventFilters.redeem !== undefined) toggles.redeem.checked = eventFilters.redeem;
        try {
          const result = await window.overlayAPI.connectTwitch({ channel, eventFilters });
          authStatus.textContent = `Auto-connected as ${session.auth.login} → #${result.channel}`;
          isConnected = true;
        } catch (e) {
          authStatus.textContent = `Auto-connect failed: ${e.message}`;
        }
        renderAuthStatus();
      }
    }

    disconnectOverlayEvents = window.overlayAPI.onEvent((event) => {
      if (!isEventEnabled(event.type)) {
        return;
      }
      pushFeedItem(event);
    });

    await initUpdaterUI();
  } catch (error) {
    authStatus.textContent = `Error initializing app: ${error.message}`;
  }
}

async function initUpdaterUI() {
  if (!window.overlayAPI?.updater || !checkUpdatesBtn || !installUpdateBtn) {
    return;
  }

  checkUpdatesBtn.addEventListener("click", async () => {
    checkUpdatesBtn.disabled = true;
    updateStatusText.textContent = "Checking for updates...";
    try {
      const status = await window.overlayAPI.updater.check();
      renderUpdaterStatus(status);
    } catch (error) {
      updateStatusText.textContent = `Update check failed: ${error.message}`;
    } finally {
      checkUpdatesBtn.disabled = false;
    }
  });

  installUpdateBtn.addEventListener("click", async () => {
    installUpdateBtn.disabled = true;
    try {
      const result = await window.overlayAPI.updater.install();
      if (!result?.ok) {
        updateStatusText.textContent = result?.message || "No downloaded update is ready yet.";
        installUpdateBtn.disabled = false;
      }
    } catch (error) {
      updateStatusText.textContent = `Install failed: ${error.message}`;
      installUpdateBtn.disabled = false;
    }
  });

  const initialStatus = await window.overlayAPI.updater.getStatus();
  renderUpdaterStatus(initialStatus);

  disconnectUpdaterStatus = window.overlayAPI.updater.onStatus((status) => {
    renderUpdaterStatus(status);
  });
}

function renderUpdaterStatus(status) {
  if (!status) {
    return;
  }

  const currentVersion = status.currentVersion ? `v${status.currentVersion}` : "unknown";
  const availableVersion = status.availableVersion ? ` -> v${status.availableVersion}` : "";
  updateVersionText.textContent = `Version ${currentVersion}${availableVersion}`;

  updateStatusText.textContent = status.message || "Updater status unavailable.";

  if (status.state === "downloading" && typeof status.progress === "number") {
    updateStatusText.textContent = `Downloading update... ${status.progress.toFixed(1)}%`;
  }

  const checkingOrDownloading = status.state === "checking" || status.state === "downloading";
  checkUpdatesBtn.disabled = checkingOrDownloading;
  checkUpdatesBtn.style.display = status.isSupported === false ? "none" : "";

  const canInstall = !!status.canInstall;
  installUpdateBtn.style.display = canInstall ? "" : "none";
  if (!canInstall) {
    installUpdateBtn.disabled = false;
  }
}

loginBtn.addEventListener("click", async () => {
  const clientId = (bundledClientId || clientIdInput.value).trim();
  if (!clientId) {
    authStatus.textContent = "Client ID is required.";
    return;
  }

  loginBtn.disabled = true;
  authStatus.textContent = "Opening Twitch login...";

  try {
    const auth = await window.overlayAPI.startAuth({
      clientId,
      scopes: defaultScopes
    });
    session = { auth };
    if (!channelInput.value.trim()) {
      channelInput.value = auth.login;
    }
    renderAuthStatus();
  } catch (error) {
    authStatus.textContent = `Login failed: ${error.message}`;
  } finally {
    loginBtn.disabled = false;
  }
});

connectBtn.addEventListener("click", async () => {
  if (!session?.auth?.accessToken) {
    authStatus.textContent = "Log in with Twitch first.";
    return;
  }

  const channel = channelInput.value.trim().replace(/^#/, "");
  if (!channel) {
    authStatus.textContent = "Enter a channel name.";
    return;
  }

  connectBtn.disabled = true;
  try {
    const eventFilters = getEventFilters();
    const result = await window.overlayAPI.connectTwitch({ channel, eventFilters });
    authStatus.textContent = `Connected as ${session.auth.login} -> #${result.channel}`;
    isConnected = true;
    renderAuthStatus();
    // Persist channel + filters so auto-connect works next boot.
    await persistConnectSettings(channel, eventFilters);
  } catch (error) {
    authStatus.textContent = `Connect failed: ${error.message}`;
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", async () => {
  try {
    await window.overlayAPI.disconnectTwitch();
    isConnected = false;
    renderAuthStatus();
  } catch (error) {
    authStatus.textContent = `Disconnect failed: ${error.message}`;
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await window.overlayAPI.logout();
    session = null;
    isConnected = false;
    renderAuthStatus();
  } catch (error) {
    authStatus.textContent = `Logout failed: ${error.message}`;
  }
});

testChatBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("chat");
});

testFollowBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("follow");
});

testSubBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("sub");
});

testGiftBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("gift");
});

testBitsBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("bits");
});

testSharedBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("shared");
});

testRedeemBtn.addEventListener("click", () => {
  window.overlayAPI.emitTestNotificationByType("redeem");
});

// Wire settings controls — save immediately on any change.
autoConnectToggle.addEventListener("change", saveSettingsFromUI);
soundToggle.addEventListener("change", saveSettingsFromUI);
closeToTrayToggle.addEventListener("change", saveSettingsFromUI);
nameColorAccentToggle.addEventListener("change", saveSettingsFromUI);
accentColorPicker.addEventListener("input", saveSettingsFromUI);
durationSlider.addEventListener("input", () => { updateDurationLabel(); saveSettingsFromUI(); });
widthSlider.addEventListener("input", () => { updateWidthLabel(); saveSettingsFromUI(); });
radiusSlider.addEventListener("input", () => { updateRadiusLabel(); saveSettingsFromUI(); });
positionSelect.addEventListener("change", saveSettingsFromUI);
scrollbarModeSelect.addEventListener("change", saveSettingsFromUI);
scrollbarColorPicker.addEventListener("input", saveSettingsFromUI);

function updateDurationLabel() {
  durationLabel.textContent = (parseInt(durationSlider.value, 10) / 1000).toFixed(1) + "s";
}

function updateWidthLabel() {
  widthLabel.textContent = widthSlider.value + "px";
}

function updateRadiusLabel() {
  radiusLabel.textContent = radiusSlider.value + "px";
}

function applyScrollbarSettings(settings) {
  const mode = settings?.scrollbarMode || "default";
  const color = settings?.scrollbarColor || "#4ec5ff";
  document.body.classList.toggle("scrollbars-hidden", mode === "hidden");
  document.body.classList.toggle("scrollbars-colored", mode === "colored");
  document.documentElement.style.setProperty("--scrollbar-thumb", color);
}

function applyToastRadiusSetting(settings) {
  const radius = settings?.toastRadius ?? 10;
  document.documentElement.style.setProperty("--toast-radius", radius + "px");
}

function applySettingsToUI(settings) {
  if (!settings) return;
  if (settings.autoConnect !== undefined) autoConnectToggle.checked = !!settings.autoConnect;
  if (settings.soundEnabled !== undefined) soundToggle.checked = !!settings.soundEnabled;
  if (settings.closeToTray !== undefined) closeToTrayToggle.checked = !!settings.closeToTray;
  else closeToTrayToggle.checked = true; // default on
  if (settings.useNameColorAccent !== undefined) nameColorAccentToggle.checked = !!settings.useNameColorAccent;
  else nameColorAccentToggle.checked = false;
  if (settings.accentColor) accentColorPicker.value = settings.accentColor;
  if (settings.toastDuration) {
    durationSlider.value = settings.toastDuration;
    updateDurationLabel();
  }
  if (settings.toastWidth) {
    widthSlider.value = settings.toastWidth;
    updateWidthLabel();
  }
  if (settings.toastRadius !== undefined) {
    radiusSlider.value = settings.toastRadius;
    updateRadiusLabel();
  }
  if (settings.toastPosition) positionSelect.value = settings.toastPosition;
  if (settings.scrollbarMode) scrollbarModeSelect.value = settings.scrollbarMode;
  if (settings.scrollbarColor) scrollbarColorPicker.value = settings.scrollbarColor;
  applyScrollbarSettings(settings);
  applyToastRadiusSetting(settings);
}

function gatherSettingsFromUI() {
  return {
    autoConnect: autoConnectToggle.checked,
    soundEnabled: soundToggle.checked,
    closeToTray: closeToTrayToggle.checked,
    useNameColorAccent: nameColorAccentToggle.checked,
    accentColor: accentColorPicker.value,
    toastDuration: parseInt(durationSlider.value, 10),
    toastWidth: parseInt(widthSlider.value, 10),
    toastRadius: parseInt(radiusSlider.value, 10),
    toastPosition: positionSelect.value,
    scrollbarMode: scrollbarModeSelect.value,
    scrollbarColor: scrollbarColorPicker.value,
    lastChannel: channelInput.value.trim().replace(/^#/, ""),
    lastEventFilters: getEventFilters()
  };
}

async function saveSettingsFromUI() {
  const settings = gatherSettingsFromUI();
  applyScrollbarSettings(settings);
  applyToastRadiusSetting(settings);
  await window.overlayAPI.saveSettings(settings);
}

async function persistConnectSettings(channel, eventFilters) {
  const current = await window.overlayAPI.loadSettings() || {};
  await window.overlayAPI.saveSettings({
    ...current,
    lastChannel: channel,
    lastEventFilters: eventFilters
  });
}

// ── Titlebar window controls ───────────────────────────────────────────────

minimizeBtn.addEventListener("click", () => window.overlayAPI.windowControls.minimize());
maximizeBtn.addEventListener("click", () => window.overlayAPI.windowControls.maximize());
closeBtn.addEventListener("click", () => window.overlayAPI.windowControls.close());

window.overlayAPI.windowControls.onMaximizeChange((isMaximized) => {
  const icon = maximizeBtn.querySelector("i");
  if (icon) icon.className = isMaximized ? "fa-regular fa-window-restore" : "fa-regular fa-square";
});

// Set initial maximize icon state.
window.overlayAPI.windowControls.isMaximized().then((isMaximized) => {
  const icon = maximizeBtn.querySelector("i");
  if (icon) icon.className = isMaximized ? "fa-regular fa-window-restore" : "fa-regular fa-square";
});

// ─────────────────────────────────────────────────────────────────

function renderAuthStatus() {
  const loggedIn = !!session?.auth;

  // Login button: only visible when not logged in.
  loginBtn.style.display = loggedIn ? "none" : "";

  // Enable Overlay: only visible when logged in and not yet connected.
  connectBtn.style.display = (loggedIn && !isConnected) ? "" : "none";

  // Disable: only visible when connected.
  disconnectBtn.style.display = isConnected ? "" : "none";

  // Logout: only visible when logged in.
  logoutBtn.style.display = loggedIn ? "" : "none";

  if (!loggedIn) {
    authStatus.textContent = "Not logged in — click Login with Twitch to start.";
  } else if (isConnected) {
    authStatus.textContent = `\u2022 Live as ${session.auth.displayName || session.auth.login}`;
    authStatus.style.color = "#66d08f";
  } else {
    authStatus.textContent = `Logged in as ${session.auth.displayName || session.auth.login} — click Enable Overlay`;
    authStatus.style.color = "";
  }
}

function getEventFilters() {
  return {
    chat: toggles.chat.checked,
    follow: toggles.follow.checked,
    sub: toggles.sub.checked,
    gift: toggles.gift.checked,
    bits: toggles.bits.checked,
    redeem: toggles.redeem.checked
  };
}

function isEventEnabled(type) {
  if (type === "chat") return toggles.chat.checked;
  if (type === "follow") return toggles.follow.checked;
  if (type === "sub") return toggles.sub.checked;
  if (type === "gift") return toggles.gift.checked;
  if (type === "bits") return toggles.bits.checked;
  if (type === "redeem") return toggles.redeem.checked;
  return true;
}

function pushFeedItem(event) {
  const item = document.createElement("article");
  item.className = "feed-item";
  const title = sanitizeText(event.title || event.type || "Notification");
  const msg = renderWithEmotes(event.message || "", event.emotes);
  const actor = sanitizeText(event.actorName || "Unknown user");
  const profileImage = sanitizeText(event.profileImageUrl || "");
  const badges = renderBadges(event.badgeImages);

  const accent = nameColorAccentToggle.checked && isValidHexColor(event.actorColor)
    ? event.actorColor
    : accentColorPicker.value;
  item.style.borderLeftColor = accent;

  item.innerHTML = `
    <h3>${badges}${title}</h3>
    <p>${msg}</p>
    <p><strong>User:</strong> ${actor}${profileImage ? " | avatar attached" : ""}</p>
  `;
  feed.prepend(item);

  const children = Array.from(feed.children);
  if (children.length > 120) {
    children.slice(120).forEach((node) => node.remove());
  }
}

function isValidHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function renderBadges(badgeImages) {
  if (!Array.isArray(badgeImages) || badgeImages.length === 0) {
    return "";
  }

  return badgeImages
    .map((badge) => {
      const src = sanitizeText(badge.imageUrl || "");
      const setId = sanitizeText(badge.setId || "badge");
      const version = sanitizeText(badge.version || "");
      if (!src) {
        return "";
      }
      return `<img class="name-badge" src="${src}" alt="${setId}" title="${setId}${version ? ` ${version}` : ""}" loading="lazy" />`;
    })
    .join("");
}

function sanitizeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderWithEmotes(rawMessage, emotes) {
  if (!emotes || typeof emotes !== "object") {
    return sanitizeText(rawMessage);
  }

  const spans = [];
  for (const [emoteId, positions] of Object.entries(emotes)) {
    const safeId = encodeURIComponent(emoteId);
    for (const pos of positions) {
      const [start, end] = pos.split("-").map(Number);
      spans.push({ start, end, safeId });
    }
  }

  if (spans.length === 0) {
    return sanitizeText(rawMessage);
  }

  spans.sort((a, b) => a.start - b.start);

  let html = "";
  let cursor = 0;
  for (const { start, end, safeId } of spans) {
    if (start > cursor) {
      html += sanitizeText(rawMessage.slice(cursor, start));
    }
    const emoteName = sanitizeText(rawMessage.slice(start, end + 1));
    html += `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${safeId}/default/dark/1.0" alt="${emoteName}" title="${emoteName}" />`;
    cursor = end + 1;
  }
  if (cursor < rawMessage.length) {
    html += sanitizeText(rawMessage.slice(cursor));
  }

  return html;
}

window.addEventListener("beforeunload", () => {
  if (disconnectOverlayEvents) {
    disconnectOverlayEvents();
  }
  if (disconnectUpdaterStatus) {
    disconnectUpdaterStatus();
  }
});
