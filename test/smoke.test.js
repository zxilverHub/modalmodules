import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { removeModalsFromHTML } from '../src/api/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../spec/fixtures');

async function fixture(name) {
  return readFile(resolve(fixtures, name), 'utf8');
}

test('removes ARIA modal dialog (definitive)', async () => {
  const html = await fixture('aria-dialog.html');
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].definitive, true);
  assert.ok(!out.includes('role="dialog"'));
  assert.ok(out.includes('Real content'));
});

test('removes class-name popup (newsletter signup)', async () => {
  const html = await fixture('class-name-modal.html');
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(!out.includes('newsletter-signup-popup'));
  assert.ok(out.includes('Article content'));
});

test('removes cookie banner', async () => {
  const html = await fixture('cookie-banner.html');
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(!out.includes('cookie-consent-banner'));
});

test('leaves non-modal pages untouched', async () => {
  const html = await fixture('non-modal.html');
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 0);
  assert.ok(out.includes('Article'));
});

test('removes hidden/delayed popups (still in HTML at load time)', async () => {
  // Sites that "show after 5s" or "show after scroll" usually pre-render the
  // popup hidden — display:none, hidden attr, visibility:hidden. The cleaner
  // strips them before they could ever be revealed.
  const html = await fixture('hidden-modal.html');
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 3, 'all three hidden popups should be removed');
  assert.ok(!out.includes('newsletter-popup'));
  assert.ok(!out.includes('cookie-consent-banner'));
  assert.ok(!out.includes('onetrust-banner-sdk'));
  assert.ok(out.includes('Article body'));
});

test('recognises OneTrust by ID selector (selector-match detector)', async () => {
  const html = '<html><body><main>x</main><div id="onetrust-consent-sdk">consent</div></body></html>';
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].signals[0].id, 'selector-match');
  assert.ok(removed[0].signals[0].reason.includes('OneTrust'));
  assert.ok(!out.includes('onetrust-consent-sdk'));
});

test('recognises Cookiebot by ID selector', async () => {
  const html = '<html><body><main>x</main><div id="CybotCookiebotDialog">consent</div></body></html>';
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(removed[0].signals[0].reason.includes('Cookiebot'));
  assert.ok(!out.includes('CybotCookiebotDialog'));
});

test('cleanup phase restores scrolling and removes orphan backdrop', async () => {
  // Reproduces the user-reported bug: site adds `body.modal-open` +
  // `overflow:hidden` + a `.modal-backdrop` sibling when opening a modal.
  // After we remove the modal, those locks/orphans must be cleaned up
  // or the page stays un-scrollable.
  const html = await fixture('scroll-locked-page.html');
  const { html: out, removed, cleanup } = await removeModalsFromHTML(html);

  // Modal definitely gone; backdrop may also be picked up by class-name
  // detection (acceptable — cleanup is a backup, not the only path).
  assert.ok(removed.length >= 1, 'at least the dialog should be removed');
  assert.ok(cleanup.length > 0, 'cleanup actions performed');

  // The body class lock is gone
  assert.ok(!out.match(/class="[^"]*modal-open/), 'modal-open class stripped');
  assert.ok(!out.match(/class="[^"]*no-scroll/), 'no-scroll class stripped');

  // The inline style lock is gone
  assert.ok(!out.includes('overflow: hidden'), 'overflow:hidden stripped');
  assert.ok(!out.includes('padding-right: 15px'), 'padding-right stripped');

  // The orphan backdrop sibling is gone
  assert.ok(!out.includes('fancybox-overlay'), 'backdrop sibling removed');

  // Real content preserved
  assert.ok(out.includes('Article body'));

  // Cleanup log records what happened (useful for auditing)
  assert.ok(cleanup.some(c => c.action === 'unlock-class' && c.value === 'modal-open'));
  assert.ok(cleanup.some(c => c.action === 'unlock-style' && c.value === 'overflow'));
  assert.ok(cleanup.some(c => c.action === 'remove-orphan'));
});

test('conditional cleanup preserves position:relative on body (concordpeptides-style regression)', async () => {
  // Sites legitimately set `body { position: relative }` for absolutely-
  // positioned children. Stripping position unconditionally broke their
  // layout. With `ifValue: "fixed"`, only the iOS scroll-lock pattern
  // (position:fixed) gets stripped — relative/static survive.
  const html = `<html><body class="modal-open" style="position: relative; overflow: hidden">
    <main>Article</main>
    <div role="dialog" aria-modal="true">popup</div>
  </body></html>`;
  const { html: out, removed, cleanup } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(out.includes('position: relative'), 'position:relative preserved (not iOS lock pattern)');
  assert.ok(!out.includes('overflow: hidden'), 'overflow still stripped (always)');
  assert.ok(!cleanup.some(c => c.value === 'position'), 'no position strip logged');
});

