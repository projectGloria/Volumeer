const slider = document.querySelector("#volume");
const valueOutput = document.querySelector("#volume-value");
const notice = document.querySelector("#notice");
const resetButton = document.querySelector("#reset");
const presetButtons = [...document.querySelectorAll("[data-gain]")];
const tabList = document.querySelector("#tab-list");
const goToTabButton = document.querySelector("#go-to-tab");
const enableButton = document.querySelector("#enable-tab");

const DEFAULT_GAIN = 100;
const LIVE_INTERVAL = 120;

let activeTabId = null;
let requestSequence = 0;
let tabs = [];
let refreshSequence = 0;
let invokedTabId = null;
let invocationInitialized = false;
let selectedState = null;
let knownStates = {};
let currentWindowId = null;
const permissionDeniedTabs = new Set();
let enableGain = DEFAULT_GAIN;
let enableReason = null;
let enableRetriable = false;
let allTabs = [];
let heardTabs = new Set();
const SVG_NS = "http://www.w3.org/2000/svg";
let liveTimer = null;
let liveRequest = null;
const collapsedGroups = new Set();

function isRestrictedTab(tab) {
  const url = tab?.pendingUrl || tab?.url || "";
  return /^(chrome|brave|edge|about|chrome-extension):/i.test(url)
    || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(url);
}

function hasAudioRole(tab) {
  return Boolean(tab.audible || tab.mutedInfo?.muted || heardTabs.has(tab.id)
    || knownStates[tab.id]?.capturing || tab.id === activeTabId);
}

// Only tabs that have something to play are worth listing; if none qualify the
// full list is shown so there is always something to pick.
function visibleTabs() {
  const listable = allTabs.filter((tab) => !isRestrictedTab(tab));
  const withAudio = listable.filter(hasAudioRole);
  return withAudio.length ? withAudio : listable;
}

function canControlSelection() {
  const tab = tabs.find((item) => item.id === activeTabId);
  return Boolean(tab && selectedState && (selectedState.capturing
    || !isRestrictedTab(tab)));
}

function offerFallback(gain, reason, retriable) {
  enableGain = gain;
  enableReason = reason;
  enableRetriable = Boolean(retriable);
  enableButton.textContent = enableRetriable
    ? "Reload tab to enable boost"
    : "Open tab to enable boost";
  enableButton.hidden = false;
}

function showSelectionNotice() {
  const tab = tabs.find((item) => item.id === activeTabId);
  if (selectedState?.capturing) {
    setNotice(`This tab is set to ${selectedState.gain}%.`);
  } else if (isRestrictedTab(tab)) {
    setNotice("Audio control is unavailable on browser pages and extension store pages.");
  } else if (!enableButton.hidden && enableRetriable) {
    setNotice("This site needs one reload before its audio can be reached.");
  } else if (!enableButton.hidden) {
    setNotice("Open this tab and click the Volumeer icon once to boost it.");
  } else {
    setNotice("Move the slider or choose a preset to start controlling this tab.");
  }
}

function siteOf(tab) {
  const url = tab?.pendingUrl || tab?.url || "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const host = parsed.hostname.replace(/^www\./i, "");
      return { key: host, label: host };
    }
    if (parsed.protocol === "file:") return { key: "file", label: "Local files" };
    if (parsed.protocol === "chrome-extension:") return { key: "extension", label: "Extensions" };
    return { key: parsed.protocol, label: `${parsed.protocol.replace(":", "")} pages` };
  } catch {
    return { key: "other", label: "Other tabs" };
  }
}

function groupTabs() {
  const groups = new Map();
  for (const tab of tabs) {
    const site = siteOf(tab);
    if (!groups.has(site.key)) groups.set(site.key, { ...site, tabs: [], icon: null });
    const group = groups.get(site.key);
    group.tabs.push(tab);
    if (!group.icon && tab.favIconUrl && /^(https?|data):/i.test(tab.favIconUrl)) {
      group.icon = tab.favIconUrl;
    }
  }
  return [...groups.values()];
}

