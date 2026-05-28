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

test('server log captures rich detail for each action', async () => {
  const events = [];
  const html = `<html><body class="modal-open" style="overflow: hidden">
    <main>Article</main>
    <div role="dialog" aria-modal="true">Welcome to our community space!</div>
    <div class="fancybox-overlay"></div>
  </body></html>`;
  await removeModalsFromHTML(html, { log: (e) => events.push(e) });

  const messages = events.map(e => e.message);

  // Scan info at start
  assert.ok(messages.some(m => /^scanning \d+ candidate/.test(m)), 'logged scan start');

  // Removal: classification + preview text
  const removalMsg = messages.find(m => m.startsWith('removed'));
  assert.ok(removalMsg, 'logged a removal');
  assert.ok(removalMsg.includes('dialog (ARIA)'), 'classified as ARIA dialog');
  assert.ok(removalMsg.includes('definitive'), 'noted definitive verdict');
  assert.ok(removalMsg.includes('Welcome to our community'), 'included text preview');

  // Cleanup phase has a header line then per-action lines
  assert.ok(messages.some(m => m.startsWith('running post-removal cleanup')), 'logged cleanup phase start');
  assert.ok(messages.some(m => m.includes('unlocked body: removed class')), 'friendly class unlock log');
  assert.ok(messages.some(m => m.includes('unlocked body: removed inline style')), 'friendly style unlock log');
  assert.ok(messages.some(m => m.startsWith('swept orphan element:')), 'friendly orphan log');
  assert.ok(messages.some(m => m.startsWith('injected backup <style>')), 'friendly injection log');

  // Summary line at end
  assert.ok(messages.some(m => /^done in \d+ms — removed \d+, cleanup \d+/.test(m)), 'logged summary');
});

test('server log: classifies as cookie banner with vendor name', async () => {
  const events = [];
  await removeModalsFromHTML(
    '<html><body><main>x</main><div id="onetrust-banner-sdk">We use cookies</div></body></html>',
    { log: (e) => events.push(e) }
  );
  const removal = events.find(e => e.message.startsWith('removed'));
  assert.ok(removal.message.includes('cookie banner (OneTrust)'), 'vendor named: ' + removal.message);
});

test('server log: when nothing removed, says so and skips cleanup', async () => {
  const events = [];
  await removeModalsFromHTML(
    '<html><body><main>Just an article</main></body></html>',
    { log: (e) => events.push(e) }
  );
  const messages = events.map(e => e.message);
  assert.ok(messages.some(m => m.startsWith('nothing removed')), 'explicit no-op log');
  assert.equal(messages.filter(m => m.startsWith('cleanup')).length, 0, 'no cleanup phase log');
});

test('log: true sends to console (smoke check — no throw)', async () => {
  // Sanity: passing log: true uses the default console output without errors.
  // We can't easily assert console output across runtimes; we just ensure the
  // call shape works.
  const html = '<html><body><main>x</main><div role="dialog" aria-modal="true">p</div></body></html>';
  const orig = console.log;
  const captured = [];
  console.log = (line) => captured.push(line);
  try {
    await removeModalsFromHTML(html, { log: true });
  } finally {
    console.log = orig;
  }
  assert.ok(captured.some(line => line.startsWith('[modalmodules] removed')));
});

test('log silent by default (no events without opt-in)', async () => {
  const orig = console.log;
  const captured = [];
  console.log = (line) => captured.push(line);
  try {
    await removeModalsFromHTML(
      '<html><body><main>x</main><div role="dialog" aria-modal="true">p</div></body></html>'
    );
  } finally {
    console.log = orig;
  }
  assert.equal(captured.length, 0, 'no log lines when log option is not set');
});

test('browser log: autoAccept reports vendor, target, and button label', async () => {
  const dom = new JSDOM(`<html><body>
    <main>x</main>
    <div id="onetrust-banner-sdk">
      <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
    </div>
  </body></html>`);
  const doc = dom.window.document;
  doc.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => {
    doc.getElementById('onetrust-banner-sdk').remove();
  });

  const events = [];
  await removeModals(doc, {
    rules,
    autoAccept: true,
    log: (e) => events.push(e),
  });

  const accepted = events.find(e => e.message.startsWith('auto-accepted'));
  assert.ok(accepted, 'click was logged');
  assert.ok(accepted.message.includes('OneTrust'), 'vendor surfaced');
  assert.ok(accepted.message.includes('Accept All Cookies'), 'button label surfaced');
  assert.ok(accepted.message.includes('onetrust-accept-btn-handler'), 'button selector surfaced');
});
