# modalmodules

Heuristic modal/popup/banner removal for HTML — usable as a Node library, a
browser script, or a self-hosted HTTP API that any language can call.

- **Server-side HTML** (scrapers, archivers, proxies) → strips modal markup from
  the HTML string and returns cleaned HTML.
- **Live browser DOM** → mutates the page in place to remove popups.
- **HTTP API** → drop-in service for Python/JS/anything that speaks HTTP.

Detection is rule-based (JSON), not per-site. Adding a new detector is one new
file; adding a new pattern is one new line in a JSON file.

For end-user usage docs with examples for every endpoint, open
[`docs.html`](docs.html) in a browser.

---

## Quick start

```bash
npm install
npm test     # 11 tests
npm start    # HTTP server on http://127.0.0.1:8787
```

Hit it:

```bash
curl -X POST http://127.0.0.1:8787/v1/clean \
  -d '<html><body><main>Article</main><div role="dialog" aria-modal="true">x</div></body></html>'
```

Response:

```json
{
  "html": "<html><head></head><body><main>Article</main></body></html>",
  "removed": [{ "selector": "div", "score": 1.5, "definitive": true, "signals": [...] }],
  "ms": 14
}
```

---

## Architecture

Four conceptual layers, each swappable independently:

```
HTTP API  →  Service  →  Repository (rules)
                      →  DetectionEngine  →  Detectors
                      →  NodeAdapter      →  CheerioAdapter | DOMAdapter
```

- **Detectors** are pure functions of `(node, config)` that return
  `{matched, confidence, reason, definitive?}`. They never see cheerio or the
  DOM directly.
- **Adapters** implement a single `NodeAdapter` shape so the same detector runs
  on server-side HTML *and* in a live browser.
- **Repository** sources the rule config. The default loads
  [`spec/rules.default.json`](spec/rules.default.json); swap for DB/HTTP/
  per-tenant without touching anything else.
- **Service** is the only thing the HTTP layer or library callers talk to.

Full architecture diagram in [`docs.html`](docs.html).

---

## Project structure

```
ModalModules/
├── spec/
│   ├── rules.schema.json          JSON Schema for rule config files
│   ├── rules.default.json         Bundled detection rules (patterns, vendors, autoAccept buttons, cleanup)
│   ├── user-preferences.schema.json
│   ├── user-preferences.json      End-user "what to do" prefs (popups/cookies/authModals)
│   └── fixtures/*.html            Shared test HTML (Python port will reuse)
├── src/
│   ├── core/
│   │   ├── NodeAdapter.js         Adapter contract (JSDoc only)
│   │   ├── DetectionEngine.js     Scores detectors, decides
│   │   └── detectors/
│   │       ├── index.js           Registry + "how to add one" guide
│   │       ├── ariaDialog.js
│   │       ├── classNamePattern.js
│   │       ├── fullViewportOverlay.js
│   │       └── selectorMatch.js   Vendor-specific signatures (OneTrust, Cookiebot, …)
│   ├── adapters/
│   │   ├── CheerioAdapter.js      Server-side HTML
│   │   └── DOMAdapter.js          Live browser DOM
│   ├── repositories/
│   │   ├── RuleRepository.js      Interface
│   │   ├── DefaultRuleRepository.js
│   │   └── JsonFileRuleRepository.js
│   ├── services/
│   │   └── ModalRemovalService.js Orchestrates repo + engine + adapter + cleanup
│   ├── server/
│   │   ├── HttpServer.js          HTTP service (CORS, auth, body limits, request log)
│   │   └── autoAcceptUrl.js       Playwright orchestrator (optional peer dep)
│   ├── api/
│   │   ├── server.js              removeModalsFromHTML(html, opts)
│   │   └── browser.js             removeModals(document, { rules, autoAccept?, watch?, log? })
│   ├── util/
│   │   └── logger.js              Logger factory (bool / function / {output} forms)
│   └── index.js
├── bin/
│   └── modalmodules.js            `serve` CLI (--quiet / --verbose)
├── test/
│   ├── smoke.test.js              Server-side library tests
│   ├── http.test.js               HTTP-layer tests
│   ├── watch.test.js              Browser API + watch mode + autoAccept (jsdom)
│   ├── log.test.js                Logger output assertions
│   ├── preferences.test.js        Preferences filter + decline mode + auth detection
│   └── auto-accept-url.test.js    /v1/auto-accept-url validation + missing-Playwright path
├── docs.html                      End-user usage docs (single-file)
├── README.md                      This file
└── package.json
```