function siteIcon(group) {
  const wrapper = document.createElement("span");
  wrapper.className = "site-icon";
  const initial = document.createElement("span");
  initial.className = "site-initial";
  initial.textContent = (group.label[0] || "?").toUpperCase();
  wrapper.append(initial);

  if (group.icon) {
    const image = document.createElement("img");
    image.src = group.icon;
    image.alt = "";
    image.addEventListener("error", () => { image.hidden = true; });
    wrapper.append(image);
  }
  return wrapper;
}

function muteIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const speaker = document.createElementNS(SVG_NS, "path");
  speaker.setAttribute("d", "M4 9v6h4l5 4V5L8 9H4Z");
  speaker.setAttribute("fill", "currentColor");
  const cross = document.createElementNS(SVG_NS, "path");
  cross.setAttribute("d", "m16 10 5 4m0-4-5 4");
  cross.setAttribute("fill", "none");
  cross.setAttribute("stroke", "currentColor");
  cross.setAttribute("stroke-width", "2");
  cross.setAttribute("stroke-linecap", "round");
  svg.append(speaker, cross);
  return svg;
}

function rowPills(tab, windows) {
  const state = knownStates[tab.id];
  const pills = [];
  const silenced = state?.capturing && state.gain === 0;
  if (state?.capturing && !silenced) pills.push({ text: `${state.gain}%`, className: "pill boost" });
  if (silenced || tab.mutedInfo?.muted) {
    pills.push({ icon: muteIcon, className: "pill muted", label: silenced ? "Set to 0%" : "Muted" });
  } else if (tab.audible) {
    pills.push({ text: "▶", className: "pill playing", label: "Playing" });
  }
  if (windows.length > 1 && tab.windowId !== currentWindowId) {
    pills.push({ text: `W${windows.indexOf(tab.windowId) + 1}`, className: "pill quiet" });
  }
  return pills;
}

function rowLabel(tab, windows) {
  return [
    tab.title || `Tab ${tab.id}`,
    tab.active ? "active tab" : "",
    windows.length > 1 ? `window ${windows.indexOf(tab.windowId) + 1}` : ""
  ].filter(Boolean).join(" · ");
}

function tabRow(tab, windows) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = tab.active ? "tab-row current" : "tab-row";
  button.setAttribute("aria-pressed", String(tab.id === activeTabId));
  button.title = rowLabel(tab, windows);

  const title = document.createElement("span");
  title.className = "tab-row-title";
  title.textContent = tab.title || `Tab ${tab.id}`;

  const meta = document.createElement("span");
  meta.className = "tab-row-meta";
  for (const pill of rowPills(tab, windows)) {
    const element = document.createElement("span");
    element.className = pill.className;
    if (pill.icon) element.append(pill.icon());
    else element.textContent = pill.text;
    if (pill.label) element.title = pill.label;
    meta.append(element);
  }

  button.append(title, meta);
  button.addEventListener("click", () => selectTab(tab.id));
  return button;
}

function renderTabs() {
  tabs = visibleTabs();
  tabList.replaceChildren();
  const windows = [...new Set(tabs.map((tab) => tab.windowId))];

  for (const group of groupTabs()) {
    // A site with a single tab needs no heading; its icon goes on the row.
    if (group.tabs.length === 1) {
      const row = tabRow(group.tabs[0], windows);
      row.className += " solo";
      row.prepend(siteIcon(group));
      tabList.append(row);
      continue;
    }

    const holdsSelection = group.tabs.some((tab) => tab.id === activeTabId);
    const collapsed = collapsedGroups.has(group.key) && !holdsSelection;
    const boosted = group.tabs.filter((tab) => knownStates[tab.id]?.capturing).length;

    const section = document.createElement("div");
    section.className = "tab-group";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "tab-group-header";
    header.setAttribute("aria-expanded", String(!collapsed));
    header.title = group.label;
    const name = document.createElement("span");
    name.className = "tab-group-name";
    name.textContent = group.label;
    const count = document.createElement("span");
    count.className = boosted ? "tab-group-count boosted" : "tab-group-count";
    count.textContent = boosted ? `${boosted}/${group.tabs.length} boosted` : String(group.tabs.length);
    header.append(siteIcon(group), name, count);
    header.addEventListener("click", () => {
      if (collapsedGroups.has(group.key)) collapsedGroups.delete(group.key);
      else collapsedGroups.add(group.key);
      renderTabs();
    });
    section.append(header);

    const rows = document.createElement("div");
    rows.className = "tab-group-rows";
    rows.hidden = collapsed;
    for (const tab of group.tabs) rows.append(tabRow(tab, windows));
    section.append(rows);
    tabList.append(section);
  }

  goToTabButton.disabled = activeTabId === null;
}

