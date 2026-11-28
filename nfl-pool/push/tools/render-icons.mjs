// Renders the raster icons Pool Alerts needs from the existing SVG mark (run from the repository root with Playwright
// available: `node nfl-pool/push/tools/render-icons.mjs`). Android does not draw SVG notification icons and wants a
// separate white-on-transparent status-bar badge; iOS uses a PNG apple-touch-icon for the Home Screen app (and so for
// its notifications). The outputs are committed; rerun only if the mark changes.
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)('playwright');
import {readFileSync} from 'node:fs';

const root = new URL('../../', import.meta.url);
const mark = readFileSync(new URL('./assets/pool-center-icon-512.svg', root), 'utf8');
const shield = 'M256 78 401 134v126c0 91-54 157-145 197-91-40-145-106-145-197V134z';
const letterP = 'M166 174h88c31 0 53 20 53 50 0 30-22 50-53 50h-43v82h-45zm45 38v25h39c9 0 15-5 15-13s-6-12-15-12z';
// White shield with the "P" knocked out (even-odd fill): Android draws only the alpha channel of a badge.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#fff" fill-rule="evenodd" d="${shield} ${letterP.replace(/^M166 174/, 'M202 196')}"/></svg>`;

const jobs = [
  {file: 'pool-alerts-icon-192.png', size: 192, svg: mark, background: 'transparent'},
  {file: 'pool-center-touch-180.png', size: 180, svg: mark, background: '#07090d'},
  {file: 'pool-alerts-badge-96.png', size: 96, svg: badge, background: 'transparent'}
];
const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({viewport: {width: job.size, height: job.size}, deviceScaleFactor: 1});
    await page.setContent(`<html><body style="margin:0;background:${job.background}"><div style="width:${job.size}px;height:${job.size}px">${job.svg
      .replace(/width="\d+" height="\d+"/, '').replace('<svg ', `<svg width="${job.size}" height="${job.size}" `)}</div></body></html>`);
    await page.locator('div').screenshot({path: new URL(`./assets/${job.file}`, root).pathname, omitBackground: job.background === 'transparent'});
    await page.close();
    console.log(`wrote nfl-pool/assets/${job.file}`);
  }
} finally { await browser.close(); }