---

## Library usage (Node)

```js
import { removeModalsFromHTML } from 'modalmodules/server';

const { html, removed } = await removeModalsFromHTML(rawHtml);
// removed[] = [{ selector, score, definitive, signals: [{id, reason, confidence}] }]
```

With a custom rules file:

```js
const { html, removed } = await removeModalsFromHTML(rawHtml, {
  rulesPath: './my-rules.json',
});
```

With a custom repository (DB, HTTP, per-tenant overrides):

```js
import { ModalRemovalService, createCheerioAdapter } from 'modalmodules';

const service = new ModalRemovalService({
  ruleRepository: { async getRules() { return await loadFromDB(tenantId); } },
  adapterFactory: createCheerioAdapter,
});
const { removed, output } = await service.run(rawHtml);
```

---

## Browser usage

```js
import { removeModals } from 'modalmodules/browser';
import rules from 'modalmodules/spec/rules.default.json';

// One-shot: strip popups that are in the DOM right now.
await removeModals(document, { rules });

// Watch mode: also catch popups injected after the initial pass — delayed
// (setTimeout), scroll-triggered, exit-intent, SPA route changes. Uses a
// MutationObserver under the hood. Returns a handle with .stop().
const handle = await removeModals(document, {
  rules,
  watch: true,
  onRemove: (entry) => console.log('killed', entry.selector),
});
// later:
handle.stop();
```

Vite/Webpack/Rollup all support JSON imports natively.

---

## HTTP API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{status:"ok"}` |
| `POST` | `/v1/clean` | raw HTML | `{html, removed[], cleanup[], ms}` |
| `POST` | `/v1/clean?format=html` | raw HTML | raw HTML + `x-modals-removed`, `x-cleanup-actions`, `x-elapsed-ms` headers |
| `POST` | `/v1/clean-url` | `{"url": "..."}` | `{html, removed[], cleanup[], sourceUrl, ms}` |
| `POST` | `/v1/auto-accept-url` | `{"url": "...", "cookies"?: "accept\|decline", "waitMs"?: 1500}` | `{html, clicked[], removed[], cleanup[], sourceUrl, renderMs, ms}` — *requires Playwright peer dep* |

**Per-request preference overrides** (any `/v1/*` POST):

```bash
curl -X POST 'http://localhost:8787/v1/clean?popups=ignore&cookies=decline&authModals=ignore' -d '...'
```

Query params: `popups` (`remove`|`ignore`), `cookies` (`accept`|`decline`|`remove`|`ignore`),
`authModals` (`remove`|`ignore`), `format` (`html`).

**Each `removed[]` entry** includes: `selector`, `category` (`cookie`|`auth`|`newsletter`|`paywall`|`generic`),
`kind` (human label), `vendor` (e.g. `"OneTrust"` or `null`), `score`, `definitive`, `preview`
(first ~60 chars of text), `signals[]` (per-detector breakdown).

**Each `cleanup[]` entry** has: `action` (`unlock-class`|`unlock-style`|`remove-orphan`|`inject-style`),
`node` (selector path), `value` (class name, style prop, or selector that matched).

CLI:

```bash
npm start                                  # default 127.0.0.1:8787
npm start -- --port 9000 --host 0.0.0.0
MODALMODULES_API_KEY=secret npm start      # require Bearer token on /v1/*
```

Full client examples (Python `requests`, browser `fetch`, Node `fetch`) are in
[`docs.html`](docs.html).

---

## User preferences

End-user control over *what to do* when each modal category is detected.
Stored in [`spec/user-preferences.json`](spec/user-preferences.json) (separate
from `rules.default.json` which describes *how to detect*).

```json
{
  "version": 1,
  "popups":     "remove",    // "remove" | "ignore"
  "cookies":    "accept",    // "accept" | "decline" | "remove" | "ignore"
  "authModals": "remove"     // "remove" | "ignore"
}
```

| Category | What it covers | Pref values |
|---|---|---|
| `popups` | Newsletter signups, exit-intent overlays, paywalls, generic modals | `remove`, `ignore` |
| `cookies` | OneTrust/Cookiebot/Didomi/+17 vendors, generic `cookie-banner` | `accept`, `decline`, `remove`, `ignore` |
| `authModals` | Login, signup, registration, "Create Account" dialogs (incl. ARIA dialogs whose text mentions "Create Account" / "Sign in" / "Register") | `remove`, `ignore` |

