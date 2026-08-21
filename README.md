# LinkPad — KaiOS Bookmark Manager (Hosted App)

Plain HTML/CSS/JS - no frameworks, no build step. Designed for 240x320 portrait feature phones with a D-pad and a numeric keypad. The app name (LinkPad) is a brand: identical in every language, taken straight from the HTML rather than the localization files. Internal identifiers (IndexedDB name `kaios-bookmarks`, storage keys `bm-*`) intentionally keep their original values so existing user data survives upgrades.

## Visual design language ("Ink & Amber")

- **Colors (6 total)**: ink `#0F141B` (background) / panel `#1A222E` (rows, top bar) / primary text `#F0F3F7` / secondary text `#93A0B0` / amber `#FFC24B` (the only accent: focus row, top-bar mark, soft-key middle action) / boundary `#2A3542`
- **Focus is functional feedback**: amber background + ink text is a double inversion (hue + lightness), reinforced by the left amber bar and the `»` prefix - still the most striking block on a monochrome screen
- **Signature detail: the domain ribbon** - a 4px color band on the left of each bookmark row, colored by a domain hash into a 5-color palette (sky/mint/violet/rose/steel; amber deliberately excluded). The same site always gets the same color (`ribbonIndex` in `js/app.js` + `.rb-0..rb-4` in `css/style.css`)
- **Three-segment soft key bar**: left `▲▼` / middle = Enter action (follows focus, amber) / right = Backspace action; the segments map to the physical keys (D-pad center, backspace area). Strings live in the `act-*` keys
- **Empty state**: three small ribbons in the palette (pure CSS) + a two-line message (`empty-title` / `empty-sub`), echoing the "bookmark = ribbon" metaphor
- No external fonts or images; only a 0.1s background transition - compatible with old Gecko engines

## KaiAds advertising (required by the KaiStore)

The integration layer lives in `js/ads.js`; the SDK loads from a remote script (`defer` at the end of `index.html`, never blocking startup). Pre-submission checklist:

1. Replace `PUBLISHER_ID` at the top of `js/ads.js` (currently the `YOUR_PUBLISHER_ID_HERE` placeholder) and `BANNER_SLOT` / `INTERSTITIAL_SLOT` / `APP_NAME`
2. `TEST_MODE = 1` requests test ads during development - **set to 0 before submission**
3. Cross-check the two TODOs against the official KaiAds v4 docs: banner `ad.banner` mounting and the `ad.call('display')` signature
4. The version of `dependencies["ads-sdk"]` in `manifest.webapp` is an empty placeholder - fill it in after confirming the latest SDK version
5. To bundle the SDK locally: download `ads-sdk.v4.min.js` into `js/lib/` and replace the remote reference

Policy: the banner lives only at the bottom of the list view (hidden in all other views); the interstitial fires only at cold start into the home screen, at most once per session and at least 10 minutes after the last show (`INTERSTITIAL_MIN_INTERVAL`, adjustable); SDK load failure / no fill / 8-second polling timeout all degrade silently - no ad slot, no impact on features. The soft key bar is hardened against the known KaiAds pitfall: `position: fixed; top: calc(100vh - 34px)` (no `bottom`), paired with `#app { padding-bottom: 34px }` - change both together.

## Localization (official KaiOS webL10n approach)

- Static strings: marked with `data-l10n-id` in `index.html`, translated automatically by `js/lib/l10n.js` (official webL10n); input placeholders use the `id.placeholder` dot syntax
- Dynamic strings: go through `navigator.webL10n.get(key, args)` in `js/app.js` (wrapped as `L()`)
- Language resources: `locales/locales.ini` @imports the per-language `.properties` by section (en-US default, hi-IN, fr-FR, sw-KE)
- Startup resolution: `localStorage` manual override > `navigator.language` match (exact full tag first, then language prefix) > en-US fallback
- Manual switching: the "Language" command row opens the language view (Enter applies, Backspace goes back); the choice persists in `localStorage`, and "Follow system language" clears the override

Adding a language: add `locales/xx-YY.properties` (copy all keys), a section in `locales/locales.ini`, an entry in `SUPPORTED_LANGS`/`LANG_NAMES` in `js/app.js`, the translation in `manifest.webapp`'s `locales`, and a row in the language view in `index.html`.

## Keys

| Key | Action |
|---|---|
| Up/Down | Move through the circular focus chain (also switches form fields) |
| Enter | Run the command / open the bookmark (records the visit + Web Activity to the system browser) / confirm |
| Backspace | Leave a subview back to the list; on a bookmark = open the action menu (edit/delete entry); in the search box with text = delete a char, when empty = cancel the search; at the list top level = handed to the system (exits the app) |

## Local testing (desktop)

```bash
cd bookmark
python3 -m http.server 8080
# open http://localhost:8080/index.html in a browser,
# shrink the window to 240x320 (DevTools device emulation),
# and drive everything with the keyboard
```

Desktop browsers have no `MozActivity`, so opening a bookmark falls back to `window.open` in a new tab.

## Deploying as a KaiOS Hosted App

1. Put the whole directory on an **HTTPS** server; `launch_path` (`/index.html`) and the icon paths are resolved against the site root.
2. The server must serve `.webapp` files with `Content-Type: application/x-web-app-manifest` (Nginx example: `types { application/x-web-app-manifest webapp; }`). Serve `manifest.*.webmanifest` (KaiStore store-listing variants for hi-IN / fr-FR / sw-KE) with `application/manifest+json`.
3. Install on a KaiOS device via Settings → App update/developer tools, or verify with WebIDE (`adb forward tcp:6000 tcp:6000`).

## Data

IndexedDB: database `kaios-bookmarks`, object store `bookmarks`, fields `id / title / url / dateAdded / dateAccessed` (`dateAccessed = 0` means never visited - not null, because indexes skip null records).

Every read/write is wrapped in try/catch and reports through the soft key bar toast (including `QuotaExceededError`); no storage failure can crash the app.
