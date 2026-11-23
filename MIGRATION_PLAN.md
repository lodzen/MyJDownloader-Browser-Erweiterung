# MV2 → MV3 Migration: Gap Analysis & Restoration Plan

Scope: everything missing or broken between the initial commit `6f0b527`
(`initial commit`, Manifest V2) and `HEAD` on `migration-mv3` (Manifest V3),
verified by code review **and live testing** (Edge 158 and branded Chrome 158
via CDP `Extensions.loadUnpacked` — extension loads and behaves identically;
real JDownloader on `127.0.0.1:9666`).

See `AGENTS.md` for repo conventions and how to test.

---

## 1. Architecture change (MV2 → MV3)

| | MV2 (`6f0b527`) | MV3 (`migration-mv3`) |
|---|---|---|
| MyJDownloader API client (`jdapi`, `MyjdService`) | Persistent background page (`index.html` + `BackgroundCtrl`) | Runs inside **each extension page** (popup, toolbar iframe, options). `BackgroundScriptService` was rewritten from a message-proxy to a local wrapper. |
| Background logic | `BackgroundCtrl` (Angular, persistent) | `scripts/background_service_worker.js` (vanilla JS, non-persistent). `BackgroundCtrl` is still shipped but self-disables under MV3. |
| Request interception | `webRequestBlocking` (could cancel/redirect the actual request) | `webRequest` observe-only + 2 DNR rules for `jdcheck.js`/`crossdomain.xml` |
| Session persistence | `localStorage` of the bg page | `chrome.storage.local["jdapi/src/core/core.js"]` (jdapi built-in) + `MYJD_CONNECTION_ACTIVE` flag |
| Toolbar/CNL queue | In-memory in `BackgroundCtrl`, delivered via `ExtensionMessagingService` | In-memory `REQUEST_QUEUE` in the SW (persisted to `CNL_REQUEST_QUEUE` storage) |

**Core architectural risk:** the API client/session is owned by short-lived
pages instead of one durable owner. Any page's failed session-restore writes
`MYJD_CONNECTION_ACTIVE=false`, which globally disables CNL interception and
context menus. Requests on a not-connected `jdapi` instance are enqueued
forever (jQuery deferred that never settles).

---

## 2. Confirmed bugs (reproduced live)

### P0 — Click'n'Load (top priority)

1. **`web_accessible_resources` `matches` bug** — `assets/jdcheck.js` and
   `assets/crossdomain.xml` are only exposed to `127.0.0.1:9666`/
   `localhost:9666` initiators. `matches` must cover the *requesting page*
   (arbitrary CNL sites). Result: the DNR redirect fires but the resource
   fails with `net::ERR_BLOCKED_BY_CLIENT` → sites never see
   `window.jdownloader` → CNL entry points dead. **Reproduced.**
   Fix: `matches: ["<all_urls>"]` in `manifest.json`.

2. **`injectJdCheckFlag` never sets the flag** —
   `chrome.scripting.executeScript` runs `func` in the **isolated world**;
   the `<script>`-append trick never reaches the page's `window`.
   Reproduced: `execScript resolved`, `window.jdownloader` still `undefined`.
   Fix: `world: 'MAIN'` in `background_service_worker.js`.

3. **CNL interception gated by a fragile flag** —
   `shouldProcessClickAndLoad` requires `MYJD_CONNECTION_ACTIVE=true`, but
   any failed session-restore in any extension page writes `false` and kills
   interception + context menus globally. Reproduced: POST to
   `127.0.0.1:9666/flash/add` silently dropped, `REQUEST_QUEUE` stayed `{}`.
   With the flag forced `true` the full chain works: POST → queue → toolbar
   iframe injected → CNL request rendered (device list + "Save for later").
   Fix: always intercept/queue; gate only `addLinks`/UI on login state. Make
   the flag last-known-good (only flip on explicit logout/login result).

4. **`request.content` shape mismatch** — SW queues
   `{source, package, passwords, urls, jk, crypted, custom}`, but
   `AddLinksController.$scope.send()` expects
   `request.content.requestBody.formData` to build the
   `dummycnl.jdownloader.org` link (`AddLinksController.js` ~lines 716-753).
   Consequence: `query.links` gets an `"undefined\r\n..."` prefix and
   **`crypted`/`jk` (`addcrypted2`) CNL is completely lost**.
   Fix: include `requestBody: {formData}` plus the top-level fields, matching
   the old `details` shape.

