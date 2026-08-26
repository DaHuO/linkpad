/*
 * KaiAds SDK integration layer (required for KaiStore submission)
 *
 * API usage follows the official KaiAds SDK docs (kaiads.com/publishers/sdk.html):
 *  - callbacks are `onerror` / `onready` (NO underscores - getting these
 *    wrong makes the SDK fail with error code 2 into a callback it can
 *    never reach, i.e. completely silent failure);
 *  - responsive (banner) ads REQUIRE `container`, `w` and `h` in the
 *    getKaiAd config - without a container the SDK requests a fullscreen
 *    ad instead and no banner ever appears;
 *  - ads are displayed with `ad.call('display', {...})`; events are
 *    'display' / 'click' / 'close'.
 *
 * Design principles (utility app - restrained ad placement):
 *  - Banner: permanently in the list view only (above the soft key bar),
 *    hidden together with the view on switches, so add/edit/delete and
 *    language operations are never interrupted by ads;
 *  - Interstitial: fires only at "cold start into the home screen" with
 *    two layers of frequency control:
 *      1) an in-memory flag: at most once per cold start (page
 *         lifecycle);
 *      2) a localStorage timestamp: skipped when the last successful
 *         show is less than MIN_INTERVAL ago;
 *  - Silent degradation: every failure path - remote script not loading,
 *    getKaiAd missing, onerror, SDK not ready within 8 seconds - just
 *    gives up silently (console logs kept for debugging); bookmark
 *    functionality is never affected.
 *
 * Exposes only window.BmAds.init(), called once by app.js after the
 * home screen is ready.
 */
