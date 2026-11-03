You are an expert JavaScript developer with deep knowledge of browser DOM APIs, bookmarklet constraints, CSP / Trusted Types, and Markdown (CommonMark + GFM) serialization.

## Task

Write a bookmarklet for current Chrome and Firefox on Windows that exports the **active conversation** on {{SERVICE_NAME}} as one UTF-8 Markdown file and downloads it.

Fill in ONE column before use:

| Placeholder          | Gemini                          | Claude                | ChatGPT                      |
|----------------------|---------------------------------|-----------------------|------------------------------|
| {{SERVICE_NAME}}     | Google Gemini                   | Claude                | ChatGPT                      |
| {{ASSISTANT_LABEL}}  | Gemini                          | Claude                | ChatGPT                      |
| {{SERVICE_SLUG}}     | gemini                          | claude                | chatgpt                      |
| {{HOSTNAMES}}        | gemini.google.com               | claude.ai             | chatgpt.com, chat.openai.com |
| {{TITLE_SUFFIX_RE}}  | `\s[-–—]\s(Google )?Gemini$`    | `\s[-–—]\s Claude$`   | (none: the title is the chat title) |

## 0. Epistemic honesty (read first)

You cannot see the live DOM and cannot run this code.
- Facts marked **VERIFIED** were observed by a DOM probe on 2026-10-31 (Chrome 156, Windows) on test chats of 3-14 turns. Everything marked **UNVERIFIED** is a hint. Even VERIFIED selectors may rot, so always implement fallback groups (class names rotate).
- Mark each selector group `// VERIFIED` or `// UNVERIFIED` in the code.
- Include a `CONFIG.DEBUG` mode that logs (console.groupCollapsed): which selector group matched, turn counts per role, the scroll container, the message region found for each turn, per-turn metadata sources and any candidates rejected, the hasH1 result, and same-role adjacencies.
- End your answer with (a) your assumptions, and (b) exactly which DOM snippets the user should paste back if something fails.
- Never state or imply the code has been tested.

## 1. Environment and constraints

- Runs from a `javascript:` bookmark in the page's main world. Use an **async** IIFE; leak no globals; guard re-entrancy; verify `location.hostname` matches {{HOSTNAMES}}, otherwise show a message and exit.
- **No network requests of any kind.** No external libraries, no injected `<script>`, no `eval`/`new Function`.
- **Trusted Types safe:** never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or `DOMParser` (VERIFIED: Gemini throws on `innerHTML`; Claude and ChatGPT do not, but code must work on all three). Build UI with `createElement` + `textContent`.
- No `navigator.clipboard`.
- **Delivery:** `Blob` (`text/markdown;charset=utf-8`) -> `URL.createObjectURL` -> `<a download>` appended to `document.body`, `.click()`, remove, then `URL.revokeObjectURL` after >= 10 s. UTF-8, LF, no BOM.
- **Status UI:** small non-blocking fixed-position element (`aria-live="polite"`) that removes itself when done; `alert()` only for fatal errors.
- **Zero turns found = failure:** do not download; show which selector groups failed.
- **Time formatting:** every time in the output uses the user's **local timezone** formatted `YYYY-MM-DD HH:MM:SS`. Build it from `getFullYear()/getMonth()+1/getDate()/getHours()/getMinutes()/getSeconds()`, zero-padded. Never use `toISOString()` or `toLocale*String()`.

## 2. Packaging

Deliver:
1. `chat-export.js`: unminified, well-commented, with a `CONFIG` object at top (`DEBUG`, `AUTOLOAD=true`, `LOAD_TIMEOUT_MS=90000`, selector groups). Write it minification-safe (explicit semicolons).
2. `make-bookmarklet.mjs`: Node >= 18 build script that minifies with `terser` (`npm i -D terser`), strips comments, applies **`encodeURIComponent` to the entire body exactly once**, prefixes `javascript:`, writes `bookmarklet.txt`, prints its length. Include the Windows PowerShell commands.
3. Do NOT hand-minify or hand-encode in your response, and do not present a "final bookmarklet string" as verified.

## 3. Turn discovery and completeness

