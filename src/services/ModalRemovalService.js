import { DetectionEngine } from '../core/DetectionEngine.js';
import { NOOP_LOGGER } from '../util/logger.js';

// Categorize a verdict so we can (a) log it with a meaningful label and
// (b) honor the user's per-category preferences ("popups" / "cookies" /
// "authModals"). Order matters — vendor signatures are most specific, then
// class-pattern keywords, then text-based fallback for generic ARIA dialogs
// (e.g. an aria-dialog that contains "Create Account" → auth modal).
//
// Returns { category, kind, vendor? } where category is one of
// 'cookie' | 'auth' | 'newsletter' | 'paywall' | 'generic'.
function classifyVerdict(verdict, node) {
  // 1. Vendor signature → always a cookie banner.
  for (const s of verdict.signals) {
    if (s.id === 'selector-match') {
      const m = s.reason.match(/^(.+?)\s+signature/);
      if (m) return { category: 'cookie', kind: 'cookie banner', vendor: m[1] };
    }
  }
  // 2. Class-name pattern keywords. Order matters — more specific categories
  // first, because the auth keyword list includes "signup" which would
  // false-positive-match the literal "signup" inside the *newsletter* pattern
  // text (e.g. `newsletter[-_]?(signup|popup|...)`). Check newsletter first.
  for (const s of verdict.signals) {
    if (s.id === 'class-name-pattern') {
      const r = s.reason.toLowerCase();
      if (/cookie|consent|gdpr|ccpa/.test(r))            return { category: 'cookie',    kind: 'cookie banner' };
      if (/newsletter|subscribe/.test(r))                return { category: 'newsletter',kind: 'newsletter popup' };
      if (/paywall/.test(r))                             return { category: 'paywall',   kind: 'paywall' };
      if (/(^|[^a-z])exit/.test(r))                      return { category: 'newsletter',kind: 'exit-intent popup' };
      if (/login|signin|sign-in|signup|sign-up|register|registration|(^|[^a-z])auth|account|create-account|(^|[^a-z])join/.test(r))
                                                          return { category: 'auth',      kind: 'auth/login modal' };
    }
  }
  // 3. ARIA dialog — peek at the text to distinguish auth from generic.
  for (const s of verdict.signals) {
    if (s.id === 'aria-dialog') {
      const text = (node?.getTextPreview ? node.getTextPreview(200) : '').toLowerCase();
      if (/(create|register|open) (an? )?account|sign\s?up|sign\s?in|log\s?in|forgot password/.test(text)) {
        return { category: 'auth', kind: 'auth/login modal (ARIA)' };
      }
      if (/subscribe|newsletter/.test(text)) {
        return { category: 'newsletter', kind: 'newsletter popup (ARIA)' };
      }
      return { category: 'generic', kind: 'dialog (ARIA)' };
    }
  }
  return { category: 'generic', kind: 'modal' };
}

// Maps a category to which preference key gates it.
function preferenceFor(category, preferences) {
  if (!preferences) return 'remove'; // no prefs → default-on
  switch (category) {
    case 'cookie': return preferences.cookies ?? 'accept';
    case 'auth':   return preferences.authModals ?? 'remove';
    default:       return preferences.popups ?? 'remove';
  }
}

// Should the detection pass actually remove this node?
// For cookies, "accept" and "decline" are handled by the browser-side autoAccept
// flow BEFORE detection runs — by the time we get here, anything still classed
// as 'cookie' is either leftover after a successful click (safe to remove) OR
// the autoAccept path didn't run (server-side). Treat both as remove.
function shouldRemove(category, preferences) {
  const pref = preferenceFor(category, preferences);
  if (pref === 'ignore') return false;
  return true;
}

function describeRemoval(cls, verdict, selectorPath, preview) {
  const score = verdict.score.toFixed(2);
  const main = verdict.signals[0];
  let header;
  if (cls.vendor) {
    header = `removed ${cls.kind} (${cls.vendor})`;
  } else if (verdict.definitive) {
    header = `removed ${cls.kind} (${main.id}, definitive)`;
  } else {
    header = `removed ${cls.kind} (${main.id}, score ${score})`;
  }
  const previewPart = preview ? ` — "${preview}"` : '';
  return `${header}: <${selectorPath}>${previewPart}`;
}

function describeCleanup(c) {
  switch (c.action) {
    case 'unlock-class':
      return `unlocked ${c.node}: removed class "${c.value}"`;
    case 'unlock-style':
      return `unlocked ${c.node}: removed inline style "${c.value}"`;
    case 'remove-orphan':
      return `swept orphan element: <${c.node}>`;
    case 'inject-style':
      return `injected backup <style> into <${c.node}> (${c.value})`;
    default:
      return `cleanup: ${c.action} ${c.node}${c.value ? ' "' + c.value + '"' : ''}`;
  }
}

