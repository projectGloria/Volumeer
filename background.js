const DEFAULT_GAIN = 100;
const MIN_GAIN = 0;
const MAX_GAIN = 500;
const OFFSCREEN_DOCUMENT = "offscreen.html";

const tabStates = new Map();
// Tabs that have played audio at some point, so a paused one stays listed.
const heardTabs = new Set();
let creatingOffscreenDocument = null;

const stateReady = chrome.storage.session.get(["tabStates", "heardTabs"])
  .then(({ tabStates: savedStates = {}, heardTabs: savedHeard = [] }) => {
    for (const [tabId, state] of Object.entries(savedStates)) {
      tabStates.set(Number(tabId), state);
    }
    for (const tabId of savedHeard) heardTabs.add(Number(tabId));
  });

async function persistStates() {
  await chrome.storage.session.set({
    tabStates: Object.fromEntries(tabStates),
    heardTabs: [...heardTabs]
  });
}

function clampGain(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, Math.round(number)));
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)]
    });
    return contexts.length > 0;
  }

  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT));
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreenDocument) return creatingOffscreenDocument;

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio and route it through a per-tab Web Audio gain control."
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}

async function updateBadge(tabId, gain) {
  const boosted = gain > DEFAULT_GAIN;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: boosted ? `${Math.round(gain / 100 * 10) / 10}x` : "" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#6C5CE7" })
  ]);
}

async function hasHostAccess(url) {
  if (!url || !/^https?:/i.test(url)) return false;
  try {
    return await chrome.permissions.contains({ origins: [new URL(url).origin + "/*"] });
  } catch {
    return false;
  }
}

// Returns null when this tab cannot be driven from the page, so the caller can
// fall back to tab capture.
async function applyGainInPage(tabId, gain, tab) {
  if (!(await hasHostAccess(tab?.url))) return { reason: "unavailable" };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      files: ["content.js"]
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: (value) => window.__volumeerControl?.setGain(value) ?? null,
      args: [gain]
    });

    const frames = results.map((entry) => entry.result).filter(Boolean);
    const media = frames.reduce((total, frame) => total + frame.media, 0);
    const routed = frames.reduce((total, frame) => total + frame.routed, 0);
    const blocked = frames.reduce((total, frame) => total + frame.blocked, 0);

    if (routed > 0) return { state: { gain, capturing: true, mode: "page" } };
    // Media served without CORS can be routed once the tab reloads with the
    // early script in place; a tab playing audio with no media element cannot.
    if (blocked > 0) return { reason: "blocked" };
    if (tab?.audible) return { reason: "no-media" };
    // Nothing is playing yet; the injected script will boost whatever starts.
    if (media === 0) return { state: { gain, capturing: true, mode: "page" } };
    return { reason: "no-media" };
  } catch {
    return { reason: "unavailable" };
  }
}

function siteScriptId(url) {
  try {
    return `volumeer-${new URL(url).origin}`;
  } catch {
    return null;
  }
}

// True when reloading the tab could still help: the site has no early script
// yet, so media that is created detached or fetched without CORS is missed.
async function siteCanBeEnabled(url) {
  const id = siteScriptId(url);
  if (!id) return false;
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
  return registered.length === 0;
}

// Both the CORS marking and the media registry have to be in place before the
// page's player runs, so the site gets an early script and one reload.
async function enableSite(tabId, gain) {
  const tab = await chrome.tabs.get(tabId);
  const origin = new URL(tab.url).origin;
  const id = `volumeer-${origin}`;
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);

  if (!registered.length) {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [`${origin}/*`],
      js: ["content-early.js"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
      persistAcrossSessions: true
    }]);
  }

  // The tab reloads in place; onUpdated reapplies the gain once it settles.
  tabStates.set(tabId, { gain, capturing: true, mode: "page" });
  await persistStates();
  await chrome.tabs.reload(tabId);
  return { ok: true, gain, capturing: true, mode: "page" };
}

async function resetPage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => window.__volumeerControl?.reset()
    });
  } catch {
    // The tab may be gone, restricted, or never injected.
  }
}

