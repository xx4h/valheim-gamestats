// The page against an anonymized real data.json (fixture/, made with anonymize.py): every page it links to renders
// without an error, and the numbers that went wrong before add up.
const { test, expect } = require('@playwright/test');
const data = require('./fixture/data.json');

const players = [...new Set(data.sessions.map((s) => s.p))];

// Page errors, and console errors except missing images (icons, terrain and Steam pictures aren't in the fixture).
function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`); });
  return errors;
}

async function open(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function start(page, hash = '#/') {
  await page.goto(`/${hash}`);
  await expect(page.locator('main, #app').first()).not.toBeEmpty();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('every linked page renders', async ({ page }, info) => {
  const errors = watch(page);
  await start(page);
  // breadth first from the overview through every in-page link; one of each kind of detail page is plenty on a phone
  const limit = info.project.name === 'phone' ? 80 : 400;
  const seen = new Set(['#/']), queue = ['#/'];
  const kind = (h) => h.replace(/\?.*$/, '').replace(/^(#\/(?:p\/[^/]+|item|creature|fight|pet|ranking))\/.*$/, '$1');
  const kinds = new Map();
  while (queue.length && seen.size <= limit) {
    const hash = queue.shift();
    await open(page, hash);
    const links = await page.$$eval('a[href^="#/"]', (as) => as.map((a) => a.getAttribute('href')));
    for (const h of links) {
      const clean = h.replace(/([?&])card=[^&]*&?/, '$1').replace(/[?&]$/, '');
      if (seen.has(clean)) continue;
      const k = kind(clean);
      if ((kinds.get(k) || 0) >= (info.project.name === 'phone' ? 1 : 4)) continue;
      kinds.set(k, (kinds.get(k) || 0) + 1);
      seen.add(clean);
      queue.push(clean);
    }
  }
  expect(seen.size, 'pages reached').toBeGreaterThan(info.project.name === 'phone' ? 15 : 50);
  expect(errors).toEqual([]);
  console.log(`${info.project.name}: ${seen.size} pages`);
});

test('player pages: every tab, all time', async ({ page }) => {
  const errors = watch(page);
  await start(page);
  for (const p of players) {
    for (const tab of ['', '/activity', '/combat', '/gear', '/saga']) {
      await open(page, `#/p/${encodeURIComponent(p)}${tab}?range=all`);
      await expect(page.locator('h1').first()).toContainText(p);
    }
  }
  expect(errors).toEqual([]);
});

test('kills box counts every kill line of the player', async ({ page }) => {
  // the "kills box doesn't add up" bug: all time, the box is the plugin's kill lines, one per kill
  await start(page);
  for (const p of players) {
    const want = data.gather.filter((g) => g[1] === p && g[2] === 'kill').reduce((a, g) => a + g[4], 0);
    if (!want) continue;
    await open(page, `#/p/${encodeURIComponent(p)}/combat?range=all`);
    const box = page.locator('.kpi', { has: page.locator('.label', { hasText: /^Kills$/ }) }).first();
    await expect(box.locator('.value')).toHaveText(want.toLocaleString('en-GB'));
  }
});

test('damage dealt next to kills on the player page', async ({ page }) => {
  await start(page);
  for (const p of players) {
    const want = Math.round(data.gather.filter((g) => g[1] === p && g[2] === 'dmg').reduce((a, g) => a + g[4], 0));
    if (!want) continue;
    await open(page, `#/p/${encodeURIComponent(p)}?range=all`);
    const labels = await page.locator('.kpis').first().locator('.kpi .label').allTextContents();
    expect(labels[labels.indexOf('Kills') + 1]).toBe('Damage dealt');
    const box = page.locator('.kpi', { has: page.locator('.label', { hasText: /^Damage dealt$/ }) }).first();
    await expect(box.locator('.value')).toHaveText(want.toLocaleString('en-GB'));
  }
});

test('title and support link come from the data', async ({ page }) => {
  await start(page);
  await expect(page).toHaveTitle(new RegExp(data.title));
  await expect(page.locator('#support')).toBeVisible();
  await expect(page.locator('#support-link')).toHaveAttribute('href', data.support.url);
});

