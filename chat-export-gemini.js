/*!
 * chat-export-gemini.js - export the active Google Gemini conversation (gemini.google.com) to one UTF-8 Markdown file.
 *
 * NOT TESTED against the live gemini.google.com DOM. Selector groups are tagged VERIFIED / UNVERIFIED
 * according to the 2026-10-31 DOM probe; class names rotate, so every group has fallbacks.
 *
 * Constraints honoured: no network, no eval, no innerHTML/outerHTML/insertAdjacentHTML/DOMParser
 * (Trusted Types is enforced on Gemini), no clipboard, no globals (the only shared state is a DOM element
 * id used as the re-entrancy guard), explicit semicolons (minification-safe).
 *
 * Debug: set CONFIG.DEBUG = true (or build with --debug, or run
 *   localStorage.setItem('__chat_export_debug','1')  in the console once).
 */
void (async () => {
  'use strict';

  // ===================================================================
  // 0. CONFIG, hostname + re-entrancy guards, status UI, fmtLocal()
  // ===================================================================
  const CONFIG = {
    DEBUG: false,
    AUTOLOAD: true,
    LOAD_TIMEOUT_MS: 90000,
    MAX_CYCLES: 5,
    STABLE_CHECKS: 5,          // consecutive unchanged checks needed at the top of the list
    CHECK_INTERVAL_MS: 500,
    STEP_WAIT_MS: 300,         // wait after each downward scroll step
    STEP_FRACTION: 0.8,        // scroll step = 0.8 x viewport height
    TOP_NUDGE_PX: 60,          // UNTESTED: while waiting at the top, bump down and back up so a scroll-event-driven pager sees a real delta (0 = off)
    REVOKE_DELAY_MS: 15000,    // >= 10 s before revoking the blob URL

    SERVICE_NAME: 'Google Gemini',
    ASSISTANT_LABEL: 'Gemini',
    SERVICE_SLUG: 'gemini',
    HOSTNAMES: ['gemini.google.com'],
    TITLE_SUFFIX_RE: /\s[-\u2013\u2014]\s(Google )?Gemini$/,   // VERIFIED title format: "<title> - Google Gemini"
    GENERIC_TITLE_RE: /^(google )?gemini$/i,                    // a title that is only the product name is not a chat title

    // Ordered selector groups. First group that yields BOTH roles wins (else first with any turn);
    // the choice is locked for the run.
    //   user / assistant : selectors for the role markers
    //   rows + itemsOf   : structural groups (one container per exchange, items derived from it)
    //   region           : per role, ordered selectors searched INSIDE the marker; the outermost hit (or the
    //                      common ancestor of several hits) is the message region that gets converted.
    //                      Absent = the marker itself is the region.
    GROUPS: [
      { // VERIFIED (two chats, 4 and 5 pairs): strictly alternating custom elements
        name: 'user-query / model-response',
        user: 'user-query',
        assistant: 'model-response',
        region: { assistant: ['message-content', '.markdown'] }   // message-content VERIFIED; .markdown VERIFIED as its rendered root
      },
      { // UNVERIFIED fallback if the outer custom elements are renamed but the inner ones survive
        name: 'inner content elements',
        user: '.query-text',                                       // VERIFIED to exist inside user-query
        assistant: 'message-content'
      },
      { // UNVERIFIED structural fallback: one .conversation-container (VERIFIED) per exchange
        name: 'structural: .conversation-container',
        rows: '.conversation-container',
        itemsOf: row => {
          const out = [];
          const u = row.querySelector('user-query, .query-text, [class*="query-text" i]');
          const a = row.querySelector('model-response, message-content, .markdown');
          if (u) out.push({ role: 'user', el: u });
          if (a) out.push({ role: 'assistant', el: a });
          return out;
        },
        region: { assistant: ['message-content', '.markdown'] }
      }
    ],
    PAIR: '.conversation-container',                               // VERIFIED: id unique per user+assistant pair
    SCROLLER_HINTS: ['infinite-scroller.chat-history', 'infinite-scroller'],  // VERIFIED (overflow-y: scroll); generic detection is the fallback
    USER_SKIP_HEADINGS: true,   // VERIFIED reasoning: user text renders as p/li; the only headings in user-query are the sr-only h5
    TIME: 'time[datetime]',                                        // VERIFIED ABSENT on Gemini; harmless safeguard (absolute ISO only)
    MODEL_PICKERS: ['button[data-test-id="bard-mode-menu-button"]'],  // VERIFIED
    MODEL_LABEL: '.picker-primary-text',                           // VERIFIED (short label such as "Flash")
    TITLE_NODES: ['[data-test-id="conversation-title"]', '.conversation-title'],  // UNVERIFIED
    NAV_ITEMS: 'a.gem-nav-list-item',                              // VERIFIED to exist; how the ACTIVE one is marked is UNVERIFIED
    STREAMING: 'button[aria-label="Stop response"], model-response[aria-busy="true"]',  // UNVERIFIED
    // Chrome that must never be exported
    CHROME: [
      'message-actions', 'copy-button', 'thumb-up-button', 'thumb-down-button',                        // VERIFIED present
      'model-response-disclaimers', 'election-info-disclaimer', 'finance-info-disclaimer',             // VERIFIED present
      'freemium-rag-disclaimer', 'sensitive-memories-banner',                                          // VERIFIED present
      '[data-test-id="luminous-expand-button"]',                                                       // VERIFIED present
      '.code-block-decoration',                                                                        // VERIFIED (label is read separately)
      'thinking-overlay',                                                                              // VERIFIED present, carries no information
      'mat-icon', '.google-symbols', '.material-icons', '.material-symbols-outlined',                  // UNVERIFIED: icon-font ligature text
      '[role="toolbar"]', '[role="tooltip"]', '[role="menu"]', '[role="dialog"]'                       // generic
    ].join(', '),
    // Elements skipped unconditionally (bypasses the CONTENT_ANCHORS exemption below). Empty = off. Fill in once a DOM
    // snippet of a response WITH expanded thinking is available; do NOT use [class*="thought"] (matches .has-thoughts).
    ALWAYS_SKIP: '',
    CONTENT_ANCHORS: 'message-content, .markdown',                 // a chrome-looking element holding these is never skipped
    CITATION: 'source-footnote, sources-carousel-inline, source-inline-chip, sources-list',  // VERIFIED names; kept only if they hold <a href>
    CODE_LABEL: '.code-block-decoration',                          // VERIFIED
    ICONS: 'mat-icon, .google-symbols, .material-icons, .material-symbols-outlined',
    ATTACHMENT: 'user-query-file-preview, uploader-file-preview, [data-test-id="file-preview"]',  // UNVERIFIED
    SR_ONLY_RE: /(?:^|\s)(?:sr-only|visually-hidden|cdk-visually-hidden)(?:\s|$)/,
    HIDDEN_HEADING_RE: /^(?:you said|gemini said)\s*:?$/i          // VERIFIED sr-only heading texts (fallback if the class changes)
  };
  try { if (localStorage.getItem('__chat_export_debug') === '1') CONFIG.DEBUG = true; } catch (e) { /* storage blocked */ }

  const host = location.hostname;
  if (!CONFIG.HOSTNAMES.some(h => host === h || host.endsWith('.' + h))) {
    alert(CONFIG.SERVICE_NAME + ' export: this bookmarklet only works on ' + CONFIG.HOSTNAMES.join(', ') +
          ' (current host: ' + host + ').');
    return;
  }
  const STATUS_ID = '__chat_export_status__';
  if (document.getElementById(STATUS_ID)) return; // re-entrancy guard

  const state = { cancelled: false, timedOut: false, discovered: 0 };
  const warnings = [];
  const addWarning = msg => { if (!warnings.includes(msg)) warnings.push(msg); };
  const D = { groups: [], scroller: null, cycles: [], rejected: [] };      // DEBUG collection
  const dlog = (...a) => { if (CONFIG.DEBUG) console.log('[chat-export]', ...a); };
  const reject = msg => { if (CONFIG.DEBUG && D.rejected.length < 300) D.rejected.push(msg); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const squash = s => s.replace(/\s+/g, ' ').trim();

  // Local time "YYYY-MM-DD HH:MM:SS" (never toISOString / toLocale*String)
  function fmtLocal(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // Status UI: createElement + textContent only (Trusted Types); styles via CSSOM (CSP-safe)
  const statusEl = document.createElement('div');
  statusEl.id = STATUS_ID;
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const css = {
    position: 'fixed', right: '16px', bottom: '16px', 'z-index': '2147483647', background: '#1f1f1f',
    color: '#fff', font: '13px/1.4 system-ui, sans-serif', padding: '8px 12px', 'border-radius': '8px',
    'box-shadow': '0 2px 8px rgba(0,0,0,.4)', 'max-width': '380px', 'pointer-events': 'none'
  };
  for (const k in css) statusEl.style.setProperty(k, css[k]);
  document.body.appendChild(statusEl);
  const say = msg => { statusEl.textContent = msg; };
  const onKey = e => { if (e.key === 'Escape') state.cancelled = true; };
  window.addEventListener('keydown', onKey, true);
  let statusLinger = 0;

  // ===================================================================
  // 1. Selector groups + deepQueryAll + message-region resolver
  // ===================================================================
  // Recurses through OPEN shadow roots (VERIFIED: none used by gemini.google.com; cheap safeguard).
  function deepQueryAll(root, selector) {
    const out = [];
    (function walk(r) {
      out.push(...r.querySelectorAll(selector));
      for (const el of r.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    })(root);
    return out;
  }
  function qAll(sel) {
    let list = Array.from(document.querySelectorAll(sel));
    if (!list.length) list = deepQueryAll(document, sel); // only pay for shadow traversal on a miss
    return list;
  }
  function describe(el) {
    if (!el) return '(null)';
    const tid = el.getAttribute && (el.getAttribute('data-test-id') || el.getAttribute('data-testid'));
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return el.localName + (el.id ? '#' + el.id.slice(0, 40) : '') + (tid ? '[data-test-id=' + tid + ']' : '') + (cls ? '.' + cls : '');
  }

  function commonAncestor(nodes, limit) {
    let a = nodes[0];
    while (a && a !== limit && !nodes.every(n => a.contains(n))) a = a.parentElement;
    return a || limit;
  }
  // Message region = the part of a role marker that holds the message itself (no avatar, actions, disclaimers).
  // VERIFIED: model-response > ... > structured-content-container > message-content > .markdown
  function regionFor(g, role, marker) {
    const sels = g.region && g.region[role];
    if (!sels) return marker;
    for (const sel of sels) {
      let hits = Array.from(marker.querySelectorAll(sel));
      hits = hits.filter(h => !hits.some(o => o !== h && o.contains(h))); // outermost only
      if (!hits.length) continue;
      return hits.length === 1 ? hits[0] : commonAncestor(hits, marker); // several parts: their common ancestor
    }
    if (CONFIG.DEBUG) reject('no inner region found, converting the whole marker: ' + describe(marker));
    return marker;
  }

  function collectGroup(g) {
    const items = [];
    if (g.rows) {
      for (const row of qAll(g.rows)) for (const it of g.itemsOf(row)) items.push(it);
    } else {
      for (const el of qAll(g.user)) items.push({ role: 'user', el });
      for (const el of qAll(g.assistant)) items.push({ role: 'assistant', el });
    }
    // keep the outermost element when matches nest; drop exact duplicates
    const kept = items.filter((a, i) => !items.some((b, j) =>
      j !== i && (b.el === a.el ? j < i : b.el.contains(a.el))));
    kept.sort((a, b) => (a.el === b.el ? 0 :
      (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1));
    return kept;
  }
  let activeGroup = null;
  function probeGroups() {
    const counts = CONFIG.GROUPS.map(g => {
      const items = collectGroup(g);
      return { g, items, u: items.filter(i => i.role === 'user').length, a: items.filter(i => i.role === 'assistant').length };
    });
    D.groups = counts.map(c => ({ name: c.g.name, user: c.u, assistant: c.a }));
    return { counts, pick: counts.find(c => c.u > 0 && c.a > 0) || counts.find(c => c.u + c.a > 0) || null };
  }

  // Stable turn keys (dedupe across remounts). VERIFIED: role + ':' + .conversation-container id.
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }
  let hashKeysUsed = false;
  function baseKey(role, marker, region) {
    const pair = marker.closest(CONFIG.PAIR);
    if (pair && pair.id) return role + ':' + pair.id;
    hashKeysUsed = true;
    return role + ':h' + hash32(squash(region.textContent || '').slice(0, 200)); // whitespace-insensitive; never hash a marker alone
  }

  // ===================================================================
  // 2. Scroll-container detection, cycle-based loader, incremental harvest
  // ===================================================================
  const store = { map: new Map(), order: [] };
  let scrollerRef = null;

  function isScrollable(el) {
    const cs = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }
  function findScroller(el) {
    for (const sel of CONFIG.SCROLLER_HINTS) {          // VERIFIED: infinite-scroller.chat-history scrolls, not window
      const h = el.closest(sel);
      if (h && isScrollable(h)) return h;
    }
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (isScrollable(p)) return p;
    }
    return document.scrollingElement || document.documentElement;
  }
  function jump(top) { // instant, even if CSS sets scroll-behavior: smooth
    try { scrollerRef.scrollTo({ top, left: 0, behavior: 'instant' }); } catch (e) { scrollerRef.scrollTop = top; }
  }

  function scan() {
    const items = collectGroup(activeGroup);
    const seen = new Map();
    const mounted = items.map(it => {
      const el = regionFor(activeGroup, it.role, it.el);
      const base = baseKey(it.role, it.el, el);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return { role: it.role, marker: it.el, el, key: n ? base + '#' + n : base };
    });
    ingest(mounted);
    if (hashKeysUsed) addWarning('Turn identity fell back to text hashes (no .conversation-container id); duplicated or merged turns are possible');
    return { count: mounted.length, firstKey: mounted.length ? mounted[0].key : null };
  }

  // Insert new turns next to already-known neighbours so document order is preserved across windows
  function ingest(mounted) {
    const atTop = !!(scrollerRef && scrollerRef.scrollTop <= 4);
    for (let i = 0; i < mounted.length; i++) {
      const m = mounted[i];
      const len = m.el.textContent.length;
      const known = store.map.get(m.key);
      if (known) {
        if (len > known.textLen) fillTurn(known, m, len); // rendered further since first harvest
        else if (!known.time) {
          const tm = findTime(m.marker);
          if (tm.time) { known.time = tm.time; known.dbg.timeSource = tm.source; }
        }
        continue;
      }
      const t = { role: m.role, key: m.key, markdown: '', hasH1: false, time: null, textLen: len, plain: '', alt: null, dbg: {} };
      fillTurn(t, m, len);
      store.map.set(m.key, t);
      let idx;
      if (i > 0) {
        const p = store.order.indexOf(mounted[i - 1].key);
        idx = p >= 0 ? p + 1 : store.order.length;
      } else {
        idx = -1;
        for (let j = 1; j < mounted.length && idx < 0; j++) idx = store.order.indexOf(mounted[j].key);
        if (idx < 0) idx = (atTop || store.order.length === 0) ? 0 : store.order.length;
      }
      store.order.splice(idx, 0, m.key);
      state.discovered++;
    }
  }

  async function loadAll() {
    const deadline = Date.now() + CONFIG.LOAD_TIMEOUT_MS;
    const stop = () => {
      if (state.cancelled) return true;
      if (Date.now() > deadline) { state.timedOut = true; return true; }
      return false;
    };
    const first = activeGroup && collectGroup(activeGroup)[0];
    scrollerRef = first ? findScroller(first.el) : (document.scrollingElement || document.documentElement);
    D.scroller = { el: describe(scrollerRef), scrollHeight: scrollerRef.scrollHeight, clientHeight: scrollerRef.clientHeight };
    const origTop = scrollerRef.scrollTop;
    const wasAtBottom = scrollerRef.scrollHeight - scrollerRef.clientHeight - origTop < 4;

    async function goTopAndStabilize() {
      let last = null, stable = 0;
      while (stable < CONFIG.STABLE_CHECKS) {
        if (stop()) return false;
        if (stable > 0 && CONFIG.TOP_NUDGE_PX > 0) { jump(CONFIG.TOP_NUDGE_PX); await sleep(80); }
        jump(0);
        await sleep(CONFIG.CHECK_INTERVAL_MS);
        const s = scan();
        const sig = s.firstKey + '|' + s.count + '|' + scrollerRef.scrollHeight;
        if (sig === last) stable++; else { stable = 0; last = sig; }
      }
      return true;
    }
    async function walkDown() {
      let stuck = 0, guard = 0;
      for (;;) {
        if (stop()) return false;
        const maxTop = scrollerRef.scrollHeight - scrollerRef.clientHeight;
        const cur = scrollerRef.scrollTop;
        if (cur >= maxTop - 2) break;
        const step = Math.max(80, Math.floor(scrollerRef.clientHeight * CONFIG.STEP_FRACTION));
        jump(Math.min(cur + step, maxTop));
        await sleep(CONFIG.STEP_WAIT_MS);
        scan();
        if (scrollerRef.scrollTop <= cur) { if (++stuck > 5) break; } else stuck = 0;
        if (++guard > 3000) break;
      }
      for (let i = 0; i < 2; i++) { await sleep(CONFIG.CHECK_INTERVAL_MS); scan(); } // late mounts at the bottom
      return true;
    }

    try {
      for (let cycle = 1; cycle <= CONFIG.MAX_CYCLES; cycle++) {
        state.discovered = 0;
        say('Loading history, cycle ' + cycle + '/' + CONFIG.MAX_CYCLES + ' (' + store.order.length + ' turns). Esc cancels.');
        if (!(await goTopAndStabilize())) break;
        say('Reading turns, cycle ' + cycle + ' (' + store.order.length + ' turns). Esc cancels.');
        if (!(await walkDown())) break;
        D.cycles.push({ cycle, newKeys: state.discovered, total: store.order.length });
        if (state.discovered === 0) return; // a full up-and-down cycle found nothing new: complete
        if (cycle === CONFIG.MAX_CYCLES) addWarning('Cycle limit (' + CONFIG.MAX_CYCLES + ') reached while new turns were still appearing; export may be incomplete');
      }
      if (state.cancelled) addWarning('Cancelled with Esc; export may be incomplete');
      if (state.timedOut) addWarning('Loading timed out after ' + Math.round(CONFIG.LOAD_TIMEOUT_MS / 1000) + ' s; export may be incomplete');
    } finally {
      if (scrollerRef.isConnected) { // restore position (stay glued to the bottom if the user was there)
        jump(wasAtBottom ? scrollerRef.scrollHeight : origTop);
      }
    }
  }

  // ===================================================================
  // 3. Metadata: time per turn, selector model for the header, alternates
  // ===================================================================
  const parseIso = s => {
    if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null; // absolute only; relative labels discarded
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  // VERIFIED: Gemini exposes no per-turn timestamps. Safeguard only: an absolute time[datetime] INSIDE the
  // turn's own marker element (never a neighbour's).
  function findTime(marker) {
    for (const t of marker.querySelectorAll(CONFIG.TIME)) {
      if (t.closest('pre')) continue;
      const d = parseIso(t.getAttribute('datetime'));
      if (d) return { time: d, source: 'time[datetime] in marker' };
      if (CONFIG.DEBUG) reject('unparseable time[datetime]=' + t.getAttribute('datetime'));
    }
    return { time: null, source: null };
  }
  // UNVERIFIED: retry/draft navigator "n / m" inside model-response but OUTSIDE the message region
  function findAlternates(marker, region) {
    for (const el of marker.querySelectorAll('span, div, p')) {
      if (el.children.length || region.contains(el) || el.closest('pre, code')) continue;
      const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(el.textContent);
      if (m && +m[2] > 1) return m[1] + '/' + m[2];
    }
    return null;
  }
  // VERIFIED: model picker. Reflects the model for the NEXT message only; header-only, never per turn.
  function selectorModel() {
    for (const sel of CONFIG.MODEL_PICKERS) {
      const b = document.querySelector(sel);
      if (!b) continue;
      const lab = b.querySelector(CONFIG.MODEL_LABEL);
      let v = lab ? squash(lab.textContent) : '';
      if (!v) { // aria-label like "Open mode picker, currently Flash"
        const m = /currently\s+(.+?)\s*$/i.exec(b.getAttribute('aria-label') || '');
        if (m) v = m[1].trim();
      }
      if (v) return v; // never fall back to button.textContent: it contains icon-font ligature text
    }
    return null;
  }
  function firstLeafText(el) {
    const leaf = Array.from(el.querySelectorAll('*')).find(e =>
      !e.children.length && e.textContent.trim() && !e.closest(CONFIG.ICONS + ', button'));
    return leaf ? leaf.textContent.trim() : (el.children.length ? '' : el.textContent.trim());
  }

  function plainOf(md) { // readable text of converted Markdown (title fallback only)
    return squash(md.replace(/[\uE000-\uF8FF]/g, ' ').replace(/\\([\\`*_{}\[\]()#+\-.!|<>~$&])/g, '$1')).slice(0, 200);
  }
  function fillTurn(t, m, len) {
    let conv;
    try {
      conv = convertTurn(m.role, m.el);
    } catch (e) {
      addWarning('A turn failed to convert and was exported as plain text (' + (e && e.message) + ')');
      conv = { md: escapeText(squash(m.el.textContent)), hasH1: false };
    }
    t.markdown = conv.md;
    t.hasH1 = conv.hasH1;
    t.textLen = len;
    t.plain = plainOf(conv.md);
    const tm = findTime(m.marker);
    t.time = tm.time;
    t.alt = m.role === 'assistant' ? findAlternates(m.marker, m.el) : null;
    t.dbg = {
      marker: describe(m.marker), region: describe(m.el), keySource: /:h[0-9a-f]+(#\d+)?$/.test(m.key) ? 'text hash' : 'pair id',
      regionTextLen: len, markerTextLen: m.marker.textContent.length, timeSource: tm.source, alternates: t.alt, mdLen: conv.md.length
    };
    if (!m.el.textContent.trim()) {
      if (CONFIG.DEBUG) { dlog('WARNING: region has no text', t.key, describe(m.el)); reject('region without text: ' + t.key); }
    }
  }

  // ===================================================================
  // 4. DOM -> Markdown converter (headings emitted as level tokens)
  // ===================================================================
  // Private-use sentinels (all PUA characters are stripped from source text first)
  const HB = '\uE010';                         // hard line break
  const H_START = '\uE000', H_MID = '\uE001', H_END = '\uE002'; // heading token: START level MID text END
  const PUA_RE = /[\uE000-\uF8FF]/g;
  const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const clean = s => s.replace(PUA_RE, '').replace(CTRL_RE, '');

  // 'button' is handled explicitly in shouldSkip()
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'audio', 'video', 'iframe',
    'object', 'embed', 'textarea', 'select', 'option', 'link', 'meta', 'head', 'time', 'dialog']);
  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'figure', 'figcaption',
    'form', 'fieldset', 'address', 'dl', 'dt', 'dd', 'center', 'summary', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
    'thead', 'tbody', 'tfoot', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details']);
  const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'ins', 'kbd', 'label',
    'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'u', 'var', 'wbr', 'del', 'img', 'input', 'br']);

  function isBlockLike(el) {
    const tag = el.localName;
    if (BLOCK_TAGS.has(tag)) return true;
    if (INLINE_TAGS.has(tag)) return false;
    const d = getComputedStyle(el).display; // custom elements (Gemini uses many): ask the browser
    return !(d.startsWith('inline') || d === 'contents' || d === 'none');
  }
  const displayNone = el => getComputedStyle(el).display === 'none';
  function looksVisuallyHidden(el) { // fallback for sr-only headings whose class names changed
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute') return false;
    return cs.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(\s*50%/.test(cs.clipPath || '') ||
           (parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1);
  }

  function newCtx(role, root) {
    return { user: role === 'user', flat: false, line: false, inCell: false, root, wsCache: new Map(), turn: { hasH1: false } };
  }
  const flatCtx = (ctx, extra) => Object.assign({}, ctx, { flat: true }, extra || {});

  function convertTurn(role, root) {
    const ctx = newCtx(role, root);
    const st = { blocks: [], inline: '', verb: false };
    walkChildren(root, ctx, st);
    flushInline(st, ctx);
    let md = joinBlocks(st.blocks, false);
    if (role === 'user') md = userPostProcess(md, ctx);
    if (!md.trim()) addWarning('Some turns contained no convertible text');
    return { md, hasH1: ctx.turn.hasH1 };
  }

  // ---- escaping -----------------------------------------------------
  const ALNUM = /[\p{L}\p{N}]/u;
  function escapeText(t) {
    let out = '';
    const n = t.length;
    const hasTwoDollars = t.indexOf('$') !== t.lastIndexOf('$');
    for (let i = 0; i < n; i++) {
      const c = t[i], prev = i > 0 ? t[i - 1] : '', next = i < n - 1 ? t[i + 1] : '';
      switch (c) {
        case '\\': out += (next === '' || /[!-\/:-@\[-`{-~]/.test(next)) ? '\\\\' : '\\'; break;
        case '`': out += '\\`'; break;
        case '*': out += (/\s/.test(prev) && /\s/.test(next)) ? '*' : '\\*'; break;
        case '_': out += (prev && next && ALNUM.test(prev) && ALNUM.test(next)) ? '_' : '\\_'; break; // intraword _ is inert
        case '[': case ']': out += '\\' + c; break;
        case '<': out += /[A-Za-z\/!?]/.test(next) ? '\\<' : '<'; break;
        case '&': out += /^&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.test(t.slice(i)) ? '\\&' : '&'; break;
        case '~': out += (prev === '~' || next === '~') ? '\\~' : '~'; break;
        case '$': out += hasTwoDollars ? '\\$' : '$'; break; // keep prose from being read as $math$
        default: out += c;
      }
    }
    return out;
  }
  // Line-leading syntax (#, >, -, +, "N.", ~~~, setext/thematic lines) in paragraph-like text.
  // Lines inside $$ ... $$ math are skipped. HB counts as a line boundary.
  function escapeLineStarts(s) {
    const parts = s.split(/(\n|\uE010)/);
    let inMath = false;
    for (let i = 0; i < parts.length; i += 2) {
      let t = parts[i];
      if (/^\s*\$\$\s*$/.test(t)) { inMath = !inMath; continue; }
      if (inMath) continue;
      t = t.replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
           .replace(/^(\s*)>/, '$1\\>')
           .replace(/^(\s*)([-+])(?=\s|$)/, '$1\\$2')
           .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3')
           .replace(/^(\s*)(~{3,})/, '$1\\$2')
           .replace(/^(\s*)(-{3,}|_{3,}|=+)\s*$/, '$1\\$2');
      parts[i] = t;
    }
    return parts.join('');
  }

  // ---- inline buffer helpers ----------------------------------------
  // st = { blocks, inline, verb }.  st.verb: the buffer holds verbatim (pre-wrap) text that must not be escaped.
  function put(st, s) { // append inline text, collapsing a doubled boundary space
    if (!s) return;
    if (s[0] === ' ' && (st.inline === '' || /[ \n\uE010]$/.test(st.inline))) s = s.slice(1);
    st.inline += s;
  }
  function finishInline(s, ctx, verb) {
    if (!s) return '';
    s = verb ? s.replace(/^[\n\uE010]+/, '') : s.replace(/^[ \t\n\uE010]+/, '');
    s = s.replace(/[ \t\n\uE010]+$/, '').replace(/ *\uE010 */g, HB);
    if (!ctx.flat && !verb) s = escapeLineStarts(s);
    return s;
  }
  function flushInline(st, ctx) {
    const s = finishInline(st.inline, ctx, st.verb);
    st.inline = '';
    st.verb = false;
    if (s.trim()) st.blocks.push({ s, k: 'p' });
  }
  function wrapInline(open, close, s) { // CommonMark: no whitespace just inside the delimiters
    const m = /^([ \t\n\uE010]*)([\s\S]*?)([ \t\n\uE010]*)$/.exec(s);
    return m[2] ? m[1] + open + m[2] + close + m[3] : s;
  }
  function inlineJoin(n, ctx) { // ctx must be a flat ctx
    const st = { blocks: [], inline: '', verb: false };
    walkChildren(n, ctx, st);
    let s;
    if (!st.blocks.length) s = st.inline; // keep edge whitespace for emphasis/link wrappers
    else { flushInline(st, ctx); s = st.blocks.map(b => b.s).join(ctx.inCell ? HB : ' '); }
    if (ctx.line) s = s.replace(/\uE010/g, ' ').replace(/\s+/g, ' ');
    return s;
  }
  function flowBlocks(n, ctx, skipEl) {
    const st = { blocks: [], inline: '', verb: false };
    walkChildren(n, ctx, st, skipEl);
    flushInline(st, ctx);
    return st.blocks;
  }
  function joinBlocks(blocks, inLi) {
    let out = '';
    blocks.forEach((b, i) => {
      if (i === 0) { out = b.s; return; }
      out += ((inLi && b.k === 'list' && blocks[i - 1].k === 'p') ? '\n' : '\n\n') + b.s;
    });
    return out;
  }

  // ---- text nodes ---------------------------------------------------
  function wsOf(el, ctx) {
    let v = ctx.wsCache.get(el);
    if (v === undefined) { v = getComputedStyle(el).whiteSpace; ctx.wsCache.set(el, v); }
    return v;
  }
  // nearest ancestor whose white-space is not normal/nowrap decides.
  // VERIFIED: Gemini user text is white-space: normal => never verbatim => goes through the normal converter.
  function isVerbatim(el, ctx) {
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const ws = wsOf(p, ctx);
      if (ws && ws !== 'normal' && ws !== 'nowrap') return ws.startsWith('pre');
      if (p === ctx.root) break;
    }
    return false;
  }
  function appendText(node, ctx, st) {
    const raw = node.nodeValue ? clean(node.nodeValue) : '';
    if (!raw) return;
    if (ctx.user && !ctx.flat && isVerbatim(node.parentNode, ctx)) {
      st.inline += raw.replace(/\r\n?/g, '\n'); // verbatim, unescaped
      st.verb = true;
      return;
    }
    const s = raw.replace(/\u00a0/g, ' ').replace(/[ \t\r\n\f]+/g, ' ');
    if (s === '') return;
    put(st, escapeText(s));
  }

  // ---- code ---------------------------------------------------------
  function fenced(code, lang) {
    let max = 0;
    const re = /`+/g;
    let m;
    while ((m = re.exec(code))) max = Math.max(max, m[0].length);
    const f = '`'.repeat(Math.max(3, max + 1));
    return f + (lang || '') + '\n' + code + '\n' + f;
  }
  function inlineCode(text) {
    text = clean(text).replace(/\r?\n/g, ' ');
    if (!text.trim()) return '';
    let max = 0;
    const re = /`+/g;
    let m;
    while ((m = re.exec(text))) max = Math.max(max, m[0].length);
    const d = '`'.repeat(max + 1);
    const padIt = /^`|`$/.test(text) || (/^ .* $/.test(text) && /\S/.test(text));
    return d + (padIt ? ' ' + text + ' ' : text) + d;
  }
  // VERIFIED Gemini: .code-block-decoration holds the label (e.g. "Python"); pre > code.code-container holds the code.
  function labelOf(deco) {
    for (const c of deco.querySelectorAll('*')) {
      if (!c.children.length && c.textContent.trim() && !c.closest('button, ' + CONFIG.ICONS)) return c.textContent.trim();
    }
    return deco.children.length ? '' : deco.textContent.trim();
  }
  function labelNear(pre) { // nearest ancestor that holds exactly this <pre> and a decoration bar
    let p = pre.parentElement;
    for (let i = 0; p && i < 5; i++, p = p.parentElement) {
      if (p.querySelectorAll('pre').length !== 1) return '';
      const d = p.querySelector(CONFIG.CODE_LABEL);
      if (d && !pre.contains(d)) return labelOf(d);
    }
    return '';
  }
  function codeBlockOf(pre, label) {
    const codeEl = pre.querySelector('code') || pre;       // text ONLY from <code>
    let text = clean(codeEl.textContent).replace(/\r\n?/g, '\n');
    const lines = codeEl.querySelectorAll('.cm-line');     // per-line editors without newline characters
    if (lines.length > 1 && text.indexOf('\n') < 0) text = Array.from(lines).map(l => l.textContent).join('\n');
    text = text.replace(/\n$/, '');
    const rx = /(?:^|\s)language-([^\s]+)/;
    const m = rx.exec(codeEl.getAttribute('class') || '') || rx.exec(pre.getAttribute('class') || '');
    let lang = m ? m[1] : '';
    if (!lang && label && /^[\w+#.\-]{1,24}$/.test(label) && !/^copy/i.test(label)) lang = label.toLowerCase(); // "Code snippet" has a space: no language
    return fenced(text, lang.replace(/[^\w+#.\-]/g, ''));
  }

  // ---- math ---------------------------------------------------------
  // VERIFIED on Gemini: TeX source in the data-math attribute of every .katex node; annotation / MathML are fallbacks.
  function texOf(root) {
    const dm = root.getAttribute && root.getAttribute('data-math');
    if (dm) return dm;
    const inner = root.querySelector('[data-math]');
    if (inner) return inner.getAttribute('data-math');
    const a = root.querySelector('annotation[encoding="application/x-tex"]');
    if (a) return a.textContent;
    const m = root.localName === 'math' ? root : root.querySelector('math');
    if (m) return Array.from(m.querySelectorAll('mi, mo, mn, mtext, ms')).map(x => x.textContent).join(' ');
    const h = root.querySelector('.katex-html');
    return h ? h.textContent : root.textContent;
  }
  const isMath = n => n.localName === 'math' || n.hasAttribute('data-math') ||
    (n.classList && (n.classList.contains('katex-display') || n.classList.contains('katex')));
  function handleMath(n, ctx, st) {
    const display = !!n.closest('.katex-display, .math-display, .math-block') || n.getAttribute('display') === 'block'; // .math-block UNVERIFIED
    const root = n.classList.contains('katex-display') ? (n.querySelector('.katex') || n) : n;
    const tex = clean(texOf(root)).replace(/\r\n?/g, '\n').trim();
    if (!tex) return;
    if (display && !ctx.flat) {
      flushInline(st, ctx);
      st.blocks.push({ s: '$$\n' + tex + '\n$$', k: 'math' });
    } else {
      put(st, '$' + tex.replace(/\s*\n\s*/g, ' ') + '$');
    }
  }

  // ---- skip -----------------------------------------------------------
  function shouldSkip(n) {
    const tag = n.localName;
    if (tag === 'button') {
      // image-only buttons (e.g. a clickable upload preview) stay as transparent wrappers; UNVERIFIED
      if (!(n.querySelector('img') && !n.textContent.trim())) return true;
    } else if (SKIP_TAGS.has(tag)) return true;
    if (tag === 'input') return n.type !== 'checkbox';
    if (n.hidden || n.getAttribute('aria-hidden') === 'true') return true;
    const cls = n.getAttribute('class');
    // VERIFIED sr-only content: user-query h5 (duplicates the query text), model-response h6 "Gemini said"
    if (cls && CONFIG.SR_ONLY_RE.test(cls)) {
      if (CONFIG.DEBUG) reject('sr-only skipped: ' + describe(n) + ' "' + squash(n.textContent).slice(0, 40) + '"');
      return true;
    }
    if (CONFIG.ALWAYS_SKIP && n.matches(CONFIG.ALWAYS_SKIP)) return true;
    if (n.matches(CONFIG.CHROME)) {
      if (n.querySelector(CONFIG.CONTENT_ANCHORS)) { // never let a chrome-looking wrapper swallow the message
        if (CONFIG.DEBUG) reject('chrome-looking element holds message content, kept: ' + describe(n));
        return false;
      }
      if (CONFIG.DEBUG) reject('chrome skipped: ' + describe(n));
      return true;
    }
    if (n.matches(CONFIG.CITATION) && !n.querySelector('a[href]')) return true;
    return false;
  }

  function absUrl(href) { try { return new URL(href, location.href).href; } catch (e) { return ''; } }
  const encUrl = u => u.replace(/[()<>\s]/g, c => ({ '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' }[c] || '%20'));

  // ---- the walker -----------------------------------------------------
  function walkChildren(node, ctx, st, skipEl) {
    for (let c = node.firstChild; c; c = c.nextSibling) if (c !== skipEl) walkNode(c, ctx, st);
  }
  function walkNode(n, ctx, st) {
    if (n.nodeType === 3) { appendText(n, ctx, st); return; }
    if (n.nodeType !== 1) return;
    const tag = n.localName;

    if (isMath(n)) { handleMath(n, ctx, st); return; } // before aria-hidden skipping: KaTeX hides its internals
    // UNVERIFIED: file attachments (not images) in user turns -> [Attachment: name]
    if (ctx.user && !ctx.flat && n.matches(CONFIG.ATTACHMENT) && !n.querySelector('img')) {
      const name = squash(n.getAttribute('aria-label') || n.getAttribute('title') || firstLeafText(n) || 'file').slice(0, 120);
      flushInline(st, ctx);
      st.blocks.push({ s: '[Attachment: ' + name.replace(/[\[\]]/g, '') + ']', k: 'p' });
      return;
    }
    if (shouldSkip(n)) return;

    switch (tag) {
      case 'br':
        if (ctx.user && isVerbatim(n.parentNode, ctx)) st.inline += '\n';
        else st.inline += ctx.line ? ' ' : HB;
        return;
      case 'hr':
        if (!ctx.flat) { flushInline(st, ctx); st.blocks.push({ s: '***', k: 'hr' }); } // '---' is the turn delimiter
        return;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        // user text never renders as headings on Gemini (VERIFIED p/li); the only headings there are sr-only duplicates
        if (ctx.user && CONFIG.USER_SKIP_HEADINGS) return;
        if (CONFIG.HIDDEN_HEADING_RE.test(squash(n.textContent)) || looksVisuallyHidden(n)) {
          if (CONFIG.DEBUG) reject('hidden heading skipped: ' + describe(n) + ' "' + squash(n.textContent).slice(0, 40) + '"');
          return;
        }
        if (ctx.flat) { flushInline(st, ctx); walkChildren(n, ctx, st); flushInline(st, ctx); return; }
        flushInline(st, ctx);
        const lvl = +tag[1];
        const txt = inlineJoin(n, flatCtx(ctx, { line: true })).trim();
        if (!txt) return;
        if (lvl === 1) ctx.turn.hasH1 = true; // DOM-decided; sr-only/hidden/chrome never reach here
        st.blocks.push({ s: H_START + lvl + H_MID + txt + H_END, k: 'h' });
        return;
      }
      case 'pre':
        if (ctx.flat) { put(st, inlineCode(n.textContent)); return; }
        flushInline(st, ctx);
        st.blocks.push({ s: codeBlockOf(n, labelNear(n)), k: 'code' });
        return;
      case 'code':
        if (ctx.user && isVerbatim(n, ctx)) { walkChildren(n, ctx, st); return; } // verbatim user text already carries its own backticks
        put(st, inlineCode(n.textContent));
        return;
      case 'ul': case 'ol':
        if (ctx.flat) { flushInline(st, ctx); walkChildren(n, ctx, st); flushInline(st, ctx); return; }
        flushInline(st, ctx);
        { const s = listString(n, ctx); if (s) st.blocks.push({ s, k: 'list' }); }
        return;
      case 'li':
        flushInline(st, ctx);
        if (ctx.flat) { st.inline = '- '; walkChildren(n, ctx, st); flushInline(st, ctx); return; }
        { const s = itemString(n, '- ', ctx); if (s) st.blocks.push({ s, k: 'list' }); }
        return;
      case 'blockquote': {
        flushInline(st, ctx);
        const inner = flowBlocks(n, ctx);
        if (!inner.length) return;
        if (ctx.flat) { inner.forEach(b => st.blocks.push(b)); return; }
        const body = joinBlocks(inner, false);
        st.blocks.push({ s: body.split('\n').map(l => (l ? '> ' + l : '>')).join('\n'), k: 'q' });
        return;
      }
      case 'table':
        flushInline(st, ctx);
        if (ctx.flat) { put(st, escapeText(squash(n.textContent))); addWarning('Nested table flattened to text'); return; }
        { const s = tableString(n, ctx); if (s) st.blocks.push({ s, k: 'table' }); }
        return;
      case 'details': {
        flushInline(st, ctx);
        if (ctx.flat) { walkChildren(n, ctx, st); flushInline(st, ctx); return; }
        const summ = Array.from(n.children).find(c => c.localName === 'summary');
        const title = (summ ? squash(clean(summ.textContent)) : '') || 'Details';
        const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const body = joinBlocks(flowBlocks(n, ctx, summ), false);
        st.blocks.push({ s: '<details>\n<summary>' + esc + '</summary>\n' + (body ? '\n' + body + '\n\n' : '') + '</details>', k: 'other' });
        return;
      }
      case 'strong': case 'b': put(st, wrapInline('**', '**', inlineJoin(n, flatCtx(ctx)))); return;
      case 'em': case 'i': put(st, wrapInline('*', '*', inlineJoin(n, flatCtx(ctx)))); return;
      case 'del': case 's': case 'strike': put(st, wrapInline('~~', '~~', inlineJoin(n, flatCtx(ctx)))); return;
      case 'sup': case 'sub': put(st, wrapInline('<' + tag + '>', '</' + tag + '>', inlineJoin(n, flatCtx(ctx)))); return;
      case 'a': {
        const href = n.getAttribute('href');
        const abs = href ? absUrl(href) : '';
        if (!/^(https?:|mailto:)/i.test(abs)) { walkChildren(n, ctx, st); return; }
        const text = inlineJoin(n, flatCtx(ctx));
        if (!text.trim()) return;
        put(st, wrapInline('[', '](' + encUrl(abs) + ')', text));
        return;
      }
      case 'img': {
        if (n.closest(CONFIG.CITATION)) return; // source-chip favicons
        const alt = squash(clean(n.getAttribute('alt') || ''));
        const w = n.width || n.naturalWidth || 0;
        if (alt && alt.length <= 8 && w > 0 && w <= 32) { put(st, escapeText(alt)); return; } // emoji-as-image
        const src = n.currentSrc || n.src || '';
        const a = alt.replace(/[\[\]]/g, '');
        if (/^https?:/i.test(src)) put(st, '![' + a + '](' + encUrl(src) + ')');
        else put(st, '[Image: ' + (a || 'image') + ']'); // blob:/data: URLs will not resolve later
        return;
      }
      case 'input': put(st, n.checked ? '[x] ' : '[ ] '); return;
      default:
        // custom elements / div / span: display:none holds hidden UI or a non-visible draft -> not exported
        if (displayNone(n)) { if (CONFIG.DEBUG) reject('display:none skipped: ' + describe(n)); return; }
        if (isBlockLike(n)) { flushInline(st, ctx); walkChildren(n, ctx, st); flushInline(st, ctx); }
        else walkChildren(n, ctx, st);
    }
  }

  // ---- lists ----------------------------------------------------------
  function itemString(li, marker, ctx) {
    const body = joinBlocks(flowBlocks(li, ctx), true);
    if (!body.trim()) return '';
    const pad = ' '.repeat(marker.length);
    return body.split('\n').map((l, i) => (i === 0 ? marker + l : (l ? pad + l : l))).join('\n');
  }
  function listString(list, ctx) {
    const ordered = list.localName === 'ol';
    let num = ordered ? parseInt(list.getAttribute('start'), 10) : 1;
    if (isNaN(num)) num = 1;
    const items = [];
    for (const li of list.children) {
      if (li.localName === 'ul' || li.localName === 'ol') { // invalid but seen: nested list directly in a list
        const s = listString(li, ctx);
        if (s) items.push(s.split('\n').map(l => (l ? '  ' + l : l)).join('\n'));
        continue;
      }
      if (li.localName !== 'li' || shouldSkip(li)) continue;
      if (ordered && li.hasAttribute('value')) { const v = parseInt(li.getAttribute('value'), 10); if (!isNaN(v)) num = v; }
      const s = itemString(li, ordered ? num + '. ' : '- ', ctx);
      if (s) items.push(s);
      num++;
    }
    return items.join('\n');
  }

  // ---- tables ---------------------------------------------------------
  function tableString(tbl, ctx) {
    const trs = Array.from(tbl.querySelectorAll('tr')).filter(tr => tr.closest('table') === tbl);
    if (!trs.length) { addWarning('A table could not be represented and was simplified to text'); return escapeText(squash(tbl.textContent)); }
    const cellCtx = flatCtx(ctx, { inCell: true });
    let merged = false;
    const rows = trs.map(tr => {
      const cells = [];
      for (const c of tr.children) {
        if (c.localName !== 'th' && c.localName !== 'td') continue;
        if (+c.getAttribute('rowspan') > 1) merged = true;
        let s = inlineJoin(c, cellCtx).replace(/\uE010/g, '<br>').replace(/\n/g, '<br>').replace(/(<br>\s*)+$/g, '').replace(/^(\s*<br>)+/g, '').trim();
        s = s.replace(/\|/g, '\\|');
        cells.push({ s, th: c.localName === 'th', c });
        for (let k = 1; k < (+c.getAttribute('colspan') || 1); k++) { merged = true; cells.push({ s: '', th: false, c: null }); }
      }
      return cells;
    }).filter(r => r.length);
    if (!rows.length) return '';
    if (merged) addWarning('Table with merged cells (rowspan/colspan) was simplified');
    const ncol = Math.max(...rows.map(r => r.length));
    const aligns = [];
    for (let i = 0; i < ncol; i++) {
      const hc = rows[0][i] && rows[0][i].c;
      const a = hc ? ((hc.getAttribute('align') || hc.style.textAlign || (/\btext-(left|center|right)\b/.exec(hc.getAttribute('class') || '') || [])[1] || '').toLowerCase()) : '';
      aligns.push(a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
    }
    const line = r => '| ' + Array.from({ length: ncol }, (_, i) => (r[i] ? r[i].s : '')).join(' | ') + ' |';
    return [line(rows[0]), '| ' + aligns.join(' | ') + ' |'].concat(rows.slice(1).map(line)).join('\n');
  }

  // ---- user-turn post-processing ----------------------------------------
  // Outside fenced code: ATX headings become tokens (so H1 detection and demotion apply to them);
  // thematic breaks become *** because --- is the turn delimiter.
  // Gemini user text goes through the escaping converter, so a typed "# x" line arrives as "\# x" and a typed
  // ``` fence arrives as escaped backticks: both forms are recognised here. Lines are split on \n and HB.
  const ATX_RE = /^ {0,3}\\?(#{1,6})(?:[ \t]+(.+?))?[ \t]*$/;
  const HR_RE = /^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/;
  const FENCE_OPEN_RE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
  function closesFence(line, f) {
    const t = line.replace(/^[ \t>]*/, '').replace(/\s+$/, '');
    return t.length >= f.len && t === f.ch.repeat(t.length);
  }
  const unescFence = l => l.replace(/\\([`~])/g, '$1');
  function userPostProcess(md, ctx) {
    const parts = md.split(/(\n|\uE010)/);
    let fence = null;
    for (let i = 0; i < parts.length; i += 2) {
      const l = parts[i];
      const probe = unescFence(l);
      if (fence) { if (closesFence(fence.real ? l : probe, fence)) fence = null; continue; }
      let fm = FENCE_OPEN_RE.exec(l), real = true;
      if (!fm) { fm = FENCE_OPEN_RE.exec(probe); real = false; }
      if (fm && !(fm[1][0] === '`' && fm[2].indexOf('`') >= 0)) { fence = { ch: fm[1][0], len: fm[1].length, real }; continue; }
      const m = ATX_RE.exec(l);
      if (m && m[2]) {
        const text = m[2].replace(/[ \t]+#+$/, '').trim();
        if (text) {
          if (m[1].length === 1) ctx.turn.hasH1 = true;
          parts[i] = H_START + m[1].length + H_MID + text + H_END;
          continue;
        }
      }
      if (HR_RE.test(l)) parts[i] = '***';
    }
    return parts.join('');
  }

  // ===================================================================
  // 5. Heading pass: hasH1 ? shift +1 (H6 -> bold) : unchanged
  // ===================================================================
  function resolveHeadings(md, shift, counter) {
    return md.replace(/\uE000(\d)\uE001([^\uE002]*)\uE002/g, (m, lv, text) => {
      const level = +lv;
      if (!shift) return '#'.repeat(level) + ' ' + text;
      if (level >= 6) { // becomes a bold paragraph (its own block, so blank lines already surround it)
        counter.h6++;
        const t = text.replace(/\*\*|__/g, '');
        return t ? '**' + t + '**' : '';
      }
      return '#'.repeat(level + 1) + ' ' + text;
    });
  }

  // ===================================================================
  // 6. Header + turn assembly (bold bracket labels, --- separators), warnings
  // ===================================================================
  function activeNavTitle() { // UNVERIFIED: how the active sidebar item is marked
    const links = Array.from(document.querySelectorAll(CONFIG.NAV_ITEMS));
    const pick = links.find(a => a.getAttribute('aria-current') === 'page' || a.classList.contains('selected') || a.classList.contains('active')) ||
                 links.find(a => a.pathname && a.pathname === location.pathname);
    if (!pick) return '';
    const node = pick.querySelector('.conversation-title') || pick;
    return squash(firstLeafText(node));
  }
  function chatTitle(turns) {
    const fromDoc = squash(document.title.replace(CONFIG.TITLE_SUFFIX_RE, ''));
    if (fromDoc && !CONFIG.GENERIC_TITLE_RE.test(fromDoc)) return { t: fromDoc, src: 'document.title' };
    for (const sel of CONFIG.TITLE_NODES) {
      const el = document.querySelector(sel);
      const v = el && squash(firstLeafText(el) || el.textContent);
      if (v) return { t: v, src: sel };
    }
    const nv = activeNavTitle();
    if (nv) return { t: nv, src: 'active sidebar item' };
    const u = turns.find(t => t.role === 'user' && t.plain);
    if (u) return { t: u.plain.slice(0, 60).trim(), src: 'first user message' };
    return { t: 'Untitled conversation', src: 'fallback' };
  }
  function slugify(title) {
    let s = title.toLowerCase().replace(/[<>:"\/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    s = s.replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(s)) s = '';
    return s || 'untitled';
  }
  function finalizeMarkdown(md) {
    md = md.replace(/\r\n?/g, '\n').replace(/\uE010/g, '  \n').replace(PUA_RE, '');
    const lines = md.split('\n');
    const out = [];
    let fence = null, blank = 0;
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (fence) { out.push(l); if (closesFence(l, fence)) fence = null; blank = 0; continue; }
      const fm = FENCE_OPEN_RE.exec(l);
      if (fm && !(fm[1][0] === '`' && fm[2].indexOf('`') >= 0)) fence = { ch: fm[1][0], len: fm[1].length };
      const next = lines[i + 1];
      if (/\S/.test(l) && / {2,}$/.test(l) && next !== undefined && /\S/.test(next)) l = l.replace(/\s+$/, '') + '  '; // intentional hard break
      else l = l.replace(/[ \t]+$/, '');
      if (l === '') { if (++blank > 2) continue; } else blank = 0;
      out.push(l);
    }
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }
  function assemble(turns, meta) {
    const hasH1 = turns.some(t => t.hasH1);
    const counter = { h6: 0 };
    const label = { user: 'User', assistant: CONFIG.ASSISTANT_LABEL };
    const parts = turns.map(t => {
      let s = '**[' + label[t.role] + ']**';
      if (t.time) s += '\n\n*Time: ' + fmtLocal(t.time) + '*';
      const body = resolveHeadings(t.markdown, hasH1, counter).replace(/^\s+|\s+$/g, '');
      if (body) s += '\n\n' + body;
      return s;
    });
    if (counter.h6) addWarning(counter.h6 + ' H6 heading(s) converted to bold');
    if (turns.length && turns[0].role !== 'user') addWarning('First exported turn is not from the user (earlier history may be missing)');
    const alts = turns.map((t, i) => (t.alt ? (i + 1) + ' (' + t.alt + ')' : null)).filter(Boolean);
    if (alts.length) addWarning('Alternate versions/retries shown for turn(s) ' + alts.slice(0, 10).join(', ') + '; only the visible version was exported');
    if (document.querySelector(CONFIG.STREAMING)) addWarning('A response appears to be still streaming; the last turn may be incomplete');
    const roles = { user: 0, assistant: 0 };
    turns.forEach(t => roles[t.role]++);
    if (!roles.user || !roles.assistant) addWarning('No ' + (roles.user ? 'assistant' : 'user') + ' turns matched; selectors may have changed');

    const head = ['# ' + CONFIG.ASSISTANT_LABEL + ' Export: ' + squash(escapeText(meta.title)), '',
      '- **Exported:** ' + fmtLocal(new Date()),
      '- **Source:** ' + location.href];
    if (meta.model) head.push('- **Selector model (at export time; may not apply to earlier turns):** ' + escapeText(meta.model));
    head.push('- **Turns:** ' + turns.length);
    if (warnings.length) head.push('- **Warnings:** ' + warnings.join('; '));
    return { text: finalizeMarkdown(head.join('\n') + '\n\n---\n\n' + parts.join('\n\n---\n\n')), hasH1 };
  }

  // ===================================================================
  // 7. Blob download, cleanup, status teardown
  // ===================================================================
  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' }); // UTF-8, LF, no BOM
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), Math.max(10000, CONFIG.REVOKE_DELAY_MS));
  }
  function printDebug(turns, hasH1) {
    if (!CONFIG.DEBUG) return;
    const per = { user: 0, assistant: 0 };
    turns.forEach(t => per[t.role]++);
    const adj = [];
    turns.forEach((t, i) => { if (i && turns[i - 1].role === t.role) adj.push(i); });
    console.groupCollapsed('[chat-export] debug');
    console.log('selector groups (matches at start)', D.groups);
    console.log('active group', activeGroup && activeGroup.name);
    console.log('scroll container', D.scroller);
    console.log('turns per role', per);
    console.log('cycles', D.cycles);
    console.groupCollapsed('per-turn (marker, region, key source, metadata sources)');
    turns.forEach((t, i) => console.log(i, t.role, t.key, t.dbg));
    console.groupEnd();
    console.log('same-role adjacencies at indices', adj);
    console.log('hasH1', hasH1, 'turns with H1:', turns.map((t, i) => (t.hasH1 ? i : -1)).filter(i => i >= 0));
    console.log('rejected / skipped candidates', D.rejected);
    console.log('warnings', warnings.slice());
    console.groupEnd();
  }
  function fatal(msg) { statusEl.remove(); alert(CONFIG.SERVICE_NAME + ' export: ' + msg); }

  // ---------------------------- main -------------------------------------
  try {
    say('Looking for conversation turns...');
    let probe = probeGroups();
    for (let i = 0; i < 12 && !probe.pick; i++) { await sleep(500); probe = probeGroups(); }
    if (!probe.pick) {
      const rows = probe.counts.map(c => '  - ' + c.g.name + ': ' + c.u + ' user, ' + c.a + ' assistant').join('\n');
      printDebug([], false);
      fatal('no conversation turns found, nothing was downloaded.\nSelector groups tried:\n' + rows +
            '\nOpen a conversation (not the home page) and retry; if it persists, the DOM changed.');
      return;
    }
    activeGroup = probe.pick.g;
    scrollerRef = findScroller(probe.pick.items[0].el);
    scan();
    if (CONFIG.AUTOLOAD) {
      try { await loadAll(); } catch (e) { addWarning('Loader error (' + (e && e.message) + '); export may be incomplete'); console.error(e); }
    } else {
      addWarning('Auto-load disabled; only currently mounted turns were exported');
    }
    scan();

    const turns = store.order.map(k => store.map.get(k));
    if (!turns.length) {
      printDebug([], false);
      fatal('conversion produced zero turns, nothing was downloaded. Matched groups: ' + JSON.stringify(D.groups));
      return;
    }
    const title = chatTitle(turns);
    const out = assemble(turns, { title: title.t, model: selectorModel() });
    if (CONFIG.DEBUG) dlog('title source:', title.src);
    printDebug(turns, out.hasH1);
    const day = fmtLocal(new Date()).slice(0, 10);
    download(CONFIG.SERVICE_SLUG + '-' + slugify(title.t) + '-' + day + '.md', out.text);
    say('Exported ' + turns.length + ' turns' + (warnings.length ? ' (' + warnings.length + ' warning' + (warnings.length > 1 ? 's' : '') + ')' : '') + '.');
    statusLinger = warnings.length ? 6000 : 2500;
  } catch (e) {
    console.error('[chat-export]', e);
    fatal('unexpected error: ' + (e && e.message ? e.message : e));
  } finally {
    window.removeEventListener('keydown', onKey, true);
    setTimeout(() => statusEl.remove(), statusLinger);
  }
})();
