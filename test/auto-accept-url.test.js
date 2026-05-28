import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/HttpServer.js';

// Verifies the new POST /v1/auto-accept-url endpoint.
//
// The validation tests (400 for bad input) always run.
//
// The "Playwright missing" 501 test is conditional: skipped when Playwright IS
// installed (because then we'd hit the real browser launch path, which is the
// other test). The "Playwright works" integration test requires
//   npm install playwright && npx playwright install chromium
// and is also skipped by default to keep the suite cheap.

const HAS_PLAYWRIGHT = await import('playwright').then(() => true).catch(() => false);

async function withServer(fn) {
  const { server, url } = await startServer({ port: 0, quiet: true });
  try { await fn(url); } finally { server.close(); }
}

test('POST /v1/auto-accept-url with non-http URL returns 400', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/v1/auto-accept-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('http'));
  });
});

test('POST /v1/auto-accept-url with bad JSON returns 400', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/v1/auto-accept-url`, {
      method: 'POST',
      body: 'not-json',
    });
    assert.equal(r.status, 400);
  });
});

test('POST /v1/auto-accept-url without url returns 400', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/v1/auto-accept-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });
});

test('POST /v1/auto-accept-url returns 501 with install instructions when Playwright missing',
  { skip: HAS_PLAYWRIGHT },
  async () => {
    await withServer(async url => {
      const r = await fetch(`${url}/v1/auto-accept-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });
      assert.equal(r.status, 501);
      const body = await r.json();
      assert.ok(body.error.includes('Playwright'));
      assert.ok(body.error.includes('npm install playwright'));
      assert.ok(body.error.includes('npx playwright install chromium'));
    });
  }
);
