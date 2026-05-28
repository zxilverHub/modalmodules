import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { removeModals } from '../src/api/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = resolve(here, '../spec/rules.default.json');
const rules = JSON.parse(await readFile(rulesPath, 'utf8'));

// MutationObserver fires asynchronously (microtask). Give it a tick + small
// macrotask delay to settle.
const tick = () => new Promise(r => setTimeout(r, 10));

test('one-shot mode removes existing popups', async () => {
  const dom = new JSDOM(`
    <html><body>
      <main>Article</main>
      <div role="dialog" aria-modal="true">SUBSCRIBE</div>
    </body></html>
  `);
  const { removed } = await removeModals(dom.window.document, { rules });
  assert.equal(removed.length, 1);
  assert.equal(dom.window.document.querySelector('[role=dialog]'), null);
  assert.ok(dom.window.document.body.textContent.includes('Article'));
});

test('watch mode removes a popup injected after load', async () => {
  const dom = new JSDOM(`<html><body><main>Article</main></body></html>`);
  const doc = dom.window.document;

  const fired = [];
  const handle = await removeModals(doc, {
    rules,
    watch: true,
    onRemove: (entry) => fired.push(entry),
  });
  assert.equal(handle.removed.length, 0, 'nothing to remove initially');

  // Simulate setTimeout-triggered popup injection
  const popup = doc.createElement('div');
  popup.className = 'newsletter-signup-popup';
  popup.textContent = 'Subscribe!';
  doc.body.appendChild(popup);

  await tick();

  assert.equal(handle.removed.length, 1, 'injected popup should be removed');
  assert.equal(fired.length, 1, 'onRemove callback should have fired');
  assert.equal(doc.querySelector('.newsletter-signup-popup'), null);

  handle.stop();
});

test('watch mode catches popup whose root element itself matches', async () => {
  const dom = new JSDOM(`<html><body><main>x</main></body></html>`);
  const doc = dom.window.document;

  const handle = await removeModals(doc, { rules, watch: true });

  // The injected node itself (not a descendant) is the popup
  const popup = doc.createElement('div');
  popup.id = 'CybotCookiebotDialog';
  popup.textContent = 'consent';
  doc.body.appendChild(popup);

  await tick();

  assert.equal(handle.removed.length, 1);
  assert.equal(doc.querySelector('#CybotCookiebotDialog'), null);

  handle.stop();
});

test('watch mode stops after handle.stop()', async () => {
  const dom = new JSDOM(`<html><body><main>x</main></body></html>`);
  const doc = dom.window.document;

  const handle = await removeModals(doc, { rules, watch: true });
  handle.stop();

  // After stop, mutations should NOT trigger removal
  const popup = doc.createElement('div');
  popup.className = 'newsletter-popup';
  doc.body.appendChild(popup);

  await tick();

  assert.equal(handle.removed.length, 0, 'observer was disconnected');
  assert.ok(doc.querySelector('.newsletter-popup'), 'popup should still be present');
});

test('watch mode unlocks scroll after removing JS-injected modal', async () => {
  // Real-world flow: site script adds `body.modal-open` + `overflow:hidden`,
  // then appends the modal. We should remove the modal AND restore scroll.
  const dom = new JSDOM(`<html><body><main>Article</main></body></html>`);
  const doc = dom.window.document;

  const handle = await removeModals(doc, { rules, watch: true });

  // Simulate the site's "open modal" code
  doc.body.classList.add('modal-open');
  doc.body.style.overflow = 'hidden';
  doc.body.style.paddingRight = '15px';
  const backdrop = doc.createElement('div');
  backdrop.className = 'modal-backdrop';
  doc.body.appendChild(backdrop);
  const popup = doc.createElement('div');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'true');
  popup.textContent = 'Subscribe';
  doc.body.appendChild(popup);

  await tick();

  assert.ok(handle.removed.length >= 1, 'modal removed');
  assert.equal(doc.body.classList.contains('modal-open'), false, 'modal-open class stripped');
  assert.equal(doc.body.style.overflow, '', 'overflow inline-style stripped');
  assert.equal(doc.body.style.paddingRight, '', 'padding-right inline-style stripped');
  assert.equal(doc.querySelector('.modal-backdrop'), null, 'orphan backdrop removed');
  assert.ok(handle.cleanup.length > 0, 'cleanup log populated');

  handle.stop();
});

