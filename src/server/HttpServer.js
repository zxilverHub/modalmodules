import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { removeModalsFromHTML } from '../api/server.js';
import { autoAcceptUrl, isPlaywrightMissing } from './autoAcceptUrl.js';
import { createLogger } from '../util/logger.js';

const MAX_BODY = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 15_000;

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PREFERENCES_PATH = resolve(here, '../../spec/user-preferences.json');

const VALID_POPUPS = new Set(['remove', 'ignore']);
const VALID_COOKIES = new Set(['accept', 'decline', 'remove', 'ignore']);
const VALID_AUTH = new Set(['remove', 'ignore']);

// Per-request query params override the server-level defaults. Caller can
// pass ?popups=ignore or ?cookies=remove to tweak behavior for one call
// without restarting the server.
function applyQueryOverrides(basePrefs, urlObj) {
  const popups = urlObj.searchParams.get('popups');
  const cookies = urlObj.searchParams.get('cookies');
  const auth = urlObj.searchParams.get('authModals') || urlObj.searchParams.get('auth');
  if (!popups && !cookies && !auth) return basePrefs;
  const out = { ...(basePrefs || {}) };
  if (popups && VALID_POPUPS.has(popups))   out.popups = popups;
  if (cookies && VALID_COOKIES.has(cookies)) out.cookies = cookies;
  if (auth && VALID_AUTH.has(auth))         out.authModals = auth;
  return out;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw httpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-max-age', '86400');
}

function checkAuth(req) {
  const required = process.env.MODALMODULES_API_KEY;
  if (!required) return;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== required) throw httpError(401, 'unauthorized');
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function fetchURL(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw httpError(400, 'invalid url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(400, 'only http/https URLs allowed');
  }
  // Before public deployment: add DNS resolution + private-IP rejection to
  // prevent SSRF against internal services (loopback, link-local, RFC1918).
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Browser-shaped headers — many sites 403/401 on bot-flavored User-Agents.
    // We're a legitimate cleaner-on-behalf-of-the-user, not a scraper, but
    // upstream sites can't tell the difference; a realistic UA gets through.
    const r = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'cache-control': 'no-cache',
      },
    });
    if (!r.ok) throw httpError(502, `upstream returned ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > MAX_BODY) throw httpError(413, 'upstream response too large');
    const text = await r.text();
    if (text.length > MAX_BODY) throw httpError(413, 'upstream response too large');
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function handle(req, res, summary, verbose, basePrefs) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { status: 'ok' });
  }

  checkAuth(req);

  if (req.method === 'POST' && url.pathname === '/v1/clean') {
    const html = await readBody(req);
    const started = Date.now();
    const preferences = applyQueryOverrides(basePrefs, url);
    const { html: out, removed, cleanup } = await removeModalsFromHTML(html, {
      log: verbose,
      preferences,
    });
    const ms = Date.now() - started;
    summary.removed = removed.length;
    summary.cleanup = cleanup?.length || 0;
    if (url.searchParams.get('format') === 'html') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('x-modals-removed', String(removed.length));
      res.setHeader('x-cleanup-actions', String(cleanup?.length || 0));
      res.setHeader('x-elapsed-ms', String(ms));
      return res.end(out);
    }
    return json(res, 200, { html: out, removed, cleanup, ms });
  }

  if (req.method === 'POST' && url.pathname === '/v1/clean-url') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { throw httpError(400, 'invalid JSON'); }
    if (!payload?.url) throw httpError(400, 'missing url');
    if (verbose) console.log(`[modalmodules] fetching ${payload.url}`);
    const fetched = await fetchURL(payload.url);
    if (verbose) console.log(`[modalmodules] fetched ${fetched.length} bytes`);
    const started = Date.now();
    const preferences = applyQueryOverrides(basePrefs, url);
    const { html: out, removed, cleanup } = await removeModalsFromHTML(fetched, {
      log: verbose,
      preferences,
    });
    const ms = Date.now() - started;
    summary.removed = removed.length;
    summary.cleanup = cleanup?.length || 0;
    return json(res, 200, { html: out, removed, cleanup, sourceUrl: payload.url, ms });
  }

  if (req.method === 'POST' && url.pathname === '/v1/auto-accept-url') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { throw httpError(400, 'invalid JSON'); }
    if (!payload?.url) throw httpError(400, 'missing url');
    let parsedUrl;
    try { parsedUrl = new URL(payload.url); } catch { throw httpError(400, 'invalid url'); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw httpError(400, 'only http/https URLs allowed');
    }

    const started = Date.now();
    const preferences = applyQueryOverrides(basePrefs, url);
    const reqLogger = verbose ? createLogger(true) : null;

    let rendered;
    try {
      rendered = await autoAcceptUrl(payload.url, {
        cookies: payload.cookies,
        waitMs: payload.waitMs,
        navTimeoutMs: payload.navTimeoutMs,
        logger: reqLogger,
      });
    } catch (err) {
      if (isPlaywrightMissing(err)) {
        throw httpError(501,
          'Playwright is required for /v1/auto-accept-url but is not installed. ' +
          'Install: npm install playwright && npx playwright install chromium'
        );
      }
      throw httpError(502, `render failed: ${err.message || 'unknown error'}`);
    }

    const { html: out, removed, cleanup } = await removeModalsFromHTML(rendered.html, {
      log: verbose,
      preferences,
    });
    summary.removed = removed.length;
    summary.cleanup = cleanup?.length || 0;
    summary.clicked = rendered.clicked.length;
    const ms = Date.now() - started;
    return json(res, 200, {
      html: out,
      sourceUrl: payload.url,
      clicked: rendered.clicked,
      removed,
      cleanup,
      renderMs: rendered.renderMs,
      ms,
    });
  }

  return json(res, 404, { error: 'not found' });
}

export function createApp({ quiet = false, verbose = false, preferences = null } = {}) {
  return async (req, res) => {
    applyCors(res);
    const start = Date.now();
    const summary = { removed: 0, cleanup: 0 };
    const isNoisy = req.method === 'OPTIONS' || req.url === '/health';
    if (verbose && !isNoisy) {
      console.log(`[modalmodules] → ${req.method} ${req.url}`);
    }
    try {
      await handle(req, res, summary, verbose && !isNoisy, preferences);
    } catch (err) {
      const status = err.status || 500;
      summary.error = err.message;
      json(res, status, { error: err.message || 'internal error' });
    }
    if (!quiet) {
      const ms = Date.now() - start;
      const extras = summary.error
        ? `error="${summary.error}"`
        : (typeof summary.clicked === 'number'
            ? `clicked=${summary.clicked} removed=${summary.removed} cleanup=${summary.cleanup}`
            : `removed=${summary.removed} cleanup=${summary.cleanup}`);
      if (!isNoisy) {
        console.log(
          `[modalmodules] ${req.method} ${req.url} → ${res.statusCode} ${extras} (${ms}ms)`
        );
      }
    }
  };
}

async function loadPreferencesFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function startServer({ port = 8787, host = '127.0.0.1', quiet = false, verbose = false, preferencesPath } = {}) {
  const prefPath = preferencesPath || DEFAULT_PREFERENCES_PATH;
  const preferences = await loadPreferencesFile(prefPath);
  return new Promise(resolve => {
    const server = http.createServer(createApp({ quiet, verbose, preferences }));
    server.listen(port, host, () => {
      const addr = server.address();
      const displayHost = addr.address === '::' || addr.address === '0.0.0.0' ? 'localhost' : addr.address;
      resolve({ server, url: `http://${displayHost}:${addr.port}`, preferences });
    });
  });
}