// Strips scroll-lock classes/inline-styles from <html>/<body> and removes
// orphan elements (backdrops, overlay wrappers) that survive after the main
// modal nodes are gone. Without this, sites that lock body scrolling when
// opening a modal end up un-scrollable after the modal is removed.
//
// Exported so the watch mode in src/api/browser.js can also call it on the
// full document after removing JS-injected popups.
export function applyCleanup(rootAdapter, cleanup) {
  if (!cleanup) return [];
  const log = [];

  if (cleanup.unlockScroll) {
    const targetSel = cleanup.unlockScroll.targets || 'html, body';
    const classes = cleanup.unlockScroll.removeClasses || [];
    const props = cleanup.unlockScroll.removeStyleProperties || [];
    for (const node of rootAdapter.queryAll(targetSel)) {
      const nodeClasses = node.getClasses();
      for (const cls of classes) {
        if (nodeClasses.includes(cls)) {
          node.removeClass(cls);
          log.push({ action: 'unlock-class', node: node.getSelectorPath(), value: cls });
        }
      }

      // Snapshot pre-strip values so conditional rules (ifValue / ifSiblingProp)
      // see the original state rather than partially-stripped state.
      const watched = new Set();
      for (const entry of props) {
        const name = typeof entry === 'string' ? entry : entry.prop;
        if (name) watched.add(name);
        if (typeof entry === 'object' && entry.ifSiblingProp) {
          for (const k of Object.keys(entry.ifSiblingProp)) watched.add(k);
        }
      }
      const snapshot = {};
      for (const p of watched) snapshot[p] = node.getStyle(p);

      for (const entry of props) {
        const prop = typeof entry === 'string' ? entry : entry.prop;
        if (!prop) continue;
        const initial = snapshot[prop];
        if (initial == null) continue;
        if (typeof entry === 'object') {
          // Conditional: only strip if value matches (e.g. position: fixed)
          if (entry.ifValue !== undefined && initial !== entry.ifValue) continue;
          // Conditional: only strip if siblings also match (e.g. strip `top`
          // only when `position: fixed` is also set — iOS scroll-lock signature)
          if (entry.ifSiblingProp) {
            const allMatch = Object.entries(entry.ifSiblingProp)
              .every(([k, v]) => snapshot[k] === v);
            if (!allMatch) continue;
          }
        }
        node.removeStyleProperty(prop);
        log.push({ action: 'unlock-style', node: node.getSelectorPath(), value: prop });
      }
    }
  }

  if (cleanup.removeOrphans?.selectors) {
    for (const sel of cleanup.removeOrphans.selectors) {
      for (const node of rootAdapter.queryAll(sel)) {
        log.push({ action: 'remove-orphan', node: node.getSelectorPath(), value: sel });
        node.remove();
      }
    }
  }

  // Last-resort backup for scroll lock that lives in stylesheets, not in
  // class/inline attributes — `body { overflow: hidden }` from a <style> block,
  // `html:has(.modal-open) { overflow: hidden }`, etc. We can't see those
  // rules from class/attr stripping, so we inject a high-specificity
  // override with !important into <head>. Default ON because the failure
  // mode (stuck un-scrollable page) is worse than the side effect
  // (forcing overflow-y on legit-fullscreen apps that happen to use modals).
  if (cleanup.injectScrollUnlock !== false && rootAdapter.injectStyle) {
    const css = (typeof cleanup.injectScrollUnlock === 'object' && cleanup.injectScrollUnlock.css)
      || 'html,body{overflow-y:auto!important;}';
    if (rootAdapter.injectStyle(css)) {
      log.push({ action: 'inject-style', node: 'head', value: 'scroll-unlock' });
    }
  }

  return log;
}

export class ModalRemovalService {
  constructor({ ruleRepository, adapterFactory }) {
    this.ruleRepository = ruleRepository;
    this.adapterFactory = adapterFactory;
  }

