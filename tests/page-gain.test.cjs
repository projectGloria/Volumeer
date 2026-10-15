const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function background({ frames, siteAccess = true, audible = false }) {
  const stored = {};
  const captures = [];
  const injections = [];
  const registered = [];
  const reloads = [];
  let captureBroken = false;
  const event = { addListener() {} };
  let listener;
  const context = vm.createContext({
    URL,
    chrome: {
      storage: { session: {
        async get(key) { return { [key]: stored[key] }; },
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; }
      } },
      tabs: {
        onRemoved: event, onUpdated: event,
        async get(id) { return { id, url: "https://example.com/", windowId: 7, audible }; },
        async update() {},
        async reload(id) { reloads.push(id); }
      },
      windows: { async update() {} },
      action: { async setBadgeText() {}, async setTitle() {}, async setBadgeBackgroundColor() {} },
      permissions: { async contains() { return siteAccess; } },
      scripting: {
        async executeScript(options) { injections.push(options); return frames(options); },
        async getRegisteredContentScripts() { return registered.slice(); },
        async registerContentScripts(scripts) { registered.push(...scripts); }
      },
      tabCapture: {
        async getMediaStreamId({ targetTabId }) {
          if (captureBroken) throw new Error("Extension has not been invoked for the current page (see activeTab permission).");
          captures.push(targetTabId);
          return "stream";
        }
      },
      runtime: {
        onMessage: { addListener(callback) { listener = callback; } }, onSuspend: event,
        getURL: (url) => url, async getContexts() { return [{}]; },
        async sendMessage() { return { ok: true }; }
      }
    }
  });
  vm.runInContext(readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  return {
    captures,
    injections,
    registered,
    reloads,
    breakCapture: () => { captureBroken = true; },
    send: (message) => new Promise((resolve) => listener(message, {}, resolve))
  };
}

test("a tab with routable media is controlled in the page without capture", async () => {
  const { send, captures, injections } = background({
    frames: (options) => options.files ? [] : [{ result: { ok: true, gain: 300, media: 1, routed: 1, blocked: 0 } }]
  });
  const result = await send({ type: "SET_TAB_GAIN", tabId: 42, gain: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.gain, 300);
  assert.equal(result.mode, "page");
  assert.deepEqual(captures, []);
  assert.equal([...injections[0].files].join(), "content.js");
});

test("blocked cross-origin media falls back to capture and reports why", async () => {
  const { send, captures } = background({
    frames: (options) => options.files ? [] : [{ result: { ok: true, gain: 300, media: 1, routed: 0, blocked: 1 } }]
  });
  const result = await send({ type: "SET_TAB_GAIN", tabId: 42, gain: 300 });
  assert.equal(result.mode, "capture");
  assert.deepEqual(captures, [42]);

  // With capture unavailable the reason reaches the popup so it can offer a reload.
  const failing = background({
    frames: (options) => options.files ? [] : [{ result: { ok: true, gain: 300, media: 1, routed: 0, blocked: 1 } }]
  });
  failing.breakCapture();
  const denied = await failing.send({ type: "SET_TAB_GAIN", tabId: 42, gain: 300 });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "blocked");
});

test("enabling a site registers an early script and reloads the tab once", async () => {
  const { send, registered, reloads } = background({
    frames: (options) => options.files ? [] : [{ result: { ok: true, gain: 300, media: 1, routed: 0, blocked: 1 } }]
  });
  const result = await send({ type: "ENABLE_SITE", tabId: 42, gain: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "page");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].runAt, "document_start");
  assert.equal(registered[0].world, "MAIN");
  assert.equal([...registered[0].js].join(), "content-early.js");
  assert.equal([...registered[0].matches].join(), "https://example.com/*");
  assert.deepEqual(reloads, [42]);

  // A second request reuses the registration rather than adding another.
  await send({ type: "ENABLE_SITE", tabId: 42, gain: 300 });
  assert.equal(registered.length, 1);
});

test("an audible tab with no media element falls back to tab capture", async () => {
  const { send, captures } = background({
    audible: true,
    frames: (options) => options.files ? [] : [{ result: { ok: true, gain: 300, media: 0, routed: 0, blocked: 0 } }]
  });
  const result = await send({ type: "SET_TAB_GAIN", tabId: 42, gain: 300 });
  assert.equal(result.mode, "capture");
  assert.deepEqual(captures, [42]);
});

test("without site access the page path is skipped entirely", async () => {
  const { send, captures, injections } = background({
    siteAccess: false,
    frames: () => { throw new Error("should not inject"); }
  });
  await send({ type: "SET_TAB_GAIN", tabId: 42, gain: 300 });
  assert.deepEqual(injections, []);
  assert.deepEqual(captures, [42]);
});

test("resetting a page-controlled tab restores it without stopping a capture", async () => {
  const { send, captures, injections } = background({
    frames: (options) => options.files ? [] : [{ result: { ok: true, gain: 300, media: 1, routed: 1, blocked: 0 } }]
  });
  await send({ type: "SET_TAB_GAIN", tabId: 42, gain: 300 });
  const result = await send({ type: "RESET_TAB", tabId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.capturing, false);
  assert.deepEqual(captures, []);
  assert.equal(injections.at(-1).func.toString().includes("reset"), true);
});
