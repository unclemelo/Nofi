const toastStack = document.getElementById("toastStack");

let audioContext = null;

// ── Settings ───────────────────────────────────────────────────────────────

let currentSettings = {
  accentColor: "#66c0f4",
  toastDuration: 5200,
  toastPosition: "bottom-right",
  soundEnabled: true,
  toastWidth: 380,
  toastRadius: 10,
  useNameColorAccent: false
};

function applySettings(settings) {
  if (!settings) return;
  currentSettings = { ...currentSettings, ...settings };
  const root = document.documentElement;
  root.style.setProperty("--accent", currentSettings.accentColor || "#66c0f4");
  root.style.setProperty("--toast-width", (currentSettings.toastWidth || 380) + "px");
  root.style.setProperty("--toast-radius", (currentSettings.toastRadius ?? 10) + "px");
  const overlayRoot = document.querySelector(".overlay-root");
  if (overlayRoot) {
    const [vert, horiz] = (currentSettings.toastPosition || "bottom-right").split("-");
    overlayRoot.style.alignItems = vert === "top" ? "flex-start" : "flex-end";
    overlayRoot.style.justifyContent = horiz === "left" ? "flex-start" : "flex-end";
  }
}

// Load saved settings on startup.
window.overlayAPI.loadSettings().then(applySettings).catch(() => {});

// React to live changes from the settings panel.
window.overlayAPI.onSettingsUpdate(applySettings);

// ─────────────────────────────────────────────────────────────────────────

const disconnectOverlayEvents = window.overlayAPI.onEvent((event) => {
  console.log("[overlay] received event type=%s", event.type);
  pushToast(event);
  playNotificationSound();
});

function pushToast(event) {
  const toast = document.createElement("div");
  toast.className = "toast";

  const accent = currentSettings.useNameColorAccent && isValidHexColor(event.actorColor)
    ? event.actorColor
    : (currentSettings.accentColor || "#66c0f4");
  toast.style.borderLeftColor = accent;

  const title = sanitizeText(event.title || "Twitch Event");
  const titleBadges = renderBadges(event.badgeImages);
  const message = renderWithEmotes(event.message || "", event.emotes);
  const actorName = sanitizeText(event.actorName || "Viewer");
  const fallbackImage = "../img/icon.png";
  const profileImageUrl = sanitizeText(event.profileImageUrl || fallbackImage);

  const sourceChannelLogin = event.sourceChannelLogin
    ? sanitizeText(event.sourceChannelLogin)
    : null;
  const sourceChannelImageUrl = event.sourceChannelImageUrl
    ? sanitizeText(event.sourceChannelImageUrl)
    : null;

  const sourceBadge = sourceChannelImageUrl
    ? `<img class="toast-source-icon" src="${sourceChannelImageUrl}" alt="#${sourceChannelLogin}" title="from #${sourceChannelLogin}" loading="lazy" />`
    : "";

  toast.innerHTML = `
    <div class="toast-row">
      <div class="toast-avatar-wrap">
        <img class="toast-avatar" src="${profileImageUrl}" alt="${actorName}" loading="lazy" />
        ${sourceBadge}
      </div>
      <div class="toast-content">
        <h4>${titleBadges}${title}</h4>
        <p>${message}</p>
      </div>
    </div>
  `;
  toastStack.prepend(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    toast.style.transition = "all 180ms ease";
    setTimeout(() => toast.remove(), 220);
  }, currentSettings.toastDuration);

  const children = Array.from(toastStack.children);
  if (children.length > 6) {
    children.slice(6).forEach((node) => node.remove());
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

function playNotificationSound() {
  if (!currentSettings.soundEnabled) return;
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {
      // Ignore resume failures.
    });
  }

  const notes = [
    { freq: 587.33, at: 0.0, gain: 0.11 },
    { freq: 783.99, at: 0.08, gain: 0.1 },
    { freq: 987.77, at: 0.16, gain: 0.09 }
  ];

  notes.forEach((note) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = "triangle";
    osc.frequency.value = note.freq;

    gain.gain.setValueAtTime(0, audioContext.currentTime + note.at);
    gain.gain.linearRampToValueAtTime(note.gain, audioContext.currentTime + note.at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + note.at + 0.24);

    osc.connect(gain).connect(audioContext.destination);
    osc.start(audioContext.currentTime + note.at);
    osc.stop(audioContext.currentTime + note.at + 0.27);
  });
}

function sanitizeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Replaces Twitch emote positions with <img> tags from the Twitch CDN.
// emotes: { "emoteId": ["start-end", ...], ... } as provided by tmi.js.
// All non-emote text is HTML-escaped before insertion.
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

  // Sort ascending by start position.
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
  disconnectOverlayEvents();
});
