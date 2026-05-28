import { ModalRemovalService, applyCleanup } from '../services/ModalRemovalService.js';
import { createDOMAdapter } from '../adapters/DOMAdapter.js';
import { createLogger } from '../util/logger.js';

// Browser entry. Pass the rules object explicitly — no filesystem in the
// browser. Bundle spec/rules.default.json with your build (Vite/Rollup/Webpack
// all support JSON imports) and hand it in here.
//
//   import rules from 'modalmodules/spec/rules.default.json';
//   import { removeModals } from 'modalmodules/browser';
//
//   // One-shot:
//   const { removed, cleanup } = await removeModals(document, { rules });
//
//   // Auto-accept cookie banners (clicks the site's Accept button instead of
//   // hard-removing the modal — the site then handles its own close, which
//   // releases scroll lock and persists the consent state):
//   const { clicked, removed } = await removeModals(document, {
//     rules, autoAccept: true,
//   });
//
//   // Watch for popups injected later (delayed, scroll-triggered, SPA route
//   // changes). Returns a handle with .stop() to disconnect the observer.
//   const handle = await removeModals(document, {
//     rules,
//     watch: true,
//     autoAccept: true,
//     onAccept: (entry) => console.log('clicked', entry.vendor),
//     onRemove: (entry) => console.log('removed', entry.selector),
//   });
//   // ... later ...
//   handle.stop();