**Cookie modes** — `accept` and `decline` click the site's button (browser
only — needs JS); `remove` strips the banner without recording consent (works
server-side, but banner reappears next visit); `ignore` leaves it alone.

**HTTP server** — edit `spec/user-preferences.json` (read at startup) or pass
a custom path:

```bash
npm start -- --preferences /path/to/my-prefs.json
# Per-request override via query params:
curl -X POST 'http://localhost:8787/v1/clean?popups=ignore&cookies=decline&authModals=ignore' -d '...'
```

**Library API:**

```js
await removeModalsFromHTML(html, {
  preferences: { popups: 'ignore', cookies: 'decline', authModals: 'remove' },
});
// or load from file:
await removeModalsFromHTML(html, { preferencesPath: './my-prefs.json' });
```

**Browser API:**

```js
import preferences from 'modalmodules/spec/user-preferences.json';
await removeModals(document, { rules, preferences });
```

Each `removed[]` entry now includes `category`, `kind`, and `vendor` fields so
downstream code can filter or report by type.

## Configuration

All detection behavior lives in [`spec/rules.default.json`](spec/rules.default.json).
Schema in [`spec/rules.schema.json`](spec/rules.schema.json).

| You want to… | Edit |
|---|---|
| Catch a new popup pattern | Add `{"pattern": "qr[-_]?prompt", "confidence": 0.9}` to `class-name-pattern.patterns` |
| Be more aggressive | Lower `decision.minScore` from `1.0` to `0.7` |
| Be more conservative | Raise it to `1.4` |
| Catch lower-z-index overlays | Lower `full-viewport-overlay.config.minZIndex` |
| Disable a detector | Set its `enabled: false` |
| Never remove a specific element | Add a CSS selector to `preserve.selectors` |

Changes apply on next call — no rebuild.

### Scoring

For each candidate node, every enabled detector returns
`{matched, confidence, definitive?}`. Score is `Σ(weight × confidence)` across
matched detectors. If score ≥ `decision.minScore` the node is removed. Any
detector returning `definitive: true` bypasses the score.

---

## Adding a detector

Three steps when JSON config isn't expressive enough.

**1. Create the detector** — `src/core/detectors/myDetector.js`:

```js
export const myDetector = {
  id: 'my-detector',
  detect(node, config) {
    // node implements NodeAdapter: getTag, getAttr, getClasses, getStyle,
    // matches, getAncestors. Same shape for cheerio and DOM.
    if (/* ... */) {
      return { matched: true, confidence: 0.8, reason: 'why it matched' };
    }
    return { matched: false };
  },
};
```

**2. Register it** in `src/core/detectors/index.js`:

```js
import { myDetector } from './myDetector.js';
export const detectorRegistry = {
  // ...existing...
  [myDetector.id]: myDetector,
};
```

**3. Enable it in `spec/rules.default.json`** (or your own rules JSON):

```json
{ "id": "my-detector", "enabled": true, "weight": 1.0, "config": { ... } }
```

---

## Logging

Two surfaces, independent of each other.

**HTTP server** — three modes via CLI flags or env vars:

| Mode | Flag | Output |
|---|---|---|
| summary *(default)* | — | One line per request: `POST /v1/clean → 200 removed=1 cleanup=4 (45ms)` |
| verbose | `--verbose` / `MODALMODULES_VERBOSE=1` | All per-action library logs (every removal with vendor/preview, every cleanup action, every cookie accept) PLUS the summary line |
| quiet | `--quiet` / `MODALMODULES_QUIET=1` | Nothing per-request |

Verbose example:

```bash
npm start -- --verbose
```
```
[modalmodules] → POST /v1/clean
[modalmodules] scanning 5 candidate elements against 4 detectors
[modalmodules] removed cookie banner (OneTrust): <div#onetrust-banner-sdk> — "We use cookies to improve…"
[modalmodules] removed newsletter popup (class-name-pattern, score 1.08): <div.newsletter-popup> — "Subscribe for 10% off"
[modalmodules] running post-removal cleanup (scroll unlock + orphan sweep + style inject)
[modalmodules] unlocked body: removed class "modal-open"
[modalmodules] swept orphan element: <div.fancybox-overlay>
[modalmodules] injected backup <style> into <head> (scroll-unlock)
[modalmodules] done in 38ms — removed 2, cleanup 3
[modalmodules] POST /v1/clean → 200 removed=2 cleanup=3 (45ms)
```

