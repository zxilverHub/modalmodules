import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/HttpServer.js';

async function withServer(fn) {
  const { server, url } = await startServer({ port: 0 });
  try { await fn(url); } finally { server.close(); }
}

test('GET /health returns ok', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });
});

test('POST /v1/clean removes ARIA modal from HTML body', async () => {
  await withServer(async url => {
    const html = '<html><body><main>Article</main><div role="dialog" aria-modal="true">x</div></body></html>';
    const r = await fetch(`${url}/v1/clean`, { method: 'POST', body: html });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.removed.length, 1);
    assert.ok(body.html.includes('Article'));
    assert.ok(!body.html.includes('role="dialog"'));
    assert.ok(typeof body.ms === 'number');
  });
});

test('POST /v1/clean?format=html returns raw HTML', async () => {
  await withServer(async url => {
    const html = '<html><body><div class="newsletter-signup-popup">x</div><main>ok</main></body></html>';
    const r = await fetch(`${url}/v1/clean?format=html`, { method: 'POST', body: html });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('x-modals-removed'), '1');
    const text = await r.text();
    assert.ok(text.includes('ok'));
    assert.ok(!text.includes('newsletter-signup-popup'));
  });
});

test('POST /v1/clean-url with bad JSON returns 400', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/v1/clean-url`, { method: 'POST', body: 'not-json' });
    assert.equal(r.status, 400);
  });
});

test('POST /v1/clean-url with non-http protocol returns 400', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/v1/clean-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    assert.equal(r.status, 400);
  });
});

test('OPTIONS preflight returns CORS headers', async () => {
  await withServer(async url => {
    const r = await fetch(`${url}/v1/clean`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
});

test('API key required when MODALMODULES_API_KEY is set', async () => {
  process.env.MODALMODULES_API_KEY = 'secret-123';
  try {
    await withServer(async url => {
      const unauth = await fetch(`${url}/v1/clean`, { method: 'POST', body: '<html></html>' });
      assert.equal(unauth.status, 401);

      const auth = await fetch(`${url}/v1/clean`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-123' },
        body: '<html><body>ok</body></html>',
      });
      assert.equal(auth.status, 200);

      // health is exempt
      const health = await fetch(`${url}/health`);
      assert.equal(health.status, 200);
    });
  } finally {
    delete process.env.MODALMODULES_API_KEY;
  }
});
