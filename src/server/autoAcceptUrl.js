// Playwright orchestrator. Launches a real headless Chromium, navigates to
// the URL, waits for the page to settle, clicks the cookie Accept (or Decline)
// button, snapshots HTML, and returns it. Caller pipes the snapshot through
// the normal cleaner for any non-cookie cleanup.
//
// Playwright is an OPTIONAL peer dependency — we lazy-import it so users who
// don't need this endpoint don't pay the 300MB download cost. When missing,
// callers get a 501 with a helpful install message.
//
// Uses the same autoAccept.buttonSelectors / declineSelectors lists from
// spec/rules.default.json as the browser-side autoAccept — single source of
// truth across runtimes.

import { DefaultRuleRepository } from '../repositories/DefaultRuleRepository.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _chromiumPromise = null;
async function getChromium() {
  if (_chromiumPromise) return _chromiumPromise;
  _chromiumPromise = import('playwright').then(
    (pw) => pw.chromium,
    (err) => { _chromiumPromise = null; throw err; }
  );
  return _chromiumPromise;
}

export function isPlaywrightMissing(err) {
  if (!err) return false;
  const msg = err.message || '';
  return err.code === 'ERR_MODULE_NOT_FOUND'
    || msg.includes("Cannot find package 'playwright'")
    || msg.includes("Cannot find module 'playwright'");
}

export async function autoAcceptUrl(targetUrl, opts = {}) {
  const chromium = await getChromium();
  const mode = opts.cookies === 'decline' ? 'decline' : 'accept';
  const extraWaitMs = opts.waitMs ?? 1500;
  const navTimeoutMs = opts.navTimeoutMs ?? 30000;
  const clickTimeoutMs = opts.clickTimeoutMs ?? 1500;
  const log = opts.logger;

  const ruleRepo = opts.ruleRepository || new DefaultRuleRepository();
  const rules = await ruleRepo.getRules();
  const buttons = mode === 'decline'
    ? (rules.autoAccept?.declineSelectors || [])
    : (rules.autoAccept?.buttonSelectors || []);

  const renderStart = Date.now();
  log?.info(`playwright: launching headless chromium → ${targetUrl}`);
  const browser = await chromium.launch({ headless: true });
  const clicked = [];
  let html = '';
  try {
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs });
    } catch (err) {
      // Some sites never reach networkidle (long-polling, ad SDKs); fall back
      // to DOMContentLoaded so we still get something useful.
      log?.info(`playwright: networkidle timed out, falling back to domcontentloaded`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    }
    await page.waitForTimeout(extraWaitMs);
    log?.info(`playwright: page rendered, scanning ${buttons.length} vendor button selector${buttons.length === 1 ? '' : 's'} for ${mode}`);

    for (const entry of buttons) {
      let handle;
      try { handle = await page.$(entry.selector); } catch { continue; }
      if (!handle) continue;
      let visible = false;
      try { visible = await handle.isVisible(); } catch { visible = false; }
      if (!visible) continue;
      let label = '';
      try { label = (await handle.textContent() || '').trim().replace(/\s+/g, ' ').slice(0, 50); }
      catch {}
      try {
        await handle.click({ timeout: clickTimeoutMs });
        const verb = mode === 'decline' ? 'declined' : 'accepted';
        log?.info(`playwright: ${verb} ${entry.vendor} cookies → clicked "${label}" (${entry.selector})`);
        clicked.push({ vendor: entry.vendor, selector: entry.selector, label, mode });
        break;
      } catch {
        // try next vendor
      }
    }

    if (clicked.length > 0) {
      // Give the site time to run its close handler + finish animations.
      await page.waitForTimeout(700);
    }

    html = await page.content();
  } finally {
    await browser.close();
  }

  return {
    html,
    clicked,
    renderMs: Date.now() - renderStart,
  };
}
