// Registered per site by background.js and run at document_start in the page's
// own world. Media fetched without CORS cannot be routed through a GainNode, so
// every media element is marked before it loads. Sites whose media server
// refuses the CORS request are put back the way they were.
(() => {
  if (window.__volumeerEarly) return;
  window.__volumeerEarly = true;

  const MEDIA_TAG = /^(audio|video)$/i;
  // Players such as SoundCloud create their audio with new Audio() and never
  // attach it, so a DOM query alone never finds it. Every media element is
  // recorded here as it is created or played.
  const tracked = window.__volumeerMedia = window.__volumeerMedia || new Set();

  function track(element) {
    if (!(element instanceof HTMLMediaElement)) return element;
    tracked.add(element);
    mark(element);
    return element;
  }

  function mark(element) {
    if (!(element instanceof HTMLMediaElement)) return;
    if (element.crossOrigin || element.dataset.volumeerCors) return;
    element.dataset.volumeerCors = "1";
    element.crossOrigin = "anonymous";
    element.addEventListener("error", () => {
      if (!element.dataset.volumeerCors) return;
      delete element.dataset.volumeerCors;
      element.removeAttribute("crossorigin");
      element.load();
    });
  }

  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) {
    const element = createElement.call(this, tag, ...rest);
    if (typeof tag === "string" && MEDIA_TAG.test(tag)) track(element);
    return element;
  };

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    track(this);
    return play.apply(this, args);
  };

  const NativeAudio = window.Audio;
  if (typeof NativeAudio === "function") {
    const PatchedAudio = function (...args) {
      return track(new NativeAudio(...args));
    };
    PatchedAudio.prototype = NativeAudio.prototype;
    window.Audio = PatchedAudio;
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLMediaElement) track(node);
        else if (node instanceof Element) {
          for (const nested of node.querySelectorAll?.("audio, video") || []) track(nested);
        }
      }
    }
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });

  for (const element of document.querySelectorAll?.("audio, video") || []) track(element);
})();