test('no support card without a link', async ({ page }) => {
  await page.route('**/c/state-*', async (route) => {  // the config is in the state file
    const body = await (await route.fetch()).json();
    delete body.support;
    await route.fulfill({ json: body });
  });
  await start(page);
  await expect(page.locator('#leaderboard')).toBeVisible();  // drawn from the data: hidden then means "not there", not "not yet"
  await expect(page.locator('#support')).toBeHidden();
});

test('leaderboard cells line up with its header', async ({ page }) => {
  await start(page);
  await expect(page.locator('#leaderboard thead th').last()).toHaveText('Last seen');
  // one snapshot of the table (it may redraw while we look): every row has a cell per column,
  // the last one being Last seen's online / ago badge
  await expect.poll(() => page.evaluate(() => {
    const n = document.querySelectorAll('#leaderboard thead th').length;
    const rows = [...document.querySelectorAll('#leaderboard tbody tr')];
    return rows.length > 0 && rows.every((tr) => tr.children.length === n && !!tr.lastElementChild.querySelector('.badge'));
  })).toBe(true);
});

test('no sideways scrolling', async ({ page }) => {
  await start(page);
  for (const hash of ['#/', '#/world', '#/base', '#/items', `#/p/${encodeURIComponent(players[0])}`]) {
    await open(page, hash);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, hash).toBeLessThanOrEqual(1);
  }
});

// ---- the data in pieces (collector/chunks.py, the loader in app.js)

test('the pieces join to exactly the data', async ({ page }) => {
  await start(page);
  // the page's own join, on the files as served (the page adds its own fields to what it draws, so not S.data)
  const got = await page.evaluate(async () => {
    const index = await (await fetch('index.json')).json();
    const files = await Promise.all(index.files.map(async (n) => (await fetch(`c/${n}`)).json()));
    return window.gamestats.join(files);
  });
  // the fixture is from before the rules were published: the chunks add the defaults (valheim_gamestats.chunks)
  const { scoring, ...rest } = got;
  expect(rest).toEqual(data);
  expect(Object.keys(scoring.rules.titles).length).toBeGreaterThan(80);
});

test('a poll fetches only what changed', async ({ page }) => {
  await start(page);
  const fetched = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.endsWith('.json')) fetched.push(u.pathname); });
  await page.click('#refresh');
  await expect.poll(() => fetched.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(fetched).toEqual(['/index.json']);  // nothing new: the index alone

  // a new minute: a new live file, nothing else
  const index = await (await page.request.get('/index.json')).json();
  const live = index.files[index.files.length - 1];
  const body = await (await page.request.get(`/c/${live}`)).json();
  await page.route('**/index.json', (route) => route.fulfill({ json: { ...index, generated: index.generated + 60,
    files: [...index.files.slice(0, -1), 'live-new.json'] } }));
  await page.route('**/c/live-new.json', (route) => route.fulfill({ json: { ...body, generated: body.generated + 60 } }));
  fetched.length = 0;
  await page.click('#refresh');
  await expect.poll(() => fetched).toEqual(['/index.json', '/c/live-new.json']);
  await expect.poll(() => page.evaluate(() => window.gamestats.data().generated)).toBe(data.generated + 60);
});


// The rules as a server with overrides publishes them (collector/valheim_gamestats/scoring.py): served instead of the
// defaults, the page must follow them everywhere — and say so on #/scoring.
async function withRules(page, change) {
  await page.route(/\/c\/scoring-[0-9a-f]+\.json$/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    change(json.scoring.rules, json.scoring.changed);
    await route.fulfill({ response, json });
  });
}