async function selectTab(tabId) {
  activeTabId = tabId;
  selectedState = null;
  enableButton.hidden = true;
  const sequence = ++requestSequence;
  const tab = tabs.find((item) => item.id === tabId);
  renderTabs();
  setBusy(true);
  showGain(DEFAULT_GAIN);
  if (!tab) {
    setNotice("No open tabs are available.");
    return;
  }
  setNotice("Loading this tab's volume…");
  try {
    const state = await send({ type: "GET_STATE", tabId });
    if (sequence !== requestSequence) return;
    selectedState = state;
    showGain(state.gain);
    showSelectionNotice();
  } catch (error) {
    if (sequence === requestSequence) setNotice(error.message, true);
  } finally {
    if (sequence === requestSequence) setBusy(false);
  }
}

async function refreshTabs() {
  const sequence = ++refreshSequence;
  try {
    const [openTabs, currentTabs, allStates] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabs.query({ active: true, currentWindow: true }),
      send({ type: "GET_ALL_STATES" }).catch(() => ({ states: {} }))
    ]);
    knownStates = allStates.states || {};
    heardTabs = new Set(allStates.heard || []);
    currentWindowId = currentTabs[0]?.windowId ?? currentWindowId;
    if (sequence !== refreshSequence) return;
    if (!invocationInitialized) {
      invokedTabId = currentTabs[0]?.id ?? null;
      invocationInitialized = true;
    }
    const previousTab = tabs.find((tab) => tab.id === activeTabId);
    allTabs = openTabs.filter((tab) => Number.isInteger(tab.id))
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    tabs = visibleTabs();
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      await selectTab(tabs.find((tab) => tab.id === currentTabs[0]?.id)?.id ?? tabs[0]?.id ?? null);
    } else {
      const selectedTab = tabs.find((tab) => tab.id === activeTabId);
      if (previousTab?.url !== selectedTab.url || previousTab?.pendingUrl !== selectedTab.pendingUrl) {
        if (activeTabId === invokedTabId) invokedTabId = null;
        await selectTab(activeTabId);
        return;
      }
      renderTabs();
    }
  } catch (error) {
    if (sequence === refreshSequence) setNotice(error.message, true);
  }
}

goToTabButton.addEventListener("click", async () => {
  const tab = tabs.find((item) => item.id === activeTabId);
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  } catch (error) {
    setNotice(error.message, true);
  }
});

for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated,
  chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached]) {
  event.addListener(refreshTabs);
}

function showGain(gain) {
  const value = Number(gain);
  slider.value = String(value);
  valueOutput.textContent = `${value}%`;
  slider.style.setProperty("--progress", `${value / 5}%`);
  presetButtons.forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.gain) === value);
  });
}

function setBusy(busy) {
  const disabled = busy || !canControlSelection();
  slider.disabled = disabled;
  resetButton.disabled = busy || !selectedState?.capturing;
  presetButtons.forEach((button) => { button.disabled = disabled; });
}

function setNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

async function ensureSiteAccess(tab) {
  if (!/^https?:/i.test(tab?.url || "")) return false;
  const origins = ["<all_urls>"];
  if (await chrome.permissions.contains({ origins })) return true;
  // Must run inside the click or change handler to keep the user gesture.
  return chrome.permissions.request({ origins }).catch(() => false);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error || "Volumeer could not update this tab.");
    error.reason = response?.reason;
    error.retriable = response?.retriable;
    throw error;
  }
  return response;
}