- **Selectors:** ordered fallback groups yielding `{role, element}`. Prefer stable hooks (custom-element names, `data-testid`, role attributes) over utility/hashed classes; add a generic structural fallback last. See section 8 for per-service hints.
- **Role marker is not always the message body.** VERIFIED on ChatGPT: the role attribute sits on a screen-reader-only `h4`, not on the message. For such markers define the **message region** as the highest ancestor of the marker that contains exactly one role marker (stop climbing when the parent would contain two). VERIFIED: this yields the same two-level region for every user and assistant message sampled, and each `[data-turn-key]` wrapper contains exactly one user marker and one assistant marker. Convert the region's content, skipping the marker heading itself, buttons, and other chrome. Log each region in DEBUG, plus a warning if a region has no text.
- **Shadow DOM:** VERIFIED none of the three services uses open shadow roots. Still provide `deepQueryAll(root, selector)` that recurses through open shadow roots as a cheap safeguard. Closed roots are unreachable.
- **Scroll container:** nearest scrollable ancestor of the turn elements (`overflow-y` auto/scroll/overlay AND `scrollHeight > clientHeight`); do not assume `window` (VERIFIED: all three scroll an inner element). Fall back to `document.scrollingElement`.
- **Roles are not guaranteed to alternate** (VERIFIED on Claude: two consecutive assistant messages). Do not assume alternation and do not warn about it; log adjacencies only in DEBUG.
- **Loading (default on) must be cycle-based:**
  1. Jump (instant, not smooth) to the container's top; wait until the oldest turn key, turn count, and `scrollHeight` are unchanged for 5 consecutive checks at ~500 ms.
  2. Walk downward in ~0.8x viewport steps; convert each newly mounted turn to Markdown immediately and store it by stable key, preserving document order.
  3. **Repeat steps 1-2 until a complete up-and-down cycle discovers no new keys** (max 5 cycles or `LOAD_TIMEOUT_MS`). VERIFIED on ChatGPT: the mounted set shifts as you scroll (and older history loaded in chunks in one run: 8 -> 10 -> 12), so a single "scroll to top, wait, extract" pass is incomplete.
  4. Restore the original scroll position. Esc cancels; a cancelled/timed-out run exports what it has and records a warning.
- **Do not assume all turns are mounted at once.** VERIFIED: Claude uses a windowed virtual list (5-10 of 10 turns mounted at a time). VERIFIED: ChatGPT also windows its DOM (12 turns mounted at the top and at the bottom of the chat, but 14 distinct turns seen across the walk; its CSS refers to `data-virtualized-turn-content`). Gemini keeps every turn mounted (10/10; `content-visibility` classes), but harvest the same way for safety.
- **Stable turn keys** (dedupe across remounts): Claude = the UUID substring of the element `id` (the rest is a React-generated prefix that may change on remount); Gemini = `role + ':' + closest('.conversation-container').id`; ChatGPT = `role + ':' + closest('[data-turn-key]').getAttribute('data-turn-key')` (one UUID per user+assistant pair, VERIFIED); final fallback = role + hash of the first 200 chars of the message region's text (never hash the marker element alone: ChatGPT's marker text is identical for every turn).
- **Warnings (header):** first turn not from the user, loader timeout/cycle limit reached, cancellation, incomplete load. Not same-role adjacency.
- **Branches/retries:** export only the active/visible branch; warn if the UI shows alternates (e.g., "2/2").

## 4. Metadata (deliberately minimal)

Data model per turn: `{ role, key, markdown, time: Date|null }`. **Never invent values; unknown stays null.**

