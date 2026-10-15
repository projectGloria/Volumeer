const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function element() {
  return {
    children: [], attributes: {}, listeners: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    style: { setProperty() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    prepend(...children) { this.children.unshift(...children); }
  };
}

// #tab-list holds a section per multi-tab site ([header, rows container]) and a
// bare row for any site with a single tab.
function groups(list) {
  return list.children.map((child) => child.className === "tab-group"
    ? {
      header: child.children[0],
      hidden: child.children[1].hidden,
      name: child.children[0].children[1].textContent,
      count: child.children[0].children[2].textContent,
      rows: child.children[1].children
    }
    : { header: null, hidden: false, name: null, count: null, rows: [child] });
}

function siteNames(list) {
  return groups(list).map((group) => group.name);
}

function allRows(list) {
  return groups(list).flatMap((group) => group.rows);
}

// A solo row carries the site icon first, so read the pills from the end.
function pillText(row) {
  return row.children.at(-1).children.map((pill) => pill.textContent).join(" · ");
}

async function setup(overrides = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const messages = [];
  const events = {};
  const api = {
    // eslint-disable-next-line no-use-before-define
    openTabs: [
      { id: 1, windowId: 10, index: 0, active: true, title: "Current", url: "https://current.example/" },
      { id: 2, windowId: 20, index: 0, active: true, title: "Music", audible: true, url: "https://music.example/" },
      { id: 3, windowId: 20, index: 1, title: "Quiet", url: "https://quiet.example/" }
    ],
    siteAccess: true,
    states: {},
    // All three fixture tabs have played audio unless a test says otherwise.
    heard: [1, 2, 3],
    respond: async (message) => message.type === "GET_ALL_STATES"
      ? { ok: true, states: api.states, heard: api.heard }
      : { ok: true, gain: message.tabId === 2 ? 200 : 100, capturing: message.tabId === 2 }
  };
  const tabs = { query: async (query) => query.currentWindow ? api.openTabs.slice(0, 1) : api.openTabs };
  for (const name of ["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached"]) {
    tabs[name] = { addListener(callback) { events[name] = callback; } };
  }
  Object.assign(api, overrides);
  const context = vm.createContext({
    URL, setTimeout, clearTimeout,
    window: { close() {} },
    document: {
      querySelector: get,
      querySelectorAll: () => [],
      createElement: element,
      createElementNS: () => element()
    },
    chrome: {
      tabs,
      permissions: {
        contains: async () => api.siteAccess,
        request: async () => api.siteAccess
      },
      runtime: { sendMessage(message) { messages.push(message); return api.respond(message); } }
    }
  });
  vm.runInContext(readFileSync(path.join(__dirname, "../popup.js"), "utf8"), context);
  await new Promise(setImmediate);
  return { get, api, events, messages, context };
}

test("lists quiet and audible tabs across windows and controls the selected tab", async () => {
  const { get, messages, context } = await setup();
  // Each site here has a single tab, so every row is solo and unheaded.
  assert.deepEqual(siteNames(get("#tab-list")), [null, null, null]);
  assert.equal(allRows(get("#tab-list")).length, 3);
  assert.equal(pillText(allRows(get("#tab-list"))[1]), "▶ · W2");
  assert.equal(allRows(get("#tab-list"))[1].attributes ? allRows(get("#tab-list"))[1].title : "",
    "Music · active tab · window 2");
  await allRows(get("#tab-list"))[1].listeners.click();
  assert.equal(get("#volume-value").textContent, "200%");
  await vm.runInContext("applyGain(300)", context);
  assert.equal(messages.at(-1).tabId, 2);
  assert.equal(messages.at(-1).gain, 300);
});

test("late reset response cannot overwrite another tab's controls", async () => {
  const { get, api } = await setup();
  const original = api.respond;
  let finishReset;
  api.respond = (message) => message.type === "RESET_TAB"
    ? new Promise((resolve) => { finishReset = resolve; }) : original(message);
  const resetting = get("#reset").listeners.click();
  await allRows(get("#tab-list"))[1].listeners.click();
  finishReset({ ok: true, gain: 100, capturing: false });
  await resetting;
  assert.equal(get("#volume-value").textContent, "200%");
});

test("closing the selected tab selects a remaining tab; an empty list disables controls", async () => {
  const { get, api, events } = await setup();
  api.openTabs = api.openTabs.slice(1);
  await events.onRemoved();
  assert.equal(get("#volume-value").textContent, "200%");
  api.openTabs = [];
  await events.onRemoved();
  assert.equal(allRows(get("#tab-list")).length, 0);
  assert.equal(get("#volume").disabled, true);
  assert.equal(get("#go-to-tab").disabled, true);
});

test("any tab is controlled directly once site access is granted", async () => {
  const { get, messages, context } = await setup();
  await allRows(get("#tab-list"))[2].listeners.click();
  assert.equal(get("#volume").disabled, false);
  const count = messages.length;
  await vm.runInContext("applyGain(300)", context);
  assert.equal(messages.length, count + 1);
  assert.equal(messages.at(-1).type, "SET_TAB_GAIN");
  assert.equal(messages.at(-1).tabId, 3);
  assert.equal(messages.at(-1).gain, 300);
});

test("a tab that cannot be reached offers setup instead of jumping to it", async () => {
  const { get, api, messages, context } = await setup();
  api.siteAccess = false;
  await allRows(get("#tab-list"))[2].listeners.click();
  const count = messages.length;
  await vm.runInContext("applyGain(300)", context);
  // No message is sent: the tab is only opened once the user asks for it.
  assert.equal(messages.length, count);
  assert.equal(get("#enable-tab").hidden, false);
  assert.match(get("#notice").textContent, /click the Volumeer icon once/);

  await get("#enable-tab").listeners.click();
  assert.equal(messages.at(-1).type, "PREPARE_TAB_GAIN");
  assert.equal(messages.at(-1).gain, 300);
});

test("browser pages are left out of the list entirely", async () => {
  const { get, api, events } = await setup();
  api.openTabs = api.openTabs.map((tab) => tab.id === 1 ? { ...tab, url: "brave://settings" } : tab);
  await events.onUpdated();
  assert.equal(allRows(get("#tab-list")).length, 2);
  assert.equal(allRows(get("#tab-list"))[0].title, "Music · active tab");
});

test("tabs that have played audio stay listed once they fall quiet", async () => {
  const { get, api, events } = await setup({ heard: [3] });
  await events.onUpdated();
  // Tab 2 is audible and tab 3 played earlier; the never-audible tab 1 is left
  // out, so the selection moves to the audible tab.
  assert.equal(allRows(get("#tab-list")).length, 2);
  assert.equal(get("#volume-value").textContent, "200%");

  api.heard = [];
  await events.onUpdated();
  // Tab 3 has no audio history any more and drops out of the list.
  assert.equal(allRows(get("#tab-list")).length, 1);
});

test("permission denial restores gain and prevents repeated failing requests", async () => {
  const { get, api, context } = await setup();
  api.respond = async (message) => message.type === "PREPARE_TAB_GAIN" ? { ok: true } : ({ ok: false, error: "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured." });
  await vm.runInContext("applyGain(300)", context);
  assert.equal(get("#volume-value").textContent, "100%");
  assert.equal(get("#volume").disabled, false);
  assert.equal(get("#enable-tab").hidden, false);
  assert.match(get("#notice").textContent, /click the Volumeer icon once/);
});

test("resetting a session leaves the tab ready to start again", async () => {
  const { get } = await setup();
  await allRows(get("#tab-list"))[1].listeners.click();
  assert.equal(get("#volume").disabled, false);
  await get("#reset").listeners.click();
  assert.equal(get("#volume").disabled, false);
  assert.match(get("#notice").textContent, /Move the slider/);
});

test("tabs on the same site share one group that can be collapsed", async () => {
  const { get, api, events } = await setup();
  api.openTabs = [
    { id: 1, windowId: 10, index: 0, active: true, title: "Inbox", url: "https://mail.example/" },
    { id: 2, windowId: 10, index: 1, title: "Album", url: "https://music.example/a", favIconUrl: "https://music.example/icon.png" },
    { id: 3, windowId: 10, index: 2, title: "Playlist", url: "https://www.music.example/b", audible: true }
  ];
  await events.onUpdated();
  const list = groups(get("#tab-list"));
  // The lone mail tab is a solo row; www and bare hosts share one heading.
  assert.deepEqual(list.map((group) => group.name), [null, "music.example"]);
  assert.equal(list[1].rows.length, 2);
  assert.equal(list[1].count, "2");

  await list[1].header.listeners.click();
  const collapsed = groups(get("#tab-list"))[1];
  assert.equal(collapsed.header.attributes["aria-expanded"], "false");
  assert.equal(get("#tab-list").children[1].children[1].hidden, true);
});

test("a boosted tab shows its level on the row and in the group count", async () => {
  const { get, api, events } = await setup();
  api.states = { 2: { gain: 250, capturing: true } };
  api.openTabs = [
    { id: 1, windowId: 10, index: 0, active: true, title: "Current", url: "https://current.example/" },
    { id: 2, windowId: 20, index: 0, active: true, title: "Music", audible: true, url: "https://music.example/a" },
    { id: 3, windowId: 20, index: 1, title: "Queue", url: "https://music.example/b" }
  ];
  await events.onUpdated();
  const list = groups(get("#tab-list"));
  assert.equal(list[1].name, "music.example");
  assert.equal(pillText(list[1].rows[0]), "250% · ▶ · W2");
  assert.equal(list[1].count, "1/2 boosted");
});

test("dragging the slider updates a live tab without waiting for the release", async () => {
  const { get, messages, context } = await setup();
  await allRows(get("#tab-list"))[1].listeners.click();
  const count = messages.length;
  get("#volume").value = "400";
  get("#volume").listeners.input();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(messages.length, count + 1);
  assert.equal(messages.at(-1).type, "SET_TAB_GAIN");
  assert.equal(messages.at(-1).gain, 400);
  assert.equal(get("#volume").disabled, false);
});

test("dragging a tab with no session yet waits for the release", async () => {
  const { get, messages } = await setup();
  await allRows(get("#tab-list"))[2].listeners.click();
  const count = messages.length;
  get("#volume").value = "400";
  get("#volume").listeners.input();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(messages.length, count);
});

test("a tab held at 0% shows a mute icon instead of a level", async () => {
  const { get, api, events } = await setup();
  api.states = { 2: { gain: 0, capturing: true } };
  await events.onUpdated();
  const pills = allRows(get("#tab-list"))[1].children.at(-1).children;
  // The mute icon replaces both the level and the playing marker.
  assert.deepEqual(pills.map((pill) => pill.className), ["pill muted", "pill quiet"]);
  assert.equal(pills[0].title, "Set to 0%");
  // The icon replaces the level, so no text is rendered in the pill.
  assert.equal(pills[0].textContent, undefined);
  assert.equal(pills[0].children.length, 1);
});