Health checks and CORS preflights are filtered out in all modes.

**Library API** — opt-in via `log` option. Three call shapes:

```js
// Default console output (rich, per-action)
await removeModalsFromHTML(html, { log: true });
// [modalmodules] scanning 5 candidate elements against 4 detectors
// [modalmodules] removed dialog (ARIA) (aria-dialog, definitive): <div> — "Subscribe! Sign up for a 10% discount"
// [modalmodules] removed cookie banner (OneTrust): <div#onetrust-banner-sdk> — "We use cookies to improve…"
// [modalmodules] removed newsletter popup (class-name-pattern, score 1.08): <div.newsletter-popup-overlay> — "Get our digest"
// [modalmodules] running post-removal cleanup (scroll unlock + orphan sweep + style inject)
// [modalmodules] unlocked body: removed class "modal-open"
// [modalmodules] unlocked body: removed inline style "overflow"
// [modalmodules] swept orphan element: <div.fancybox-overlay>
// [modalmodules] injected backup <style> into <head> (scroll-unlock)
// [modalmodules] done in 45ms — removed 3, cleanup 4

// Custom sink — Datadog/Sentry/Pino/whatever
await removeModalsFromHTML(html, {
  log: (event) => myLogger.info(event),
  //  event = { level, message, details, ts }
});

// Custom prefix + output
await removeModalsFromHTML(html, {
  log: { prefix: '[scraper-job-42]', output: (e) => writeStream.write(...) },
});
```

Same `log` option in the browser API. autoAccept clicks log as `accepted X
cookies (selector)`, watch mode logs observer start/stop.

## Development

```bash
npm install
npm test                          # node --test, no extra framework
npm start                         # run the HTTP server
node bin/modalmodules.js serve    # same, direct
```

Tests live in `test/*.test.js` and use the built-in `node:test` runner. Add new
tests by creating another `*.test.js` file there — the glob in `package.json`
picks them up.

### Adding test fixtures

Drop HTML files into [`spec/fixtures/`](spec/fixtures/). Both the Node tests
and the future Python port read from this folder, so a fixture added here keeps
both implementations honest.

---

## Delayed / scroll-triggered popups

Two patterns, two solutions.

**Case A — popup is in the HTML at load, hidden until triggered.** Handled by
default. Detectors match on `role` / class / selector, not visibility, so
hidden popups (`display:none`, `hidden` attr, `visibility:hidden`) are stripped
before they could be revealed. Locked in by the `hidden-modal.html` fixture
test.

**Case B — popup is injected by JS at trigger time.**

- *Browser:* pass `watch: true` to `removeModals`. A `MutationObserver`
  catches popups added to the DOM in real time (delayed, scroll-triggered,
  exit-intent, SPA route changes).
- *Server:* the calling project should render the page first
  (Playwright/Puppeteer) so the JS fires, then POST the rendered HTML to
  `/v1/clean`. Full recipe in [`docs.html`](docs.html) under
  *Delayed / scroll-triggered popups*.

## Auto-accept cookies (browser library)

Instead of *removing* the cookie modal, click the site's own Accept button.
The site's close handler then runs, which is strictly cleaner: scroll lock is
released by the site itself, the consent state is persisted, analytics that
gates on consent works normally.

```js
import { removeModals } from 'modalmodules/browser';
import rules from 'modalmodules/spec/rules.default.json';

const { clicked, removed } = await removeModals(document, {
  rules,
  autoAccept: true,
});
// clicked = [{ vendor: 'OneTrust', selector: '...' }, ...]
```

Knows the Accept buttons for: OneTrust, Cookiebot, Didomi, Usercentrics,
Quantcast, TrustArc, Osano, CookieYes, Iubenda, HubSpot, CookieHub, Cookie
Information, Tealium, Borlabs, Klaro, Sourcepoint, Termly. Add more by
appending to `autoAccept.buttonSelectors` in
[`spec/rules.default.json`](spec/rules.default.json).