5. **POST to 9666 is not canceled** — MV3 `webRequest` cannot block; there is
   no DNR rule for `/flash/add*`. Result: request hits the real local JD
   (double-send when remote add also succeeds) or lands on a dead error page
   for `main_frame` navigation, where the in-page toolbar cannot be injected.
   Old code canceled the request and replaced the tab content.
   Fix: DNR `block`/`redirect` rule for `/flash/add*` (block = simplest,
   prevents double-send) and open `toolbar.html` popup instead of relying on
   in-page injection when the navigation target dies.

### P0 — "Login works, no downloaders found"

The Angular device-list pipeline is **verified working** (stubbed
`api.listDevices` → `{data:{devices:[...]}}` rendered + cached). Suspects:

6. **`getDeviceList` hangs forever when not CONNECTED** — jdapi `_call`
   enqueues while state ≠ CONNECTED; the deferred never resolves/rejects →
   stuck "initializing" or empty list. **Reproduced.**
   Fix: guard API state in `MyjdService.getDeviceList` (reject or defer
   until connected) + timeout in `BackgroundScriptService.getDevices`.

7. **Optimistic login state** — `MYJD_CONNECTION_ACTIVE` in storage shows
   "logged in" even when the session is expired → `listDevices` enqueues or
   fails → looks exactly like "logged in but no devices".
   Fix: reconcile flag/UI with real session state; only show logged-in after
   the first successful `listDevices`, or surface the API error.

8. **`ToolbarController.refreshDevices` bug** (pre-existing) —
   `$scope.devices = result.data` assigns `{devices:[...]}` instead of
   `result.data.devices` → `.contains`/`push` throws
   (`ToolbarController.js` ~lines 377-397).

9. **Possible `URLBlocked` on `/my/listdevices`** — HEAD added that error
   type, suggesting it was seen in practice; the appkey
   `myjd_webextension_chrome` may be server-side rejected. Needs a
   real-credential test to confirm or rule out.

### P1 — Wiring gaps (features present but unreachable)

10. **`new-copy-event` (clipboard observer)** — `onCopyContentscript.js`
    sends it; no SW handler → feature dead.
11. **`myjd-selection`/`new-selection`** — context menu "Add selection"
    sends `get-selection`; the reply is unhandled → dead.
12. **Keyboard shortcuts** (`Ctrl+Shift+X/Y` clipboard toggle, auto-grab) —
    declared in `manifest.json`, no `chrome.commands.onCommand` listener in
    the SW → dead.
13. **`PopupIconService` uses `chrome.browserAction`** — removed in MV3;
    `updateBadge` throws if called → port to `chrome.action`.
14. **Double `initializeState()`** → `Cannot create item with duplicate id
    simple_menu_item` on boot; `connectionActive` defaults to `true` on a
    fresh install (`undefined !== false`). Make init idempotent.
15. **Async rejections uncaught** — `chrome.tabs.sendMessage` /
    `chrome.scripting.executeScript` promises reject outside the
    synchronous try/catch → unhandled rejection noise; also
    `onMessage` handlers that return `true` must actually `sendResponse`
    asynchronously or the channel closes with a console error.

### P2 — Removed, not ported

| Feature | Files removed in `89b3de6`/`02981ec` |
|---|---|
| reCAPTCHA/hCaptcha **browser solver** (JD delegates captcha solving to the browser, incognito option) | `scripts/services/Rc2Service.js` (~400 lines), `contentscripts/rc2Contentscript.js` (~650), `contentscripts/rc2LoadingIndicator.js`, `contentscripts/browserSolverEnhancer.js`, `res/browser_solver_template.html` |
| my.jdownloader.org **webinterface enhancer** | `contentscripts/webinterfaceEnhancer.js` |
| Settings `ENHANCE_CAPTCHA_DIALOG`, `CAPTCHA_PRIVACY_MODE` | removed from `StorageService`/UI (locale strings remain) |
| `PopupCandidatesService` popup heuristic | simplified to opener/active-tab lookup in SW — acceptable |
| `_metadata/verified_contents.json` | CRX store artifact — not needed unpacked |
| `BrowserService`, MV2-only `BackgroundCtrl` body | dead code still shipped |

---

## 3. Prioritized plan — STATUS