// Capture human-readable info about a button BEFORE we click it (handler
// may remove the element).
function snapshotButton(btn) {
  const text = (btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  const value = (btn.value || '').trim().slice(0, 50);
  const aria = (typeof btn.getAttribute === 'function' ? btn.getAttribute('aria-label') || '' : '').trim().slice(0, 50);
  const label = text || value || aria || '';
  const tag = (btn.tagName || 'button').toLowerCase();
  const id = btn.id ? `#${btn.id}` : '';
  const cls = btn.className && typeof btn.className === 'string'
    ? '.' + btn.className.trim().split(/\s+/).slice(0, 1).join('.')
    : '';
  return { label, target: `${tag}${id}${cls}` };
}

// Click vendor cookie buttons. `which` selects the button list to use:
// 'accept' uses autoAccept.buttonSelectors; 'decline' uses autoAccept.declineSelectors.
function tryAutoClickCookies(root, autoAcceptConfig, which) {
  const list = which === 'decline'
    ? autoAcceptConfig?.declineSelectors
    : autoAcceptConfig?.buttonSelectors;
  if (!list?.length) return [];
  const queryRoot = (typeof root.querySelectorAll === 'function')
    ? root
    : (root.documentElement || root.ownerDocument || null);
  if (!queryRoot) return [];
  const clicked = [];
  for (const entry of list) {
    let buttons;
    try { buttons = queryRoot.querySelectorAll(entry.selector); }
    catch { continue; }
    for (const btn of buttons) {
      try {
        if (typeof btn.click !== 'function') continue;
        const snap = snapshotButton(btn);
        btn.click();
        clicked.push({
          vendor: entry.vendor,
          selector: entry.selector,
          target: snap.target,
          label: snap.label,
          mode: which,
        });
      } catch {
        // Swallow per-button errors; one broken handler shouldn't kill the rest.
      }
    }
  }
  return clicked;
}

// Keep the old name as a thin alias for clarity in existing call sites.
function tryAutoAcceptCookies(root, autoAcceptConfig) {
  return tryAutoClickCookies(root, autoAcceptConfig, 'accept');
}

// Fallback: click buttons by visible text (textContent / value / aria-label)
// when no vendor selector matched. Scoped to cookie/consent containers so we
// don't accidentally click "Accept terms" on checkout or "OK" in unrelated
// dialogs. Guarded by a deny-word list so we never click "Reject all",
// "Manage preferences", "Necessary only", etc.
function tryAutoAcceptByText(root, textConfig) {
  if (!textConfig?.patterns?.length) return [];
  const queryRoot = (typeof root.querySelectorAll === 'function')
    ? root
    : (root.documentElement || root.ownerDocument || null);
  if (!queryRoot) return [];

  const scopeSelector = textConfig.scopeSelector || '[role=dialog]';
  let scopes;
  try { scopes = queryRoot.querySelectorAll(scopeSelector); }
  catch { return []; }
  if (scopes.length === 0) return [];

  const patterns = textConfig.patterns.map(p => p.toLowerCase().trim()).filter(Boolean);
  const denyWords = (textConfig.denyWords || []).map(w => w.toLowerCase());
  const maxClicks = textConfig.maxClicks ?? 1;

  const seen = new Set();
  const clicked = [];

  for (const scope of scopes) {
    if (clicked.length >= maxClicks) break;
    const buttons = scope.querySelectorAll(
      'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'
    );
    for (const btn of buttons) {
      if (clicked.length >= maxClicks) break;
      if (seen.has(btn)) continue;
      seen.add(btn);

      const text = (btn.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const value = (btn.value || '').toLowerCase();
      const aria = (typeof btn.getAttribute === 'function' ? btn.getAttribute('aria-label') || '' : '').toLowerCase();
      const haystacks = [text, value, aria].filter(Boolean);
      if (haystacks.length === 0) continue;

      // Safety: skip if any source contains a deny word.
      if (denyWords.some(w => haystacks.some(h => h.includes(w)))) continue;

      // Prefer exact match; fall back to short-string contains (within
      // pattern.length + 25 chars) so we don't match paragraph copy that
      // happens to include "accept".
      let matchedPattern = null;
      for (const p of patterns) {
        if (haystacks.some(h => h === p)) { matchedPattern = p; break; }
      }
      if (!matchedPattern) {
        outer:
        for (const p of patterns) {
          for (const h of haystacks) {
            if (h.length <= p.length + 25 && h.includes(p)) { matchedPattern = p; break outer; }
          }
        }
      }
      if (!matchedPattern) continue;

      try {
        if (typeof btn.click !== 'function') continue;
        const snap = snapshotButton(btn);
        btn.click();
        clicked.push({
          vendor: 'text-match',
          selector: snap.target,
          text: text || value || aria,
          label: snap.label,
          target: snap.target,
          matchedPattern,
        });
      } catch {
        // Swallow per-button errors.
      }
    }
  }
  return clicked;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

export async function removeModals(root, options = {}) {
  if (!options.rules) {
    throw new Error(
      'removeModals(root, { rules }) requires a `rules` object in the browser. ' +
      'Bundle spec/rules.default.json with your build and pass it in.'
    );
  }

  const log = createLogger(options.log);
  const ruleRepository = { getRules: async () => options.rules };
  const service = new ModalRemovalService({
    ruleRepository,
    adapterFactory: createDOMAdapter,
  });

  // Resolve preferences (call-time option > rules-bundled default > legacy
  // autoAccept shorthand). preferences.cookies = 'accept' is the modern way
  // to say what `autoAccept: true` used to mean.
  const preferences = options.preferences
    || options.rules.preferences
    || (options.autoAccept ? { popups: 'remove', cookies: 'accept', authModals: 'remove' } : null);
  const cookiesMode = preferences?.cookies ?? (options.autoAccept ? 'accept' : null);

  // Click the site's cookie button (Accept or Decline) BEFORE detection runs.
  // The site's own close handler then runs, which is the cleanest possible
  // outcome — no leftover scroll locks, proper consent state recorded, no
  // analytics breakage from a mid-flight modal teardown. The click stores
  // consent state synchronously, so the subsequent detection pass — which
  // only touches DOM — cannot undo that consent.
  let allClicked = [];
  if ((cookiesMode === 'accept' || cookiesMode === 'decline') && options.rules.autoAccept) {
    allClicked = tryAutoClickCookies(root, options.rules.autoAccept, cookiesMode);
    // Text fallback only makes sense for accept (decline-by-text-match is
    // ambiguous and would frequently click the wrong button).
    if (allClicked.length === 0 && cookiesMode === 'accept' && options.rules.autoAccept.textFallback) {
      allClicked = tryAutoAcceptByText(root, options.rules.autoAccept.textFallback);
    }
    for (const c of allClicked) {
      const verb = (c.mode === 'decline') ? 'auto-declined' : 'auto-accepted';
      const headline = c.vendor === 'text-match'
        ? `${verb} cookies (text match "${c.matchedPattern}")`
        : `${verb} ${c.vendor} cookies`;
      const targetPart = c.label
        ? `: clicked <${c.target}> labeled "${c.label}"`
        : `: clicked <${c.target}>`;
      log.info(`${headline}${targetPart}`, c);
      options.onAccept?.(c);
    }
    if (allClicked.length > 0) {
      await wait(options.rules.autoAccept.waitAfterClickMs ?? 300);
    }
  }

  // Then run normal detection on whatever's left, honoring per-category
  // preferences (popups, cookies, authModals).
  const initial = await service.run(root, { logger: log, preferences });
  for (const entry of initial.removed) options.onRemove?.(entry);

  if (!options.watch) {
    return { ...initial, clicked: allClicked };
  }

  // Watch mode: catch popups added to the DOM after the initial pass.
  // Triggered popups created via JS (setTimeout, scroll listeners, exit-intent,
  // SPA route changes) all show up here as childList mutations.
  const view = root.defaultView || root.ownerDocument?.defaultView || globalThis;
  const MO = view.MutationObserver || globalThis.MutationObserver;
  if (!MO) {
    return { ...initial, clicked: allClicked, stop() {} };
  }

  log.info('watch mode: observer started');
  const observerTarget = root.documentElement || root;
  const allRemoved = [...initial.removed];
  const allCleanup = [...(initial.cleanup || [])];

  const handleMutations = async (mutations) => {
    for (const m of mutations) {
      for (const added of m.addedNodes) {
        if (added.nodeType !== 1) continue; // Element only
        try {
          // Try auto-accept/decline on the injected subtree first.
          if ((cookiesMode === 'accept' || cookiesMode === 'decline') && options.rules.autoAccept) {
            let justClicked = tryAutoClickCookies(added, options.rules.autoAccept, cookiesMode);
            if (justClicked.length === 0 && cookiesMode === 'accept' && options.rules.autoAccept.textFallback) {
              justClicked = tryAutoAcceptByText(added, options.rules.autoAccept.textFallback);
            }
            if (justClicked.length > 0) {
              for (const c of justClicked) {
                allClicked.push(c);
                const verb = (c.mode === 'decline') ? 'auto-declined' : 'auto-accepted';
                const headline = c.vendor === 'text-match'
                  ? `${verb} cookies (text match "${c.matchedPattern}")`
                  : `${verb} ${c.vendor} cookies`;
                const targetPart = c.label
                  ? `: clicked <${c.target}> labeled "${c.label}"`
                  : `: clicked <${c.target}>`;
                log.info(`watch → ${headline}${targetPart}`, c);
                options.onAccept?.(c);
              }
              await wait(options.rules.autoAccept.waitAfterClickMs ?? 300);
              // Site is closing the modal itself — skip our removal pass for
              // this added subtree so we don't double-handle it.
              continue;
            }
          }
          const res = await service.run(added, { logger: log, preferences });
          for (const entry of res.removed) {
            allRemoved.push(entry);
            options.onRemove?.(entry);
          }
          // After removing a JS-injected popup, the same JS likely added the
          // body-level scroll lock. Re-run cleanup on the document so scroll
          // is restored — the per-subtree run() couldn't touch html/body.
          if (res.removed.length > 0 && options.rules.cleanup) {
            const docRoot = createDOMAdapter(root);
            const cleanupLog = applyCleanup(docRoot, options.rules.cleanup);
            allCleanup.push(...cleanupLog);
            for (const c of cleanupLog) {
              const detail = c.value ? ` "${c.value}"` : '';
              log.info(`cleanup: ${c.action} ${c.node}${detail}`, c);
            }
          }
        } catch {
          // Swallow per-mutation errors so one bad node doesn't kill the watcher.
        }
      }
    }
  };

  const observer = new MO((mutations) => { handleMutations(mutations); });
  observer.observe(observerTarget, { childList: true, subtree: true });

  return {
    get removed() { return allRemoved; },
    get cleanup() { return allCleanup; },
    get clicked() { return allClicked; },
    stop() {
      observer.disconnect();
      log.info('watch mode: observer stopped');
    },
  };
}