**Text-based fallback** — when no vendor selector matches, scans button text
(`textContent`, `value`, `aria-label`) inside cookie/consent containers and
clicks any whose visible text matches one of: `Accept all`, `Accept`,
`Allow all`, `I agree`, `Got it`, `OK`, plus multi-language variants in
Spanish, French, German, Italian, Portuguese, Dutch, Polish, Russian.
Guarded by a deny-word list so "Reject all", "Decline", "Manage settings",
"Necessary only" etc. are never clicked. Scope-limited to cookie containers
so unrelated "Accept terms" buttons on checkout pages aren't touched.

**Removal vs auto-accept semantics** — plain `removeModals` without
`autoAccept` leaves the user un-consented (modal disappears, no choice
recorded, banner reappears next visit). `autoAccept: true` clicks the site's
own Accept button — consent is stored synchronously in localStorage/cookies
before our cleanup pass runs, so the consent record is safe. Use `autoAccept`
for cookie/GDPR modals; use plain removal for newsletter/popup nags with no
consent semantics.

**HTTP API users:** clicking requires JS, which the `/v1/clean` endpoint
doesn't run. Render the page client-side with Playwright, click consent
buttons, then send the snapshot to `/v1/clean` — full Python and Node recipes
in [`docs.html`](docs.html) under *Auto-accept cookies*.

## Scroll lock + orphan cleanup

Removing a modal node alone often isn't enough — sites lock body scroll
(`body.modal-open`, `body { overflow: hidden }`) and ship separate backdrop
nodes (`.modal-backdrop`, `.ReactModal__Overlay`, …) that survive as siblings.

