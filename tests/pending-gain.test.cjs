const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("requested volume survives popup closure and applies only on the target toolbar invocation", async () => {
  const stored = {};
  const captures = [];
  const event = { addListener() {} };
  let listener;
  const context = vm.createContext({
    chrome: {
      storage: { session: {
        async get(key) { return { [key]: stored[key] }; },
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; }
      } },
      tabs: {
        onRemoved: event, onUpdated: event,
        async get(id) { return { id, url: "https://example.com/", windowId: 7 }; },
        async update() {}
      },
      permissions: { async contains() { return false; } },
      scripting: { async executeScript() { return []; } },
      windows: { async update() {} },
      action: { async setBadgeText() {}, async setTitle() {}, async setBadgeBackgroundColor() {} },
      tabCapture: { async getMediaStreamId({ targetTabId }) { captures.push(targetTabId); return "stream"; } },
      runtime: {
        onMessage: { addListener(callback) { listener = callback; } }, onSuspend: event,
        getURL: (url) => url, async getContexts() { return [{}]; },
        async sendMessage(message) { return { ok: true }; }
      }
    }
  });
  vm.runInContext(readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const send = (message) => new Promise((resolve) => listener(message, {}, resolve));
  assert.equal((await send({ type: "PREPARE_TAB_GAIN", tabId: 42, gain: 250 })).ok, true);
  assert.equal(captures.length, 0);
  assert.equal((await send({ type: "APPLY_PENDING_GAIN", tabId: 1 })).applied, false);
  const result = await send({ type: "APPLY_PENDING_GAIN", tabId: 42 });
  assert.equal(result.applied, true);
  assert.equal(result.gain, 250);
  assert.deepEqual(captures, [42]);
  assert.equal(stored.pendingGain, undefined);
  const update = await send({ type: "SET_TAB_GAIN", tabId: 42, gain: 350 });
  assert.equal(update.gain, 350);
  assert.equal(captures.length, 1);
});
