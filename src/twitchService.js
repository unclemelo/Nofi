const tmi = require("tmi.js");
const WebSocket = require("ws");

const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";
const HELIX_BASE = "https://api.twitch.tv/helix";

class TwitchService {
  constructor({ clientId, token, login, channel, eventFilters, onEvent, onTokenExpired }) {
    this.clientId = clientId;
    this.token = token;
    this.login = login;
    this.channel = String(channel).replace(/^#/, "").toLowerCase();
    this.eventFilters = eventFilters || {};
    this.onEvent = onEvent;
    this.onTokenExpired = onTokenExpired;

    this.ws = null;
    this.chatClient = null;
    this.subscriptionsRegistered = false;
    this.stopped = false;
    this.reconnectTimer = null;
    this.userProfileCache = new Map();
    this.userLoginCache = new Map();
    this.broadcasterUserId = null;
    this.badgeImageCache = new Map();
    this.badgesLoaded = false;
    this.badgesLoadPromise = null;
  }

  async start() {
    console.log("[TwitchService] start() — login:", this.login, "channel:", this.channel, "filters:", this.eventFilters);
    await this.ensureAuthValid();
    await this.connectChat();
    await this.connectEventSub();
  }

  async stop() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.chatClient) {
      try {
        await this.chatClient.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      this.chatClient = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors.
      }
      this.ws = null;
    }
  }

  async ensureAuthValid() {
    const response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: {
        Authorization: `OAuth ${this.token}`
      }
    });

    if (!response.ok) {
      this.onTokenExpired?.();
      throw new Error("Twitch token is invalid or expired. Please login again.");
    }
  }

  async connectChat() {
    if (!this.eventFilters.chat) {
      console.log("[TwitchService] chat filter is disabled, skipping IRC");
      return;
    }

    console.log("[TwitchService] connecting to IRC as", this.login, "in channel", this.channel);

    this.chatClient = new tmi.Client({
      connection: { reconnect: true, secure: true },
      identity: {
        username: this.login,
        password: `oauth:${this.token}`
      },
      channels: [this.channel]
    });

    this.chatClient.on("connected", () => {
      console.log("[TwitchService] IRC connected to #" + this.channel);
      this.emit({
        type: "system",
        title: "Chat Connected",
        message: `Joined #${this.channel} chat.`
      });
    });

    this.chatClient.on("disconnected", (reason) => {
      console.warn("[TwitchService] IRC disconnected:", reason);
      this.emit({
        type: "system",
        title: "Chat Disconnected",
        message: reason || "IRC connection lost."
      });
    });

    this.chatClient.on("notice", (_channel, msgid, message) => {
      console.warn("[TwitchService] IRC notice:", msgid, message);
    });

    this.chatClient.on("message", async (_channel, tags, message, self) => {
      try {
        console.log("[TwitchService] IRC message self=%s user=%s msg=%s", self, tags["display-name"], message);
        if (self) return;

        const username = tags["display-name"] || tags.username || "Viewer";
        const actorId = tags["user-id"] || null;

        // Shared chat messages can arrive with source-room-id even when source-room-login is absent.
        const sourceRoomLoginTag = tags["source-room-login"] || null;
        const sourceChannelId = tags["source-room-id"] || null;
        const roomId = tags["room-id"] || null;

        const sourceLoginNormalized = sourceRoomLoginTag
          ? sourceRoomLoginTag.toLowerCase()
          : null;

        const isShared = Boolean(
          (sourceLoginNormalized && sourceLoginNormalized !== this.channel) ||
          (sourceChannelId && roomId && sourceChannelId !== roomId)
        );

        let sourceChannelLogin = null;
        if (isShared) {
          sourceChannelLogin = sourceLoginNormalized || await this.getUserLoginById(sourceChannelId);
        }

        const title = isShared
          ? `${username} (${sourceChannelLogin ? `#${sourceChannelLogin}` : "Shared Chat"})`
          : username;

        this.emitActorEvent({
          type: "chat",
          title,
          message: message,
          actorName: username,
          actorId,
          actorLogin: tags.username || null,
          actorColor: tags.color || null,
          emotes: tags.emotes || null,
          badges: tags.badges || null,
          badgeInfo: tags["badge-info"] || null,
          sourceChannelLogin: isShared ? sourceChannelLogin : null,
          sourceChannelId: isShared ? sourceChannelId : null
        });
      } catch (error) {
        this.emit({
          type: "system",
          title: "Chat Parse Error",
          message: error?.message || "Failed to process chat message"
        });
      }
    });

    console.log("[TwitchService] IRC client.connect() called");
    await this.chatClient.connect();
    console.log("[TwitchService] IRC client.connect() resolved");
  }

  async connectEventSub() {
    this.subscriptionsRegistered = false;

    return new Promise((resolve, reject) => {
      this.openEventSubSocket({
        url: EVENTSUB_WS_URL,
        shouldRegister: true,
        resolve,
        reject
      });
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }

      try {
        await this.connectEventSub();
      } catch (error) {
        this.emit({
          type: "system",
          title: "EventSub Reconnect Failed",
          message: error.message || "Could not reconnect EventSub"
        });
        this.scheduleReconnect();
      }
    }, 2200);
  }

  openEventSubSocket({ url, shouldRegister, resolve, reject }) {
    const ws = new WebSocket(url);
    this.ws = ws;

    let settled = false;

    ws.on("message", async (raw) => {
      try {
        const payload = JSON.parse(raw.toString("utf8"));
        const msgType = payload?.metadata?.message_type;

        if (msgType === "session_welcome") {
          const sessionId = payload?.payload?.session?.id;
          if (!sessionId) {
            throw new Error("Missing EventSub session id.");
          }

          if (shouldRegister) {
            await this.registerSubscriptions(sessionId);
            this.subscriptionsRegistered = true;
          }

          if (!settled && resolve) {
            settled = true;
            resolve();
          }
          return;
        }

        if (msgType === "notification") {
          this.handleEventSubNotification(payload.payload).catch(() => {
            // Ignore transient notification mapping failures.
          });
          return;
        }

        if (msgType === "session_reconnect") {
          const reconnectUrl = payload?.payload?.session?.reconnect_url;
          if (reconnectUrl && !this.stopped) {
            ws.close();
            this.openEventSubSocket({
              url: reconnectUrl,
              shouldRegister: false,
              resolve: null,
              reject: null
            });
          }
        }
      } catch (error) {
        if (!settled && reject) {
          settled = true;
          reject(error);
          return;
        }

        this.emit({
          type: "system",
          title: "EventSub Parsing Error",
          message: error.message || "Unknown EventSub parsing failure"
        });
      }
    });

    ws.on("error", (error) => {
      if (!settled && reject) {
        settled = true;
        reject(error);
        return;
      }

      this.emit({
        type: "system",
        title: "EventSub Error",
        message: error.message || "Unknown websocket error"
      });
    });

    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
      }

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  async registerSubscriptions(sessionId) {
    const me = await this.getMe();
    const broadcasterUserId = me.id;
    this.broadcasterUserId = broadcasterUserId;

    const requests = [];

    if (this.eventFilters.follow) {
      requests.push({
        type: "channel.follow",
        version: "2",
        condition: {
          broadcaster_user_id: broadcasterUserId,
          moderator_user_id: broadcasterUserId
        },
        transport: {
          method: "websocket",
          session_id: sessionId
        }
      });
    }

    if (this.eventFilters.sub) {
      requests.push({
        type: "channel.subscribe",
        version: "1",
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
          method: "websocket",
          session_id: sessionId
        }
      });
    }

    if (this.eventFilters.gift) {
      requests.push({
        type: "channel.subscription.gift",
        version: "1",
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
          method: "websocket",
          session_id: sessionId
        }
      });
    }

    if (this.eventFilters.bits) {
      requests.push({
        type: "channel.cheer",
        version: "1",
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
          method: "websocket",
          session_id: sessionId
        }
      });
    }

    for (const body of requests) {
      const response = await fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
        method: "POST",
        headers: {
          "Client-Id": this.clientId,
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const text = await response.text();
        this.emit({
          type: "system",
          title: `Subscription Failed (${body.type})`,
          message: `${response.status}: ${text}`
        });
      }
    }
  }

  async getMe() {
    const response = await fetch(`${HELIX_BASE}/users`, {
      headers: {
        "Client-Id": this.clientId,
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Could not load Twitch user: ${response.status} ${text}`);
    }

    const json = await response.json();
    if (!json?.data?.[0]) {
      throw new Error("No user data returned by Twitch API.");
    }

    return json.data[0];
  }

  async handleEventSubNotification(payload) {
    const subscriptionType = payload?.subscription?.type;
    const event = payload?.event || {};

    if (subscriptionType === "channel.follow") {
      await this.emitActorEvent({
        type: "follow",
        title: "New Follow",
        message: `${event.user_name || "A viewer"} followed your channel.`,
        actorId: event.user_id || null,
        actorLogin: event.user_login || null,
        actorName: event.user_name || "A viewer"
      });
      return;
    }

    if (subscriptionType === "channel.subscribe") {
      // Gifted subs also trigger channel.subscribe per recipient.
      // We skip those here and let channel.subscription.gift emit one aggregate notification.
      if (event.is_gift) {
        return;
      }

      await this.emitActorEvent({
        type: "sub",
        title: "New Subscriber",
        message: `${event.user_name || "A viewer"} subscribed at tier ${event.tier || "1000"}.`,
        actorId: event.user_id || null,
        actorLogin: event.user_login || null,
        actorName: event.user_name || "A viewer"
      });
      return;
    }

    if (subscriptionType === "channel.subscription.gift") {
      const gifter = event.user_name || "Anonymous";
      const total = event.total || 1;
      await this.emitActorEvent({
        type: "gift",
        title: "Gift Subs",
        message: `${gifter} gifted ${total} subscription(s)!`,
        actorId: event.user_id || null,
        actorLogin: event.user_login || null,
        actorName: gifter
      });
      return;
    }

    if (subscriptionType === "channel.cheer") {
      const bits = Number(event.bits || 0);
      const isAnonymous = !!event.is_anonymous;
      const cheerer = isAnonymous ? "Anonymous" : (event.user_name || "A viewer");
      const baseMessage = `${cheerer} cheered ${bits} bits!`;
      const extra = event.message ? ` ${event.message}` : "";

      await this.emitActorEvent({
        type: "bits",
        title: "Bits Cheer",
        message: `${baseMessage}${extra}`,
        actorId: isAnonymous ? null : (event.user_id || null),
        actorLogin: isAnonymous ? null : (event.user_login || null),
        actorName: cheerer
      });
    }
  }

  async emitActorEvent(event) {
    console.log("[TwitchService] emitActorEvent type=%s actor=%s", event.type, event.actorName);
    const actorId = event.actorId || null;
    const actorLogin = event.actorLogin || null;
    const actorName = event.actorName || "Unknown user";

    let profileImageUrl = "";
    try {
      profileImageUrl = await this.getUserProfileImage({ actorId, actorLogin });
    } catch {
      // Avatar fetch failed — still emit the notification without an image.
    }

    // Shared Chat: also fetch the originating channel's avatar for the badge.
    let sourceChannelImageUrl = "";
    if (event.sourceChannelLogin || event.sourceChannelId) {
      try {
        sourceChannelImageUrl = await this.getUserProfileImage({
          actorId: event.sourceChannelId || null,
          actorLogin: event.sourceChannelLogin || null
        });
      } catch {
        // Source channel avatar optional — don't block the notification.
      }
    }

    let badgeImages = [];
    if (event.badges && typeof event.badges === "object") {
      try {
        badgeImages = await this.resolveBadgeImages(event.badges);
      } catch {
        // Badge resolution is optional for notifications.
      }
    }

    this.emit({
      ...event,
      actorId,
      actorLogin,
      actorName,
      actorColor: event.actorColor || null,
      profileImageUrl,
      badgeImages,
      sourceChannelImageUrl: sourceChannelImageUrl || null,
      sourceChannelId: event.sourceChannelId || null,
      sourceChannelLogin: event.sourceChannelLogin || null
    });
  }

  async getBroadcasterUserId() {
    if (this.broadcasterUserId) {
      return this.broadcasterUserId;
    }

    const me = await this.getMe();
    this.broadcasterUserId = me.id;
    return this.broadcasterUserId;
  }

  async resolveBadgeImages(badges) {
    await this.ensureBadgeCacheLoaded();

    const resolved = [];
    for (const [setId, version] of Object.entries(badges || {})) {
      const normalizedSetId = String(setId || "").trim();
      const normalizedVersion = String(version || "").trim();
      if (!normalizedSetId || !normalizedVersion) {
        continue;
      }

      const key = `${normalizedSetId}/${normalizedVersion}`;
      const imageUrl = this.badgeImageCache.get(key) || null;
      if (imageUrl) {
        resolved.push({
          setId: normalizedSetId,
          version: normalizedVersion,
          imageUrl
        });
      }
    }

    return resolved;
  }

  async ensureBadgeCacheLoaded() {
    if (this.badgesLoaded) {
      return;
    }

    if (this.badgesLoadPromise) {
      await this.badgesLoadPromise;
      return;
    }

    this.badgesLoadPromise = this.loadBadgeCache();
    try {
      await this.badgesLoadPromise;
    } finally {
      this.badgesLoadPromise = null;
    }
  }

  async loadBadgeCache() {
    const globalData = await this.fetchHelixJson(`${HELIX_BASE}/chat/badges/global`);
    this.storeBadgeData(globalData);

    try {
      const broadcasterUserId = await this.getBroadcasterUserId();
      if (broadcasterUserId) {
        const channelData = await this.fetchHelixJson(
          `${HELIX_BASE}/chat/badges?broadcaster_id=${encodeURIComponent(broadcasterUserId)}`
        );
        this.storeBadgeData(channelData);
      }
    } catch {
      // Channel-specific badges are optional; global badges still work.
    }

    this.badgesLoaded = true;
  }

  storeBadgeData(payload) {
    const sets = payload?.data;
    if (!Array.isArray(sets)) {
      return;
    }

    for (const set of sets) {
      const setId = String(set?.set_id || "").trim();
      if (!setId || !Array.isArray(set?.versions)) {
        continue;
      }

      for (const version of set.versions) {
        const versionId = String(version?.id || "").trim();
        const imageUrl = String(version?.image_url_1x || "").trim();
        if (!versionId || !imageUrl) {
          continue;
        }
        this.badgeImageCache.set(`${setId}/${versionId}`, imageUrl);
      }
    }
  }

  async fetchHelixJson(url) {
    const response = await fetch(url, {
      headers: {
        "Client-Id": this.clientId,
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Helix request failed: ${response.status}`);
    }

    return response.json();
  }

  async getUserLoginById(userId) {
    if (!userId) {
      return null;
    }

    if (this.userLoginCache.has(userId)) {
      return this.userLoginCache.get(userId);
    }

    const url = new URL(`${HELIX_BASE}/users`);
    url.searchParams.set("id", userId);

    const response = await fetch(url.toString(), {
      headers: {
        "Client-Id": this.clientId,
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      this.userLoginCache.set(userId, null);
      return null;
    }

    const json = await response.json();
    const login = json?.data?.[0]?.login ? String(json.data[0].login).toLowerCase() : null;
    this.userLoginCache.set(userId, login);
    return login;
  }

  async getUserProfileImage({ actorId, actorLogin }) {
    const cacheKey = actorId || actorLogin || null;
    if (cacheKey && this.userProfileCache.has(cacheKey)) {
      return this.userProfileCache.get(cacheKey);
    }

    if (!actorId && !actorLogin) {
      return "";
    }

    const url = new URL(`${HELIX_BASE}/users`);
    if (actorId) {
      url.searchParams.set("id", actorId);
    } else if (actorLogin) {
      url.searchParams.set("login", actorLogin);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Client-Id": this.clientId,
        Authorization: `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      return "";
    }

    const json = await response.json();
    const profileImageUrl = json?.data?.[0]?.profile_image_url || "";

    if (cacheKey) {
      this.userProfileCache.set(cacheKey, profileImageUrl);
    }

    return profileImageUrl;
  }

  emit(event) {
    console.log("[TwitchService] emit type=%s", event.type);
    this.onEvent?.({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      ...event
    });
  }
}

module.exports = {
  TwitchService
};
