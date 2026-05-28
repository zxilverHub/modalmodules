import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { removeModalsFromHTML } from '../src/api/server.js';
import { removeModals } from '../src/api/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(await readFile(resolve(here, '../spec/rules.default.json'), 'utf8'));
const tick = () => new Promise(r => setTimeout(r, 10));

// ---------------- Auth detection ----------------

test('auth: classifies "Create Account" ARIA dialog as auth/login modal', async () => {
  const html = `<html><body><main>x</main>
    <div role="dialog" aria-modal="true">
      <h2>Choose your local station</h2>
      <p>Create an account and designate a local station to get more stories.</p>
      <button>Create Account</button>
    </div>
  </body></html>`;
  const { removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].category, 'auth');
  assert.ok(removed[0].kind.includes('auth/login'));
});

test('auth: classifies login-modal class as auth', async () => {
  const html = '<html><body><main>x</main><div class="login-modal">Sign in</div></body></html>';
  const { removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].category, 'auth');
});

test('auth: classifies create-account class as auth', async () => {
  const html = '<html><body><main>x</main><div class="create-account-popup">Join now</div></body></html>';
  const { removed } = await removeModalsFromHTML(html);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].category, 'auth');
});

// ---------------- Preferences filter ----------------

test('preferences: authModals=ignore leaves login modal alone', async () => {
  const html = `<html><body><main>x</main>
    <div role="dialog" aria-modal="true">
      <button>Create Account</button>
    </div>
  </body></html>`;
  const { html: out, removed } = await removeModalsFromHTML(html, {
    preferences: { popups: 'remove', cookies: 'accept', authModals: 'ignore' },
  });
  assert.equal(removed.length, 0, 'auth modal preserved');
  assert.ok(out.includes('Create Account'));
});

test('preferences: popups=ignore leaves newsletter popup alone but still removes cookies', async () => {
  const html = `<html><body><main>x</main>
    <div class="newsletter-signup-popup">Subscribe</div>
    <div id="onetrust-banner-sdk">We use cookies</div>
  </body></html>`;
  const { html: out, removed } = await removeModalsFromHTML(html, {
    preferences: { popups: 'ignore', cookies: 'remove', authModals: 'remove' },
  });
  assert.equal(removed.length, 1, 'only cookie removed');
  assert.equal(removed[0].category, 'cookie');
  assert.ok(out.includes('newsletter-signup-popup'));
  assert.ok(!out.includes('onetrust-banner-sdk'));
});

test('preferences: cookies=ignore leaves cookie banner alone', async () => {
  const html = '<html><body><main>x</main><div id="onetrust-banner-sdk">consent</div></body></html>';
  const { html: out, removed } = await removeModalsFromHTML(html, {
    preferences: { popups: 'remove', cookies: 'ignore', authModals: 'remove' },
  });
  assert.equal(removed.length, 0);
  assert.ok(out.includes('onetrust-banner-sdk'));
});

test('preferences: server logs the active preferences once at start', async () => {
  const events = [];
  await removeModalsFromHTML(
    '<html><body><main>x</main><div role="dialog" aria-modal="true">popup</div></body></html>',
    {
      preferences: { popups: 'ignore', cookies: 'decline', authModals: 'ignore' },
      log: (e) => events.push(e),
    }
  );
  const prefLine = events.find(e => e.message.startsWith('preferences:'));
  assert.ok(prefLine, 'preferences logged');
  assert.ok(prefLine.message.includes('popups=ignore'));
  assert.ok(prefLine.message.includes('cookies=decline'));
  assert.ok(prefLine.message.includes('authModals=ignore'));
});

// ---------------- Decline mode (browser) ----------------

test('decline: cookies=decline clicks Reject button instead of Accept', async () => {
  const dom = new JSDOM(`<html><body>
    <main>x</main>
    <div id="onetrust-banner-sdk">
      <button id="onetrust-accept-btn-handler">Accept</button>
      <button id="onetrust-reject-all-handler">Reject All</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  const clickedIds = [];
  doc.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => clickedIds.push('accept'));
  doc.getElementById('onetrust-reject-all-handler').addEventListener('click', () => {
    clickedIds.push('reject');
    doc.getElementById('onetrust-banner-sdk').remove();
  });

  const result = await removeModals(doc, {
    rules,
    preferences: { popups: 'remove', cookies: 'decline', authModals: 'remove' },
  });

  assert.deepEqual(clickedIds, ['reject'], 'reject clicked, not accept');
  assert.equal(result.clicked.length, 1);
  assert.equal(result.clicked[0].mode, 'decline');
  assert.equal(result.clicked[0].vendor, 'OneTrust');
});

test('decline: log says "auto-declined" not "auto-accepted"', async () => {
  const dom = new JSDOM(`<html><body><main>x</main>
    <div id="CybotCookiebotDialog">
      <button id="CybotCookiebotDialogBodyButtonDecline">Decline</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  doc.getElementById('CybotCookiebotDialogBodyButtonDecline').addEventListener('click', () => {
    doc.getElementById('CybotCookiebotDialog').remove();
  });

  const events = [];
  await removeModals(doc, {
    rules,
    preferences: { popups: 'remove', cookies: 'decline', authModals: 'remove' },
    log: (e) => events.push(e),
  });

  const decline = events.find(e => e.message.startsWith('auto-declined'));
  assert.ok(decline, 'decline action logged');
  assert.ok(decline.message.includes('Cookiebot'));
});

// ---------------- Backward-compat ----------------

test('backward-compat: autoAccept: true still maps to preferences.cookies = accept', async () => {
  const dom = new JSDOM(`<html><body><main>x</main>
    <div id="onetrust-banner-sdk">
      <button id="onetrust-accept-btn-handler">Accept</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  let acceptedClicked = false;
  doc.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => {
    acceptedClicked = true;
    doc.getElementById('onetrust-banner-sdk').remove();
  });

  const result = await removeModals(doc, { rules, autoAccept: true });
  assert.equal(acceptedClicked, true);
  assert.equal(result.clicked.length, 1);
  assert.equal(result.clicked[0].mode, 'accept');
});