(function () {
  'use strict';

  /* =====================================================================
   * Configuration (TODO: replace before submitting to the store)
   * ===================================================================== */

  // Publisher ID from the KaiAds portal (publisher.kaiads.com)
  var PUBLISHER_ID = '59c555c8-c385-480c-a86b-6f61fba7d5d4';
  // Optional per the docs (used for reporting only)
  var APP_NAME = 'linkpad';
  var BANNER_SLOT = 'banner_list_bottom';
  var INTERSTITIAL_SLOT = 'interstitial_cold_start';

  // Test mode: 1 = request test ads. Keep at 1 while the store reviews
  // the app (they will see test ads); set to 0 for commercial launch.
  var TEST_MODE = 0;

  // Request timeout in ms (SDK-side). The docs' default is 60s; shorter
  // so a dead network does not keep requests hanging.
  var REQUEST_TIMEOUT = 10000;

  // Banner size: the docs support up to 240x264 and reject too-small
  // containers (error codes 3/6). 240x64 is the standard mobile banner
  // size and keeps enough room for the bookmark list on a 320px screen.
  // Keep in sync with the #ad-banner height in css/style.css.
  var BANNER_W = 240;
  var BANNER_H = 64;

  // Interstitial master switch. Frequency follows the official best
  // practice: after a fullscreen ad at launch, wait for at least five
  // more completed sessions (cold starts) before showing it again.
  var INTERSTITIAL_ENABLED = true;
  var INTERSTITIAL_MIN_SESSIONS = 5;

  // Session (cold start) counter and the launch number at which the
  // last interstitial was actually shown (localStorage; try/catch'd -
  // private mode degrades to "once per session only" via the in-memory
  // flag)
  var LS_LAUNCH_COUNT = 'bm-ad-launch-count';
  var LS_LAST_SHOWN_LAUNCH = 'bm-ad-last-shown-launch';

  // SDK wait budget: the remote script loads with defer, so on a slow
  // network the app runs first and the SDK arrives later; after this
  // deadline ads are abandoned for the session (silently, no retry)
  var SDK_WAIT_TIMEOUT = 8000;
  var SDK_POLL_INTERVAL = 250;

  /* =====================================================================
   * Internal state
   * ===================================================================== */

  var bannerRequested = false;              // guards against duplicate banner requests
  var interstitialTriedThisSession = false; // interstitial attempted this cold start
  var inited = false;
  var currentLaunch = 0;                    // sequential cold-start number of this session

  // KaiAds serves ads to KaiOS devices; the official website-integration
  // sample guards every request with this UA check. On desktop browsers
  // banner requests just time out (error 5) and test creatives get in
  // the way of debugging, so ads are fully disabled off-device.
  function isKaiOS() {
    return /kaios/i.test(navigator.userAgent || '');
  }

  function readLaunchCount() {
    try {
      return parseInt(window.localStorage.getItem(LS_LAUNCH_COUNT) || '0', 10) || 0;
    } catch (e) { return 0; }
  }

  function readLastShownLaunch() {
    try {
      return parseInt(window.localStorage.getItem(LS_LAST_SHOWN_LAUNCH) || '0', 10) || 0;
    } catch (e) { return 0; }
  }

  function sdkReady() {
    // The SDK exposes the global getKaiAd on window once loaded
    return typeof window.getKaiAd === 'function';
  }

  // The SDK is a deferred remote script at the end of body, so app.js
  // runs before it. Poll for it here and give up silently on timeout.
  // We don't listen to script.onload because the script may already be
  // loading by the time ads.js executes, which would miss the event.
  function whenSdkReady(onReady) {
    if (sdkReady()) { onReady(); return; }
    var waited = 0;
    var timer = setInterval(function () {
      waited += SDK_POLL_INTERVAL;
      if (sdkReady()) {
        clearInterval(timer);
        onReady();
      } else if (waited >= SDK_WAIT_TIMEOUT) {
        clearInterval(timer);
        // Give up silently: on a bad network the app must keep working
        if (window.console && console.log) {
          console.log('[ads] SDK not ready in ' + SDK_WAIT_TIMEOUT + 'ms, skip ads');
        }
      }
    }, SDK_POLL_INTERVAL);
  }

  /* =====================================================================
   * Banner ad (responsive; permanent at the bottom of the list view)
   *
   * The #ad-banner container sits inside view-list, below the scroll
   * area:
   *  - the container element, width and height are passed in the
   *    getKaiAd config as the docs require for responsive ads;
   *  - hidden is removed only on the ad's 'display' event (no reserved
   *    space while unfilled);
   *  - the container hides/shows together with view-list, so other
   *    views have no ad slot;
   *  - tabindex + navClass integrate the ad into this app's focus
   *    chain (.focusable), so users can reach it with the D-pad and
   *    press Enter to interact - key events inside the ad's iframe do
   *    not bubble into our keydown handler.
   * ===================================================================== */

  function loadBanner() {
    if (bannerRequested) return;
    var container = document.getElementById('ad-banner');
    if (!container) return;
    bannerRequested = true;
    try {
      window.getKaiAd({
        publisher: PUBLISHER_ID,
        app: APP_NAME,
        slot: BANNER_SLOT,
        test: TEST_MODE,
        timeout: REQUEST_TIMEOUT,
        container: container,       // required for responsive ads
        w: BANNER_W,
        h: BANNER_H,
        onerror: function (error) {
          // Lightweight DOM state marker for debugging (readable via
          // devtools or remote inspect); no visual impact
          container.setAttribute('data-ad-state', 'error ' + error);
          // No fill / network failure: stay silent, the UI keeps no ad
          // slot at all
          if (window.console && console.log) {
            console.log('[ads] banner error:', error);
          }
        },
        onready: function (ad) {
          container.setAttribute('data-ad-state', 'ready');
          try {
            ad.on('display', function () {
              container.setAttribute('data-ad-state', 'displayed');
              // The ad is actually on screen - only now reserve the space
              container.classList.remove('hidden');
            });
            ad.on('error', function (e) {
              if (window.console && console.log) console.log('[ads] banner display error:', e);
            });
            // Per the docs: display takes tabindex (focusable via D-pad),
            // navClass (class name the SDK applies to the container, ours
            // is .focusable) and the CSS display mode of the container.
            ad.call('display', {
              tabindex: 0,
              navClass: 'focusable',
              display: 'block'
            });
          } catch (e) {
            // A rendering failure must never leak into the main flow
            if (window.console && console.log) console.log('[ads] banner display fail:', e);
          }
        }
      });
    } catch (e) {
      if (window.console && console.log) console.log('[ads] getKaiAd throw:', e);
    }
  }

  /* =====================================================================
   * Fullscreen interstitial (cold start into the home screen only)
   * ===================================================================== */

  function writeLastShown(launch) {
    try { window.localStorage.setItem(LS_LAST_SHOWN_LAUNCH, String(launch)); } catch (e) {}
  }

  function maybeShowInterstitial() {
    if (!INTERSTITIAL_ENABLED) return;
    // Frequency control 1: at most one attempt per cold start (page
    // lifecycle)
    if (interstitialTriedThisSession) return;
    // Frequency control 2 (official best practice): after a launch
    // fullscreen ad, wait for at least five more completed sessions
    // before showing it again
    var lastShown = readLastShownLaunch();
    if (lastShown && currentLaunch - lastShown < INTERSTITIAL_MIN_SESSIONS) return;

    interstitialTriedThisSession = true; // mark on request, preventing a
                                         // re-trigger before onready

    try {
      window.getKaiAd({
        publisher: PUBLISHER_ID,
        app: APP_NAME,
        slot: INTERSTITIAL_SLOT,
        test: TEST_MODE,
        timeout: REQUEST_TIMEOUT,
        onerror: function (error) {
          document.body.setAttribute('data-ad-inter', 'error ' + error);
          // Silent degradation; since nothing was shown, no timestamp is
          // written and the next cold start may retry once the interval
          // allows
          if (window.console && console.log) {
            console.log('[ads] interstitial error:', error);
          }
        },
        onready: function (ad) {
          document.body.setAttribute('data-ad-inter', 'ready');
          try {
            ad.on('display', function () {
              document.body.setAttribute('data-ad-inter', 'displayed');
              // Record the launch number only after actually showing, so
              // frequency control counts real impressions
              writeLastShown(currentLaunch);
            });
            ad.on('close', function () {
              if (window.console && console.log) {
                console.log('[ads] interstitial closed');
              }
            });

            // Fullscreen ads display with a bare ad.call('display')
            ad.call('display');
          } catch (e) {
            if (window.console && console.log) console.log('[ads] interstitial display fail:', e);
          }
        }
      });
    } catch (e) {
      if (window.console && console.log) console.log('[ads] getKaiAd throw:', e);
    }
  }

  /* =====================================================================
   * Public interface: app.js calls this once, after the home screen is
   * ready (l10n + data rendering complete)
   * ===================================================================== */

  window.BmAds = {
    init: function () {
      if (inited) return;
      inited = true;
      // Official guidance: only request ads on KaiOS devices. Desktop
      // browsers time out (error 5) and test creatives disturb debugging
      if (!isKaiOS()) {
        if (window.console && console.log) {
          console.log('[ads] non-KaiOS environment, ads disabled');
        }
        return;
      }
      whenSdkReady(function () {
        // Count this cold start first; the interstitial's 5-session rule
        // reads it below
        currentLaunch = readLaunchCount() + 1;
        try {
          window.localStorage.setItem(LS_LAUNCH_COUNT, String(currentLaunch));
        } catch (e) { /* private mode: session flag still applies */ }
        loadBanner();
        maybeShowInterstitial();
      });
    }
  };
})();
