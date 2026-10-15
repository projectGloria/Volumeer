# Volumeer

Volumeer is a Brave/Chromium extension that boosts audio independently for each tab from 0% to 500%.

## Install in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `Volumeer` folder.
5. Pin Volumeer from the extensions menu if you want one-click access.

## Use

Open the Volumeer popup to see your tabs across browser windows. It lists only tabs with something to play: tabs that are playing, muted, already boosted, or that have played audio since the browser started. Browser pages such as `brave://history` are never listed, since their audio cannot be controlled. If no tab qualifies, every controllable tab is listed so there is always something to pick. Tabs are grouped by site. A site with several tabs gets a heading carrying its favicon, name, and how many of its tabs are boosted, and clicking that heading collapses the group; a site with one tab is shown as a single row with its favicon inline. Long titles are trimmed with an ellipsis. Each row shows its tab's boost level, or a mute icon when the tab is set to 0% or muted by the browser. Each row shows its tab's boost level, whether it is playing or muted, and which window it belongs to. Select a tab, then use the slider, presets, or **Reset this tab** for that selection. The list updates as tabs open, close, or change.

Volumeer asks for access to websites when you install it. With that granted, you can change **any** tab's volume straight from the popup, without leaving the tab you are on, and the slider applies as you drag it. Volumeer injects a small script into the target tab that routes its `<audio>` and `<video>` elements through a gain control, and reapplies your setting after that tab navigates. Media served from another origin is refetched with CORS so it can be boosted too; if that fetch is refused, the original stream is restored untouched.

Some players, SoundCloud among them, build their audio element without ever putting it in the page, or fetch their stream in a way that cannot be routed after the fact. Volumeer cannot reach those on a page that is already loaded, so it offers **Reload tab to enable boost**. Accepting it registers a small script for that site alone which records every media element as it is created and marks it for CORS before it loads, then reloads the tab in place. That site is controllable from then on, including on later visits. Volumeer never jumps to or reloads a tab on its own.

Sites that play through Web Audio with no media element at all cannot be handled either way. Those show **Open tab to enable boost**, and only if you click it does the tab come forward, where one click on the Volumeer icon switches that tab to tab capture. Click the **Volumeer toolbar icon** there once (within two minutes, without navigating away) to grant capture access, after which that tab is controlled from the list like any other. **Reset this tab** ends its session. Browser and extension store pages stay listed with controls disabled.

After updating, reload Volumeer on the extensions page. The `tabs` permission lets the popup display titles and audio status for all tabs. The popup grows taller as tabs are added. Brave caps extension popups at 600 pixels tall, which fits roughly eleven tabs; past that the list scrolls on its own and the controls stay in view.

Browser-internal pages such as `brave://settings`, the Chrome Web Store, and some protected media cannot be controlled at all. Very high gain can clip or distort already-loud audio; start around 150–200%.

## Files

- `background.js` owns per-tab state, chooses the page or capture path, and holds tab-capture permissions.
- `content.js` is injected on demand and applies gain to a tab's media elements.
- `content-early.js` is registered per site, records media elements as they are created, and marks them for CORS before they load.
- `offscreen.js` runs the Web Audio gain graph for captured tabs.
- `popup.html`, `popup.css`, and `popup.js` provide the control panel.
- `icon.png` is the 512px source artwork; `icons/` holds the sizes the manifest points at.
