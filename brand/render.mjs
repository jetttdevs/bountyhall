// Renders the brand assets to PNG with Chromium (Playwright).
//   node brand/render.mjs      (needs playwright installed, globally is fine)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {
  ({ chromium } = createRequire(join(execSync('npm root -g').toString().trim(), '/'))('playwright'));
}
const browser = await chromium.launch();
async function shot(file, out, width, height, { transparent = false, scale = 1 } = {}) {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ignoreHTTPSErrors: true })).newPage();
  await page.goto(`file://${join(here, file)}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(here, out), omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  console.log('wrote', out);
}
await shot('logo-mark.svg', 'x-profile-400.png', 400, 400);
await shot('logo-mark.svg', 'logo-mark-1024.png', 512, 512, { scale: 2 });
await shot('src/wordmark.html', 'logo-wordmark.png', 1200, 300, { transparent: true });
await shot('src/x-header.html', 'x-header-1500x500.png', 1500, 500);
await shot('src/article-cover.html', 'article-cover-1600x640.png', 1600, 640);
await shot('src/how-it-works.html', 'article-how-it-works-1600x900.png', 1600, 900);
await browser.close();