- **Per-turn model / thinking: not exported.** VERIFIED across three services and conversations whose responses came from different models (Gemini Pro -> Flash; ChatGPT May-2026 default -> Oct-2026 default; ChatGPT with Thinking on for the last response): the DOM exposes no per-turn model or thinking label, as an attribute, a short button/tooltip text, or an aria-label. Do not attempt to infer one. (Gemini's `.has-thoughts` / `thinking-overlay` marker is on every response and carries no information.) Do not export thinking panels or summaries if encountered.
- **Page-level model picker -> header `Selector model` only.** It reflects the model for the *next* message, not past turns, so never attach it to turns. VERIFIED sources:
  - Claude: `button[aria-label^="Model:"]`, visible text e.g. "Sonnet 4.6 High".
  - Gemini: `button[data-test-id="bard-mode-menu-button"]`, `aria-label` like "Open mode picker, currently Flash" (the visible label is in its `.picker-primary-text` span; it is a short label such as "Flash", not the full version string).
  - ChatGPT (free tier): no picker exists. Ignore the composer "Think" toggle (`aria-pressed`); it controls the next response.
  Omit the header line if the element isn't found.
- **Timestamps:** absolute only. VERIFIED on Claude: `time[datetime]` (ISO UTC, parseable) appears on only some assistant turns; emit when present, converted to local `YYYY-MM-DD HH:MM:SS`. Gemini and ChatGPT: none exist. Discard relative labels ("2 hours ago").

## 5. Markdown output

~~~markdown
# {{ASSISTANT_LABEL}} Export: <Chat Title>

- **Exported:** 2026-10-31 09:12:00
- **Source:** <location.href>
- **Selector model (at export time; may not apply to earlier turns):** <value; omit line if none>
- **Turns:** 24
- **Warnings:** <semicolon-separated; omit line if none>

---

**[User]**

*Time: 2026-10-31 09:10:12*

<content>

---

**[{{ASSISTANT_LABEL}}]**

*Time: 2026-10-31 09:10:40*

<content>
~~~

Rules:
- Exactly one H1 (the document title). The exporter emits **no other headings**: turn labels are the bold bracketed lines `**[User]**` and `**[{{ASSISTANT_LABEL}}]**`, never `#` headings.
- Every `---` has a blank line before and after. No trailing `---` after the last turn.
- Because `---` is the only turn delimiter, emit any horizontal rule from message content as `***`, never `---`.
- The italic `*Time: ...*` line (user and assistant turns alike) appears only when the turn's time is known; otherwise omit it and its blank line.
- **Title:** `document.title` with {{TITLE_SUFFIX_RE}} stripped (VERIFIED: Gemini "<title> - Google Gemini", Claude "<title> - Claude", ChatGPT has no suffix) -> active sidebar item / chat header text -> first user message truncated to 60 chars -> "Untitled conversation".
- **Filename:** `{{SERVICE_SLUG}}-<slug>-<YYYY-MM-DD local>.md`. Slug: lowercase, runs of non-alphanumerics -> `-`, trimmed, <= 60 chars; strip Windows-illegal characters (`<>:"/\|?*`, control chars), trailing dots/spaces, and reserved device names (CON, NUL, COM1, ...); fallback `untitled`.

## 6. Heading demotion (conditional; strict)

- Demote **if and only if** at least one H1 appears anywhere in the conversation. H1s that count: rendered `<h1>` in any turn, plus ATX `# ` lines in user text outside fenced code. Ignore screen-reader-only/hidden headings, UI chrome, and anything inside code or tables.
- **No H1 anywhere:** emit all headings at their original levels (H1-H6), unshifted.
- **At least one H1:** shift every heading in every turn down by exactly one level (H1->H2, H2->H3, H3->H4, H4->H5, H5->H6), uniformly across all turns. **Any existing H6 becomes a bold paragraph with no heading tag**: `**text**` on its own line with blank lines around it (strip any `**`/`__` already inside the heading text to avoid nested bold). Add a warning "N H6 heading(s) converted to bold".
- Decide from DOM elements, never by regex over finished Markdown (it would corrupt `# comment` lines in code). Because turns are harvested incrementally, represent headings as structured tokens (`{level, text}`) and resolve final levels only at assembly, after all turns have been seen.

## 7. DOM -> Markdown conversion

Recursive walker over child nodes (never flat `innerText`).

- **Skip (chrome/hidden):** `script, style, noscript, button`, toolbars, copy/share/feedback controls, `[hidden]`, `[aria-hidden="true"]`, suggestion chips, expand/collapse buttons, and all **screen-reader-only/visually-hidden elements** (class matching `sr-only|visually-hidden|cdk-visually-hidden`). VERIFIED sr-only content: ChatGPT `h4` "You said:" / "ChatGPT said:" (these are the role markers); Gemini `h5` in user turns (it **duplicates the user's query text** after "You said", so it must not be emitted) and `h6` "Gemini said"; Claude assistant `h3` (summary text) and user `span` "Message collapsed". They are neither emitted nor counted as headings.
- **Gemini chrome tags (VERIFIED present):** `message-actions, copy-button, thumb-up-button, thumb-down-button, model-response-disclaimers, election-info-disclaimer, finance-info-disclaimer, freemium-rag-disclaimer, sensitive-memories-banner`, and `[data-test-id="luminous-expand-button"]`.
- **Citations/source chips** (Gemini `source-footnote`, `sources-carousel-inline`, `source-inline-chip`, `sources-list`; ChatGPT `[data-testid="chatgpt-citation"]`): if they contain `<a href>`, emit as normal links; otherwise skip.
- **Inline/block:** paragraphs, `<br>`, strong, em, strikethrough, links `[text](absolute-url)`, ordered lists (honor `start`) and unordered lists with correct nested indentation, task-list checkboxes, nested blockquotes, `<hr>` (as `***`), `<details>/<summary>`.
- **ChatGPT lists/text (inferred from attribute names only):** the renderer exposes `data-d-marker-layout`, `data-d-list-item-content`, and per-word `data-d-stream-word` / `data-d-text-flow` spans. Take list structure from `ul/ol/li`, ignore separate marker nodes so numbers aren't duplicated, and concatenate adjacent word spans without inserting extra spaces beyond the text nodes' own whitespace.
- **Tables -> GFM pipe tables:** escape `|`, newlines in cells -> `<br>`; degrade to simplified text with a warning if not representable.
- **Math:** Gemini VERIFIED: TeX source is in the `data-math` attribute on every `.katex` node, so prefer it, falling back to `annotation[encoding="application/x-tex"]`. Claude VERIFIED: annotations present on all KaTeX nodes. ChatGPT: UNVERIFIED (its responses contain MathML `mi`/`mo`; whether a TeX annotation exists is unknown); fall back to any `annotation[encoding="application/x-tex"]`, else MathML text. Emit `$...$` inline and `$$...$$` display (display if inside `.katex-display` or a block-math container).
- **Code blocks:** take text **only** from the `<code>` element. VERIFIED Claude: `pre.code-block__code > code.language-<lang>` (language from the class; a label also appears in a sibling div; the copy button's text is a private-use icon glyph U+E056, so never read the wrapper's text). VERIFIED Gemini: `.code-block-decoration` holds the label (e.g. "Python"), `pre > code.code-container` holds the code. For both, `textContent` preserves newlines. ChatGPT assistant code blocks: `pre` elements exist but their internals are UNVERIFIED; if the editor renders per-line elements without newline characters (e.g., `.cm-line`), join with `\n`. Preserve whitespace exactly; trim one trailing newline.
- **Fences:** length = max(3, longest backtick run in content + 1). Inline code: delimiter longer than the longest backtick run, space-padded if content starts/ends with a backtick.
- **Text nodes (assistant turns):** collapse whitespace per HTML rules outside `pre`; escape Markdown-significant characters only where they would create syntax (line-leading `#`, `>`, `-`, `+`, `N.`; `*`, `_`, backtick, `[`, `]`, `<`, backslash; `|` in tables).
- **User turns:** run the same walker, but text inside elements whose computed `white-space` starts with `pre` is emitted verbatim with line breaks and **not escaped** (VERIFIED: Claude `p`/`code` are `pre-wrap`). ChatGPT user text sits in `white-space: nowrap` spans (VERIFIED) inside a `pre-wrap` container, so apply the rule to the nearest ancestor with a non-`normal` white-space, and take line breaks from `\n` in text nodes and `<br>`. Gemini user text is rendered as `p`/`li` blocks (`white-space: normal`), so it goes through the normal converter.
- **Images:** emit `![alt](src)` only for `http(s)` sources; for `blob:`/`data:` sources emit `[Image: <alt or "image">]` (they will not resolve later). VERIFIED: Gemini turns contain images (uploads). Attachments -> `[Attachment: filename]`.
- **Cleanup:** collapse 3+ blank lines to 2 outside code fences; strip trailing spaces except intentional hard breaks.

## 8. Service notes

**Gemini**
- VERIFIED (two chats, 4 and 5 pairs): turns are `user-query` / `model-response` (strictly alternating), each pair inside `div.conversation-container` whose `id` is unique per pair. User text: `.query-text` inside `user-query` (`.collapsed` class with an expand button). Assistant content: `message-content` inside `structured-content-container`; the rendered markdown root is a `.markdown` element.
- VERIFIED: scroll container `infinite-scroller.chat-history` (`overflow-y: scroll`). All turns stayed mounted at every scroll position (10/10), and no older-history loading occurred in a 5-pair chat; keep the cycle-based loader anyway.
- VERIFIED: Trusted Types enforced. Model picker: see section 4.
- Sidebar active item is under `a.gem-nav-list-item`.

**Claude**
- VERIFIED: user `[data-testid="user-message"]`, assistant `[data-testid="assistant-message"]`, both inside `[data-testid="transcript-row"]`. Message `id` = React prefix + UUID; assistant elements also carry `data-turn-key`.
- VERIFIED: virtual list (`[data-testid="transcript-list"]`, `transcript-sizer`, `transcript-spacer`) inside a scrollable `div.overflow-y-auto`; windowed DOM, so incremental harvest is required.
- VERIFIED: model picker (section 4); `time[datetime]` on some assistant turns; header testids `chat-header`, `chat-title-split` exist.
- UNVERIFIED: artifacts (side panel; emit `[Artifact: title]`), tool/web-search rows.

**ChatGPT**
- VERIFIED ABSENT (do not rely on): `[data-message-author-role]`, `article[data-testid^="conversation-turn-"]`, any per-message model attribute.
- VERIFIED: role markers are `[data-conversation-role="user"|"assistant"]` on screen-reader-only `h4` elements (text "You said:" / "ChatGPT said:"); use the message-region rule in section 3. `[data-turn-key]` (UUID) wraps one user+assistant pair.
- VERIFIED body anchors inside each region (exactly one each in every sampled region): user `[data-user-message-bubble]`; assistant `[data-markdown-text-style]` and `[data-chatgpt-selection-message-id]` (UUID; per-message id). Use them to sanity-check a region in DEBUG; convert the whole region minus chrome, since code blocks and tables may sit outside the anchor element.
- VERIFIED: scroll container `div.thread-scroll-container` (`overflow-y: auto`, scrollable); DOM windowed (section 3). `document.title` is the chat title with no suffix. Citations: `[data-testid="chatgpt-citation"]`.
- Assistant regions contain `pre` elements (VERIFIED present) and `table` elements (VERIFIED present), but their internal structure (code header/label, per-line elements, table wrappers) and ChatGPT's math markup are UNVERIFIED. Use the generic rules in section 7 (text from `<code>` only; join per-line elements with `\n`; GFM tables; MathML/annotation fallbacks) and log what you find in DEBUG.

## 9. Deliverables, in this order

1. Approach summary (<= 6 lines).
2. `chat-export.js` in this structure:
   ~~~javascript
   (async () => {
     // 0. CONFIG, hostname + re-entrancy guards, status UI, fmtLocal()
     // 1. Selector groups + deepQueryAll + message-region resolver
     // 2. Scroll-container detection, cycle-based loader, incremental harvest (stable keys)
     // 3. Metadata: time per turn, selector model for the header
     // 4. DOM -> Markdown converter (headings emitted as level tokens)
     // 5. Heading pass: hasH1 ? shift +1 (H6 -> bold) : unchanged
     // 6. Header + turn assembly (bold bracket labels, --- separators), warnings
     // 7. Blob download, cleanup, status teardown
   })();
   ~~~
3. `make-bookmarklet.mjs` + PowerShell commands.
4. Unverified assumptions + which DOM snippets to paste back.
5. Manual test checklist: long chat that lazy-loads (ChatGPT) and one with a windowed list (Claude); code containing ``` ; table; math; heading cases (no H1 / H1 in one turn / H6 present); consecutive assistant messages; images; Firefox download.