A **cleanup phase** runs automatically *after* main removal (and only when at
least one modal was actually removed, so pages with unrelated `modal-open`
classes aren't broken). It:

- Strips known lock classes from `html`/`body` (`modal-open`, `no-scroll`,
  `ReactModal__Body--open`, `swal2-shown`, `fancybox-lock`, etc.).
- Strips inline lock styles (`overflow`, `position`, `top`, `padding-right`,
  `touch-action`).
- Sweeps orphan backdrop selectors (`.modal-backdrop`, `.fancybox-overlay`,
  `.mfp-bg`, `.ReactModal__Overlay`, `#CybotCookiebotDialogBodyUnderlay`, …).
- Injects `<style data-modalmodules-unlock>html,body{overflow-y:auto!important;}</style>`
  into `<head>` as a last-resort scroll restorer. Wins over `<style>body{overflow:hidden}</style>`
  rules that can't be reached by class/inline stripping. Default ON; disable
  with `cleanup.injectScrollUnlock: false`.

The HTTP response now includes a `cleanup[]` log alongside `removed[]`. The
`?format=html` mode adds an `x-cleanup-actions` response header.

Extend both lists by editing the `cleanup` block in
[`spec/rules.default.json`](spec/rules.default.json) — no code change.

## Cookie vendor coverage

Beyond generic `cookie-banner` / `consent` regex, the `selector-match`
detector handles the major consent vendors by their well-known IDs and class
signatures: OneTrust, Cookiebot, Didomi, Usercentrics, Quantcast Choice,
TrustArc, Osano, CookieYes, Iubenda, Termly, HubSpot, Klaro, Sourcepoint,
Tealium, CookieHub, Cookie Information, Borlabs. Full list and per-vendor
signatures in [`docs.html`](docs.html).

Add a new vendor by appending one entry to `selector-match.config.selectors`
in [`spec/rules.default.json`](spec/rules.default.json) — no code change.

## `/v1/auto-accept-url` — for JS-rendered and anti-bot sites

The `/v1/clean` and `/v1/clean-url` endpoints don't execute JavaScript, so
they can't see popups that are injected at runtime (BBC, NYT, Medium, …) and
can't bypass sophisticated anti-bot fetches (Reuters, Tripadvisor, …).

`/v1/auto-accept-url` launches headless Chromium via Playwright, navigates,
clicks the cookie Accept (or Decline) button using the same vendor selectors
as the browser library, then runs the rendered HTML through the normal cleaner.

```bash
curl -X POST http://127.0.0.1:8787/v1/auto-accept-url \
  -H 'content-type: application/json' \
  -d '{"url": "https://www.bbc.com", "cookies": "accept", "waitMs": 2000}'
```

Returns `{ html, clicked[], removed[], cleanup[], sourceUrl, renderMs, ms }`.

**Playwright is an optional peer dependency** — install only if you need this
endpoint:

```bash
npm install playwright
npx playwright install chromium     # ~150 MB Chromium download
```

Without it, the endpoint returns a 501 with the exact install command above.

## Real-world coverage (28-site diagnostic)

Tested with `/v1/clean-url` against a list of major media/news/recipe/travel
sites. Results break into three buckets — the categorization matters more
than the count, because "didn't work" usually means **the static HTML doesn't
contain a popup**, not that detection failed.

| Bucket | Count | Examples | Fix |
|---|---|---|---|
| ✓ Cleaner caught the popup | 13 | cnn, theverge, techcrunch, arstechnica, wired, sportingnews, rottentomatoes, variety, bonappetit, allrecipes, scientificamerican | Works as-is |
| ○ Static HTML has no popup (JS-injected on page load) | 10 | bbc, npr, apnews, theguardian, nytimes, washingtonpost, nature, sciencedaily, lonelyplanet, medium | Use the **Playwright recipe** in [`docs.html`](docs.html) to render the page first, then post the rendered HTML to `/v1/clean` |
| ✗ Site blocks the fetch with 401/403/500 | 5 | reuters, espn, bleacherreport, tripadvisor, quora, seriouseats | Site refuses any non-browser request. Need to fetch client-side and post HTML to `/v1/clean` |

A realistic Chrome User-Agent + Accept headers are now sent on `/v1/clean-url`
fetches — this unlocked arstechnica.com and medium.com that previously 403-ed.

Run the diagnostic yourself: `node scripts/diagnose-real-sites.mjs` (server
must be running). Edit the URL list inside the script to test your own targets.

## Known limits

- **HTTP `/v1/clean` doesn't run JavaScript.** Sites that inject popups via JS
  need either (a) the browser library with `watch: true` + `autoAccept: true`,
  or (b) client-side rendering with Playwright before posting to `/v1/clean`
  (recipe in [`docs.html`](docs.html)). Server-side `/v1/auto-accept-url` with
  optional Playwright peer-dep is on the roadmap.
- **Server-side `full-viewport-overlay` is weaker than browser.** Cheerio has
  no computed styles, so this detector only catches modals with inline
  `style="position:fixed;z-index:..."`. ARIA, class-name, and selector-match
  detectors work identically in both adapters.
- **Watch mode catches additions, not attribute mutations.** A pre-existing
  node that *becomes* a popup later (e.g. `className` swapped to add `modal`)
  is not re-evaluated. Watching `childList` only — by design, since attribute
  observation would re-evaluate every visible node on every attribute write.
- **JS-installed scroll-lock event listeners** (e.g. `addEventListener('wheel',
  preventDefault)`) can't be removed via DOM mutation. The injected
  `overflow-y: auto !important` <style> tag wins over most stylesheet locks,
  but won't override an active JS listener.
- **Plain `removeModals` (no `autoAccept`) leaves the user un-consented.**
  Modal disappears but no choice is recorded — the banner reappears next visit
  and consent-gated analytics stays off. Use `autoAccept: true` for cookie
  modals; plain removal for newsletter/popup nags.
- **Heuristic, not exhaustive.** Novel popups will be missed; rare false
  positives are possible. The `removed[]` report and `preserve.selectors` list
  exist so callers can audit and override.

---

## Before public deployment

Two intentionally permissive defaults to lock down:

1. **SSRF on `/v1/clean-url`.** Currently rejects non-http(s) but doesn't block
   loopback / RFC1918 / link-local IPs. Add a DNS lookup + IP filter — see the
   marker comment in [`src/server/HttpServer.js`](src/server/HttpServer.js).
2. **CORS allowlist.** Default is `Access-Control-Allow-Origin: *`. Replace
   with your customer origins in `applyCors()`.

Already in place: 10 MB body cap, 15s upstream fetch timeout, protocol
allowlist, optional Bearer auth via `MODALMODULES_API_KEY`.

---

## Roadmap

- Python port (BeautifulSoup adapter), reusing `spec/rules.*.json` and
  `spec/fixtures/`.
- CLI `clean` subcommand for stdin/stdout piping
  (`modalmodules clean < in.html > out.html`).
- `MergingRuleRepository(base, overlay)` so users can ship a tiny JSON with
  just additions instead of copying the whole defaults file.
- SSRF guards on `/v1/clean-url` and `/v1/auto-accept-url` (DNS lookup +
  private-IP rejection).

---

## License

MIT-style. See `package.json`.