test('scoring: the default rules', async ({ page }) => {
  const errors = watch(page);
  await start(page, '#/scoring');
  await expect(page.locator('h1')).toHaveText('How scoring works');
  await expect(page.locator('.phead .meta')).toContainText('the default rules');
  for (const id of ['impact', 'titles', 'medals', 'milestones', 'badges', 'cards', 'traits', 'grades']) await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator('#impact')).toContainText('Playtime');
  await expect(page.locator('.changed')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('scoring: a server\'s own rules', async ({ page }) => {
  const errors = watch(page);
  await withRules(page, (r, changed) => {
    for (const k of Object.keys(r.impact.bonus)) r.impact.bonus[k] = 0;
    for (const k of Object.keys(r.impact.penalty)) r.impact.penalty[k] = 0;
    Object.assign(r.impact.bonus, { play: 50, found: 50 });
    delete r.titles.marathon;
    r.titles.streak.title = 'Unbroken';
    r.cards.tiers = { rare: 1, epic: 2, legendary: 3 };
    r.grades.min_hours = 100000;
    Object.assign(changed, { 'impact.bonus.play': 22, 'impact.bonus.found': 14, 'titles.marathon.enabled': true, 'titles.streak.title': 'Streak',
      'cards.tiers.rare': 25, 'grades.min_hours': 5 });
  });
  await start(page, '#/?range=all');
  const titles = page.locator('.card', { has: page.locator('h2', { hasText: /^Titles$/ }) });
  await expect(titles).toContainText('Unbroken');
  await expect(titles).not.toContainText('Marathon');
  // the impact column says what it weighs: only what this server counts
  await expect(page.locator('th[data-sort="impact"]')).toHaveAttribute('title', /contributed, 0–100: Playtime 50, Zones 50\. Bonuses/);
  // every card at its top rarity, nobody graded yet
  const p = players[0];
  await open(page, `#/p/${encodeURIComponent(p)}?range=all`);
  await expect(page.locator('.tcard')).toHaveClass(/legendary/);
  await expect(page.locator('.teacher')).toContainText('grades come after 100,000 h');
  await open(page, '#/scoring');
  await expect(page.locator('.phead .meta')).toContainText('6 rules set by this server');
  await expect(page.locator('#impact .changed').first()).toHaveAttribute('title', 'Set by this server · default: 22');
  await expect(page.locator('#titles')).toContainText('Unbroken');
  await expect(page.locator('#titles')).toContainText('Switched off on this server: marathon.');
  expect(errors).toEqual([]);
});

test('sidebar shortcuts follow the rule', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'the sidebar is the desktop navigation');
  await start(page);
  // every sidebar entry has one (g then <key>), keys are unique, and each is a letter of the entry's name
  const entries = await page.$$eval('#sidenav .sn-top, #sidenav .sn-sub > li > a.sn-link', (as) => as
    .filter((a) => !a.getAttribute('href').startsWith('#/p/')).map((a) => [a.textContent.trim(), a.title || '']));
  expect(entries.length).toBeGreaterThan(10);
  const keys = entries.map(([name, title]) => {
    const m = title.match(/\(g then (\w)\)$/);
    expect(m, `${name}: ${title}`).toBeTruthy();
    expect(name.toLowerCase()).toContain(m[1]);
    return m[1];
  });
  expect(new Set(keys).size).toBe(keys.length);
  expect(Object.fromEntries(entries.map(([n], i) => [n, keys[i]]))).toMatchObject({ Overview: 'o', Players: 'p', Leaderboard: 'l', Scoring: 'g' });
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await expect(page.locator('h1')).toHaveText('How scoring works');
});

