// The documentation site, the project pages, and the Markdown renderer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { render } from '../src/markdown.js';
import { pageSlugs, SECTIONS } from '../src/docs.js';
import { TOOLS } from '../src/mcp.js';

let app, base;
before(async () => {
  process.env.PUBLIC_URL = 'https://bountyhall.lol';
  app = createApp({ dbFile: ':memory:', sweepMs: 0 });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { delete process.env.PUBLIC_URL; app.server.closeAllConnections(); app.server.close(); });

const get = async (path) => { const r = await fetch(base + path); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };

test('every docs page renders, is in the sidebar, and has no unfilled placeholders', async () => {
  const inSidebar = new Set(SECTIONS.flatMap(([, s]) => s));
  for (const slug of pageSlugs()) {
    assert.ok(inSidebar.has(slug), `${slug} is missing from the sidebar`);
    const path = slug === 'introduction' ? '/docs' : `/docs/${slug}`;
    const page = await get(path);
    assert.equal(page.status, 200, path);
    assert.doesNotMatch(page.text, /\{\{\w+\}\}/, `${path} has an unfilled placeholder`);
    assert.match(page.text, /class="doc-nav"/);
    assert.match(page.text, /<link rel="canonical" href="https:\/\/bountyhall\.lol\/docs/);
    const raw = await get(`/docs/${slug}.md`);
    assert.equal(raw.status, 200);
    assert.match(raw.type, /text\/markdown/);
    assert.match(raw.text, /^# /);
    assert.doesNotMatch(raw.text, /\{\{\w+\}\}/);
  }
  assert.equal((await get('/docs/nope')).status, 404);
  assert.equal((await get('/docs/nope.md')).status, 404);
});

test('docs reflect the running server: URL, currency, fee and every MCP tool', async () => {
  const quick = (await get('/docs/quickstart.md')).text;
  assert.match(quick, /https:\/\/bountyhall\.lol\/solver\.md/);
  assert.match(quick, /1000 free test credits/);
  const concepts = (await get('/docs/concepts.md')).text;
  assert.match(concepts, /\(2\.5%\)/);
  const mcp = (await get('/docs/mcp.md')).text;
  for (const [name] of TOOLS) assert.match(mcp, new RegExp(`\\| \`${name}\` \\|`), `MCP docs miss ${name}`);
});

test('no broken internal links anywhere on the site', async () => {
  const start = ['/', '/about', '/rules', '/status', '/intents', '/agents', '/join', '/post', ...pageSlugs().map((s) => (s === 'introduction' ? '/docs' : `/docs/${s}`))];
  const seen = new Map();
  const queue = [...start];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const r = await get(path);
    seen.set(path, r.status);
    if (!/text\/html/.test(r.type || '')) continue;
    for (const [, href] of r.text.matchAll(/href="([^"]+)"/g)) {
      const url = href.replace(/&amp;/g, '&');
      if (!url.startsWith('/') || url.startsWith('//')) continue;
      const clean = url.split('#')[0].split('?')[0];
      if (!clean || /^\/(i|u)\//.test(clean)) continue; // per-record pages are covered elsewhere
      if (!seen.has(clean)) queue.push(clean);
    }
  }
  const broken = [...seen].filter(([, s]) => s >= 400);
  assert.deepEqual(broken, [], `broken links: ${JSON.stringify(broken)}`);
  assert.ok(seen.size > 25, `crawled ${seen.size} pages`);
});

test('about, rules and status pages; the public status API', async () => {
  const about = await get('/about');
  assert.equal(about.status, 200);
  assert.match(about.text, /not affiliated with, endorsed by, or speaking for musebook or Robinhood/);
  const rules = await get('/rules');
  assert.match(rules.text, /Test credits have no value/);
  const status = await get('/status');
  assert.match(status.text, /All systems operational/);
  const api = JSON.parse((await get('/api/status')).text);
  assert.equal(api.ok, true);
  assert.match(api.version, /^\d+\.\d+\.\d+$/);
  assert.equal(api.payments, null);
  const notFound = await get('/nowhere');
  assert.equal(notFound.status, 404);
  assert.match(notFound.text, /Nothing here/);
});

test('robots.txt, sitemap.xml and llms.txt', async () => {
  const robots = await get('/robots.txt');
  assert.match(robots.text, /Disallow: \/admin/);
  assert.match(robots.text, /Sitemap: https:\/\/bountyhall\.lol\/sitemap\.xml/);
  const sitemap = await get('/sitemap.xml');
  assert.match(sitemap.type, /xml/);
  assert.match(sitemap.text, /<loc>https:\/\/bountyhall\.lol\/docs\/api<\/loc>/);
  const llms = await get('/llms.txt');
  assert.match(llms.text, /^# Bountyhall/);
  assert.match(llms.text, /https:\/\/bountyhall\.lol\/docs\/mcp\.md/);
});

test('markdown renderer: structure, and nothing unsafe gets through', () => {
  const { html, title, headings } = render([
    '# Title', '', 'Text with **bold**, *em*, `a<b>` and [a link](/docs).', '',
    '## Section', '', '- one', '- two', '', '1. first', '2. second', '',
    '```js', 'const x = "<y>";', '```', '',
    '| a | b |', '| --- | --- |', '| `x|y` | 1 \\| 2 |', '',
    '> **Warning** careful', '', '## Section',
  ].join('\n'));
  assert.equal(title, 'Title');
  assert.deepEqual(headings.map((h) => h.id), ['section', 'section-1']);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <code>a&lt;b&gt;<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li>/);
  assert.match(html, /<code class="lang-js">const x = &quot;&lt;y&gt;&quot;;<\/code>/);
  assert.match(html, /<td><code>x\|y<\/code><\/td><td>1 \| 2<\/td>/);
  assert.match(html, /class="callout warning"/);
  const evil = render('<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](data:text/html,hi) <img src=x onerror=alert(1)>').html;
  assert.doesNotMatch(evil, /<script|<img|javascript:|data:text/);
  assert.match(evil, /&lt;script&gt;/);
});
