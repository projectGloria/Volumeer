// Injected on demand by background.js into the page's own world, so it can see
// media elements that were never attached to the document. Routes each of them
// through a GainNode so any tab can be boosted without a toolbar click.
(() => {
  if (window.__volumeerControl) return;

  const MEDIA_SELECTOR = "audio, video";
  const nodes = new WeakMap();
  const upgraded = new WeakSet();
  const discovered = new Set();
  const state = { gain: 100, audioContext: null, observer: null };

  function scale() {
    return state.gain / 100;
  }

  function audioContext() {
    if (!state.audioContext) state.audioContext = new AudioContext();
    if (state.audioContext.state === "suspended") state.audioContext.resume().catch(() => {});
    return state.audioContext;
  }

  // createMediaElementSource silences cross-origin media that was not fetched
  // with CORS, so those elements must stay on the untouched element volume.
  function canRoute(element) {
    const source = element.currentSrc || element.src || "";
    if (!source) return true;
    if (/^(blob|data|mediasource|filesystem):/i.test(source)) return true;
    try {
      if (new URL(source, location.href).origin === location.origin) return true;
    } catch {
      return true;
    }
    return Boolean(element.crossOrigin);
  }

  // Sites such as SoundCloud stream from a media CDN without the CORS headers
  // createMediaElementSource needs. Refetching with crossOrigin set makes the
  // element routable when the CDN allows it, and is rolled back when it does not.
  async function upgradeToCors(element) {
    if (upgraded.has(element) || element.crossOrigin) return false;
    upgraded.add(element);

    const source = element.currentSrc || element.src || "";
    if (!/^https?:/i.test(source)) return false;

    const position = element.currentTime;
    const wasPlaying = !element.paused;
    element.crossOrigin = "anonymous";

    const reloaded = await new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer);
        element.removeEventListener("loadeddata", onLoad);
        element.removeEventListener("error", onError);
        resolve(ok);
      };
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), 4000);
      element.addEventListener("loadeddata", onLoad);
      element.addEventListener("error", onError);
      element.load();
    });

    if (!reloaded) {
      element.removeAttribute("crossorigin");
      element.load();
    }
    try {
      element.currentTime = position;
    } catch {
      // Some streams reject seeking before they are buffered again.
    }
    if (wasPlaying) element.play().catch(() => {});
    return reloaded;
  }

  function attach(element) {
    const existing = nodes.get(element);
    if (existing) return existing;
    if (!canRoute(element)) return null;

    try {
      const context = audioContext();
      const source = context.createMediaElementSource(element);
      const gainNode = context.createGain();
      source.connect(gainNode).connect(context.destination);
      const node = { source, gainNode, context };
      nodes.set(element, node);
      return node;
    } catch {
      return null;
    }
  }

  async function applyTo(element) {
    let node = nodes.get(element);
    if (!node && scale() > 1) {
      if (!canRoute(element)) await upgradeToCors(element);
      node = attach(element);
    }

    if (node) {
      element.volume = 1;
      node.gainNode.gain.setTargetAtTime(scale(), node.context.currentTime, 0.015);
      if (node.context.state === "suspended") node.context.resume().catch(() => {});
      return "routed";
    }

    if (scale() <= 1) {
      element.volume = scale();
      return "routed";
    }

    element.volume = 1;
    return "blocked";
  }

  // Detached elements never appear in a DOM query, so the registry kept by
  // content-early.js and the play hook below are the only way to reach them.
  function mediaElements() {
    const found = new Set(document.querySelectorAll(MEDIA_SELECTOR));
    for (const element of window.__volumeerMedia || []) found.add(element);
    for (const element of discovered) found.add(element);
    return [...found].filter((element) => element instanceof HTMLMediaElement);
  }

  async function applyAll() {
    const elements = mediaElements();
    let routed = 0;
    let blocked = 0;
    for (const element of elements) {
      if (await applyTo(element) === "routed") routed += 1;
      else blocked += 1;
    }
    return { media: elements.length, routed, blocked };
  }

  function observe() {
    if (state.observer) return;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!discovered.has(this)) {
        discovered.add(this);
        applyTo(this);
      }
      return play.apply(this, args);
    };

    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (!(added instanceof Element)) continue;
          if (added.matches?.(MEDIA_SELECTOR)) applyTo(added);
          for (const nested of added.querySelectorAll?.(MEDIA_SELECTOR) || []) applyTo(nested);
        }
      }
    });
    state.observer.observe(document.documentElement || document, { childList: true, subtree: true });
    // Media sources are often swapped in after playback starts.
    document.addEventListener("play", (event) => {
      if (event.target instanceof HTMLMediaElement) applyTo(event.target);
    }, true);
    document.addEventListener("loadedmetadata", (event) => {
      if (event.target instanceof HTMLMediaElement) applyTo(event.target);
    }, true);
  }

  window.__volumeerControl = {
    async setGain(gain) {
      state.gain = gain;
      observe();
      return { ok: true, gain, ...(await applyAll()) };
    },

    async getState() {
      return { gain: state.gain, ...(await applyAll()) };
    },

    reset() {
      for (const element of mediaElements()) {
        const node = nodes.get(element);
        if (node) node.gainNode.gain.setTargetAtTime(1, node.context.currentTime, 0.015);
        element.volume = 1;
      }
      state.gain = 100;
      state.observer?.disconnect();
      state.observer = null;
      return { ok: true };
    }
  };
})();