test('autoAccept clicks the OneTrust accept button instead of removing', async () => {
  // The site's own click handler is the gold-standard close path: it removes
  // the modal AND releases scroll lock AND persists consent. Auto-accept
  // simulates the user pressing Accept.
  const dom = new JSDOM(`<html><body class="modal-open" style="overflow: hidden">
    <main>Article</main>
    <div id="onetrust-banner-sdk">
      <p>We use cookies</p>
      <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;

  // Simulate the site's own accept handler
  doc.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => {
    doc.getElementById('onetrust-banner-sdk').remove();
    doc.body.classList.remove('modal-open');
    doc.body.style.removeProperty('overflow');
  });

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 1);
  assert.equal(result.clicked[0].vendor, 'OneTrust');
  assert.equal(doc.getElementById('onetrust-banner-sdk'), null, 'site removed modal itself');
  assert.equal(doc.body.classList.contains('modal-open'), false, 'site released scroll lock itself');
  assert.equal(doc.body.style.overflow, '', 'site removed overflow style itself');
  // Detection runs after wait — modal is gone, nothing left to remove
  assert.equal(result.removed.length, 0, 'manual removal not needed when site handled close');
});

test('autoAccept watch-mode catches popup injected after load', async () => {
  const dom = new JSDOM(`<html><body><main>x</main></body></html>`);
  const doc = dom.window.document;

  const accepted = [];
  const handle = await removeModals(doc, {
    rules,
    watch: true,
    autoAccept: true,
    onAccept: (entry) => accepted.push(entry),
  });

  // Simulate site injecting Cookiebot consent dialog
  const banner = doc.createElement('div');
  banner.id = 'CybotCookiebotDialog';
  banner.innerHTML = '<button id="CybotCookiebotDialogBodyLevelButtonAccept">Allow</button>';
  banner.querySelector('button').addEventListener('click', () => banner.remove());
  doc.body.appendChild(banner);

  await new Promise(r => setTimeout(r, 400));

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].vendor, 'Cookiebot');
  assert.equal(doc.getElementById('CybotCookiebotDialog'), null);

  handle.stop();
});

test('autoAccept text-fallback clicks "Accept all" button on unknown vendor', async () => {
  // Custom cookie banner with no recognized vendor class/ID, but text says
  // "Accept all". Text fallback should match and click it.
  const dom = new JSDOM(`<html><body class="modal-open">
    <main>Article</main>
    <div class="custom-cookie-bar" role="dialog">
      <p>We use cookies</p>
      <button class="custom-btn">Manage settings</button>
      <button class="custom-btn primary">Accept all</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  doc.querySelectorAll('.custom-btn').forEach(b => {
    b.addEventListener('click', () => {
      doc.querySelector('.custom-cookie-bar').remove();
      doc.body.classList.remove('modal-open');
    });
  });

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 1, 'exactly one click');
  assert.equal(result.clicked[0].vendor, 'text-match');
  assert.equal(result.clicked[0].matchedPattern, 'accept all');
  assert.equal(doc.querySelector('.custom-cookie-bar'), null);
});

test('autoAccept text-fallback skips "Reject all" and "Manage" buttons', async () => {
  // Banner contains both an Accept button AND a Reject button. Deny-word
  // safety must prevent clicking "Reject" even though it contains pattern-ish text.
  const dom = new JSDOM(`<html><body>
    <main>x</main>
    <div class="cookie-bar" role="dialog">
      <button id="manage-btn">Manage preferences</button>
      <button id="reject-btn">Reject all cookies</button>
      <button id="accept-btn">Accept all</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  const clickedIds = [];
  ['manage-btn', 'reject-btn', 'accept-btn'].forEach(id => {
    doc.getElementById(id).addEventListener('click', () => clickedIds.push(id));
  });

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 1, 'maxClicks=1 enforced');
  assert.deepEqual(clickedIds, ['accept-btn'], 'only Accept was clicked; Reject/Manage skipped');
});

test('autoAccept text-fallback is scoped — does not click buttons outside cookie containers', async () => {
  // A checkout page with "Accept Terms" button outside any cookie banner.
  // Text fallback must NOT click it because it's not inside a cookie scope.
  const dom = new JSDOM(`<html><body>
    <form class="checkout">
      <button id="accept-terms">Accept</button>
    </form>
  </body></html>`);
  const doc = dom.window.document;
  let termsClicked = false;
  doc.getElementById('accept-terms').addEventListener('click', () => { termsClicked = true; });

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 0, 'no cookie scope present → no clicks');
  assert.equal(termsClicked, false, 'Accept Terms button never clicked');
});

test('autoAccept text-fallback matches via aria-label on icon buttons', async () => {
  const dom = new JSDOM(`<html><body>
    <div class="cookie-consent" role="dialog">
      <button aria-label="Accept all cookies"><svg></svg></button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  doc.querySelector('button').addEventListener('click', () => {
    doc.querySelector('.cookie-consent').remove();
  });

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 1);
  assert.equal(doc.querySelector('.cookie-consent'), null);
});

test('autoAccept text-fallback handles non-English (German "Alle akzeptieren")', async () => {
  const dom = new JSDOM(`<html><body>
    <div class="cookie-banner" role="dialog">
      <button class="x">Ablehnen</button>
      <button class="y">Alle akzeptieren</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  doc.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => doc.querySelector('.cookie-banner').remove());
  });

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 1);
  assert.equal(result.clicked[0].matchedPattern, 'alle akzeptieren');
});

test('autoAccept falls back to manual removal when no Accept button exists', async () => {
  // Some modals genuinely have no accept button — e.g. a newsletter popup
  // with only a close X. Auto-accept should silently fall through to the
  // normal detection+removal flow.
  const dom = new JSDOM(`<html><body>
    <main>Article</main>
    <div class="newsletter-signup-popup">Subscribe!</div>
  </body></html>`);
  const doc = dom.window.document;

  const result = await removeModals(doc, { rules, autoAccept: true });

  assert.equal(result.clicked.length, 0, 'no accept button matched');
  assert.equal(result.removed.length, 1, 'fell back to manual removal');
  assert.equal(doc.querySelector('.newsletter-signup-popup'), null);
});

test('watch mode catches deeply nested injected popups', async () => {
  const dom = new JSDOM(`<html><body><main>x</main><section id="host"></section></body></html>`);
  const doc = dom.window.document;

  const handle = await removeModals(doc, { rules, watch: true });

  // Site code injects a wrapper with a popup deeply nested inside
  doc.querySelector('#host').innerHTML = `
    <div class="wrapper">
      <div class="inner">
        <div class="cookie-consent-banner">Accept</div>
      </div>
    </div>
  `;

  await tick();

  assert.equal(handle.removed.length, 1);
  assert.equal(doc.querySelector('.cookie-consent-banner'), null);
  assert.ok(doc.querySelector('.wrapper'), 'non-popup wrapper preserved');

  handle.stop();
});