test('long explanations fold behind an i', async ({ page }) => {
  const errors = watch(page);
  await start(page, '#/?range=all');
  // the Titles card's subtitle is long: folded, one click shows it, another hides it
  const titles = page.locator('.card', { has: page.locator('h2', { hasText: /^Titles$/ }) });
  const hint = titles.locator('.card-head > .hint'), btn = titles.locator('.info-btn');
  await expect(hint).toBeHidden();
  await btn.click();
  await expect(hint).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await btn.click();
  await expect(hint).toBeHidden();
  // short ones that fit stay as they are; every folded text has its button
  for (const c of await page.locator('#view .card').all()) {
    const h = c.locator(':scope > .card-head > .hint');
    if (await h.count() && await h.isVisible()) expect((await h.textContent()).length).toBeLessThanOrEqual(90);
    if (await c.locator('.explain:not(.keep), :scope > .card-head > .hint').evaluateAll((ns) => ns.some((n) => n.hidden))) {
      await expect(c.locator('.info-btn')).toHaveCount(1);
    }
  }
  // the scoring page's explanations are its content: not folded
  await open(page, '#/scoring');
  await expect(page.locator('#impact .explain').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('a long server name wraps, then ends in …', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'the header squeezes the name only on a phone');
  const long = 'The Mead Hall of the Northern Wolves — Ragnar, Astrid and friends';
  await page.route('**/c/state-*', async (route) => {  // the title is in the state file
    const body = await (await route.fetch()).json();
    body.title = long;
    await route.fulfill({ json: body });
  });
  await start(page);
  await expect(page.locator('#leaderboard')).toBeVisible();
  const t = page.locator('#title');
  await expect(t).toHaveText(long);
  const box = await t.evaluate((n) => ({ h: n.clientHeight, sh: n.scrollHeight, lh: parseFloat(getComputedStyle(n).lineHeight),
    w: n.scrollWidth, cw: n.clientWidth }));
  expect(Math.round(box.h / box.lh)).toBe(2);   // two lines …
  expect(box.sh).toBeGreaterThan(box.h);        // … and the rest cut off (the ellipsis)
  expect(box.w).toBeLessThanOrEqual(box.cw + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // a short one stays on one line
  await page.evaluate(() => { document.getElementById('title').textContent = 'My Valheim'; });
  expect(await t.evaluate((n) => Math.round(n.clientHeight / parseFloat(getComputedStyle(n).lineHeight)))).toBe(1);
});

test('unaccounted kills: their own page, never a player', async ({ page }) => {
  const errors = watch(page);
  let added = false;
  await page.route('**/c/*', async (route) => {  // the plugin's `ukill` rows have no player
    const body = await (await route.fetch()).json();
    if (!added && Array.isArray(body.gather) && body.gather.length) {
      added = true;
      const t = Math.max(...body.gather.map((g) => g[0]));
      body.gather.push([t, '', 'ukill', 'Tick', 2], [t, '', 'ukill', 'Goblin/GoblinArcher*1', 1], [t - 3600, '', 'ukill', 'Dverger', 1],
        [t, '', 'udmg', 'Gjall', 249]);
    }
    await route.fulfill({ json: body });
  });
  await start(page, '#/unaccounted');
  await expect(page.getByRole('heading', { name: 'Unaccounted kills' }).first()).toBeVisible();
  await expect(page.locator('.kpis').first()).toContainText('deaths nobody could be credited with');
  await expect(page.locator('.kpis .kpi').first()).toContainText('4');
  await expect(page.getByText(/ or /).first()).toBeVisible();  // a shared ragdoll: every kind it can be
  await expect(page.locator('a[href^="#/creature/Tick"]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Damage nobody could be credited with' })).toBeVisible();
  await expect(page.locator('.kpis').first()).toContainText('249');
  await expect(page.locator('a[href^="#/p/"]').filter({ hasText: /^$/ })).toHaveCount(0);  // no empty player anywhere
  await open(page, '#/');
  await expect(page.locator('#sidenav a[href="#/unaccounted"], nav a[href="#/unaccounted"]').first()).toBeAttached();
  expect(errors).toEqual([]);
});

test('summons: by race and type on the player page', async ({ page }) => {
  const errors = watch(page);
  const p = players[0];
  let added = false;
  await page.route('**/c/*', async (route) => {
    const body = await (await route.fetch()).json();
    if (!added && Array.isArray(body.gather) && body.gather.length) {
      added = true;
      const t = Math.max(...body.gather.map((g) => g[0]));
      body.gather.push([t, p, 'sdw', 'Skeleton_Friendly:skeleton_sword2+ShieldWood>Bonemass', 595],
        [t, p, 'skw', 'Skeleton_Friendly:skeleton_sword2+ShieldWood>Bonemass', 1], [t, p, 'sdw', 'Skeleton_Friendly:skeleton_bow>Neck', 30]);
    }
    await route.fulfill({ json: body });
  });
  await start(page, `#/p/${encodeURIComponent(p)}/combat`);
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Summons' }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Best:');
  await expect(card.locator('tbody tr')).toHaveCount(2);  // two variants, the creatures they hit summed
  expect(errors).toEqual([]);
});
