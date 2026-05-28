// One-off diagnostic: hits /v1/clean-url against a list of real-world URLs,
// reports per-URL outcome. Helps tell static-detection failures from
// JS-rendered popups (which the static HTML simply doesn't contain).
const URLS = `https://www.bbc.com,https://www.reuters.com,https://www.cnn.com,https://www.npr.org,https://apnews.com,https://www.theguardian.com,https://www.nytimes.com,https://www.washingtonpost.com,https://www.theverge.com,https://techcrunch.com,https://arstechnica.com,https://www.wired.com,https://www.scientificamerican.com,https://www.nature.com,https://www.sciencedaily.com,https://www.espn.com,https://bleacherreport.com,https://www.sportingnews.com,https://www.imdb.com,https://www.rottentomatoes.com,https://variety.com,https://www.allrecipes.com,https://www.seriouseats.com,https://www.bonappetit.com,https://www.lonelyplanet.com,https://www.tripadvisor.com,https://www.medium.com,https://www.quora.com`.split(',');

const SERVER = process.env.SERVER || 'http://127.0.0.1:8790';
const CONCURRENCY = process.env.AUTO === '1' ? 2 : 6;  // Playwright is heavier
const TIMEOUT_MS = process.env.AUTO === '1' ? 60000 : 25000;
const ENDPOINT = process.env.AUTO === '1' ? '/v1/auto-accept-url' : '/v1/clean-url';

async function probe(url) {
  const start = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const ms = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let err = body;
      try { err = JSON.parse(body).error || body; } catch {}
      return { url, ok: false, status: res.status, error: err, ms };
    }
    const data = await res.json();
    const cats = {};
    const vendors = new Set();
    for (const r of data.removed) {
      cats[r.category] = (cats[r.category] || 0) + 1;
      if (r.vendor) vendors.add(r.vendor);
    }
    return {
      url,
      ok: true,
      removed: data.removed.length,
      cleanup: data.cleanup?.length || 0,
      clicked: data.clicked?.length || 0,
      clickedVendors: (data.clicked || []).map(c => c.vendor),
      categories: cats,
      vendors: [...vendors],
      htmlBytes: data.html.length,
      ms,
    };
  } catch (err) {
    clearTimeout(t);
    return { url, ok: false, error: err.message || String(err), ms: Date.now() - start };
  }
}

const results = [];
const queue = [...URLS];
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const url = queue.shift();
    const r = await probe(url);
    results.push(r);
    const clickedPart = r.clicked > 0 ? `clicked=${r.clicked}(${r.clickedVendors.join(',')}) ` : '';
    const tag = !r.ok ? `✗ ${r.status || 'ERR'} ${r.error?.slice(0, 60)}`
              : r.removed === 0 && r.clicked === 0 ? `○ ${clickedPart}0 removed (${r.htmlBytes}B, ${r.ms}ms)`
              : `✓ ${clickedPart}${r.removed} removed [${Object.entries(r.categories).map(([k,v]) => `${k}:${v}`).join(',')}]${r.vendors.length ? ' (' + r.vendors.join(',') + ')' : ''}`;
    console.error(`  ${url.padEnd(40)} → ${tag}`);
  }
});
await Promise.all(workers);

results.sort((a, b) => URLS.indexOf(a.url) - URLS.indexOf(b.url));
console.log(JSON.stringify(results, null, 2));
