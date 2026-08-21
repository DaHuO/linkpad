/*
 * KaiOS Bookmark Manager - core logic
 *
 * Platform conventions (keep them):
 *  - Plain ES5 / basic ES6: var + function. No arrow functions, template
 *    literals, optional chaining (?.) or top-level await, to stay compatible
 *    with the older Gecko engines on KaiOS devices.
 *  - Keyboard-only interaction: ArrowUp/ArrowDown move focus, Enter
 *    confirms, Backspace goes back. No click/touch handlers anywhere.
 *  - All async work uses callbacks instead of Promises, to avoid
 *    microtask-timing quirks in old engines.
 *
 * View state machine: list / form (add & edit) / menu (bookmark actions)
 *                      / confirm (delete confirmation) / lang (language)
 *
 * Localization (official KaiOS webL10n approach):
 *  - Static strings: marked with data-l10n-id in index.html, translated
 *    automatically by l10n.js;
 *  - Dynamic strings: go through L() -> navigator.webL10n.get(key, args);
 *  - Language resolution priority: localStorage manual override >
 *    navigator.language match (exact first, then language prefix) >
 *    en-US fallback.
 */
(function () {
  'use strict';

  /* =====================================================================
   * webL10n integration
   * The official l10n.js exposes the library on document.webL10n; the
   * KaiOS/gaia environment usually accesses it via navigator, so add an
   * alias here and then always use navigator.webL10n.get().
   * ===================================================================== */

  if (typeof navigator.webL10n === 'undefined' &&
      typeof document.webL10n !== 'undefined') {
    navigator.webL10n = document.webL10n;
  }

  // Fetch a localized string; webL10n returns '{{key}}' on a miss, so
  // degrade to showing the key itself - if a resource is missing or not
  // loaded yet the UI still shows readable English keys, not braces.
  function L(key, args) {
    var lib = navigator.webL10n;
    if (lib && typeof lib.get === 'function') {
      var s = lib.get(key, args);
      if (s && s.indexOf('{{') === -1) return s;
    }
    return key;
  }

  // Supported languages (must match the sections in locales/locales.ini)
  var SUPPORTED_LANGS = ['en-US', 'hi-IN', 'fr-FR', 'sw-KE'];
  // Display names: by convention always shown in their own language
  // (an English user recognizes "Hindi"; a Hindi user may not recognize
  // the English word), so these are intentionally NOT translated
  var LANG_NAMES = {
    'en-US': 'English',
    'hi-IN': 'हिन्दी',
    'fr-FR': 'Français',
    'sw-KE': 'Kiswahili'
  };
  // Persistence key for the manual language override. Bookmark data
  // lives in IndexedDB, but a tiny setting like this conventionally goes
  // to localStorage on KaiOS; it may throw in private mode, so guard both
  // read and write with try/catch - on failure the choice still applies
  // for the current session.
  var LS_KEY = 'bm-lang';

  function isSupportedLang(code) {
    for (var i = 0; i < SUPPORTED_LANGS.length; i++) {
      if (SUPPORTED_LANGS[i] === code) return true;
    }
    return false;
  }

  // Read the user's manual language override; null when absent
  function getLangOverride() {
    try {
      var saved = window.localStorage.getItem(LS_KEY);
      if (saved && isSupportedLang(saved)) return saved;
    } catch (e) { /* localStorage unavailable: ignore */ }
    return null;
  }

  // Pick a language from the support list based on the system language
  // (navigator.language): first an exact full-tag match (en-US == en-US),
  // then a primary subtag prefix match ("fr" or "fr-CA" -> fr-FR);
  // fall back to en-US when nothing matches.
  function detectSystemLang() {
    var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    var i;
    for (i = 0; i < SUPPORTED_LANGS.length; i++) {
      if (SUPPORTED_LANGS[i].toLowerCase() === nav) return SUPPORTED_LANGS[i];
    }
    var pref = nav.split('-')[0];
    if (pref) {
      for (i = 0; i < SUPPORTED_LANGS.length; i++) {
        if (SUPPORTED_LANGS[i].split('-')[0] === pref) return SUPPORTED_LANGS[i];
      }
    }
    return 'en-US';
  }

  // Language finally used at startup: manual override first, then the
  // system-language match, then en-US
  function resolveLanguage() {
    return getLangOverride() || detectSystemLang();
  }

  /* =====================================================================
   * Constants and global state
   * ===================================================================== */

  var DB_NAME = 'kaios-bookmarks';
  var DB_VERSION = 1;
  var STORE_NAME = 'bookmarks';

  // All mutable state lives in `state` for easy inspection
  var state = {
    db: null,            // opened IndexedDB handle; null = storage unavailable
    view: 'list',        // current view name, drives key dispatch
    bookmarks: [],       // full bookmark cache (re-read after every change;
                         // simplest reliable approach at this data size)
    query: '',           // current search keyword ('' = no filter)
    sortMode: 'added',   // 'added' by date added desc | 'accessed' by last visit desc
    editingId: null,     // bookmark id being edited; null = "add" mode
    menuTargetId: null,  // bookmark id the action menu points at
    toastTimer: null,    // reset timer for the transient footer message
    lang: 'en-US'        // active language (canonical casing, for display)
  };

  // Frequently used DOM refs (fetched once in init to avoid re-querying)
  var elHeaderMeta, elBmList, elEmptyTip, elNoMatchTip,
      elSearchLabel, elSearchInput, elSortLabel, elLangLabel,
      elFormTitle, elFTitle, elFUrl,
      elMenuTarget, elConfirmText,
      elStatusBar, elSkLeft, elSkMid, elSkRight;

  /* =====================================================================
   * Small utilities
   * ===================================================================== */

  function $(id) { return document.getElementById(id); }

  // Escape HTML: bookmark titles/URLs are user input and are concatenated
  // into innerHTML, so escape them to keep markup like <script> inert.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // Short date: omit the year when it is the current one (limited room
  // on a 240px-wide line). Dates stay numeric - language-neutral.
  function fmtShort(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md;
  }

  // Extract the host from a URL for the secondary line; return the input
  // unchanged when extraction fails (truncation is handled by CSS)
  function hostOf(url) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(url || '');
    return m ? m[1] : (url || '');
  }

  // Domain ribbon (visual signature): a stable string hash (djb2 variant)
  // maps a host to a 0..4 palette index. The same domain always gets the
  // same color, which helps users spot frequently used sites by color.
  function ribbonIndex(host) {
    var h = String(host || '?');
    var sum = 5381;
    for (var i = 0; i < h.length; i++) {
      sum = ((sum << 5) + sum + h.charCodeAt(i)) >>> 0;
    }
    return sum % 5;
  }

  // If the entered URL has no scheme (e.g. "example.com/foo"), prepend
  // https:// - otherwise the Web Activity would treat it as a relative
  // path when handed to the browser
  function ensureScheme(url) {
    if (/^[a-z][a-z0-9+.\-]*:/i.test(url)) return url; // http:/https:/mailto: etc.
    return 'https://' + url;
  }

  // Translate a low-level error into a localized, user-readable message.
  // The data layer (IndexedDB wrappers below) passes "error code strings"
  // (properties keys like 'err-db-open') for its own expected failures,
  // which are localized here; native DOMExceptions from IndexedDB keep
  // their original technical text (raw diagnostic info beats a bad
  // translation). QuotaExceededError matters most: writes fail with it
  // when device storage is full - show an actionable message instead of
  // letting the exception kill the app.
  function describeError(err) {
    if (!err) return L('err-unknown');
    if (typeof err === 'string') return L(err);
    if (err.name === 'QuotaExceededError' || /quota/i.test(err.message || '')) {
      return L('err-quota');
    }
    return err.message || String(err);
  }

  /* =====================================================================
   * IndexedDB wrappers (callback style + try/catch everywhere)
   *
   * Why it is written this way:
   *  1) indexedDB.open and friends can throw synchronously in edge cases
   *     (stale version connections, private mode), so every entry point
   *     is wrapped in try/catch; errors always go to the callback's
   *     first argument and the UI layer only shows a toast - nothing is
   *     ever rethrown.
   *  2) Transaction handles are single-use, so each operation opens a
   *     fresh transaction and reads results via request.onsuccess,
   *     preferring e.target.error (the native error object) on failure.
   * ===================================================================== */

  function openDb(cb) {
    try {
      // Very old engines use a webkit-prefixed binding - probe for it
      var idb = window.indexedDB || window.webkitIndexedDB;
      if (!idb) { cb('err-no-idb', null); return; }

      var req = idb.open(DB_NAME, DB_VERSION);
      // Create the store on first install/upgrade:
      //  - keyPath: id + autoIncrement, primary key generated by the DB
      //  - dateAccessed uses 0 (not null) to mean "never visited" -
      //    IndexedDB indexes skip records whose value is null, so with
      //    null the unvisited bookmarks would disappear entirely from
      //    the "last visited" sort.
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id', autoIncrement: true
          });
          store.createIndex('dateAdded', 'dateAdded', { unique: false });
          store.createIndex('dateAccessed', 'dateAccessed', { unique: false });
        }
      };
      req.onsuccess = function (e) { cb(null, e.target.result); };
      req.onerror = function (e) {
        cb(e.target.error || 'err-db-open', null);
      };
      // Also fires when blocked by another tab holding an old version
      req.onblocked = function () { cb('err-db-busy', null); };
    } catch (err) {
      cb(err, null);
    }
  }

  function dbGetAll(cb) {
    if (!state.db) { cb('err-storage'); return; }
    try {
      var tx = state.db.transaction(STORE_NAME, 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var results = [];

      if (typeof store.getAll === 'function') {
        // Newer engines: one getAll fetches the whole table
        var rq = store.getAll();
        rq.onsuccess = function (e) { cb(null, e.target.result || []); };
        rq.onerror = function (e) { cb(e.target.error || 'err-db-read'); };
      } else {
        // Older engines: fall back to a cursor walk over the table
        var cr = store.openCursor();
        cr.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) { results.push(cursor.value); cursor.continue(); }
          else { cb(null, results); }
        };
        cr.onerror = function (e) { cb(e.target.error || 'err-db-read'); };
      }
    } catch (err) {
      cb(err);
    }
  }

  function dbAdd(bm, cb) {
    if (!state.db) { cb('err-storage'); return; }
    try {
      var tx = state.db.transaction(STORE_NAME, 'readwrite');
      var rq = tx.objectStore(STORE_NAME).add(bm);
      rq.onsuccess = function (e) { cb(null, e.target.result); }; // new id
      rq.onerror = function (e) { cb(e.target.error || 'err-db-write'); };
    } catch (err) {
      // QuotaExceededError usually surfaces here
      cb(err);
    }
  }

  function dbPut(bm, cb) {
    if (!state.db) { cb('err-storage'); return; }
    try {
      var tx = state.db.transaction(STORE_NAME, 'readwrite');
      var rq = tx.objectStore(STORE_NAME).put(bm);
      rq.onsuccess = function () { cb(null); };
      rq.onerror = function (e) { cb(e.target.error || 'err-db-write'); };
    } catch (err) {
      cb(err);
    }
  }

  function dbDelete(id, cb) {
    if (!state.db) { cb('err-storage'); return; }
    try {
      var tx = state.db.transaction(STORE_NAME, 'readwrite');
      var rq = tx.objectStore(STORE_NAME).delete(id);
      rq.onsuccess = function () { cb(null); };
      rq.onerror = function (e) { cb(e.target.error || 'err-db-del'); };
    } catch (err) {
      cb(err);
    }
  }

  /* =====================================================================
   * View switching and rendering
   * ===================================================================== */

  function getViewEl(name) {
    return $('view-' + (name || state.view));
  }

  // Switch views: hide the others, show the target. Actively blur the
  // focused input when leaving a view - some old engines keep the system
  // keyboard up after the container becomes display:none.
  // Also, display:none resets scrollTop, so remember the list scroll
  // position before leaving and restore it on return; otherwise the list
  // would jump back to the top after e.g. the form view.
  var savedListScrollTop = 0;

  function showView(name) {
    if (state.view === 'list' && name !== 'list') {
      savedListScrollTop = $('list-scroll').scrollTop;
    }
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.add('hidden');
    }
    getViewEl(name).classList.remove('hidden');
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    if (name === 'list' && state.view !== 'list') {
      $('list-scroll').scrollTop = savedListScrollTop;
    }
    state.view = name;
    // The list view keeps focus where it was; every other view starts
    // with focus on its first item
    if (name !== 'list') setFocus(0);
  }

  // Bookmarks visible after the current filter + sort
  function getVisibleBookmarks() {
    var list = state.bookmarks.slice();
    // Descending: newest first. dateAccessed 0 (never visited) sinks
    if (state.sortMode === 'accessed') {
      list.sort(function (a, b) { return (b.dateAccessed || 0) - (a.dateAccessed || 0); });
    } else {
      list.sort(function (a, b) { return (b.dateAdded || 0) - (a.dateAdded || 0); });
    }
    var q = state.query.toLowerCase();
    if (q) {
      // Fuzzy match = case-insensitive substring; hit on title OR url
      list = list.filter(function (bm) {
        return (bm.title || '').toLowerCase().indexOf(q) !== -1 ||
               (bm.url || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    return list;
  }

  // Rebuild only the bookmark list area; the four command rows at the top
  // are static DOM, so the search input never loses focus while the list
  // re-renders on every keystroke. All secondary/count strings go through
  // L() and are refreshed by updateAllTexts after a language switch.
  function renderBookmarks() {
    var list = getVisibleBookmarks();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var bm = list[i];
      // Secondary line follows the sort mode: show the time you sort by
      var timeInfo;
      if (state.sortMode === 'accessed') {
        timeInfo = bm.dateAccessed
          ? L('visited-info', { date: fmtShort(bm.dateAccessed) })
          : L('never-visited');
      } else {
        timeInfo = L('added-info', { date: fmtShort(bm.dateAdded) });
      }
      var host = hostOf(bm.url);
      html += '<li class="row bm focusable rb-' + ribbonIndex(host) + '" data-id="' + bm.id + '">' +
                '<span class="row-title">' + escapeHtml(bm.title) + '</span>' +
                '<span class="row-sub">' + escapeHtml(host) + ' · ' + escapeHtml(timeInfo) + '</span>' +
              '</li>';
    }
    elBmList.innerHTML = html;

    elEmptyTip.classList.toggle('hidden', !(list.length === 0 && state.bookmarks.length === 0));
    elNoMatchTip.classList.toggle('hidden', !(list.length === 0 && state.bookmarks.length > 0));

    elHeaderMeta.textContent = L('count', { n: state.bookmarks.length }) +
      (state.db ? '' : ' · ' + L('storage-unavailable'));
  }

  function updateSortLabel() {
    elSortLabel.textContent = state.sortMode === 'accessed'
      ? L('sort-by-visited')
      : L('sort-by-date');
  }

  function updateSearchLabel() {
    elSearchLabel.textContent = state.query
      ? L('search-query', { query: state.query })
      : L('search');
  }

  function updateLangLabel() {
    var name = LANG_NAMES[state.lang] || state.lang;
    elLangLabel.textContent = L('lang-cmd', { lang: name });
  }

  // After a language switch, refresh every JS-owned dynamic string in one
  // place (the static data-l10n-id part is handled automatically by the
  // library's translateFragment)
  function updateAllTexts() {
    updateSortLabel();
    updateSearchLabel();
    updateLangLabel();
    renderBookmarks();
    updateFooterHint();
  }

  // Re-read the whole table from the DB and refresh the UI; cb runs after
  // the refresh (used e.g. to focus a newly added bookmark)
  function refresh(cb) {
    dbGetAll(function (err, list) {
      if (err) {
        showToast(L('err-load') + ' ' + describeError(err));
      } else {
        state.bookmarks = list || [];
        renderBookmarks();
        // Re-rendering may have removed the focused row; if focus was
        // lost, fall back to the first item
        if (currentFocusIndex() === -1) setFocus(0);
      }
      if (cb) cb();
    });
  }

  /* =====================================================================
   * Focus management (the core of D-pad navigation)
   *
   * Model: each view's elements with .focusable form a circular focus
   * chain; the .focused class provides the highlight. Inputs are part of
   * the chain too - focusing one brings up the system keyboard, which is
   * the only text-entry channel on a feature phone.
   * ===================================================================== */

  function getFocusables() {
    var view = getViewEl();
    if (!view) return [];
    var nodes = view.querySelectorAll('.focusable');
    var arr = [];
    for (var i = 0; i < nodes.length; i++) {
      // Filter out invisible elements (e.g. the collapsed search input):
      // selector matching ignores visibility, but focus() on a
      // display:none element silently fails, which would leave a "ghost"
      // entry in the chain. offsetParent === null means not rendered
      // (this app uses no fixed positioning).
      if (nodes[i].offsetParent !== null) arr.push(nodes[i]);
    }
    return arr;
  }

  function getFocusedEl() {
    var view = getViewEl();
    return view ? view.querySelector('.focused') : null;
  }

  function currentFocusIndex() {
    var items = getFocusables();
    var el = getFocusedEl();
    for (var i = 0; i < items.length; i++) {
      if (items[i] === el) return i;
    }
    return -1;
  }

  function setFocus(i) {
    var items = getFocusables();
    if (!items.length) return;
    if (i < 0) i = items.length - 1;     // wrap: above the first -> last
    if (i >= items.length) i = 0;
    var prev = getFocusedEl();
    if (prev) prev.classList.remove('focused');
    items[i].classList.add('focused');
    if (items[i].tagName === 'INPUT') {
      items[i].focus();                  // bring up the system keyboard
    } else if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();     // leave an input: dismiss keyboard
    }
    updateScroll(items[i]);
    updateFooterHint();
  }

  function focusEl(el) {
    var items = getFocusables();
    for (var i = 0; i < items.length; i++) {
      if (items[i] === el) { setFocus(i); return true; }
    }
    return false;
  }

  function moveFocus(delta) {
    setFocus(currentFocusIndex() + delta);
  }

  // Scroll the focused row into view manually. scrollIntoView is not
  // used: its arguments are inconsistent on old Gecko engines. Relies on
  // .scroll { position: relative } in the CSS so offsetTop of a row is
  // computed relative to the scrolling container.
  function updateScroll(el) {
    var c = el.parentNode;
    while (c && !(c.classList && c.classList.contains('scroll'))) c = c.parentNode;
    if (!c) return;
    var top = el.offsetTop;
    if (top < c.scrollTop) {
      c.scrollTop = top;
    } else if (top + el.offsetHeight > c.scrollTop + c.clientHeight) {
      c.scrollTop = top + el.offsetHeight - c.clientHeight;
    }
  }

  // Focus the row of a bookmark by id (jump to a freshly added one)
  function focusBookmarkById(id) {
    var items = getFocusables();
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-id') === String(id)) {
        setFocus(i);
        updateScroll(items[i]);
        return;
      }
    }
    setFocus(0);
  }

  function findBm(id) {
    for (var i = 0; i < state.bookmarks.length; i++) {
      if (String(state.bookmarks[i].id) === String(id)) return state.bookmarks[i];
    }
    return null;
  }

  /* =====================================================================
   * Soft key bar: three segments (left ▲▼ / middle Enter action /
   * right Backspace action) + transient messages (toast)
   *
   * The segments map to physical keys: middle = the D-pad center key
   * (Enter), right = the Backspace area. The middle action follows focus
   * in real time and is amber - the same "actionable" signal as the
   * list focus highlight.
   * ===================================================================== */

  function updateFooterHint() {
    if (state.toastTimer) return; // don't overwrite a visible toast
    var mid = '', right = '';
    if (state.view === 'list') {
      if (isInputFocused()) {
        mid = L('act-confirm');            // search input: Enter confirms
      } else {
        var el = getFocusedEl();
        if (el && el.id === 'cmd-add') mid = L('act-add');
        else if (el && el.id === 'cmd-search') mid = L('act-search');
        else if (el && el.id === 'cmd-sort') mid = L('act-sort');
        else if (el && el.id === 'cmd-lang') mid = L('act-lang');
        else if (el) {
          mid = L('act-open');
          right = L('act-menu');           // Backspace on a bookmark = menu
        }
      }
    } else if (state.view === 'form' || state.view === 'menu' ||
               state.view === 'confirm' || state.view === 'lang') {
      mid = L('act-select');
      right = L('act-back');
    }
    elSkLeft.textContent = '▲▼';
    elSkMid.textContent = mid;
    elSkRight.textContent = right;
  }

  // Show a transient message for 2 seconds, then restore the soft key
  // hints. Every storage and validation error goes through here: any
  // failure produces feedback without ever crashing the app.
  function showToast(msg) {
    elSkMid.textContent = msg;
    elStatusBar.classList.add('toast'); // CSS hides left/right, centers mid
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      state.toastTimer = null;
      elStatusBar.classList.remove('toast');
      updateFooterHint();
    }, 2000);
  }

  /* =====================================================================
   * Key handling state machine (the only interaction entry point)
   *
   * Physical keys surface as keydown on window with standard e.key
   * values: 'ArrowUp' / 'ArrowDown' / 'Enter' / 'Backspace'. Some
   * firmwares report the back key as 'GoBack' - accept it too.
   * ===================================================================== */

  // Very old engines only have keyCode, no e.key - map the ones we use
  function normKey(e) {
    if (e.key) return e.key;
    switch (e.keyCode) {
      case 38: return 'ArrowUp';
      case 40: return 'ArrowDown';
      case 13: return 'Enter';
      case 8: return 'Backspace';
      default: return '';
    }
  }

  function isInputFocused() {
    var a = document.activeElement;
    return !!a && a.tagName === 'INPUT';
  }

  function onKeydown(e) {
    var key = normKey(e);

    /* ---- Up/Down: move focus. Intercepted while an input is focused
     * too - a single-line input has no default vertical behavior, and
     * borrowing these keys to move between form fields is the standard
     * feature-phone pattern. Left/Right are NOT intercepted so the text
     * cursor keeps working. */
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(key === 'ArrowUp' ? -1 : 1);
      return;
    }

    /* ---- Enter: confirm */
    if (key === 'Enter') {
      e.preventDefault();
      if (isInputFocused()) onEnterInInput();
      else activateFocused();
      return;
    }

    /* ---- Backspace: back / delete char / open bookmark menu */
    if (key === 'Backspace' || key === 'GoBack') {
      if (isInputFocused()) {
        // Inside an input: let the default behavior (delete a char) run
        // while there is text; only intercept when it is empty, meaning
        // "leave search"
        if (document.activeElement.value === '') {
          e.preventDefault();
          onBackInEmptyInput();
        }
        return;
      }
      // Not in an input: true means the app consumed the event; false
      // means we do NOT preventDefault and hand the back key to the
      // system (at the list top level this exits the app, matching the
      // "back" intuition)
      if (handleBack()) e.preventDefault();
      return;
    }
  }

  // Enter pressed while an input is focused
  function onEnterInInput() {
    var inp = document.activeElement;
    if (state.view === 'list') {
      // Search box: confirm the keyword, collapse the input and return
      // focus to the "Search" command row
      confirmSearch();
    } else if (state.view === 'form') {
      if (inp === elFTitle) {
        focusEl(elFUrl);          // title done => jump to the URL field
      } else {
        saveForm();               // URL done => save right away (shortcut)
      }
    }
  }

  // Backspace pressed in an empty input
  function onBackInEmptyInput() {
    if (state.view === 'list') {
      cancelSearch();             // empty search box + back = cancel & clear
    }
    // In the form an empty input does nothing on backspace: avoid
    // accidentally discarding what the other field already holds. To go
    // back, move focus to "Cancel" and press Enter, or leave the input
    // first and then press Backspace.
  }

  // Backspace dispatch when not in an input. Returns true = consumed.
  function handleBack() {
    if (state.view === 'form' || state.view === 'menu' ||
        state.view === 'confirm' || state.view === 'lang') {
      backToList();
      return true;
    }
    if (state.view === 'list') {
      var el = getFocusedEl();
      if (el && el.id === 'cmd-search' && state.query) {
        // Focus on the "Search" command row with a keyword: backspace
        // clears the keyword
        state.query = '';
        elSearchInput.value = '';
        updateSearchLabel();
        renderBookmarks();
        showToast(L('toast-search-cleared'));
        return true;
      }
      if (el && el.getAttribute('data-id')) {
        // Focus on a bookmark: backspace opens its action menu
        // (the edit/delete entry point)
        openMenu(el.getAttribute('data-id'));
        return true;
      }
    }
    return false; // hand to the system: back at list top level = exit app
  }

  // Enter dispatch: acts on the currently focused element
  function activateFocused() {
    var el = getFocusedEl();
    if (!el) return;

    if (state.view === 'list') {
      var action = el.getAttribute('data-action');
      if (action === 'add') {
        openForm(null);
      } else if (action === 'search') {
        enterSearch();
      } else if (action === 'sort') {
        toggleSort();
      } else if (action === 'lang') {
        openLangView();
      } else if (el.getAttribute('data-id')) {
        // Requirement 5: Enter on a bookmark = record the visit and open
        openBookmark(parseInt(el.getAttribute('data-id'), 10));
      }
    } else if (state.view === 'form') {
      if (el.id === 'f-save') saveForm();
      else backToList(); // f-cancel
    } else if (state.view === 'menu') {
      menuAction(el.getAttribute('data-menu'));
    } else if (state.view === 'confirm') {
      if (el.id === 'confirm-yes') doDelete();
      else backToList(); // confirm-no
    } else if (state.view === 'lang') {
      // data-lang-value '' = follow the system (clear the override)
      applyLanguage(el.getAttribute('data-lang-value') || null);
    }
  }

  /* =====================================================================
   * Feature actions
   * ===================================================================== */

  function toggleSort() {
    state.sortMode = state.sortMode === 'added' ? 'accessed' : 'added';
    updateSortLabel();
    renderBookmarks();
    showToast(state.sortMode === 'accessed' ? L('toast-sort-visited') : L('toast-sort-date'));
  }

  function enterSearch() {
    elSearchLabel.classList.add('hidden');
    elSearchInput.classList.remove('hidden');
    // focusEl returning false means the input is not in the focus chain
    // (a configuration error); fall back to focusing it directly so the
    // user can still type
    if (!focusEl(elSearchInput)) elSearchInput.focus();
  }

  function collapseSearchInput() {
    elSearchInput.blur();
    elSearchInput.classList.add('hidden');
    elSearchLabel.classList.remove('hidden');
  }

  // Enter confirms: keep the keyword, focus back on "Search"
  function confirmSearch() {
    state.query = elSearchInput.value.replace(/^\s+|\s+$/g, '');
    collapseSearchInput();
    updateSearchLabel();
    renderBookmarks();
    focusEl($('cmd-search'));
  }

  // Backspace in an empty box: cancel the search and clear the filter
  function cancelSearch() {
    state.query = '';
    elSearchInput.value = '';
    collapseSearchInput();
    updateSearchLabel();
    renderBookmarks();
    focusEl($('cmd-search'));
  }

  // Live filtering: the input event only updates data and the bookmark
  // area; the command rows (including the input itself) are static DOM
  // and are never disturbed by the re-render
  function onSearchInput() {
    state.query = elSearchInput.value;
    renderBookmarks();
  }

  function backToList() {
    showView('list');
    // If focus was lost after returning (e.g. the row was rebuilt),
    // fall back to the first item
    if (currentFocusIndex() === -1) setFocus(0);
    updateFooterHint();
  }

  // Open the add/edit form. bm == null means "add" mode
  function openForm(bm) {
    state.editingId = bm ? bm.id : null;
    elFormTitle.textContent = bm ? L('form-title-edit') : L('form-title-add');
    elFTitle.value = bm ? bm.title : '';
    elFUrl.value = bm ? bm.url : '';
    showView('form');
    setFocus(0); // focus lands on the title input: type right away
  }

  function saveForm() {
    // trim via replace for the oldest engines
    var title = elFTitle.value.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var url = elFUrl.value.replace(/^\s+|\s+$/g, '');

    // Required-field validation: toast and refocus the offending field
    if (!title) { showToast(L('toast-title-empty')); focusEl(elFTitle); return; }
    if (!url) { showToast(L('toast-url-empty')); focusEl(elFUrl); return; }
    url = ensureScheme(url);

    if (state.editingId == null) {
      // Adding: dateAccessed 0 means "never visited" (see openDb)
      var bm = { title: title, url: url, dateAdded: Date.now(), dateAccessed: 0 };
      dbAdd(bm, function (err, newId) {
        if (err) { showToast(L('err-save') + ' ' + describeError(err)); return; }
        backToList();
        refresh(function () { focusBookmarkById(newId); });
        showToast(L('toast-added'));
      });
    } else {
      // Editing: only title and url change; id/dateAdded/dateAccessed stay
      var old = findBm(state.editingId);
      if (!old) { showToast(L('toast-orig-missing')); backToList(); return; }
      old.title = title;
      old.url = url;
      dbPut(old, function (err) {
        if (err) { showToast(L('err-save') + ' ' + describeError(err)); return; }
        var id = state.editingId;
        backToList();
        refresh(function () { focusBookmarkById(id); });
        showToast(L('toast-saved'));
      });
    }
  }

  function openMenu(id) {
    var bm = findBm(id);
    if (!bm) { showToast(L('toast-not-found')); return; }
    state.menuTargetId = bm.id;
    // textContent assignment is injection-safe by itself
    elMenuTarget.textContent = bm.title;
    showView('menu');
  }

  function menuAction(action) {
    var id = state.menuTargetId;
    if (action === 'open') {
      backToList();
      openBookmark(id);
    } else if (action === 'edit') {
      var bm = findBm(id);
      if (bm) openForm(bm); else { showToast(L('toast-not-found')); backToList(); }
    } else if (action === 'delete') {
      var target = findBm(id);
      if (!target) { showToast(L('toast-not-found')); backToList(); return; }
      elConfirmText.textContent = L('delete-confirm', { title: target.title });
      showView('confirm');
    } else { // cancel
      backToList();
    }
  }

  function doDelete() {
    dbDelete(state.menuTargetId, function (err) {
      if (err) { showToast(L('err-delete') + ' ' + describeError(err)); backToList(); return; }
      backToList();
      refresh();
      showToast(L('toast-deleted'));
    });
  }

  /* =====================================================================
   * Language switching (list command row -> view-lang -> Enter applies)
   * ===================================================================== */

  // Enter the language view: mark the active option with .current and
  // focus it
  function openLangView() {
    showView('lang');
    var rows = getFocusables(); // visible focusables = the option rows
    var current = getLangOverride() || '';
    var focusRow = null;
    for (var i = 0; i < rows.length; i++) {
      var isCur = rows[i].getAttribute('data-lang-value') === current;
      if (isCur) {
        rows[i].classList.add('current');
        focusRow = rows[i];
      } else {
        rows[i].classList.remove('current');
      }
    }
    if (focusRow) focusEl(focusRow);
  }

  // Apply the language choice. code == null means "follow the system"
  // (clears the manual override).
  function applyLanguage(code) {
    var want = code || detectSystemLang();
    try {
      if (code) window.localStorage.setItem(LS_KEY, code);
      else window.localStorage.removeItem(LS_KEY);
      // If the write fails (private mode etc.) the switch still applies
      // to this session
    } catch (e) { /* localStorage unavailable: session-only */ }

    var lib = navigator.webL10n;
    var done = function () {
      state.lang = want;
      // Sync <html lang> so the system can pick suitable fonts for
      // scripts like Devanagari
      document.documentElement.lang = want;
      updateAllTexts();
      backToList();
      showToast(L('toast-lang-applied', {
        lang: code ? LANG_NAMES[code] : L('lang-system')
      }));
    };

    if (lib && typeof lib.setLanguage === 'function' &&
        lib.getLanguage() !== want.toLowerCase()) {
      // After setLanguage completes: the callback refreshes dynamic
      // strings, and the static data-l10n-id elements are translated
      // automatically by the library's subsequent translateFragment
      lib.setLanguage(want, done);
    } else {
      done();
    }
  }

  /* =====================================================================
   * Opening a bookmark: record the visit + Web Activity to the browser
   * ===================================================================== */

  function openBookmark(id) {
    var bm = findBm(id);
    if (!bm) { showToast(L('toast-not-found')); refresh(); return; }

    // Update the visit time asynchronously but do NOT wait for the write
    // before firing the Activity: the Web Activity switches the user to
    // the system browser, and waiting for the DB write first would feel
    // sluggish. IndexedDB requests keep running while the page is in the
    // background, so the data is stored by the time the user returns.
    bm.dateAccessed = Date.now();
    dbPut(bm, function (err) {
      if (err) showToast(L('err-record') + ' ' + describeError(err));
      refresh();
    });

    openUrlExternal(bm.url);
  }

  // The standard way to open an external link on KaiOS is a Web Activity
  // (inherited from Firefox OS):
  //   new MozActivity({ name: 'view', data: { type: 'url', url: ... } })
  // The system dispatches the request to the default browser; this app
  // needs no network permissions at all.
  // Notes:
  //  - The constructor carries the Moz prefix and exists only in the
  //    KaiOS/Firefox OS environment;
  //  - TODO (verify on device): some KaiOS firmwares require an extra
  //    title field in data or the name 'open'; test once with WebIDE on
  //    a real device. The form below is the most common one in the
  //    KaiOS 2.x docs and community apps.
  //  - Desktop browsers have no MozActivity, so fall back to
  //    window.open there to keep the flow testable on a PC.
  function openUrlExternal(url) {
    try {
      if (typeof window.MozActivity === 'function') {
        var activity = new window.MozActivity({
          name: 'view',
          data: { type: 'url', url: url }
        });
        activity.onsuccess = function () {
          // The system accepted and dispatched the open request
          showToast(L('toast-opened', { host: hostOf(url) }));
        };
        activity.onerror = function () {
          // Typically no handler for urls (e.g. a trimmed firmware
          // without a browser)
          showToast(L('err-open-fail'));
        };
      } else {
        // Debug fallback: open a plain new tab in a desktop browser
        var win = window.open(url, '_blank');
        if (!win) showToast(L('err-popup'));
      }
    } catch (err) {
      // The Activity constructor itself can throw (e.g. invalid URL);
      // catch it so the app never crashes
      showToast(L('err-activity') + ' ' + describeError(err));
    }
  }

  /* =====================================================================
   * Initialization
   * ===================================================================== */

  function cacheDom() {
    elHeaderMeta = $('header-meta');
    elBmList = $('bm-list');
    elEmptyTip = $('empty-tip');
    elNoMatchTip = $('no-match-tip');
    elSearchLabel = $('search-label');
    elSearchInput = $('search-input');
    elSortLabel = $('sort-label');
    elLangLabel = $('lang-label');
    elFormTitle = $('form-title');
    elFTitle = $('f-title');
    elFUrl = $('f-url');
    elMenuTarget = $('menu-target');
    elConfirmText = $('confirm-text');
    elStatusBar = $('statusbar');
    elSkLeft = $('sk-left');
    elSkMid = $('sk-mid');
    elSkRight = $('sk-right');
  }

  function init() {
    cacheDom();

    // The only interaction entry point: keydown. No click/touch binding.
    document.addEventListener('keydown', onKeydown, false);

    // Live search filtering. Not change (which needs a blur): the input
    // event fires after every keystroke, which is what "live" means.
    elSearchInput.addEventListener('input', onSearchInput, false);

    // Refresh once when returning from the system browser: covers data
    // written in the background during a long "open bookmark -> stay in
    // browser -> come back" period, and reflects dateAccessed updates
    // immediately in the "last visited" sort.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.db) refresh();
    }, false);

    var want = resolveLanguage();
    var lib = navigator.webL10n;

    // First render must wait for webL10n, otherwise dynamic strings would
    // show as keys. Timing: l10n.js has already auto-loaded
    // navigator.language and translated the static elements on
    // DOMContentLoaded; once ready() fires, switch explicitly if the
    // active language differs from the desired one (manual override or
    // match result) to avoid a load race.
    var onLocalized = function () {
      state.lang = want;
      document.documentElement.lang = want;
      updateAllTexts();
      setFocus(0);

      // Initialize ads only after the home screen is ready (KaiStore
      // requirement): banner preload + cold-start interstitial (with
      // frequency control), all silently degrading, so no ad failure can
      // ever affect bookmark features. try/catch guards against ads.js
      // being missing (e.g. temporarily removed while debugging). The
      // storage-failure branch calls it too - ads depend only on the
      // SDK, not on IndexedDB.
      var startAds = function () {
        try {
          if (window.BmAds && typeof window.BmAds.init === 'function') {
            window.BmAds.init();
          }
        } catch (e) { /* ad init failure: silent */ }
      };

      // Open storage after localization too, so error toasts are
      // already translated
      openDb(function (err, db) {
        if (err) {
          // Keep running even without a DB: the UI is visible, every
          // operation reports an error, and nothing white-screens or
          // throws
          state.db = null;
          renderBookmarks(); // refresh the "storage unavailable" marker
          showToast(L('err-storage') + ' ' + describeError(err));
          startAds();
          return;
        }
        state.db = db;
        refresh(startAds);
      });
    };

    if (lib && typeof lib.ready === 'function') {
      lib.ready(function () {
        if (lib.getLanguage() !== want.toLowerCase()) {
          lib.setLanguage(want, onLocalized);
        } else {
          onLocalized();
        }
      });
    } else {
      // l10n.js entirely missing (e.g. resources 404): L() degrades to
      // showing keys; everything else keeps working
      onLocalized();
    }
  }

  // Start once the DOM is ready (scripts sit at the end of body, so all
  // elements exist; l10n.js has already loaded and exposed webL10n on
  // document)
  init();
})();
