// The README's showcase: a short tour of the demo, recorded as video, desktop and phone (demo/showcase.sh puts them
// side by side in one animated WebP). Runs with the site tests' Playwright: NODE_PATH=tests/site/node_modules node demo/showcase.js <url> <dir>
const { chromium, devices } = require('@playwright/test');

const [url = 'http://127.0.0.1:8899/', out = 'showcase'] = process.argv.slice(2);
const pause = (page, ms) => page.waitForTimeout(ms);

async function glide(page, to, ms = 1600) {  // a smooth scroll to y (or an element), ms long
  await page.evaluate(async ([target, dur]) => {
    const el = typeof target === 'string' ? document.querySelector(target) : null;
    const y = el ? el.getBoundingClientRect().top + scrollY - 70 : target;
    const from = scrollY, t0 = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        scrollTo(0, from + (y - from) * e);
        if (k < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }, [to, ms]);
}

async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(700);
}

async function tour(page, phone) {  // three stops, ~9 s: the overview, a player, the map
  await page.goto(url);
  await page.locator('#leaderboard').waitFor();
  await pause(page, 1300);                                   // the overview: totals, bosses
  await glide(page, '#leaderboard', 1500);                   // down to the leaderboard
  await pause(page, 900);
  await go(page, '#/p/Ragnar');                              // a player
  await pause(page, 1000);
  await glide(page, phone ? 900 : 650, 1100);
  await pause(page, 700);
  await go(page, '#/world');                                 // the map
  await glide(page, phone ? 380 : 260, 700);
  await pause(page, 1600);
}

(async () => {
  const browser = await chromium.launch();
  for (const [name, opts] of [['desktop', { viewport: { width: 1280, height: 760 } }], ['phone', devices['Pixel 7']]]) {
    const size = opts.viewport;
    const ctx = await browser.newContext({ ...opts, colorScheme: 'light', timezoneId: 'Europe/Berlin', locale: 'en-GB',
      recordVideo: { dir: `${out}/${name}`, size } });
    const page = await ctx.newPage();
    await tour(page, name === 'phone');
    await ctx.close();
    console.log(`${name}: ${await page.video().path()}`);
  }
  await browser.close();
})();
