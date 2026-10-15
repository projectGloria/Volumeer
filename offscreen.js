const captures = new Map();

function stopCapture(tabId, notify = false) {
  const capture = captures.get(tabId);
  if (!capture) return;

  captures.delete(tabId);
  for (const track of capture.stream.getTracks()) track.stop();
  capture.source.disconnect();
  capture.gainNode.disconnect();
  capture.audioContext.close().catch(() => {});

  if (notify) {
    chrome.runtime.sendMessage({ type: "CAPTURE_ENDED", tabId }).catch(() => {});
  }
}

async function startCapture({ tabId, streamId, gain }) {
  stopCapture(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = gain / 100;
  source.connect(gainNode).connect(audioContext.destination);

  const capture = { stream, audioContext, source, gainNode };
  captures.set(tabId, capture);

  stream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (captures.get(tabId) === capture) stopCapture(tabId, true);
  }, { once: true });

  if (audioContext.state === "suspended") await audioContext.resume();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  const handle = async () => {
    switch (message.type) {
      case "START_CAPTURE":
        await startCapture(message);
        return { ok: true };

      case "SET_GAIN": {
        const capture = captures.get(message.tabId);
        if (!capture) throw new Error("This tab's audio session ended. Move the slider to reconnect.");
        capture.gainNode.gain.setTargetAtTime(
          message.gain / 100,
          capture.audioContext.currentTime,
          0.015
        );
        return { ok: true };
      }

      case "STOP_CAPTURE":
        stopCapture(message.tabId);
        return { ok: true };

      default:
        return null;
    }
  };

  handle()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