Legend: `[x]` done & verified live · `[-]` done, needs real-credential/UI verification · `[ ]` open

**P0-1 · CNL chain**
1. `[x]` `manifest.json` → WAR `matches: ["<all_urls>"]` — verified: `window.jdownloader=true` now set on test page (was `ERR_BLOCKED_BY_CLIENT`).
2. `[x]` `injectJdCheckFlag` → `world: 'MAIN'` + direct assignment + `.catch`.
3. `[x]` CNL interception decoupled from `MYJD_CONNECTION_ACTIVE` (`shouldProcessClickAndLoad` no longer checks it); transient PENDING/RECONNECT states no longer write `false` to the flag (`MyjdService.apiStateChanceListener`).
4. `[x]` `buildCnlContent` → `content` now carries `requestBody:{formData}` + `url` + decoded top-level fields — verified in queue: `formData` present → `dummycnl` path in `AddLinksController.send()` can fire.
5. `[x]` DNR: `/flash/add*` blocked (rule 4, priority 1); `fromExtension` URLs allowed (rule 3, priority 2). `main_frame` same-tab nav → `chrome.tabs.update` to `toolbar.html?id=…` (error page can't host the iframe).
   - Verified live: POST → `ERR_BLOCKED_BY_CLIENT` → queued → toolbar iframe injected even with `connectionActive=false`.

**P0-2 · Device discovery**
6. `[x]` `MyjdService.getDeviceList` → rejects `NOT_CONNECTED` when DISCONNECTED/no api (no more infinite enqueue), 20s `DEVICE_LIST_TIMEOUT` cap. `ToolbarController.refreshDevices` → `result.data.devices` + `.some()` guard (was `result.data` + nonexistent `.contains` — would have thrown).
7. `[x]` Error surfacing fixed: `NOT_CONNECTED`/`DEVICE_LIST_TIMEOUT` now carry `src:'myjd'` so `createApiError` preserves their types (was squashed to UNKNOWN → "Unknown communication error"); `ConnectedCtrl.onApiError`/`updateDevices` suppress `NOT_CONNECTED` (session-change switches to login view) and map timeout to "Failed to get a list of your JDownloaders"; popup template `ng-show` no longer renders the empty `{}` error box. Optimistic logged-in display still storage-driven — acceptable.
7b. `[x]` Settings from logged-out popup: `showLoggedOutSettings` no longer calls `chrome.runtime.openOptionsPage()` (new tab + options page); it switches `state.showSettings` and renders `<my-settings>` in-popup with a back link (`templateCache.js` popup.html).
8. `[x]` Real-credential test PASSED (live capture, branded Chrome 158): `/my/connect` 200 → CONNECTED → `/my/listdevices` 200 → device "PC" found → `getDirectConnectionInfos` + `polling/poll` 200 → `CACHED_DEVICE_LIST` persisted. No `URLBlocked`. Minor follow-ups: `ui_status_panel_loading` i18n key missing; appkey resolves to `myjd_webextension_firefoxself_3_2_34` via UA sniffing quirk (accepted by server); each extension page owns its own api instance so cross-page logged-in state can disagree (architectural — see §1).

**P1 · Wiring**
9. `[x]` SW handlers added: `new-copy-event` (gates on `CLIPBOARD_OBSERVER` → `get-selection`), `myjd-selection`/`new-selection` → `addTextToRequestQueue` (type `text`, injects toolbar script, opens toolbar), `chrome.commands.onCommand` (`toggle-clipboard-observer` flips the setting).
10. `[x]` `PopupIconService` → `chrome.action`. (Dead `chrome.extension.*`/`BackgroundCtrl` remnants still shipped — cleanup optional.)
11. `[x]` `initializeState` idempotent (`stateInitialized` guard — no more duplicate context-menu ids); `connectionActive` default `=== true` not `!== false`; `sendTabMessage` helper suppresses async `lastError` (open/close toolbar, get-selection, session-change broadcast); `login-success`/`login-failed` handlers now `return true` (async `sendResponse`).

**P2 · Feature restoration**
12. `[ ]` Port the captcha browser-solver suite (Rc2Service + 4 scripts) to MV3.
13. `[ ]` Port `webinterfaceEnhancer` for my.jdownloader.org.

**Next verification round**: reload unpacked extension → repeat live CNL test → then real login + `listDevices` (needs user credentials).