async function applyGain(gain) {
  if (!canControlSelection()) return;
  const tabId = activeTabId;
  const sequence = ++requestSequence;
  const tab = tabs.find((item) => item.id === tabId);
  const hasSiteAccess = await ensureSiteAccess(tab);
  if (sequence !== requestSequence || tabId !== activeTabId) return;
  setBusy(true);
  setNotice("Connecting to this tab's audio…");

  try {
    if (!hasSiteAccess && !selectedState.capturing
      && (tabId !== invokedTabId || permissionDeniedTabs.has(tabId))) {
      offerFallback(gain, null, false);
      showSelectionNotice();
      return;
    }
    const state = await send({ type: "SET_TAB_GAIN", tabId: activeTabId, gain });
    if (sequence !== requestSequence) return;
    selectedState = state;
    knownStates[tabId] = { gain: state.gain, capturing: state.capturing };
    enableButton.hidden = true;
    showGain(state.gain);
    renderTabs();
    setNotice(state.gain > 100 ? `Boosting this tab to ${state.gain}%.` : "Volume control is active for this tab.");
  } catch (error) {
    if (sequence !== requestSequence) return;
    if (error.reason || /not been invoked|activeTab permission/i.test(error.message)) {
      permissionDeniedTabs.add(tabId);
      selectedState = { gain: DEFAULT_GAIN, capturing: false };
      offerFallback(gain, error.reason, error.retriable);
      showSelectionNotice();
    } else {
      showGain(selectedState?.gain ?? DEFAULT_GAIN);
      setNotice(error.message, true);
    }
  } finally {
    if (sequence === requestSequence) setBusy(false);
  }
}

async function applyGainLive(gain) {
  if (liveRequest || !selectedState?.capturing || !canControlSelection()) return;
  const tabId = activeTabId;
  liveRequest = send({ type: "SET_TAB_GAIN", tabId, gain })
    .then((state) => {
      if (tabId !== activeTabId) return;
      selectedState = state;
      knownStates[tabId] = { gain: state.gain, capturing: state.capturing };
    })
    .catch(() => {})
    .finally(() => { liveRequest = null; });
}

slider.addEventListener("input", () => {
  showGain(slider.value);
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    applyGainLive(Number(slider.value));
  }, LIVE_INTERVAL);
});

slider.addEventListener("change", () => {
  clearTimeout(liveTimer);
  liveTimer = null;
  applyGain(Number(slider.value));
});

enableButton.addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) return;
  try {
    if (enableRetriable) {
      enableButton.hidden = true;
      setNotice("Reloading this tab so its audio can be boosted…");
      await send({ type: "ENABLE_SITE", tabId: activeTabId, gain: enableGain });
      await selectTab(activeTabId);
      return;
    }
    await send({ type: "PREPARE_TAB_GAIN", tabId: activeTabId, gain: enableGain });
    window.close();
  } catch (error) {
    setNotice(error.message, true);
  }
});

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const gain = Number(button.dataset.gain);
    showGain(gain);
    applyGain(gain);
  });
});

resetButton.addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) return;
  const sequence = ++requestSequence;
  setBusy(true);

  try {
    const tabId = activeTabId;
    await send({ type: "RESET_TAB", tabId });
    if (sequence !== requestSequence) return;
    selectedState = { gain: 100, capturing: false };
    delete knownStates[tabId];
    showGain(DEFAULT_GAIN);
    renderTabs();
    showSelectionNotice();
  } catch (error) {
    if (sequence === requestSequence) setNotice(error.message, true);
  } finally {
    if (sequence === requestSequence) setBusy(false);
  }
});

async function initialize() {
  setBusy(true);
  showGain(DEFAULT_GAIN);

  await refreshTabs();
  if (invokedTabId !== null) {
    try {
      const result = await send({ type: "APPLY_PENDING_GAIN", tabId: invokedTabId });
      if (result.applied && activeTabId === invokedTabId) await selectTab(invokedTabId);
    } catch (error) {
      setNotice(error.message, true);
    }
  }
}

initialize();