test('conditional cleanup strips position:fixed (iOS scroll-lock pattern)', async () => {
  const html = `<html><body style="position: fixed; top: -300px; width: 100%; overflow: hidden">
    <main>Article</main>
    <div role="dialog" aria-modal="true">popup</div>
  </body></html>`;
  const { html: out, removed, cleanup } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(!out.includes('position: fixed'), 'position:fixed stripped');
  assert.ok(!out.includes('top: -300px'), 'top stripped (sibling condition met)');
  assert.ok(!out.includes('width: 100%'), 'width stripped (sibling condition met)');
  assert.ok(cleanup.some(c => c.value === 'position'));
  assert.ok(cleanup.some(c => c.value === 'top'));
});

test('preserves structural elements even if class regex would match (header.modal-header, etc.)', async () => {
  // <header class="modal-header"> would match the `modal` regex if not for
  // the preserve list. Sites style their own headers/navs with these names.
  const html = `<html><body>
    <header class="modal-header">Real header</header>
    <nav class="popup-nav">Nav</nav>
    <main>Article</main>
    <div role="dialog" aria-modal="true">Actual popup</div>
  </body></html>`;
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1, 'only the real dialog removed');
  assert.ok(out.includes('Real header'));
  assert.ok(out.includes('<nav'));
});

test('Shopify cart drawer + body--locked lock pattern', async () => {
  // Common Shopify theme pattern: open cart drawer, body gets `body--locked`,
  // overlay sibling appears. Removing the drawer should unlock + sweep overlay.
  const html = `<html><body class="template-product body--locked">
    <main>Product page</main>
    <div class="drawer__overlay js-drawer-overlay"></div>
    <div id="cart-drawer" class="cart-drawer drawer--cart">
      <h2>Your cart</h2>
    </div>
  </body></html>`;
  const { html: out, removed, cleanup } = await removeModalsFromHTML(html);
  assert.ok(removed.length >= 1, 'cart drawer detected as modal');
  assert.ok(!out.includes('cart-drawer'), 'cart drawer markup gone');
  assert.ok(!out.match(/class="[^"]*body--locked/), 'body--locked stripped');
  assert.ok(!out.includes('drawer__overlay'), 'drawer overlay sibling swept');
  assert.ok(out.includes('Product page'), 'real content preserved');
  assert.ok(out.includes('template-product'), 'unrelated theme class preserved');
});

test('Privy popup vendor signature is recognised', async () => {
  const html = '<html><body><main>Shop</main><div id="privy-popup-state-12345" class="privy-popup">Subscribe</div></body></html>';
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.ok(removed.length >= 1);
  assert.ok(!out.includes('privy-popup'));
});

test('Klaviyo embedded form is recognised', async () => {
  const html = '<html><body><main>Shop</main><div class="klaviyo-form-XyZ12 needsclick klaviyo-form" data-klaviyo-form="abc">Email</div></body></html>';
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.ok(removed.length >= 1);
  assert.ok(!out.includes('klaviyo-form-XyZ12'));
});

test('CookieHub vendor signature is recognised', async () => {
  const html = '<html><body><main>x</main><div class="ch2-dialog ch2-style-light">consent</div></body></html>';
  const { html: out, removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(removed[0].signals.some(s => s.id === 'selector-match' && s.reason.includes('CookieHub')));
  assert.ok(!out.includes('ch2-dialog'));
});

test('injects scroll-unlock <style> as last-resort backup', async () => {
  // Sites that lock scroll via a stylesheet rule (not class/inline) — e.g.
  // a <style>body{overflow:hidden}</style> block triggered by some other
  // mechanism — can't be unlocked by class/inline stripping alone. The
  // injected <style data-modalmodules-unlock> wins via !important.
  const html = `<html><head><style>body{overflow:hidden}</style></head><body>
    <main>Article</main>
    <div role="dialog" aria-modal="true">popup</div>
  </body></html>`;
  const { html: out, removed, cleanup } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.ok(out.includes('data-modalmodules-unlock'), 'unlock style tag injected');
  assert.ok(out.includes('overflow-y:auto'), 'override CSS present');
  assert.ok(cleanup.some(c => c.action === 'inject-style'), 'injection logged');
});

test('inject-style is idempotent (no duplicate tags on repeat calls)', async () => {
  const html = `<html><body>
    <main>x</main>
    <div role="dialog" aria-modal="true">a</div>
  </body></html>`;
  // First pass
  const first = await removeModalsFromHTML(html);
  // Feed the cleaned HTML back through — the injection shouldn't duplicate
  const second = await removeModalsFromHTML(
    first.html + '<div role="dialog" aria-modal="true">b</div>'
  );
  const matches = second.html.match(/data-modalmodules-unlock/g) || [];
  assert.equal(matches.length, 1, 'single injection survives multiple cleans');
});

test('cleanup does NOT run when no modal was removed', async () => {
  // Don't break pages that legitimately have these classes/styles with no modal.
  const html = '<html><body class="modal-open" style="overflow: hidden"><main>Calendar app</main></body></html>';
  const { html: out, removed, cleanup } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 0);
  assert.equal(cleanup.length, 0);
  assert.ok(out.includes('modal-open'), 'unrelated body class preserved');
  assert.ok(out.includes('overflow: hidden'), 'unrelated inline style preserved');
});