  async run(input, runOptions = {}) {
    const log = runOptions.logger || NOOP_LOGGER;
    const preferences = runOptions.preferences || null;
    const started = Date.now();
    const rules = await this.ruleRepository.getRules();
    const root = this.adapterFactory(input);
    const engine = new DetectionEngine(rules);
    const preserveSelectors = rules.preserve?.selectors || [];
    const candidateSelector = rules.candidateSelector || '*';
    const candidates = root.queryAll(candidateSelector);
    const enabledDetectors = (rules.detectors || []).filter(d => d.enabled).length;
    log.info(
      `scanning ${candidates.length} candidate element${candidates.length === 1 ? '' : 's'} ` +
      `against ${enabledDetectors} detector${enabledDetectors === 1 ? '' : 's'}`,
      { candidates: candidates.length, detectors: enabledDetectors }
    );
    if (preferences) {
      log.info(
        `preferences: popups=${preferences.popups ?? 'remove'}, ` +
        `cookies=${preferences.cookies ?? 'accept'}, ` +
        `authModals=${preferences.authModals ?? 'remove'}`,
        { preferences }
      );
    }

    const removedRefs = new Set();
    const removed = [];
    const skipped = { preserve: 0, ancestor: 0, ignored: { popups: 0, cookies: 0, auth: 0 } };
    for (const node of candidates) {
      if (preserveSelectors.some(sel => node.matches(sel))) {
        skipped.preserve++;
        continue;
      }
      // Skip nodes whose ancestor was already removed — avoids duplicate
      // reports for nested matches and wasted work on detached subtrees.
      if (node.getAncestors().some(a => removedRefs.has(a.raw()))) {
        skipped.ancestor++;
        continue;
      }
      const verdict = engine.evaluate(node);
      if (!verdict.isModal) continue;

      const cls = classifyVerdict(verdict, node);
      const selectorPath = node.getSelectorPath();
      // Honor end-user preferences — leave categories the user marked 'ignore'.
      if (!shouldRemove(cls.category, preferences)) {
        const prefKey = cls.category === 'cookie' ? 'cookies'
                      : cls.category === 'auth'   ? 'authModals'
                      : 'popups';
        skipped.ignored[cls.category === 'auth' ? 'auth' : (cls.category === 'cookie' ? 'cookies' : 'popups')]++;
        log.info(
          `skipped ${cls.kind}: preferences.${prefKey} = ignore — <${selectorPath}>`,
          { category: cls.category, selector: selectorPath }
        );
        continue;
      }

      // Capture text BEFORE removing — after .remove() in cheerio the text
      // is gone from the live tree.
      const preview = node.getTextPreview ? node.getTextPreview(60) : '';
      const entry = {
        selector: selectorPath,
        category: cls.category,
        kind: cls.kind,
        vendor: cls.vendor || null,
        score: verdict.score,
        definitive: verdict.definitive,
        preview,
        signals: verdict.signals.map(s => ({
          id: s.id,
          reason: s.reason,
          confidence: s.confidence,
        })),
      };
      removed.push(entry);
      removedRefs.add(node.raw());
      node.remove();
      log.info(describeRemoval(cls, verdict, selectorPath, preview), entry);
    }

    const totalSkippedIgnored = skipped.ignored.popups + skipped.ignored.cookies + skipped.ignored.auth;
    if (skipped.preserve > 0 || skipped.ancestor > 0 || totalSkippedIgnored > 0) {
      const parts = [];
      if (skipped.preserve > 0) parts.push(`${skipped.preserve} preserve-listed`);
      if (skipped.ancestor > 0) parts.push(`${skipped.ancestor} descendant-of-removed`);
      if (totalSkippedIgnored > 0) {
        const ignoredParts = [];
        if (skipped.ignored.popups > 0)  ignoredParts.push(`${skipped.ignored.popups} popup`);
        if (skipped.ignored.cookies > 0) ignoredParts.push(`${skipped.ignored.cookies} cookie`);
        if (skipped.ignored.auth > 0)    ignoredParts.push(`${skipped.ignored.auth} auth`);
        parts.push(`${totalSkippedIgnored} preference-ignored (${ignoredParts.join(', ')})`);
      }
      log.info(`skipped ${parts.join(', ')}`, skipped);
    }

    // Cleanup runs only when we actually removed something — that's the signal
    // the site is in a "modal open" state. Pages that legitimately use these
    // classes/styles with no modal aren't touched.
    let cleanup = [];
    if (removed.length > 0 && rules.cleanup) {
      log.info(`running post-removal cleanup (scroll unlock + orphan sweep + style inject)`);
      cleanup = applyCleanup(root, rules.cleanup);
      for (const c of cleanup) log.info(describeCleanup(c), c);
    } else if (removed.length === 0) {
      log.info('nothing removed — cleanup skipped to avoid touching unrelated pages');
    }

    const ms = Date.now() - started;
    log.info(
      `done in ${ms}ms — removed ${removed.length}, cleanup ${cleanup.length}`,
      { removedCount: removed.length, cleanupCount: cleanup.length, ms }
    );

    return { removed, cleanup, output: root.serialize() };
  }
}
