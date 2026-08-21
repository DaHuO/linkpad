/*
 * KaiAds SDK integration layer (required for KaiStore submission)
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
 *         show is less than MIN_INTERVAL ago, avoiding "an ad on every
 *         cold start";
 *  - Silent degradation: every failure path - remote script not loading,
 *    getKaiAd missing, on_error, SDK not ready within 8 seconds - just
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

  // TODO: replace with the real Publisher ID assigned by the KaiAds
  // portal (publisher.kaiads.com)
  var PUBLISHER_ID = '59c555c8-c385-480c-a86b-6f61fba7d5d4';
  // TODO: replace with the app/slot names created for this app in the
  // KaiAds portal
  var APP_NAME = 'linkpad';
  var BANNER_SLOT = 'banner_list_bottom';
  var INTERSTITIAL_SLOT = 'interstitial_cold_start';

  // Test mode: 1 = request test ads (useful during development, works
  // partially even with the placeholder Publisher ID); set to 0 before
  // store submission. TODO: confirm before review.
  var TEST_MODE = 1;

  // Interstitial master switch and minimum interval between shows (ms).
  // 10 minutes = repeated cold starts within a short session will not
  // each trigger an ad. Adjust to your ad strategy.
  var INTERSTITIAL_ENABLED = true;
  var INTERSTITIAL_MIN_INTERVAL = 10 * 60 * 1000;

  // Persistence key for the last successful interstitial show
  // (localStorage; both read and write are try/catch'd - in private mode
  // it degrades to "once per session only")
  var LS_LAST_INTERSTITIAL = 'bm-ad-last-interstitial';

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
   * Banner ad (permanent, bottom of the list view)
   *
   * The #ad-banner container sits inside view-list, below the scroll
   * area:
   *  - hidden is removed only when an ad is ready (no reserved space
   *    while unfilled);
   *  - the container hides/shows together with view-list, so other
   *    views have no ad slot.
   *
   * TODO (verify during device/integration QA): the ad.banner node and
   * the ad.on('finish') event name below follow the best recollection of
   * the KaiAds v4 docs - cross-check once against the integration docs
   * at https://publisher.kaiads.com.
   * ===================================================================== */

  function loadBanner() {
    if (bannerRequested) return;
    bannerRequested = true;
    try {
      window.getKaiAd({
        publisher: PUBLISHER_ID,
        app: APP_NAME,
        slot: BANNER_SLOT,
        test: TEST_MODE,
        on_error: function (error) {
          // No fill / network failure: stay silent, the UI keeps no ad
          // slot at all
          if (window.console && console.log) {
            console.log('[ads] banner error:', error);
          }
        },
        on_ready: function (ad) {
          try {
            var container = document.getElementById('ad-banner');
            if (!container) return;
            container.innerHTML = '';
            // TODO: verify against the v4 API - for banner ads,
            // appending the SDK-generated ad.banner DOM node into the
            // container completes the display
            if (ad && ad.banner) {
              container.appendChild(ad.banner);
              container.classList.remove('hidden');
            }
            if (ad && typeof ad.on === 'function') {
              // Banner finished: the MVP does no auto-rotation; the
              // container keeps whatever it has
              ad.on('finish', function () {
                if (window.console && console.log) {
                  console.log('[ads] banner finished');
                }
              });
            }
          } catch (e) {
            // A rendering failure must never leak into the main flow
            if (window.console && console.log) console.log('[ads] banner render fail:', e);
          }
        }
      });
    } catch (e) {
      if (window.console && console.log) console.log('[ads] getKaiAd throw:', e);
    }
  }

  /* =====================================================================
   * Full-screen interstitial (cold start into the home screen only)
   * ===================================================================== */

  function readLastShown() {
    try {
      return parseInt(window.localStorage.getItem(LS_LAST_INTERSTITIAL) || '0', 10) || 0;
    } catch (e) { return 0; }
  }

  function writeLastShown(ts) {
    try { window.localStorage.setItem(LS_LAST_INTERSTITIAL, String(ts)); } catch (e) {}
  }

  function maybeShowInterstitial() {
    if (!INTERSTITIAL_ENABLED) return;
    // Frequency control 1: at most one attempt per cold start (page
    // lifecycle)
    if (interstitialTriedThisSession) return;
    // Frequency control 2: skip when the last successful show is more
    // recent than the interval (avoids an ad on every cold start)
    if (Date.now() - readLastShown() < INTERSTITIAL_MIN_INTERVAL) return;

    interstitialTriedThisSession = true; // mark on request, preventing a
                                         // re-trigger before on_ready

    try {
      window.getKaiAd({
        publisher: PUBLISHER_ID,
        app: APP_NAME,
        slot: INTERSTITIAL_SLOT,
        test: TEST_MODE,
        on_error: function (error) {
          // Silent degradation; since nothing was shown, no timestamp is
          // written and the next cold start may retry once the interval
          // allows
          if (window.console && console.log) {
            console.log('[ads] interstitial error:', error);
          }
        },
        on_ready: function (ad) {
          try {
            // TODO (verify against the v4 API): interstitials display
            // via ad.call('display'); some doc revisions require extra
            // arguments - check the signature against the official docs
            if (ad && typeof ad.call === 'function') {
              ad.call('display');
              // Record the timestamp only after actually showing, so
              // frequency control counts real impressions
              writeLastShown(Date.now());
            }
            if (ad && typeof ad.on === 'function') {
              ad.on('finish', function () {
                if (window.console && console.log) {
                  console.log('[ads] interstitial finished');
                }
              });
            }
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
      whenSdkReady(function () {
        loadBanner();
        maybeShowInterstitial();
      });
    }
  };
})();