async function startOrUpdateCapture(tabId, gain) {
  const existing = tabStates.get(tabId);
  if (existing?.capturing && existing.mode !== "page") {
    const result = await sendToOffscreen({ type: "SET_GAIN", tabId, gain });
    if (result?.ok) {
      tabStates.set(tabId, { gain, capturing: true, mode: "capture" });
      await Promise.all([persistStates(), updateBadge(tabId, gain)]);
      return { gain, capturing: true };
    }

    // The offscreen document may have been reclaimed while the service worker slept.
    tabStates.delete(tabId);
    await persistStates();
  }

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const result = await sendToOffscreen({
    type: "START_CAPTURE",
    tabId,
    streamId,
    gain
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Could not start audio capture.");
  }

  tabStates.set(tabId, { gain, capturing: true, mode: "capture" });
  await Promise.all([persistStates(), updateBadge(tabId, gain)]);
  return { gain, capturing: true, mode: "capture" };
}

async function stopCapture(tabId) {
  const state = tabStates.get(tabId);
  if (state?.mode === "page") {
    await resetPage(tabId);
  } else if (state?.capturing) {
    await sendToOffscreen({ type: "STOP_CAPTURE", tabId });
  }
  tabStates.delete(tabId);
  await Promise.all([
    persistStates(),
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
  ]);
  return { gain: DEFAULT_GAIN, capturing: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  const handle = async () => {
    await stateReady;
    const tabId = Number(message.tabId);

    switch (message.type) {
      case "PREPARE_TAB_GAIN": {
        if (!Number.isInteger(tabId)) throw new Error("No tab was selected.");
        const tab = await chrome.tabs.get(tabId);
        const gain = clampGain(message.gain);
        // A toolbar click on the target grants capture access. Keep the desired
        // gain across popup closure so that click can complete the operation.
        await chrome.storage.session.set({ pendingGain: { tabId, gain, url: tab.url, createdAt: Date.now() } });
        await chrome.action.setBadgeText({ tabId, text: "GO" });
        await chrome.action.setTitle({ tabId, title: `Click Volumeer to apply ${gain}% volume` });
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }

      case "APPLY_PENDING_GAIN": {
        const { pendingGain } = await chrome.storage.session.get("pendingGain");
        if (!pendingGain || pendingGain.tabId !== tabId) return { ok: true, applied: false };
        const tab = await chrome.tabs.get(tabId);
        await chrome.storage.session.remove("pendingGain");
        await chrome.action.setTitle({ tabId, title: "Volumeer" });
        await chrome.action.setBadgeText({ tabId, text: "" });
        if (pendingGain.url !== tab.url || Date.now() - pendingGain.createdAt > 120000) {
          return { ok: true, applied: false };
        }
        const state = await startOrUpdateCapture(tabId, pendingGain.gain);
        return { ok: true, applied: true, ...state };
      }

      case "ENABLE_SITE": {
        if (!Number.isInteger(tabId)) throw new Error("No tab was selected.");
        return enableSite(tabId, clampGain(message.gain));
      }

      case "GET_ALL_STATES": {
        return { ok: true, states: Object.fromEntries(tabStates), heard: [...heardTabs] };
      }

      case "GET_STATE": {
        const state = tabStates.get(tabId);
        return {
          ok: true,
          gain: state?.gain ?? DEFAULT_GAIN,
          capturing: Boolean(state?.capturing),
          mode: state?.mode ?? null
        };
      }

      case "SET_TAB_GAIN": {
        if (!Number.isInteger(tabId)) throw new Error("No active tab was found.");
        const gain = clampGain(message.gain);
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const page = await applyGainInPage(tabId, gain, tab);
        if (page.state) {
          tabStates.set(tabId, page.state);
          await Promise.all([persistStates(), updateBadge(tabId, gain)]);
          return { ok: true, ...page.state };
        }

        try {
          const state = await startOrUpdateCapture(tabId, gain);
          return { ok: true, ...state };
        } catch (error) {
          // Tells the popup which kind of setup this tab needs.
          error.reason = page.reason;
          error.retriable = page.reason !== "unavailable" && await siteCanBeEnabled(tab?.url);
          throw error;
        }
      }

      case "RESET_TAB": {
        if (!Number.isInteger(tabId)) throw new Error("No active tab was found.");
        return { ok: true, ...(await stopCapture(tabId)) };
      }

      case "CAPTURE_ENDED": {
        if (Number.isInteger(tabId)) {
          tabStates.delete(tabId);
          await Promise.all([
            persistStates(),
            chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
          ]);
        }
        return { ok: true };
      }

      default:
        return null;
    }
  };

  handle()
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error.message || String(error),
      reason: error.reason,
      retriable: error.retriable
    }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateReady.then(() => {
    if (heardTabs.delete(tabId)) persistStates().catch(() => {});
    if (!tabStates.has(tabId)) return;
    sendToOffscreen({ type: "STOP_CAPTURE", tabId }).catch(() => {});
    tabStates.delete(tabId);
    persistStates().catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.audible || heardTabs.has(tabId)) return;
  stateReady.then(() => {
    heardTabs.add(tabId);
    return persistStates();
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  stateReady.then(async () => {
    const state = tabStates.get(tabId);
    if (state?.mode !== "page") return;
    // A navigation discards the injected script, so restore this tab's gain.
    const restored = await applyGainInPage(tabId, state.gain, tab);
    if (!restored.state) {
      tabStates.delete(tabId);
      await Promise.all([
        persistStates(),
        chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
      ]);
    }
  }).catch(() => {});
});

chrome.runtime.onSuspend.addListener(() => {
  // Capture lives in the offscreen document; the map is rebuilt as users revisit tabs.
});
