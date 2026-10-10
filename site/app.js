/* gamestats — static stats page. Reads the collector's data (index.json and the
   files it names, see fetchData; refreshed every minute) and renders everything
   client-side, so the range slider can re-slice without another request. No
   dependencies. */
'use strict';
(() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const HOUR = 3600, DAY = 86400;
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const SLOTS = 8;

  const S = {
    data: null, min: 0, max: 0, a: 0, b: 0, preset: 30,
    trail: [], restoreY: null,  // pages clicked through, for the back links (trailStep)
    card: null, pin: null, sections: [], seen: new Map(), infoOpen: new Set(), killers: null, navAll: false, sheetK: null, since: undefined,  // card linked to (URL) and held in place, cards on this page, sidebar/sheet state
    petF: { status: '', named: '', kind: '', saddle: false }, petSt: { key: 'name', asc: true, q: '', limit: 100 },  // the pets table's filters
    lb: { key: 'impact', asc: false, q: '' },
    feed: { q: '', types: new Set(['login', 'logout', 'death', 'raid', 'progress', 'restart', 'day']), limit: 120 },
    sess: { limit: 25 },
    sl: { key: 's', asc: false, q: '', limit: 50 },
    itemsSort: { key: 'stored', asc: false, q: '', limit: 60 },
    rq: '',
    focus: null,
    maps: {},
    tables: {},  // sortable tables' sort / search / limit by page + columns, so a redraw or reload keeps them
    players: [], color: new Map(), raidColor: new Map(),
  };

  // ------------------------------------------------------------------ dom

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    applyAttrs(n, attrs);
    append(n, kids);
    return n;
  }
  function sv(tag, attrs, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    applyAttrs(n, attrs);
    append(n, kids);
    return n;
  }
  function applyAttrs(n, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  function append(n, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  const $ = (s) => document.querySelector(s);

  // ------------------------------------------------------------------ time

  let TZ = 'UTC';
  // What counts how much (impact, titles, badges, cards, traits, grades, milestones): scoring.json with this server's
  // overrides, published by the collector with the data (collector/valheim_gamestats/scoring.py, docs/SCORING.md).
  const SC = () => S.data.scoring.rules;
  const scoringLink = (part) => el('a', { class: 'more-link', href: `#/scoring?card=${part}`, text: 'How it works →' });
  const fmts = new Map();
  function fmt(opts) {
    const k = JSON.stringify(opts);
    if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }));
    return fmts.get(k);
  }
  const fDateTime = (t) => fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t * 1000);
  const fDate = (t) => fmt({ day: 'numeric', month: 'short' }).format(t * 1000);
  const fDateY = (t) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(t * 1000);
  const fTime = (t) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t * 1000);

  // Local calendar parts of the hour starting at UTC-hour-aligned t. All
  // aggregation splits at whole UTC hours, which are also local hour
  // boundaries for every whole-hour-offset zone (Europe/Berlin included).
  const partCache = new Map();
  function hourParts(t) {
    let p = partCache.get(t);
    if (p) return p;
    const o = {};
    for (const x of fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(t * 1000)) o[x.type] = x.value;
    p = { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24, dow: DOW.indexOf(o.weekday) };
    partCache.set(t, p);
    return p;
  }
  // Local day key of t, and the first instant of a local day key ("2026-10-03") in TZ.
  const dayOf = (t) => hourParts(Math.floor(t / HOUR) * HOUR).day;
  function dayStart(key) {
    const [y, m, d] = key.split('-').map(Number);
    const utc = Date.UTC(y, m - 1, d) / 1000;
    for (let h = -15; h <= 15; h++) if (hourParts(utc + h * HOUR).day === key) return utc + h * HOUR;
    return utc;
  }
  // Calls cb(hourStart, seconds) for each hour slice of [s, e).
  function eachHour(s, e, cb) {
    let h = Math.floor(s / HOUR) * HOUR;
    while (h < e) {
      const x = Math.max(s, h), y = Math.min(e, h + HOUR);
      if (y > x) cb(h, y - x);
      h += HOUR;
    }
  }
  // Local days intersecting [a, b): [{key, t (first hour of the day ≥ a)}]
  function daysIn(a, b) {
    const out = [];
    let last = null;
    for (let h = Math.floor(a / HOUR) * HOUR; h < b; h += HOUR) {
      const k = hourParts(h).day;
      if (k !== last) { out.push({ key: k, t: Math.max(h, a) }); last = k; }
    }
    return out;
  }

  // ------------------------------------------------------------------ format

  function fH(sec) {
    const h = sec / HOUR;
    if (h === 0) return '0 h';
    if (h < 10) return `${h.toFixed(1)} h`;
    return `${Math.round(h).toLocaleString('en-GB')} h`;
  }
  function fDur(sec) {
    if (sec < 60) return `${Math.round(sec)} s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`;
  }
  function fAgo(sec) {
    if (sec < 90) return 'just now';
    if (sec < 90 * 60) return `${Math.round(sec / 60)} min ago`;
    if (sec < 36 * HOUR) return `${Math.round(sec / HOUR)} h ago`;
    return `${Math.round(sec / DAY)} days ago`;
  }
  const nf = (n, d = 0) => n.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
  const plural = (n, w, ws) => `${nf(n)} ${n === 1 ? w : (ws || w + 's')}`;

  const RAIDS = {
    army_eikthyr: 'Eikthyr rallies the creatures of the forest',
    army_theelder: 'The forest is moving…',
    army_bonemass: 'A foul smell from the swamp',
    army_moder: 'A cold wind blows from the mountains',
    army_goblin: 'The horde is attacking',
    army_gjall: 'You hear a distant roar',
    army_seekers: 'They sought you out',
    army_charred: 'The dead march',
    foresttrolls: 'The ground is shaking',
    skeletons: 'Skeleton surprise',
    blobs: 'A foul smell from the swamp',
    surtlings: 'There\'s a smell of sulfur in the air',
    wolves: 'You are being hunted',
    bats: 'You stirred the cauldron',
    hildirboss1: 'Hildir\'s quest', hildirboss2: 'Hildir\'s quest', hildirboss3: 'Hildir\'s quest',
  };
  const raidName = (n) => RAIDS[n] || n.replace(/_/g, ' ');
  // [{k: message, v: count, title: raw ids}] sorted by count
  function raidTypes(raids) {
    const m = new Map();
    for (const r of raids) {
      const e = m.get(raidName(r.n)) || { k: raidName(r.n), v: 0, ids: new Set() };
      e.v += 1; e.ids.add(r.n); m.set(e.k, e);
    }
    return [...m.values()].map((e) => ({ k: e.k, v: e.v, title: `Raid id: ${[...e.ids].join(', ')}` })).sort((x, y) => y.v - x.v);
  }

  const BIOMES = [
    ['Meadows', /^(WoodHouse|WoodFarm|WoodVillage|Dolmen|Runestone_Meadows|Runestone_Boars|Eikthyrnir|StartTemple|StoneCircle|ShipSetting|Meteorite)/],
    ['Black Forest', /^(Crypt|StoneTowerRuins|StoneHouse|TrollCave|Greydwarf_camp|Runestone_Greydwarfs|Runestone_BlackForest|GDKing|Ruin\d|BearCave|Vendor_BlackForest|Grave|CombatRuin|BigRockClearing|Hildir_camp|MineCave)/],
    ['Swamp', /^(SunkenCrypt|SwampHut|InfestedTree|Runestone_Swamps|Runestone_Draugr|SwampRuin|SwampWell|FireHole|Bonemass|BogWitch)/],
    ['Mountain', /^(DrakeNest|Waymarker|MountainCave|DrakeLorestone|MountainGrave|AbandonedLogCabin|MountainWell|Dragonqueen|Runestone_Mountains|Hildir_cave)/],
    ['Plains', /^(GoblinCamp|TarPit|StoneHenge|Goblinking|Runestone_Plains|Hildir_plainsfortress|PlainsFortress)/],
    ['Mistlands', /^(Mistlands|Dvergr|TheQueen|Runestone_Mistlands|Giant)/],
    ['Ashlands', /^(Ashland|CharredFortress|FaderLocation|Runestone_Ashlands|MorgenHole|LeviathanLava|VoltureNest|PlaceofMystery)/],
    ['Ocean', /^ShipWreck/],
  ];
  const AMBIGUOUS = /^(Dolmen|Grave|Ruin\d|CombatRuin|BigRockClearing)/;
  function biomeOf(z) {
    let fallback = null;
    for (const loc of z.l) {
      const b = BIOMES.find(([, re]) => re.test(loc));
      if (!b) continue;
      if (!AMBIGUOUS.test(loc)) return b[0];
      fallback = fallback || b[0];
    }
    return fallback || 'Unknown';
  }
  const prettyLoc = (l) => l.replace(/_/g, ' ').replace(/(\D)(\d+)$/, '$1');

  // ------------------------------------------------------------------ tooltip

  const tt = () => $('#tt');
  const HOVER = matchMedia('(hover: none)').matches ? 'tap' : 'hover';  // for "hover for details" hints
  function tip(evt, ...nodes) {
    const t = tt();
    t.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
    t.hidden = false;
    let x, y;
    if (evt.clientX != null && evt.type !== 'focus') { x = evt.clientX; y = evt.clientY; }
    else { const r = evt.target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top; }
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    t.style.left = `${Math.max(8, left)}px`;
    t.style.top = `${Math.max(8, top)}px`;
  }
  const untip = () => { tt().hidden = true; };
  const tRow = (color, value, label) => el('div', { class: 'row' },
    color ? el('i', { class: 'k', style: { background: color } }) : null, el('b', { text: value }), label ? el('span', { text: label }) : null);
  function hoverable(node, fn) {
    node.setAttribute('tabindex', '0');
    node.classList.add('hov');
    node.addEventListener('pointermove', (e) => tip(e, fn()));
    node.addEventListener('pointerleave', untip);
    node.addEventListener('focus', (e) => tip(e, fn()));
    node.addEventListener('blur', untip);
  }

  // ------------------------------------------------------------------ data

  function load(data) {
    S.data = data;
    TZ = data.tz || 'UTC';
    fmts.clear(); partCache.clear();
    const now = data.generated;
    for (const s of data.sessions) s.end_t = s.e == null ? now : s.e;
    S.min = Math.floor(data.first / HOUR) * HOUR;
    S.max = Math.ceil(now / HOUR) * HOUR;

    // Colour follows the player, ranked by all-time playtime — the range
    // slider never repaints anyone.
    const tot = new Map();
    for (const s of data.sessions) tot.set(s.p, (tot.get(s.p) || 0) + s.end_t - s.s);
    S.players = [...tot.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p);
    S.color.clear();
    S.players.forEach((p, i) => S.color.set(p, i < SLOTS ? `var(--s${i + 1})` : 'var(--other)'));
    // Raid types: colour by all-time frequency, so the range never repaints
    // them. Only three slots — raid markers share one strip, where every pair
    // of colours can meet; rarer types share "other".
    const rc = new Map();
    for (const r of data.raids) rc.set(raidName(r.n), (rc.get(raidName(r.n)) || 0) + 1);
    S.raidColor = new Map([...rc].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k], i) => [k, `var(--s${i + 1})`]));
    skillModel(data);
  }
  const raidColor = (n) => S.raidColor.get(raidName(n)) || 'var(--other)';
  // The log has no raid end, so "during" is approximated as the first 5 minutes.
  const deathsAfter = (r) => S.data.deaths.filter((d) => d.t >= r.t && d.t < r.t + 300).length;

  // ---- skill loss on death, as the game does it (values read from the Player prefab):
  // every skill loses 5 % (m_DeathLowerFactor) × the world's SkillReductionRate of its
  // current level — unless the previous death was < 600 s of play ago (m_hardDeathCooldown;
  // the timer only runs while the character is in the game). "deathskillsreset" wipes all.
  const GRACE = 600;
  function skillModel(data) {
    const keys = data.world?.keys || [];
    const rate = keys.find((k) => k.startsWith('skillreductionrate '));
    S.skillLoss = keys.includes('deathskillsreset') ? 1 : 0.05 * (rate ? parseFloat(rate.split(' ')[1]) / 100 : 1);
    const byP = new Map();
    for (const se of data.sessions) (byP.get(se.p) || byP.set(se.p, []).get(se.p)).push(se);
    const online = (p, a, b) => (byP.get(p) || []).reduce((n, se) => n + Math.max(0, Math.min(b, se.end_t) - Math.max(a, se.s)), 0);
    const last = new Map();
    for (const d of [...data.deaths].sort((x, y) => x.t - y.t)) {
      const prev = last.get(d.p);
      d.since = prev == null ? Infinity : online(d.p, prev, d.t);
      d.hard = d.since > GRACE;
      last.set(d.p, d.t);
    }
  }
  // share of every skill gone after n penalised deaths (compounding)
  const drain = (n) => 1 - (1 - S.skillLoss) ** n;
  const pct = (x) => `${(x * 100).toLocaleString('en-GB', { maximumFractionDigits: x < 0.1 ? 1 : 0 })} %`;
  const LOSS_EXPLAIN = () => el('p', { class: 'explain', text: `Dying lowers every skill by ${pct(S.skillLoss)} of its current level — unless the same character died less than 10 minutes of playtime before (a free “soft death”). Skill levels are stored on each player’s PC, so this shows the share lost, not XP: “drain” is how much of every skill the penalised deaths would take if they happened back to back (1 − ${nf(1 - S.skillLoss, 2)}ⁿ).` });
  function lossStats(deaths) {
    const m = new Map();
    for (const d of deaths) {
      const e = m.get(d.p) || { p: d.p, n: 0, hard: 0, soft: 0 };
      e.n += 1; d.hard ? (e.hard += 1) : (e.soft += 1);
      m.set(d.p, e);
    }
    return [...m.values()].map((e) => ({ ...e, drain: drain(e.hard) })).sort((a, b) => b.drain - a.drain || b.n - a.n);
  }
  const colorOf = (p) => S.color.get(p) || 'var(--other)';

  // Everything the views need for [a, b), optionally narrowed to one player.
  function compute(a, b, only) {
    const d = S.data;
    const ses = [];
    for (const s of d.sessions) {
      if (only && s.p !== only) continue;
      const x = Math.max(s.s, a), y = Math.min(s.end_t, b);
      if (y > x) ses.push({ p: s.p, s: x, e: y, src: s });
    }
    const deaths = d.deaths.filter((x) => x.t >= a && x.t < b && (!only || x.p === only));
    const raids = d.raids.filter((x) => x.t >= a && x.t < b && (!only || x.players.includes(only)));

    const per = new Map();
    const P = (p) => {
      if (!per.has(p)) per.set(p, { p, play: 0, sessions: 0, longest: 0, deaths: 0, days: new Set() });
      return per.get(p);
    };
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const daily = new Map(); // dayKey -> Map(player -> sec)
    for (const s of ses) {
      const r = P(s.p);
      const dur = s.e - s.s;
      r.play += dur; r.sessions += 1; r.longest = Math.max(r.longest, dur);
      eachHour(s.s, s.e, (h, sec) => {
        const hp = hourParts(h);
        heat[hp.dow][hp.hour] += sec;
        if (!daily.has(hp.day)) daily.set(hp.day, new Map());
        const m = daily.get(hp.day);
        m.set(s.p, (m.get(s.p) || 0) + sec);
        r.days.add(hp.day);
      });
    }
    for (const x of deaths) P(x.p).deaths += 1;
    // Plugin events, summed per hour: [hour, player, pick|loot|fell|mine|…, prefab, n].
    for (const [t, p, e, i, n] of d.gather || []) {
      if (t < a || t >= b || (only && p !== only) || !per.has(p)) continue;
      const r = per.get(p);
      const key = { dist: 'dist', crouch: 'crouch', exh: 'exh', exhn: 'exhn', emote: 'emotes', bed: 'beds', pick: 'picked', loot: 'looted', fell: 'felled', mine: 'mined', kill: 'kills', dmg: 'dealt', taken: 'taken', hit: 'hitsTaken', cost: 'paid', sdw: 'sdealt', skw: 'skills', wkill: 'wkills', wdmg: 'wdealt', kw: 'kwc', dw: 'dwc' }[e];
      if (!key) continue;
      r[key] = (r[key] || 0) + n;
      (r.gathered ||= {})[key] ||= new Map();
      r.gathered[key].set(i, (r.gathered[key].get(i) || 0) + n);
    }
    // body & movement (plugin Vitals.cs): the highest value per hour, and single feats [t, p, sprint|closecall|fall, value, extra]
    for (const [t, p, k, v] of d.peaks || []) {
      if (t < a || t >= b || (only && p !== only) || !per.has(p)) continue;
      const r = per.get(p);
      r.peak ||= {};
      if (!(r.peak[k] >= v)) r.peak[k] = v;
      if (k === 'hp') r.hpmax = r.peak.hp;
    }
    for (const f of d.feats || []) {
      if (f[0] < a || f[0] >= b || (only && f[1] !== only) || !per.has(f[1])) continue;
      (per.get(f[1]).feats ||= []).push(f);
    }
    const rows = [...per.values()].filter((r) => r.play > 0 || r.deaths > 0);
    const total = rows.reduce((n, r) => n + r.play, 0);

    // Concurrency step function.
    const ev = [];
    for (const s of ses) { ev.push([s.s, 1]); ev.push([s.e, -1]); }
    ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const conc = [[a, 0]];
    let n = 0, peak = 0, peakT = null;
    for (const [t, k] of ev) {
      n += k;
      if (conc[conc.length - 1][0] === t) conc[conc.length - 1][1] = n; else conc.push([t, n]);
      if (n > peak) { peak = n; peakT = t; }
    }

    const zones = d.zones.filter((z) => z.t >= a && z.t < b && (!only || z.by.includes(only)));
    return { a, b, ses, deaths, raids, rows, total, heat, daily, conc, peak, peakT, zones, only };
  }

  function playerAllTime(p) {
    const ss = S.data.sessions.filter((s) => s.p === p);
    if (!ss.length) return null;
    return {
      first: Math.min(...ss.map((s) => s.s)),
      last: Math.max(...ss.map((s) => s.end_t)),
      online: S.data.online.includes(p),
      total: ss.reduce((n, s) => n + s.end_t - s.s, 0),
    };
  }

  // ------------------------------------------------------------------ chart helpers

  function width(host) { return Math.max(260, Math.floor(host.clientWidth || host.parentNode.clientWidth || 600)); }
  function niceMax(v, ticks = 4) {
    if (v <= 0) return { max: 1, step: 1 };
    const raw = v / ticks;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    return { max: Math.ceil(v / step) * step, step };
  }
  // Column with a 4px rounded data-end, square at the baseline.
  function colPath(x, y, w, h, r = 4) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function timeTicks(a, b, w) {
    const span = b - a, target = Math.max(2, Math.floor(w / 95));
    const steps = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720].map((h) => h * HOUR);
    const step = steps.find((s) => span / s <= target) || steps[steps.length - 1];
    const out = [];
    if (step < DAY) {
      const sh = step / HOUR;
      for (let h = Math.ceil(a / HOUR) * HOUR; h <= b; h += HOUR) {
        const p = hourParts(h);
        if (p.hour % sh === 0) out.push({ t: h, label: p.hour === 0 ? fDate(h) : `${String(p.hour).padStart(2, '0')}:00`, major: p.hour === 0 });
      }
    } else {
      const sd = step / DAY;
      let i = 0;
      for (let h = Math.ceil(a / HOUR) * HOUR; h <= b; h += HOUR) {
        if (hourParts(h).hour !== 0) continue;
        if (i++ % sd === 0) out.push({ t: h, label: sd >= 7 ? fDate(h) : `${DOW[hourParts(h).dow]} ${fDate(h)}`, major: true });
      }
    }
    return out;
  }
  function empty(host, msg) { host.replaceChildren(el('div', { class: 'empty-state', text: msg })); }
  function legend(items, kind = 'sw') {
    return el('div', { class: 'legend' }, items.map(([name, color]) =>
      el('span', { class: 'key' }, el('i', { class: kind, style: { background: color } }), name)));
  }
  function dataTable(head, rows) {
    return el('details', { class: 'tv' }, el('summary', { text: 'Show as table' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, head.map((h, i) => el('th', { class: i ? 'r' : null, text: h })))),
        el('tbody', null, rows.map((r) => el('tr', null, r.map((c, i) => el('td', { class: i ? 'r' : null, text: c }))))))));
  }

  // ---- activity timeline: concurrency band + one swimlane per player
  // At most this much fits the card; longer ranges scroll sideways, starting at the end.
  const TL_SPAN = 72 * HOUR;
  function timeline(host, c) {
    const W = width(host);
    const lanes = [...c.rows].filter((r) => r.play > 0).sort((x, y) => S.players.indexOf(x.p) - S.players.indexOf(y.p));
    if (!lanes.length) return empty(host, 'Nobody played in this range.');
    const gutter = W < 560 ? 84 : 124, right = 10;
    const bandH = 92, laneH = 24, top = 8, gap = 18, axisH = 22;
    const H = top + bandH + gap + lanes.length * laneH + axisH;
    const span = c.b - c.a, viewW = Math.max(60, W - gutter - right);
    const PW = span > TL_SPAN ? Math.round((viewW * span) / TL_SPAN) : viewW;  // plot width
    const x = (t) => ((t - c.a) / span) * PW;
    const ny = niceMax(Math.max(1, c.peak), Math.min(4, Math.max(1, c.peak)));
    const y = (n) => top + bandH - (n / ny.max) * bandH;
    // labels stay put in their own svg; the plot scrolls
    const side = sv('svg', { class: 'tl-side', width: gutter, height: H, viewBox: `0 0 ${gutter} ${H}`, 'aria-hidden': 'true' });
    const svg = sv('svg', { width: PW + right, height: H, viewBox: `0 0 ${PW + right} ${H}`, role: 'img', 'aria-label': 'Players online over time and sessions per player' });

    const ticks = timeTicks(c.a, c.b, PW);
    const plotBottom = H - axisH;
    for (const tk of ticks) {
      svg.append(sv('line', { class: 'gl', x1: x(tk.t), x2: x(tk.t), y1: top, y2: plotBottom }));
      svg.append(sv('text', { class: 'ax', x: Math.min(Math.max(x(tk.t), 14), PW - 14), y: H - 6, 'text-anchor': 'middle', text: tk.label }));
    }
    for (let v = ny.step; v <= ny.max; v += ny.step) {
      svg.append(sv('line', { class: 'gl', x1: 0, x2: PW, y1: y(v), y2: y(v) }));
      side.append(sv('text', { class: 'ax', x: gutter - 8, y: y(v) + 4, 'text-anchor': 'end', text: nf(v) }));
    }
    side.append(sv('text', { class: 'ax-ink', x: 0, y: top + 14, text: 'Online' }));
    svg.append(sv('line', { class: 'bl', x1: 0, x2: PW, y1: y(0), y2: y(0) }));

    // step area
    let dPath = `M${x(c.a)},${y(0)}`;
    for (const [t, n] of c.conc) dPath += `H${x(t)}V${y(n)}`;
    dPath += `H${x(c.b)}`;
    svg.append(sv('path', { d: `${dPath}V${y(0)}Z`, style: { fill: 'var(--s1)', fillOpacity: 0.12 } }));
    svg.append(sv('path', { d: dPath, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', style: { stroke: 'var(--s1)' } }));

    // raids
    for (const r of c.raids) {
      const g = sv('g', null,
        sv('line', { x1: x(r.t), x2: x(r.t), y1: top, y2: y(0), 'stroke-width': 1, style: { stroke: 'var(--critical)', strokeOpacity: 0.5 } }),
        sv('path', { d: `M${x(r.t) - 5},${top}h10l-5,7z`, style: { fill: 'var(--critical)' } }),
        sv('rect', { x: x(r.t) - 9, y: top - 4, width: 18, height: 16, fill: 'transparent' }));
      hoverable(g, () => [el('div', { class: 't', text: fDateTime(r.t) }), tRow(null, 'Raid', raidName(r.n)),
        el('div', { class: 'note', text: r.players.length ? `Online: ${r.players.join(', ')}` : 'Nobody online' })]);
      svg.append(g);
    }

    // world progress: altars, biomes, bosses, milestones. Bosses/milestones are only known
    // to the save window, which gets a faint span; markers dodge each other downwards.
    const prog = progressEvents(c.a, c.b, c.only);
    const lastX = [];
    for (const ev of prog) {
      const k = PROGRESS[ev.kind], cx = x(ev.t);
      let row = lastX.findIndex((lx) => cx - lx >= 12);
      if (row < 0) row = Math.min(lastX.length, 4);
      lastX[row] = cx;
      const cy = top + 18 + row * 12;
      const g = sv('g', null);
      if (ev.from != null && x(ev.t) - x(Math.max(ev.from, c.a)) > 2) {
        g.append(sv('rect', { x: x(Math.max(ev.from, c.a)), y: top, width: x(ev.t) - x(Math.max(ev.from, c.a)), height: y(0) - top,
          style: { fill: k.color, fillOpacity: 0.1 } }));
      }
      g.append(sv('line', { x1: cx, x2: cx, y1: top, y2: plotBottom, 'stroke-width': 1, 'stroke-dasharray': '3 3', style: { stroke: k.color, strokeOpacity: 0.6 } }),
        sv('circle', { cx, cy, r: 5, 'stroke-width': 2, style: { fill: k.color, stroke: 'var(--surface)' } }),
        sv('rect', { x: cx - 9, y: cy - 9, width: 18, height: 18, fill: 'transparent' }));
      hoverable(g, () => [el('div', { class: 't', text: ev.when || fDateTime(ev.t) }), tRow(k.color, ev.txt),
        el('div', { class: 'note', text: ev.players.length ? `${ev.from != null ? 'Online' : 'By'}: ${ev.players.join(', ')}` : 'World generation' })]);
      svg.append(g);
    }

    // lanes
    const laneTop = top + bandH + gap;
    lanes.forEach((r, i) => {
      const ly = laneTop + i * laneH;
      if (i % 2 === 0) svg.append(sv('rect', { x: 0, y: ly, width: PW, height: laneH, rx: 4, style: { fill: 'var(--surface-2)', fillOpacity: 0.6 } }));
      const label = sv('text', { class: 'ax-ink lane-link', x: 0, y: ly + laneH / 2 + 4, text: r.p.length > 16 ? r.p.slice(0, 15) + '…' : r.p,
        onclick: () => go(r.p) });
      side.append(sv('circle', { cx: gutter - 10, cy: ly + laneH / 2, r: 4, style: { fill: colorOf(r.p) } }), label);
    });
    side.removeAttribute('aria-hidden');  // lane names are links
    for (const s of c.ses) {
      const i = lanes.findIndex((r) => r.p === s.p);
      const ly = laneTop + i * laneH + 5;
      svg.append(sv('rect', { x: x(s.s), y: ly, width: Math.max(2, x(s.e) - x(s.s)), height: laneH - 10, rx: 3, style: { fill: colorOf(s.p) } }));
    }
    for (const dth of c.deaths) {
      const i = lanes.findIndex((r) => r.p === dth.p);
      if (i < 0) continue;
      const ly = laneTop + i * laneH;
      svg.append(sv('path', { d: `M${x(dth.t)},${ly + 2}l3,3l-3,3l-3,-3z`, style: { fill: 'var(--ink)' } }));
    }

    // crosshair layer
    const xh = sv('line', { class: 'xh', y1: top, y2: plotBottom, visibility: 'hidden' });
    const hit = sv('rect', { x: 0, y: top + 14, width: PW, height: plotBottom - top - 14, fill: 'transparent' });
    const tAt = (e) => {
      const r = svg.getBoundingClientRect();
      const px = Math.min(Math.max(e.clientX - r.left, 0), PW);
      return [c.a + (px / PW) * span, e.clientY - r.top];
    };
    hit.addEventListener('pointermove', (e) => {
      const [t, py] = tAt(e);
      xh.setAttribute('x1', x(t)); xh.setAttribute('x2', x(t)); xh.setAttribute('visibility', 'visible');
      const on = c.ses.filter((s) => s.s <= t && s.e > t);
      const lane = py > laneTop ? lanes[Math.floor((py - laneTop) / laneH)] : null;
      hit.style.cursor = lane ? 'pointer' : 'crosshair';
      tip(e, el('div', { class: 't', text: fDateTime(t) }),
        tRow(null, plural(on.length, 'player'), 'online'),
        on.map((s) => tRow(colorOf(s.p), s.p, `since ${fTime(s.src.s)}`)),
        lane ? el('div', { class: 'note', text: `Click for ${lane.p}` }) : null);
    });
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); untip(); });
    hit.addEventListener('click', (e) => {
      const [, py] = tAt(e);
      const lane = py > laneTop ? lanes[Math.floor((py - laneTop) / laneH)] : null;
      if (lane) { untip(); go(lane.p); }
    });
    svg.append(xh, hit);
    // raids and progress markers must stay hoverable above the crosshair layer
    for (const g of svg.querySelectorAll('g.hov')) svg.append(g);
    const kinds = [...new Set(prog.map((ev) => ev.kind))];

    // Keep the reader's place across the minutely refresh: at the end stays at the end
    // (new data scrolls in), elsewhere stays at the same time.
    const old = host.querySelector('.tl-scroll');
    const keep = old && old.scrollWidth > old.clientWidth + 4 && old.scrollLeft + old.clientWidth < old.scrollWidth - 4
      ? host._tlLeft : null;
    const scroller = el('div', { class: `tl-scroll${PW > viewW ? ' scrolls' : ''}` }, svg);
    scroller.addEventListener('scroll', () => { host._tlLeft = c.a + (scroller.scrollLeft / PW) * span; untip(); }, { passive: true });
    host.replaceChildren(el('div', { class: 'tl' }, side, scroller),
      ...(PW > viewW ? [el('div', { class: 'hint tl-hint', text: `Showing ${nf(TL_SPAN / HOUR)} h at a time · scroll sideways for earlier` })] : []),
      ...(kinds.length || c.raids.length
        ? [legend([...(c.raids.length ? [['Raid', 'var(--critical)']] : []), ...kinds.map((k) => [PROGRESS[k].label, PROGRESS[k].color])])] : []));
    const place = () => { scroller.scrollLeft = keep != null && keep >= c.a ? x(keep) : scroller.scrollWidth; };
    place();
    requestAnimationFrame(place);
  }

  // ---- stacked daily columns (one stack per local day)
  function daily(host, c) {
    const days = daysIn(c.a, c.b);
    if (!c.total) return empty(host, 'No playtime in this range.');
    const W = width(host), H = 210, left = 40, right = 6, top = 10, bottom = 24;
    const who = S.players.filter((p) => c.rows.some((r) => r.p === p && r.play > 0));
    const val = (k, p) => (c.daily.get(k)?.get(p) || 0) / HOUR;
    const totals = days.map((d) => who.reduce((n, p) => n + val(d.key, p), 0));
    const ny = niceMax(Math.max(...totals));
    const band = (W - left - right) / days.length;
    const bw = Math.max(1, Math.min(24, band * 0.7));
    const y = (v) => top + (H - top - bottom) * (1 - v / ny.max);
    const svg = sv('svg', { width: W, height: H, role: 'img', 'aria-label': 'Playtime per day' });
    for (let v = 0; v <= ny.max + 1e-9; v += ny.step) {
      svg.append(sv('line', { class: v ? 'gl' : 'bl', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
      svg.append(sv('text', { class: 'ax', x: left - 8, y: y(v) + 4, 'text-anchor': 'end', text: `${nf(v, ny.step < 1 ? 1 : 0)} h` }));
    }
    const every = Math.ceil(days.length / Math.max(1, Math.floor((W - left) / 56)));
    days.forEach((d, i) => {
      const cx = left + band * i + band / 2;
      if (i % every === 0) svg.append(sv('text', { class: 'ax', x: cx, y: H - 6, 'text-anchor': 'middle', text: fDate(d.t) }));
      const g = sv('g', null);
      g.append(sv('rect', { x: left + band * i, y: top, width: band, height: H - top - bottom, fill: 'transparent' }));
      let acc = 0;
      const segs = who.map((p) => [p, val(d.key, p)]).filter(([, v]) => v > 0);
      segs.forEach(([p, v], j) => {
        const y1 = y(acc + v), y0 = y(acc);
        const h = Math.max(1, y0 - y1 - (j ? 2 : 0)); // 2px surface gap between segments
        const yy = y0 - (j ? 2 : 0) - h;
        if (j === segs.length - 1) g.append(sv('path', { d: colPath(cx - bw / 2, yy, bw, h), style: { fill: colorOf(p) } }));
        else g.append(sv('rect', { x: cx - bw / 2, y: yy, width: bw, height: h, style: { fill: colorOf(p) } }));
        acc += v;
      });
      hoverable(g, () => [el('div', { class: 't', text: `${DOW_LONG[hourParts(Math.floor(d.t / HOUR) * HOUR).dow]}, ${fDateY(d.t)}` }),
        tRow(null, fH(totals[i] * HOUR), 'total'),
        segs.slice().reverse().map(([p, v]) => tRow(colorOf(p), fH(v * HOUR), p)),
        segs.length ? el('div', { class: 'note', text: 'Click to zoom to this day' }) : null]);
      g.addEventListener('click', () => {
        const start = Math.floor(d.t / HOUR) * HOUR;
        const nxt = days[i + 1] ? Math.floor(days[i + 1].t / HOUR) * HOUR : S.max;
        setRange(start, Math.min(nxt, S.max), null);
      });
      svg.append(g);
    });
    host.replaceChildren(svg,
      ...(who.length > 1 ? [legend(who.map((p) => [p, colorOf(p)]))] : []),
      dataTable(['Day', ...who, 'Total'], days.map((d, i) => [fDateY(d.t), ...who.map((p) => fH(val(d.key, p) * HOUR)), fH(totals[i] * HOUR)])));
  }

  // ---- weekday × hour heatmap (sequential, one hue)
  const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
  function heatmap(host, c) {
    const W = width(host), left = 36, top = 4, bottom = 20;
    const cw = (W - left) / 24;
    const ch = Math.max(14, Math.min(26, cw));
    const H = top + ch * 7 + bottom;
    const max = Math.max(...c.heat.flat());
    if (!max) return empty(host, 'No playtime in this range.');
    const svg = sv('svg', { width: W, height: H, role: 'img', 'aria-label': 'Playtime by weekday and hour' });
    for (let d = 0; d < 7; d++) {
      svg.append(sv('text', { class: 'ax', x: 0, y: top + ch * d + ch / 2 + 4, text: DOW[d] }));
      for (let h = 0; h < 24; h++) {
        const v = c.heat[d][h];
        const step = v ? Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length)) : -1;
        const r = sv('rect', { x: left + cw * h + 1, y: top + ch * d + 1, width: cw - 2, height: ch - 2, rx: 3,
          style: { fill: step < 0 ? 'var(--empty)' : SEQ[step] } });
        hoverable(r, () => [el('div', { class: 't', text: `${DOW_LONG[d]} ${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00` }),
          tRow(null, fH(v), 'player-hours')]);
        svg.append(r);
      }
    }
    for (let h = 0; h < 24; h += (cw < 22 ? 3 : 2)) {
      svg.append(sv('text', { class: 'ax', x: left + cw * h + cw / 2, y: H - 5, 'text-anchor': 'middle', text: String(h).padStart(2, '0') }));
    }
    const scale = el('div', { class: 'seg-scale' }, 'less', el('span', { class: 'bar' },
      el('span', { style: { background: 'var(--empty)' } }), SEQ.map((s) => el('span', { style: { background: s } }))), 'more');
    host.replaceChildren(svg, el('div', { class: 'legend' }, scale),
      dataTable(['Weekday', ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))],
        c.heat.map((row, d) => [DOW[d], ...row.map((v) => (v ? (v / HOUR).toFixed(1) : '–'))])));
  }

  // ---- single-series columns
  function columns(host, { labels, values, color = 'var(--s1)', fmtV, tipT, height = 150, every = 1, aria }) {
    const W = width(host), left = 36, right = 4, top = 16, bottom = 20, H = height;
    const ny = niceMax(Math.max(...values, 0));
    const band = (W - left - right) / labels.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const y = (v) => top + (H - top - bottom) * (1 - v / ny.max);
    const svg = sv('svg', { width: W, height: H, role: 'img', 'aria-label': aria });
    for (let v = 0; v <= ny.max + 1e-9; v += ny.step) {
      svg.append(sv('line', { class: v ? 'gl' : 'bl', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
      svg.append(sv('text', { class: 'ax', x: left - 6, y: y(v) + 4, 'text-anchor': 'end', text: nf(v, ny.step < 1 ? 1 : 0) }));
    }
    const best = values.indexOf(Math.max(...values));
    labels.forEach((l, i) => {
      const cx = left + band * i + band / 2;
      const g = sv('g', null, sv('rect', { x: left + band * i, y: top, width: band, height: H - top - bottom, fill: 'transparent' }));
      if (values[i] > 0) g.append(sv('path', { d: colPath(cx - bw / 2, y(values[i]), bw, y(0) - y(values[i])), style: { fill: color } }));
      hoverable(g, () => [el('div', { class: 't', text: tipT(i) }), tRow(null, fmtV(values[i]))]);
      svg.append(g);
      if (i % every === 0) svg.append(sv('text', { class: 'ax', x: cx, y: H - 5, 'text-anchor': 'middle', text: l }));
      if (i === best && values[i] > 0) {
        // keep the peak label inside the plot near either edge
        const anchor = cx > W - 40 ? 'end' : cx < left + 40 ? 'start' : 'middle';
        const lx = anchor === 'end' ? Math.min(cx + bw / 2, W - right) : anchor === 'start' ? cx - bw / 2 : cx;
        svg.append(sv('text', { class: 'ax', x: lx, y: y(values[i]) - 5, 'text-anchor': anchor, text: fmtV(values[i]) }));
      }
    });
    host.replaceChildren(svg);
  }

  // ---- exploration map
  // Drawn in zone units (1 = one 64 m zone, north up); zoom and pan only touch
  // the viewBox, so they never re-render. Filters/zoom live in S.maps[key].
  const WORLDGEN = '\u0000world';
  // What the map can show on top: [key, label, legend glyph, on by default]
  // Dungeons from the world save (world.map.locations of kind "dungeon": [kind, label, x, z, prefab], the entrance, exact)
  // and who went in (data.visits from the server plugin: [t, player, prefab, entrance x, z, seconds inside or null]).
  const dungeons = () => (S.data.world?.map?.locations || []).filter((l) => l[0] === 'dungeon');
  const visitsAt = (l) => (S.data.visits || []).filter((v) => v[2] === l[4] && Math.hypot(v[3] - l[2], v[4] - l[3]) <= 60);
  const zoneAt = (x, z) => S.data.zones.find((q) => q.x === Math.floor((x + 32) / 64) && q.y === Math.floor((z + 32) / 64));
  const dungeonName = (prefab) => dungeons().find((l) => l[4] === prefab)?.[1] || prettyLoc(prefab);
  const visitDur = (v) => (v[5] != null ? `${fDur(v[5])} inside`
    : (S.data.online || []).includes(v[1]) && v === [...(S.data.visits || [])].reverse().find((x) => x[1] === v[1]) ? 'still inside' : 'time inside unknown');
  // ---- map filter line
  // The map shows what the line names: one key per kind of thing, its value narrows it down (* = all of them).
  //   user:*|<player>|world-generation  whose map: zones found while they were online, their positions — nothing else; every
  //                                     other key filters by its own values (tomb:astrid, base:ragnar, dungeon:entered-by-ragnar)
  //   biome:<biome>                     zones in a biome
  //   altar: trader: dungeon: base: portal: tomb: pin: pet:  e.g. portal:* portal:spawn dungeon:troll-cave dungeon:not-entered pet:boar
  // Several tokens with the same key: any of them. AND between two of the same key: both — dungeon:troll-cave AND dungeon:not-entered,
  // user:ragnar AND user:astrid (zones they found together). Starts as user:*, which can be removed until the page is loaded anew.
  const tokSlug = (x) => fold(x).trim().replace(/\s+/g, '-');
  const MAP_LINE_DEFAULT = 'user:*';
  const USER_TOKEN = /^(user|users|found):/i;
  const withDefaultUser = (line) => (line.split(/\s+/).some((t) => USER_TOKEN.test(t)) ? line : `${MAP_LINE_DEFAULT} ${line}`.trim());
  const dungeonTypes = () => [...new Set(dungeons().map((l) => l[1]))];
  const zoneBiomes = () => [...new Set(S.data.zones.map(biomeOf))];
  const altarDefeated = (name) => (S.data.world?.bosses || []).some((b) => b[1] === name && b[2]);
  // Portals as [tag, x, z, partner, index]: the game's own pairing, live from the server plugin (data.portals_live, 1.14.0+,
  // partner = index or -1), else the last world save, where only shared tags tell — two with a tag are a pair, with three or
  // more the game links two of them and which isn't known (partner -2).
  function portalList() {
    const live = S.data.portals_live?.list;
    if (live) return live.map(([tag, x, z, partner], i) => [tag, x, z, partner >= 0 && live[partner] ? partner : -1, i]);
    const ps = S.data.world?.map?.portals || [];
    return ps.map(([tag, x, z], i) => {
      const same = ps.map((q, j) => j).filter((j) => j !== i && ps[j][0] === tag);  // no tag is a tag too: the game pairs those as well
      return [tag, x, z, same.length === 1 ? same[0] : same.length ? -2 : -1, i];
    });
  }
  const portalLinked = (p) => p[3] !== -1;
  const portalsLive = () => !!S.data.portals_live?.list;
  const portalsNote = () => (portalsLive() ? `the game’s own pairing, live · ${fAgo(S.data.generated - S.data.portals_live.t)}` : 'from the last world save: portals sharing a tag (none counts too)');
  const PIN_NAMES = { fire: 'Fire pins', house: 'House pins', hammer: 'Hammer pins', point: 'Dot pins', bed: 'Bed pins', rune: 'Rune pins' };
  // a value per name the items carry: [[value, label, match(item)]]
  const namesOf = (xs, names) => [...new Set(xs.flatMap(names))].filter(Boolean).sort().map((n) => [tokSlug(n), n, (x) => names(x).includes(n)]);
  // kinds of things on the map: key, layer it is drawn on, label, glyph, items, values
  const MAP_KINDS = [
    { k: 'altar', layer: 'landmarks', label: 'Boss altars', glyph: '⚔', items: () => (S.data.world?.map?.locations || []).filter((l) => l[0] === 'altar'),
      values: (xs) => [['defeated', 'Defeated', (l) => altarDefeated(l[1])], ['not-defeated', 'Not defeated yet', (l) => !altarDefeated(l[1])], ...namesOf(xs, (l) => [l[1]])] },
    { k: 'trader', layer: 'landmarks', label: 'Traders', glyph: '¤', items: () => (S.data.world?.map?.locations || []).filter((l) => l[0] === 'trader'),
      values: (xs) => namesOf(xs, (l) => [l[1]]) },
    { k: 'dungeon', layer: 'dungeons', label: 'Dungeons', glyph: '▼', items: () => dungeons(),
      values: (xs) => [['entered', 'Entered', (l) => visitsAt(l).length > 0], ['not-entered', 'Not entered yet', (l) => !visitsAt(l).length],
        ...[...new Set((S.data.visits || []).map((v) => v[1]))].sort().map((p) => [`entered-by-${tokSlug(p)}`, `Entered by ${p}`, (l) => visitsAt(l).some((v) => v[1] === p)]),
        ...namesOf(xs, (l) => [l[1]])] },
    { k: 'base', layer: 'bases', label: 'Bases', glyph: '⌂', items: () => S.data.world?.map?.bases || [], values: (xs) => namesOf(xs, (b) => b.builders.map((x) => x[0])) },
    { k: 'portal', layer: 'portals', label: 'Portals', glyph: '◎', items: () => portalList(),
      values: (xs) => [['linked', 'Linked', (p) => portalLinked(p)], ['unlinked', 'Not linked', (p) => !portalLinked(p)], ['no-tag', 'Without a tag', (p) => !p[0]],
        ...namesOf(xs, (p) => [p[0]])] },
    { k: 'tomb', layer: 'tombs', label: 'Tombstones', glyph: '✝', items: () => S.data.world?.map?.tombs || [], values: (xs) => namesOf(xs, (t) => [t[0]]) },
    { k: 'pin', layer: 'pins', label: 'Shared pins', glyph: '•', items: () => S.data.world?.map?.pins || [],
      values: (xs) => [...Object.entries(PIN_NAMES).filter(([kind]) => xs.some((p) => p[1] === kind)).map(([kind, label]) => [kind, label, (p) => p[1] === kind]), ...namesOf(xs, (p) => [plainText(p[0])])] },
    { k: 'pet', layer: 'pets', label: 'Pets', glyph: '♥', items: () => (S.data.pets || []).filter((p) => p.status === 'alive'),
      values: (xs) => [...namesOf(xs, (p) => [gatherLabel(p.s)]), ...namesOf(xs, (p) => [p.n])] },
  ];
  const KIND = Object.fromEntries(MAP_KINDS.map((x) => [x.k, x]));
  const KEY_ALIAS = { user: 'user', users: 'user', found: 'user', biome: 'biome', biomes: 'biome', altars: 'altar', traders: 'trader', vendor: 'trader',
    dungeons: 'dungeon', cave: 'dungeon', bases: 'base', portals: 'portal', tombs: 'tomb', tombstone: 'tomb', tombstones: 'tomb', grave: 'tomb',
    pins: 'pin', pets: 'pet', ...Object.fromEntries(MAP_KINDS.map((x) => [x.k, x.k])) };
  // Links and saved lines from before: show:/hide:, type:/entered:, users:a,b, found:, combine:all.
  function normalizeOld(line) {
    const out = [], users = [], types = [];
    let status = '', combine = false;
    const SHOW = { altars: ['altar:*', 'trader:*'], dungeons: ['dungeon:*'], bases: ['base:*'], portals: ['portal:*'], tombstones: ['tomb:*'], pins: ['pin:*'], pets: ['pet:*'] };
    for (const t of line.trim().split(/\s+/).filter(Boolean)) {
      const m = t.match(/^([a-z]+):(.+)$/i), k = m?.[1].toLowerCase(), v = m?.[2];
      if (k === 'users' || k === 'found' || (k === 'user' && v.includes(','))) users.push(...v.split(',').filter(Boolean));
      else if (k === 'show') out.push(...(SHOW[fold(v)] || [t]));
      else if (k === 'hide') continue;
      else if (k === 'type') types.push(v);
      else if (k === 'entered') status = v === 'yes' ? 'entered' : v === 'no' ? 'not-entered' : `entered-by-${v}`;
      else if (k === 'combine') combine = fold(v) === 'all';
      else out.push(t);
    }
    const dung = types.length ? types.map((x) => `dungeon:${x}${status ? ` AND dungeon:${status}` : ''}`) : status ? [`dungeon:${status}`] : [];
    const us = users.map((x) => `user:${x}`);
    return [...(combine ? [us.join(' AND ')] : us), ...dung, ...out].filter(Boolean).join(' ');
  }
  function parseMapFilter(line) {
    const F = { user: [], biome: new Set(), kinds: {}, toks: [] };  // user / kinds[key]: clauses, each a list of values that must all hold
    const player = (v) => (v === '*' ? '*' : v === 'world-generation' ? WORLDGEN : S.players.find((x) => tokSlug(x) === v));
    let last = null, joining = false;
    for (const tok of normalizeOld(line || '').split(/\s+/).filter(Boolean)) {
      if (/^and$/i.test(tok)) { F.toks.push(['AND', !!last && !joining]); joining = !!last; continue; }
      const m = tok.match(/^([a-z]+):(.+)$/i), k = m && KEY_ALIAS[m[1].toLowerCase()], v = m ? tokSlug(m[2]) : '';
      let val = null;
      if (k === 'user') val = player(v);
      else if (k === 'biome') val = zoneBiomes().find((b) => tokSlug(b) === v);
      else if (KIND[k] && (v === '*' || KIND[k].values(KIND[k].items(), F).some(([x]) => x === v))) val = v;
      F.toks.push([tok, !!val]);
      if (!val) { last = null; joining = false; continue; }
      if (k === 'biome') { F.biome.add(val); last = null; joining = false; continue; }
      const list = k === 'user' ? F.user : (F.kinds[k] ||= []);
      if (joining && last?.k === k) last.clause.push(val);
      else {
        if (joining) F.toks[F.toks.length - 2][1] = false;  // AND joins two of the same key only
        last = { k, clause: [val] };
        list.push(last.clause);
      }
      joining = false;
    }
    if (joining) F.toks[F.toks.length - 1][1] = false;  // AND at the end
    // users: zones need one clause's players all together; things (bases, tombstones, visits) any player named
    const clauses = F.user.map((cl) => cl.filter((p) => p !== '*'));
    F.zoneUsers = clauses.some((cl) => !cl.length) ? [] : clauses;
    F.players = F.zoneUsers.length ? [...new Set(F.zoneUsers.flat())] : [];
    F.layers = new Set(Object.keys(F.kinds).map((k) => KIND[k].layer));
    const matchers = {};
    F.shows = (k, x) => {
      if (!F.kinds[k]) return false;
      const vals = matchers[k] ||= Object.fromEntries(KIND[k].values(KIND[k].items(), F).map(([v, , fn]) => [v, fn]));
      return F.kinds[k].some((cl) => cl.every((v) => v === '*' || vals[v]?.(x)));
    };
    return F;
  }
  // The dungeon filter (dungeon: tokens and the ANDs between them) is one for the World map, its Dungeons card and the
  // Overview map: set on one, it applies on the others. Everything else in a line stays that map's own.
  const DUNGEON_MAPS = ['world', 'overview'];
  const isDungeonTok = (t) => KEY_ALIAS[(t || '').split(':')[0].toLowerCase()] === 'dungeon' && t.includes(':');
  function dungeonPart(line) {
    const ts = line.split(/\s+/).filter(Boolean);
    return ts.filter((t, j) => isDungeonTok(t) || (/^and$/i.test(t) && isDungeonTok(ts[j - 1]) && isDungeonTok(ts[j + 1]))).join(' ');
  }
  function withDungeonPart(line, part) {
    const ts = line.split(/\s+/).filter(Boolean);
    const rest = ts.filter((t, j) => !isDungeonTok(t) && !(/^and$/i.test(t) && (isDungeonTok(ts[j - 1]) || isDungeonTok(ts[j + 1]))));
    return [...rest, part].filter(Boolean).join(' ');
  }
  // The world map's line lives in the link (#/world?f=…); links from before the line still work.
  function worldLineFromLink(q) {
    const old = () => [...(q?.get('dungeons') || '').split(',').filter(Boolean).map((t) => `type:${tokSlug(t)}`),
      q?.get('entered') ? `entered:${q.get('entered')}` : '', q?.get('dby') ? `entered:${tokSlug(q.get('dby'))}` : ''].filter(Boolean).join(' ');
    const own = q?.has('f') || q?.has('dungeons') || q?.has('entered');
    // no filter in the link (the menu, a plain #/world): the line as it was left in this visit
    let line = own ? normalizeOld(q.has('f') ? q.get('f') : old()) : S.maps.world?.line ?? MAP_LINE_DEFAULT;
    if (own) S.dungeonLine = dungeonPart(line);  // a link with its own filter wins
    else if (S.dungeonLine != null) line = withDungeonPart(line, S.dungeonLine);  // else the one set on the Overview map
    return mapState('world').noUser ? line : withDefaultUser(line);  // user:* unless removed since this page was loaded
  }
  // Apply a map's line: on the World page through the link (the Dungeons card reads it too), elsewhere the map redraws.
  function setMapLine(key, line, rerender, focus = false) {
    const st = mapState(key);
    let toks = normalizeOld(line).split(/\s+/).filter(Boolean);
    if (toks.some((t) => USER_TOKEN.test(t) && !/:\*$/.test(t))) toks = toks.filter((t, i) => t.toLowerCase() !== MAP_LINE_DEFAULT || /^and$/i.test(toks[i + 1] || '') || /^and$/i.test(toks[i - 1] || ''));
    st.noUser = !toks.some((t) => USER_TOKEN.test(t));  // user:* removed: stays out until the page is loaded anew
    st.line = toks.join(' ');
    st.fit = true;  // the next draw zooms to what the line shows
    if (DUNGEON_MAPS.includes(key)) {  // the shared dungeon filter follows
      S.dungeonLine = dungeonPart(st.line);
      for (const other of DUNGEON_MAPS) {
        const o = S.maps[other];
        if (other !== key && o && dungeonPart(o.line) !== S.dungeonLine) { o.line = withDungeonPart(o.line, S.dungeonLine); o.fit = true; }
      }
    }
    S.mapLineFocus = focus ? key : null;
    const r = route();
    if (key === 'world' && r.view === 'world') {
      const q = new URLSearchParams(r.q);
      q.delete('dungeons'); q.delete('entered'); q.delete('dby');
      if (st.line !== MAP_LINE_DEFAULT) q.set('f', st.line); else q.delete('f');  // f= (empty): user:* was removed
      const qs = q.toString();
      history.replaceState(null, '', `#/world${qs ? `?${qs}` : ''}`);
      scheduleRender();
    } else rerender();
  }
  // The line itself: suggestions while typing or on ↓ (↑↓ pick, Enter or Tab takes one, Enter alone applies), the applied
  // tokens as removable pills, and one-click toggles per kind (adds kind:*, or takes that kind out).
  function filterLine(key, F, rerender) {
    const st = mapState(key);
    const apply = (line, focus = false) => setMapLine(key, line, rerender, focus);
    const players = S.players.filter((p) => S.data.zones.some((z) => z.by.includes(p)));
    const userValues = () => [['*', 'Everyone', null], ...players.map((p) => [tokSlug(p), p, S.data.zones.filter((z) => z.by.includes(p)).length]),
      ['world-generation', 'World generation', S.data.zones.filter((z) => !z.by.length).length]];
    const biomeValues = () => zoneBiomes().map((b) => [tokSlug(b), b, S.data.zones.filter((z) => biomeOf(z) === b).length]).sort((a, b) => b[2] - a[2]);
    const kindValues = (k) => {  // values with nothing behind them are left out; * always there
      const xs = KIND[k].items();
      return [['*', `All ${KIND[k].label.toLowerCase()}`, xs.length], ...KIND[k].values(xs, F).map(([v, label, fn]) => [v, label, xs.filter(fn).length]).filter((x) => x[2])];
    };
    const valuesOf = (k) => (k === 'user' ? userValues() : k === 'biome' ? biomeValues() : KIND[k] ? kindValues(k) : []);
    const KEYS = [['user', 'Whose map: the zones they found, their positions'], ...MAP_KINDS.map((x) => [x.k, x.label]), ['biome', 'Zones in a biome']];
    const input = el('input', { type: 'text', class: 'map-filter-input', 'data-keep': `mapline:${key}`, value: st.line ? `${st.line} ` : '', spellcheck: 'false', autocomplete: 'off',
      'aria-label': 'Map filter', placeholder: 'What to show: portal:*  dungeon:troll-cave  pet:boar  user:stick  biome:swamp  … AND …' });
    const list = el('div', { class: 'map-filter-sugg', role: 'listbox', hidden: true });
    let opts = [], sel = 0;
    const tokenAt = () => { const v = input.value, i = v.lastIndexOf(' ', Math.max(0, input.selectionStart - 1)) + 1; return { i, tok: v.slice(i, input.selectionStart) }; };
    const suggest = () => {
      const { i, tok } = tokenAt(), have = new Set(input.value.trim().split(/\s+/).map((t) => t.toLowerCase()));
      const prev = input.value.slice(0, i).trim().split(/\s+/).pop() || '';
      const andOk = prev && !/^and$/i.test(prev);
      const m = tok.match(/^([a-z]+):(.*)$/i), w = tokSlug(tok);
      const opt = (k, v, label, n) => ({ ins: `${k}:${v} `, label, n, done: true });
      const hit = (v, label, q) => v.startsWith(q) || tokSlug(label).split('-').some((x) => x.startsWith(q)) || tokSlug(label).startsWith(q);
      if (m) {
        const k = KEY_ALIAS[m[1].toLowerCase()], q = tokSlug(m[2]);
        opts = k ? valuesOf(k).filter(([v, label]) => (!q || hit(v, label, q)) && !have.has(`${k}:${v}`)).map(([v, label, n]) => opt(k, v, label, n)) : [];
      } else if (!w) {
        opts = [...KEYS.map(([k, label]) => ({ ins: `${k}:`, label, n: KIND[k] ? KIND[k].items().length : null })), ...(andOk ? [{ ins: 'AND ', label: 'Both: joins two of the same kind' }] : [])];
      } else {
        // a bare word: the kinds it names (portal, pet …) with their values, then any value of any kind that matches
        const kinds = KEYS.filter(([k, label]) => k.startsWith(w) || tokSlug(label).split('-').some((x) => x.startsWith(w)));
        const fromKinds = kinds.flatMap(([k]) => valuesOf(k).filter(([v]) => !have.has(`${k}:${v}`)).slice(0, 6).map(([v, label, n]) => opt(k, v, label, n)));
        const fromValues = KEYS.flatMap(([k]) => (kinds.some(([x]) => x === k) ? [] : valuesOf(k).filter(([v, label]) => v !== '*' && hit(v, label, w) && !have.has(`${k}:${v}`))
          .map(([v, label, n]) => opt(k, v, `${label} · ${k === 'user' ? 'whose map' : k === 'biome' ? 'biome' : KIND[k].label.toLowerCase()}`, n))));
        opts = [...('and'.startsWith(w) && w.length > 1 && andOk ? [{ ins: 'AND ', label: 'Both: joins two of the same kind' }] : []), ...fromKinds, ...fromValues];
      }
      sel = 0;
      list.replaceChildren(...opts.slice(0, 14).map((o, j) => el('div', { class: 'pal-opt', role: 'option', 'aria-selected': String(j === sel),
        onmousedown: (e) => { e.preventDefault(); take(o); } },
        el('span', { class: 'pal-label' }, el('code', { text: o.ins.trim() }), el('span', { class: 'hint', text: ` ${o.label}` })),
        o.n != null ? el('span', { class: 'hint', text: nf(o.n) }) : null)));
      list.hidden = !opts.length || document.activeElement !== input;
    };
    const take = (o) => {
      const { i } = tokenAt(), v = input.value, end = v.indexOf(' ', input.selectionStart);
      input.value = v.slice(0, i) + o.ins + (end < 0 ? '' : v.slice(end + 1));
      if (o.done) apply(input.value, true); else { input.setSelectionRange(i + o.ins.length, i + o.ins.length); suggest(); }
    };
    const shown = () => Math.min(14, opts.length);
    const mark = () => [...list.children].forEach((c, j) => c.setAttribute('aria-selected', String(j === sel)));
    // suggestions while typing or on ↓ — clicking into the line, or a pill or toggle, doesn't open them
    input.addEventListener('input', suggest);
    input.addEventListener('blur', () => { list.hidden = true; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && list.hidden) { e.preventDefault(); suggest(); }
      else if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); sel = (sel + 1) % shown(); mark(); }
      else if (e.key === 'ArrowUp' && opts.length) { e.preventDefault(); sel = (sel + shown() - 1) % shown(); mark(); }
      else if ((e.key === 'Tab' || e.key === 'Enter') && !list.hidden && opts[sel] && (tokenAt().tok || !opts[sel].done)) { e.preventDefault(); take(opts[sel]); }
      else if (e.key === 'Enter') { e.preventDefault(); apply(input.value, true); }
      else if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); list.hidden = true; } else input.blur(); }
    });
    // after a pick or Enter the line keeps the focus: on the World page the whole page redraws, elsewhere only the map
    if (S.mapLineFocus === key) {
      S.mapLineFocus = null;
      requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
    }
    // a pill goes with the AND that joined it
    const without = (idx) => {
      const ts = F.toks.map((t) => t[0]);
      const drop = new Set([idx, /^and$/i.test(ts[idx - 1] || '') ? idx - 1 : /^and$/i.test(ts[idx + 1] || '') ? idx + 1 : -1]);
      return ts.filter((_, j) => !drop.has(j)).join(' ');
    };
    const pills = F.toks.length ? el('div', { class: 'map-filter-pills' }, F.toks.map(([tok, ok], j) => (tok === 'AND'
      ? el('span', { class: `map-and${ok ? '' : ' bad'}`, title: ok ? 'Both must hold' : 'AND joins two of the same kind', text: 'AND' })
      : el('button', { type: 'button', class: `tag map-pill${ok ? '' : ' bad'}`, title: ok ? 'Remove' : 'Not understood — remove', onclick: () => apply(without(j)) },
        tok, el('span', { 'aria-hidden': 'true', text: ' ×' })))),
      el('button', { type: 'button', class: 'more-link', text: 'Clear', onclick: () => apply(MAP_LINE_DEFAULT) })) : null;
    // one click per kind: kind:* in, or every token of that kind (and its ANDs) out
    const toggle = (k) => {
      const ts = F.toks.map((t) => t[0]);
      if (!F.kinds[k]) { apply(`${ts.join(' ')} ${k}:*`); return; }
      const isK = (t) => KEY_ALIAS[t.split(':')[0].toLowerCase()] === k;
      apply(ts.filter((t, j) => !isK(t) && !(/^and$/i.test(t) && (isK(ts[j - 1] || '') || isK(ts[j + 1] || '')))).join(' '));
    };
    const toggles = el('div', { class: 'map-layers', role: 'group', 'aria-label': 'On the map' }, MAP_KINDS.filter((x) => x.items().length || F.kinds[x.k]).map((x) =>
      el('button', { type: 'button', class: 'map-layer', 'aria-pressed': String(!!F.kinds[x.k]), title: `${x.label} (${x.k}:*) — click to ${F.kinds[x.k] ? 'hide' : 'show'}`,
        onclick: () => toggle(x.k) }, el('span', { 'aria-hidden': 'true', text: x.glyph }), ` ${nf(x.items().length)}`)));
    return el('div', { class: 'map-filter' }, el('div', { class: 'map-filter-box' }, input, list), pills, toggles);
  }
  const visitLine = (v, who = true) => el('div', { class: 'note' }, `${fAgo(S.data.generated - v[0])} · `, who ? whoLink(v[1]) : null,
    `${who ? ' went' : 'Went'} into ${dungeonName(v[2]).replace(/^./, (ch) => ch.toLowerCase())} at `, placeLink(v[3], v[4], dungeonName(v[2])), ` · ${visitDur(v)}`);
  const PIN_GLYPH = { fire: '♨', house: '⌂', hammer: '⚒', point: '•', bed: '☾', rune: 'ᚱ' };
  // A world position (m) on the map page; zoom 0 shows ~25 km across, every step halves it.
  const mapHref = (x, z, zoom = 4, label = '') => `#/world?at=${Math.round(x)},${Math.round(z)}&zoom=${zoom}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
  // "Base of X" when a position (m) is in or next to a base, else its coordinates.
  const placeName = (x, z) => {
    const b = (S.data.world?.map?.bases || []).find((b) => Math.hypot(b.x - x, b.z - z) <= 3 * 64);
    return b ? `base of ${b.builders[0]?.[0] || '?'}` : `x ${nf(Math.round(x))}, z ${nf(Math.round(z))}`;
  };
  const bossHref = (name) => {
    const k = Object.keys(CD()).find((x) => CD()[x].name === name);
    return !k ? '#/bosses' : (S.data.fights || []).some((f) => f.boss === k) ? `#/bosses?boss=${encodeURIComponent(k)}` : creatureHref(k);
  };
  function mapState(key, init) {
    if (!S.maps[key]) S.maps[key] = { line: init?.length ? init.map((p) => `user:${tokSlug(p)}`).join(' ') : MAP_LINE_DEFAULT, color: 'time', view: null, ground: 'terrain', focused: null };
    return S.maps[key];
  }
  // extra: { players: false hides player positions, marks: [{x, z (world), label, style, cls, tip(), href?}], legend,
  //         plain: neutral zones without the exploration controls, fitted to the marks }
  function zoneMap(host, c, key, initPlayers, extra = null) {
    const st = mapState(key, initPlayers);
    const all = S.data.zones.filter((z) => z.t < c.b);
    if (!all.length) return empty(host, 'No explored zones yet.');
    const spawn = spawnZone();
    const F = parseMapFilter(extra?.plain ? '' : st.line), sel = F.players;
    const byOf = (z) => (z.by.length ? z.by : [WORLDGEN]);
    const match = (z) => (!F.zoneUsers.length || F.zoneUsers.some((cl) => cl.every((p) => byOf(z).includes(p)))) && (!F.biome.size || F.biome.has(biomeOf(z)));
    const hits = all.filter(match);
    const span = Math.max(1, c.b - c.a);

    const bounds = (zs) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const z of zs) { x0 = Math.min(x0, z.x); x1 = Math.max(x1, z.x); y0 = Math.min(y0, z.y); y1 = Math.max(y1, z.y); }
      return [x0 - 2, -y1 - 3, x1 - x0 + 5, y1 - y0 + 5];
    };

    // ---- controls
    const rerender = () => zoneMap(host, c, key, null, extra);
    const explorers = S.players.filter((p) => all.some((z) => z.by.includes(p)));
    const seg = (label, opts, cur, set, disabled) => el('div', { class: 'seg', role: 'group', 'aria-label': label },
      opts.map(([v, t, title]) => el('button', { type: 'button', 'aria-pressed': String(cur === v), disabled: disabled || null, title: title || null, text: t,
        onclick: () => { set(v); rerender(); } })));
    const M = S.data.world?.map, T = S.data.terrain;
    // what the line names, narrowed by its own values (user: only picks the zones and positions)
    const shown = (k) => KIND[k].items().filter((x) => F.shows(k, x));
    const layerData = {
      landmarks: [...shown('altar'), ...shown('trader')], dungeons: shown('dungeon'),
      bases: shown('base'), portals: shown('portal'), tombs: shown('tomb'), pins: shown('pin'), pets: shown('pet'),
    };
    const controls = el('div', { class: 'map-controls' },
      filterLine(key, F, rerender),
      el('div', { class: 'ctl-row' },
        // the zones' colour only shows on the Zones ground: on the terrain they are a faint wash
        T ? seg('Ground', [['terrain', 'Terrain', 'The land where players have been, zones lighter on top'], ['zones', 'Zones', 'Zone squares only']], st.ground, (v) => { st.ground = v; }) : null,
        seg('Colour by', [['time', 'Discovery time'], ['player', 'Player']], st.color, (v) => { st.color = v; }, T && st.ground !== 'zones')));

    // ---- svg
    const svg = sv('svg', { role: 'img', 'aria-label': 'Explored world zones', tabindex: '0', preserveAspectRatio: 'xMidYMid meet' });
    const g = sv('g');
    // Terrain (server plugin → collector) only where players have been: their shared map (cartography
    // tables) plus every generated zone. Image coordinates: 1 unit = one zone, x = (wx + 32) / 64, y = -(wz + 32) / 64.
    const terrainOn = T && (extra?.plain || st.ground === 'terrain');
    if (terrainOn) {
      const fog = `fog-${key.replace(/[^\w-]/g, '_')}`, E = T.extent, ex = M?.explored;
      const box = (half) => ({ x: (-half + 32) / 64, y: -(half + 32) / 64, width: (2 * half) / 64, height: (2 * half) / 64 });
      g.append(sv('defs', null, sv('mask', { id: fog, maskUnits: 'userSpaceOnUse', x: -400, y: -400, width: 800, height: 800 },
        ex ? sv('image', { href: `explored.png?v=${ex.v}`, ...box(ex.size * ex.px / 2), preserveAspectRatio: 'none' }) : null,
        sv('path', { d: all.map((z) => `M${z.x - 0.02} ${-z.y - 1.02}h1.04v1.04h-1.04z`).join(''), fill: '#fff' }))),  // one path, not a rect per zone
      sv('image', { class: 'map-terrain', href: `terrain.png?v=${T.v}`, ...box(E), preserveAspectRatio: 'none', mask: `url(#${fog})` }));
    }
    for (let km = 1; km <= 12; km++) {
      g.append(sv('circle', { cx: spawn.x + 0.5, cy: -spawn.y - 0.5, r: km * 1000 / 64, fill: 'none', 'vector-effect': 'non-scaling-stroke', class: 'gl' }));
    }
    // zones as one path per colour and opacity (a few dozen elements instead of one per zone: every element is redrawn
    // when the map moves); the pointer finds zones by position, not by element
    const paint = new Map();
    all.forEach((z) => {
      const m = match(z), fresh = z.t >= c.a;
      let fill = 'var(--other)', op = m ? 0.45 : 0.1;
      if (extra?.plain) op = 0.3;
      else if (m && st.color === 'time' && fresh) {
        fill = SEQ[Math.min(SEQ.length - 1, Math.floor(((z.t - c.a) / span) * SEQ.length))]; op = 1;
      } else if (m && st.color === 'player') {
        fill = z.by.length === 1 ? colorOf(z.by[0]) : z.by.length > 1 ? 'var(--ink-2)' : 'var(--other)';
        op = fresh ? 1 : 0.4;
      }
      if (terrainOn) op *= m && (F.zoneUsers.length || F.biome.size) && !extra?.plain ? 0.5 : 0.07;  // the land shows through; a filter picks zones out
      const k = `${fill}|${op}`;
      paint.set(k, (paint.get(k) || '') + `M${z.x + 0.06} ${-z.y - 1 + 0.06}h0.88v0.88h-0.88z`);
    });
    for (const [k, d] of paint) { const [fill, op] = k.split('|'); g.append(sv('path', { d, style: { fill, fillOpacity: Number(op) } })); }
    // Outline of the zone under the pointer; zones are looked up by map position, so the gaps between boxes count too.
    const at = new Map(all.map((z, i) => [`${z.x},${z.y}`, i]));
    const hl = sv('rect', { class: 'map-hl', width: 1, height: 1, rx: 0.18, visibility: 'hidden', 'vector-effect': 'non-scaling-stroke' });
    const unhover = () => { hl.setAttribute('visibility', 'hidden'); untip(); };
    const spawnRing = sv('circle', { cx: spawn.x + 0.5, cy: -spawn.y - 0.5, r: 0.8, fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', style: { stroke: 'var(--accent)' } });
    const spawnLabel = sv('text', { class: 'map-label', x: spawn.x + 1.6, y: -spawn.y - 1, text: 'Spawn' });
    // Players who share their position on the in-game map (rcon.py): online ones where they
    // are now, the rest where they were last seen. Zone x spans world x 64x-32 … 64x+32.
    const P = extra?.players === false ? null : S.data.positions;
    const mark = (wx, wz, style, text, tipFn, cls = '', href = null, glyph = null, labelAt = 0) => {
      const x = (wx + 32) / 64, y = -(wz + 32) / 64;
      return { x, y, tip: tipFn, href, labelAt,
        glyph: glyph ? sv('text', { class: 'map-glyph', x, y, text: glyph }) : null,
        dot: sv('circle', { class: `map-player${glyph ? ' map-sym' : ''}`, cx: x, cy: y, r: 0.5, 'vector-effect': 'non-scaling-stroke', style }),
        label: sv('text', { class: `map-label map-player-label${cls}`, x, y, text }) };
    };
    // Marks of the world layers; things players own sit in the middle of their 64 m zone (the collector snaps them).
    const L = extra?.plain ? new Set() : F.layers, groups = (rows, keyOf) => { const m = new Map(); for (const r of rows) (m.get(keyOf(r)) || m.set(keyOf(r), []).get(keyOf(r))).push(r); return [...m.values()]; };
    const defeated = new Set((S.data.world?.bosses || []).filter((b) => b[2]).map((b) => b[1]));
    const prio = (n, ks) => ks.map((k) => Object.assign(k, { prio: n }));  // who keeps their label when labels collide
    const layerMarks = [
      ...prio(4, L.has('landmarks') ? layerData.landmarks.map(([kind, name, x, z]) => (kind === 'altar'
        ? mark(x, z, { fill: defeated.has(name) ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)' }, name,
          () => [el('div', { class: 't', text: `${name} · boss altar` }), el('div', { class: 'note', text: defeated.has(name) ? 'Defeated' : 'Not defeated yet' }), el('div', { class: 'note', text: `x ${nf(x)}, z ${nf(z)}` })],
          ' sym-label', bossHref(name), '⚔', 0)
        : mark(x, z, { fill: 'var(--surface)', stroke: 'var(--s4)' }, name,
          () => [el('div', { class: 't', text: `${name} · trader` }), el('div', { class: 'note', text: `x ${nf(x)}, z ${nf(z)}` })], ' sym-label', null, '¤', 0))) : []),
      ...prio(1, L.has('dungeons') ? layerData.dungeons.map((l) => {
        const [, label, x, z] = l, vs = visitsAt(l);
        return mark(x, z, { fill: vs.length ? 'var(--s6)' : 'var(--surface)', stroke: 'var(--s6)' }, label, () => {
          const zn = zoneAt(x, z), by = new Map();
          for (const v of vs) by.set(v[1], (by.get(v[1]) || 0) + 1);
          return [el('div', { class: 't', text: `${label} · dungeon` }),
            zn ? el('div', { class: 'note', text: `Found ${fDateTime(zn.t)}${zn.by.length ? ` · ${zn.by.join(', ')} online` : ''}` }) : null,
            ...[...by].sort((a, b) => b[1] - a[1]).map(([p, n]) => tRow(colorOf(p), p, plural(n, 'visit'))),
            el('div', { class: 'note', text: vs.length ? `Last went in ${fAgo(S.data.generated - vs[vs.length - 1][0])}` : 'Nobody has gone in yet (followed since server plugin 1.13.0)' }),
            el('div', { class: 'note', text: `x ${nf(x)}, z ${nf(z)}` })];
        }, ' sym-label', null, '▼', 60);
      }) : []),
      ...prio(3, L.has('bases') ? layerData.bases.map((b) => mark(b.x, b.z, { fill: 'var(--surface)', stroke: colorOf(b.builders[0]?.[0]) }, `Base · ${b.builders[0]?.[0] || '?'}`,
        () => [el('div', { class: 't', text: `Base of ${b.builders.map((x) => x[0]).join(', ')}` }), tRow(null, nf(b.pieces), 'pieces'), tRow(null, nf(b.chests), `chests · ${nf(b.items)} items`),
          el('div', { class: 'note', text: `${plural(b.zones, 'zone')} · shown at its 64 m zone` })], ' sym-label', '#/base', '⌂', 0)) : []),
      ...prio(2, L.has('portals') ? groups(layerData.portals, (p) => `${p[1]},${p[2]}`).map((ps) => mark(ps[0][1], ps[0][2], { fill: 'var(--surface)', stroke: 'var(--s7)' },
        ps.map((p) => p[0] || '(no tag)').join(', '),
        () => {
          const all = portalList();
          return [el('div', { class: 't', text: plural(ps.length, 'portal') }), ...ps.map((p) => {
            const to = p[3] >= 0 ? all[p[3]] : null;
            return el('div', { class: 'note', text: `“${p[0] || 'no tag'}” · ${to ? `linked to ${placeName(to[1], to[2])}` : p[3] === -2 ? 'linked to one of the others with this tag' : 'not linked'}` });
          }), el('div', { class: 'note', text: `Shown at its 64 m zone · ${portalsNote()}` })];
        },
        ' sym-label', '#/base?card=portals', '◎', 140)) : []),
      ...prio(2, L.has('tombs') ? groups(layerData.tombs, (t) => `${t[1]},${t[2]}`).map((ts) => mark(ts[0][1], ts[0][2], { fill: 'var(--surface)', stroke: 'var(--critical)' },
        [...new Set(ts.map((t) => t[0]))].join(', '),
        () => [el('div', { class: 't', text: ts.length > 1 ? `${ts.length} tombstones` : 'Tombstone' }),
          ...ts.flatMap((t) => [tRow(colorOf(t[0]), t[0], t[3] != null ? `day ${nf(petDay(t[3]))}` : ''), t[4]?.length ? el('div', { class: 'note', text: tombText(t[4], 6) }) : null]),
          el('div', { class: 'note', text: 'Their things wait here · shown at its 64 m zone' })], ' sym-label', ts.length === 1 ? `#/p/${encodeURIComponent(ts[0][0])}` : null, '✝', 140)) : []),
      ...prio(1, L.has('pins') ? groups(layerData.pins, (p) => `${p[2]},${p[3]}`).map((ps) => mark(ps[0][2], ps[0][3], { fill: 'var(--surface)', stroke: 'var(--ink-2)' },
        ps.map((p) => plainText(p[0])).filter(Boolean).join(', '),
        () => [el('div', { class: 't', text: ps.length > 1 ? `${ps.length} shared pins` : 'Shared pin' }), ...ps.map((p) => el('div', { class: 'note' }, `${PIN_GLYPH[p[1]] || '•'} `, p[0] ? richText(p[0]) : '(no name)')),
          el('div', { class: 'note', text: 'From the cartography table · shown at its 64 m zone' })], ' sym-label', null, PIN_GLYPH[ps[0][1]] || '•', 60)) : []),
      ...prio(1, L.has('pets') ? layerData.pets.map((p) => mark(p.x, p.z, { fill: 'var(--s3)', stroke: 'var(--surface)' }, p.n || '',
        () => [el('div', { class: 't', text: petName(p) }), el('div', { class: 'note', text: gatherLabel(p.s) })], '', `#/pet/${encodeURIComponent(p.k)}`, null, 40)) : []),
    ];
    const focus = extra?.focus;
    const marks = [
      ...layerMarks,
      ...(focus ? [Object.assign(mark(focus.x, focus.z, { fill: 'none', stroke: 'var(--accent)' }, focus.label || 'Here',
        () => [el('div', { class: 't', text: focus.label || 'Linked position' }), el('div', { class: 'note', text: `x ${nf(focus.x)}, z ${nf(focus.z)}` })], ' sym-label map-focus'), { prio: 6, scale: 2.2, ring: true })] : []),
      ...(P ? P.players : []).filter((m) => !sel.length || sel.includes(m.p))
        .sort((a, b) => a.online - b.online)  // online on top
        .map((m) => mark(m.x, m.z, m.online ? { fill: colorOf(m.p), stroke: 'var(--surface)' } : { fill: 'var(--surface)', stroke: colorOf(m.p) },
          m.p, () => playerTip(m), m.online ? '' : ' off')),
      ...(extra?.marks || []).map((m) => mark(m.x, m.z, m.style, m.label, m.tip, m.cls || '', m.href)),
    ];
    let markR = 0.5;
    const playerTip = (m) => {
      const zx = Math.floor((m.x + 32) / 64), zy = Math.floor((m.z + 32) / 64), z = all[at.get(`${zx},${zy}`)];
      return [el('div', { class: 't', text: m.p }),
        m.online ? tRow(colorOf(m.p), 'Online now') : tRow(colorOf(m.p), fAgo(Date.now() / 1000 - m.t), `last seen · ${fDateTime(m.t)}`),
        el('div', { class: 'note', text: `Zone ${zx}, ${zy}${z ? ` · ${biomeOf(z)}` : ''} · ${nf(Math.hypot(zx - spawn.x, zy - spawn.y) * 64 / 1000, 1)} km from spawn` })];
    };
    g.append(hl, spawnRing, spawnLabel, sv('g', null, marks.map((k) => [k.dot, k.glyph]), marks.map((k) => k.label)));
    svg.append(g);

    const box = el('div', { class: 'mapbox' }, svg);
    const zoomBtns = el('div', { class: 'map-zoom' },
      el('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', text: '+', onclick: () => zoomCenter(0.7) }),
      el('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', text: '−', onclick: () => zoomCenter(1 / 0.7) }),
      el('button', { type: 'button', title: 'Fit to zones', 'aria-label': 'Fit to zones', class: 'fit', text: '⤢', onclick: () => applyView(fitView()) }),
      el('button', { type: 'button', title: 'Copy a link to this view', 'aria-label': 'Copy a link to this view', class: 'fit', onclick: () => {
        const [x, z] = [(vb[0] + vb[2] / 2) * 64 - 32, -(vb[1] + vb[3] / 2) * 64 - 32], zoom = Math.max(0, Math.min(8, Math.round(Math.log2(400 / vb[2]))));
        const url = `${location.origin}${location.pathname}${mapHref(x, z, zoom)}`;
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast('Link to this view copied'), () => prompt('Copy this link:', url));
        else prompt('Copy this link:', url);
      } }, navIcon('link', 15)));
    const coords = el('div', { class: 'map-coords', 'aria-hidden': 'true' });
    box.append(zoomBtns, coords);
    const showCoords = (e) => { const [mx, my] = toMap(e.clientX, e.clientY); coords.textContent = `x ${nf(Math.round(mx * 64 - 32))} · z ${nf(Math.round(-my * 64 - 32))}`; };

    // ---- view math (viewBox always has the box's aspect, so screen→map is linear)
    let vb = null, aspect = 1;
    const markZones = (extra?.marks || []).map((m) => ({ x: Math.floor((m.x + 32) / 64), y: Math.floor((m.z + 32) / 64) }));
    // plain maps (pets) fit the marks with ~400 m around them, so a single pen still shows its surroundings
    const pad = ([x, y, w, h], n) => [x - n, y - n, w + 2 * n, h + 2 * n];
    // what the filter line shows (every kind it names), else the zones it picks
    const objZones = [...layerData.landmarks.map((l) => [l[2], l[3]]), ...layerData.dungeons.map((l) => [l[2], l[3]]), ...layerData.bases.map((b) => [b.x, b.z]),
      ...layerData.portals.map((q) => [q[1], q[2]]), ...layerData.tombs.map((t) => [t[1], t[2]]), ...layerData.pins.map((q) => [q[2], q[3]]),
      ...layerData.pets.map((q) => [q.x, q.z])].map(([x, z]) => ({ x: Math.floor((x + 32) / 64), y: Math.floor((z + 32) / 64) }));
    const fitBase = extra?.plain && markZones.length ? pad(bounds(markZones), 6) : objZones.length ? pad(bounds(objZones), 3) : bounds(hits.length ? hits : all),
      allBox = bounds(all);
    const withAspect = ([x, y, w, h]) => {
      const cx = x + w / 2, cy = y + h / 2;
      if (w / h > aspect) h = w / aspect; else w = h * aspect;
      return [cx - w / 2, cy - h / 2, w, h];
    };
    const fitView = () => withAspect(fitBase);
    function applyView(v) {
      const maxW = Math.max(allBox[2], allBox[3] * aspect) * 3;
      let [x, y, w, h] = v;
      const k = Math.min(Math.max(w, 6), maxW) / w;
      const cx = x + w / 2, cy = y + h / 2;
      w *= k; h *= k;
      vb = [cx - w / 2, cy - h / 2, w, h];
      st.view = vb;
      if (!drawRaf) drawRaf = requestAnimationFrame(drawView);  // pointer events come faster than frames
    }
    // While a finger or the wheel is moving the map, the drawn SVG is only shifted and scaled (a CSS transform the GPU
    // does without redrawing anything); once it rests ~150 ms, or the gesture ends, the real view is drawn and labels
    // placed. Redrawing every element (and the fog mask over the terrain) on each move is what made phones lag.
    let drawRaf = 0, drawnW = null, drawnVb = null, gesture = false, settle = 0;
    const commit = () => { clearTimeout(settle); gesture = false; if (!drawRaf) drawRaf = requestAnimationFrame(drawView); };
    const moving = () => { gesture = true; clearTimeout(settle); settle = setTimeout(commit, 150); };
    function drawView() {
      drawRaf = 0;
      if (gesture && drawnVb) {
        const W = svg.clientWidth, H = svg.clientHeight, k = drawnVb[2] / vb[2];
        svg.style.transformOrigin = '0 0';
        svg.style.willChange = 'transform';
        svg.style.transform = `translate(${((drawnVb[0] - vb[0]) / vb[2]) * W}px, ${((drawnVb[1] - vb[1]) / vb[3]) * H}px) scale(${k})`;
        return;
      }
      svg.style.transform = svg.style.willChange = '';
      drawnVb = vb;
      svg.setAttribute('viewBox', vb.map((n) => n.toFixed(3)).join(' '));
      if (vb[2] === drawnW) return;  // only moved: sizes and which labels fit stay as they are
      drawnW = vb[2];
      const fs = vb[2] / 55;
      spawnLabel.setAttribute('font-size', fs);
      spawnLabel.setAttribute('x', spawn.x + 0.5 + fs * 0.9);
      spawnLabel.setAttribute('y', -spawn.y - 0.5 - fs * 0.4);
      spawnRing.setAttribute('r', Math.max(0.8, vb[2] / 90));
      markR = Math.max(0.45, vb[2] / 120);
      // Labels by importance (players and the page's own marks, then Spawn, then the world layers); one that would overlap a kept one is hidden.
      const sx = spawn.x + 0.5 + fs * 0.9, sy = -spawn.y - 0.5 - fs * 0.4, spawnBox = [sx, sy - fs * 0.8, 3.4 * fs, fs * 1.1];
      const placed = [], hits = (lb) => placed.some((o) => lb[0] < o[0] + o[2] && o[0] < lb[0] + lb[2] && lb[1] < o[1] + o[3] && o[1] < lb[1] + lb[3]);
      let spawnDone = false;
      const placeSpawn = () => { spawnDone = true; const ok = !hits(spawnBox); if (ok) placed.push(spawnBox); spawnLabel.setAttribute('visibility', ok ? 'visible' : 'hidden'); };
      for (const k of [...marks].sort((a, b) => (b.prio ?? 5) - (a.prio ?? 5))) {
        if (!spawnDone && (k.prio ?? 5) < 5) placeSpawn();
        const r = (k.glyph ? markR * 1.1 : markR) * (k.scale || 1);
        k.dot.setAttribute('r', r);
        k.label.setAttribute('font-size', fs * 0.9);
        k.label.setAttribute('x', k.x + r * 1.4);
        k.label.setAttribute('y', k.y + fs * 0.3);
        if (k.glyph) { k.glyph.setAttribute('font-size', r * 1.35); k.glyph.setAttribute('y', k.y + r * 0.45); }
        const lb = [k.x + r * 1.4, k.y - fs * 0.6, (k.label.textContent.length * 0.56 + 0.4) * fs * 0.9, fs * 1.1];
        const show = !!k.label.textContent && !(k.labelAt && vb[2] > k.labelAt) && !hits(lb);  // crowded kinds only up close
        if (show) placed.push(lb);
        k.label.setAttribute('visibility', show ? 'visible' : 'hidden');
      }
      if (!spawnDone) placeSpawn();
    }
    const toMap = (cx, cy) => {
      const r = box.getBoundingClientRect();  // the box, not the svg: that one is shifted mid-gesture
      return [vb[0] + ((cx - r.left) / r.width) * vb[2], vb[1] + ((cy - r.top) / r.height) * vb[3]];
    };
    function zoomAt(f, mx, my) {
      const [x, y, w, h] = vb;
      applyView([mx - (mx - x) * f, my - (my - y) * f, w * f, h * f]);
    }
    function zoomCenter(f) { zoomAt(f, vb[0] + vb[2] / 2, vb[1] + vb[3] / 2); }
    function panBy(dx, dy) { const r = box.getBoundingClientRect(); applyView([vb[0] - dx * vb[2] / r.width, vb[1] - dy * vb[3] / r.height, vb[2], vb[3]]); }

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const [mx, my] = toMap(e.clientX, e.clientY);
      moving();
      zoomAt(Math.exp(d * 0.0015), mx, my);
    }, { passive: false });
    svg.addEventListener('dblclick', (e) => { const [mx, my] = toMap(e.clientX, e.clientY); zoomAt(e.shiftKey ? 2 : 0.5, mx, my); });
    const ptrs = new Map();
    let dragged = false, pinch = null;
    // Tooltip for what is under the pointer: a marker (players, pets, graves), else the zone. Mouse: on hover;
    // touch has no hover, so a tap does it — a second tap on a marker with a page opens it.
    let tapped = null, moved = 0;
    function inspect(e, touch) {
      const [mx, my] = toMap(e.clientX, e.clientY);
      const near = marks.reduce((best, k) => {
        const d = Math.hypot(k.x - mx, k.y - my);
        return d < markR * (touch ? 3 : 1.8) && (!best || d < best.d) ? { k, d } : best;
      }, null);
      if (near) {
        hl.setAttribute('visibility', 'hidden');
        tip(e, near.k.tip(), near.k.href ? el('div', { class: 'note', text: touch ? 'Tap again to open its page' : 'Click to open its page' }) : null);
        return near.k;
      }
      const i = at.get(`${Math.floor(mx)},${Math.floor(-my)}`);
      if (i == null) { unhover(); return null; }
      const z = all[i];
      hl.setAttribute('x', z.x); hl.setAttribute('y', -z.y - 1); hl.setAttribute('visibility', 'visible');
      tip(e, el('div', { class: 't', text: `Zone ${z.x}, ${z.y} · ${biomeOf(z)} · ${nf(Math.hypot(z.x - spawn.x, z.y - spawn.y) * 64 / 1000, 1)} km from spawn` }),
        tRow(null, fDateTime(z.t), 'discovered'),
        // exact (server plugin 1.15.0+): the players near enough for it to be generated; before that, everyone online then
        el('div', { class: 'note', text: z.exact ? (z.by.length ? `Discovered by ${z.by.join(', ')}` : 'World generation (no player near)')
          : z.by.length ? `Online when it was generated: ${z.by.join(', ')}` : 'World generation (nobody online)' }),
        z.l.length ? el('div', { class: 'note', text: [...new Set(z.l.map(prettyLoc))].join(', ') }) : null);
      return null;
    }
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      dragged = false;
      moved = 0;
      if (ptrs.size === 2) {
        const [[ax, ay], [bx, by]] = [...ptrs.values()];
        pinch = { d: Math.hypot(ax - bx, ay - by), m: [(ax + bx) / 2, (ay + by) / 2] };
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (vb) showCoords(e);
      if (!ptrs.has(e.pointerId)) {
        if (e.pointerType === 'mouse') inspect(e, false);
        return;
      }
      const prev = ptrs.get(e.pointerId);
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) {
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 6 && !dragged) { dragged = true; box.classList.add('dragging'); unhover(); tapped = null; }
        if (dragged) { moving(); panBy(dx, dy); }
      } else if (ptrs.size === 2 && pinch) {
        const [[ax, ay], [bx, by]] = [...ptrs.values()];
        const d = Math.hypot(ax - bx, ay - by), m = [(ax + bx) / 2, (ay + by) / 2];
        const [mx, my] = toMap(m[0], m[1]);
        moving();
        zoomAt(pinch.d / d, mx, my);
        panBy(m[0] - pinch.m[0], m[1] - pinch.m[1]);
        pinch = { d, m };
        dragged = true;
      }
    });
    const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) { box.classList.remove('dragging'); if (gesture) commit(); } };
    svg.addEventListener('pointerup', (e) => {
      const tap = ptrs.size === 1 && !dragged && !pinch;
      up(e);
      if (!tap) return;
      if (e.pointerType === 'mouse') {  // a click on a marker with a page opens it
        const [mx, my] = toMap(e.clientX, e.clientY);
        const k = marks.find((m) => m.href && Math.hypot(m.x - mx, m.y - my) < markR * 1.8);
        if (k) location.hash = k.href;
        return;
      }
      const k = inspect(e, true);
      if (k && k === tapped && k.href) { untip(); location.hash = k.href; return; }
      tapped = k;
    });
    svg.addEventListener('pointercancel', up);
    // lifting a finger "leaves" the map too: only a mouse leaving hides the tooltip
    svg.addEventListener('pointerleave', (e) => { if (!ptrs.size && e.pointerType === 'mouse') unhover(); });
    svg.addEventListener('keydown', (e) => {
      const step = 40;
      const act = { '+': () => zoomCenter(0.7), '=': () => zoomCenter(0.7), '-': () => zoomCenter(1 / 0.7), '0': () => applyView(fitView()),
        ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step) }[e.key];
      if (act) { e.preventDefault(); act(); }
    });

    // ---- legend + stats
    const far = hits.length ? Math.max(...hits.map((z) => Math.hypot(z.x - spawn.x, z.y - spawn.y))) * 64 / 1000 : 0;
    const newIn = hits.filter((z) => z.t >= c.a).length;
    const nm = (p) => (p === WORLDGEN ? 'world generation' : p);
    const who = F.zoneUsers.map((cl) => (cl.length > 1 ? `${cl.map(nm).join(' and ')} were` : `${nm(cl[0])} was`)).join(' or ');
    const stats = el('div', { class: 'hint' },
      `${plural(hits.length, 'zone')} (${nf(hits.length * 64 * 64 / 1e6, 2)} km²)${who ? ` discovered while ${who} online` : ''}`
      + ` · ${nf(newIn)} new in range · farthest ${nf(far, 1)} km from spawn`);
    const legendEl = terrainOn ? null : st.color === 'time'
      ? el('div', { class: 'seg-scale' }, 'before range', el('span', { class: 'bar' },
        el('span', { style: { background: 'var(--other)', opacity: 0.45 } }), SEQ.map((x) => el('span', { style: { background: x } }))), 'newest')
      : el('div', { class: 'legend', style: { marginTop: 0 } },
        explorers.map((p) => el('span', { class: 'key' }, el('i', { class: 'sw', style: { background: colorOf(p) } }), p)),
        el('span', { class: 'key' }, el('i', { class: 'sw', style: { background: 'var(--ink-2)' } }), 'Several together'),
        el('span', { class: 'key' }, el('i', { class: 'sw', style: { background: 'var(--other)' } }), 'World generation'));
    const shareNote = 'Only players who share their position on the in-game map';
    const posKey = P && el('div', { class: 'legend' },
      el('span', { class: 'key' }, el('i', { class: 'pm on' }), 'Online now'),
      el('span', { class: 'key' }, el('i', { class: 'pm' }), 'Last seen'),
      el('span', { class: 'hint', text: P.live ? shareNote : `Live positions unavailable since ${fDateTime(P.ok)} · ${shareNote.toLowerCase()}` }));
    host.replaceChildren(...[extra?.plain ? null : controls, box,
      extra?.plain ? null : el('div', { class: 'legend' }, legendEl, stats), posKey, extra?.legend].filter(Boolean),
      el('div', { class: 'hint map-help', text: 'Scroll or pinch to zoom · drag to move · double-click to zoom in · ⤢ fits the selection' }));

    // needs layout for the aspect ratio
    requestAnimationFrame(() => {
      const r = box.getBoundingClientRect();
      aspect = r.width / Math.max(1, r.height);
      if (focus && st.focused !== focus.id) {  // a link to a place: centre on it once, then it's the visitor's map again
        st.focused = focus.id;
        const w = 400 / 2 ** focus.zoom, cx = (focus.x + 32) / 64, cy = -(focus.z + 32) / 64;
        st.view = [cx - w / 2, cy - w / 2, w, w];
      }
      if (st.fit) { st.fit = false; st.view = null; }  // the filter line changed: everything it shows in view
      applyView(st.view ? withAspect(st.view) : fitView());
    });
  }

  const spawnZone = () => S.data.zones.find((z) => z.l.some((l) => l.startsWith('StartTemple'))) || { x: 0, y: 0 };

  // ---- step line over time (in-game day)
  function stepChart(host, { a, b, pts, color = 'var(--s1)', fmtY, label, aria }) {
    if (!pts.length) return empty(host, 'No data in this range.');
    const vals = pts.map((p) => p[1]);
    // room for the widest axis label and the end-of-line value (~7 px per digit)
    const chars = Math.max(...vals.map((v) => nf(v).length));
    const W = width(host), H = 190, left = Math.max(44, chars * 7 + 14), right = Math.max(36, chars * 7 + 12), top = 12, bottom = 22;
    const ny = niceMax(Math.max(1, Math.max(...vals) - Math.min(...vals)));
    const lo = Math.floor(Math.min(...vals) / ny.step) * ny.step;
    const hi = Math.max(lo + ny.step, Math.ceil(Math.max(...vals) / ny.step) * ny.step);
    const x = (t) => left + ((t - a) / (b - a)) * (W - left - right);
    const y = (v) => top + (H - top - bottom) * (1 - (v - lo) / (hi - lo));
    const svg = sv('svg', { width: W, height: H, role: 'img', 'aria-label': aria });
    for (let v = lo; v <= hi + 1e-9; v += ny.step) {
      svg.append(sv('line', { class: v === lo ? 'bl' : 'gl', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
      svg.append(sv('text', { class: 'ax', x: left - 8, y: y(v) + 4, 'text-anchor': 'end', text: nf(v) }));
    }
    for (const tk of timeTicks(a, b, W - left)) svg.append(sv('text', { class: 'ax', x: x(tk.t), y: H - 6, 'text-anchor': 'middle', text: tk.label }));
    let d = `M${x(pts[0][0])},${y(pts[0][1])}`;
    for (const [t, v] of pts.slice(1)) d += `H${x(t)}V${y(v)}`;
    d += `H${x(b)}`;
    svg.append(sv('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', style: { stroke: color } }));
    const last = pts[pts.length - 1];
    svg.append(sv('circle', { cx: x(b), cy: y(last[1]), r: 4, 'stroke-width': 2, style: { fill: color, stroke: 'var(--surface)' } }));
    svg.append(sv('text', { class: 'ax-ink', x: x(b) + 8, y: y(last[1]) + 4, text: nf(last[1]) }));
    const xh = sv('line', { class: 'xh', y1: top, y2: H - bottom, visibility: 'hidden' });
    const hit = sv('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = a + ((e.clientX - r.left - left) / (W - left - right)) * (b - a);
      const p = [...pts].reverse().find((q) => q[0] <= t) || pts[0];
      xh.setAttribute('x1', x(t)); xh.setAttribute('x2', x(t)); xh.setAttribute('visibility', 'visible');
      tip(e, el('div', { class: 't', text: fDateTime(t) }), tRow(null, fmtY(p[1]), label));
    });
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); untip(); });
    svg.append(xh, hit);
    host.replaceChildren(svg);
  }

  // ---- horizontal bars (played-with, raids)
  // wide: name and value on one line, bar underneath — for long labels.
  function hbars(items, fmtV, color, link, wide) {
    const max = Math.max(...items.map((i) => Math.abs(i.v)), 1);  // negative values (e.g. pieces torn down) draw by magnitude
    return el('div', { class: `hbars${wide ? ' wide' : ''}` }, items.map((i) =>
      el('div', { class: 'hbar', title: i.title || null },
        (link && (link === true || link(i))) ? el('a', { class: 'name', href: link === true ? `#/p/${encodeURIComponent(i.k)}` : link(i), text: i.k }) : el('span', { class: 'name', text: i.k }),
        el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: `${(Math.abs(i.v) / max) * 100}%`, background: color(i.k), opacity: i.v < 0 ? 0.45 : null } })),
        el('span', { class: 'v', text: fmtV(i.v) }))));
  }

  // ------------------------------------------------------------------ views

  const card = (title, hint, body, span = 'span-12', ...extra) =>
    el('section', { class: `card ${span}` }, el('div', { class: 'card-head' }, el('h2', { text: title }), hint ? el('span', { class: 'hint', text: hint }) : null, ...extra), body);
  // act: { href } to navigate, or { run } for an in-page action; either way a real link.
  function tileLink(cls, act, kids) {
    return el('a', { class: `${cls} tile-link`, href: act.href || '#/', title: act.title || null,
      onclick: act.run ? (e) => { e.preventDefault(); act.run(); } : null },
    kids, el('span', { class: 'go', 'aria-hidden': 'true', text: '→' }));
  }
  const kpi = (label, value, sub, act) => {
    // long text values (names) wrap in a smaller size instead of being cut off
    const long = typeof value === 'string' && value.length > 10 && /[^\d.,:–\s%²kmh×-]/.test(value);
    const kids = [el('div', { class: 'label', text: label }), el('div', { class: long ? 'value long' : 'value', text: value, title: long ? value : null }),
      sub ? el('div', { class: 'sub', text: sub, title: sub }) : null];
    return act ? tileLink('kpi', act, kids) : el('div', { class: 'kpi' }, kids);
  };
  const withId = (n, id) => { n.id = id; return n; };
  // Scroll to (and flash) a card on the overview after the next render.
  function focusCard(id, prep) {
    if (prep) prep();
    S.focus = id;
    if (route().player || route().view) location.hash = '#/'; else scheduleRender();
  }
  function dayBounds(t) {
    const h0 = Math.floor(t / HOUR) * HOUR, k = hourParts(h0).day;
    let a = h0, b = h0 + HOUR;
    while (hourParts(a - HOUR).day === k) a -= HOUR;
    while (hourParts(b).day === k) b += HOUR;
    return [a, b];
  }
  function zoomToDay(t, focus) {
    const [a, b] = dayBounds(t);
    S.focus = focus;
    setRange(a, Math.min(b, S.max), null);
  }
  const toLeaderboard = { title: 'Open the leaderboard', run: () => focusCard('leaderboard', () => { S.lb.key = 'impact'; S.lb.asc = false; S.lb.q = ''; }) };
  const chartHost = () => el('div', { class: 'chart' });
  const peakOf = (heat) => {
    let best = [0, 0, 0];
    heat.forEach((row, d) => row.forEach((v, h) => { if (v > best[0]) best = [v, d, h]; }));
    return best[0] ? `${DOW[best[1]]} ${String(best[2]).padStart(2, '0')}:00` : '–';
  };
  // After the cards are in the DOM (charts need their width).
  let pending = [];
  const later = (fn) => pending.push(fn);

  function overview() {
    const c = compute(S.a, S.b);
    const longest = c.ses.reduce((m, s) => (s.e - s.s > m.e - m.s ? s : m), { s: 0, e: 0, p: null });
    const zonesTotal = S.data.zones.filter((z) => z.t < S.b).length;

    const hero = tileLink('card hero', toLeaderboard, [
      el('div', { class: 'label', text: 'Time spent in Valheim' }),
      el('div', { class: 'value' }, nf(c.total / HOUR, c.total < 10 * HOUR ? 1 : 0), el('small', { text: 'player-hours' })),
      el('div', { class: 'sub', text: `${fDateY(S.a)} – ${fDateY(S.b)}` })]);
    const kpis = el('div', { class: 'kpis' },
      kpi('Vikings', nf(c.rows.filter((r) => r.play > 0).length), `${plural(S.players.length, 'player')} all time`, toLeaderboard),
      kpi('Sessions', nf(c.ses.length), c.ses.length ? `Ø ${fDur(c.total / c.ses.length)}` : null, { href: '#/sessions', title: 'All sessions' }),
      kpi('Longest session', longest.p ? fDur(longest.e - longest.s) : '–', longest.p, { href: '#/sessions?sort=dur', title: 'Sessions by length' }),
      kpi('Peak online', nf(c.peak), c.peakT ? fDateTime(c.peakT) : null,
        c.peakT ? { title: 'Zoom to the peak day', run: () => zoomToDay(c.peakT, 'activity') } : { run: () => focusCard('activity') }),
      kpi('Deaths', nf(c.deaths.length), c.total ? `${nf(c.deaths.length / (c.total / HOUR), 1)} per hour` : null, { href: '#/deaths', title: 'Deaths' }),
      kpi('Raids', nf(c.raids.length), c.raids.length ? raidName(c.raids[c.raids.length - 1].n) : null, { href: '#/raids', title: 'Raids' }),
      S.data.pets?.length ? (() => { const al = S.data.pets.filter((p) => p.status === 'alive').length, gn = S.data.pets.length - al;
        return kpi('Pets', nf(al), gn ? `${nf(gn)} gone` : 'all alive', { href: '#/pets', title: 'Pets' }); })() : null,
      S.data.fights?.length ? (() => { const fs = fightsIn();
        return kpi('Boss fights', nf(fs.length), fs.length ? `${nf(fs.filter((f) => f.outcome === 'killed').length)} won` : 'none in range', { href: '#/bosses', title: 'Boss fights' }); })() : null,
      kpi('Zones explored', nf(c.zones.length), `${nf(zonesTotal)} total`, { href: '#/world', title: 'World & exploration' }),
      kpi('In-game day', S.data.day != null ? nf(S.data.day) : '–', S.data.version ? `Valheim ${S.data.version}` : null, { href: '#/world', title: 'World & exploration' }),
      S.data.world ? kpi('Pieces built', nf(sumPieces()), `${plural(Object.keys(S.data.world.pieces).length, 'builder')}`, { href: '#/base', title: 'Base & gear' }) : null,
      (() => { const up = uptime(S.a, S.b), r = S.data.restarts.filter((t) => t >= S.a && t < S.b).length;
        return kpi('Server uptime', up ? fPct(up.up) : '–', plural(r, 'restart'), { href: '#/server', title: 'Server health' }); })());

    const tl = chartHost(), dl = chartHost(), hm = chartHost(), wd = chartHost(), hr = chartHost(), mp = el('div');
    later(() => timeline(tl, c));
    later(() => daily(dl, c));
    later(() => heatmap(hm, c));
    later(() => {
      const byDow = c.heat.map((r) => r.reduce((n, v) => n + v, 0) / HOUR);
      columns(wd, { labels: DOW, values: byDow, fmtV: (v) => fH(v * HOUR), tipT: (i) => DOW_LONG[i], aria: 'Playtime by weekday' });
      const byHour = Array.from({ length: 24 }, (_, h) => c.heat.reduce((n, r) => n + r[h], 0) / HOUR);
      columns(hr, { labels: byHour.map((_, h) => String(h).padStart(2, '0')), values: byHour, every: 3, fmtV: (v) => fH(v * HOUR),
        tipT: (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`, aria: 'Playtime by hour of day' });
    });
    later(() => {
      const ov = mapState('overview');
      if (S.dungeonLine != null && dungeonPart(ov.line) !== S.dungeonLine) { ov.line = withDungeonPart(ov.line, S.dungeonLine); ov.fit = true; }
      zoneMap(mp, c, 'overview');
    });


    return [
      el('div', { class: 'tiles' }, hero, kpis),
      el('div', { class: 'grid' },
        sinceCard(),
        recapCard(c),
        progressCard(true),
        nextBossCard(),
        withId(card('Activity', 'Players online, and every session per player · click a lane for details', tl), 'activity'),
        card('Playtime per day', 'Click a day to zoom in', dl, 'span-7'),
        card('When do we play?', `Player-hours by weekday and hour (${TZ}) · peak ${peakOf(c.heat)}`, hm, 'span-5'),
        card('By weekday', 'Player-hours', wd, 'span-6'),
        card('By hour of day', 'Player-hours', hr, 'span-6'),
        leaderboard(c),
        ...combatOverview(c),
        card('Exploration', 'Zones (64 m) generated as players explore', mp, 'span-12',
          el('a', { class: 'more-link', href: '#/world', text: 'World view →' })),
        awardsCard(c),
        achievementsCard(),
        raidsCard(c),
        feed(c),
        tavernTalk(c)),
    ];
  }

  // ---- just for fun, folded by default (the visitor's choice is remembered)
  function tavernTalk(c) {
    const cards = [funFactsCard(c), omensCard(c), milestonesCard(c), horoscopeCard(c), chemistryCard(c)].filter(Boolean);
    if (!cards.length) return null;
    return el('details', { class: 'card span-12 tavern', id: 'tavern-talk', open: store.get('gs.tavern') === '1',
      ontoggle: (e) => store.set('gs.tavern', e.currentTarget.open ? '1' : '0') },
    el('summary', null, el('div', { class: 'card-head' }, el('h2', { text: 'Tavern talk' }),
      el('span', { class: 'hint', text: `${cards.map((x) => x.querySelector('h2').textContent).join(' · ')} — just for fun` }))),
    el('div', { class: 'grid' }, cards));
  }

  // ---- recap: the range against the one right before it
  const PERIOD = { 1: ['Last 24 hours', 'previous 24 h'], 7: ['This week', 'previous 7 days'], 30: ['Last 30 days', 'previous 30 days'] };
  const dayAt = (t) => [...S.data.days].reverse().find((d) => d.t < t)?.d;
  // in-game day at a wall time from the world clock; the logged day (dayAt) only moves when someone sleeps
  const gameDayAt = (t) => { const w = worldAt(t); return w != null ? Math.floor((w - MORNING * DAY_LEN) / DAY_LEN) : dayAt(t); };
  function recapCard(c) {
    const span = c.b - c.a;
    if (S.preset === 0 || span >= S.max - S.min) return null;
    const pa = c.a - span, pb = c.a;
    const p = pb > S.min ? compute(pa, pb) : null;
    const [title, prevLabel] = PERIOD[S.preset] || ['This range', `previous ${fDur(span)}`];
    const days = (a, b) => (gameDayAt(b) != null && gameDayAt(a) != null ? gameDayAt(b) - gameDayAt(a) : null);
    const vikings = (x) => x.rows.filter((r) => r.play > 0).length;
    // [label, now, before, decimals, better: 1 more is better, -1 fewer is, 0 neutral]
    const stats = [
      ['Player-hours', c.total / HOUR, p && p.total / HOUR, 1, 1],
      ['Vikings', vikings(c), p && vikings(p), 0, 1],
      ['Sessions', c.ses.length, p && p.ses.length, 0, 1],
      ['Deaths', c.deaths.length, p && p.deaths.length, 0, -1],
      ['Raids', c.raids.length, p && p.raids.length, 0, 0],
      ['New zones', c.zones.length, p && p.zones.length, 0, 1],
      ...(S.data.world ? [['Pieces built (net)', builtInRange(c.a, c.b)?.net ?? null, p && (builtInRange(pa, pb)?.net ?? null), 0, 1]] : []),
      ['In-game days', days(c.a, c.b), p && days(pa, pb), 0, 0],
    ];
    const tiles = el('div', { class: 'recap' }, stats.map(([label, v, before, dec, better]) => {
      let delta = null;
      if (v != null && before != null) {
        const d = v - before, r = Math.abs(d) < 10 ** -dec / 2 ? 0 : d;
        const cls = !r || !better ? '' : (r > 0) === (better > 0) ? 'up' : 'down';
        delta = el('div', { class: `delta ${cls}`.trim() }, el('b', { text: r ? `${r > 0 ? '▲ +' : '▼ −'}${nf(Math.abs(r), dec)}` : '= same' }), ` vs ${prevLabel}`);
      }
      return el('div', { class: 'recap-stat' }, el('div', { class: 'label', text: label }),
        el('div', { class: 'value', text: v == null ? '–' : nf(v, dec) }), delta || el('div', { class: 'delta', text: before == null && p ? 'no data before' : '' }));
    }));

    const hl = [];
    const w = S.data.world;
    if (w) {
      const times = keyTimes();
      const inRange = (k) => times[k] && !times[k].before && times[k].to >= c.a && times[k].to < c.b;
      for (const [k, name, d] of w.bosses) if (d && inRange(k)) hl.push([`${name} defeated`, ` · ${whenText(times[k])}`]);
      for (const k of milestoneKeys(w)) if (inRange(k)) hl.push([milestoneName(k), ` · ${whenText(times[k])}`]);
    }
    for (const pl of S.players) {
      const at = playerAllTime(pl);
      if (at.first >= c.a && at.first < c.b) hl.push([[playerLink(pl), ' joined the server for the first time'], ` · ${fDateTime(at.first)}`]);
    }
    const top = [...c.rows].sort((x, y) => y.play - x.play)[0];
    if (top?.play) hl.push([[playerLink(top.p), ' played the most'], ` · ${fH(top.play)}`]);
    const ex = new Map();
    for (const z of c.zones) for (const pl of z.by) ex.set(pl, (ex.get(pl) || 0) + 1);
    const topEx = [...ex].sort((x, y) => y[1] - x[1])[0];
    if (topEx) hl.push([[playerLink(topEx[0]), ' explored the most'], ` · ${plural(topEx[1], 'new zone')}`]);
    const b = w && builtInRange(c.a, c.b);
    if (b?.rows[0]?.v > 0) hl.push([[playerLink(b.rows[0].k), ' built the most'], ` · +${nf(b.rows[0].v)} pieces`]);

    return card(title, `${fDateY(c.a)} – ${c.b >= S.max ? 'now' : fDateY(c.b)} · compared with the ${prevLabel}${p && pa < S.min ? ' (only partly tracked)' : ''}`,
      el('div', null, tiles, hl.length ? el('ul', { class: 'highlights' }, hl.map(([what, sub]) => el('li', null, what, el('span', { class: 'hint', text: sub })))) : null), 'span-12');
  }

  // ---- awards: fun superlatives for the range; the "base" ones read the current world save.
  // Metrics match extra_metrics() in collector/valheim_gamestats/notify.py, which posts hand-overs.
  const PAIR = '\t';  // a pair award's holder is "a\tb": sorted, or "follower\tleader" for a directed one
  const pairOf = (x, y) => (x < y ? `${x}${PAIR}${y}` : `${y}${PAIR}${x}`);
  const RAID_TITLES = ['foresttrolls', 'wolves', 'surtlings', 'skeletons', 'bats'];  // a "raid_<name>" title each
  const DUNGEON = /^(Crypt|SunkenCrypt|TrollCave|MountainCave|BearCave|Mistlands_DvergrTownEntrance|Hildir_crypt|Hildir_cave|Hildir_plainsfortress|MorgenHole|CharredFortress)/;
  const TRADERS = [/^Vendor_BlackForest/, /^Hildir_camp/, /^BogWitch_Camp/];
  const STINKY = ['Entrails', 'Guck', 'Ooze', 'Bloodbag'];
  const DECOR = /^(piece_(chair|bench|logbench|table|throne|banner|cloth|rug|brazier|trap_troph|pot|maypole|jackoturnip|xmas|Christmas|\w*Garland)|rug_|itemstand|ArmorStand|piece_dvergr_lantern)/;
  const FIRE = /^(fire_pit|bonfire|hearth|piece_groundtorch|piece_walltorch|piece_brazier|piece_Lavalantern|piece_dvergr_lantern|piece_jackoturnip)/;
  const STRUCT = /^(wood|stone_|darkwood|blackmarble|iron_|ashwood|grausten|stake_wall|piece_dvergr_(wood|metal))/;  // walls, floors, beams, roofs
  const WOODEN = /^(wood_|woodwall|stake_wall)/;
  const RAGE = 240, GHOST = 300, FOLLOW = 600, PACT = 60, JONAH = 600, RAID_WINDOW = 300;
  const spawnDist = (z, sp) => Math.hypot(z.x - sp.x, z.y - sp.y) * 64;  // metres

  // metric -> Map(holder -> value)
  function awardMetrics(c) {
    const M = {};
    const m = (k) => (M[k] ||= new Map());
    const add = (k, p, v = 1) => m(k).set(p, (m(k).get(p) || 0) + v);
    const hi = (k, p, v) => { if (v > (m(k).get(p) ?? -Infinity)) m(k).set(p, v); };
    const lo = (k, p, v) => { if (v < (m(k).get(p) ?? Infinity)) m(k).set(p, v); };
    const d = S.data;
    const bySes = new Map(), allDeaths = new Map();
    for (const s of d.sessions) (bySes.get(s.p) || bySes.set(s.p, []).get(s.p)).push(s);
    for (const x of d.deaths) (allDeaths.get(x.p) || allDeaths.set(x.p, []).get(x.p)).push(x.t);
    for (const ts of allDeaths.values()) ts.sort((x, y) => x - y);
    const online = (p, x, y) => (bySes.get(p) || []).reduce((n, s) => n + Math.max(0, Math.min(y, s.end_t) - Math.max(x, s.s)), 0);

    // ---- time & company
    for (const s of c.ses) {
      add('play', s.p, s.e - s.s);
      hi('marathon', s.p, s.e - s.s);
      eachHour(s.s, s.e, (h, sec) => {
        const hp = hourParts(h);
        if (hp.hour < 5) add('night', s.p, sec); else if (hp.hour < 9) add('morning', s.p, sec);
        if (hp.dow < 5 && hp.hour >= 9 && hp.hour < 17) add('wfh', s.p, sec);
      });
      // time with others online (concurrency ≥ 2) and alone (exactly them)
      for (let i = 0; i < c.conc.length; i++) {
        const [t, n] = c.conc[i], t2 = i + 1 < c.conc.length ? c.conc[i + 1][0] : c.b;
        const ov = Math.max(0, Math.min(t2, s.e) - Math.max(t, s.s));
        if (ov && n >= 2) add('company', s.p, ov); else if (ov && n === 1) add('lonewolf', s.p, ov);
      }
    }
    const play = m('play'), days = daysIn(c.a, c.b);
    for (const pl of play.keys()) {
      let cur = 0, best = 0;
      for (const day of days) {
        const sec = c.daily.get(day.key)?.get(pl) || 0;
        cur = sec > 0 ? cur + 1 : 0; best = Math.max(best, cur);
        hi('bigday', pl, sec);
      }
      m('streak').set(pl, best);
    }
    const srcs = [...new Map(c.ses.map((s) => [s.src, s])).values()];
    const logins = srcs.map((s) => s.src).filter((s) => s.s >= c.a);  // sessions that started in range
    const loginsOn = new Map();
    for (const s of logins) {
      const hp = hourParts(Math.floor(s.s / HOUR) * HOUR);
      const k = `${s.p}${PAIR}${hp.day}`;
      loginsOn.set(k, (loginsOn.get(k) || 0) + 1);
      if (hp.dow < 5 && (hp.hour === 12 || hp.hour === 13)) add('lunch', s.p);
      if (s.e != null && s.e - s.s < GHOST) add('ghost', s.p);
      const leaders = new Set(d.sessions.filter((o) => o.p !== s.p && o.s < s.s && s.s - o.s <= FOLLOW).map((o) => o.p));
      for (const q of leaders) add('lemming', `${s.p}${PAIR}${q}`);
    }
    for (const [k, n] of loginsOn) hi('revolving', k.split(PAIR)[0], n);
    const byDay = new Map();
    for (const s of logins) { const k = hourParts(Math.floor(s.s / HOUR) * HOUR).day; (byDay.get(k) || byDay.set(k, []).get(k)).push(s); }
    for (const ss of byDay.values()) {
      if (new Set(ss.map((s) => s.p)).size < 2) continue;
      add('firstlight', ss.reduce((x, s) => (s.s < x.s ? s : x)).p);
      if (ss.every((s) => s.e != null)) add('lightsout', ss.reduce((x, s) => (s.e > x.e ? s : x)).p);
    }
    for (const s of srcs.map((x) => x.src)) {
      if (s.e == null || s.e < c.a || s.e >= c.b) continue;
      if (s.end === 'restart') add('sunk', s.p);
      if (s.end === 'logout' && (allDeaths.get(s.p) || []).some((t) => t >= s.s && t <= s.e && s.e - t <= RAGE)) add('ragequit', s.p);
    }
    M.inseparable = overlaps(c.ses);
    // Ships in the night: regulars (≥3 h) — overlap over the smaller of the two playtimes
    const regulars = [...play].filter(([, v]) => v >= 3 * HOUR).map(([p]) => p).sort();
    if (regulars.length >= 3) {
      for (let i = 0; i < regulars.length; i++) for (let j = i + 1; j < regulars.length; j++) {
        const [x, y] = [regulars[i], regulars[j]];
        m('ships').set(pairOf(x, y), (M.inseparable?.get(pairOf(x, y)) || 0) / Math.min(play.get(x), play.get(y)));
      }
    }

    // ---- death & danger
    const dIn = deathsBySession(true);
    for (const s of srcs) {
      const n = dIn(s.src);
      hi('daredevil', s.p, n);
      if (!n) hi('untouchable', s.p, s.e - s.s);
      // first death of a session, counted from when they actually joined
      const first = c.deaths.filter((x) => x.p === s.p && x.t >= s.src.s && x.t <= s.src.end_t).reduce((v, x) => Math.min(v, x.t), Infinity);
      if (first < Infinity) lo('fastdeath', s.p, first - s.src.s);
    }
    const dBy = new Map();
    for (const x of c.deaths) (dBy.get(x.p) || dBy.set(x.p, []).get(x.p)).push(x.t);
    for (const [p, ts] of dBy) {
      ts.sort((x, y) => x - y);
      for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) lo('dejavu', p, ts[i] - ts[i - 1]);
    }
    for (const [p, v] of play) if (v >= 5 * HOUR && dBy.get(p)?.length) m('flyer').set(p, v / dBy.get(p).length);
    // Immortal: playtime between two deaths (or since joining / until now), for stretches ending in range
    for (const p of play.keys()) {
      const ts = allDeaths.get(p) || [];
      const ends = [...ts, Math.min(c.b, d.generated)];
      ends.forEach((e, i) => { if (e >= c.a && e <= c.b) hi('immortal', p, online(p, i ? ends[i - 1] : -Infinity, e)); });
    }
    const ds = c.deaths.slice().sort((x, y) => x.t - y.t);
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length && ds[j].t - ds[i].t <= PACT; j++) if (ds[i].p !== ds[j].p) add('pact', pairOf(ds[i].p, ds[j].p));
    }
    for (const r of c.raids) {
      for (const p of r.players) {
        add('raids', p);
        if (RAID_TITLES.includes(r.n)) add(`raid_${r.n}`, p);
        if ((bySes.get(p) || []).some((s) => s.s <= r.t && r.t - s.s <= JONAH)) add('jonah', p);
        if (!(allDeaths.get(p) || []).some((t) => t >= r.t && t < r.t + RAID_WINDOW)) add('survivor', p);
      }
    }
    for (const x of c.deaths) if (d.raids.some((r) => x.t >= r.t && x.t < r.t + RAID_WINDOW)) add('casualty', x.p);
    // "x within an hour": the best sliding one-hour window per player. pairs: [[player, t]]
    const bestHour = (k, pairs) => {
      const by = new Map();
      for (const [p, t] of pairs) (by.get(p) || by.set(p, []).get(p)).push(t);
      for (const [p, ts] of by) {
        ts.sort((x, y) => x - y);
        let j = 0, best = 0;
        ts.forEach((t, i) => { while (t - ts[j] >= HOUR) j++; best = Math.max(best, i - j + 1); });
        m(k).set(p, best);
      }
    };
    bestHour('badhour', c.deaths.map((x) => [x.p, x.t]));

    // ---- exploration
    const sp = spawnZone();
    for (const z of c.zones) {
      for (const p of z.by) {
        add('pathfinder', p);
        add('_dist', p, spawnDist(z, sp));
        hi('edgelord', p, spawnDist(z, sp));
        if (z.l.some((l) => DUNGEON.test(l))) add('dungeon', p);
        if (z.l.some((l) => l.startsWith('ShipWreck'))) add('sealegs', p);
      }
    }
    for (const [p, n] of m('pathfinder')) if (n >= 10 && (play.get(p) || 0) >= 2 * HOUR) m('homebody').set(p, M._dist.get(p) / n);
    for (const re of TRADERS) {
      const z = d.zones.find((x) => x.l.some((l) => re.test(l)));  // zones are in discovery order
      if (z && z.t >= c.a && z.t < c.b) for (const p of z.by) add('contact', p);
    }
    bestHour('blitz', c.zones.flatMap((z) => z.by.map((p) => [p, z.t])));

    // ---- building (range) and the base as it stands
    for (const r of (d.world && builtInRange(c.a, c.b)?.rows) || []) if (r.v > 0) m('builder').set(r.k, r.v);
    // pieces added / torn down between two consecutive hourly world saves
    const hist = d.world ? HIST() : [];
    for (let i = 1; i < hist.length; i++) {
      const h0 = hist[i - 1], h1 = hist[i];
      // both snapshots from the same (crop-free, v4+) reader: a counting change is not building or demolishing
      if (h1.t < c.a || h1.t >= c.b || h1.t - h0.t > 1.5 * HOUR || !h0.v || h0.v !== h1.v) continue;
      for (const p of new Set([...Object.keys(h0.pieces), ...Object.keys(h1.pieces)])) {
        const dlt = (h1.pieces[p] || 0) - (h0.pieces[p] || 0);
        hi('speedbuild', p, dlt);
        hi('wreck', p, -dlt);
      }
    }
    // Passenger: share of exploration + building over share of playtime (1 = pulls their weight)
    const crew = [...play].filter(([, v]) => v >= 2 * HOUR).map(([p]) => p);
    if (crew.length >= 2) {
      const sum = (k) => crew.reduce((n, p) => n + (M[k]?.get(p) || 0), 0);
      const T = sum('play'), F = sum('pathfinder'), B = sum('builder');
      for (const p of crew) {
        const parts = [F ? (M.pathfinder?.get(p) || 0) / F : null, B ? (M.builder?.get(p) || 0) / B : null].filter((x) => x != null);
        if (parts.length) m('passenger').set(p, parts.reduce((n, x) => n + x, 0) / parts.length / (play.get(p) / T));
      }
    }
    const w = d.world;
    if (w) {
      for (const [name, it] of Object.entries(ITEMS())) {
        for (const [p, n] of Object.entries(it.shown || {})) add('taxidermist', p, n);
        for (const [p, q] of Object.entries(it.q || {})) for (const [lvl, n] of Object.entries(q)) if (Number(lvl) >= 3) add('overachiever', p, n);
        if (/sapling/i.test(name)) continue;  // crops grow into objects without a creator
        for (const [p, n] of Object.entries(it.built || {})) {
          add('_pieces', p, n);
          if (DECOR.test(name)) add('_decor', p, n);
          if (FIRE.test(name)) add('pyro', p, n);
          if (STRUCT.test(name)) { add('_struct', p, n); if (WOODEN.test(name)) add('_wood', p, n); }
        }
      }
      for (const [p, n] of m('_pieces')) if (n >= 30) m('decorator').set(p, (M._decor?.get(p) || 0) / n);
      if (w.keys.includes('defeated_gdking')) for (const [p, n] of m('_struct')) if (n >= 50) m('woodage').set(p, (M._wood?.get(p) || 0) / n);
      for (const [p, n] of Object.entries(w.chests || {})) if (n >= 3) m('tetris').set(p, (w.chest_items?.[p] || 0) / n);
      for (const [p, n] of Object.entries(w.beds || {})) m('nomad').set(p, n);
      for (const [p, k] of Object.entries(w.kitchen || {})) m('gordon').set(p, (k.burnt || 0) + (k.done || 0));
    }
    // combat & gathering, from the server plugin's events in range
    for (const r of c.rows) {
      if (!r.gathered) continue;
      const set = (k, v) => { if (v) m(k).set(r.p, v); };
      set('slayer', r.kills); set('berserker', Math.round(r.dealt || 0)); set('punchbag', Math.round(r.taken || 0));
      set('lumberjack', r.felled); set('prospector', r.mined); set('magpie', r.picked);
      set('biggame', [...(r.gathered.kills || [])].reduce((n, [i, v]) => n + (starsOf(i) ? v : 0), 0));
      set('bossbane', gatherSum(r, 'kills', BOSS_RE)); set('butcher', gatherSum(r, 'kills', ANIMAL_RE));
      set('robinhood', gatherSum(r, 'wkills', BOW_RE)); set('brawler', r.gathered.wkills?.get('Unarmed') || 0);
      set('forager', gatherSum(r, 'picked', FORAGE_RE));
      set('hoard', r.looted); set('rock', r.gathered.picked?.get('Stone') || 0); set('honey', r.gathered.picked?.get('Honey') || 0);
      set('stinky', [...(r.gathered.picked || [])].reduce((n, [i, v]) => n + (STINKY.includes(i) ? v : 0), 0));
    }
    // body & movement, from the plugin's sums, hourly maxima and feats in range
    for (const r of c.rows) {
      const set = (k, v) => { if (v) m(k).set(r.p, v); };
      const pk = r.peak || {}, fs = r.feats || [], dist = r.gathered?.dist;
      set('tank', pk.hp); set('mountaineer', pk.y > 0 ? pk.y : 0); set('speeddemon', pk.v_foot); set('oneforteam', pk.hit);
      set('globetrotter', r.dist); set('fish', dist?.get('swim')); set('seadog', dist?.get('boat')); set('rider', dist?.get('ride'));
      set('empty', r.exhn); set('sleepyhead', r.beds); set('showman', r.emotes); set('sneaky', r.crouch);
      const of = (kind) => fs.filter((f) => f[2] === kind).map((f) => f[3]);
      set('sprinter', Math.max(0, ...of('sprint'))); set('skydiver', Math.max(0, ...of('fall')));
      const cc = of('closecall');
      set('closecalls', cc.length);
      if (cc.length) m('lastbreath').set(r.p, Math.min(...cc));
    }
    return M;
  }

  // Plugin object names (prefabs) the combat & gathering titles and badges group by.
  const BOSS_RE = /^(Eikthyr|gd_king|Bonemass|Dragon|GoblinKing|SeekerQueen|Fader)(\*|$)/;
  const ANIMAL_RE = /^(Boar|Deer|Neck|Hare|Lox|Chicken|Hen|Asksvin)(\*|$)/;
  const FORAGE_RE = /^(Raspberry|Blueberries|Cloudberry|Mushroom\w*|Thistle|Dandelion|Carrot|Turnip|Onion|Barley|Flax|Fiddleheadfern|Vineberry|Jotun\w*)$/;
  const BOW_RE = /^(Bow|Crossbow)/;
  // Sum of a plugin breakdown (kills, picked, wkills, …) over the objects matching re.
  const gatherSum = (r, key, re) => [...(r.gathered?.[key] || [])].reduce((n, [i, v]) => n + (re.test(i) ? v : 0), 0);
  // Titles: what each one is, its group, minimum and text are the rules (scoring.json, the server's overrides merged in);
  // here is only how a value reads. k: title (and metric) key · min: least value that qualifies · low: lowest wins (min
  // ignored) · pair: joiner for pair holders.
  const TITLE_FMT = {
    marathon: fDur,
    streak: (v) => plural(v, 'day'),
    bigday: fH,
    night: fH,
    morning: fH,
    wfh: (v) => `${fH(v)} on the clock`,
    lunch: (v) => plural(v, 'lunch break'),
    company: fH,
    lonewolf: (v) => `${fH(v)} alone`,
    inseparable: (v) => `${fH(v)} together`,
    ships: (v) => `together ${pct(v)} of the time`,
    lemming: (v) => `${nf(v)}× right behind`,
    firstlight: (v) => `first in on ${plural(v, 'day')}`,
    lightsout: (v) => `last out on ${plural(v, 'day')}`,
    revolving: (v) => `${nf(v)} logins in a day`,
    ghost: (v) => plural(v, 'drive-by visit'),
    sunk: (v) => `${plural(v, 'session')} sunk`,
    untouchable: fDur,
    immortal: (v) => `${fH(v)} · ≈ ${plural(Math.round(v / 1800), 'in-game day')}`,
    daredevil: (v) => plural(v, 'death'),
    badhour: (v) => `${plural(v, 'death')} in an hour`,
    dejavu: (v) => `died twice in ${fDur(v)}`,
    fastdeath: (v) => `dead ${fDur(v)} after joining`,
    flyer: (v) => `a death every ${fDur(v)}`,
    ragequit: (v) => plural(v, 'ragequit'),
    pact: (v) => `${nf(v)}× off to Valhalla together`,
    raids: (v) => plural(v, 'raid'),
    jonah: (v) => `${plural(v, 'raid')} brought along`,
    survivor: (v) => `${plural(v, 'raid')} survived`,
    casualty: (v) => plural(v, 'death'),
    slayer: (v) => plural(v, 'kill'),
    berserker: (v) => `${nf(v)} damage`,
    biggame: (v) => plural(v, 'starred kill'),
    bossbane: (v) => plural(v, 'boss', 'bosses'),
    butcher: (v) => plural(v, 'animal'),
    robinhood: (v) => plural(v, 'kill'),
    brawler: (v) => plural(v, 'kill'),
    punchbag: (v) => `${nf(v)} damage taken`,
    lumberjack: (v) => plural(v, 'tree'),
    prospector: (v) => plural(v, 'deposit'),
    magpie: (v) => plural(v, 'item'),
    forager: (v) => `${nf(v)} picked`,
    pathfinder: (v) => plural(v, 'zone'),
    blitz: (v) => `${plural(v, 'zone')} in an hour`,
    edgelord: (v) => `${nf(v / 1000, 2)} km out`,
    homebody: (v) => `Ø ${nf(v / 1000, 2)} km from spawn`,
    dungeon: (v) => plural(v, 'dungeon'),
    contact: (v) => `found ${plural(v, 'trader')}`,
    sealegs: (v) => plural(v, 'shipwreck'),
    builder: (v) => `+${nf(v)} pieces`,
    speedbuild: (v) => `+${nf(v)} pieces in an hour`,
    wreck: (v) => `−${nf(v)} pieces in an hour`,
    passenger: (v) => `pulls ${nf(v, 2)}× their weight`,
    hoard: (v) => `${nf(v)} items`,
    rock: (v) => `${nf(v)} stone`,
    stinky: (v) => `${nf(v)} smelly things`,
    honey: (v) => `${nf(v)} honey`,
    tetris: (v, ps) => `${plural(S.data.world?.chests?.[ps[0]] || 0, 'chest')}, Ø ${nf(v)} items each`,
    decorator: (v) => `${pct(v)} decor`,
    woodage: (v) => `${pct(v)} wood`,
    pyro: (v) => plural(v, 'fire'),
    overachiever: (v) => `${nf(v)} × ★3+`,
    taxidermist: (v) => `${nf(v)} on display`,
    nomad: (v) => plural(v, 'bed'),
    gordon: (v) => plural(v, 'sad meal'),
    tank: (v) => `${nf(v)} health`,
    lastbreath: (v) => `${nf(v, 1)} health left`,
    closecalls: (v) => plural(v, 'close call'),
    sprinter: (v) => `${nf(v)} m`,
    speeddemon: (v) => `${nf(v * 3.6, 1)} km/h`,
    mountaineer: (v) => `${nf(v)} m above the sea`,
    skydiver: (v) => `${nf(v)} m`,
    oneforteam: (v) => `${nf(v)} damage`,
    globetrotter: (v) => `${nf(v / 1000, 1)} km`,
    fish: (v) => `${nf(v / 1000, 2)} km`,
    seadog: (v) => `${nf(v / 1000, 1)} km`,
    rider: (v) => `${nf(v / 1000, 2)} km`,
    empty: (v) => plural(v, 'time'),
    sleepyhead: (v) => plural(v, 'night'),
    showman: (v) => plural(v, 'emote'),
    sneaky: (v) => `${nf(v / 60)} min`,
  };
  for (const n of RAID_TITLES) TITLE_FMT[`raid_${n}`] = (v) => plural(v, 'raid');
  const titleRule = (t) => t.rule.replaceAll('{tz}', TZ);
  function awardDefs() {
    return Object.entries(SC().titles).map(([k, t]) => ({ k, g: t.group, ico: t.icon, t: t.title, rule: titleRule(t), min: t.min ?? 0,
      low: !!t.low, pair: t.pair, f: TITLE_FMT[k] }));
  }

  function awardsCard(c) {
    if (!c.ses.length) return null;
    const M = awardMetrics(c);
    // Highest value wins (lowest with low); ties share the award.
    const win = (mp, min, low) => {
      const vals = [...(mp || [])].filter(([, v]) => (low ? v != null : v >= min));
      if (!vals.length) return null;
      const top = (low ? Math.min : Math.max)(...vals.map(([, v]) => v));
      return { ps: vals.filter(([, v]) => v === top).map(([k]) => k).sort(), v: top };
    };
    const holder = (h, join) => h.split(PAIR).map((p, i) => [i ? join : '', el('a', { href: `#/p/${encodeURIComponent(p)}`, text: p })]);
    const won = awardDefs().map((a) => ({ ...a, w: win(M[a.k], a.min, a.low) })).filter((a) => a.w);
    if (!won.length) return null;
    return card('Titles', `One holder at a time — beat their number to take the title · for the selected range; “current world” ones read the latest world save · ${HOVER} for the rule`,
      el('div', { class: 'award-groups' }, Object.entries(SC().title_groups).map(([g, label]) => {
        const list = won.filter((a) => a.g === g);
        return list.length ? el('div', null, el('h3', { text: label }), el('div', { class: 'awards' }, list.map((a) =>
          el('div', { class: 'award', title: a.rule }, el('span', { class: 'ico', 'aria-hidden': 'true', text: a.ico }),
            el('div', { class: 'title', text: a.t }),
            el('div', { class: 'winner', title: a.w.ps.map((h) => h.split(PAIR).join(a.pair || ', ')).join(', ') },
              a.w.ps.map((h, i) => [i ? ', ' : '', holder(h, a.pair)])),
            el('div', { class: 'val', text: a.f(a.w.v, a.w.ps) }))))) : null;
      })), 'span-12', scoringLink('titles'));
  }

  // ------------------------------------------------------------------ fun statistics

  // Time each pair spent online together: Map(pairOf(a, b) -> seconds), from clipped sessions.
  function overlaps(ses) {
    const out = new Map(), by = ses.slice().sort((x, y) => x.s - y.s);
    for (let i = 0; i < by.length; i++) {
      for (let j = i + 1; j < by.length && by[j].s < by[i].e; j++) {
        if (by[i].p === by[j].p) continue;
        const k = pairOf(by[i].p, by[j].p);
        out.set(k, (out.get(k) || 0) + Math.min(by[i].e, by[j].e) - by[j].s);
      }
    }
    return out;
  }
  // Real places to hold the explored area against, km².
  const PLACES = [[0.00714, 'football pitch', 'football pitches'], [0.49, 'Vatican City', 'Vatican Cities'], [2.02, 'Monaco', 'Monacos'],
    [3.41, 'Central Park', 'Central Parks'], [59.1, 'Manhattan', 'Manhattans'], [160, 'Liechtenstein', 'Liechtensteins'],
    [891, 'Berlin', 'Berlins'], [2586, 'Luxembourg', 'Luxembourgs']];
  // Rough wood cost per piece (wood, fine wood and core wood alike); unlisted wood_* pieces cost 2.
  const WOOD_COST = { wood_wall_half: 1, wood_wall_quarter: 1, wood_floor_1x1: 1, wood_beam_1: 1, wood_pole: 1, wood_pole_log: 1, wood_fence: 1,
    wood_stepladder: 3, wood_door: 4, wood_fence_gate: 4, stake_wall: 4, wood_gate: 8, bed: 8, ArmorStand: 8, piece_workbench: 10,
    piece_chest_wood: 10, piece_chest: 10, piece_chest_barrel: 6, piece_bench01: 4, piece_logbench01: 4, piece_table: 4, piece_chair: 2,
    piece_chair02: 4, sign: 1, itemstand: 1, itemstandh: 1, piece_groundtorch_wood: 2, fire_pit: 2, portal_wood: 20 };
  const woodCost = (n) => WOOD_COST[n] ?? (/^(wood_|woodwall)/.test(n) ? 2 : 0);
  const WOOD_PER_TREE = 10;
  const hashStr = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.codePointAt(0)) | 0, 7);
  const fact = (ico, value, text, sub, cls) => el('div', { class: `fact${cls ? ` ${cls}` : ''}` },
    el('span', { class: 'ico', 'aria-hidden': 'true', text: ico }), el('div', { class: 'value', text: value }),
    el('div', { class: 'text', text }), sub ? el('div', { class: 'sub', text: sub }) : null);

  function funFactsCard(c) {
    const d = S.data, w = d.world, F = [];
    const zones = d.zones.filter((z) => z.t < c.b).length;
    if (zones) {
      const km2 = zones * 64 * 64 / 1e6;
      const [ref, one, many] = [...PLACES].reverse().find(([a]) => km2 >= a) || PLACES[0];
      const n = km2 / ref;
      F.push(fact('🗺', n < 1 ? `${pct(n)} of a ${one}` : n < 1.05 ? `1 ${one}` : `${nf(n, n < 10 ? 1 : 0)} ${many}`, 'explored so far',
        `${nf(km2, 2)} km² · ${nf(km2 / PLACES[0][0])} football pitches`));
    }
    if (w) {
      let wood = 0, meads = 0;
      for (const [name, it] of Object.entries(ITEMS())) {
        if (!/sapling/i.test(name)) wood += woodCost(name) * total(it.built);
        if (/^(Mead|BarleyWine)/.test(name)) meads += it.kept || 0;
      }
      if (wood) F.push(fact('🌲', `≈ ${nf(Math.round(wood / WOOD_PER_TREE))} trees`, 'felled for what’s standing', `≈ ${nf(wood)} wood in the pieces · ~${WOOD_PER_TREE} wood a tree`));
      const rate = c.total ? c.deaths.length / (c.total / HOUR) : 0;
      if (meads) F.push(fact('🍺', plural(meads, 'mead'), 'in the cellar', rate ? `one per death lasts ${fH(meads / rate * HOUR)} of play at this range’s death rate` : 'and nobody died in this range to need one'));
    }
    if (d.day != null) F.push(fact('🎂', `${nf(d.day / 365, 2)} Viking years`, `the world is ${plural(d.day, 'day')} old`, 'an in-game day lasts 30 minutes of someone being online'));
    const hard = c.deaths.filter((x) => x.hard).length;
    if (hard) F.push(fact('💸', `${nf(hard * 50 * S.skillLoss, 1)} levels`, 'of every skill paid to Odin', `if every skill sat at level 50 · ${plural(hard, 'costly death')} in range`));
    const objs = d.samples.filter((x) => x[2] != null);
    const objAt = (t) => [...objs].reverse().find((x) => x[0] < t)?.[2];
    const o0 = objAt(c.a) ?? objs.find((x) => x[0] >= c.a)?.[2], o1 = objAt(c.b);
    if (o0 != null && o1 != null && c.total >= HOUR) {
      F.push(fact('👣', `${o1 >= o0 ? '+' : '−'}${nf(Math.abs(o1 - o0) / (c.total / HOUR))}`, 'world objects per hour of play', `${nf(o0)} → ${nf(o1)} objects held by the server`));
    }
    if (c.deaths.length >= 5) {
      const ds = c.deaths.slice().sort((x, y) => x.t - y.t);
      let caught = 0;
      ds.forEach((x, i) => { for (let j = i + 1; j < ds.length && ds[j].t - x.t <= 120; j++) if (ds[j].p !== x.p) { caught++; break; } });
      F.push(fact('🦠', pct(caught / ds.length), 'of deaths are contagious', 'someone else died within the next 2 minutes'));
    }
    if (w?.portals?.length) {
      const lonely = portalList().filter((p) => !portalLinked(p)).length;
      const longest = w.portals.map(([t]) => t).reduce((x, t) => (t.length > x.length ? t : x), '');
      F.push(fact('🌀', nf(lonely), lonely === 1 ? 'portal to nowhere' : 'portals to nowhere', longest ? `longest tag: “${longest}”` : null));
    }
    if (w?.signs?.length) {
      const s = w.signs[Math.abs(hashStr(hourParts(Math.floor(d.generated / HOUR) * HOUR).day)) % w.signs.length];
      F.push(fact('🪧', `“${plainText(s)}”`, 'sign of the day', `one of ${plural(w.signs.length, 'sign')}, a new one every day`, 'quote'));
    }
    if (w?.named_tames?.length) {
      const odd = (n) => n.length + 3 * (n.match(/[^\p{L} ]/gu) || []).length;  // longer and stranger is better
      const [name, sp] = w.named_tames.reduce((x, t) => (odd(t[0]) > odd(x[0]) ? t : x));
      F.push(fact('🐾', `“${name}”`, `the ${pretty(sp).toLowerCase()} · best pet name`, `${plural(w.named_tames.length, 'named tame')} in the world`, 'quote'));
    }
    return F.length ? card('Fun facts', 'Silly numbers for the selected range and the current world', el('div', { class: 'facts' }, F), 'span-12') : null;
  }

  function omensCard(c) {
    const O = [];
    let live = 0;  // time with anyone online
    c.conc.forEach(([t, n], i) => { if (n > 0) live += (i + 1 < c.conc.length ? c.conc[i + 1][0] : c.b) - t; });
    if (live >= HOUR) {
      const top = raidTypes(c.raids)[0];
      O.push(fact('🌩', pct(1 - Math.exp(-c.raids.length / (live / HOUR))), 'chance of a raid in your next hour online',
        top ? `most likely: ${top.k}` : 'no raids in this range — enjoy it while it lasts'));
    }
    const rate = c.total ? c.deaths.length / (c.total / HOUR) : 0;
    if (c.deaths.length >= 5 && rate) {
      // deaths per player-hour in a bucket, against the range's average; buckets need ≥2 player-hours
      const odds = (deaths, hours) => deaths.map((n, i) => (hours[i] >= 2 ? n / hours[i] / rate : null));
      const ends = (xs) => { const ok = xs.map((v, i) => [v, i]).filter(([v]) => v != null); return ok.length ? [ok.reduce((m, x) => (x[0] > m[0] ? x : m)), ok.reduce((m, x) => (x[0] < m[0] ? x : m))] : null; };
      const byH = odds(perHour(c.deaths.map((x) => x.t)), Array.from({ length: 24 }, (_, h) => c.heat.reduce((n, r) => n + r[h], 0) / HOUR));
      const h = ends(byH);
      if (h) O.push(fact('🕯', `${nf(h[0][0], 1)}×`, `the death rate ${hhLabel(h[0][1])}`, `safest: ${hhLabel(h[1][1])} at ${nf(h[1][0], 1)}× · 1× = average`));
      const dd = new Array(7).fill(0);
      for (const x of c.deaths) dd[hourParts(Math.floor(x.t / HOUR) * HOUR).dow] += 1;
      const wd = ends(odds(dd, c.heat.map((r) => r.reduce((n, v) => n + v, 0) / HOUR)));
      if (wd) O.push(fact('🐈‍⬛', `${nf(wd[0][0], 1)}×`, `the death rate on ${DOW_LONG[wd[0][1]]}s`, `luckiest: ${DOW_LONG[wd[1][1]]}s at ${nf(wd[1][0], 1)}× · 1× = average`));
    }
    return O.length ? card('Odds & omens', `Forecasts from this range (${TZ})`, el('div', { class: 'facts' }, O), 'span-6') : null;
  }

  // The steps are the rules' milestones, the same the Discord feed posts.
  function milestonesCard(c) {
    const d = S.data, span = c.b - c.a, ms = SC().milestones;
    const dayStep = ms.day_every ? [(Math.floor((d.day ?? 0) / ms.day_every) + 1) * ms.day_every] : [];
    const days = (a, b) => (gameDayAt(b) != null && gameDayAt(a) != null ? gameDayAt(b) - gameDayAt(a) : 0);
    const rows = [
      ['⏳', 'player-hours', d.sessions.reduce((n, s) => n + s.end_t - s.s, 0) / HOUR, c.total / HOUR, ms.hours],
      ['🧭', 'zones explored', d.zones.length, c.zones.length, ms.zones],
      ...(d.world ? [['🏗', 'pieces standing', sumPieces(), builtInRange(c.a, c.b)?.net ?? 0, ms.pieces]] : []),
      ['💀', 'deaths', d.deaths.length, c.deaths.length, ms.deaths],
      ...(d.gather?.length ? (() => {
        const all = (e) => d.gather.reduce((n, g) => n + (g[2] === e ? g[4] : 0), 0);
        const inRange = (e) => d.gather.reduce((n, g) => n + (g[2] === e && g[0] >= c.a && g[0] < c.b ? g[4] : 0), 0);
        return [['🗡', 'kills', all('kill'), inRange('kill'), ms.count],
          ['🌲', 'trees felled', all('fell'), inRange('fell'), ms.count],
          ['🎒', 'items collected', all('pick'), inRange('pick'), ms.count]];
      })() : []),
      ['☀', 'in-game day', d.day ?? 0, days(c.a, c.b), dayStep],
    ].map(([ico, label, cur, gain, steps]) => {
      const next = steps.find((s) => s > cur);
      const eta = next && gain > 0 ? d.generated + (next - cur) / (gain / span) : null;
      return { ico, label: label === 'in-game day' ? `Day ${nf(next || 0)}` : `${nf(next || 0)} ${label}`, next, eta, cur };
    }).filter((r) => r.next);
    if (!rows.length) return null;
    const until = (t) => { const s = t - S.data.generated; return s < 2 * DAY ? `in ${fDur(s)}` : `in ${nf(s / DAY)} days`; };
    return card('Coming up', 'Next round numbers, at the pace of the selected range', el('ul', { class: 'eta' }, rows.map((r) =>
      el('li', null, el('span', { class: 'ico', 'aria-hidden': 'true', text: r.ico }),
        el('span', null, el('b', { text: r.label }), el('span', { class: 'hint', text: ` · ${nf(r.next - r.cur)} to go` })),
        el('span', { class: 'hint', text: r.eta ? `≈ ${fDateY(r.eta)} · ${until(r.eta)}` : 'not at this pace' })))), 'span-6');
  }

  // The weekday-hour slot p was online in (≥10 min of it) most reliably: times seen ÷ times that slot occurred in [a, b).
  function horoscope(p, a = S.a, b = S.b) {
    const slots = new Map(), seen = new Map(), sec = new Map();
    const key = (h) => { const hp = hourParts(h); return hp.dow * 24 + hp.hour; };
    for (let h = Math.floor(a / HOUR) * HOUR; h < b; h += HOUR) slots.set(key(h), (slots.get(key(h)) || 0) + 1);
    for (const s of S.data.sessions) if (s.p === p) eachHour(Math.max(s.s, a), Math.min(s.end_t, b), (h, x) => sec.set(h, (sec.get(h) || 0) + x));
    for (const [h, x] of sec) if (x >= 600) seen.set(key(h), (seen.get(key(h)) || 0) + 1);
    let best = null;
    for (const [k, n] of seen) {
      const pr = n / slots.get(k);
      // a slot seen twice beats any seen once; then the likelier, then the more often seen
      const rank = [Math.min(n, 2), pr, n];
      const i = best ? rank.findIndex((v, j) => v !== best.rank[j]) : 0;
      if (i >= 0 && (!best || rank[i] > best.rank[i])) best = { dow: Math.floor(k / 24), hour: k % 24, pr, n, rank };
    }
    return best;
  }
  const ZODIAC = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  function horoscopeCard(c) {
    const lines = c.rows.filter((r) => r.play >= 2 * HOUR).sort((x, y) => y.play - x.play).map((r) => [r.p, horoscope(r.p, c.a, c.b)]).filter(([, h]) => h);
    if (!lines.length) return null;
    return card('Viking horoscope', `When Thor expects each Viking: their most reliable weekday & hour in range (${TZ})`, el('ul', { class: 'eta' }, lines.map(([p, h]) =>
      el('li', null, el('span', { class: 'ico', 'aria-hidden': 'true', text: ZODIAC[Math.max(0, S.players.indexOf(p)) % ZODIAC.length] }),
        el('span', null, playerLink(p), ` on ${DOW_LONG[h.dow]}s around ${hh(h.hour)}`),
        el('span', { class: 'hint', text: `${pct(h.pr)} of the time` })))), 'span-6');
  }

  function chemistryCard(c) {
    const ps = c.rows.filter((r) => r.play > 0).sort((x, y) => y.play - x.play).slice(0, SLOTS).map((r) => r.p);
    if (ps.length < 2) return null;
    const tog = overlaps(c.ses);
    const max = Math.max(...tog.values(), 1);
    const cell = (x, y) => {
      if (x === y) return el('td', { class: 'self', text: '·' });
      const v = tog.get(pairOf(x, y)) || 0;
      const step = v ? Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length)) : -1;
      return el('td', { title: `${x} & ${y}: ${fH(v)} together` },
        el('span', { class: 'chem-sw', style: { background: step < 0 ? 'var(--empty)' : SEQ[step] } }), !v ? '–' : v < 360 ? '<0.1 h' : fH(v));
    };
    const short = (p) => (p.length > 10 ? `${p.slice(0, 9)}…` : p);
    return card('Chemistry', 'Hours online together, per pair · darker = more', el('div', { class: 'table-wrap' }, el('table', { class: 'chem' },
      el('thead', null, el('tr', null, el('th'), ps.map((p) => el('th', { title: p, text: short(p) })))),
      el('tbody', null, ps.map((x) => el('tr', null, el('th', null, playerLink(x)), ps.map((y) => cell(x, y))))))), 'span-6');
  }

  // Personal badges from the plugin stats, all time. What each one counts is here; its name, unit and the steps of
  // each level (Bronze … Diamond) are the rules.
  const BADGE_VALUE = {
    slayer: (r) => r.kills, berserker: (r) => r.dealt, bossbane: (r) => gatherSum(r, 'kills', BOSS_RE),
    archer: (r) => gatherSum(r, 'wkills', BOW_RE), lumberjack: (r) => r.felled, prospector: (r) => r.mined,
    collector: (r) => r.picked, forager: (r) => gatherSum(r, 'picked', FORAGE_RE),
  };
  const badgeDefs = () => Object.entries(SC().badges).map(([k, b]) => [b.icon, b.name, BADGE_VALUE[k], b.steps, b.unit]);
  const badgeTier = (n) => SC().badge_tiers[n - 1];  // level n (1 = the lowest)
  // All-time badges of a player: [{ico, name, v, steps, unit, tier: 0 none … 3 gold}], null without plugin data
  function badgesOf(p) {
    const r = compute(S.min, S.max, p).rows.find((x) => x.p === p);
    if (!r?.gathered) return null;
    return badgeDefs().map(([ico, name, fn, steps, unit]) => {
      const v = Math.round(fn(r) || 0);
      return { ico, name, v, steps, unit, tier: steps.filter((s) => v >= s).length };
    });
  }
  function badgesCard(p) {
    const bs = badgesOf(p);
    if (!bs) return null;
    const tiles = bs.map(({ ico, name, v, steps, unit, tier }) => {
      const next = steps[tier];
      return el('div', { class: 'award', style: { opacity: tier ? null : 0.45 },
        title: `${name}: ${steps.map((s, i) => `${badgeTier(i + 1).name} at ${nf(s)}`).join(' · ')} ${unit}` },
        el('span', { class: 'ico', 'aria-hidden': 'true', text: ico }),
        el('div', { class: 'title', text: name }),
        el('div', { class: 'winner', text: tier ? `${badgeTier(tier).icon} ${badgeTier(tier).name}` : 'not yet' }),
        el('div', { class: 'val', text: next ? `${nf(v)} / ${nf(next)} ${unit}` : `${nf(v)} ${unit} · maxed` }));
    });
    const earned = bs.filter((b) => b.tier > 0).length;
    return card('Badges', `${nf(earned)} of ${nf(bs.length)} earned · all time, since the server plugin started logging · ${HOVER} for the steps`,
      el('div', { class: 'awards' }, tiles), 'span-12', scoringLink('badges'));
  }

  // ---- full lists behind the overview's top-10 cards (#/ranking/<kind>)
  const RANKINGS = {
    killers: { title: 'Top killers', hint: 'Every player who fought in range', unit: 'player' },
    creatures: { title: 'Kills by creature', hint: 'Every creature killed in range, by kind and stars', unit: 'kind' },
    weapons: { title: 'Damage by weapon', hint: 'Every weapon that dealt damage in range', unit: 'weapon' },
    gatherers: { title: 'Top gatherers', hint: 'Every player who picked up, felled or mined something in range', unit: 'player' },
    collected: { title: 'Collected', hint: 'Every item picked up in range', unit: 'kind' },
  };
  const labelCount = (m) => new Set([...m.keys()].map((i) => gatherLabel(i))).size;
  const allLink = (kind, n) => (n ? el('a', { class: 'more-link', href: `#/ranking/${kind}`, text: `All ${nf(n)} →` }) : null);
  // Summed over players by display name (two prefabs can be the same creature): label → {raw, v: {key: n}, by: player → n of byKey}
  function byLabel(rows, keys, byKey) {
    const out = new Map();
    for (const r of rows) for (const key of keys) for (const [i, n] of r.gathered?.[key] || []) {
      const k = gatherLabel(i);
      const e = out.get(k) || { raw: i, v: {}, by: new Map() };
      e.v[key] = (e.v[key] || 0) + n;
      if (key === byKey) e.by.set(r.p, (e.by.get(r.p) || 0) + n);
      out.set(k, e);
    }
    return out;
  }
  function rankingView(r) {
    const kind = RANKINGS[r.arg] ? r.arg : 'killers', cfg = RANKINGS[kind];
    const c = compute(S.a, S.b);
    const best = (m) => [...m].sort((x, y) => y[1] - x[1])[0];
    const td = (v) => el('td', { class: 'r', text: v ? nf(v) : '–' });
    const named = (x, kindOf) => { const href = gatherHref(kindOf, x.raw); return el('td', null, href ? el('a', { class: 'plain', href, text: x.name }) : x.name); };
    let cols, rows, rowFn;
    if (kind === 'killers') {
      rows = c.rows.filter((x) => x.kills || x.dealt).map((x) => {
        const fav = best(x.gathered?.wdealt || new Map());
        return { p: x.p, kills: x.kills || 0, kinds: labelCount(x.gathered?.kills || new Map()), dealt: Math.round(x.dealt || 0),
          fav: fav ? gatherLabel(fav[0]) : '–', _search: x.p.toLowerCase() };
      });
      cols = [{ label: 'Player', key: 'p' }, { label: 'Kills', key: 'kills', r: true }, { label: 'Kinds', key: 'kinds', r: true },
        { label: 'Damage dealt', key: 'dealt', r: true }, { label: 'Favourite weapon', key: 'fav' }];
      rowFn = (x) => el('tr', null, el('td', null, playerLink(x.p)), td(x.kills), td(x.kinds), td(x.dealt), el('td', { text: x.fav }));
    } else if (kind === 'creatures') {
      rows = [...byLabel(c.rows, ['kills', 'dealt'], 'kills')].filter(([, e]) => e.v.kills).map(([name, e]) => {
        const b = best(e.by);
        return { name, raw: e.raw, kills: e.v.kills, dealt: Math.round(e.v.dealt || 0), players: e.by.size, top: b ? b[0] : '–', _search: name.toLowerCase() };
      });
      cols = [{ label: 'Creature', key: 'name' }, { label: 'Kills', key: 'kills', r: true }, { label: 'Damage dealt', key: 'dealt', r: true },
        { label: 'Players', key: 'players', r: true }, { label: 'Most kills', key: 'top' }];
      rowFn = (x) => el('tr', null, named(x, 'creature'), td(x.kills), td(x.dealt), td(x.players), el('td', null, x.top !== '–' ? playerLink(x.top) : '–'));
    } else if (kind === 'gatherers') {
      rows = c.rows.filter((x) => x.picked || x.felled || x.mined).map((x) => {
        const fav = best(x.gathered?.picked || new Map());
        return { p: x.p, picked: x.picked || 0, kinds: labelCount(x.gathered?.picked || new Map()), felled: x.felled || 0, mined: x.mined || 0,
          fav: fav ? gatherLabel(fav[0]) : '–', _search: x.p.toLowerCase() };
      });
      cols = [{ label: 'Player', key: 'p' }, { label: 'Picked up', key: 'picked', r: true }, { label: 'Kinds', key: 'kinds', r: true },
        { label: 'Trees felled', key: 'felled', r: true }, { label: 'Rocks & ore mined', key: 'mined', r: true }, { label: 'Collected most', key: 'fav' }];
      rowFn = (x) => el('tr', null, el('td', null, playerLink(x.p)), td(x.picked), td(x.kinds), td(x.felled), td(x.mined), el('td', { text: x.fav }));
    } else if (kind === 'collected') {
      rows = [...byLabel(c.rows, ['picked'], 'picked')].map(([name, e]) => {
        const b = best(e.by);
        return { name, raw: e.raw, picked: e.v.picked, players: e.by.size, top: b ? b[0] : '–', _search: name.toLowerCase() };
      });
      cols = [{ label: 'Item', key: 'name' }, { label: 'Picked up', key: 'picked', r: true }, { label: 'Players', key: 'players', r: true },
        { label: 'Collected most', key: 'top' }];
      rowFn = (x) => el('tr', null, named(x, 'item'), td(x.picked), td(x.players), el('td', null, x.top !== '–' ? playerLink(x.top) : '–'));
    } else {
      rows = [...byLabel(c.rows, ['wdealt', 'wkills'], 'wdealt')].filter(([, e]) => e.v.wdealt).map(([name, e]) => {
        const b = best(e.by);
        return { name, raw: e.raw, dealt: Math.round(e.v.wdealt || 0), kills: e.v.wkills || 0, players: e.by.size, top: b ? b[0] : '–', _search: name.toLowerCase() };
      });
      cols = [{ label: 'Weapon', key: 'name' }, { label: 'Damage dealt', key: 'dealt', r: true }, { label: 'Kills', key: 'kills', r: true },
        { label: 'Players', key: 'players', r: true }, { label: 'Used most by', key: 'top' }];
      rowFn = (x) => el('tr', null, named(x, 'item'), td(x.dealt), td(x.kills), td(x.players), el('td', null, x.top !== '–' ? playerLink(x.top) : '–'));
    }
    const { table, search } = sortableTable(cols, rows, { key: { weapons: 'dealt', gatherers: 'picked', collected: 'picked' }[kind] || 'kills', asc: false, q: '', limit: 200 }, rowFn, 'Nothing in this range.');
    const others = Object.entries(RANKINGS).filter(([k]) => k !== kind).map(([k, v]) => el('a', { class: 'chip', href: `#/ranking/${k}`, text: v.title }));
    return [
      ...subHead(cfg.title, plural(rows.length, cfg.unit)),
      el('div', { class: 'grid', style: { marginTop: '14px' } },
        card(cfg.title, `${cfg.hint} · click a column to sort`, table, 'span-12', search),
        card('More lists', null, el('div', { class: 'chips' }, others), 'span-12')),
    ];
  }

  // Server-wide plugin stats for the range: totals, top killers / gatherers, breakdowns.
  function combatOverview(c) {
    if (!S.data.gather?.length) return [];
    const sum = (key) => c.rows.reduce((n, r) => n + (r[key] || 0), 0);
    const players = (key, empty) => {
      const top = c.rows.filter((r) => r[key]).sort((x, y) => y[key] - x[key]).slice(0, 10);
      return top.length ? hbars(top.map((r) => ({ k: r.p, v: r[key] })), (v) => nf(v), colorOf, true)
        : el('div', { class: 'empty-state', text: empty });
    };
    const neutral = () => 'var(--ink-2)'; // not a player, so no player colour; --accent is chrome only
    return [
      el('h2', { class: 'section-title span-12', text: 'Combat & gathering in range' }),
      card('Server totals', 'Logged by the server plugin since it started — see the leaderboard columns for who did what', el('div', { class: 'kpis' },
        kpi('Kills', nf(sum('kills')), plural(labelCount(mergeGather(c.rows, ['kills'])), 'kind') + ' of creature'),
        kpi('Damage dealt', nf(sum('dealt')), 'health removed from creatures'),
        kpi('Damage taken', nf(sum('taken')), plural(sum('hitsTaken'), 'hit')),
        kpi('Collected', nf(sum('picked')), 'items picked up'),
        kpi('Trees felled', nf(sum('felled'))),
        kpi('Rocks & ore mined', nf(sum('mined')))), 'span-12'),
      card('Top killers', 'Top 10 · kills in range', players('kills', 'No kills in range.'), 'span-4', allLink('killers', c.rows.filter((r) => r.kills || r.dealt).length)),
      card('Kills by creature', 'Top 10 · by kind and stars', gatherBars(mergeGather(c.rows, ['kills']), neutral, 'No kills in range.', 10, 'creature'), 'span-4',
        allLink('creatures', labelCount(mergeGather(c.rows, ['kills'])))),
      card('Damage by weapon', 'Top 10 · health removed', gatherBars(mergeGather(c.rows, ['wdealt']), neutral, 'No damage dealt in range.', 10, 'item'), 'span-4',
        allLink('weapons', labelCount(mergeGather(c.rows, ['wdealt'])))),
      card('Top gatherers', 'Top 10 · items picked up in range', players('picked', 'Nothing picked up in range.'), 'span-6',
        allLink('gatherers', c.rows.filter((r) => r.picked || r.felled || r.mined).length)),
      card('Collected', 'Top 10 · by material', gatherBars(mergeGather(c.rows, ['picked']), neutral, 'Nothing picked up in range.', 10, 'item'), 'span-6',
        allLink('collected', labelCount(mergeGather(c.rows, ['picked'])))),
    ];
  }

  // Leaderboard column names (the impact score's stats on the scoring page too).
  const COL_LABEL = { play: 'Playtime', sessions: 'Sessions', avg: 'Ø session', longest: 'Longest', nDays: 'Days', deaths: 'Deaths', dph: 'Deaths/h', drain: 'Drain', built: 'Built', found: 'Zones', picked: 'Collected', felled: 'Felled', mined: 'Mined', kills: 'Kills', dealt: 'Dmg dealt', taken: 'Dmg taken', hitsTaken: 'Hits taken', dist: 'Travelled', hpmax: 'Max health' };
  function leaderboard(c) {
    const allDeaths = new Map();
    for (const d of c.deaths) allDeaths.set(d.p, (allDeaths.get(d.p) || 0) + 1);
    const rows = c.rows.map((r) => {
      const at = playerAllTime(r.p);
      return { ...r, avg: r.sessions ? r.play / r.sessions : 0, dph: r.play ? r.deaths / (r.play / HOUR) : 0,
        first: at?.first, last: at?.last, online: at?.online, nDays: r.days.size,
        built: S.data.world?.pieces?.[r.p]?.total || 0,
        found: c.zones.filter((z) => z.by.includes(r.p)).length,
        drain: drain(c.deaths.filter((d) => d.p === r.p && d.hard).length) };
    });
    const world = !!S.data.world;
    const gather = !!S.data.gather?.length;
    const cols = [
      ['#', null], ['Player', 'p'], ['Impact', 'impact'], [COL_LABEL.play, 'play'], [COL_LABEL.sessions, 'sessions'], [COL_LABEL.avg, 'avg'], [COL_LABEL.longest, 'longest'],
      [COL_LABEL.nDays, 'nDays'], [COL_LABEL.deaths, 'deaths'], [COL_LABEL.dph, 'dph'], [COL_LABEL.drain, 'drain', 'Skill drain from penalised deaths in range'],
      ...(world ? [[COL_LABEL.built, 'built', 'Pieces of theirs standing in the world now']] : []),
      [COL_LABEL.found, 'found', 'New zones (64 m tiles) generated in range while they were online — everyone online at the time gets the credit'],
      ...(gather ? [[COL_LABEL.picked, 'picked', 'Items picked up (materials, food, drops) — counted since the server plugin started logging'],
        [COL_LABEL.felled, 'felled', 'Standing trees felled — the nearest player within 15 m gets the credit'],
        [COL_LABEL.mined, 'mined', 'Rocks and ore deposits mined out — the nearest player within 15 m gets the credit'],
        [COL_LABEL.kills, 'kills', 'Creatures killed — every player who hit it gets the kill, like the game\'s own kill stats'],
        [COL_LABEL.dealt, 'dealt', 'Damage done to creatures — split evenly when several players fight the same one'],
        [COL_LABEL.taken, 'taken', 'Health lost, from any source (creatures, falls, poison, drowning)'],
        [COL_LABEL.hitsTaken, 'hitsTaken', 'Times their health dropped — hits within a fraction of a second merge, every poison/fire tick counts'],
        [COL_LABEL.dist, 'dist', 'Way travelled on foot, swimming, sailing and riding (server plugin 1.14.0+)'],
        [COL_LABEL.hpmax, 'hpmax', 'Highest max health in range — food, armour and buffs (server plugin 1.14.0+)']] : []),
      ['Last seen', 'last'],
    ];
    const LABEL = Object.fromEntries(cols.filter((x) => x[1]).map(([l, k]) => [k, l]));
    const ord = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
    // Which way is "better" per column. Lower-is-better columns only rank
    // players with ≥1 h in range — a 10-minute visit would otherwise win.
    const DIR = { impact: 1, play: 1, sessions: 1, avg: 1, longest: 1, nDays: 1, deaths: -1, dph: -1, drain: -1, built: 1, found: 1, picked: 1, felled: 1, mined: 1, kills: 1, dealt: 1, taken: -1, hitsTaken: -1, dist: 1, hpmax: 1 };
    // Plugin-fed fewer-is-better columns: 0 only means something if the
    // plugin saw the player at all in this range.
    const eligible = (r, k) => (DIR[k] < 0 ? r.play >= HOUR && (!['taken', 'hitsTaken'].includes(k) || !!r.gathered) : (r[k] || 0) > 0);
    // Impact: what a player contributed, 0–100. The more-is-better columns add
    // up to 100 — each log-scaled against the best player, so one 300 h
    // regular doesn't flatten everyone else — and dying subtracts up to 20,
    // linear against the worst player with ≥1 h (zero deaths → no penalty;
    // under 1 h is too little to judge → no penalty). Rates outweigh raw
    // deaths, which mostly punish playing a lot. A stat that says nothing in
    // this range (everyone equal, or no world data for Built) drops out; the
    // remaining bonus weights are rescaled to 100. Floors at 0.
    // the weights are the rules (scoring "impact"); a column this server doesn't have (no plugin data) or weighs 0 is out
    const used = (m) => Object.fromEntries(Object.entries(m).filter(([k, v]) => v > 0 && LABEL[k]));
    const IMPACT_W = used(SC().impact.bonus), IMPACT_PENALTY = used(SC().impact.penalty);
    const pool = (k) => rows.filter((r) => (DIR[k] < 0 ? eligible(r, k) : r.play > 0));
    const informative = (k) => (k !== 'built' || world) && new Set(pool(k).map((r) => r[k] || 0)).size > 1;
    const bonusKeys = Object.keys(IMPACT_W).filter(informative);
    const penaltyKeys = Object.keys(IMPACT_PENALTY).filter(informative);
    const bonusTotal = bonusKeys.reduce((s, k) => s + IMPACT_W[k], 0);
    const weight = (k) => (IMPACT_W[k] ? (IMPACT_W[k] / bonusTotal) * 100 : -IMPACT_PENALTY[k]);
    const statScore = {};
    for (const k of [...bonusKeys, ...penaltyKeys]) {
      const top = Math.max(...pool(k).map((r) => r[k] || 0));
      const m = new Map();
      // Bonus: relative to the best, unit-free (raw ms would flatten
      // everything) — half the best → 0.74, a tenth → 0.28.
      // Penalty: share of the worst ranked player's value.
      for (const r of pool(k)) m.set(r.p, DIR[k] > 0 ? Math.log1p((9 * (r[k] || 0)) / top) / Math.log(10) : (r[k] || 0) / top);
      statScore[k] = m;
    }
    for (const r of rows) {
      const parts = [...bonusKeys, ...penaltyKeys].map((k) => [k, weight(k) * (statScore[k].get(r.p) || 0)]);
      r.impact = Math.max(0, parts.reduce((s, [, v]) => s + v, 0));
      r.impactParts = parts.filter(([, v]) => Math.abs(v) >= 0.5).sort((a, b) => b[1] - a[1]);
    }
    const sign = (v) => (v < 0 ? `−${nf(-v, 1)}` : nf(v, 1));
    cols[2].push(`What a player contributed, 0–100${bonusKeys.length ? ': ' : ''}${bonusKeys
      .map((k) => `${LABEL[k]} ${Math.round(weight(k))}`).join(', ')}${penaltyKeys.length ? `; dying costs up to ${penaltyKeys
      .map((k) => `${LABEL[k]} −${IMPACT_PENALTY[k]}`).join(', ')}` : ''}. Bonuses are log-scaled to the best player; penalties scale linearly to the worst player with ≥1 h (under 1 h: no penalty). Stats nobody differs in drop out.`);
    const RULE = (k) => (DIR[k] < 0 ? `fewest ${LABEL[k].toLowerCase()} ranks first (players with ≥1 h in range)` : `most ${LABEL[k].toLowerCase()} ranks first`);
    const places = {};
    for (const k of Object.keys(DIR)) {
      if (!LABEL[k]) continue;
      const list = rows.filter((r) => eligible(r, k)).sort((x, y) => DIR[k] * ((y[k] || 0) - (x[k] || 0)));
      const m = new Map();
      list.forEach((r, i) => m.set(r.p, i && (list[i - 1][k] || 0) === (r[k] || 0) ? m.get(list[i - 1].p) : i + 1));
      places[k] = m;
    }
    const FMT = {
      impact: (r) => (r.impact ? nf(r.impact, 1) : '–'), play: (r) => fH(r.play), sessions: (r) => nf(r.sessions), avg: (r) => (r.sessions ? fDur(r.avg) : '–'),
      longest: (r) => (r.longest ? fDur(r.longest) : '–'), nDays: (r) => nf(r.nDays), deaths: (r) => nf(r.deaths),
      dph: (r) => (r.play ? nf(r.dph, 1) : '–'), drain: (r) => (r.drain ? pct(r.drain) : '–'), built: (r) => (r.built ? nf(r.built) : '–'), found: (r) => (r.found ? nf(r.found) : '–'),
      picked: (r) => (r.picked ? nf(r.picked) : '–'), felled: (r) => (r.felled ? nf(r.felled) : '–'), mined: (r) => (r.mined ? nf(r.mined) : '–'),
      kills: (r) => (r.kills ? nf(r.kills) : '–'), dealt: (r) => (r.dealt ? nf(r.dealt) : '–'),
      taken: (r) => (r.taken ? nf(r.taken) : '–'), hitsTaken: (r) => (r.hitsTaken ? nf(r.hitsTaken) : '–'),
      dist: (r) => (r.dist ? `${nf(r.dist / 1000, 1)} km` : '–'), hpmax: (r) => (r.hpmax ? nf(r.hpmax) : '–'),
    };
    const mini = (k, r) => {
      const n = places[k]?.get(r.p);
      return n && n <= 3 ? el('span', { class: `mini m${n}`, title: `${ord(n)} in ${LABEL[k].toLowerCase()}`, 'aria-label': `${ord(n)} in ${LABEL[k].toLowerCase()}`, text: n }) : null;
    };
    // Top materials / trees / rocks / creatures behind a gather or kill count.
    const gatherTip = (r, key) => {
      const m = r.gathered?.[key];
      if (!m || key === 'taken' || key === 'hitsTaken') return null;
      const top = [...m].sort((x, y) => y[1] - x[1]);
      return top.slice(0, 8).map(([i, n]) => `${gatherLabel(i)} ${nf(n)}`).join(' · ') + (top.length > 8 ? ` · +${top.length - 8} more` : '');
    };
    const tbody = el('tbody');
    const thead = el('tr');
    const draw = () => {
      const q = S.lb.q.trim().toLowerCase();
      const k = S.lb.key, dir = S.lb.asc ? 1 : -1;
      // unranked rows (e.g. <1 h for fewest-deaths) always sink to the bottom
      const unranked = (r) => (DIR[k] && !places[k]?.has(r.p) ? 1 : 0);
      const sorted = rows.slice().sort((x, y) => unranked(x) - unranked(y)
        || (typeof x[k] === 'string' ? x[k].localeCompare(y[k]) : (x[k] || 0) - (y[k] || 0)) * dir || y.play - x.play);
      // # follows the sorted column; name / last-seen say nothing about who leads → impact.
      const rk = DIR[k] ? k : 'impact';
      const place = (r) => {
        const n = places[rk].get(r.p);
        if (!n) return el('span', { class: 'medal', title: DIR[rk] < 0 ? 'Less than 1 h in range — not ranked' : 'Not ranked', text: '–' });
        return n <= 3
          ? el('span', { class: `medal m${n}`, title: `${ord(n)} in ${LABEL[rk].toLowerCase()}`, 'aria-label': `${ord(n)} in ${LABEL[rk].toLowerCase()}`, text: n })
          : el('span', { class: 'medal', text: n });
      };
      const shown = sorted.filter((r) => !q || r.p.toLowerCase().includes(q));
      // medal slot + value; values are padded to the column's widest after layout, so medals line up
      const mv = (key, r) => el('span', { class: 'mv' }, el('span', { class: 'mslot' }, mini(key, r)),
        el('span', { class: 'v', 'data-k': key, text: FMT[key](r) }));
      tbody.replaceChildren(...shown.map((r) => el('tr', {
        class: 'click', tabindex: '0', onclick: () => go(r.p), onkeydown: (e) => { if (e.key === 'Enter') go(r.p); } },
        el('td', { class: 'num' }, place(r)),
        el('td', null, el('span', { class: 'who' }, el('i', { class: 'sw', style: { background: colorOf(r.p) } }), r.p)),
        el('td', { class: 'r', title: r.impactParts.length ? `Impact ${nf(r.impact, 1)}: ${r.impactParts.map(([key, v]) => `${LABEL[key]} ${sign(v)}`).join(' · ')}` : null }, mv('impact', r)),
        el('td', null, el('span', { class: 'share' }, el('span', { style: { width: `${c.total ? (r.play / c.total) * 100 : 0}%`, background: colorOf(r.p) } })), mv('play', r)),
        // the plain stat columns, in header order (a list of its own here once dropped Travelled / Max health)
        ...cols.map(([, key]) => key).filter((key) => FMT[key] && key !== 'impact' && key !== 'play')
          .map((key) => el('td', { class: 'r', title: gatherTip(r, key) }, mv(key, r))),
        el('td', null, r.online ? el('span', { class: 'badge on', text: 'online' }) : el('span', { class: 'badge', text: r.last ? fAgo(S.data.generated - r.last) : '–' })))));
      if (!tbody.children.length) tbody.append(el('tr', null, el('td', { colspan: cols.length, class: 'empty-state', text: 'No matching player.' })));
      requestAnimationFrame(() => {
        for (const key of Object.keys(FMT)) {
          const vs = [...tbody.querySelectorAll(`.v[data-k="${key}"]`)];
          vs.forEach((v) => { v.style.minWidth = ''; });
          const w = Math.max(0, ...vs.map((v) => v.getBoundingClientRect().width));
          vs.forEach((v) => { v.style.minWidth = `${Math.ceil(w)}px`; });
        }
      });
      thead.replaceChildren(...cols.map(([label, key, tip], i) => el('th', {
        class: [key && FMT[key] && key !== 'play' ? 'r' : '', key && key === S.lb.key ? `sorted${S.lb.asc ? ' asc' : ''}` : ''].join(' ').trim() || null,
        title: key ? [tip, DIR[key] ? RULE(key) : null].filter(Boolean).join(' · ') || null : `Place by ${LABEL[rk].toLowerCase()} — ${RULE(rk)}`,
        'data-sort': key || null, 'aria-sort': key === S.lb.key ? (S.lb.asc ? 'ascending' : 'descending') : null, text: label,
        onclick: key ? () => { if (S.lb.key === key) S.lb.asc = !S.lb.asc; else { S.lb.key = key; S.lb.asc = key === 'p' || DIR[key] < 0; } draw(); } : null })));
    };
    draw();
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Search players', 'aria-label': 'Search players', value: S.lb.q,
      oninput: (e) => { S.lb.q = e.target.value; draw(); } });
    return withId(card('Leaderboard', null, el('div', { class: 'table-wrap' }, el('table', null, el('thead', null, thead), tbody)), 'span-12', search, scoringLink('impact')), 'leaderboard');
  }

  function events(c) {
    const out = [];
    const only = c.only;
    for (const s of S.data.sessions) {
      if (only && s.p !== only) continue;
      if (s.s >= c.a && s.s < c.b) out.push({ t: s.s, type: 'login', p: s.p, txt: 'joined' });
      if (s.e != null && s.e >= c.a && s.e < c.b) {
        out.push({ t: s.e, type: 'logout', p: s.p, txt: `left after ${fDur(s.e - s.s)}${s.end === 'restart' ? ' (server restart)' : ''}` });
      }
    }
    for (const d of c.deaths) {
      out.push({ t: d.t, type: 'death', p: d.p, txt: 'died',
        sub: d.hard ? `skills −${pct(S.skillLoss)}` : `no skill loss · died again after ${fDur(d.since)}` });
    }
    for (const r of c.raids) out.push({ t: r.t, type: 'raid', txt: `Raid: ${raidName(r.n)}`, sub: r.players.join(', ') });
    for (const ev of progressEvents(c.a, c.b, only)) {
      out.push({ t: ev.t, type: 'progress', txt: ev.txt, sub: [ev.when, ev.players.join(', ')].filter(Boolean).join(' · ') || null });
    }
    if (!only) {
      for (const t of S.data.restarts) if (t >= c.a && t < c.b) out.push({ t, type: 'restart', txt: 'Server (re)started' });
      let prev = null;
      for (const d of S.data.days) {
        if (prev != null && d.d > prev && d.t >= c.a && d.t < c.b) out.push({ t: d.t, type: 'day', txt: `Slept through to day ${d.d}` });
        prev = d.d;
      }
    }
    return out.sort((x, y) => y.t - x.t);
  }
  const RAID_TEXT = 'Raids are random attacks on a base while players are nearby; the game announces each with the message shown. Deaths count everyone who died within 5 minutes of the start — the log has no raid end.';
  const RAID_EXPLAIN = () => el('p', { class: 'explain', text: RAID_TEXT });

  // ---- raids: one marker per raid on a thin time strip, coloured by type
  function raidStrip(host, raids, a, b) {
    const W = width(host), H = 62, left = 8, right = 8, base = 36;
    const x = (t) => left + ((t - a) / (b - a)) * (W - left - right);
    const svg = sv('svg', { width: W, height: H, role: 'img', 'aria-label': 'Raids over time' });
    svg.append(sv('line', { class: 'bl', x1: left, x2: W - right, y1: base + 8, y2: base + 8 }));
    for (const tk of timeTicks(a, b, W)) {
      svg.append(sv('line', { class: 'gl', x1: x(tk.t), x2: x(tk.t), y1: base + 8, y2: base + 12 }));
      svg.append(sv('text', { class: 'ax', x: x(tk.t), y: H - 2, 'text-anchor': 'middle', text: tk.label }));
    }
    const lastX = [-Infinity, -Infinity, -Infinity];
    for (const r of [...raids].sort((p, q) => p.t - q.t)) {
      const cx = x(r.t);
      const row = Math.max(0, lastX.findIndex((lx) => cx - lx >= 14));  // dodge overlapping markers upwards
      lastX[row] = cx;
      const cy = base - row * 13;
      const g = sv('g', null,
        sv('circle', { cx, cy, r: 12, fill: 'transparent' }),
        sv('circle', { cx, cy, r: 6, 'stroke-width': 2, style: { fill: raidColor(r.n), stroke: 'var(--surface)' } }));
      const d = deathsAfter(r);
      hoverable(g, () => [el('div', { class: 't', text: fDateTime(r.t) }), tRow(raidColor(r.n), raidName(r.n)),
        el('div', { class: 'note', text: r.players.length ? `Online: ${r.players.join(', ')}` : 'Nobody online' }),
        d ? el('div', { class: 'note', text: `☠ ${plural(d, 'death')} within 5 min` }) : null]);
      svg.append(g);
    }
    host.replaceChildren(svg);
  }
  const raidLegend = (raids) => el('div', { class: 'legend' }, raidTypes(raids).map((t) =>
    el('span', { class: 'key', title: t.title }, el('i', { class: 'sw', style: { background: S.raidColor.get(t.k) || 'var(--other)' } }), `${t.k} · ${t.v}×`)));
  function raidItem(r) {
    const d = deathsAfter(r);
    return el('li', null, el('i', { class: 'sw', style: { background: raidColor(r.n) } }),
      el('div', null, el('div', { class: 'raid-name', text: raidName(r.n), title: r.n }),
        el('div', { class: 'hint' }, `${fAgo(S.data.generated - r.t)} · `,
          r.players.length ? r.players.map((p, i) => [i ? ', ' : '', el('a', { class: 'plain', href: `#/p/${encodeURIComponent(p)}`, text: p })]) : 'nobody online',
          d ? ` · ☠ ${d}` : '')));
  }
  function raidsCard(c) {
    const rs = c.raids;
    const link = el('a', { class: 'more-link', href: '#/raids', text: 'All raids →' });
    if (!rs.length) return card('Raids', null, el('div', { class: 'empty-state', text: 'Quiet times — no raids in this range.' }), 'span-12', link);
    const avg = rs.reduce((n, r) => n + r.players.length, 0) / rs.length;
    const deaths = rs.reduce((n, r) => n + deathsAfter(r), 0);
    const strip = chartHost();
    later(() => raidStrip(strip, rs, c.a, c.b));
    return card('Raids', `${plural(rs.length, 'raid')} in range · Ø ${nf(avg, 1)} players online · ☠ ${plural(deaths, 'death')} within 5 min`,
      el('div', { class: 'raids-compact' },
        el('div', null, el('h3', { text: 'Latest' }), el('ul', { class: 'raid-list' }, rs.slice(-3).reverse().map(raidItem))),
        el('div', null, el('h3', { text: 'When they hit' }), strip, raidLegend(rs))), 'span-12', link);
  }
  const ICON = { login: '→', logout: '←', death: '☠', raid: '⚔', progress: '★', restart: '⟳', day: '☾' };
  const TYPE_LABEL = { login: 'Joins', logout: 'Leaves', death: 'Deaths', raid: 'Raids', progress: 'Progress', restart: 'Restarts', day: 'Sleep' };

  function feed(c, opts = {}) {
    const fixed = opts.fixed ? new Set(opts.fixed) : null;
    const has = (t) => (fixed ? fixed.has(t) : S.feed.types.has(t));
    const all = events(c).filter((e) => !fixed || fixed.has(e.type));
    const list = el('ul', { class: 'feed' });
    const more = el('div', { class: 'more' });
    const draw = () => {
      const q = S.feed.q.trim().toLowerCase();
      const hits = all.filter((e) => has(e.type) && (!q || `${e.p || ''} ${e.txt} ${e.sub || ''}`.toLowerCase().includes(q)));
      list.replaceChildren(...hits.slice(0, S.feed.limit).map((e) => el('li', null,
        el('span', { class: 'ico', 'aria-hidden': 'true', text: ICON[e.type] }),
        el('span', { class: 'what' },
          e.p ? el('a', { href: `#/p/${encodeURIComponent(e.p)}`, text: e.p }) : null, e.p ? ' ' : null, e.txt,
          e.sub ? el('span', { class: 'hint', text: ` · ${e.sub}` }) : null),
        el('time', { datetime: new Date(e.t * 1000).toISOString(), text: fDateTime(e.t) }))));
      if (!hits.length) list.append(el('li', { class: 'empty-state', text: 'Nothing matches.' }));
      more.replaceChildren(...(hits.length > S.feed.limit
        ? [el('button', { type: 'button', text: `Show more (${nf(hits.length - S.feed.limit)} hidden)`, onclick: () => { S.feed.limit += 200; draw(); } })] : []));
    };
    const types = c.only ? ['login', 'logout', 'death', 'raid', 'progress'] : Object.keys(ICON);
    const chips = fixed ? null : el('div', { class: 'chips', role: 'group', 'aria-label': 'Event types' }, types.map((t) =>
      el('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.feed.types.has(t)), text: `${ICON[t]} ${TYPE_LABEL[t]}`,
        onclick: (e) => { S.feed.types.has(t) ? S.feed.types.delete(t) : S.feed.types.add(t); e.target.setAttribute('aria-pressed', String(S.feed.types.has(t))); draw(); } })));
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Search events', 'aria-label': 'Search events', value: S.feed.q,
      oninput: (e) => { S.feed.q = e.target.value; S.feed.limit = 120; draw(); } });
    draw();
    return card(opts.title || 'Event log', null, el('div', null, chips, chips ? el('div', { style: { height: '10px' } }) : null, list, more), 'span-12', search);
  }

  // One page per player, split into tabs (#/p/<name>[/activity|combat|gear|saga]); only the open tab is built.
  // body & movement of one player in range (plugin Vitals.cs): peaks, feats, sums; max health over all time as a chart
  function bodyCards(p, r) {
    const pk = r.peak || {}, fs = r.feats || [], dist = r.gathered?.dist || new Map();
    if (!Object.keys(pk).length && !fs.length && !r.dist && !r.crouch && !r.exhn && !r.emotes && !r.beds) return [];
    const of = (kind) => fs.filter((f) => f[2] === kind);
    const most = (xs) => xs.reduce((m, f) => (!m || f[3] > m[3] ? f : m), null);
    const sp = most(of('sprint')), fa = most(of('fall')), ccs = of('closecall'), cc = ccs.reduce((m, f) => (!m || f[3] < m[3] ? f : m), null);
    const km = (m) => (m >= 1000 ? `${nf(m / 1000, 1)} km` : `${nf(m)} m`);
    const emotes = [...(r.gathered?.emotes || [])].sort((x, y) => y[1] - x[1]).slice(0, 3);
    const body = el('dl', { class: 'facts-dl' },
      fl('💪 Max health', pk.hp ? nf(pk.hp) : '–', pk.st ? `stamina ${nf(pk.st)}${pk.eitr ? ` · eitr ${nf(pk.eitr)}` : ''}` : null),
      fl('🫀 Closest call', cc ? `${nf(cc[3], 1)} health left` : '–', ccs.length ? `${plural(ccs.length, 'close call')}${cc[4] ? ` · of ${nf(cc[4])}` : ''}` : 'no close calls'),
      fl('🏃 Longest sprint', sp ? `${nf(sp[3])} m` : '–', sp ? `${fDur(sp[4])} without stopping · ${fDateTime(sp[0])}` : null),
      fl('🪂 Biggest fall survived', fa ? `${nf(fa[3])} m` : '–', fa ? fDateTime(fa[0]) : null),
      fl('💥 Biggest hit survived', pk.hit ? `${nf(pk.hit)} damage` : '–'),
      fl('🏔️ Highest point', pk.y != null ? `${nf(pk.y)} m above the sea` : '–'),
      fl('😮‍💨 Running on empty', r.exhn ? plural(r.exhn, 'time') : '–', r.exh ? `${fDur(r.exh)} without stamina` : null),
      fl('🛌 Nights in bed', r.beds ? nf(r.beds) : '–'),
      fl('🥷 Sneaking', r.crouch ? fDur(r.crouch) : '–'),
      fl('💃 Emotes', r.emotes ? nf(r.emotes) : '–', emotes.length ? emotes.map(([e, n]) => `${e} ${nf(n)}`).join(' · ') : null));
    const ways = el('dl', { class: 'facts-dl' }, [['foot', '🚶 On foot'], ['swim', '🏊 Swimming'], ['boat', '⛵ Sailing'], ['ride', '🐗 Riding']]
      .map(([k, label]) => fl(label, dist.get(k) ? km(dist.get(k)) : '–', pk[`v_${k}`] ? `top ${nf(pk[`v_${k}`] * 3.6, 1)} km/h` : null)),
    fl('🧭 Altogether', r.dist ? km(r.dist) : '–'));
    const pts = (S.data.peaks || []).filter((x) => x[1] === p && x[2] === 'hp').map((x) => [x[0], x[3]]);
    const hpHost = chartHost();
    if (pts.length > 1) later(() => stepChart(hpHost, { a: Math.min(S.a, pts[0][0]), b: S.b, pts, fmtY: (v) => `${nf(v)} health`, label: 'max health', aria: 'Max health over time' }));
    return [card('Body & movement', 'In range · from the server plugin (1.14.0+)', body, 'span-6'),
      card('Travelled', 'Way and top speed in range', ways, 'span-6'),
      pts.length > 1 ? card('Max health over time', 'Highest per hour, all time — food, armour and buffs', hpHost, 'span-12') : null].filter(Boolean);
  }

  function playerView(p, tab = 'overview') {
    const at = playerAllTime(p);
    if (!at) return [crumbs(), el('div', { class: 'empty-state', text: `No player named “${p}”.` })];
    const c = compute(S.a, S.b, p);
    const r = c.rows.find((x) => x.p === p) || { play: 0, sessions: 0, longest: 0, deaths: 0, days: new Set() };

    // Overlap with everyone else, within range.
    const together = new Map();
    const mine = c.ses;
    for (const o of compute(S.a, S.b).ses) {
      if (o.p === p) continue;
      for (const m of mine) {
        const ov = Math.min(m.e, o.e) - Math.max(m.s, o.s);
        if (ov > 0) together.set(o.p, (together.get(o.p) || 0) + ov);
      }
    }
    const zonesMine = S.data.zones.filter((z) => z.by.includes(p));
    const rank = compute(S.a, S.b).rows.sort((x, y) => y.play - x.play).findIndex((x) => x.p === p) + 1;

    // Plugin stats (Collected … Damage taken): shown once the server logs them at all.
    const gatherOn = !!S.data.gather?.length;
    const gTop = (key) => [...(r.gathered?.[key] || [])].sort((x, y) => y[1] - x[1]);
    const mostly = (key) => (gTop(key)[0] ? `mostly ${gatherLabel(gTop(key)[0][0])}` : null);
    const gBars = (keys, empty, kind) => gatherBars(mergeGather([r], keys), () => colorOf(p), empty, 12, kind);
    const combatSummary = () => {
      const kills = r.kills || 0, dealt = r.dealt || 0, taken = r.taken || 0;
      // the most health: base HP (creatures.json) × (stars + 1), as the game scales it — a Troll ★1 (1,200)
      // beats a Greydwarf ★2 (120); without game data, the health removed per kill of that kind
      const hpOf = (i) => { const hp = CD()[i.split('*')[0]]?.hp; return hp ? hp * (starsOf(i) + 1) : (r.gathered?.dealt?.get(i) || 0) / (r.gathered?.kills?.get(i) || 1); };
      const strongest = gTop('kills').sort((x, y) => hpOf(y[0]) - hpOf(x[0]))[0];
      const weapon = gTop('wdealt')[0];
      const weaponKills = weapon ? r.gathered?.wkills?.get(weapon[0]) || 0 : 0;
      const hours = r.play / HOUR;
      return el('div', { class: 'kpis' },
        kpi('Kills', nf(kills), r.gathered?.kills ? plural(labelCount(r.gathered.kills), 'kind') + ' of creature' : null),
        kpi('Strongest kill', strongest ? gatherLabel(strongest[0]) : '–', strongest ? `${nf(hpOf(strongest[0]))} health · ${plural(strongest[1], 'time')}` : 'no kills yet',
          strongest ? { title: 'About this creature', href: creatureHref(strongest[0]) } : null),
        kpi('Kills per death', r.deaths ? nf(kills / r.deaths, 1) : kills ? '∞' : '–', `${plural(kills, 'kill')} · ${plural(r.deaths, 'death')}`),
        kpi('Damage dealt', nf(dealt), hours && dealt ? `${nf(dealt / hours)} per hour` : null),
        kpi('Damage per kill', kills ? nf(dealt / kills) : '–', 'health removed, overkill not counted'),
        kpi('Favourite weapon', weapon ? gatherLabel(weapon[0]) : '–', weapon ? `${nf(weapon[1])} damage · ${plural(weaponKills, 'kill')}` : null,
          weapon && hasItemPage(weapon[0]) ? { title: 'About this weapon', href: itemHref(weapon[0]) } : null),
        kpi('Damage taken', nf(taken), r.hitsTaken ? plural(r.hitsTaken, 'hit') : null),
        kpi('Taken per hour', hours && taken ? nf(taken / hours) : '–', 'from any source'),
        // blood magic takes its cost from health: paid, not damage taken (plugin: CombatCore, docs/ATTRIBUTION.md)
        r.paid ? kpi('Health paid', nf(r.paid), mostly('paid') ? `for blood magic · ${mostly('paid')}` : 'for blood magic') : null);
    };

    const byname = bynameOf(p), animal = animalOf(p);
    const head = el('div', { class: 'phead' },
      lookAvatar(p) || el('div', { class: 'avatar', style: { background: colorOf(p) } }, [...p][0].toUpperCase()),
      el('div', null,
        el('h1', null, p, byname ? el('span', { class: 'byname', text: ` ${byname}` }) : null),
        el('div', { class: 'meta' },
          at.online ? el('span', { class: 'badge on', text: 'online now' }) : el('span', { class: 'badge', text: `last seen ${fAgo(S.data.generated - at.last)}` }),
          ` · first seen ${fDateY(at.first)} · ${fH(at.total)} all time`,
          animal ? el('span', { title: animal[2] }, ` · spirit animal: ${animal[0]} ${animal[1]}`) : null)),
      el('button', { type: 'button', class: 'chip me-btn', 'aria-pressed': String(me() === p), title: me() === p ? 'Click to forget' : 'Remembered in this browser only',
        text: me() === p ? '✓ This is you' : 'This is me', onclick: () => setMe(me() === p ? null : p) }));

    const hero = el('div', { class: 'card hero' },
      el('div', { class: 'label', text: 'Playtime in range' }),
      el('div', { class: 'value' }, nf(r.play / HOUR, r.play < 10 * HOUR ? 1 : 0), el('small', { text: 'hours' })),
      el('div', { class: 'sub', text: rank ? `#${rank} on the server · ${fDateY(S.a)} – ${fDateY(S.b)}` : `${fDateY(S.a)} – ${fDateY(S.b)}` }));
    const gearHref = `#/p/${encodeURIComponent(p)}/gear`;
    const K = {
      sessions: () => kpi('Sessions', nf(r.sessions), r.sessions ? `Ø ${fDur(r.play / r.sessions)}` : null),
      longest: () => kpi('Longest session', r.longest ? fDur(r.longest) : '–'),
      days: () => kpi('Active days', nf(r.days.size)),
      fav: () => kpi('Favourite time', peakOf(c.heat)),
      horoscope: () => { const h = horoscope(p);
        return kpi('Horoscope', h ? `${DOW[h.dow]} ${hh(h.hour)}` : '–', h ? `Thor expects them ${pct(h.pr)} of the time` : 'needs a longer range'); },
      deaths: () => kpi('Deaths', nf(r.deaths), r.play ? `${nf(r.deaths / (r.play / HOUR), 1)} per hour` : null),
      drain: () => { const ls = lossStats(c.deaths)[0];
        return kpi('Skill drain', ls?.hard ? pct(ls.drain) : '0 %', ls ? `${plural(ls.hard, 'costly death')} · ${nf(ls.soft)} free` : 'no deaths in range',
          { title: 'Skill loss explained', href: '#/deaths' }); },
      raids: () => kpi('Raids witnessed', nf(c.raids.length)),
      zones: () => kpi('Zones discovered', nf(c.zones.length), `${nf(zonesMine.length)} all time`),
      collected: () => (gatherOn ? kpi('Collected', nf(r.picked || 0), mostly('picked') || 'items picked up') : null),
      felled: () => (gatherOn ? kpi('Felled · mined', `${nf(r.felled || 0)} · ${nf(r.mined || 0)}`, 'trees · rocks & ore') : null),
      kills: () => (gatherOn ? kpi('Kills', nf(r.kills || 0), mostly('kills')) : null),
      dealt: () => (gatherOn ? kpi('Damage dealt', nf(Math.round(r.dealt || 0)), mostly('dealt') || 'health removed from creatures') : null),
      buddy: () => kpi('Best buddy', together.size ? [...together].sort((x, y) => y[1] - x[1])[0][0] : '–',
        together.size ? `${fH([...together].sort((x, y) => y[1] - x[1])[0][1])} together` : null),
      pieces: () => (S.data.world ? kpi('Pieces built', nf(S.data.world.pieces[p]?.total || 0), 'standing in the world now', { title: 'Their builds', href: gearHref }) : null),
      crafted: () => (S.data.world ? kpi('Crafted gear', nf(itemsWhere('crafted', p).reduce((n, x) => n + x.n, 0)), 'items of theirs in chests', { title: 'Their crafted items', href: gearHref }) : null),
    };
    const TAB_TILES = {
      overview: ['sessions', 'days', 'kills', 'dealt', 'deaths', 'collected', 'zones', 'buddy', 'pieces'],  // kills and damage side by side (4 or 2 per row)
      activity: ['sessions', 'longest', 'days', 'fav', 'horoscope', 'raids', 'zones', 'buddy'],
      combat: ['deaths', 'drain', 'kills', 'collected', 'felled'],
      gear: ['pieces', 'crafted'],
      saga: [],
    };
    const tiles = (TAB_TILES[tab] || []).map((k) => K[k]()).filter(Boolean);

    const dl = chartHost(), hm = chartHost(), mp = el('div');
    if (tab === 'activity') later(() => {
      const days = daysIn(S.a, S.b);
      const vals = days.map((d) => (c.daily.get(d.key)?.get(p) || 0) / HOUR);
      columns(dl, { labels: days.map((d) => fDate(d.t)), values: vals, color: colorOf(p), height: 190,
        every: Math.ceil(days.length / Math.max(1, Math.floor(width(dl) / 56))), fmtV: (v) => fH(v * HOUR),
        tipT: (i) => fDateY(days[i].t), aria: `Playtime per day for ${p}` });
    });
    if (tab === 'activity') {
      later(() => heatmap(hm, c));
      later(() => zoneMap(mp, c, `player:${p}`, [p]));
    }

    // sessions table
    const sesAll = S.data.sessions.filter((s) => s.p === p && s.end_t > S.a && s.s < S.b).sort((x, y) => y.s - x.s);
    const deathsIn = (s) => S.data.deaths.filter((d) => d.p === p && d.t >= s.s && d.t <= s.end_t).length;
    const tbody = el('tbody');
    const more = el('div', { class: 'more' });
    const drawSes = () => {
      tbody.replaceChildren(...sesAll.slice(0, S.sess.limit).map((s) => el('tr', null,
        el('td', { text: fDateTime(s.s) }),
        el('td', { text: s.e == null ? 'now' : fTime(s.e) }),
        el('td', { class: 'r', text: fDur(s.end_t - s.s) }),
        el('td', { class: 'r', text: nf(deathsIn(s)) }),
        el('td', null, s.e == null ? el('span', { class: 'badge on', text: 'online' }) : el('span', { class: 'hint', text: { logout: 'left', relog: 'relogged', timeout: 'connection lost', restart: 'server restart' }[s.end] || s.end })))));
      more.replaceChildren(...(sesAll.length > S.sess.limit ? [el('button', { type: 'button', text: `Show all ${nf(sesAll.length)} sessions`, onclick: () => { S.sess.limit = Infinity; drawSes(); } })] : []));
    };
    drawSes();
    const sesTable = el('div', null, el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['Started', 'Ended', 'Duration', 'Deaths', ''].map((h, i) => el('th', { class: i === 2 || i === 3 ? 'r' : null, text: h })))), tbody)), more);

    const base = `#/p/${encodeURIComponent(p)}`;
    const TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['combat', gatherOn ? 'Combat & gathering' : 'Combat'],
      ['gear', 'Gear & base'], ['saga', 'Saga & achievements']];
    const tabBar = el('nav', { class: 'chips ptabs', 'aria-label': `${p}: sections` }, TABS.map(([k, label]) =>
      el('a', { class: 'chip', href: k === 'overview' ? base : `${base}/${k}`, 'aria-current': k === tab ? 'true' : null, text: label,
        title: `${label} (t then ${tabKey(k)} · , and . for the previous / next tab)`, 'aria-keyshortcuts': `t ${tabKey(k)}` })));
    const vp = (...titles) => vikingProfile(p, (x) => titles.includes(x));
    const SECTIONS = {
      overview: () => [...vp('Trading card', 'Report card'), gatherOn ? badgesCard(p) : null, feed(c)],
      activity: () => [
        card('Playtime per day', null, dl, 'span-7'),
        card('When does ' + p + ' play?', `Weekday × hour (${TZ})`, hm, 'span-5'),
        card('Played together with', 'Overlapping time online, in range',
          together.size ? hbars([...together].map(([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v), fH, colorOf, true)
            : el('div', { class: 'empty-state', text: 'Played solo in this range.' }), 'span-4'),
        ...vp('Habits'),
        (() => { const vs = (S.data.visits || []).filter((v) => v[1] === p);
          return vs.length ? card('Dungeons', `${plural(vs.length, 'visit')} to ${plural(new Set(vs.map((v) => `${v[2]}@${v[3]},${v[4]}`)).size, 'dungeon')} · all time`,
            el('div', { class: 'stack' }, [...vs].reverse().slice(0, 20).map((v) => visitLine(v, false))), 'span-12') : null; })(),
        card('Exploration', `Zones generated while ${p} was online — add other players to compare`, mp, 'span-12'),
        card('Sessions', `${plural(sesAll.length, 'session')} in range`, sesTable, 'span-12')],
      combat: () => [
        ...(gatherOn ? [
          card('Combat summary', 'Kills and damage in range — damage is health removed, not the number shown on hit', combatSummary(), 'span-12'),
          ...(() => { const fs = fightsIn().filter((f) => f.players[p]);
            return fs.length ? [card('Boss fights', `${plural(fs.length, 'fight')} in range`, fightsTable(fs, p).table, 'span-12')] : []; })(),
          card('Kills', 'Creatures, by kind and stars', gatherBars(mergeGather([r], ['kills']), () => colorOf(p), 'No kills in range.', Infinity, 'creature'), 'span-6'),
          card('Damage dealt', 'By creature', gBars(['dealt'], 'No damage dealt in range.', 'creature'), 'span-6'),
          card('Damage by weapon', 'Health removed, in range', gBars(['wdealt'], 'No damage dealt in range.', 'item'), 'span-6'),
          card('Kills by weapon', 'In range', gBars(['wkills'], 'No kills in range.', 'item'), 'span-6'),
          summonsCard(r),
          card('Collected', 'Items picked up, by kind', gBars(['picked'], 'Nothing picked up in range.', 'item'), 'span-6'),
          card('Felled & mined', 'Trees, rocks and ore deposits', gBars(['felled', 'mined'], 'Nothing felled or mined in range.'), 'span-6'),
          ...bodyCards(p, r),
        ] : []),
        ...vp('Death certificate')],
      gear: () => [playerEquipment(p), playerEquipHistory(p), ...playerGear(p), ...vp('Wealth & stuff')],
      saga: () => [...vp('Saga', 'Fortune'), playerAchievements(p)],
    };
    const body = (SECTIONS[tab] || SECTIONS.overview)().flat().filter(Boolean);

    return [
      crumbs(),
      head,
      tabBar,
      tab === 'overview' ? el('div', { class: 'tiles' }, hero, el('div', { class: 'kpis' }, tiles))
        : tiles.length ? kpiRow(...tiles) : null,
      el('div', { class: 'grid' }, ...(body.length ? body : [el('div', { class: 'card span-12' }, el('div', { class: 'empty-state', text: 'Nothing here yet.' }))])),
    ];
  }


  // ------------------------------------------------------------------ drill-down views

  function subHead(title, hint, noRange) {
    const range = `${fDateY(S.a)} – ${S.b >= S.max ? 'now' : fDateY(S.b)}`;
    return [
      crumbs(),
      el('div', { class: 'phead' }, el('div', null, el('h1', { text: title }),
        el('div', { class: 'meta', text: [hint, noRange ? null : range].filter(Boolean).join(' · ') }))),
    ];
  }
  const kpiRow = (...k) => el('div', { class: 'kpis', style: { marginTop: '14px' } }, k);
  const playerLink = (p) => el('a', { class: 'who plain', href: `#/p/${encodeURIComponent(p)}` }, el('i', { class: 'sw', style: { background: colorOf(p) } }), p);
  const hhLabel = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
  const everyFor = (host, n) => Math.ceil(n / Math.max(1, Math.floor(width(host) / 56)));
  function perDay(times) {
    const days = daysIn(S.a, S.b);
    const idx = new Map(days.map((d, i) => [d.key, i]));
    const v = new Array(days.length).fill(0);
    for (const t of times) { const i = idx.get(hourParts(Math.floor(t / HOUR) * HOUR).day); if (i != null) v[i] += 1; }
    return { days, v };
  }
  function perHour(times) {
    const v = new Array(24).fill(0);
    for (const t of times) v[hourParts(Math.floor(t / HOUR) * HOUR).hour] += 1;
    return v;
  }
  function sortableTable(cols, rows, st, rowFn, empty) {
    // the same table (page + columns) picks up where it was: sort, search, how many shown
    const id = `${splitHash(location.hash).path}|${cols.map((c) => c.label).join(',')}`;
    if (S.tables[id]) Object.assign(st, S.tables[id]);
    S.tables[id] = st;
    const tbody = el('tbody'), thead = el('tr'), more = el('div', { class: 'more' });
    const draw = () => {
      const k = st.key, dir = st.asc ? 1 : -1;
      const col = cols.find((c) => c.key === k);
      const val = col?.val || ((r) => r[k]);
      const q = st.q.trim().toLowerCase();
      const hits = rows.filter((r) => !q || r._search.includes(q)).sort((x, y) => {
        const a = val(x), b = val(y);
        return (typeof a === 'string' ? a.localeCompare(b) : (a ?? 0) - (b ?? 0)) * dir;
      });
      tbody.replaceChildren(...hits.slice(0, st.limit).map(rowFn));
      if (!hits.length) tbody.append(el('tr', null, el('td', { colspan: cols.length, class: 'empty-state', text: empty })));
      more.replaceChildren(...(hits.length > st.limit ? [el('button', { type: 'button', text: `Show more (${nf(hits.length - st.limit)} hidden)`, onclick: () => { st.limit += 100; draw(); } })] : []));
      thead.replaceChildren(...cols.map((c) => el('th', {
        class: [c.r ? 'r' : '', c.key && c.key === st.key ? `sorted${st.asc ? ' asc' : ''}` : ''].join(' ').trim() || null,
        'data-sort': c.key || null, 'aria-sort': c.key === st.key ? (st.asc ? 'ascending' : 'descending') : null, text: c.label,
        onclick: c.key ? () => { if (st.key === c.key) st.asc = !st.asc; else { st.key = c.key; st.asc = c.key === 'p'; } draw(); } : null })));
    };
    draw();
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Search', 'aria-label': 'Search table', value: st.q,
      oninput: (e) => { st.q = e.target.value; draw(); } });
    return { table: el('div', null, el('div', { class: 'table-wrap' }, el('table', null, el('thead', null, thead), tbody)), more), search };
  }
  const END_LABEL = { logout: 'left', relog: 'relogged', timeout: 'connection lost', restart: 'server restart' };
  // Deaths during a session; with clip, only those inside the selected range.
  function deathsBySession(clip) {
    const byP = new Map();
    for (const d of S.data.deaths) { if (!byP.has(d.p)) byP.set(d.p, []); byP.get(d.p).push(d.t); }
    return (s) => (byP.get(s.p) || []).filter((t) => t >= s.s && t <= s.end_t && (!clip || (t >= S.a && t < S.b))).length;
  }

  function sessionsView() {
    const dIn = deathsBySession();
    const ses = S.data.sessions.filter((s) => s.end_t > S.a && s.s < S.b)
      .map((s) => ({ ...s, dur: s.end_t - s.s, deaths: dIn(s), _search: `${s.p} ${END_LABEL[s.end] || s.end}`.toLowerCase() }));
    const durs = ses.map((s) => s.dur).sort((x, y) => x - y);
    const total = durs.reduce((n, v) => n + v, 0);
    const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
    const longest = ses.reduce((m, s) => (s.dur > (m?.dur || 0) ? s : m), null);
    const count = new Map();
    for (const s of ses) count.set(s.p, (count.get(s.p) || 0) + 1);
    const most = [...count].sort((x, y) => y[1] - x[1])[0];
    const buckets = [[0, 15 * 60, '<15m'], [15 * 60, 30 * 60, '15–30m'], [30 * 60, HOUR, '30–60m'], [HOUR, 2 * HOUR, '1–2h'],
      [2 * HOUR, 4 * HOUR, '2–4h'], [4 * HOUR, 8 * HOUR, '4–8h'], [8 * HOUR, Infinity, '8h+']];
    const hist = buckets.map(([lo, hi]) => durs.filter((d) => d >= lo && d < hi).length);
    const starts = perHour(ses.filter((s) => s.s >= S.a).map((s) => s.s));

    const hg = chartHost(), st = chartHost();
    later(() => columns(hg, { labels: buckets.map((b) => b[2]), values: hist, fmtV: (v) => plural(v, 'session'), tipT: (i) => `Sessions lasting ${buckets[i][2]}`, aria: 'Session length distribution' }));
    later(() => columns(st, { labels: starts.map((_, h) => String(h).padStart(2, '0')), values: starts, every: 3, fmtV: (v) => plural(v, 'session'), tipT: (h) => `Started ${hhLabel(h)}`, aria: 'Session starts by hour' }));

    const cols = [
      { label: 'Player', key: 'p' }, { label: 'Started', key: 's' }, { label: 'Ended', key: 'end_t' },
      { label: 'Duration', key: 'dur', r: true }, { label: 'Deaths', key: 'deaths', r: true }, { label: '', key: null },
    ];
    const { table, search } = sortableTable(cols, ses, S.sl, (s) => el('tr', { class: 'click', tabindex: '0', onclick: () => go(s.p), onkeydown: (e) => { if (e.key === 'Enter') go(s.p); } },
      el('td', null, el('span', { class: 'who' }, el('i', { class: 'sw', style: { background: colorOf(s.p) } }), s.p)),
      el('td', { text: fDateTime(s.s) }),
      el('td', { text: s.e == null ? 'now' : fDateTime(s.e) }),
      el('td', { class: 'r', text: fDur(s.dur) }),
      el('td', { class: 'r', text: nf(s.deaths) }),
      el('td', null, s.e == null ? el('span', { class: 'badge on', text: 'online' }) : el('span', { class: 'hint', text: END_LABEL[s.end] || s.end }))), 'No matching session.');

    return [
      ...subHead('Sessions', plural(ses.length, 'session')),
      kpiRow(
        kpi('Sessions', nf(ses.length), most ? `most: ${most[0]} (${most[1]})` : null),
        kpi('Total time', fH(total)),
        kpi('Average', ses.length ? fDur(total / ses.length) : '–'),
        kpi('Median', ses.length ? fDur(median) : '–'),
        kpi('Longest', longest ? fDur(longest.dur) : '–', longest ? `${longest.p} · ${fDate(longest.s)}` : null)),
      el('div', { class: 'grid' },
        card('How long do sessions last?', null, hg, 'span-6'),
        card('When do sessions start?', `Hour of day (${TZ})`, st, 'span-6'),
        card('All sessions', 'Click a column to sort · click a row for the player', table, 'span-12', search)),
    ];
  }

  function skillLossCard(ds) {
    const ls = lossStats(ds);
    const max = Math.max(...ls.map((e) => e.drain), 0.0001);
    const body = ls.length ? el('div', null, el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['Player', 'Deaths', 'Cost skills', 'Free', 'Skill drain'].map((h, i) => el('th', { class: i && i < 4 ? 'r' : null, text: h })))),
      el('tbody', null, ls.map((e) => el('tr', null,
        el('td', null, playerLink(e.p)),
        el('td', { class: 'r', text: nf(e.n) }),
        el('td', { class: 'r', text: nf(e.hard) }),
        el('td', { class: 'r', text: nf(e.soft) }),
        el('td', null, el('span', { class: 'share wide' }, el('span', { style: { width: `${(e.drain / max) * 100}%`, background: colorOf(e.p) } })),
          el('b', { text: e.hard ? pct(e.drain) : '0 %' }))))))), LOSS_EXPLAIN())
      : el('div', { class: 'empty-state', text: 'Nobody died — no skills lost.' });
    return card('Skill loss', 'What dying cost each character in this range', body, 'span-12');
  }

  function deathsView() {
    const c = compute(S.a, S.b);
    const ds = c.deaths;
    const per = new Map();
    for (const d of ds) per.set(d.p, (per.get(d.p) || 0) + 1);
    const ranked = [...per].map(([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v);
    const rate = c.rows.filter((r) => r.play >= HOUR).map((r) => ({ k: r.p, v: r.deaths / (r.play / HOUR) })).sort((x, y) => y.v - x.v);
    const dIn = deathsBySession(true);
    const worstSes = S.data.sessions.filter((s) => s.end_t > S.a && s.s < S.b).map((s) => ({ s, n: dIn(s) })).sort((x, y) => y.n - x.n)[0];
    const byHour = perHour(ds.map((d) => d.t));
    const worstH = byHour.indexOf(Math.max(...byHour));

    // "Rough moments": ≥3 deaths with ≤5 min between consecutive ones.
    const sorted = ds.slice().sort((x, y) => x.t - y.t);
    const clusters = [];
    let cur = [];
    for (const d of sorted) {
      if (cur.length && d.t - cur[cur.length - 1].t > 300) { if (cur.length >= 3) clusters.push(cur); cur = []; }
      cur.push(d);
    }
    if (cur.length >= 3) clusters.push(cur);
    clusters.sort((x, y) => y.length - x.length || y[0].t - x[0].t);
    const raidNear = (t) => S.data.raids.find((r) => r.t <= t && t - r.t < 15 * 60);

    const pd = chartHost(), ph = chartHost();
    later(() => {
      const { days, v } = perDay(ds.map((d) => d.t));
      columns(pd, { labels: days.map((d) => fDate(d.t)), values: v, color: 'var(--s8)', every: everyFor(pd, days.length), fmtV: (n) => plural(n, 'death'), tipT: (i) => fDateY(days[i].t), aria: 'Deaths per day' });
    });
    later(() => columns(ph, { labels: byHour.map((_, h) => String(h).padStart(2, '0')), values: byHour, color: 'var(--s8)', every: 3, fmtV: (n) => plural(n, 'death'), tipT: hhLabel, aria: 'Deaths by hour of day' }));

    const moments = clusters.slice(0, 8).map((cl) => {
      const who = new Map();
      for (const d of cl) who.set(d.p, (who.get(d.p) || 0) + 1);
      const raid = raidNear(cl[0].t);
      return el('li', null,
        el('span', { class: 'ico', 'aria-hidden': 'true', text: '☠' }),
        el('span', { class: 'what' }, el('b', { text: `${cl.length} deaths in ${fDur(cl[cl.length - 1].t - cl[0].t || 1)}` }), ' · ',
          [...who].map(([p, n], i) => [i ? ', ' : '', el('a', { href: `#/p/${encodeURIComponent(p)}`, text: p }), n > 1 ? ` ×${n}` : '']),
          raid ? el('span', { class: 'hint', text: ` · during raid: ${raidName(raid.n)}` }) : null),
        el('time', { text: fDateTime(cl[0].t) }));
    });

    return [
      ...subHead('Deaths', plural(ds.length, 'death')),
      kpiRow(
        kpi('Deaths', nf(ds.length), c.total ? `${nf(ds.length / (c.total / HOUR), 1)} per player-hour` : null),
        kpi('Most deaths', ranked[0]?.k || '–', ranked[0] ? plural(ranked[0].v, 'death') : null),
        kpi('Most careless', rate[0]?.k || '–', rate[0] ? `${nf(rate[0].v, 1)} deaths per hour played` : null),
        kpi('Worst session', worstSes?.n ? plural(worstSes.n, 'death') : '–', worstSes?.n ? `${worstSes.s.p} · ${fDate(worstSes.s.s)}` : null),
        kpi('Deadliest hour', ds.length ? hhLabel(worstH) : '–', ds.length ? plural(byHour[worstH], 'death') : null),
        kpi('Costly deaths', nf(ds.filter((d) => d.hard).length), `${nf(ds.filter((d) => !d.hard).length)} free · each −${pct(S.skillLoss)} skills`)),
      el('div', { class: 'grid' },
        skillLossCard(ds),
        card('Deaths per player', null, ranked.length ? hbars(ranked, (v) => nf(v), colorOf, true) : el('div', { class: 'empty-state', text: 'Nobody died. Impressive.' }), 'span-6'),
        card('Deaths per hour played', 'Players with at least 1 h in range', rate.length ? hbars(rate, (v) => nf(v, 1), colorOf, true) : el('div', { class: 'empty-state', text: 'Not enough playtime.' }), 'span-6'),
        card('Deaths per day', null, pd, 'span-7'),
        card('By hour of day', TZ, ph, 'span-5'),
        card('Rough moments', '3+ deaths in quick succession',
          moments.length ? el('ul', { class: 'feed' }, moments) : el('div', { class: 'empty-state', text: 'No death streaks in this range.' }), 'span-12'),
        feed(c, { fixed: ['death'], title: 'Death log' })),
    ];
  }

  function raidsView() {
    const rs = S.data.raids.filter((r) => r.t >= S.a && r.t < S.b);
    const types = raidTypes(rs);
    const defenders = new Map();
    for (const r of rs) for (const p of r.players) defenders.set(p, (defenders.get(p) || 0) + 1);
    const def = [...defenders].map(([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v);
    const avg = rs.length ? rs.reduce((n, r) => n + r.players.length, 0) / rs.length : 0;
    const deaths = rs.reduce((n, r) => n + deathsAfter(r), 0);

    const strip = chartHost();
    later(() => (rs.length ? raidStrip(strip, rs, S.a, S.b) : empty(strip, 'No raids in this range.')));

    // per-type summary
    const per = types.map((t) => {
      const of = rs.filter((r) => raidName(r.n) === t.k);
      return { k: t.k, title: t.title, n: of.length, last: Math.max(...of.map((r) => r.t)),
        avg: of.reduce((n, r) => n + r.players.length, 0) / of.length, deaths: of.reduce((n, r) => n + deathsAfter(r), 0), _search: t.k.toLowerCase() };
    });
    const tt = sortableTable([{ label: 'Raid', key: 'k' }, { label: 'Times', key: 'n', r: true }, { label: 'Last', key: 'last', r: true },
      { label: 'Ø online', key: 'avg', r: true }, { label: '☠ ≤5 min', key: 'deaths', r: true }], per, { key: 'n', asc: false, q: '', limit: 50 },
    (t) => el('tr', null,
      el('td', { title: t.title }, el('span', { class: 'who' }, el('i', { class: 'sw', style: { background: S.raidColor.get(t.k) || 'var(--other)', borderRadius: '3px' } }), t.k)),
      el('td', { class: 'r', text: nf(t.n) }), el('td', { class: 'r', text: fAgo(S.data.generated - t.last) }),
      el('td', { class: 'r', text: nf(t.avg, 1) }), el('td', { class: 'r', text: nf(t.deaths) })), 'No raids in this range.');

    const rows = rs.map((r) => ({ ...r, name: raidName(r.n), np: r.players.length, deaths: deathsAfter(r), _search: `${raidName(r.n)} ${r.n} ${r.players.join(' ')}`.toLowerCase() }));
    const st = { key: 't', asc: false, q: S.rq, limit: 100 };
    const { table, search } = sortableTable(
      [{ label: 'When', key: 't' }, { label: 'Raid', key: 'name' }, { label: 'Online', key: 'np' }, { label: '☠ ≤5 min', key: 'deaths', r: true }],
      rows, st, (r) => el('tr', null,
        el('td', { text: fDateTime(r.t) }),
        el('td', { title: r.n }, el('span', { class: 'who' }, el('i', { class: 'sw', style: { background: raidColor(r.n), borderRadius: '3px' } }), r.name)),
        // plain links: on this page colour means raid type, not player
        el('td', null, r.players.length ? r.players.map((p, i) => [i ? ', ' : '', el('a', { class: 'plain', href: `#/p/${encodeURIComponent(p)}`, text: p })]) : el('span', { class: 'hint', text: 'nobody online' })),
        el('td', { class: 'r', text: r.deaths ? nf(r.deaths) : '–' })),
      'No matching raid.');
    search.addEventListener('input', (e) => { S.rq = e.target.value; });

    return [
      ...subHead('Raids', plural(rs.length, 'raid')),
      kpiRow(
        kpi('Raids', nf(rs.length), types.length ? `${plural(types.length, 'kind')}` : null),
        kpi('Most common', types[0]?.k || '–', types[0] ? `${types[0].v}×` : null),
        kpi('Last raid', rs.length ? fAgo(S.data.generated - rs[rs.length - 1].t) : '–', rs.length ? raidName(rs[rs.length - 1].n) : null),
        kpi('Ø online', rs.length ? nf(avg, 1) : '–', 'players when it started'),
        kpi('Deaths', nf(deaths), 'within 5 min of a raid start')),
      el('div', { class: 'grid' },
        card('Timeline', `Each marker is one raid · ${HOVER} for details`, el('div', null, strip, rs.length ? raidLegend(rs) : null), 'span-12'),
        card('By type', null, el('div', null, tt.table, RAID_EXPLAIN()), 'span-8'),
        card('Defenders', 'Raids that started while they were online', def.length
          ? hbars(def, (v) => `${nf(v)}×`, () => 'var(--ink-2)', true) : el('div', { class: 'empty-state', text: 'Nobody defended anything.' }), 'span-4'),
        card('All raids', null, table, 'span-12', search)),
    ];
  }

  // ---- unaccounted kills: deaths the plugin saw but couldn't credit to anyone (no guessing from who was near)
  const UNACCOUNTED_TEXT = 'A creature died, but nothing said who killed it: no player on its attacker list who was alive and near, '
    + 'and no summon of anyone in reach just before. Typical causes: traps, turrets, the environment, creatures fighting each other, '
    + 'or a one-hit kill whose last update never reached the server. These are never credited to whoever happened to be nearby. '
    + 'Each one is in the server log as a "[Gamestats-unaccounted]" line with what was known; to investigate, turn on '
    + '[Debug] Trace in the plugin config and replay the trace (docs/ATTRIBUTION.md, "Unaccounted kills").';
  function unaccountedView() {
    const rows = (S.data.gather || []).filter((g) => g[2] === 'ukill' && g[0] >= S.a && g[0] < S.b);
    const total = rows.reduce((n, g) => n + g[4], 0);
    const byKind = new Map();
    for (const g of rows) byKind.set(g[3], (byKind.get(g[3]) || 0) + g[4]);
    const kinds = new Set([...byKind.keys()].map((i) => gatherLabel(i).replace(/ ★\d+$/, '')));
    const last = rows.length ? Math.max(...rows.map((g) => g[0])) : null;
    const list = rows.map((g) => ({ t: g[0], i: g[3], name: gatherLabel(g[3]), n: g[4], _search: `${gatherLabel(g[3])} ${g[3]}`.toLowerCase() }));
    const { table, search } = sortableTable([{ label: 'Hour', key: 't' }, { label: 'Creature', key: 'name' }, { label: 'Kills', key: 'n', r: true }],
      list, { key: 't', asc: false, q: '', limit: 100 }, (r) => el('tr', null,
        el('td', { text: fDateTime(r.t) }),
        el('td', null, r.i.includes('/') ? el('span', { text: r.name }) : el('a', { class: 'plain', href: creatureHref(r.i), text: r.name })),
        el('td', { class: 'r', text: nf(r.n) })), 'No unaccounted kills in this range.');
    return [
      ...subHead('Unaccounted kills', plural(total, 'kill')),
      kpiRow(
        kpi('Unaccounted kills', nf(total), 'deaths nobody could be credited with'),
        kpi('Creature kinds', nf(kinds.size), byKind.size ? `mostly ${gatherLabel([...byKind].sort((x, y) => y[1] - x[1])[0][0])}` : null),
        kpi('Last one', last != null ? fAgo(S.data.generated - last) : '–', last != null ? 'within that hour' : null)),
      el('div', { class: 'grid' },
        card('By creature', null, el('div', null,
          gatherBars(byKind, () => 'var(--ink-2)', 'No unaccounted kills in this range.', 20, 'creature'),
          el('p', { class: 'explain', text: UNACCOUNTED_TEXT })), 'span-6'),
        card('All of them', 'per hour and creature', table, 'span-6', search)),
    ];
  }

  // ---- summons a player fought with: by race (the creature) and type (what it held), from the plugin's sdw / skw
  // ("Skeleton_Friendly:skeleton_sword2+ShieldWood>Bonemass": kind, held items, the creature it hit)
  function summonsCard(r) {
    const rows = new Map();
    for (const [key, field] of [['sdealt', 'd'], ['skills', 'k']])
      for (const [i, n] of r.gathered?.[key] || []) {
        const v = i.slice(0, i.lastIndexOf('>'));
        const row = rows.get(v) || rows.set(v, { v, d: 0, k: 0 }).get(v);
        row[field] += n;
      }
    if (!rows.size) return null;
    const list = [...rows.values()].map((x) => {
      const [kind, held = ''] = x.v.split(':');
      const type = held ? held.split('+').map(itemName).join(' + ') : '–';
      return { ...x, race: gatherLabel(kind), type, _search: `${gatherLabel(kind)} ${type}`.toLowerCase() };
    });
    const best = [...list].sort((a, b) => b.d - a.d)[0];
    const { table } = sortableTable([{ label: 'Summon', key: 'race' }, { label: 'Type', key: 'type' }, { label: 'Damage', key: 'd', r: true },
      { label: 'Kills', key: 'k', r: true }], list, { key: 'd', asc: false, q: '', limit: 50 }, (x) => el('tr', null,
      el('td', { text: x.race }), el('td', { text: x.type }), el('td', { class: 'r', text: nf(x.d) }), el('td', { class: 'r', text: nf(x.k) })),
    'No summons in range.');
    return card('Summons', `Best: ${best.race} · ${best.type} — ${nf(best.d)} damage`, table, 'span-12');
  }

  function worldView(r) {
    const wst = mapState('world');
    wst.line = worldLineFromLink(r?.q);
    if (!r?.q?.has('f') && wst.line !== MAP_LINE_DEFAULT) {  // the link shows the line it draws, so it can be shared
      const q = new URLSearchParams(r?.q);
      q.set('f', wst.line);
      history.replaceState(null, '', `#/world?${q}`);
    }
    const c = compute(S.a, S.b);
    const at = r?.q?.get('at')?.split(',').map(Number);
    const focus = at?.length === 2 && at.every(Number.isFinite)
      ? { id: location.hash, x: at[0], z: at[1], zoom: Math.max(0, Math.min(8, Number(r.q.get('zoom')) || 4)), label: r.q.get('label') || '' } : null;
    const all = S.data.zones.filter((z) => z.t < S.b);
    const spawn = spawnZone();
    const far = all.length ? Math.max(...all.map((z) => Math.hypot(z.x - spawn.x, z.y - spawn.y))) * 64 / 1000 : 0;
    const biomes = new Map();
    for (const z of all) biomes.set(biomeOf(z), (biomes.get(biomeOf(z)) || 0) + 1);
    const bl = [...biomes].map(([k, v]) => ({ k, v })).sort((x, y) => BIOMES.findIndex((b) => b[0] === x.k) - BIOMES.findIndex((b) => b[0] === y.k));
    const reached = bl.filter((b) => b.k !== 'Unknown' && b.k !== 'Ocean').map((b) => b.k);
    const exp = new Map();
    for (const z of c.zones) for (const p of (z.by.length ? z.by : ['World generation'])) exp.set(p, (exp.get(p) || 0) + 1);
    const explorers = [...exp].map(([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v);
    const sleeps = S.data.days.filter((d) => d.t >= S.a && d.t < S.b);
    const before = [...S.data.days].reverse().find((d) => d.t < S.a);
    const pts = [...(before ? [[S.a, before.d]] : []), ...sleeps.map((d) => [d.t, d.d])];

    const mp = el('div'), pd = chartHost(), dg = chartHost();
    later(() => zoneMap(mp, c, 'world', null, focus ? { focus } : null));
    later(() => {
      const { days, v } = perDay(c.zones.map((z) => z.t));
      columns(pd, { labels: days.map((d) => fDate(d.t)), values: v, every: everyFor(pd, days.length), fmtV: (n) => plural(n, 'zone'), tipT: (i) => fDateY(days[i].t), aria: 'Zones discovered per day' });
    });
    later(() => stepChart(dg, { a: S.a, b: S.b, pts, fmtY: (v) => `Day ${nf(v)}`, label: 'in-game', aria: 'In-game day over time' }));

    return [
      ...subHead('World', S.data.version ? `Valheim ${S.data.version}` : null),
      kpiRow(
        kpi('Zones explored', nf(c.zones.length), `${nf(all.length)} total`),
        kpi('Area', `${nf(all.length * 64 * 64 / 1e6, 2)} km²`, 'explored so far'),
        kpi('Farthest out', `${nf(far, 1)} km`, 'from spawn'),
        kpi('Biomes reached', nf(reached.length), reached.join(', ') || null),
        kpi('In-game day', S.data.day != null ? nf(S.data.day) : '–', `${plural(sleeps.length, 'night')} slept in range`)),
      el('div', { class: 'grid' },
        withId(card('Map', S.data.terrain ? 'The land where players have been, the zones (64 m) they generated, and what is on it' : 'Zones (64 m) generated as players explore', mp, 'span-12'), 'map'),
        card('In-game day', 'Advances when everyone sleeps', dg, 'span-6'),
        card('Discoveries per day', null, pd, 'span-6'),
        card('Explorers', 'New zones generated while a player was online', explorers.length ? hbars(explorers, (v) => nf(v), (k) => (S.color.has(k) ? colorOf(k) : 'var(--other)'), false) : el('div', { class: 'empty-state', text: 'Nothing new explored in this range.' }), 'span-6'),
        dungeonsCard(),
        card('Biomes', 'Zones by biome (guessed from locations found there)', bl.length ? hbars(bl, (v) => nf(v), () => 'var(--s3)') : el('div', { class: 'empty-state', text: 'No zones yet.' }), 'span-6')),
    ];
  }

  function dungeonsCard() {
    const all = dungeons();
    if (!all.length) return null;
    const st = mapState('world'), F = parseMapFilter(st.line), ds = F.kinds.dungeon ? all.filter((l) => F.shows('dungeon', l)) : all;
    const rows = ds.map((l) => {
      const vs = visitsAt(l), zn = zoneAt(l[2], l[3]), last = vs[vs.length - 1];
      return { l, type: l[1], place: placeName(l[2], l[3]), found: zn?.t ?? 0, visits: vs.length, last: last?.[0] ?? 0, lastBy: last?.[1] || '',
        who: [...new Set(vs.map((v) => v[1]))], _search: `${l[1]} ${placeName(l[2], l[3])} ${vs.map((v) => v[1]).join(' ')}`.toLowerCase() };
    });
    const sst = S.dgSort || (S.dgSort = { key: 'last', asc: false, q: '', limit: 25 });
    const { table, search } = sortableTable([{ label: 'Dungeon', key: 'type' }, { label: 'Where', key: 'place' }, { label: 'Found', key: 'found' },
      { label: 'Visits', key: 'visits', r: true }, { label: 'Last went in', key: 'last' }], rows, sst, (x) => el('tr', null,
      el('td', null, el('a', { class: 'plain', href: mapHref(x.l[2], x.l[3], 6, x.type), text: x.type })), el('td', { class: 'hint', text: x.place }),
      el('td', { class: 'hint', text: x.found ? fDate(x.found) : '–' }), el('td', { class: 'r', text: x.visits ? nf(x.visits) : '–' }),
      el('td', null, x.last ? [whoLink(x.lastBy), el('span', { class: 'hint', text: ` · ${fAgo(S.data.generated - x.last)}` })] : el('span', { class: 'hint', text: 'nobody yet' }))),
      'No dungeon matches the filter.');
    // visits: to the dungeons the filter keeps, and by whom dungeon:entered-by-… names
    const byP = new Set((F.kinds.dungeon || []).flat().filter((v) => v.startsWith('entered-by-')).map((v) => v.slice(11)));
    const vs = (S.data.visits || []).filter((v) => { const l = all.find((d) => d[4] === v[2] && Math.hypot(v[3] - d[2], v[4] - d[3]) <= 60); return (!l || !F.kinds.dungeon || F.shows('dungeon', l)) && (!byP.size || byP.has(tokSlug(v[1]))); });
    const filtered = !!F.kinds.dungeon;
    const dtoks = F.toks.filter(([t, ok], j) => ok && (/^dungeon:/i.test(t) || (t === 'AND' && /^dungeon:/i.test(F.toks[j - 1]?.[0] || '')))).map(([t]) => t);
    return withId(card('Dungeons', `${filtered ? `${nf(ds.length)} of ` : ''}${plural(all.length, 'dungeon')} found so far (▼ on the map, filtered the same) · who went in, since the server plugin follows it`,
      el('div', { class: 'stack' }, el('div', { class: 'hint' }, dtoks.length ? `Filtered by ${dtoks.join(' ')} — ` : 'Narrow it down in the map’s filter line, e.g. dungeon:troll-cave AND dungeon:not-entered — ',
        el('a', { class: 'plain', href: '#/world?card=map', text: 'edit the filter ↑' })), table, vs.length
        ? el('div', null, el('h3', { text: 'Latest visits' }), ...[...vs].reverse().slice(0, 15).map((v) => visitLine(v)))
        : el('div', { class: 'empty-state', text: (S.data.visits || []).length ? 'No visit matches the filter.' : 'Nobody has gone into a dungeon since the server plugin started following it.' })),
      'span-12', search), 'dungeons');
  }

  // ------------------------------------------------------------------ world save (snapshot, not range-filtered)

  const ALTAR = { defeated_eikthyr: 'Eikthyrnir', defeated_gdking: 'GDKing', defeated_bonemass: 'Bonemass', defeated_dragon: 'Dragonqueen',
    defeated_goblinking: 'GoblinKing', defeated_queen: 'Mistlands_DvergrBossEntrance1', defeated_fader: 'FaderLocation' };
  const MILESTONES = { killedtroll: 'First troll slain', killed_surtling: 'First surtling slain', killedbat: 'First bat slain' };
  // Keys the boss cards don't cover; a defeated_* key for a boss we don't know yet still shows up.
  const milestoneName = (k) => MILESTONES[k] || (k.startsWith('defeated_') ? `${pretty(k.slice(9))} defeated` : pretty(k));
  const pretty = (n) => n.replace(/^piece_/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
  const sumPieces = () => Object.values(S.data.world?.pieces || {}).reduce((n, v) => n + v.total, 0);
  const snapNote = () => `world save #${S.data.world.save} · saved ${fDateTime(S.data.world.t)}`;
  const itemHref = (name) => `#/item/${encodeURIComponent(name)}`;

  // ------------------------------------------------------------------ game item data
  // icons/valheim/items.json, extracted from the game's files by tools/extract_gamedata.py:
  // {prefab: {name, desc, type, maxQ, weight, armor/block/deflect/dur/dmg.<type>: [base, perLevel], …}}.
  // Loaded once next to data.json; everything here degrades to prefab names without it.
  const GD = () => S.gd || {};
  // creatures.json beside items.json (tools/extract_gamedata.py): {prefab: {name, hp, boss, …}} — optional
  const CD = () => S.cd || {};
  const creatureHref = (prefab) => `#/creature/${encodeURIComponent(prefab.split('*')[0])}`;
  const itemName = (n) => (GD()[n]?.name && !GD()[n].name.startsWith('$') ? GD()[n].name : pretty(n));  // $item_… = no English name in the game files
  // Plugin event objects: items, trees, rocks, creatures — creatures carry their stars as Name*N.
  // Creature prefabs whose in-game name differs (the rest read fine through pretty()). Checked
  // against the game's English localization (enemy_* keys in resources.assets) — only verified ones here.
  const CREATURE_NAMES = {
    Bjorn: 'Bear', Unbjorn: 'Vile', gd_king: 'The Elder', Dragon: 'Moder', GoblinKing: 'Yagluth', SeekerQueen: 'The Queen',
    Greydwarf_Elite: 'Greydwarf Brute', Greydwarf_Shaman: 'Greydwarf Shaman', Skeleton_Meadows_noarcher: 'Skeleton', Skeleton_NoArcher: 'Skeleton',
    Skeleton_Poison: 'Rancid Remains', Goblin: 'Fuling', GoblinBrute: 'Fuling Berserker', GoblinShaman: 'Fuling Shaman',
    Draugr_Elite: 'Draugr Elite', Hatchling: 'Drake', StoneGolem: 'Stone Golem', BlobElite: 'Oozer',
    SeekerBrute: 'Seeker Soldier', FallenValkyrie: 'Fallen Valkyrie', BonemawSerpent: 'Bonemaw', Charred_Melee: 'Charred Warrior',
    Charred_Archer: 'Charred Marksman', Charred_Mage: 'Charred Warlock', Charred_Twitcher: 'Charred Twitcher',
  };
  const gatherLabel = (i) => {
    const [base, stars] = i.split('*');
    // "Goblin/GoblinArcher": a death known only by a ragdoll several kinds share — every kind it can be
    const one = (b) => CD()[b]?.name || CREATURE_NAMES[b] || itemName(b);
    const name = base.includes('/') ? base.split('/').map(one).join(' or ') : one(base);
    return stars ? `${name} ★${stars}` : name;
  };
  // Sum the per-object breakdowns of some plugin stats over several players.
  const mergeGather = (rows, keys) => {
    const m = new Map();
    for (const r of rows) for (const key of keys) for (const [i, n] of r.gathered?.[key] || []) m.set(i, (m.get(i) || 0) + n);
    return m;
  };
  // kind: 'creature' or 'item' links each bar to its page; trees and rocks have none.
  const gatherHref = (kind, i) => (kind === 'creature' ? creatureHref(i) : kind === 'item' && hasItemPage(i) ? itemHref(i) : null);
  const gatherBars = (m, color, empty, n = 12, kind = null) => {
    // by display name: two prefabs can be the same creature (Skeleton_Meadows_noarcher is a Skeleton)
    const byLabel = new Map(), raw = new Map();
    for (const [i, v] of m) {
      byLabel.set(gatherLabel(i), (byLabel.get(gatherLabel(i)) || 0) + v);
      if (!raw.has(gatherLabel(i))) raw.set(gatherLabel(i), i);
    }
    const top = [...byLabel].sort((x, y) => y[1] - x[1]).slice(0, n);
    return top.length ? hbars(top.map(([k, v]) => ({ k, v, href: gatherHref(kind, raw.get(k)) })), (v) => nf(v), color, kind ? (i) => i.href : null)
      : el('div', { class: 'empty-state', text: empty });
  };
  const starsOf = (i) => Number(i.split('*')[1] || 0);
  const hasItemPage = (n) => !!(GD()[n] || ITEMS()[n]);
  const atQ = (pair, q) => pair[0] + Math.max(0, q - 1) * pair[1];
  const nq = (v, dg) => nf(v, Math.abs(v - Math.round(v)) < 1e-6 ? 0 : dg);  // 20, but 0.8
  const sgnPct = (v) => `${v > 0 ? '+' : ''}${nf(v * 100)} %`;
  const DMG_LABEL = { damage: 'Damage', blunt: 'Blunt', slash: 'Slash', pierce: 'Pierce', chop: 'Chop', pickaxe: 'Pickaxe',
    fire: 'Fire', frost: 'Frost', lightning: 'Lightning', poison: 'Poison', spirit: 'Spirit' };
  const MOD_LABEL = { movementModifier: 'Movement speed', eitrRegenModifier: 'Eitr regen', heatResistanceModifier: 'Heat resistance',
    homeItemsStaminaModifier: 'Building stamina', jumpStaminaModifier: 'Jump stamina', attackStaminaModifier: 'Attack stamina',
    blockStaminaModifier: 'Block stamina', dodgeStaminaModifier: 'Dodge stamina', swimStaminaModifier: 'Swim stamina',
    sneakStaminaModifier: 'Sneak stamina', runStaminaModifier: 'Run stamina' };
  // status-effect stats worth showing; anything else the extractor found stays hidden
  const SE_LABEL = {
    addMaxCarryWeight: ['Carry weight', (v) => `${v > 0 ? '+' : ''}${nf(v)}`],
    healthRegenMultiplier: ['Health regen', (v) => sgnPct(v - 1)], staminaRegenMultiplier: ['Stamina regen', (v) => sgnPct(v - 1)],
    eitrRegenMultiplier: ['Eitr regen', (v) => sgnPct(v - 1)], speedModifier: ['Movement speed', sgnPct],
    runStaminaDrainModifier: ['Run stamina', sgnPct], jumpStaminaUseModifier: ['Jump stamina', sgnPct],
    attackStaminaUseModifier: ['Attack stamina', sgnPct], blockStaminaUseModifier: ['Block stamina', sgnPct],
    dodgeStaminaUseModifier: ['Dodge stamina', sgnPct], swimStaminaUseModifier: ['Swim stamina', sgnPct],
    fallDamageModifier: ['Fall damage', sgnPct], maxMaxFallSpeed: ['Max fall speed', (v) => nf(v)],
    timedBlockBonus: ['Parry bonus', (v) => `+${nf(v, 2)}×`], windMovementModifier: ['Sailing with the wind', sgnPct],
  };
  // [label, value] rows of one status effect (equip, set, adrenaline, consume)
  function effectRows(se) {
    const st = se.stats || {}, out = [];
    for (const [k, v] of Object.entries(st)) if (SE_LABEL[k]) out.push([SE_LABEL[k][0], SE_LABEL[k][1](v)]);
    if (st.skillLevel && st.skillLevelModifier) out.push([st.skillLevel, `+${nf(st.skillLevelModifier)}`]);
    if (st.skillLevel2 && st.skillLevelModifier2) out.push([st.skillLevel2, `+${nf(st.skillLevelModifier2)}`]);
    if (st.damageModifier && st.modifyAttackSkill) out.push([`${st.modifyAttackSkill} damage`, sgnPct(st.damageModifier - 1)]);
    for (const [k, label] of [['healthOverTime', 'Healing'], ['staminaOverTime', 'Stamina'], ['eitrOverTime', 'Eitr']]) {
      if (st[k]) out.push([label, `+${nf(st[k])}${st[`${k}Duration`] ? ` over ${fDur(st[`${k}Duration`])}` : ''}`]);
    }
    for (const r of se.res || []) out.push([`${r.type} damage`, r.mod]);
    return out;
  }
  // stats that change with quality: [label, (q) => number, digits]
  function qualityRows(g) {
    const rows = [];
    if (g.armor) rows.push(['Armor', (q) => atQ(g.armor, q), 1]);
    for (const [k, p] of Object.entries(g.dmg || {})) rows.push([DMG_LABEL[k] || pretty(k), (q) => atQ(p, q), 1]);
    if (g.block) rows.push(['Block armor', (q) => atQ(g.block, q), 1], ['Block force', (q) => atQ(g.deflect, q), 1]);
    if (g.dur) rows.push(['Durability', (q) => atQ(g.dur, q), 0]);
    return rows;
  }
  // stats that don't: [label, text]
  function fixedRows(g, short) {
    const rows = [];
    if (g.parry) rows.push(['Parry bonus', `${nq(g.parry, 1)}×`]);
    if (g.backstab && !short) rows.push(['Backstab', `${nf(g.backstab, 1)}×`]);
    if (g.knockback && !short) rows.push(['Knockback', nf(g.knockback)]);
    if (g.stamina) rows.push(['Attack stamina', nq(g.stamina, 1)]);
    if (g.eitr) rows.push(['Attack eitr', nq(g.eitr, 1)]);
    if (g.health) rows.push(['Attack health', nq(g.health, 1)]);
    if (g.skill && !short) rows.push(['Skill', g.skill]);
    if (g.food) {
      rows.push(['Health', nf(g.food.health)], ['Stamina', nf(g.food.stamina)]);
      if (g.food.eitr) rows.push(['Eitr', nf(g.food.eitr)]);
      rows.push(['Duration', fDur(g.food.duration)], ['Healing', `${nf(g.food.regen, 1)} hp/tick`]);
    }
    for (const [k, v] of Object.entries(g.mods || {})) rows.push([MOD_LABEL[k] || pretty(k), sgnPct(v)]);
    for (const r of g.res || []) rows.push([`${r.type} damage`, r.mod]);
    if (!short) {
      rows.push(['Weight', nq(g.weight, 1)]);
      if (g.value) rows.push(['Trader value', `${nf(g.value)} coins`]);
      if (g.noTeleport) rows.push(['Teleportable', 'No']);
    }
    return rows;
  }
  // named effects of an item: [title, status effect]
  const itemEffects = (g) => [
    g.equipSE && ['While equipped', g.equipSE],
    g.adrenaline && [`At ${nf(g.adrenaline.max)} adrenaline`, g.adrenaline.se],
    g.set && [`Set bonus · ${g.set.size} pieces`, g.set.se],
    g.consumeSE && ['When consumed', g.consumeSE],
  ].filter((x) => x && effectRows(x[1]).length);
  const ITEM_TYPE = { 1: 'Material', 2: 'Consumable', 3: 'One-handed weapon', 4: 'Bow', 5: 'Shield', 6: 'Helmet', 7: 'Chest',
    9: 'Ammo', 10: 'Customization', 11: 'Legs', 12: 'Hands', 13: 'Trophy', 14: 'Two-handed weapon', 15: 'Torch', 16: 'Misc',
    17: 'Cape', 18: 'Utility', 19: 'Tool', 20: 'Atgeir', 21: 'Fish', 22: 'Two-handed weapon', 23: 'Ammo', 24: 'Trinket' };
  const itemIcon = (n, cls) => (GD()[n]?.icons ? el('img', { class: cls, alt: '', loading: 'lazy', decoding: 'async', src: `icons/valheim/${encodeURIComponent(n)}.png` }) : null);
  const tag = (name, n) => el('a', { class: 'tag link', href: itemHref(name), title: name }, itemName(name), n > 1 ? el('b', { text: ` ×${nf(n)}` }) : null);
  const tags = (list, empty) => (list.length ? el('div', { class: 'tags' }, list.map(([k, n]) => tag(k, n))) : el('div', { class: 'empty-state', text: empty }));

  // When a world key first appeared: between the last save without it and the first with it,
  // or between two RCON polls (a minute apart) for keys that appeared since polling started.
  function keyTimes() {
    const hist = S.data.world_history || [];
    const out = {};
    for (const k of new Set(hist.flatMap((h) => h.keys))) {
      const i = hist.findIndex((h) => h.keys.includes(k));
      out[k] = i > 0 ? { from: hist[i - 1].t, to: hist[i].t } : { before: true };
    }
    for (const [k, [from, to]] of Object.entries(S.data.key_times || {})) out[k] = { from, to };
    return out;
  }
  function whenText(w) {
    if (!w) return '';
    if (w.before) return 'before tracking started';
    return hourParts(Math.floor(w.from / HOUR) * HOUR).day === hourParts(Math.floor(w.to / HOUR) * HOUR).day
      ? `${fDateTime(w.from)}–${fTime(w.to)}` : `${fDateTime(w.from)} – ${fDateTime(w.to)}`;
  }

  // World progress in [a, b) for the activity chart and the event log: altars and biomes
  // come from the zone log (exact time + who), bosses/milestones from the world keys
  // (only known to the hourly save window, so they carry `from`).
  const PROGRESS = {
    boss: { ico: '⚔', color: 'var(--s4)', label: 'Boss slain' },
    altar: { ico: '⛩', color: 'var(--s7)', label: 'Altar found' },
    key: { ico: '✔', color: 'var(--s5)', label: 'Milestone' },
    biome: { ico: '⛰', color: 'var(--s3)', label: 'New biome' },
  };
  const BOSS_NAME = { defeated_eikthyr: 'Eikthyr', defeated_gdking: 'The Elder', defeated_bonemass: 'Bonemass', defeated_dragon: 'Moder',
    defeated_goblinking: 'Yagluth', defeated_queen: 'The Queen', defeated_fader: 'Fader' };
  const onlineDuring = (a, b) => [...new Set(S.data.sessions.filter((s) => s.s < b && s.end_t > a).map((s) => s.p))].sort();
  function progressEvents(a, b, only) {
    const out = [];
    const altars = Object.entries(ALTAR).map(([k, loc]) => [loc.toLowerCase(), S.data.world?.bosses.find((x) => x[0] === k)?.[1] || BOSS_NAME[k]]);
    const seenAltar = new Set(), seenBiome = new Set();
    for (const z of S.data.zones) {  // in discovery order
      const hit = z.t >= a && z.t < b && (!only || z.by.includes(only));
      for (const [loc, boss] of altars) {
        if (seenAltar.has(loc) || !z.l.some((l) => l.toLowerCase() === loc)) continue;
        seenAltar.add(loc);
        if (hit) out.push({ t: z.t, kind: 'altar', txt: `Altar of ${boss} found`, players: z.by });
      }
      const bi = biomeOf(z);
      if (bi !== 'Unknown' && !seenBiome.has(bi)) {
        seenBiome.add(bi);
        if (hit) out.push({ t: z.t, kind: 'biome', txt: `First steps into the ${bi}`, players: z.by });
      }
    }
    const w = S.data.world;
    if (w) {
      const times = keyTimes();
      const names = Object.fromEntries(w.bosses.map(([k, n]) => [k, n]));
      for (const k of [...w.bosses.filter((x) => x[2]).map((x) => x[0]), ...milestoneKeys(w)]) {
        const tw = times[k];
        if (!tw || tw.before || tw.to < a || tw.to >= b) continue;
        const players = onlineDuring(tw.from, tw.to);
        if (only && !players.includes(only)) continue;
        const boss = k in names;
        out.push({ t: tw.to, from: tw.from, kind: boss ? 'boss' : 'key', txt: boss ? `${names[k]} defeated` : milestoneName(k), players, when: whenText(tw) });
      }
    }
    return out.sort((x, y) => x.t - y.t);
  }

  // World keys worth celebrating: everything but the boss cards and per-world settings.
  const SETTING_KEY = /^(activebosses|skillreductionrate|deathskillsreset|nobuildcost|playerdamage|enemydamage|enemyspeedsize|enemylevelupchance|resourcerate|staminarate|moveStaminarate|staminaregenrate|nomap|noportals|preset|worldlevel|eventrate|raidrate|passivemobs|playerevents|fire|nobossportals|dungeonbuild|teleportall|chaintimer|deathdeleteitems|deathdeleteunequipped|deathkeepequip)/i;
  const milestoneKeys = (w) => w.keys.filter((k) => !SETTING_KEY.test(k) && !w.bosses.some((b) => b[0] === k));

  function progressCard(withLink) {
    const w = S.data.world;
    if (!w) return null;
    const times = keyTimes();
    const done = w.bosses.filter((b) => b[2]).length;
    const next = w.bosses.find((b) => !b[2]);
    const bosses = el('div', { class: 'bosses' }, w.bosses.map(([k, name, d]) => {
      const altar = w.boss_altars?.[ALTAR[k]];
      return el('div', { class: `boss${d ? ' done' : ''}${next && next[0] === k ? ' next' : ''}` },
        el('div', { class: 'boss-state' }, el('span', { class: 'boss-ico', 'aria-hidden': 'true', text: d ? '✔' : next && next[0] === k ? '⚔' : '·' }),
          el('span', { text: d ? 'Defeated' : next && next[0] === k ? 'Next' : 'Ahead' })),
        el('div', { class: 'boss-name', text: name }),
        el('div', { class: 'boss-sub', text: d ? whenText(times[k]) : altar ? 'altar area explored' : 'altar not found yet' }));
    }));
    const ms = milestoneKeys(w);
    const milestones = ms.length ? el('div', { class: 'tags', style: { marginTop: '12px' } }, ms.map((k) =>
      el('span', { class: 'tag', title: whenText(times[k]) }, '✔ ', milestoneName(k)))) : null;
    return card('Boss progress', `${done} of ${w.bosses.length} bosses defeated · ${S.data.keys_live ? `live · checked ${fDateTime(S.data.keys_live)}` : snapNote()}`, el('div', null, bosses, milestones), 'span-12',
      S.data.fights?.length ? el('a', { class: 'more-link', href: '#/bosses', text: 'Boss fights →' }) : null,
      withLink ? el('a', { class: 'more-link', href: '#/base', text: 'Base & gear →' }) : null);
  }

  // ---- Unity rich text (signs, shared pins, the game's own strings): <color=…>, <b>, <i>, <u>, <s>, <mark>, often unclosed
  const RICH_TAG = /<\/?(?:color|b|i|u|s|size|mark|material|alpha|sup|sub|font|cspace|voffset|line-height|nobr|noparse|lowercase|uppercase|smallcaps|style|sprite|link|align|indent|margin|pos|rotate|space|width)(?:=[^>]*)?>/gi;
  const plainText = (t) => String(t ?? '').replace(RICH_TAG, '');
  // the colour names Unity's text understands, as the game draws them (CSS's own "green" is much darker)
  const TMP_COLORS = { black: '#000000', blue: '#0000ff', green: '#00ff00', orange: '#ff8000', purple: '#a020f0', red: '#ff0000', white: '#ffffff', yellow: '#ffff00' };
  // as elements: the formatting it asks for (colours checked, nothing else interpreted), unknown tags dropped
  function richText(t) {
    const out = [], stack = [];
    const style = () => Object.assign({}, ...stack.map((x) => x.style));
    let last = 0;
    const text = (str) => { if (str) out.push(stack.length ? el('span', { style: style(), text: str }) : str); };
    for (const m of String(t ?? '').matchAll(RICH_TAG)) {
      text(t.slice(last, m.index));
      last = m.index + m[0].length;
      const tag = m[0].toLowerCase(), close = tag[1] === '/', name = tag.replace(/^<\/?|(=.*)?>$/g, '');
      if (close) { const i = stack.map((x) => x.name).lastIndexOf(name); if (i >= 0) stack.splice(i, 1); continue; }
      const arg = (m[0].match(/=\s*"?([^">]*)"?>$/) || [])[1]?.trim() || '';
      const st = name === 'color' && (/^#[0-9a-f]{3,8}$/i.test(arg) || TMP_COLORS[arg.toLowerCase()]) ? { color: TMP_COLORS[arg.toLowerCase()] || arg }
        : name === 'b' ? { fontWeight: '700' } : name === 'i' ? { fontStyle: 'italic' } : name === 'u' ? { textDecoration: 'underline' }
          : name === 's' ? { textDecoration: 'line-through' } : name === 'mark' ? { background: /^#[0-9a-f]{3,8}$/i.test(arg) ? arg : 'rgb(255 230 0 / 0.35)', borderRadius: '3px', padding: '0 2px' } : null;
      if (st) stack.push({ name, style: st });
    }
    text(String(t ?? '').slice(last));
    return out;
  }

  // ---- item index helpers (world.items: {prefab: {c, built, kept, at, on, tomb, crafted, q, shown}})
  // kept: units in player-built chests — nobody's in particular, whoever built the chest; at / on / tomb: [[x, z, n]] per
  // 64 m zone of chests / item & armor stands / tombstones. Who an item counts for: its crafter, or whoever first picked it up or looted it (FOUND).
  const ITEMS = () => S.data.world?.items || {};
  // First pickups and world-chest loot per item: {item: Map(player -> n)}, all time, from the server plugin's events
  let FOUND = null;
  const found = () => {
    if (FOUND?.gen !== S.data.generated) {
      FOUND = { gen: S.data.generated, by: new Map() };
      for (const [, p, e, i, n] of S.data.gather || []) {
        if (e !== 'pick' && e !== 'loot') continue;
        const m = FOUND.by.get(i) || FOUND.by.set(i, new Map()).get(i);
        const r = m.get(p) || m.set(p, { pick: 0, loot: 0 }).get(p);
        r[e] += n;
      }
    }
    return FOUND.by;
  };
  // a tombstone's contents ([[item, units, quality]]) as one line, the first `max` kinds
  const tombText = (inv, max = 99) => inv.slice(0, max).map(([i, n, q]) => `${n > 1 ? `${nf(n)}× ` : ''}${itemName(i)}${q > 1 ? ` ★${q}` : ''}`).join(', ') + (inv.length > max ? ` and ${plural(inv.length - max, 'more kind')}` : '');
  const foundBy = (name) => [...(found().get(name) || [])].map(([k, r]) => ({ k, v: r.pick + r.loot, ...r })).sort((a, b) => b.v - a.v);
  const foundOf = (p) => [...found()].filter(([, m]) => m.has(p)).map(([name, m]) => ({ name, it: ITEMS()[name] || {}, ...m.get(p), n: m.get(p).pick + m.get(p).loot }));
  const total = (o) => Object.values(o || {}).reduce((n, v) => n + v, 0);
  const catLabel = (c) => (c === 'pieces' ? 'Building pieces' : c ? c[0].toUpperCase() + c.slice(1) : 'Other');
  const catHref = (c) => `#/items?cat=${encodeURIComponent(c || 'other')}`;
  const qualityText = (q) => Object.entries(q || {}).map(([lvl, n]) => `★${lvl}${n > 1 ? ` ×${nf(n)}` : ''}`).join('  ');
  const whoLink = (p) => (S.color.has(p) ? playerLink(p) : el('span', { class: 'who', text: p }));
  const whoColor = (k) => (S.color.has(k) ? colorOf(k) : 'var(--other)');
  const noWorld = (title) => [...subHead(title, null, true), el('div', { class: 'card', style: { marginTop: '16px' } },
    el('div', { class: 'empty-state', text: 'No world snapshot yet — the first one is taken within the hour.' }))];
  // [{name, it, n}] of items where field[p] > 0
  const itemsWhere = (field, p) => Object.entries(ITEMS()).filter(([, it]) => it[field]?.[p]).map(([name, it]) => ({ name, it, n: it[field][p] }));
  const itemRow = (r, cells) => el('tr', { class: 'click', tabindex: '0', onclick: () => { location.hash = itemHref(r.name); },
    onkeydown: (e) => { if (e.key === 'Enter') location.hash = itemHref(r.name); } }, cells);
  const itemCell = (name) => el('td', null, el('a', { class: 'plain', href: itemHref(name), text: itemName(name), onclick: (e) => e.stopPropagation() }));
  const catCell = (c) => el('td', null, el('a', { class: 'hint plain', href: catHref(c), text: catLabel(c), onclick: (e) => e.stopPropagation() }));
  // Category breakdown as tags linking to the filtered catalogue.
  function catTags(list) {
    const by = new Map();
    for (const r of list) by.set(r.it.c, (by.get(r.it.c) || 0) + r.n);
    return el('div', { class: 'tags' }, [...by].sort((a, b) => b[1] - a[1]).map(([c, n]) =>
      el('a', { class: 'tag link', href: catHref(c) }, catLabel(c), el('b', { text: ` ${nf(n)}` }))));
  }

  // ---- per-player gear & base (snapshot)
  // data.equipment: {name: {t, online, slots: {slot: {item, q?, v?}}}} from the ValheimGamestats
  // plugin over RCON — what other players see them wearing, so no inventory and no crafter.
  // Drawn as a paper doll facing the viewer (their right hand is on the left); icons are the
  // game's own, extracted by tools/extract_gamedata.py and served from the PVC under /icons/.
  const DOLL = {  // slot: [label, box x, box y, anchor on the figure]
    helmet: ['Helmet', 40, 16, [300, 52]], shoulder: ['Cape', 40, 106, [266, 104]],
    right: ['Right hand', 40, 196, [230, 206]], legs: ['Legs', 40, 286, [288, 286]],
    trinket: ['Trinket', 500, 16, [300, 92]], chest: ['Chest', 500, 106, [324, 142]],
    left: ['Left hand', 500, 196, [370, 206]], utility: ['Utility', 500, 286, [314, 200]],
    rightBack: ['On the back', 226, 386, null], leftBack: ['On the back', 314, 386, null],
  };
  const BOX = 60;
  // The rendered figure (tools/render_looks.py, front view: their right hand on the viewer's left) sits in
  // FIG within the doll; slot anchors on it as fractions of the image.
  const FIG = { x: 162, y: 6, w: 275, h: 370 };
  const FIG_AT = { helmet: [0.5, 0.04], trinket: [0.5, 0.155], shoulder: [0.35, 0.2], chest: [0.58, 0.28],
    right: [0.07, 0.53], left: [0.93, 0.53], utility: [0.58, 0.43], legs: [0.44, 0.68] };
  const figAnchor = (k) => (FIG_AT[k] ? [FIG.x + FIG_AT[k][0] * FIG.w, FIG.y + FIG_AT[k][1] * FIG.h] : null);
  // name of a hair/beard item ("Top Braid"); none for the bald / clean-shaven choice
  const lookName = (k) => (k && !/None$/.test(k) ? S.lk?.styles?.[k] || GD()[k]?.name || pretty(k) : null);
  // The figure as layers, tinted like the game's shader does (_SkinColor): skin × skin colour, hair and beard × hair colour
  // [defs, layers] placed at x, y, w × h; uid keeps the filter ids apart when several figures share a page
  function lookLayers(look, uid, x, y, w, h) {
    const m = look.m === 1 ? 1 : 0;
    const url = (f) => `icons/valheim/looks/${encodeURIComponent(f)}.png`;
    const tint = (id, [r, g, b]) => sv('filter', { id, 'color-interpolation-filters': 'sRGB' },
      sv('feColorMatrix', { type: 'matrix', values: `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0` }));
    const layer = (file, filter) => sv('image', { href: url(file), x, y, width: w, height: h, filter: filter ? `url(#${filter}-${uid})` : null });
    const styles = S.lk?.styles || {};
    return [sv('defs', null, tint(`skin-${uid}`, look.skin || [1, 1, 1]), tint(`hair-${uid}`, look.hair || [1, 1, 1])),
      sv('g', { class: 'doll-look' },
        layer(`body${m}`, 'skin'), layer(`body${m}_wear`),
        look.b && styles[look.b] ? layer(`${look.b}_${m}`, 'hair') : null,
        look.h && styles[look.h] ? layer(`${look.h}_${m}`, 'hair') : null)];
  }
  function lookFigure(svg, look, uid) { svg.append(...lookLayers(look, uid, FIG.x, FIG.y, FIG.w, FIG.h)); }
  // Player avatar: head and shoulders of their figure on their colour; null without look data (plugin 1.9.0+)
  // prefix keeps the figure's svg ids apart when it is on the page twice (player page + sidebar)
  function lookAvatar(p, cls = 'avatar avatar-look', prefix = 'av') {
    const look = S.lk && S.data.equipment?.[p]?.look;
    if (!look) return null;
    const [w, h] = S.lk.size;
    return sv('svg', { class: cls, viewBox: `${w * 0.35} ${h * 0.004} ${w * 0.3} ${w * 0.3}`, role: 'img', 'aria-label': p, style: { background: colorOf(p) } },
      ...lookLayers(look, `${prefix}${hashStr(p) >>> 0}`, 0, 0, w, h));
  }
  const iconUrl = (s) => `icons/valheim/${encodeURIComponent(s.item)}${s.v ? `__${s.v}` : ''}.png`;
  // Tooltip of one worn item: the stats at the quality they wear. The game only syncs quality
  // for hand, back and cape items (s.q). For armor, utility and trinket the collector takes the
  // level from their newest tombstone (s.lq, as of s.lt); without one it shows the ★1–★max range.
  const wornQ = (s) => s.q ?? s.lq;
  function equipTip(s, label) {
    const g = GD()[s.item], q = wornQ(s);
    const out = [el('div', { class: 't', text: itemName(s.item) }),
      tRow(null, label, s.q != null ? `quality ${s.q}` : s.lq != null ? `quality ${s.lq} at last death` : null)];
    if (!g) return out;
    if (s.q == null && s.lq != null && g.maxQ > 1) {
      out.push(el('div', { class: 'note', text: `The game doesn't share this slot's level; ★${s.lq} is from their tombstone on ${fDateTime(s.lt)} — upgraded since? Then it's higher.` }));
    } else if (q == null && g.maxQ > 1) {
      out.push(el('div', { class: 'note', text: `The game doesn't share this slot's level, and they haven't died in it yet — ★1–★${g.maxQ} shown` }));
    }
    for (const [lbl, f, dg] of qualityRows(g)) {
      out.push(tRow(null, q != null || g.maxQ === 1 ? nq(f(Math.min(q || 1, g.maxQ)), dg) : `${nq(f(1), dg)}–${nq(f(g.maxQ), dg)}`, lbl));
    }
    for (const [lbl, v] of fixedRows(g, true)) out.push(tRow(null, v, lbl));
    for (const [title, se] of itemEffects(g)) {
      out.push(el('div', { class: 'note', text: `${se.name || title} · ${title.toLowerCase()}` }));
      for (const [lbl, v] of effectRows(se)) out.push(tRow(null, v, lbl));
    }
    if (hasItemPage(s.item)) out.push(el('div', { class: 'note', text: 'Click for the item page' }));
    return out;
  }
  function playerEquipment(p) {
    const e = S.data.equipment?.[p];
    // nothing worn still shows the figure (and the empty slots) when we know how they look
    if (!e || (!Object.keys(e.slots || {}).length && !(S.lk && e.look))) return null;
    const svg = sv('svg', { class: 'doll', viewBox: '0 0 600 470', role: 'img', 'aria-label': `${p}'s equipment` });
    const look = S.lk && e.look ? e.look : null;
    if (look) lookFigure(svg, look, hashStr(p) >>> 0);
    else {
      // no look data (plugin before 1.9.0, or no rendered layers): the plain figure — head, torso, arms, legs
      svg.append(sv('g', { class: 'doll-figure' },
        sv('circle', { cx: 300, cy: 62, r: 25 }),
        sv('path', { d: 'M262 98 Q300 86 338 98 L352 200 Q300 214 248 200 Z' }),
        sv('path', { class: 'limb', d: 'M266 106 Q244 150 230 206' }), sv('path', { class: 'limb', d: 'M334 106 Q356 150 370 206' }),
        sv('path', { class: 'limb', d: 'M284 206 L278 340' }), sv('path', { class: 'limb', d: 'M316 206 L322 340' })));
    }
    for (const [k, [label, x, y, plainAnchor]] of Object.entries(DOLL)) {
      const s = e.slots[k];
      const anchor = look ? figAnchor(k) : plainAnchor;
      if (anchor) {
        const ax = x < 300 ? x + BOX : x;
        svg.append(sv('path', { class: `doll-link${s ? '' : ' empty'}`, d: `M${ax} ${y + BOX / 2} L${(ax + anchor[0]) / 2} ${y + BOX / 2} L${anchor[0]} ${anchor[1]}` }));
        svg.append(sv('circle', { class: `doll-dot${s ? '' : ' empty'}`, cx: anchor[0], cy: anchor[1], r: 3 }));
      }
      const g = sv('g', { class: `doll-slot${s ? '' : ' empty'}`, tabindex: s ? '0' : null },
        sv('rect', { x, y, width: BOX, height: BOX, rx: 10 }),
        sv('text', { class: 'doll-label', x: x + BOX / 2, y: y + BOX + 15, 'text-anchor': 'middle', text: label }));
      if (s) {
        const img = sv('image', { href: iconUrl(s), x: x + 4, y: y + 4, width: BOX - 8, height: BOX - 8 });
        img.addEventListener('error', () => img.replaceWith(sv('text', { class: 'doll-missing', x: x + BOX / 2, y: y + BOX / 2 + 4, 'text-anchor': 'middle', text: '?' })));
        g.append(img);
        const q = wornQ(s);
        if (q > 1 || (q === 1 && s.q == null)) {
          g.append(sv('text', { class: `doll-q${s.q == null ? ' doll-q-death' : ''}`, x: x + BOX - 6, y: y + BOX - 6, 'text-anchor': 'end', text: `★${q}` }));
        }
        g.append(sv('title', { text: `${label}: ${itemName(s.item)}${s.q != null ? ` · quality ${s.q}` : s.lq != null ? ` · quality ${s.lq} at last death` : ''}` }));
        const show = (ev) => tip(ev, ...equipTip(s, label));
        g.addEventListener('pointerenter', show);
        g.addEventListener('focus', show);
        g.addEventListener('pointerleave', untip);
        g.addEventListener('blur', untip);
        if (hasItemPage(s.item)) {
          g.classList.add('link');
          g.addEventListener('click', () => { untip(); location.hash = itemHref(s.item); });
          g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') location.hash = itemHref(s.item); });
        }
      }
      svg.append(g);
    }
    const looks = look ? [lookName(look.h) ? `${lookName(look.h)} hair` : 'bald', look.m !== 1 ? (lookName(look.b) ? `${lookName(look.b)} beard` : 'clean-shaven') : null].filter(Boolean).join(' · ') : null;
    return card('Equipment', [e.online ? 'Wearing right now' : `Last seen wearing · ${fDateTime(e.t)}`, looks].filter(Boolean).join(' · '),
      el('div', { class: 'doll-wrap' }, svg), 'span-12');
  }

  // Gear history from data.equipment[p].usage: {slot: {item: {f, l, s, q?}}} — first/last worn,
  // seconds worn while online, best synced level. Aggregates only; the collector doesn't log every swap.
  const wornFor = (s) => (s < HOUR ? fDur(s) : fH(s));
  const ARMOR_SLOTS = [['helmet', 'Helmet'], ['chest', 'Chest'], ['legs', 'Legs'], ['shoulder', 'Cape'], ['utility', 'Utility'], ['trinket', 'Trinket']];
  const usageStart = () => Math.min(...Object.values(S.data.equipment || {}).flatMap((e) => Object.values(e.usage || {})
    .flatMap((items) => Object.values(items).map((u) => u.f))), Infinity);
  function playerEquipHistory(p) {
    const e = S.data.equipment?.[p], u = e?.usage;
    if (!u || !Object.keys(u).length) return null;
    const chip = (slot, item, x) => {
      const now = e.slots[slot]?.item === item;
      return el(hasItemPage(item) ? 'a' : 'span', { class: `gear-step${now ? ' now' : ''}`, href: hasItemPage(item) ? itemHref(item) : null,
        title: `${itemName(item)} · first worn ${fDateTime(x.f)} · last ${fDateTime(x.l)} · worn ${wornFor(x.s)}${x.q ? ` · up to ★${x.q}` : ''}` },
        itemIcon(item, 'gear-ico'),
        el('span', { class: 'gear-txt' }, el('b', { text: itemName(item) }), el('span', { class: 'hint', text: `${now ? 'wearing now' : `since ${fDate(x.f)}`} · ${wornFor(x.s)}` })));
    };
    const rows = ARMOR_SLOTS.filter(([k]) => u[k]).map(([k, label]) => {
      const steps = Object.entries(u[k]).sort((a, b) => a[1].f - b[1].f);
      return el('div', { class: 'gear-row' }, el('span', { class: 'gear-slot', text: label }),
        el('div', { class: 'gear-steps' }, steps.flatMap(([item, x], i) => [i ? el('span', { class: 'gear-arrow', 'aria-hidden': 'true', text: '→' }) : null, chip(k, item, x)])));
    });
    // weapons and shields: time actually held (back slots are just carried)
    const held = new Map();
    for (const k of ['right', 'left']) for (const [item, x] of Object.entries(u[k] || {})) held.set(item, (held.get(item) || 0) + x.s);
    const top = [...held].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const max = Math.max(1, ...top.map(([, v]) => v));
    const weapons = top.length ? el('div', { class: 'gear-held' }, top.map(([item, v]) => el('div', { class: 'gear-hbar' },
      itemIcon(item, 'gear-ico sm'),
      hasItemPage(item) ? el('a', { class: 'plain name', href: itemHref(item), text: itemName(item) }) : el('span', { class: 'name', text: itemName(item) }),
      el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: `${(v / max) * 100}%`, background: colorOf(p) } })),
      el('span', { class: 'v', text: wornFor(v) })))) : null;
    return card('Gear history', `In order of first use · time worn while online · tracked since ${fDate(usageStart())}`, el('div', { class: 'gear-hist' },
      rows.length ? el('div', null, el('h3', { text: 'Armor & accessories' }), rows) : null,
      weapons ? el('div', null, el('h3', { text: 'Most used weapons & shields' }), weapons) : null), 'span-12');
  }
  // who wore an item, from everyone's gear history (item page)
  // ---- where gear went (plugin Custody.cs): data.custody = [[item, crafter, quality, [[t, player, event, kind, x, z, n]]]],
  // one entry per copy (crafter + quality is all that tells copies apart), moves oldest first
  const HOLDING = new Set(['take', 'off', 'carry']);  // after these the player has it; after put / on it is back in a place
  const KIND_NAME = { chest: 'a chest', 'world chest': 'a world chest', tombstone: 'a tombstone', stand: 'a stand', ground: 'the ground' };
  const moveVerb = (e, k) => ({ take: `took it from ${KIND_NAME[k] || k}`, put: `put it in ${KIND_NAME[k] || k}`, off: 'took it off a stand',
    on: 'put it on a stand', carry: 'picked it up from the ground' }[e] || e);
  const copyName = (i, c, q) => `${itemName(i)}${q > 1 ? ` ★${q}` : ''}${c ? ` · made by ${c}` : ''}`;
  const placeLink = (x, z, label) => el('a', { class: 'plain', href: mapHref(x, z, 6, label), text: placeName(x, z) });
  function moveLine([t, p, e, k, x, z], label) {
    return el('div', { class: 'note' }, `${fAgo(S.data.generated - t)} · `, whoLink(p), ` ${moveVerb(e, k)} at `, placeLink(x, z, label));
  }
  function custodyCard(name) {
    const copies = (S.data.custody || []).filter((c) => c[0] === name).sort((a, b) => b[3][b[3].length - 1][0] - a[3][a[3].length - 1][0]);
    if (!copies.length) return null;
    return card('Who has it', 'Every time a copy left or went into a chest or stand, or was picked up — inventories never reach the server, so “has it” means took it and hasn’t put it back · copies told apart by crafter & quality',
      el('div', { class: 'stack' }, copies.map(([i, c, q, ev]) => {
        const last = ev[ev.length - 1], [t, p, e, k, x, z] = last, label = copyName(i, c, q);
        const status = HOLDING.has(e)
          ? el('div', null, el('span', { class: 'tag warn' }, '🎒 with ', whoLink(p)), el('span', { class: 'hint', text: ` since ${fAgo(S.data.generated - t)} · ${moveVerb(e, k)} at ` }), placeLink(x, z, label))
          : el('div', null, el('span', { class: 'tag' }, e === 'on' ? '🛡 on a stand' : `📦 in ${KIND_NAME[k] || k}`), el('span', { class: 'hint', text: ' at ' }), placeLink(x, z, label),
            el('span', { class: 'hint' }, ` · ${p} put it there ${fAgo(S.data.generated - t)}`));
        return el('div', null, el('h3', { text: label }), status, ...ev.slice(-6, -1).reverse().map((m) => moveLine(m, label)));
      })), 'span-12');
  }
  // the copies a player took last and hasn't put back
  const carriedBy = (p) => (S.data.custody || []).filter(([, , , ev]) => { const l = ev[ev.length - 1]; return l[1] === p && HOLDING.has(l[2]); });

  function wornByCard(name) {
    const rows = Object.entries(S.data.equipment || {}).map(([p, e]) => ({
      k: p, v: Object.entries(e.usage || {}).filter(([slot]) => slot !== 'rightBack' && slot !== 'leftBack')
        .reduce((n, [, items]) => n + (items[name]?.s || 0), 0) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    return rows.length ? card('Worn by', `Time worn or held while online · tracked since ${fDate(usageStart())}`, hbars(rows, wornFor, whoColor, true), 'span-6') : null;
  }

  function playerGear(p) {
    const w = S.data.world;
    if (!w) return [];
    const crafted = itemsWhere('crafted', p);
    const built = itemsWhere('built', p);
    const got = foundOf(p);
    const shown = itemsWhere('shown', p);
    const beds = w.beds[p] || 0, tomb = w.tombstones[p] || 0, chests = w.chests?.[p] || 0;
    const carried = carriedBy(p);
    if (!crafted.length && !built.length && !got.length && !shown.length && !beds && !tomb && !chests && !carried.length) return [];
    const note = `${snapNote()} · current state`;
    const out = [];

    const st1 = { key: 'n', asc: false, q: '', limit: 15 };
    const cr = crafted.map((r) => ({ ...r, cat: catLabel(r.it.c), pretty: itemName(r.name), _search: `${r.name} ${itemName(r.name)} ${catLabel(r.it.c)}`.toLowerCase() }));
    const t1 = sortableTable([{ label: 'Item', key: 'pretty' }, { label: 'Category', key: 'cat' }, { label: 'Crafted', key: 'n', r: true },
      { label: 'Quality', key: null }, { label: 'Kept at', key: null }], cr, st1, (r) => itemRow(r, [
      itemCell(r.name), catCell(r.it.c), el('td', { class: 'r', text: nf(r.n) }), el('td', { class: 'hint', text: qualityText(r.it.q?.[p]) }),
      el('td', { class: 'hint', text: (r.it.at || []).slice(0, 2).map(([x, z]) => placeName(x, z)).join(' · ') + ((r.it.at || []).length > 2 ? ' …' : '') })]), 'Nothing matches.');
    out.push(withId(card(`Crafted by ${p}`, `${plural(crafted.length, 'kind')} of items that still exist in a chest · ${note}`,
      crafted.length ? el('div', null, catTags(crafted), el('div', { style: { height: '10px' } }), t1.table) : el('div', { class: 'empty-state', text: 'None of their crafted items are in a chest right now.' }),
      'span-12', crafted.length ? t1.search : null), 'crafted'));

    out.push(card(`Built by ${p}`, `${nf(total(Object.fromEntries(built.map((r) => [r.name, r.n]))))} pieces of ${plural(built.length, 'kind')} standing`,
      built.length ? tags(built.sort((a, b) => b.n - a.n).map((r) => [r.name, r.n]), '') : el('div', { class: 'empty-state', text: 'Nothing built yet.' }), 'span-7'));

    if (carried.length) out.push(withId(card('Carrying', 'Gear they took and haven’t put back in a chest or on a stand since · from the server plugin', el('div', { class: 'stack' },
      carried.map(([i, c, q, ev]) => { const [t, , e, k, x, z] = ev[ev.length - 1];
        return el('div', null, el('a', { class: 'tag link', href: itemHref(i) }, copyName(i, c, q)),
          el('span', { class: 'hint', text: ` · ${moveVerb(e, k)} at ` }), placeLink(x, z, copyName(i, c, q)), el('span', { class: 'hint', text: ` · ${fAgo(S.data.generated - t)}` })); })),
      'span-12'), 'carrying'));
    const graves = (w.map?.tombs || []).filter((t) => t[0] === p);
    if (graves.length) out.push(withId(card('Tombstones', `${plural(graves.length, 'tombstone')} not recovered yet, oldest first · what they dropped · ${snapNote()}`,
      el('div', { class: 'stack' }, graves.map(([, x, z, died, inv]) => el('div', null,
        el('h3', null, el('a', { class: 'plain', href: mapHref(x, z, 6, `${p}'s tombstone`), text: `☠ ${placeName(x, z)}` }),
          el('span', { class: 'hint', text: ` · ${died != null ? `died on day ${nf(petDay(died))} · ` : ''}${plural((inv || []).reduce((n, it) => n + it[1], 0), 'item')}` })),
        el('div', { class: 'tags' }, (inv || []).map(([i, n, q]) => el('a', { class: 'tag link', href: itemHref(i), title: i }, itemName(i), q > 1 ? ` ★${q}` : null, n > 1 ? el('b', { text: ` ×${nf(n)}` }) : null)))))),
      'span-12'), 'tombstones'));

    out.push(card('Beds, stands & tombstones', null, el('div', { class: 'stack' },
      el('div', { class: 'tags' }, el('span', { class: 'tag' }, `🛏 ${plural(beds, 'bed')}`), el('span', { class: 'tag' }, `📦 ${plural(chests, 'chest')} built`),
        tomb ? el('span', { class: 'tag warn' }, `☠ ${plural(tomb, 'unrecovered tombstone')}`) : el('span', { class: 'tag' }, 'no lost tombstones')),
      el('div', null, el('h3', { text: 'On their item & armor stands' }), tags(shown.map((r) => [r.name, r.n]), 'Nothing on display.'))), 'span-5'));

    const st2 = { key: 'n', asc: false, q: '', limit: 15 };
    const fr = got.map((r) => ({ ...r, pretty: pretty(r.name), kept: r.it.kept || 0, _search: `${r.name} ${pretty(r.name)}`.toLowerCase() }));
    const t2 = sortableTable([{ label: 'Item', key: 'pretty' }, { label: 'Picked up', key: 'pick', r: true }, { label: 'Looted', key: 'loot', r: true },
      { label: 'In chests now', key: 'kept', r: true }], fr, st2, (r) => itemRow(r, [itemCell(r.name), el('td', { class: 'r', text: r.pick ? nf(r.pick) : '–' }),
        el('td', { class: 'r', text: r.loot ? nf(r.loot) : '–' }), el('td', { class: 'r hint', text: r.kept ? nf(r.kept) : '–' })]), 'Nothing matches.');
    out.push(withId(card(`Found by ${p}`, `${plural(got.length, 'kind')} of items they were the first to pick up or took from world chests · all time, since the server plugin logs it · “in chests now” is everyone’s`,
      got.length ? t2.table : el('div', { class: 'empty-state', text: 'Nothing found yet.' }), 'span-12', got.length ? t2.search : null), 'found'));
    return out;
  }

  // ---- item page: generic for any prefab in the index
  // Stats card: one column per quality when the item has several, then the fixed stats.
  function itemStatsCards(g) {
    const out = [], qs = Array.from({ length: g.maxQ }, (_, i) => i + 1), qr = qualityRows(g);
    if (qr.length && g.maxQ > 1) {
      out.push(card('Stats by quality', `★1 is crafted, every upgrade adds a level · up to ★${g.maxQ}`, el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Stat' }), qs.map((q) => el('th', { class: 'r', text: `★${q}` })))),
        el('tbody', null, qr.map(([label, f, dg]) => el('tr', null, el('td', { text: label }), qs.map((q) => el('td', { class: 'r', text: nq(f(q), dg) }))))))), 'span-7'));
    }
    const fixed = [...(g.maxQ > 1 ? [] : qr.map(([label, f, dg]) => [label, nq(f(1), dg)])), ...fixedRows(g)];
    out.push(card(g.maxQ > 1 ? 'Other stats' : 'Stats', ITEM_TYPE[g.type] || null, el('div', { class: 'kvs' },
      fixed.map(([label, v]) => el('div', { class: 'kv' }, el('span', { class: 'hint', text: label }), el('b', { text: v })))), g.maxQ > 1 && qr.length ? 'span-5' : 'span-12'));
    for (const [title, se] of itemEffects(g)) {
      out.push(card(se.name || title, `${title}${se.tooltip ? ` · ${se.tooltip}` : ''}`, el('div', { class: 'kvs' },
        effectRows(se).map(([label, v]) => el('div', { class: 'kv' }, el('span', { class: 'hint', text: label }), el('b', { text: v })))), 'span-6'));
    }
    return out;
  }

  // A creature: game stats (creatures.json, if extracted) and what the players did to it (plugin, in range).
  function creatureView(r) {
    const name = r.arg, info = CD()[name];
    const back = crumbs();
    const ofIt = (i) => i.split('*')[0] === name;
    const c = compute(S.a, S.b);
    const kills = new Map(), dealt = new Map(), stars = new Map(), withW = new Map(), dmgW = new Map();
    let first = null, last = null;
    for (const [t, p, e, i, n] of S.data.gather || []) {
      if ((e === 'kw' || e === 'dw') && t >= c.a && t < c.b) {  // "Weapon>Creature"
        const [w, mob] = i.split('>');
        if (mob && ofIt(mob)) (e === 'kw' ? withW : dmgW).set(w, ((e === 'kw' ? withW : dmgW).get(w) || 0) + n);
        continue;
      }
      if (!ofIt(i)) continue;
      if (e === 'kill') { first = Math.min(first ?? t, t); last = Math.max(last ?? t, t); }
      if (t < c.a || t >= c.b) continue;
      if (e === 'kill') {
        kills.set(p, (kills.get(p) || 0) + n);
        const s = starsOf(i);
        stars.set(s, (stars.get(s) || 0) + n);
      } else if (e === 'dmg') dealt.set(p, (dealt.get(p) || 0) + n);
    }
    const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
    const bars = (m) => hbars([...m].map(([k, v]) => ({ k, v: Math.round(v) })).sort((x, y) => y.v - x.v), (v) => nf(v), colorOf, true);
    const trophy = info?.trophy && GD()[info.trophy]?.icons ? itemIcon(info.trophy, 'avatar item-icon') : null;
    const head = el('div', { class: 'phead' },
      trophy || el('div', { class: 'avatar item-avatar', 'aria-hidden': 'true', text: gatherLabel(name)[0] }),
      el('div', null, el('h1', { text: gatherLabel(name) }),
        el('div', { class: 'meta' }, [info?.boss ? 'Boss' : 'Creature', info?.faction, name].filter(Boolean).join(' · ')),
        info?.desc ? el('p', { class: 'item-desc', text: info.desc }) : null));
    const dl = (pairs) => el('dl', { class: 'facts-dl' }, pairs.filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [el('dt', { text: k }), el('dd', null, v)]));
    const statsCard = info ? card('Stats', 'From the game files · health per star: ×2, ×3 …', dl([
      ['Health', info.hp != null ? nf(info.hp) : null],
      ['Health ★1 / ★2', info.hp != null ? `${nf(info.hp * 2)} / ${nf(info.hp * 3)}` : null],
      ['Faction', info.faction],
      ['Tameable', info.tame ? 'yes' : null],
      ['Weak to', info.weak?.join(', ')],
      ['Resistant to', info.resist?.join(', ')],
      ['Immune to', info.immune?.join(', ')],
    ]), 'span-6') : null;
    const attacks = info?.attacks?.length ? card('Attacks', 'Base damage per hit, before star and difficulty scaling', el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Attack' }), el('th', { class: 'r', text: 'Damage' }))),
      el('tbody', null, info.attacks.map((a) => el('tr', null, el('td', { text: a.name }), el('td', { class: 'r' }, a.dmg, a.note ? el('div', { class: 'hint', text: a.note }) : null)))))), 'span-6') : null;
    const drops = info?.drops?.length ? card('Drops', 'Per kill, before star bonuses', el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Item' }), el('th', { class: 'r', text: 'Amount' }), el('th', { class: 'r', text: 'Chance' }))),
      el('tbody', null, info.drops.map((x) => el('tr', null,
        el('td', null, hasItemPage(x.item) ? el('a', { class: 'plain', href: itemHref(x.item), text: itemName(x.item) }) : itemName(x.item)),
        el('td', { class: 'r', text: x.min === x.max ? nf(x.min) : `${nf(x.min)}–${nf(x.max)}` }),
        el('td', { class: 'r', text: pct(x.chance) })))))), 'span-6') : null;
    const total = sum(kills);
    // what sets it apart from an ordinary creature (extract_gamedata.py: Character / BaseAI fields)
    const sp = info?.special || {};
    const special = [
      sp.regen ? `Heals its full health in ${fDur(sp.regen)}${info.hp ? ` — about ${nf((info.hp / sp.regen) * 60)} health per minute` : ''}${info.boss ? ', so a long fight has to deal more than its health' : ''}` : null,
      sp.noStagger ? 'Can’t be staggered by damage' : null,
      sp.noBlockStagger ? 'Blocking its attacks doesn’t stagger it' : null,
      sp.flies ? 'Flies' : null,
      sp.tolerates ? `Unharmed by ${sp.tolerates.join(', ')}` : null,
      sp.hurtByWater ? 'Takes damage in water' : null,
      sp.afraidOfFire ? 'Afraid of fire' : null,
      sp.fleesAt ? `Flees below ${pct(sp.fleesAt)} health` : null,
      info?.saddle ? `Can be ridden once tamed and saddled (${itemName(info.saddle)})` : null,
    ].filter(Boolean);
    const spw = info?.spawns || [], fixed = info?.spawners || [];
    const points = fixed.filter((x) => x.kind !== 'nest'), nests = [...new Set(fixed.filter((x) => x.kind === 'nest').map((x) => nestName(x.src)))];
    const respawn = Math.min(...points.map((x) => x.respawn || Infinity));
    const whereCard = spw.length || fixed.length ? card('Where & when', 'From the game files: what roams a biome, plus fixed spawners', el('ul', { class: 'special-list' },
      spw.map((sp) => el('li', null, el('b', { text: sp.biomes.join(', ') }), ` — ${spawnText(sp)}`)),
      points.length ? el('li', { text: `At fixed spawn points in camps, villages and dungeons${Number.isFinite(respawn) ? ` (respawn after ${plural(respawn, 'minute')})` : ''}` }) : null,
      nests.length ? el('li', { text: `Spawned by: ${nests.join(', ')}` }) : null), 'span-6') : null;
    const specialCard = special.length ? card('Specialties', 'From the game files', el('ul', { class: 'special-list' }, special.map((t) => el('li', { text: t }))), 'span-6') : null;
    const fs = (S.data.fights || []).filter((f) => f.parts.includes(name) || f.boss === name);
    const fightCard = fs.length ? card('Fights', `${plural(fs.length, 'fight')} · ${nf(fs.filter((f) => f.outcome === 'killed').length)} won · all time`, fightsTable(fs, null, { key: 's', asc: false, q: '', limit: 10 }).table, 'span-12',
      el('a', { class: 'more-link', href: `#/bosses?boss=${encodeURIComponent(fs[0].boss)}`, text: 'All fights →' })) : null;
    return [
      back, head,
      kpiRow(
        kpi('Kills in range', nf(total), total ? `by ${plural(kills.size, 'player')}` : 'none in this range'),
        kpi('Damage dealt', nf(Math.round(sum(dealt))), 'health removed, in range'),
        kpi('Most stars', stars.size ? `★${Math.max(...stars.keys())}` : '–', stars.size ? 'killed in range' : null),
        info?.hp != null ? kpi('Health', nf(info.hp), info.boss ? 'boss' : 'at 0 stars') : null,
        kpi('Last killed', last ? fAgo(S.data.generated - last) : '–', first ? `first ${fDateY(first)}` : 'not yet, since the plugin started')),
      el('div', { class: 'grid' },
        fightCard, statsCard, specialCard, whereCard, attacks, drops,
        kills.size ? card('Killed by', 'Kills in range — everyone who hit it gets the kill', bars(kills), 'span-6') : null,
        dealt.size ? card('Damage dealt by', 'Health removed, in range', bars(dealt), 'span-6') : null,
        withW.size ? card('Killed with', 'What the killers held, in range', gatherBars(withW, () => 'var(--ink-2)', '', Infinity, 'item'), 'span-6') : null,
        dmgW.size ? card('Damage by weapon', 'Health removed, in range', gatherBars(dmgW, () => 'var(--ink-2)', '', 12, 'item'), 'span-6') : null,
        stars.size > 1 ? card('By stars', 'Kills in range per star level', hbars([...stars].sort((x, y) => x[0] - y[0]).map(([s, v]) => ({ k: s ? '★'.repeat(s) : 'no star', v })), (v) => nf(v), () => 'var(--ink-2)'), 'span-6') : null,
        !info && !total ? card('Nothing yet', null, el('div', { class: 'empty-state', text: 'No kills in this range and no game data for this creature.' }), 'span-12') : null),
    ];
  }

  // ------------------------------------------------------------------ boss fights (collector: fights.py)
  // One fight can be several creatures (Kall's phases, Zil & Thungr): names joined, health summed.
  // (Thungr's own name is already "Zil & Thungr": names inside another one are dropped)
  const fightName = (f) => {
    const names = [...new Set(f.parts.map((x) => gatherLabel(x)))];
    return names.filter((n) => !names.some((o) => o !== n && o.includes(n))).join(' & ') || gatherLabel(f.boss);
  };
  const fightHp = (f) => f.parts.reduce((n, x) => n + (CD()[x]?.hp || 0), 0);
  const fightHref = (f) => `#/fight/${encodeURIComponent(f.id)}`;
  const OUTCOME = { killed: '✔ Killed', retreat: '✘ Retreated', ongoing: '⚔ Ongoing' };
  const FIGHT_SPLIT = 'Damage per player is split by who attacked (plugin 1.5.0+)';
  const FIGHT_EVEN = 'Fought before plugin 1.5.0: each health drop was split evenly over everyone who had hit the boss, so the per-player damage is an estimate — the total is exact';
  const fightsIn = () => (S.data.fights || []).filter((f) => f.e >= S.a && f.s < S.b);
  const topWeapons = (w, n = 2) => Object.entries(w).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => gatherLabel(k)).join(', ');

  // All fights, or one player's (p: their damage and deaths instead of the totals).
  function fightsTable(fs, p, st = { key: 's', asc: false, q: '', limit: 50 }) {
    const rows = fs.map((f) => ({ ...f, name: fightName(f), dur: f.e - f.s, np: Object.keys(f.players).length,
      nd: p ? f.players[p]?.x || 0 : f.deaths.length, d: p ? f.players[p]?.d || 0 : f.dmg,
      _search: `${fightName(f)} ${f.outcome} ${Object.keys(f.players).join(' ')}`.toLowerCase() }));
    const open = (f) => { location.hash = fightHref(f); };
    return sortableTable([{ label: 'When', key: 's' }, { label: 'Boss', key: 'name' }, { label: 'Duration', key: 'dur', r: true },
      { label: 'Outcome', key: 'outcome' }, { label: 'Players', key: 'np', r: true },
      { label: p ? 'Their deaths' : 'Deaths', key: 'nd', r: true }, { label: p ? 'Their damage' : 'Damage', key: 'd', r: true }],
    rows, st, (f) => el('tr', { class: 'click', tabindex: '0', onclick: () => open(f), onkeydown: (e) => { if (e.key === 'Enter') open(f); } },
      el('td', null, el('a', { class: 'plain', href: fightHref(f), text: fDateTime(f.s) })),
      el('td', { text: f.name }), el('td', { class: 'r', text: fDur(f.dur) }), el('td', { text: OUTCOME[f.outcome] || f.outcome }),
      el('td', { class: 'r', text: nf(f.np), title: Object.keys(f.players).join(', ') }),
      el('td', { class: 'r', text: f.nd ? nf(f.nd) : '–' }), el('td', { class: 'r', text: nf(f.d) })),
    'No boss fights in this range.');
  }

  function bossesView(r) {
    const want = r.q?.get('boss');
    const all = fightsIn();
    const fs = want ? all.filter((f) => f.boss === want) : all;
    const kills = fs.filter((f) => f.outcome === 'killed');
    const per = new Map();
    for (const f of all) {
      const b = per.get(f.boss) || { boss: f.boss, name: fightName(f), n: 0, k: 0, deaths: 0, last: 0, fastest: null, _search: fightName(f).toLowerCase() };
      b.n += 1; b.deaths += f.deaths.length; b.last = Math.max(b.last, f.s);
      if (f.outcome === 'killed') { b.k += 1; b.fastest = Math.min(b.fastest ?? Infinity, f.e - f.s); }
      per.set(f.boss, b);
    }
    const goBoss = (b) => { location.hash = `#/bosses?boss=${encodeURIComponent(b.boss)}`; };
    const bt = sortableTable([{ label: 'Boss', key: 'name' }, { label: 'Fights', key: 'n', r: true }, { label: 'Kills', key: 'k', r: true },
      { label: 'Fastest kill', key: 'fastest', r: true }, { label: 'Deaths', key: 'deaths', r: true }, { label: 'Last fight', key: 'last', r: true }],
    [...per.values()], { key: 'last', asc: false, q: '', limit: 50 },
    (b) => el('tr', { class: 'click', tabindex: '0', 'aria-current': b.boss === want ? 'true' : null, onclick: () => goBoss(b), onkeydown: (e) => { if (e.key === 'Enter') goBoss(b); } },
      el('td', null, el('a', { class: 'plain', href: creatureHref(b.boss.replace('HildirBros', 'GoblinShaman_Hildir')), text: b.name, onclick: (e) => e.stopPropagation() })),
      el('td', { class: 'r', text: nf(b.n) }), el('td', { class: 'r', text: nf(b.k) }),
      el('td', { class: 'r', text: b.fastest != null ? fDur(b.fastest) : '–' }), el('td', { class: 'r', text: nf(b.deaths) }),
      el('td', { class: 'r', text: fAgo(S.data.generated - b.last) })), 'No boss fights in this range.');
    const who = new Map();
    for (const f of fs) for (const p of Object.keys(f.players)) who.set(p, (who.get(p) || 0) + 1);
    const { table, search } = fightsTable(fs);
    const title = want ? `${per.get(want)?.name || gatherLabel(want)} fights` : 'Boss fights';
    return [
      ...subHead(title, plural(fs.length, 'fight')),
      ...(want ? [el('a', { class: 'more-link', href: '#/bosses', text: '← All bosses' })] : []),
      kpiRow(
        kpi('Fights', nf(fs.length), `${nf(kills.length)} won · ${nf(fs.length - kills.length)} not`),
        kpi('Fastest kill', kills.length ? fDur(Math.min(...kills.map((f) => f.e - f.s))) : '–', kills.length ? fightName(kills.reduce((m, f) => (f.e - f.s < m.e - m.s ? f : m))) : null),
        kpi('Time fighting', fDur(fs.reduce((n, f) => n + f.e - f.s, 0)), null),
        kpi('Deaths', nf(fs.reduce((n, f) => n + f.deaths.length, 0)), 'while a fight lasted'),
        kpi('Damage dealt', nf(fs.reduce((n, f) => n + f.dmg, 0)), 'incl. what they healed')),
      el('div', { class: 'grid' },
        want ? null : card('By boss', 'Click a boss for its fights', bt.table, 'span-8'),
        card('Fighters', 'Fights they took part in', who.size ? hbars([...who].map(([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v), (v) => plural(v, 'fight'), colorOf, true)
          : el('div', { class: 'empty-state', text: 'Nobody fought a boss in this range.' }), want ? 'span-12' : 'span-4'),
        card('All fights', 'A fight ends when the boss dies or nobody hurts it for 15 min · only since the server plugin logs combat', table, 'span-12', search)),
    ];
  }

  function fightView(r) {
    const f = (S.data.fights || []).find((x) => x.id === r.arg);
    const back = crumbs();
    if (!f) return [back, el('div', { class: 'empty-state', text: 'No such fight.' })];
    const hp = fightHp(f), dur = f.e - f.s;
    const ps = Object.entries(f.players).map(([p, v]) => ({ p, ...v })).sort((x, y) => y.d - x.d);
    const info = CD()[f.boss] || CD()[f.parts[0]];
    const trophy = info?.trophy && GD()[info.trophy]?.icons ? itemIcon(info.trophy, 'avatar item-avatar') : null;
    const head = el('div', { class: 'phead' },
      trophy || el('div', { class: 'avatar item-avatar', 'aria-hidden': 'true', text: fightName(f)[0] }),
      el('div', null, el('h1', { text: fightName(f) }),
        el('div', { class: 'meta', text: `${fDateTime(f.s)} · ${fDur(dur)} · ${OUTCOME[f.outcome] || f.outcome}` })));
    // damage beyond the boss's health is what it healed back during the fight (BaseAI: full health per hour)
    const healed = f.outcome === 'killed' && hp && f.dmg > hp ? f.dmg - hp : 0;
    const weapons = new Map();
    for (const v of ps) for (const [w, n] of Object.entries(v.w)) weapons.set(w, (weapons.get(w) || 0) + n);
    const pt = el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['Player', 'Damage', 'Share', 'Weapons', 'Deaths', 'Damage taken', 'Kill'].map((h, i) => el('th', { class: i && i !== 3 ? 'r' : null, text: h })))),
      el('tbody', null, ps.map((v) => el('tr', null,
        el('td', null, playerLink(v.p)), el('td', { class: 'r', text: nf(v.d) }), el('td', { class: 'r', text: f.dmg ? pct(v.d / f.dmg) : '–' }),
        el('td', { text: topWeapons(v.w, 3) || '–' }), el('td', { class: 'r', text: v.x ? nf(v.x) : '–' }),
        el('td', { class: 'r', text: v.tk ? nf(v.tk) : '–' }), el('td', { class: 'r', text: v.k ? '✔' : '–' }))))));
    // one chip per death, in order: minutes into the fight, coloured by player
    const deaths = f.deaths.length ? el('div', { class: 'tags' }, f.deaths.map(([t, p]) =>
      el('span', { class: 'tag', title: `${p} · ${fTime(t)}` }, el('i', { class: 'sw', style: { background: colorOf(p) } }), ` +${fDur(Math.max(0, t - f.s))} ${p}`)))
      : el('div', { class: 'empty-state', text: 'Nobody died.' });
    const others = (S.data.fights || []).filter((x) => x.boss === f.boss);
    return [
      back, head,
      kpiRow(
        kpi('Outcome', OUTCOME[f.outcome] || f.outcome, f.outcome === 'retreat' ? 'nobody hurt it for 15 min' : null),
        kpi('Duration', fDur(dur), `${fTime(f.s)} – ${fTime(f.e)}`),
        kpi('Damage dealt', nf(f.dmg), healed ? `${nf(hp)} + ${nf(healed)} healed` : hp ? `of ${nf(hp)} health` : null),
        kpi('Deaths', nf(f.deaths.length), dur >= 600 && f.deaths.length ? `one every ${fDur(dur / f.deaths.length)}` : null),
        kpi('Players', nf(ps.length), others.length > 1 ? `fight ${others.indexOf(f) + 1} of ${others.length} against it` : 'the only fight against it')),
      el('div', { class: 'grid' },
        card('Damage by player', f.exact ? FIGHT_SPLIT : 'Estimate — see below', hbars(ps.map((v) => ({ k: v.p, v: v.d })), (v) => `${nf(v)} · ${f.dmg ? pct(v / f.dmg) : '–'}`, colorOf, true), 'span-6'),
        card('Damage by weapon', 'All players together', gatherBars(weapons, () => 'var(--ink-2)', 'No damage.', 12, 'item'), 'span-6'),
        card('Players', `Deaths and damage taken are from any source while the fight lasted · ${f.exact ? FIGHT_SPLIT : FIGHT_EVEN}`, pt, 'span-12'),
        card('Deaths', 'Players of this fight who died while it lasted · minutes into the fight', deaths, others.length > 1 ? 'span-6' : 'span-12'),
        others.length > 1 ? card(`All ${fightName(f)} fights`, null, fightsTable(others).table, 'span-6') : null),
    ];
  }

  // ------------------------------------------------------------------ pets (collector: pets.py, plugin: Pets.cs)
  const PET_STATUS = { alive: '● Alive', dead: '✝ Died', grew: '↑ Grew up', gone: '? Vanished' };
  const petName = (p) => p.n || gatherLabel(p.s);
  const rideable = (p) => !!CD()[p.s]?.saddle;  // Lox, Asksvin, Moose: the game data names their saddle
  const petKind = (p) => `${gatherLabel(p.s)}${p.lv ? ` ★${p.lv}` : ''}`;
  const worldNow = () => gameClock(Date.now() / 1000)?.worldTime;
  // seconds someone was online between two wall times — the world clock only runs then
  function onlineBetween(a, b) {
    const spans = S.data.sessions.map((s) => [Math.max(s.s, a), Math.min(s.e ?? b, b)]).filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0]);
    let on = 0, end = -Infinity;
    for (const [x, y] of spans) if (y > end) { on += y - Math.max(x, end); end = y; }
    return on;
  }
  // World clock (s) at a wall time. Sleeping jumps it forward, and every sleep is logged (data.days: the day slept
  // through, waking on the next morning): after the last sleep, count back from the live clock; before it, forward
  // from the last sleep before t.
  function worldAt(t) {
    const k = S.data?.clock, sl = S.data?.days || [], last = sl[sl.length - 1];
    if (k && (!last || t >= last.t)) return t >= k.t ? gameClock(t)?.worldTime ?? null : k.time - onlineBetween(t, k.t);
    const x = [...sl].reverse().find((d) => d.t < t);
    return x ? (x.d + 1 + MORNING) * DAY_LEN + onlineBetween(x.t, t) : null;  // before the first logged sleep: unknown
  }
  // young that grow up (Growup replaces them with a newly spawned adult) and those adults
  const PET_YOUNG = new Set(['Chicken', 'Boar_piggy', 'Wolf_cub', 'Lox_Calf', 'Asksvin_hatchling']);
  const PET_GROWN = new Set(['Hen', 'Boar', 'Wolf', 'Lox', 'Asksvin']);
  const petDay = (born) => Math.floor((born - MORNING * DAY_LEN) / DAY_LEN);
  const petAge = (p) => { const w = worldNow(); return w != null && p.born != null ? Math.max(0, (w - p.born) / DAY_LEN) : null; };
  // zone, biome and distance of a world position (zone x spans world x 64x-32 … 64x+32)
  function placeOf(x, z) {
    const zx = Math.floor((x + 32) / 64), zy = Math.floor((z + 32) / 64), sp = spawnZone();
    const zone = S.data.zones.find((q) => q.x === zx && q.y === zy);
    return `${zone ? `${biomeOf(zone)} · ` : ''}${nf(Math.hypot(zx - sp.x, zy - sp.y) * 64 / 1000, 1)} km from spawn`;
  }
  function deathCause(d) {
    const parts = [];
    if (d.by?.length) parts.push(`hit by ${d.by.join(', ')}`);
    if (d.near) parts.push(`probably ${gatherLabel(d.near)} (${nf(d.nd)} m away)`);
    return parts.join(' · ') || 'no creature nearby — fall, water, fire?';
  }

  const petHref = (p) => `#/pet/${encodeURIComponent(p.k)}`;
  // a damage source from Pets.cs: a player, "~creature" (nearest one around, a guess) or "?"
  const petSource = (s) => (s === '?' ? 'Unknown (fall, fire …)' : s.startsWith('~') ? `${gatherLabel(s.slice(1))} (guess)` : s);

  function petView(r) {
    const p = (S.data.pets || []).find((x) => x.k === r.arg);
    const back = crumbs();
    if (!p) return [back, el('div', { class: 'empty-state', text: 'No such pet.' })];
    const h = p.hist || [], hu = p.hurt;
    const lastH = h[h.length - 1];
    // health: the newer of the last save and the last logged minute
    const hpNow = lastH && lastH[0] > (p.last || 0) ? lastH[5] : (p.hp ?? p.max);
    const max = (lastH && lastH[6]) || p.max;
    const head = el('div', { class: 'phead' },
      el('div', { class: 'avatar item-avatar', 'aria-hidden': 'true', text: p.status === 'dead' ? '✝' : '🐾' }),
      el('div', null, el('h1', { text: petName(p) }),
        el('div', { class: 'meta', text: [petKind(p), PET_STATUS[p.status] || p.status, p.saddle ? '🐎 saddled' : rideable(p) ? 'rideable, no saddle' : null,
          p.by ? `named by ${p.by}` : null, p.f ? `follows ${p.f}` : null].filter(Boolean).join(' · ') })));
    const chart = chartHost();
    if (h.length) {
      const a = h[0][0] - 60, b = p.status === 'alive' ? Math.max(S.data.generated, lastH[0]) : lastH[0];
      // health at the end of each logged minute; before the first one, what it had before the damage
      const pts = [[a, Math.min(max || 0, (h[0][5] ?? 0) + h[0][1] - h[0][3])], ...h.map((x) => [x[0], x[5] ?? 0])];
      later(() => stepChart(chart, { a, b, pts, color: 'var(--s3)', fmtY: (v) => `${nf(v)} / ${nf(max)} health`, label: 'at the end of that minute', aria: 'Health over time' }));
    }
    const srcRows = hu ? Object.entries(hu.by).map(([k, v]) => ({ k: petSource(k), v, raw: k })).sort((x, y) => y.v - x.v) : [];
    const hist = h.length ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['When', 'Damage', 'Hits', 'Healed', 'Lowest', 'Health after', 'From'].map((t, i) => el('th', { class: i && i < 6 ? 'r' : null, text: t })))),
      el('tbody', null, [...h].reverse().slice(0, 200).map((x) => el('tr', null,
        el('td', { text: fDateTime(x[0]) }), el('td', { class: 'r', text: x[1] ? nf(x[1]) : '–' }), el('td', { class: 'r', text: x[2] ? nf(x[2]) : '–' }),
        el('td', { class: 'r', text: x[3] ? nf(x[3]) : '–' }), el('td', { class: 'r', text: x[4] != null ? nf(x[4]) : '–' }),
        el('td', { class: 'r', text: x[5] != null ? `${nf(x[5])} / ${nf(x[6])}` : '–' }),
        el('td', { class: 'hint', text: Object.keys(x[7]).map(petSource).join(', ') || '–' }))))))
      : el('div', { class: 'empty-state', text: `${p.status === 'alive' ? 'Nothing has happened to it yet' : 'Nothing was logged for it'} since health is logged (plugin 1.7.0). The world only runs near players — a pen nobody is near stands still.` });
    const d = p.death;
    // where it is (last save), or was and where it died; own map state per pet, so each opens zoomed to its own spot
    const mapHost = chartHost();
    const here = p.x != null ? [{ x: p.x, z: p.z, label: petName(p), style: p.status === 'alive' ? { fill: 'var(--s3)', stroke: 'var(--surface)' } : { fill: 'var(--surface)', stroke: 'var(--s3)' },
      tip: () => [el('div', { class: 't', text: `${petName(p)} · ${petKind(p)}` }),
        tRow('var(--s3)', p.status === 'alive' ? 'here at the last save' : 'last seen here', fDateTime(p.last)), el('div', { class: 'note', text: placeOf(p.x, p.z) })] }] : [];
    const grave = d?.x != null ? [{ x: d.x, z: d.z, label: '', style: { fill: 'var(--surface)', stroke: 'var(--critical)' },
      tip: () => [el('div', { class: 't', text: `✝ ${petName(p)}` }), tRow('var(--critical)', fDateTime(d.t), 'died'),
        el('div', { class: 'note', text: deathCause(d) }), el('div', { class: 'note', text: placeOf(d.x, d.z) })] }] : [];
    if (here.length || grave.length) {
      later(() => zoneMap(mapHost, compute(S.min, S.max), `pet:${p.k}`, [], { players: false, plain: true, marks: [...here, ...grave],
        legend: el('div', { class: 'hint', text: [here.length ? placeOf(p.x, p.z) : null, grave.length ? `red ring: where it died · ${placeOf(d.x, d.z)}` : null].filter(Boolean).join(' · ') }) }));
    }
    const mapTitle = p.status === 'alive' ? 'Where it is' : grave.length ? 'Where it died' : 'Where it was last seen';
    return [
      back, head,
      kpiRow(
        kpi('Status', PET_STATUS[p.status] || p.status, d ? fDateTime(d.t) : p.status === 'alive' ? `seen ${fAgo(S.data.generated - p.last)}` : null),
        p.status === 'alive' ? kpi('Health', max ? `${nf(hpNow ?? max)} / ${nf(max)}` : '–', lastH && lastH[0] > (p.last || 0) ? 'last logged minute' : 'as of the last save') : null,
        kpi('Damage taken', nf(hu?.dmg || 0), hu ? plural(hu.hits, 'hit') : 'since plugin 1.7.0'),
        kpi('Healed', nf(hu?.heal || 0), 'heals fully in 1 h'),
        kpi('Lowest', hu?.min != null ? nf(hu.min) : '–', hu?.min != null && max ? `${pct(hu.min / max)} of its health` : null),
        kpi('Age', petAge(p) != null ? `${nf(petAge(p), petAge(p) < 10 ? 1 : 0)} days` : '–', p.born != null ? `born on day ${nf(petDay(p.born))}` : null)),
      el('div', { class: 'grid' },
        here.length || grave.length ? card(mapTitle, p.status === 'alive' ? `Position at the last hourly save · ${fDateTime(p.last)}` : 'Last saved position and where it died', mapHost, 'span-12') : null,
        d ? card('Death', 'Logged the moment it happened', el('ul', { class: 'special-list' },
          el('li', { text: fDateTime(d.t) }), el('li', { text: deathCause(d) }), d.x != null ? el('li', { text: placeOf(d.x, d.z) }) : null), 'span-12') : null,
        h.length ? card('Health over time', 'Per minute with a change · steps down are damage, up is healing', chart, 'span-8') : null,
        srcRows.length ? card('Damage by source', 'A player who hit it, else the creature closest to it then',
          hbars(srcRows, (v) => nf(v), (k) => (srcRows.find((x) => x.k === k)?.raw.match(/^[~?]/) ? 'var(--ink-2)' : colorOf(k)),
            (i) => (i.raw.match(/^[~?]/) ? null : `#/p/${encodeURIComponent(i.raw)}`)), 'span-4') : null,
        card('History', `${plural(h.length, 'minute')} with a change${h.length > 200 ? ' · newest 200 shown' : ''}`, hist, 'span-12')),
    ];
  }

  function petsView() {
    const ps = S.data.pets || [];
    const alive = ps.filter((p) => p.status === 'alive'), dead = ps.filter((p) => p.status === 'dead'), gone = ps.filter((p) => p.status === 'gone');
    const species = new Set(alive.map((p) => gatherLabel(p.s)));
    const oldest = alive.filter((p) => p.born != null).sort((a, b) => a.born - b.born)[0];
    // map: one marker per group of pets within ~150 m (a base's pens and hen house), one per grave
    const herds = [];
    for (const p of alive) {
      const h = herds.find((g) => Math.hypot(g[0].x - p.x, g[0].z - p.z) <= 150);
      if (h) h.push(p); else herds.push([p]);
    }
    const marks = [
      ...herds.map((h) => {
        const kinds = new Map();
        for (const p of h) kinds.set(gatherLabel(p.s), (kinds.get(gatherLabel(p.s)) || 0) + 1);
        const label = kinds.size === 1 ? `${[...kinds.keys()][0]} ×${h.length}` : plural(h.length, 'pet');
        return { x: h.reduce((n, p) => n + p.x, 0) / h.length, z: h.reduce((n, p) => n + p.z, 0) / h.length, label,
          href: h.length === 1 ? petHref(h[0]) : null,
          style: { fill: 'var(--s3)', stroke: 'var(--surface)' },
          tip: () => [el('div', { class: 't', text: plural(h.length, 'pet') }), ...[...kinds].map(([k, n]) => tRow('var(--s3)', `${nf(n)} × ${k}`)),
            h.some((p) => p.n) ? el('div', { class: 'note', text: `Named: ${h.filter((p) => p.n).map((p) => p.n).join(', ')}` }) : null,
            h.some((p) => p.saddle) ? el('div', { class: 'note', text: `🐎 Saddled: ${h.filter((p) => p.saddle).map(petName).join(', ')}` }) : null,
            el('div', { class: 'note', text: placeOf(h[0].x, h[0].z) })] };
      }),
      // graves without a label: they are mostly at the bases, right next to a herd's; the tooltip has it all
      ...dead.filter((p) => p.death?.x != null).map((p) => ({ x: p.death.x, z: p.death.z, label: '', href: petHref(p),
        style: { fill: 'var(--surface)', stroke: 'var(--critical)' },
        tip: () => [el('div', { class: 't', text: `✝ ${petName(p)} · ${petKind(p)}` }), tRow('var(--critical)', fDateTime(p.death.t), 'died'),
          el('div', { class: 'note', text: deathCause(p.death) }), el('div', { class: 'note', text: placeOf(p.death.x, p.death.z) })] })),
    ];
    const mapHost = chartHost();
    later(() => zoneMap(mapHost, compute(S.min, S.max), 'pets', [], { players: false, plain: true, marks,
      legend: el('div', { class: 'legend' },
        el('span', { class: 'key' }, el('i', { class: 'pm on', style: { background: 'var(--s3)', borderColor: 'var(--s3)' } }), `Pets, grouped within ~150 m · ${HOVER} for who`),
        el('span', { class: 'key' }, el('i', { class: 'pm', style: { borderColor: 'var(--critical)' } }), 'Where one died')) }));

    const graves = [...dead.map((p) => ({ p, t: p.death.t, text: deathCause(p.death), where: p.death.x != null ? placeOf(p.death.x, p.death.z) : '' })),
      ...gone.map((p) => ({ p, t: p.gone, text: 'vanished between two hourly saves — died before deaths were logged', where: placeOf(p.x, p.z), vague: true }))]
      .sort((a, b) => b.t - a.t);
    const graveList = graves.length ? el('ul', { class: 'plain-list' }, graves.map((g) => el('li', null,
      el('a', { class: 'plain', href: petHref(g.p) }, el('b', { text: `✝ ${petName(g.p)}` })), el('span', { class: 'hint', text: ` · ${petKind(g.p)}` }), el('br'),
      el('span', { text: `${g.vague ? 'by ' : ''}${fDateTime(g.t)} · ${g.text}` }), g.where ? el('div', { class: 'hint', text: g.where }) : null)))
      : el('div', { class: 'empty-state', text: 'No pet has died yet.' });

    // filters over the table: status, named, species, saddled — counts are over all pets
    const F = S.petF;
    const keep = (p, skip) => (skip === 'status' || !F.status || p.status === F.status) && (skip === 'named' || !F.named || (F.named === 'yes') === !!p.n)
      && (skip === 'kind' || !F.kind || gatherLabel(p.s) === F.kind) && (skip === 'saddle' || !F.saddle || p.saddle);
    const fps = ps.filter((p) => keep(p));
    const count = (skip, fn) => ps.filter((p) => keep(p, skip) && fn(p)).length;
    const chipRow = (label, key, opts) => el('div', { class: 'ctl' }, el('span', { class: 'ctl-label', text: label }),
      el('div', { class: 'chips', role: 'group', 'aria-label': label }, opts.map(([v, t, n]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(F[key] === v),
        onclick: () => { F[key] = v; S.petSt.limit = 100; scheduleRender(); } }, n == null ? t : `${t} ${nf(n)}`))));
    const kinds = [...new Set(ps.map((p) => gatherLabel(p.s)))].sort();
    const filters = el('div', { class: 'map-controls' },
      chipRow('Status', 'status', [['', 'All', count('status', () => true)], ...['alive', 'dead', 'grew', 'gone'].filter((k) => ps.some((p) => p.status === k))
        .map((k) => [k, PET_STATUS[k].replace(/^\S+ /, ''), count('status', (p) => p.status === k)])]),
      chipRow('Name', 'named', [['', 'All', count('named', () => true)], ['yes', 'Named', count('named', (p) => !!p.n)], ['no', 'Unnamed', count('named', (p) => !p.n)]]),
      chipRow('Species', 'kind', [['', 'All', count('kind', () => true)], ...kinds.map((k) => [k, k, count('kind', (p) => gatherLabel(p.s) === k)])]),
      ps.some(rideable) ? chipRow('Saddle', 'saddle', [[false, 'Any', null], [true, '🐎 Saddled', count('saddle', (p) => p.saddle)]]) : null);
    const rows = fps.map((p) => ({ ...p, name: petName(p), kind: petKind(p), st: PET_STATUS[p.status] || p.status, age: petAge(p),
      hpv: p.status === 'alive' ? (p.hp ?? p.max ?? 0) / (p.max || 1) : -1, seen: p.death?.t ?? p.gone ?? p.last, taken: p.hurt?.dmg || 0,
      sad: p.saddle ? 2 : rideable(p) ? 1 : 0,
      _search: `${petName(p)} ${gatherLabel(p.s)} ${p.status} ${p.by || ''} ${p.f || ''}`.toLowerCase() }));
    const { table, search } = sortableTable([
      { label: 'Name', key: 'name' }, { label: 'Species', key: 'kind' }, { label: 'Status', key: 'st' }, { label: 'Health', key: 'hpv', r: true },
      { label: 'Damage taken', key: 'taken', r: true }, { label: 'Saddle', key: 'sad' },
      { label: 'Where', key: null }, { label: 'Follows', key: 'f' }, { label: 'Named by', key: 'by' }, { label: 'Age', key: 'age', r: true },
      { label: 'Last seen / died', key: 'seen', r: true }],
    rows, S.petSt, (p) => el('tr', null,
      el('td', null, el('a', { class: 'plain', href: petHref(p) }, p.n ? el('b', { text: p.n }) : el('span', { class: 'hint', text: 'unnamed' }))),
      el('td', null, el('a', { class: 'plain', href: creatureHref(p.s), text: p.kind })),
      el('td', { text: p.st }),
      el('td', { class: 'r', text: p.status === 'alive' ? `${nf(p.hp ?? p.max ?? 0)} / ${nf(p.max ?? 0)}` : '–' }),
      el('td', { class: 'r', text: p.taken ? nf(p.taken) : '–' }),
      el('td', { title: p.saddle ? 'Wears a saddle — can be ridden' : rideable(p) ? 'Can be ridden once saddled' : null, text: p.saddle ? '🐎 saddled' : rideable(p) ? '–' : '' }),
      el('td', { class: 'hint', text: placeOf(p.death?.x ?? p.x, p.death?.z ?? p.z) }),
      el('td', null, p.f ? playerLink(p.f) : '–'), el('td', null, p.by ? playerLink(p.by) : '–'),
      el('td', { class: 'r', title: p.born != null ? `born on day ${nf(petDay(p.born))}` : null, text: p.age != null ? `${nf(p.age, p.age < 10 ? 1 : 0)} days` : '–' }),
      el('td', { class: 'r', text: p.status === 'alive' ? fAgo(S.data.generated - p.last) : fDateTime(p.seen) })),
    'No pet matches.');

    // one log over all pets: every minute with damage or healing (plugin 1.7.0+) and every death, newest first
    const events = [
      ...ps.flatMap((p) => (p.hist || []).map(([t, dmg, hits, heal, min, hp, max, by]) => ({ t, p, kind: dmg ? 'Hurt' : 'Healed', dmg, hits, heal, min, hp, max,
        from: Object.keys(by).map(petSource).join(', ') }))),
      ...dead.map((p) => ({ t: p.death.t, p, kind: '✝ Died', from: deathCause(p.death) })),
    ].map((e) => ({ ...e, name: petName(e.p), _search: `${petName(e.p)} ${gatherLabel(e.p.s)} ${e.kind} ${e.from}`.toLowerCase() }));
    const log = sortableTable([
      { label: 'When', key: 't' }, { label: 'Pet', key: 'name' }, { label: 'What', key: 'kind' }, { label: 'Damage', key: 'dmg', r: true },
      { label: 'Healed', key: 'heal', r: true }, { label: 'Lowest', key: 'min', r: true }, { label: 'Health after', key: 'hp', r: true }, { label: 'From', key: 'from' }],
    events, { key: 't', asc: false, q: '', limit: 100 }, (e) => el('tr', null,
      el('td', { text: fDateTime(e.t) }),
      el('td', null, el('a', { class: 'plain', href: petHref(e.p), text: e.name }), el('span', { class: 'hint', text: ` · ${petKind(e.p)}` })),
      el('td', { text: e.kind }),
      el('td', { class: 'r', text: e.dmg ? `${nf(e.dmg)}${e.hits > 1 ? ` (${e.hits}×)` : ''}` : '–' }),
      el('td', { class: 'r', text: e.heal ? nf(e.heal) : '–' }), el('td', { class: 'r', text: e.min != null ? nf(e.min) : '–' }),
      el('td', { class: 'r', text: e.hp != null ? `${nf(e.hp)} / ${nf(e.max)}` : '–' }), el('td', { class: 'hint', text: e.from || '–' })),
    'Nothing logged yet — damage and healing are logged since plugin 1.7.0, while a player is near.');

    return [
      ...subHead('Pets', `${plural(alive.length, 'pet')} alive · ${nf(dead.length + gone.length)} gone`, true),
      kpiRow(
        kpi('Alive', nf(alive.length), plural(species.size, 'species', 'species')),
        kpi('Named', nf(alive.filter((p) => p.n).length), alive.filter((p) => p.n).map((p) => p.n).slice(0, 3).join(', ') || null),
        kpi('Died', nf(dead.length), gone.length ? `+ ${nf(gone.length)} vanished before deaths were logged` : 'since deaths are logged'),
        (() => { const r = alive.filter(rideable); return r.length ? kpi('Saddled', nf(r.filter((p) => p.saddle).length), `of ${plural(r.length, 'rideable pet')}`) : null; })(),
        kpi('Oldest', oldest ? petName(oldest) : '–', oldest ? `${oldest.n ? `${petKind(oldest)} · ` : oldest.lv ? `★${oldest.lv} · ` : ''}${nf(petAge(oldest) ?? 0)} days old` : null)),
      el('div', { class: 'grid' },
        card('Where they are', 'Living pets and where pets died · positions from the hourly world save', mapHost, 'span-12'),
        card('All pets', `${plural(fps.length, 'pet')}${fps.length !== ps.length ? ` of ${nf(ps.length)}` : ''} · age in in-game days · health as of the last save`,
          el('div', null, filters, table), 'span-12', search),
        card('Graveyard', 'Deaths are logged the moment they happen; the killer is the nearest hostile creature, a guess', graveList, 'span-12'),
        card('History', 'Every pet: each minute with damage or healing, and deaths · newest first', log.table, 'span-12', log.search)),
    ];
  }

  // ---- where and when creatures appear (extract_gamedata.py: the world's spawn lists, fixed spawners and nests)
  const camelWords = (x) => x.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const NEST_NAME = { GreydwarfNest: 'Greydwarf nest', DraugrPile: 'Body pile', BonePileSpawner: 'Bone pile', BonePileSpawner_swamp: 'Bone pile',
    CharredCross: 'Charred cross', CharredStone: 'Charred stone', CharredStone_Elite: 'Charred stone', CharredStone_event: 'Charred stone' };
  const nestName = (src) => { const k = src.replace(/^Spawner_/, ''); return NEST_NAME[k] || cap1(camelWords(k.replace(/_/g, ' '))); };
  const cap1 = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const spawnWhen = (sp) => (sp.day && sp.night ? 'day and night' : sp.night ? 'at night' : 'by day');
  function spawnText(sp) {  // "at night · groups of 2–3 · up to ★★ · in forests · once The Elder is defeated"
    return [spawnWhen(sp), sp.group[1] > 1 ? `groups of ${sp.group[0]}–${sp.group[1]}` : null, sp.stars ? `up to ${'★'.repeat(sp.stars)}` : null,
      ...(sp.where || []), sp.weather ? `only in ${sp.weather.map(camelWords).join(' / ')} weather` : null,
      sp.after ? `once ${sp.after} is defeated` : null].filter(Boolean).join(' · ');
  }
  // one line for a drop row: "Black Forest at night · Meadows at night after The Elder"
  const spawnShort = (c) => [...new Set((c?.spawns || []).map((sp) => `${sp.biomes.join('/')} ${spawnWhen(sp)}${sp.after ? ` after ${sp.after}` : ''}`))].join(' · ');
  function itemDropCards(name) {
    // one row per creature name: variants of a creature (e.g. a Deep North one) share it, their places merge
    const rows = new Map();
    for (const [k, c] of Object.entries(CD())) {
      const d = (c.drops || []).find((x) => x.item === name);
      if (!d) continue;
      const label = gatherLabel(k), r = rows.get(label);
      const found = spawnShort(c) || (c.spawners?.length ? 'at fixed spots (camps, dungeons, nests)' : c.boss ? 'summoned at its altar' : '');
      if (r) { if (found && !r.found.includes(found)) r.found.push(found); if (d.chance > r.d.chance) r.d = d; } else rows.set(label, { k, d, found: found ? [found] : [] });
    }
    const by = [...rows.values()].sort((a, b) => b.d.chance - a.d.chance || gatherLabel(a.k).localeCompare(gatherLabel(b.k)));
    if (!by.length) return [];
    return [card('Dropped by', 'Per kill, before star bonuses · where and when they appear — click for details', el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Creature' }), el('th', { class: 'r', text: 'Amount' }), el('th', { class: 'r', text: 'Chance' }), el('th', { text: 'Found' }))),
      el('tbody', null, by.map(({ k, d, found }) => el('tr', null,
        el('td', null, el('a', { class: 'plain', href: creatureHref(k), text: gatherLabel(k) })),
        el('td', { class: 'r', text: d.min === d.max ? nf(d.min) : `${nf(d.min)}–${nf(d.max)}` }),
        el('td', { class: 'r', text: pct(d.chance) }),
        el('td', { class: 'hint', style: { whiteSpace: 'normal' }, text: found.join(' · ') || '–' })))))), 'span-6')];
  }

  // Item page: how it is made and what it is for (extract_gamedata.py: recipes, build pieces, smelters & co.)
  function itemUseCards(g) {
    const link = (i) => (hasItemPage(i) ? el('a', { class: 'plain', href: itemHref(i), text: itemName(i) }) : itemName(i));
    const at = (st, lv) => (st ? `${st}${lv > 1 ? ` level ${lv}` : ''}` : 'by hand');
    const out = [];
    const made = [
      ...(g.recipes || []).map((rc) => el('div', null,
        el('div', { class: 'hint', text: `Crafted at ${at(rc.st, rc.lv)}${rc.n > 1 ? ` · makes ${rc.n}` : ''}` }),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, el('th', { text: 'Ingredient' }), el('th', { class: 'r', text: 'Craft' }), g.maxQ > 1 ? el('th', { class: 'r', text: 'Per upgrade' }) : null)),
          el('tbody', null, rc.res.map(([i, n, up]) => el('tr', null, el('td', null, link(i)),
            el('td', { class: 'r', text: n ? nf(n) : '–' }), g.maxQ > 1 ? el('td', { class: 'r', text: up ? nf(up) : '–' }) : null))))))),
      ...(g.from?.length ? [el('div', { class: 'hint', text: 'Made from' }), el('div', { class: 'tags' }, g.from.map((x) => el('span', { class: 'tag' }, link(x.i), ` at ${x.at}`)))] : []),
    ];
    if (made.length) out.push(card('How it’s made', 'From the game files', el('div', { class: 'stack' }, made), 'span-6'));
    const by = (k) => (g.uses || []).filter((u) => u.k === k);
    const list = (xs, fn, cap = 60) => el('div', { class: 'tags' }, xs.slice(0, cap).map(fn),
      xs.length > cap ? el('span', { class: 'hint', text: ` +${nf(xs.length - cap)} more` }) : null);
    const groups = [
      ['Crafting ingredient', by('craft'), (u) => el('span', { class: 'tag', title: `${u.n ? `${u.n} to craft` : ''}${u.up ? `${u.n ? ', ' : ''}${u.up} per upgrade` : ''}${u.st ? ` · ${u.st}` : ''}` },
        link(u.i), u.n ? ` ×${nf(u.n)}` : ` ×${nf(u.up)}/upgrade`)],
      ['Building material', by('build'), (u) => el('span', { class: 'tag', title: u.st ? `Built with the hammer near a ${u.st}` : null }, `${u.p} ×${nf(u.n)}`)],
      ['Turned into', by('convert'), (u) => el('span', { class: 'tag' }, link(u.i), ` at ${u.at}`)],
      ['Fuel for', by('fuel'), (u) => el('span', { class: 'tag', text: u.at })],
    ].filter(([, xs]) => xs.length);
    if (groups.length) out.push(card('Used for', `Every recipe, building piece and station that takes it · ${HOVER} for amounts`, el('div', { class: 'stack' },
      groups.flatMap(([title, xs, fn]) => [el('div', { class: 'hint', text: `${title} · ${nf(xs.length)}` }), list(xs, fn)])), 'span-6'));
    else if (g.type === 1) out.push(card('Used for', null, el('div', { class: 'empty-state', text: 'No recipe, building piece or station takes it.' }), 'span-6'));
    return out;
  }

  // Item page cards from the server plugin, for the range: who fought with it, who picked it up.
  function itemPluginCards(name) {
    if (!S.data.gather?.length) return [];
    const rows = compute(S.a, S.b).rows;
    const per = (key) => rows.map((x) => ({ k: x.p, v: Math.round(x.gathered?.[key]?.get(name) || 0) })).filter((x) => x.v).sort((x, y) => y.v - x.v);
    const dealt = per('wdealt'), kills = per('wkills'), picked = per('picked');
    // "Weapon>Creature" events: what this weapon killed / hurt
    const vs = (key) => {
      const m = new Map();
      for (const x of rows) for (const [i, n] of x.gathered?.[key] || []) {
        const [w, mob] = i.split('>');
        if (w === name && mob) m.set(mob, (m.get(mob) || 0) + n);
      }
      return m;
    };
    const kv = vs('kwc'), dv = vs('dwc');
    return [
      kv.size ? card('Kills by creature', 'What died while it was held, in range', gatherBars(kv, () => 'var(--ink-2)', '', Infinity, 'creature'), 'span-6') : null,
      dv.size ? card('Damage by creature', 'Health removed while it was held, in range', gatherBars(dv, () => 'var(--ink-2)', '', 12, 'creature'), 'span-6') : null,
      dealt.length ? card('Damage dealt with it', 'Health removed from creatures while held, in range', hbars(dealt, (v) => nf(v), colorOf, true), 'span-6') : null,
      kills.length ? card('Kills with it', 'Creatures that died while it was held, in range', hbars(kills, (v) => nf(v), colorOf, true), 'span-6') : null,
      picked.length ? card('Picked up by', 'Items picked up, in range', hbars(picked, (v) => nf(v), colorOf, true), 'span-6') : null,
    ];
  }

  // Where an item is kept: the zones whose chests hold the most of it, on a small map.
  function keptMap(name, at, on, tomb) {
    const host = el('div');
    later(() => zoneMap(host, compute(S.min, S.max), `item:${name}`, [], { players: false, plain: true,
      marks: at.map(([x, z, n]) => ({ x, z, label: nf(n), style: { fill: 'var(--accent)', stroke: 'var(--surface)' },
        tip: () => [el('div', { class: 't', text: `${nf(n)} × ${itemName(name)}` }), el('div', { class: 'note', text: `In chests at ${placeName(x, z)} · 64 m zone` })],
        href: mapHref(x, z, 6, `${itemName(name)}: ${nf(n)}`) })).concat(on.map(([x, z, n]) => ({ x, z, label: nf(n), style: { fill: 'var(--s2)', stroke: 'var(--surface)' },
        tip: () => [el('div', { class: 't', text: `${nf(n)} × ${itemName(name)}` }), el('div', { class: 'note', text: `On item & armor stands at ${placeName(x, z)} · 64 m zone` })],
        href: mapHref(x, z, 6, `${itemName(name)}: ${nf(n)} on display`) }))).concat(tomb.map(([x, z, n]) => ({ x, z, label: nf(n), style: { fill: 'var(--critical)', stroke: 'var(--surface)' },
        tip: () => [el('div', { class: 't', text: `${nf(n)} × ${itemName(name)}` }), el('div', { class: 'note', text: `In a tombstone at ${placeName(x, z)} · 64 m zone` })],
        href: mapHref(x, z, 6, `${itemName(name)}: ${nf(n)} in a tombstone`) }))) }));
    const list = (xs, what) => (xs.length ? `${what} ${xs.slice(0, 4).map(([x, z, n]) => `${nf(n)} at ${placeName(x, z)}`).join(' · ')}${xs.length > 4 ? ` and ${plural(xs.length - 4, 'more place')}` : ''}` : null);
    return card('Where it is', [list(at, 'In chests:'), list(on, 'On stands:'), list(tomb, 'In tombstones:'), 'every 64 m zone, last world save'].filter(Boolean).join(' · '), host, 'span-12');
  }
  function itemView(r) {
    const name = r.arg;
    const g = GD()[name];
    const back = crumbs();
    const it = S.data.world ? ITEMS()[name] : null;
    if (!it && !g) {
      if (!S.data.world) return noWorld(itemName(name));
      return [back, el('div', { class: 'card', style: { marginTop: '16px' } }, el('div', { class: 'empty-state', text: `“${name}” isn't stored, crafted, built or displayed in the current world.` }))];
    }
    const head = el('div', { class: 'phead' },
      itemIcon(name, 'avatar item-icon') || el('div', { class: 'avatar item-avatar', 'aria-hidden': 'true', text: itemName(name)[0] }),
      el('div', null, el('h1', { text: itemName(name) }),
        el('div', { class: 'meta' }, it ? el('a', { class: 'plain', href: catHref(it.c), text: catLabel(it.c) }) : (ITEM_TYPE[g.type] || 'Item'),
          ` · ${name}${it ? ` · ${snapNote()}` : ''}`),
        g?.desc ? el('p', { class: 'item-desc', text: g.desc }) : null));
    if (!it) {
      return [back, head, el('div', { class: 'grid', style: { marginTop: '14px' } }, ...itemStatsCards(g), ...itemUseCards(g), ...itemDropCards(name), ...itemPluginCards(name), wornByCard(name), custodyCard(name),
        card('In this world', null, el('div', { class: 'empty-state', text: 'Nobody has this stored, crafted, built or on display right now.' }), 'span-12'))];
    }
    const rows = (o) => Object.entries(o || {}).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
    const crafters = rows(it.crafted), finders = foundBy(name), builders = rows(it.built), shown = rows(it.shown);
    const same = Object.entries(ITEMS()).filter(([n, x]) => n !== name && x.c === it.c)
      .map(([n, x]) => [n, (x.kept || 0) + total(x.crafted) + total(x.built) + total(x.shown)]).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const fTable = finders.length ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Player' }), el('th', { class: 'r', text: 'Picked up' }), el('th', { class: 'r', text: 'Looted' }))),
      el('tbody', null, finders.map((f) => el('tr', null, el('td', null, whoLink(f.k)),
        el('td', { class: 'r', text: f.pick ? nf(f.pick) : '–' }), el('td', { class: 'r', text: f.loot ? nf(f.loot) : '–' })))))) : null;
    const crTable = crafters.length ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Player' }), el('th', { class: 'r', text: 'Crafted' }), el('th', { text: 'Quality' }))),
      el('tbody', null, crafters.map((c) => el('tr', null, el('td', null, whoLink(c.k)), el('td', { class: 'r', text: nf(c.v) }),
        el('td', { class: 'hint', text: qualityText(it.q?.[c.k]) })))))) : null;
    const piece = it.c === 'pieces' || (builders.length && !it.kept && !crafters.length);
    return [
      back,
      head,
      kpiRow(
        piece ? kpi('Standing', nf(total(it.built)), `placed by ${plural(builders.length, 'player')}`) : null,
        !piece || it.kept ? kpi('In chests', nf(it.kept || 0), it.at?.length ? `in ${plural(it.at.length, 'place')} (64 m zones)` : null) : null,
        crafters.length ? kpi('Crafted', nf(total(it.crafted)), `by ${plural(crafters.length, 'player')}, still in chests`) : null,
        shown.length ? kpi('On display', nf(total(it.shown)), 'on item & armor stands') : null),
      el('div', { class: 'grid' },
        ...(g ? itemStatsCards(g) : []),
        ...(g ? itemUseCards(g) : []),
        ...itemDropCards(name),
        ...itemPluginCards(name),
        wornByCard(name),
        builders.length ? card('Built by', 'Pieces standing in the world', hbars(builders, (v) => nf(v), whoColor, true), 'span-6') : null,
        crafters.length ? card('Crafted by', 'Units in chests, by who made them; quality ★ levels', crTable, 'span-6') : null,
        finders.length ? card('Found by', 'First picked up, or taken from dungeon, treasure and shipwreck chests · all time, since the server plugin logs it', fTable, 'span-6') : null,
        it.at?.length || it.on?.length || it.tomb?.length ? keptMap(name, it.at || [], it.on || [], it.tomb || []) : null,
        custodyCard(name),
        shown.length ? card('On display at', 'Stands built by', hbars(shown, (v) => nf(v), whoColor, true), 'span-6') : null,
        same.length ? card(`More ${catLabel(it.c).toLowerCase()}`, null, el('div', null, tags(same, ''),
          el('a', { class: 'more-link', href: catHref(it.c), style: { display: 'inline-block', marginTop: '10px' }, text: `All ${catLabel(it.c).toLowerCase()} →` })), 'span-12') : null),
    ];
  }

  // ---- item catalogue
  function itemsView(r) {
    if (!S.data.world) return noWorld('Items');
    const want = r.q?.get('cat') || '';
    const all = Object.entries(ITEMS()).map(([name, it]) => ({
      name, it, pretty: itemName(name), cat: catLabel(it.c),
      stored: it.kept || 0, crafted: total(it.crafted), built: total(it.built), shown: total(it.shown),
      _search: `${name} ${itemName(name)} ${catLabel(it.c)} ${Object.keys(it.crafted || {}).join(' ')}`.toLowerCase(),
    }));
    const cats = new Map();
    for (const x of all) cats.set(x.it.c || 'other', (cats.get(x.it.c || 'other') || 0) + 1);
    const list = want ? all.filter((x) => (x.it.c || 'other') === want) : all;
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Category' },
      el('a', { class: 'chip', href: '#/items', 'aria-current': want ? null : 'true', text: `All ${nf(all.length)}` }),
      [...cats].sort((a, b) => b[1] - a[1]).map(([c, n]) => el('a', { class: 'chip', href: catHref(c), 'aria-current': want === c ? 'true' : null, text: `${catLabel(c === 'other' ? '' : c)} ${n}` })));
    const st = S.itemsSort;
    const { table, search } = sortableTable([
      { label: 'Item', key: 'pretty' }, { label: 'Category', key: 'cat' }, { label: 'In chests', key: 'stored', r: true },
      { label: 'Crafted', key: 'crafted', r: true }, { label: 'Built', key: 'built', r: true }, { label: 'On display', key: 'shown', r: true },
    ], list, st, (x) => itemRow(x, [itemCell(x.name), catCell(x.it.c),
      ...['stored', 'crafted', 'built', 'shown'].map((k) => el('td', { class: 'r', text: x[k] ? nf(x[k]) : '–' }))]), 'No matching item.');
    return [
      ...subHead(want ? catLabel(want === 'other' ? '' : want) : 'Items', `${plural(list.length, 'kind')} of item · ${snapNote()}`, true),
      el('div', { class: 'grid' }, card('Categories', 'From the game’s own asset folders', chips, 'span-12'),
        card('All items', 'Everything players built, keep in chests, crafted or put on display · click for details', table, 'span-12', search)),
    ];
  }

  // ---- world history (one summary per hourly save)
  const HIST = () => S.data.world_history || [];
  // Step chart of fn(snapshot) over the range, carrying the last value from before it in.
  function histChart(host, fn, fmtY, label, aria, color) {
    const hist = HIST().filter((h) => fn(h) != null).map((h) => [h.t, fn(h)]);
    const before = [...hist].reverse().find((h) => h[0] < S.a);
    const pts = [...(before ? [[S.a, before[1]]] : []), ...hist.filter((h) => h[0] >= S.a && h[0] < S.b)];
    later(() => (hist.length < 2 ? empty(host, 'Needs a few hourly snapshots — check back later.')
      : stepChart(host, { a: S.a, b: S.b, pts, color, fmtY, label, aria })));
  }
  // Pieces each player added (net) between the snapshot in force at range start and the last one in range.
  function builtInRange(a = S.a, b = S.b) {
    const hist = HIST();
    const from = [...hist].reverse().find((h) => h.t < a) || hist.find((h) => h.t >= a && h.t < b);
    const to = [...hist].reverse().find((h) => h.t < b);
    if (!from || !to || to.t <= from.t) return null;
    const rows = [...new Set([...Object.keys(from.pieces), ...Object.keys(to.pieces)])]
      .map((k) => ({ k, v: (to.pieces[k] || 0) - (from.pieces[k] || 0) })).filter((r) => r.v).sort((x, y) => y.v - x.v);
    return { from: from.t, to: to.t, rows, net: rows.reduce((n, r) => n + r.v, 0) };
  }

  // ---- next boss: what the chests hold towards it. [label, prefabs (any of), units needed]
  const PREP = {
    defeated_eikthyr: { summon: [['Deer trophies', ['TrophyDeer'], 2]],
      gear: [['Leather tunic', ['ArmorLeatherChest']], ['Leather pants', ['ArmorLeatherLegs']], ['Leather helmet', ['HelmetLeather']], ['Bow', ['Bow', 'BowFineWood']], ['Arrows', ['ArrowFlint', 'ArrowWood', 'ArrowFire'], 40]] },
    defeated_gdking: { summon: [['Ancient seeds', ['AncientSeed'], 3]],
      gear: [['Bronze plate cuirass', ['ArmorBronzeChest']], ['Bronze plate leggings', ['ArmorBronzeLegs']], ['Bronze helmet', ['HelmetBronze']], ['Fire arrows', ['ArrowFire'], 40], ['Minor healing mead', ['MeadHealthMinor'], 3]] },
    defeated_bonemass: { summon: [['Withered bones', ['WitheredBone'], 10]],
      gear: [['Poison resistance mead', ['MeadPoisonResist'], 3], ['Blunt weapon', ['MaceIron', 'MaceBronze', 'SledgeIron']], ['Iron scale mail', ['ArmorIronChest']], ['Iron greaves', ['ArmorIronLegs']], ['Iron helmet', ['HelmetIron']], ['Medium healing mead', ['MeadHealthMedium'], 3]] },
    defeated_dragon: { summon: [['Dragon eggs', ['DragonEgg'], 3]],
      gear: [['Frost resistance mead', ['MeadFrostResist'], 3], ['Wolf armor chest', ['ArmorWolfChest']], ['Wolf armor legs', ['ArmorWolfLegs']], ['Drake helmet', ['HelmetDrake']], ['Wolf fur cape', ['CapeWolf']],
        ['Draugr fang bow', ['BowDraugrFang']], ['Arrows (obsidian, poison, silver)', ['ArrowObsidian', 'ArrowPoison', 'ArrowSilver'], 50], ['Medium healing mead', ['MeadHealthMedium'], 3]] },
    defeated_goblinking: { summon: [['Fuling totems', ['GoblinTotem'], 5]],
      gear: [['Fire resistance barley wine', ['BarleyWine'], 3], ['Padded cuirass', ['ArmorPaddedCuirass']], ['Padded greaves', ['ArmorPaddedGreaves']], ['Padded helmet', ['HelmetPadded']], ['Lox cape', ['CapeLox']], ['Medium healing mead', ['MeadHealthMedium'], 3]] },
    defeated_queen: { summon: [['Sealbreaker (or 9 fragments)', ['DvergrKey'], 1, ['DvergrKeyFragment', 9]]],
      gear: [['Carapace breastplate', ['ArmorCarapaceChest']], ['Carapace greaves', ['ArmorCarapaceLegs']], ['Carapace helmet', ['HelmetCarapace']], ['Feather cape', ['CapeFeather']], ['Major healing mead', ['MeadHealthMajor'], 3]] },
    defeated_fader: { summon: [['Bell (or 3 fragments)', ['Bell'], 1, ['BellFragment', 3]]],
      gear: [['Fire resistance barley wine', ['BarleyWine'], 3], ['Flametal breastplate', ['ArmorFlametalChest']], ['Flametal greaves', ['ArmorFlametalLegs']], ['Flametal helmet', ['HelmetFlametal']], ['Ashen cape', ['CapeAsh']], ['Major healing mead', ['MeadHealthMajor'], 3]] },
  };
  function nextBossCard() {
    const w = S.data.world;
    const next = w?.bosses.find((b) => !b[2]);
    const prep = next && PREP[next[0]];
    if (!prep) return null;
    const have = (names) => names.reduce((n, x) => n + (ITEMS()[x]?.kept || 0), 0);
    const where = (names) => names.filter((x) => ITEMS()[x]?.kept);
    const line = ([label, names, need = 1, alt]) => {
      let n = have(names), ok = n >= need, note = `${nf(n)}${need > 1 ? ` / ${nf(need)}` : ''}`;
      if (!ok && alt) { const m = have([alt[0]]); if (m >= alt[1]) { ok = true; note = `${nf(m)} fragments`; } else if (m) note += ` · ${nf(m)}/${alt[1]} fragments`; }
      const found = where(alt ? [...names, alt[0]] : names);
      return el('li', { class: ok ? 'ok' : 'miss' },
        el('span', { class: 'chk', 'aria-hidden': 'true', text: ok ? '✔' : n ? '◐' : '✗' }),
        el('span', { class: 'what' }, found.length ? el('a', { class: 'plain', href: itemHref(found[0]), text: label }) : label),
        el('span', { class: 'hint', text: n || ok ? note : 'none in chests' }));
    };
    const altar = w.boss_altars?.[ALTAR[next[0]]];
    const all = [...prep.summon, ...prep.gear];
    const ready = all.filter(([, names, need = 1, alt]) => have(names) >= need || (alt && have([alt[0]]) >= alt[1])).length;
    return card(`Getting ready for ${next[1]}`, `${ready} of ${all.length} in chests · ${snapNote()}`, el('div', null,
      el('div', { class: 'prep-cols' },
        el('div', null, el('h3', { text: 'Summoning' }), el('ul', { class: 'checklist' },
          el('li', { class: altar ? 'ok' : 'miss' }, el('span', { class: 'chk', 'aria-hidden': 'true', text: altar ? '✔' : '✗' }),
            el('span', { class: 'what', text: 'Altar area' }), el('span', { class: 'hint', text: altar ? 'explored' : 'not found yet' })),
          prep.summon.map(line))),
        el('div', null, el('h3', { text: 'Suggested gear & consumables' }), el('ul', { class: 'checklist' }, prep.gear.map(line)))),
      el('p', { class: 'explain', text: 'Counts what is in player-built chests. Carried items live in each player’s character file, not the world save, so gear someone wears is not seen here.' })), 'span-12');
  }

  // ---- production pieces (smelters, kilns, fermenters, hives, cooking)
  const STATION_LABEL = { smelter: 'Smelter', blastfurnace: 'Blast furnace', eitrrefinery: 'Eitr refinery', charcoal_kiln: 'Charcoal kiln', windmill: 'Windmill',
    piece_spinningwheel: 'Spinning wheel', piece_FrostKiln: 'Frost kiln', fermenter: 'Fermenter', piece_beehive: 'Beehive', piece_sapcollector: 'Sap extractor',
    piece_cookingstation: 'Cooking station', piece_cookingstation_iron: 'Iron cooking station', piece_oven: 'Stone oven' };
  const OUT_LABEL = { piece_beehive: 'honey', piece_sapcollector: 'sap' };
  function stationsCard() {
    const st = S.data.world?.stations;
    if (!st || !Object.keys(st).length) return null;
    const rows = Object.entries(st).sort((a, b) => Object.keys(STATION_LABEL).indexOf(a[0]) - Object.keys(STATION_LABEL).indexOf(b[0]));
    const state = (name, s) => {
      const out = [];
      const cook = name.includes('cooking') || name === 'piece_oven';
      if (s.busy) out.push(el('span', { class: 'tag on' }, name === 'fermenter' ? 'fermenting ' : cook ? 'cooking ' : 'working ', el('b', { text: nf(s.busy) })));
      if (s.queue) out.push(el('span', { class: 'tag' }, `${nf(s.queue)} queued`));
      if (s.ready) out.push(el('span', { class: 'tag good' }, OUT_LABEL[name] ? `${nf(s.out || 0)} ${OUT_LABEL[name]} to collect` : name === 'fermenter' ? `${nf(s.ready)} ready to tap` : `${nf(s.ready)} done`));
      else if (s.out && !OUT_LABEL[name]) out.push(el('span', { class: 'tag good' }, `${nf(s.out)} to collect`));
      if (s.nofuel) out.push(el('span', { class: 'tag warn' }, `${nf(s.nofuel)} out of fuel`));
      if (s.burnt) out.push(el('span', { class: 'tag warn' }, `${nf(s.burnt)} burnt`));
      if (!out.length) out.push(el('span', { class: 'hint', text: 'idle' }));
      return out;
    };
    return card('Workstations', `State at the last world save · ${fDateTime(S.data.world.t)}`, el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Station' }), el('th', { class: 'r', text: 'Built' }), el('th', { text: 'State' }))),
      el('tbody', null, rows.map(([name, s]) => el('tr', null,
        el('td', null, el('a', { class: 'plain', href: itemHref(name), text: STATION_LABEL[name] || pretty(name) })),
        el('td', { class: 'r', text: nf(s.n) }),
        el('td', null, el('div', { class: 'tags' }, state(name, s)))))))), 'span-12');
  }

  function baseView() {
    const w = S.data.world;
    if (!w) return noWorld('Base & gear');
    const builders = Object.entries(w.pieces).map(([k, v]) => ({ k, v: v.total, top: v.top })).sort((a, b) => b.v - a.v);
    const stored = Object.values(ITEMS()).reduce((n, it) => n + (it.kept || 0), 0);
    const tamed = w.tames.reduce((n, [, c]) => n + c, 0);
    const plist = portalList(), linked = Math.floor(plist.filter(portalLinked).length / 2);
    const tombs = Object.entries(w.tombstones).filter(([, n]) => n > 0);

    // Per-snapshot totals over time, within the range.
    const bt = chartHost(), tt2 = chartHost(), stc = chartHost();
    histChart(bt, (h) => Object.values(h.pieces).reduce((n, v) => n + v, 0), (v) => `${nf(v)} pieces`, 'standing', 'Pieces standing over time');
    histChart(tt2, (h) => h.tames, (v) => `${nf(v)} tames`, 'tamed', 'Tamed animals over time', 'var(--s2)');
    histChart(stc, (h) => h.stored, (v) => `${nf(v)} items`, 'in chests', 'Items in chests over time', 'var(--s3)');
    const delta = builtInRange();

    const inChests = Object.entries(ITEMS()).filter(([, it]) => it.kept).map(([name, it]) => ({ name, it, n: it.kept, pretty: pretty(name),
      cat: catLabel(it.c), _search: `${name} ${pretty(name)} ${catLabel(it.c)}`.toLowerCase() }));
    const st = { key: 'n', asc: false, q: '', limit: 25 };
    const { table, search } = sortableTable([{ label: 'Item', key: 'pretty' }, { label: 'Category', key: 'cat' }, { label: 'Amount', key: 'n', r: true }], inChests, st,
      (r) => itemRow(r, [itemCell(r.name), catCell(r.it.c), el('td', { class: 'r', text: nf(r.n) })]), 'No matching item.');
    const crafters = {};
    for (const [name, it] of Object.entries(ITEMS())) for (const [c, n] of Object.entries(it.crafted || {})) (crafters[c] ||= []).push([name, n]);

    return [
      ...subHead('Base & gear', `${snapNote()} · shows the current world, the time range only affects the building chart`, true),
      kpiRow(
        kpi('Pieces built', nf(sumPieces()), `${plural(builders.length, 'builder')}`),
        kpi('Items stored', nf(stored), `in ${plural(w.containers, 'chest')}`, { href: '#/items', title: 'Item catalogue' }),
        kpi('Kinds of items', nf(Object.keys(ITEMS()).length), 'see the catalogue', { href: '#/items', title: 'Item catalogue' }),
        kpi('Tames', nf(tamed), w.named_tames.length ? `${nf(w.named_tames.length)} with a name` : null),
        kpi('Portals', nf(w.portals.reduce((n, [, c]) => n + c, 0)), `${plural(linked, 'linked pair')}`),
        kpi('Lost tombstones', nf(tombs.reduce((n, [, c]) => n + c, 0)), tombs.length ? tombs.map(([p]) => p).join(', ') : 'all recovered')),
      el('div', { class: 'grid' },
        progressCard(false),
        card('Builders', 'Pieces standing in the world, by who placed them', hbars(builders, (v) => nf(v), whoColor, true), 'span-5'),
        card('What they build', 'Most placed pieces per player · click a piece for details', el('div', { class: 'stack' }, builders.map((b) =>
          el('div', { class: 'build-row' }, whoLink(b.k), tags(b.top.slice(0, 8), '–')))), 'span-7'),
        nextBossCard(),
        stationsCard(),
        card('Building over time', 'Total pieces standing, per hourly snapshot', bt, 'span-7'),
        card('Built in range', delta ? `Pieces added minus removed · ${fDateTime(delta.from)} – ${fDateTime(delta.to)}` : null,
          !delta ? el('div', { class: 'empty-state', text: 'Needs two hourly snapshots in this range.' })
            : delta.rows.length ? hbars(delta.rows, (v) => (v > 0 ? `+${nf(v)}` : nf(v)), whoColor, true)
              : el('div', { class: 'empty-state', text: 'Nothing built or torn down in this range.' }), 'span-5'),
        card('Tames over time', 'Tamed animals, per hourly snapshot', tt2, 'span-6'),
        card('Storage over time', 'Items in player-built chests, per hourly snapshot', stc, 'span-6'),
        card('Storage', 'Everything in player-built chests · click an item for details', table, 'span-7', search),
        card('Most stored', null, el('div', null, hbars(inChests.sort((a, b) => b.n - a.n).slice(0, 14).map((r) => ({ k: r.pretty, v: r.n, href: itemHref(r.name) })),
          (v) => nf(v), () => 'var(--s3)', (i) => i.href),
          el('a', { class: 'more-link', href: '#/items', style: { display: 'inline-block', marginTop: '10px' }, text: 'Item catalogue →' })), 'span-5'),
        card('Crafted gear in storage', 'Items in chests, by who crafted them', el('div', { class: 'stack' },
          Object.entries(crafters).sort((a, b) => b[1].length - a[1].length).map(([c, list]) =>
            el('div', { class: 'build-row' }, whoLink(c), tags(list.sort((a, b) => b[1] - a[1]), '–')))), 'span-8'),
        card('On display', 'Item & armor stands', tags(w.displayed, 'Nothing on display.'), 'span-4'),
        card('Tames', `${nf(tamed)} tamed animals`, el('div', null, el('div', { class: 'tags' }, w.tames.map(([k, n]) => el('span', { class: 'tag' }, pretty(k), n > 1 ? el('b', { text: ` ×${nf(n)}` }) : null))),
          w.named_tames.length ? el('ul', { class: 'plain-list' }, w.named_tames.map(([n, sp]) => el('li', null, el('b', { text: n }), el('span', { class: 'hint', text: ` · ${pretty(sp)}` })))) : null), 'span-4',
          S.data.pets?.length ? el('a', { class: 'more-link', href: '#/pets', text: 'Pets →' }) : null),
        card('Portals', `By tag · ${portalsNote()}`, el('ul', { class: 'plain-list' }, [...new Set(plist.map((p) => p[0]))].map((t) => {
          const mine = plist.filter((p) => p[0] === t), at = mine[0], on = mine.filter(portalLinked).length;
          return el('li', null, at ? el('a', { class: 'plain', href: mapHref(at[1], at[2], 5, `Portal “${t || 'no tag'}”`), title: 'Show on the map' }, el('b', { text: t || '(no tag)' })) : el('b', { text: t || '(no tag)' }),
            el('span', { class: 'hint', text: mine.length === 2 && on === 2 ? ' · linked' : mine.length === 1 ? (on ? ' · linked' : ' · unlinked') : ` · ${mine.length} portals, ${on ? `${nf(on)} linked` : 'none linked'}` }));
        })), 'span-4'),
        card('Beds', 'Spawn points per player', hbars(Object.entries(w.beds).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v), (v) => nf(v), whoColor, true), 'span-4'),
        card('Signs', `${plural(w.signs.length, 'sign')} with text`, w.signs.length
          ? el('ul', { class: 'signs' }, w.signs.map((t) => el('li', null, richText(t)))) : el('div', { class: 'empty-state', text: 'No signs yet.' }), 'span-12')),
    ];
  }

  // ------------------------------------------------------------------ Steam achievements
  // data.steam: {app, achievements: [{k, n, d, hidden, icon, gray, pct}], players: {main character: {chars, status, unlocked: {k: t}}}}
  // Achievements belong to the Steam account and count wherever they were earned; "here" means
  // the unlock fell inside a session of one of the account's characters on this server.

  const STEAM = () => S.data.steam;
  const achIcon = (a, got, cls = 'ach-ico') => el('img', { class: `${cls}${got ? '' : ' locked'}`, alt: '', loading: 'lazy', decoding: 'async',
    src: `steam/${STEAM().app}/${got ? a.icon : a.gray || a.icon}` });
  const earnedHere = (chars, t) => S.data.sessions.some((s) => chars.includes(s.p) && t >= s.s - 120 && t <= s.end_t + 120);
  // [{p, chars, status, a, t, here}] for every unlock of a tracked account
  function unlocks() {
    const st = STEAM(), by = new Map(st.achievements.map((a) => [a.k, a]));
    return Object.entries(st.players).flatMap(([p, pl]) => Object.entries(pl.unlocked).filter(([k]) => by.has(k))
      .map(([k, t]) => ({ p, chars: pl.chars, a: by.get(k), t, here: earnedHere(pl.chars, t) }))).sort((x, y) => y.t - x.t);
  }
  const achDesc = (a, revealed) => (a.hidden && !revealed ? 'Hidden achievement — revealed once a player here unlocks it' : a.d || 'Hidden achievement');
  const achName = (a, revealed) => (a.hidden && !revealed ? 'Hidden achievement' : a.n);
  const rarity = (pct) => (pct == null ? null : `${nf(pct, pct < 10 ? 1 : 0)} % of all players`);
  const PRIVATE_NOTE = 'Steam privacy: “Game details” is not public, so Steam doesn’t share these achievements.';

  // Valheim's Steam stats (lifetime per account, all worlds). Steam ships no display names.
  const km = (m) => `${nf(m / 1000, m < 10000 ? 1 : 0)} km`;
  const STEAM_STATS = [
    ['FoodEaten', 'Food eaten', nf], ['CraftFood', 'Meals cooked', nf], ['HarvestCrop', 'Crops harvested', nf],
    ['BeesHarvested', 'Honey harvested', nf], ['Tree', 'Trees felled', nf], ['BuiltPiecesNoDebt', 'Pieces built', nf],
    ['MaxBuildingHeight', 'Tallest build', (v) => `${nf(v)} m`], ['MaxBuildingHeightWorld', 'Highest build above sea', (v) => `${nf(v)} m`],
    ['MaxComfort', 'Highest comfort', nf], ['ConsecutiveDaysSurvivedMax', 'Longest survival streak', (v) => plural(v, 'day')],
    ['DistanceSail', 'Distance sailed', km], ['DistanceSailHelm', 'Distance sailed at the helm', km],
    ['LeviathanSink', 'Leviathan dives ridden out', nf], ['TreasureBuriedFound', 'Buried treasure found', nf],
  ];
  function steamStatsCard() {
    const st = STEAM();
    const who = Object.entries(st?.players || {}).filter(([, pl]) => pl.stats && Object.keys(pl.stats).length);
    if (!who.length) return null;
    const rows = STEAM_STATS.filter(([k]) => who.some(([, pl]) => pl.stats[k]));
    return card('Steam stats', 'Lifetime per Steam account, across all worlds · bold = highest', el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Stat' }), who.map(([p]) => el('th', { class: 'r' }, el('a', { class: 'plain', href: `#/p/${encodeURIComponent(p)}`, text: p }))))),
      el('tbody', null, rows.map(([k, label, f]) => {
        const max = Math.max(...who.map(([, pl]) => pl.stats[k] || 0));
        return el('tr', null, el('td', { text: label, title: k }), who.map(([, pl]) => {
          const v = pl.stats[k] || 0;
          return el('td', { class: 'r', style: v && v === max && who.some(([, o]) => (o.stats[k] || 0) < max) ? { fontWeight: 650 } : null, text: v ? f(v) : '–' });
        }));
      })))), 'span-12');
  }
  function playerSteamStats(pl) {
    const rows = STEAM_STATS.filter(([k]) => pl.stats?.[k]);
    if (!rows.length) return null;
    return card('Steam stats', 'Lifetime on this Steam account, across all worlds', el('div', { class: 'kvs' },
      rows.map(([k, label, f]) => el('div', { class: 'kv', title: k }, el('span', { class: 'hint', text: label }), el('b', { text: f(pl.stats[k]) })))), 'span-12');
  }

  function achProgress(st) {
    const total = st.achievements.length;
    const rows = Object.entries(st.players).sort((x, y) => Object.keys(y[1].unlocked).length - Object.keys(x[1].unlocked).length
      || (x[1].status === 'ok' ? -1 : 1));
    return el('div', { class: 'hbars' }, rows.map(([p, pl]) => {
      const n = Object.keys(pl.unlocked).length;
      return el('div', { class: 'hbar', title: pl.status === 'ok' ? `${pl.chars.join(', ')} · checked ${fDateTime(pl.checked)}` : PRIVATE_NOTE },
        el('a', { class: 'name', href: `#/p/${encodeURIComponent(p)}`, text: p }),
        el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: `${(n / total) * 100}%`, background: whoColor(p) } })),
        el('span', { class: 'v', text: pl.status === 'ok' ? `${n} / ${total}` : n ? `${n} / ${total} · private` : 'private' }));
    }));
  }
  function unlockItem(u) {
    return el('li', null, achIcon(u.a, true, 'ach-ico sm'),
      el('span', { class: 'what' }, el('a', { href: `#/p/${encodeURIComponent(u.p)}`, text: u.p }), ' unlocked ', el('b', { text: u.a.n }),
        el('span', { class: 'hint', text: ` · ${[u.here ? 'earned here' : null, rarity(u.a.pct)].filter(Boolean).join(' · ')}` })),
      el('time', { datetime: new Date(u.t * 1000).toISOString(), text: fDateTime(u.t) }));
  }

  function achievementsCard() {
    const st = STEAM();
    if (!st || !Object.keys(st.players).length) return null;
    const us = unlocks();
    return card('Steam achievements', `${plural(st.achievements.length, 'achievement')} · per Steam account, wherever they were earned`,
      el('div', { class: 'raids-compact' },
        el('div', null, el('h3', { text: 'Progress' }), achProgress(st)),
        el('div', null, el('h3', { text: 'Latest unlocks' }), us.length ? el('ul', { class: 'feed ach-feed' }, us.slice(0, 5).map(unlockItem))
          : el('div', { class: 'empty-state', text: 'No unlocks yet.' }))), 'span-12',
      el('a', { class: 'more-link', href: '#/achievements', text: 'All achievements →' }));
  }

  function achievementsView(r) {
    const st = STEAM();
    if (!st) return [...subHead('Achievements', null, true), el('div', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'empty-state', text: 'No Steam achievements yet — the first check runs within minutes.' }))];
    const us = unlocks();
    const holders = new Map();
    for (const u of us) (holders.get(u.a.k) || holders.set(u.a.k, []).get(u.a.k)).push(u);
    const want = r.q?.get('show') || 'all';
    // unlocked first (latest first unlock on top), then the rest by how common they are: the likely next ones
    const first = (a) => Math.min(...holders.get(a.k).map((u) => u.t));
    const list = st.achievements.filter((a) => (want === 'all' ? true : want === 'unlocked' ? holders.has(a.k) : !holders.has(a.k)))
      .sort((x, y) => (holders.has(y.k) - holders.has(x.k)) || (holders.has(x.k) ? first(y) - first(x) : (y.pct ?? 0) - (x.pct ?? 0)));
    const got = st.achievements.filter((a) => holders.has(a.k));
    const rarest = got.reduce((m, a) => (a.pct != null && (!m || a.pct < m.pct) ? a : m), null);
    const best = Object.entries(st.players).sort((x, y) => Object.keys(y[1].unlocked).length - Object.keys(x[1].unlocked).length)[0];
    const priv = Object.entries(st.players).filter(([, pl]) => pl.status !== 'ok').map(([p]) => p);
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['unlocked', 'Unlocked here'], ['locked', 'Not yet']].map(([k, t]) =>
      el('a', { class: 'chip', href: k === 'all' ? '#/achievements' : `#/achievements?show=${k}`, 'aria-current': want === k ? 'true' : null, text: t })));
    const grid = el('div', { class: 'achs' }, list.map((a) => {
      const hs = holders.get(a.k) || [];
      return el('div', { class: `ach${hs.length ? '' : ' none'}` }, achIcon(a, hs.length > 0),
        el('div', null,
          el('div', { class: 'ach-name', text: achName(a, hs.length) }),
          el('div', { class: 'ach-desc', text: achDesc(a, hs.length) }),
          el('div', { class: 'ach-meta' }, rarity(a.pct) ? el('span', { class: 'hint', text: rarity(a.pct) }) : null,
            hs.length ? el('div', { class: 'tags' }, hs.sort((x, y) => x.t - y.t).map((u) =>
              el('a', { class: `tag link${u.here ? ' good' : ''}`, href: `#/p/${encodeURIComponent(u.p)}`,
                title: `${fDateTime(u.t)}${u.here ? ' · earned on this server' : ' · earned elsewhere'}` }, u.here ? '★ ' : '', u.p))) : null)));
    }));
    return [
      ...subHead('Achievements', `Valheim on Steam · ${plural(st.achievements.length, 'achievement')}`, true),
      kpiRow(
        kpi('Unlocked here', `${nf(got.length)} / ${nf(st.achievements.length)}`, 'by at least one player'),
        kpi('Most achievements', best ? best[0] : '–', best ? `${nf(Object.keys(best[1].unlocked).length)} unlocked` : null, best ? { href: `#/p/${encodeURIComponent(best[0])}` } : null),
        kpi('Rarest unlocked', rarest ? rarest.n : '–', rarest ? rarity(rarest.pct) : null),
        kpi('Earned on this server', nf(us.filter((u) => u.here).length), `of ${plural(us.length, 'unlock')}`),
        kpi('Private profiles', nf(priv.length), priv.length ? priv.join(', ') : 'everyone shares')),
      el('div', { class: 'grid' },
        card('Progress', 'Unlocked of all achievements, per Steam account', el('div', null, achProgress(st),
          priv.length ? el('p', { class: 'explain', text: `${PRIVATE_NOTE} Set it to public under Steam → Profile → Edit Profile → Privacy Settings.` }) : null), 'span-5'),
        card('Latest unlocks', '★ = earned on this server', us.length ? el('ul', { class: 'feed ach-feed' }, us.slice(0, 12).map(unlockItem))
          : el('div', { class: 'empty-state', text: 'No unlocks yet.' }), 'span-7'),
        steamStatsCard(),
        card('All achievements', 'Grey: nobody here has it yet · global rates from Steam', el('div', null, chips, el('div', { style: { height: '12px' } }), grid), 'span-12')),
    ];
  }

  function playerAchievements(p) {
    const st = STEAM();
    const [, pl] = Object.entries(st?.players || {}).find(([, x]) => x.chars.includes(p)) || [];
    if (!pl) return null;
    const all = new Set(Object.values(st.players).flatMap((x) => Object.keys(x.unlocked)));
    const got = st.achievements.filter((a) => pl.unlocked[a.k] != null).sort((x, y) => pl.unlocked[y.k] - pl.unlocked[x.k]);
    const rest = st.achievements.filter((a) => pl.unlocked[a.k] == null).sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0));
    const tile = (a, t) => el('div', { class: 'ach-mini', title: `${achName(a, all.has(a.k))} — ${achDesc(a, all.has(a.k))}${t ? ` · ${fDateTime(t)}${earnedHere(pl.chars, t) ? ' · earned here' : ''}` : ''}${a.pct != null ? ` · ${rarity(a.pct)}` : ''}` },
      achIcon(a, t != null));
    const others = pl.chars.filter((x) => x !== p);
    return [card('Steam achievements', `${nf(got.length)} of ${nf(st.achievements.length)}${others.length ? ` · Steam account shared with ${others.join(', ')}` : ''} · ${HOVER} for details`,
      el('div', null, pl.status !== 'ok' ? el('p', { class: 'explain', style: { marginTop: 0 }, text: `${PRIVATE_NOTE}${got.length ? ' Showing what was visible before.' : ''}` }) : null,
        el('div', { class: 'ach-wall' }, got.map((a) => tile(a, pl.unlocked[a.k])), rest.map((a) => tile(a, null)))), 'span-12'),
      playerSteamStats(pl)];
  }

  // ------------------------------------------------------------------ Viking profile (per player, all time)
  // Identity, report card, trading card, death certificate, habits, wealth and fortune. All of it is
  // all-time, so a byname doesn't flip with the range slider; computed once per data.json.

  let FUN = null;
  function funAll() {
    const d = S.data;
    if (FUN?.gen === d.generated) return FUN;
    const c = compute(S.min, S.max);
    const M = awardMetrics(c);
    const w = d.world;
    const val = (k, p) => M[k]?.get(p) || 0;
    const ps = S.players.filter((p) => val('play', p) > 0);
    const R = new Map();
    for (const p of ps) {
      const cp = compute(S.min, S.max, p);
      const ses = d.sessions.filter((s) => s.p === p).sort((x, y) => x.s - y.s);
      const deaths = d.deaths.filter((x) => x.p === p).map((x) => x.t).sort((x, y) => x - y);
      const play = val('play', p), hours = play / HOUR;
      const first = ses[0].s;
      const logins = ses.map((s) => hourParts(Math.floor(s.s / HOUR) * HOUR).hour + (s.s % HOUR) / HOUR);
      // how regular their start time is: mean resultant length of login times on a 24 h circle (1 = always the same time)
      const ang = logins.map((h) => (h / 24) * 2 * Math.PI);
      const regular = logins.length >= 3 ? Math.hypot(ang.reduce((n, a) => n + Math.cos(a), 0), ang.reduce((n, a) => n + Math.sin(a), 0)) / ang.length : null;
      const items = Object.entries(ITEMS());
      const mine = (field) => items.filter(([, it]) => it[field]?.[p]).map(([name, it]) => [name, it, it[field][p]]);
      R.set(p, {
        p, play, hours, ses, deaths, first, heat: cp.heat.flat(),
        days: cp.rows[0]?.days.size || 0, since: daysIn(first, d.generated).length,
        dealt: cp.rows[0]?.dealt || 0, picked: cp.rows[0]?.picked || 0,
        zones: val('pathfinder', p), far: val('edgelord', p), raids: val('raids', p), survived: val('survivor', p), jonah: val('jonah', p),
        company: val('company', p), lone: val('lonewolf', p), night: val('night', p), longest: val('marathon', p),
        built: w?.pieces?.[p]?.total || 0, hoard: val('hoard', p), honey: val('honey', p), wreck: val('wreck', p),
        regular,
        builtItems: mine('built'), foundItems: foundOf(p).map((f) => [f.name, f.it, f.n]),
        dph: hours >= 1 ? deaths.length / hours : null,
      });
    }
    FUN = { gen: d.generated, c, M, R, ps };
    return FUN;
  }
  const median = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b), m = s.length / 2;
    return s.length ? (s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2) : null;
  };

  // ---- identity: byname + spirit animal from the traits a player stands out in most. What a trait measures is here;
  // its weight (quirky ones that hinge on one event weigh less), byname and animal are the rules.
  const TRAIT_VALUE = {
    deaths: (r) => r.dph, survival: (r) => (r.dph == null ? null : 1 / Math.max(r.dph, 0.05)), explore: (r) => r.zones,
    build: (r) => r.built, hoard: (r) => r.hoard, night: (r) => r.night / Math.max(r.play, 1),
    company: (r) => r.company / Math.max(r.play, 1), lone: (r) => r.lone / Math.max(r.play, 1),
    restless: (r) => r.ses.length / Math.max(r.hours, 1), storm: (r) => r.raids / Math.max(r.hours, 1), tireless: (r) => r.longest,
    honey: (r) => r.honey, wreck: (r) => r.wreck,
  };
  // traits by how far the player leads everyone else (value ÷ the best other player) × weight, best first
  function traitsOf(p) {
    const { R } = funAll();
    const r = R.get(p);
    if (!r) return [];
    const others = [...R.values()].filter((x) => x.p !== p && x.hours >= 1);
    return Object.entries(SC().traits).map(([k, t]) => [k, TRAIT_VALUE[k], t.weight, t.byname, [t.icon, t.animal, t.why]]).map(([k, fn, weight, name, animal]) => {
      const v = fn(r), top = Math.max(0, ...others.map(fn).filter((x) => x != null));
      return { k, name, animal, score: v != null && v > 0 && others.length ? weight * Math.min(2, top ? v / top : 2) : 0 };
    }).filter((t) => t.score > 0).sort((a, b) => b.score - a.score || a.k.localeCompare(b.k));
  }
  const bynameOf = (p) => traitsOf(p)[0]?.name || null;
  const animalOf = (p) => { const t = traitsOf(p); return (t[1] || t[0])?.animal || null; };

  // ---- report card: fixed grade steps per subject, the player's own record — not graded against the others. What a
  // subject measures and how it reads is here; its name, comments and the steps for A+, A, B, C, D (lower is better:
  // at most) are the rules, as is how many hours it takes to be graded.
  const SUBJECT_VALUE = {
    attendance: [(r) => r.days / Math.max(r.since, 1), (v) => pct(v)], survival: [(r) => r.dph, (v) => `${nf(v, 2)} deaths/h`],
    construction: [(r) => r.built / Math.max(r.hours, 1), (v) => `${nf(v, 1)} pieces/h`],
    exploration: [(r) => r.zones / Math.max(r.hours, 1), (v) => `${nf(v, 1)} zones/h`],
    teamwork: [(r) => r.company / Math.max(r.play, 1), (v) => pct(v)], punctuality: [(r) => r.regular, (v) => nf(v, 2)],
  };
  // [subject, value(r), lower is better, praise, complaint, steps, unit]
  const subjects = () => Object.entries(SC().grades.subjects).map(([k, x]) => [x.name, SUBJECT_VALUE[k][0], !!x.low, x.good, x.bad, x.steps, SUBJECT_VALUE[k][1]]);
  const GRADES = ['A+', 'A', 'B', 'C', 'D'];
  const gradeMinH = () => SC().grades.min_hours;  // fewer hours than this is too little to grade
  function reportCard(p) {
    const { R } = funAll();
    const r = R.get(p);
    if (r.hours < gradeMinH()) return subjects().map(([name, , , good, bad]) => ({ name, grade: '–', ratio: null, good, bad }));
    return subjects().map(([name, fn, low, good, bad, steps, fmtV]) => {
      const v = fn(r);
      if (v == null) return { name, grade: '–', ratio: null, good, bad };
      const i = steps.findIndex((t) => (low ? v <= t : v >= t));
      // ratio against the C step, for the teacher's best/worst comment
      const ratio = low ? (v === 0 ? Infinity : steps[3] / v) : v / steps[3];
      return { name, grade: i < 0 ? 'F' : GRADES[i], ratio, good, bad, value: fmtV(v) };
    });
  }
  const gradeHelp = () => subjects().map(([name, , low, , , steps, fmtV]) => `${name}: A ${low ? '≤' : '≥'} ${fmtV(steps[1])}, C ${low ? '≤' : '≥'} ${fmtV(steps[3])}`).join(' · ');

  // ---- trading card stats, 0–99 on fixed yardsticks: the player's own progress, not a ranking against the
  // others (same as card_tiers in collector/valheim_gamestats/notify.py). Counts score 99 at the rules' cards.at on a
  // square-root curve — a quarter of it gives 50; survival is 99 without deaths and 50 at cards.dph deaths per hour played.
  const cardHelp = () => {
    const { at, dph } = SC().cards;
    return `99 at ${nf(at.survived)} raids survived · ${nf(at.built)} pieces built · ${nf(at.zones)} zones explored`
      + ` · ${nf(at.dealt)} damage dealt · ${nf(at.picked)} items picked up; survival: 99 without deaths, 50 at one death per ${nf(1 / dph)} h played`;
  };
  function cardStats(p) {
    const { R } = funAll();
    const r = R.get(p);
    const { at, dph, tiers } = SC().cards;
    const count = (k) => (r[k] == null ? 0 : Math.round(99 * Math.min(1, Math.sqrt(r[k] / at[k]))));
    const st = [['⚔', 'Raids', count('survived')], ['🛡', 'Survival', r.dph == null ? 0 : Math.round(99 / (1 + r.dph / dph))],
      ['🔨', 'Building', count('built')], ['🧭', 'Exploring', count('zones')],
      // only where the server plugin logs them — else a 0 would drag every card down
      ...(S.data.gather?.length ? [['🗡', 'Combat', count('dealt')], ['🎒', 'Gathering', count('picked')]] : [])];
    const avg = st.reduce((n, s) => n + s[2], 0) / st.length;
    const now = avg >= tiers.legendary ? 'legendary' : avg >= tiers.epic ? 'epic' : avg >= tiers.rare ? 'rare' : 'common';
    // a card keeps the best tier it ever reached (kept by the collector), the bars stay live
    const best = S.data.cards?.[p];
    const kept = best && TIERS.indexOf(best.tier) > TIERS.indexOf(now);
    return { st, rarity: kept ? best.tier : now, now, since: best && TIERS.indexOf(best.tier) >= TIERS.indexOf(now) && best.tier !== 'common' ? best.t : null,
      lives: R.get(p).deaths.length + 1, foil: foilOf(p), medal: medalOf(p) };
  }
  const TIERS = ['common', 'rare', 'epic', 'legendary'];
  // The card's medal: the highest badge level the player reached, and with which badges ({tier, names} or null)
  function medalOf(p) {
    const bs = (badgesOf(p) || []).filter((b) => b.tier > 0);
    const top = Math.max(0, ...bs.map((b) => b.tier));
    return top ? { tier: top, names: bs.filter((b) => b.tier === top).map((b) => b.name) } : null;
  }
  // Foil edition: a badge at the top level (Diamond) — earned on this server, like the rest of the card
  function foilOf(p) {
    const m = medalOf(p);
    return m?.tier === SC().badge_tiers.length ? [`${badgeTier(m.tier).icon} ${m.names.join(', ')}`] : null;
  }

  // ---- habits
  function twinOf(p) {
    const { R } = funAll();
    const a = R.get(p).heat;
    const cos = (x, y) => { let d = 0, nx = 0, ny = 0; x.forEach((v, i) => { d += v * y[i]; nx += v * v; ny += y[i] * y[i]; }); return nx && ny ? d / Math.sqrt(nx * ny) : 0; };
    return [...R.values()].filter((r) => r.p !== p && r.hours >= 1).map((r) => ({ p: r.p, sim: cos(a, r.heat) })).sort((x, y) => y.sim - x.sim)[0] || null;
  }
  const done = (r) => r.ses.filter((s) => s.e != null).map((s) => s.e - s.s);

  // ---- wealth (current world save)
  const VALUE = { Coins: 1, Amber: 5, AmberPearl: 10, Ruby: 20, SilverNecklace: 30 };  // what Haldor pays
  const RAW_FOOD = /^(Raspberry|Blueberries|Cloudberry|Mushroom|MushroomYellow|MushroomJotunPuffs|MushroomMagecap|Carrot|Onion|Honey|Vineberry)$/;  // eaten as found
  const MEALS_A_DAY = 3;

  function seeded(str) {  // small deterministic PRNG, seeded per player and day
    let h = hashStr(str) >>> 0;
    return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return h / 2 ** 32; };
  }

  // want(title): build only these cards (the player tabs split the profile up); without it, all of them under a header.
  function vikingProfile(p, want = null) {
    const on = (title) => !want || want(title);
    const { R, M } = funAll();
    const r = R.get(p);
    if (!r) return [];
    const d = S.data, w = d.world;
    const traits = traitsOf(p), byname = bynameOf(p), animal = animalOf(p);
    const out = want ? [] : [el('h2', { class: 'section-title span-12', text: 'Viking profile' })];

    // trading card
    const tc = cardStats(p);
    const cap = (x) => `${x[0].toUpperCase()}${x.slice(1)}`;
    if (on('Trading card')) out.push(card('Trading card', `${cap(tc.rarity)}${tc.foil ? ' foil' : ''} · all time, their own progress — ${HOVER} a stat`, el('div', { class: `tcard ${tc.rarity}${tc.foil ? ' foil' : ''}`, title: tc.foil ? `Foil: ${tc.foil.join(', ')}` : null },
      el('div', { class: 'tcard-top' }, el('span', { class: 'tcard-name', text: p }), el('span', { class: 'tcard-lives', title: 'Lives used', text: `❤ ${nf(tc.lives)}` })),
      el('div', { class: 'tcard-art', style: { background: colorOf(p) } }, el('span', { text: animal?.[0] || [...p][0].toUpperCase() }),
        tc.medal ? el('span', { class: `tcard-medal m${tc.medal.tier}`, title: `Highest badge level: ${badgeTier(tc.medal.tier).name} — ${tc.medal.names.join(', ')}` },
          `${badgeTier(tc.medal.tier).icon} ${badgeTier(tc.medal.tier).name}`) : null),
      el('div', { class: 'tcard-type', text: [byname, animal ? `${animal[1]} type` : null].filter(Boolean).join(' · ') }),
      el('div', { class: 'tcard-stats', title: cardHelp() }, tc.st.map(([ico, label, v]) => el('div', { class: 'tcard-stat' },
        el('span', { text: `${ico} ${label}` }), el('span', { class: 'bar' }, el('i', { style: { width: `${v}%` } })), el('b', { text: nf(v) })))),
      el('div', { class: 'tcard-foot' }, [rarityLine(tc.rarity), tc.since ? `since ${fDate(tc.since)}` : null, `${fH(r.play)} played`].filter(Boolean).join(' · '),
        tc.rarity !== tc.now ? el('div', { class: 'hint', text: `plays at ${cap(tc.now)} level right now` }) : null,
        tc.foil ? el('div', { class: 'foil-why', text: `✨ Foil · ${tc.foil.join(' · ')}` }) : null)), 'span-4', scoringLink('cards')));

    // report card
    const rc = reportCard(p);
    const graded = rc.filter((x) => x.ratio != null);
    const best = graded.slice().sort((a, b) => b.ratio - a.ratio)[0], worst = graded.slice().sort((a, b) => a.ratio - b.ratio)[0];
    const comment = r.hours < gradeMinH() ? `${p} has played ${fH(r.play)} so far — grades come after ${nf(gradeMinH())} h on the server.`
      : !best ? 'Not enough data to judge this Viking yet.'
      : worst && worst.ratio < 0.8 && worst !== best ? `${p} ${best.good}, but ${worst.bad}.` : `${p} ${best.good}. Keep it up!`;
    if (on('Report card')) out.push(card('Report card', 'Fixed grade steps, their own record · all time', el('div', null,
      el('div', { class: 'grades' }, rc.map((x) => el('div', { class: `grade g-${x.grade.replace('+', 'p').replace('–', 'na')}`, title: x.value || null },
        el('b', { text: x.grade }), el('span', { text: x.name })))),
      el('p', { class: 'teacher', text: `“${comment}”` }),
      el('p', { class: 'explain', text: `Attendance: share of days online since joining · Survival: deaths per hour played · Construction & Exploration: per hour played · Teamwork: share of their time with others online · Punctuality: how regular their login time is (1 = always the same). Hover a grade for the value. ${gradeHelp()}.` })), 'span-8', scoringLink('grades')));

    // saga
    if (on('Saga')) out.push(card('Saga', `As the skalds tell it${animal ? ` · spirit animal: ${animal[0]} ${animal[1]}, ${animal[2]}` : ''}`, el('p', { class: 'saga', text: sagaOf(p, r, byname) }), 'span-12', scoringLink('traits')));

    // death certificate
    const dc = chartHost();
    const byHour = perHourAll(r.deaths);
    const worstH = r.deaths.length ? byHour.indexOf(Math.max(...byHour)) : null;
    if (on('Death certificate')) later(() => columns(dc, { labels: byHour.map((_, h) => String(h).padStart(2, '0')), values: byHour, color: 'var(--s8)', every: 3, height: 120,
      fmtV: (n) => plural(n, 'death'), tipT: hhLabel, aria: `Deaths of ${p} by hour of day` }));
    const raidDeaths = r.deaths.filter((t) => d.raids.some((x) => t >= x.t && t < x.t + RAID_WINDOW)).length;
    const chained = r.deaths.filter((t, i) => i && t - r.deaths[i - 1] <= 300).length;
    const nightDeaths = r.deaths.filter((t) => { const h = hourParts(Math.floor(t / HOUR) * HOUR).hour; return h < 5 || h >= 22; }).length;
    const n = r.deaths.length;
    const cause = !n ? 'Not dead yet' : raidDeaths / n >= 0.3 ? `Raids (${pct(raidDeaths / n)} of deaths)` : chained / n >= 0.4 ? `Corpse runs gone wrong (${pct(chained / n)})`
      : nightDeaths / n >= 0.5 ? `Late-night wandering (${pct(nightDeaths / n)})` : 'Unknown — probably a troll';
    const nemesis = [...(M.pact || [])].filter(([k]) => k.split(PAIR).includes(p)).sort((a, b) => b[1] - a[1])[0];
    const trend = trendOf(r);
    if (on('Death certificate')) out.push(card('Death certificate', 'All time', el('div', null,
      el('dl', { class: 'facts-dl' },
        fl('Lives used', nf(n + 1), n ? `${plural(n, 'death')} so far` : 'still on the first one'),
        fl('Average life', n ? fDur(r.play / (n + 1)) : fDur(r.play), 'of playtime per life'),
        fl('Most dangerous hour', worstH != null ? hhLabel(worstH) : '–', worstH != null ? plural(byHour[worstH], 'death') : null),
        fl('Probable cause of death', cause),
        fl('Nemesis', nemesis ? nemesis[0].split(PAIR).find((x) => x !== p) : '–', nemesis ? `died together ${nf(nemesis[1])}× within ${PACT} s` : 'dies alone'),
        fl('Getting better?', trend ? trend.text : '–', trend ? trend.sub : 'needs ≥4 h and ≥4 deaths')),
      n ? dc : null), 'span-6'));

    // habits
    const twin = twinOf(p);
    const mine = done(r), all = [...R.values()].flatMap(done);
    const myMed = median(mine), srvMed = median(all);
    const diet = myMed == null || srvMed == null ? null : myMed <= 0.6 * srvMed ? ['🍿', 'Snacker'] : myMed >= 1.6 * srvMed ? ['🍖', 'Binger'] : ['🍲', 'Balanced diet'];
    const wk = r.ses.length ? weekendShare(r) / (2 / 7) : null;
    const gap = disappearance(r);
    if (on('Habits')) out.push(card('Habits', 'All time', el('dl', { class: 'facts-dl' },
      fl('Schedule twin', twin ? twin.p : '–', twin ? `schedules ${pct(twin.sim)} alike` : 'nobody to compare with'),
      fl('Session style', diet ? `${diet[0]} ${diet[1]}` : '–', diet ? `median session ${fDur(myMed)} vs ${fDur(srvMed)} on the server · ${pct(mine.filter((x) => x < 20 * 60).length / Math.max(mine.length, 1))} under 20 min` : null),
      fl('Weekend warrior index', wk == null ? '–' : `${nf(wk, 1)}×`, wk == null ? null : wk >= 1.5 ? 'a true weekend warrior' : wk <= 0.6 ? 'a weekday regular' : 'plays all week long'),
      fl('Longest disappearance', gap ? fDur(gap.len) : '–', gap ? `${gap.open ? 'still gone' : 'presumed dead, then returned'} · from ${fDate(gap.from)}` : 'never really gone'),
      fl('Last seen', lastSeen(p, r))), 'span-6'));

    // wealth
    if (w) {
      const worth = r.foundItems.reduce((n2, [name, , v]) => n2 + (VALUE[name] || 0) * v, 0);
      const food = r.foundItems.filter(([name]) => RAW_FOOD.test(name)).reduce((n2, [, , v]) => n2 + v, 0);
      const wood = r.builtItems.filter(([name]) => !/sapling/i.test(name)).reduce((n2, [name, , v]) => n2 + woodCost(name) * v, 0);
      if (on('Wealth & stuff')) out.push(card('Wealth & stuff', `What they found (all time) and the pieces they built · ${snapNote()}`, el('dl', { class: 'facts-dl' },
        fl('💰 Fortune found', `${nf(worth)} coins`, 'coins, amber, pearls, rubies and necklaces they picked up or looted, at Haldor’s prices'),
        fl('🫐 Foraged', food ? `≈ ${plural(Math.floor(food / MEALS_A_DAY), 'in-game day')}` : 'nothing yet', food ? `${nf(food)} berries, mushrooms, honey and the like at ~${MEALS_A_DAY} meals a day` : 'nothing edible picked up yet'),
        fl('🌲 Personal deforestation', `≈ ${plural(Math.round(wood / WOOD_PER_TREE), 'tree')}`, `≈ ${nf(wood)} wood in the pieces they built`)), 'span-6'));
    }

    // fortune
    if (on('Fortune')) out.push(card('Fortune', 'Bucket list from Steam · a new prophecy every day', el('div', null,
      bucketList(p), el('p', { class: 'prophecy', text: `🔮 ${prophecy(p, r, { worstH, byHour, nemesis, twin, traits, rc })}` })), 'span-6'));
    return out;
  }
  const fl = (label, value, sub) => el('div', null, el('dt', { text: label }), el('dd', null, el('b', { text: value }), sub ? el('span', { class: 'hint', text: ` · ${sub}` }) : null));
  const rarityLine = (r) => ({ legendary: '★★★★ Legendary', epic: '★★★ Epic', rare: '★★ Rare', common: '★ Common' })[r];
  function perHourAll(times) {
    const v = new Array(24).fill(0);
    for (const t of times) v[hourParts(Math.floor(t / HOUR) * HOUR).hour] += 1;
    return v;
  }
  function weekendShare(r) {
    const total = r.heat.reduce((n, v) => n + v, 0);
    return total ? r.heat.slice(5 * 24).reduce((n, v) => n + v, 0) / total : 0;
  }
  // death rate in the first half of their playtime against the second half
  function trendOf(r) {
    if (r.hours < 4 || r.deaths.length < 4) return null;
    let acc = 0, mid = null;
    for (const s of r.ses) {
      const len = s.end_t - s.s;
      if (acc + len >= r.play / 2) { mid = s.s + (r.play / 2 - acc); break; }
      acc += len;
    }
    const a = r.deaths.filter((t) => t < mid).length, b = r.deaths.length - a;
    const h = r.play / 2 / HOUR, ra = a / h, rb = b / h;
    if (!ra && !rb) return null;
    const ch = ra ? rb / ra - 1 : 1;
    return Math.abs(ch) < 0.1 ? { text: '➖ About the same', sub: `${nf(ra, 1)} → ${nf(rb, 1)} deaths per hour` }
      : ch < 0 ? { text: `📈 ${pct(-ch)} fewer deaths`, sub: `per hour than in their early days (${nf(ra, 1)} → ${nf(rb, 1)})` }
        : { text: `📉 ${pct(ch)} more deaths`, sub: `per hour than in their early days (${nf(ra, 1)} → ${nf(rb, 1)})` };
  }
  function disappearance(r) {
    let best = null;
    for (let i = 1; i < r.ses.length; i++) {
      const len = r.ses[i].s - r.ses[i - 1].end_t;
      if (len > (best?.len || 0)) best = { len, from: r.ses[i - 1].end_t, open: false };
    }
    const last = r.ses[r.ses.length - 1];
    if (last.e != null && S.data.generated - last.e > (best?.len || 0)) best = { len: S.data.generated - last.e, from: last.e, open: true };
    return best && best.len >= HOUR ? best : null;
  }
  function lastSeen(p, r) {
    const last = r.ses[r.ses.length - 1];
    if (last.e == null) return S.data.raids.some((x) => x.t >= last.s && x.players.includes(p) && S.data.generated - x.t < 600) ? 'online right now, fighting off a raid' : 'online right now';
    const dLast = r.deaths.filter((t) => t >= last.s && t <= last.e).pop();
    const raid = S.data.raids.find((x) => x.t >= last.s && x.t <= last.e && x.players.includes(p));
    const what = dLast && last.e - dLast <= 600 ? `dying at ${fTime(dLast)}, then logging off` : raid ? `fleeing a raid (“${raidName(raid.n)}”)` : `leaving at ${fTime(last.e)}`;
    return `${what} · ${fAgo(S.data.generated - last.e)}`;
  }
  function sagaOf(p, r, byname) {
    const d = S.data, w = d.world;
    const who = byname ? `${p} ${byname}` : p;
    const day0 = gameDayAt(r.first + 1) ?? null;
    const lines = [`${day0 != null ? `On day ${nf(day0)} of the world` : 'Long ago'}, ${who} first set foot in ${d.title}.`];
    if (r.zones) lines.push(`They wandered ${plural(r.zones, 'land')}, as far as ${nf(r.far / 1000, 1)} km from the stones where all Vikings wake.`);
    const top = r.builtItems.filter(([n]) => !/sapling/i.test(n)).sort((a, b) => b[2] - a[2])[0];
    if (r.built) lines.push(`With their own hands they raised ${nf(r.built)} pieces${top ? `, most of them ${pretty(top[0]).toLowerCase()}` : ''}.`);
    const n = r.deaths.length;
    lines.push(n ? `${n === 1 ? 'Once' : `${nf(n)} times`} they fell and rose again from Odin’s hall${n >= 10 ? ', and the Valkyries know them by name' : ''}.` : 'Not once did they fall — the Valkyries are still waiting.');
    if (r.raids) lines.push(`${nf(r.raids)} ${r.raids === 1 ? 'raid' : 'raids'} came while they were there${r.survived ? `, and ${nf(r.survived)} of them they lived through` : ''}.`);
    const buddy = [...(funAll().M.inseparable || [])].filter(([k]) => k.split(PAIR).includes(p)).sort((a, b) => b[1] - a[1])[0];
    if (buddy) lines.push(`Their sworn companion was ${buddy[0].split(PAIR).find((x) => x !== p)}, at their side for ${fH(buddy[1])}.`);
    const st = d.steam && Object.values(d.steam.players).find((x) => x.chars.includes(p));
    lines.push(st?.status === 'ok' ? `Odin has written ${plural(Object.keys(st.unlocked).length, 'deed')} into their saga.` : 'The rest of their deeds the skalds are still counting.');
    return lines.join(' ');
  }
  function bucketList(p) {
    const st = S.data.steam;
    const pl = st && Object.values(st.players).find((x) => x.chars.includes(p));
    if (!pl) return el('p', { class: 'hint', text: 'No Steam account linked to this character.' });
    if (pl.status !== 'ok' && !Object.keys(pl.unlocked).length) return el('p', { class: 'hint', text: PRIVATE_NOTE });
    const next = st.achievements.filter((a) => pl.unlocked[a.k] == null && a.pct != null && !a.hidden).sort((a, b) => b.pct - a.pct).slice(0, 3);
    return el('div', null, el('h3', { text: 'Bucket list — most likely next' }), el('ul', { class: 'feed ach-feed' }, next.map((a) =>
      el('li', null, achIcon(a, false, 'ach-ico sm'), el('span', { class: 'what', title: a.d }, el('b', { text: a.n }), el('span', { class: 'hint', text: ` · ${a.d}` })),
        el('span', { class: 'hint', text: rarity(a.pct) })))));
  }
  function prophecy(p, r, x) {
    const rnd = seeded(`${p}|${hourParts(Math.floor(S.data.generated / HOUR) * HOUR).day}`);
    const worst = x.rc.filter((g) => g.ratio != null).sort((a, b) => a.ratio - b.ratio)[0];
    const hz = horoscope(p, S.min, S.max);
    const animal = (x.traits[1] || x.traits[0])?.animal;
    const opts = [
      'A tree is watching you. Do not turn your back on it.',
      'Odin sees a great feast in your future. Bring mead.',
      'The ravens whisper of treasure buried beneath your own base.',
      x.worstH != null ? `Beware the hour of ${hhLabel(x.worstH)}. It has claimed you ${plural(x.byHour[x.worstH], 'time')} already.` : null,
      x.nemesis ? `${x.nemesis[0].split(PAIR).find((y) => y !== p)} will lead you to Valhalla today. Keep your distance.` : null,
      worst && worst.ratio < 1 ? `Your ${worst.name.toLowerCase()} grade worries the gods. Today is a good day to fix it.` : null,
      animal ? `The ${animal[1].toLowerCase()} within you grows restless. ${animal[1] === 'Deer' ? 'Build something.' : 'Go explore.'}` : null,
      x.twin ? `The stars align with ${x.twin.p}${hz ? ` — ${DOW_LONG[hz.dow]} around ${hh(hz.hour)}` : ''}. Sail together.` : null,
      r.deaths.length ? `Your next death will be ${['heroic', 'embarrassing', 'caused by a tree', 'witnessed by everyone', 'entirely avoidable'][Math.floor(rnd() * 5)]}.` : 'The Valkyries grow impatient. They have never met you.',
    ].filter(Boolean);
    return opts[Math.floor(rnd() * opts.length)];
  }

  // ------------------------------------------------------------------ server health
  // The server is sampled every 10 minutes (players online, world objects). A longer silence is an outage
  // (server down — or its events not reaching the collector, which looks the same from here).
  const BEAT = 600, GAP = 900;
  function outages() {
    const s = S.data.samples, out = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i][0] - s[i - 1][0] <= GAP) continue;
      const back = S.data.restarts.find((t) => t > s[i - 1][0] && t <= s[i][0]);
      out.push({ s: s[i - 1][0], e: back ?? s[i][0], restart: back != null });
    }
    const last = s[s.length - 1];
    if (last && S.data.generated - last[0] > GAP) out.push({ s: last[0], e: null, restart: false });
    return out;
  }
  // Planned downtime (collector config "maintenance": [[from, to, note]]) doesn't count as down.
  const plannedIn = (a, b) => (S.data.maintenance || []).reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const plannedNote = (a, b) => (S.data.maintenance || []).find(([x, y]) => x <= a && b <= y)?.[2];
  const isPlanned = (o) => { const e = o.e ?? S.data.generated; return plannedIn(o.s, e) >= e - o.s - 1; };
  function uptime(a, b) {
    const s = S.data.samples;
    if (!s.length) return null;
    const from = Math.max(a, s[0][0]), to = Math.min(b, S.data.generated);
    if (to <= from) return null;
    let down = 0, planned = 0;
    for (const o of outages()) {
      const x = Math.max(from, o.s), y = Math.min(to, o.e ?? S.data.generated);
      if (y <= x) continue;
      const p = plannedIn(x, y);
      down += y - x - p;
      planned += p;
    }
    return { up: 1 - down / (to - from), down, planned, from, to };
  }
  const fPct = (x) => `${(x * 100).toLocaleString('en-GB', { maximumFractionDigits: x > 0.999 && x < 1 ? 2 : 1 })} %`;

  function serverView() {
    const d = S.data, s = d.samples;
    const up = uptime(S.a, S.b);
    const outs = outages().filter((o) => (o.e ?? d.generated) > S.a && o.s < S.b);
    const unplanned = outs.filter((o) => !isPlanned(o)), planned = outs.length - unplanned.length;
    const restarts = d.restarts.filter((t) => t >= S.a && t < S.b);
    const objs = s.filter((x) => x[2] != null);
    const objAt = (t) => [...objs].reverse().find((x) => x[0] < t)?.[2];
    const objNow = objs.length ? objs[objs.length - 1][2] : null;
    const objStart = objAt(S.a) ?? objs.find((x) => x[0] >= S.a)?.[2];
    const objEnd = objAt(S.b);
    const lastOut = outages().filter((o) => o.e != null).map((o) => o.e);
    const upSince = Math.max(...d.restarts, ...lastOut, d.first);
    const ongoing = outages().find((o) => o.e == null);

    const oc = chartHost();
    later(() => {
      const before = [...objs].reverse().find((x) => x[0] < S.a);
      const pts = [...(before ? [[S.a, before[2]]] : []), ...objs.filter((x) => x[0] >= S.a && x[0] < S.b).map((x) => [x[0], x[2]])];
      objs.length ? stepChart(oc, { a: S.a, b: S.b, pts, color: 'var(--s7)', fmtY: (v) => `${nf(v)} objects`, label: 'loaded', aria: 'World objects over time' })
        : empty(oc, 'No object counts in the log yet.');
    });
    const events = [
      ...outs.map((o) => ({ t: o.s, dur: (o.e ?? d.generated) - o.s,
        what: isPlanned(o) ? `Planned maintenance${plannedNote(o.s, o.e ?? d.generated) ? ` · ${plannedNote(o.s, o.e ?? d.generated)}` : ''}`
          : o.e == null ? 'No heartbeat — still silent' : o.restart ? 'Down, came back with a restart' : 'No heartbeat' })),
      ...restarts.filter((t) => !outs.some((o) => o.restart && o.e === t)).map((t) => ({ t, dur: null, what: plannedIn(t - 1, t) ? `Planned restart${plannedNote(t - 1, t) ? ` · ${plannedNote(t - 1, t)}` : ''}` : 'Restart' })),
    ].sort((x, y) => y.t - x.t);
    const table = events.length ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'When' }), el('th', { class: 'r', text: 'Silent for' }), el('th', { text: 'What' }))),
      el('tbody', null, events.map((e) => el('tr', null, el('td', { text: fDateTime(e.t) }),
        el('td', { class: 'r', text: e.dur == null ? '–' : `~${fDur(e.dur)}` }), el('td', { text: e.what }))))))
      : el('div', { class: 'empty-state', text: 'No restarts or outages in this range.' });

    return [
      ...subHead('Server', d.version ? `Valheim ${d.version}` : null),
      kpiRow(
        kpi('Uptime', up ? fPct(up.up) : '–', up ? `${fDur(up.down)} down${up.planned ? ` · ${fDur(up.planned)} planned` : ' in range'}` : 'no heartbeat data'),
        kpi(ongoing ? 'Silent since' : 'Up since', ongoing ? fDateTime(ongoing.s) : fDateTime(upSince), ongoing ? 'no heartbeat in the log' : fDur(d.generated - upSince)),
        kpi('Outages', nf(unplanned.length), unplanned.length ? `longest ~${fDur(Math.max(...unplanned.map((o) => (o.e ?? d.generated) - o.s)))}` : planned ? `${plural(planned, 'planned maintenance', 'planned maintenances')} not counted` : 'none in range'),
        kpi('Restarts', nf(restarts.length), restarts.length ? `last ${fAgo(d.generated - restarts[restarts.length - 1])}` : 'none in range'),
        kpi('World objects', objNow != null ? nf(objNow) : '–', objStart != null && objEnd != null ? `${objEnd >= objStart ? '+' : '−'}${nf(Math.abs(objEnd - objStart))} in range` : 'loaded by the server')),
      el('div', { class: 'grid' },
        card('World objects', 'Objects (ZDOs) the server holds — grows as the world is explored and built on', oc, 'span-12'),
        card('Restarts & outages', `An outage is more than ${fDur(GAP)} without the 10-minute heartbeat; durations are ±10 min · planned maintenance doesn't count as down`, table, 'span-12')),
    ];
  }

  const fightTitle = (id) => { const f = (S.data.fights || []).find((x) => x.id === id); return f ? `${fightName(f)} · ${fDate(f.s)}` : 'Boss fight'; };
  const VIEWS = { sessions: sessionsView, deaths: deathsView, raids: raidsView, unaccounted: unaccountedView, world: worldView, base: baseView, items: itemsView, item: itemView, creature: creatureView, server: serverView, achievements: achievementsView, bosses: bossesView, fight: fightView, ranking: rankingView, pets: petsView, pet: petView, search: searchView, scoring: scoringView };
  // ------------------------------------------------------------------ how scoring works (#/scoring)
  // The rules this server's page and Discord feed compute from (data.scoring: scoring.json with the server's overrides),
  // with what the server changed marked. docs/SCORING.md is the same for server owners, with how to change it.
  function scoringView() {
    const R = SC(), changed = S.data.scoring.changed || {};
    const show = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.name || x.icon : nf(x))).join(', ') : typeof v === 'number' ? nf(v) : String(v));
    // a value the server set: marked, the default on hover
    const mark = (path, text) => (path in changed ? el('span', { class: 'changed', title: `Set by this server · default: ${show(changed[path])}` }, text, ' ✎') : text);
    const table = (head, rows) => el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, head.map((h, i) => el('th', { class: i && typeof h === 'string' && h.startsWith(' ') ? 'r' : null, text: h.trim() })))),
      el('tbody', null, rows.map((r) => el('tr', null, r.map((x, i) => el('td', { class: i && head[i].startsWith(' ') ? 'r' : null }, x)))))));
    const off = Object.keys(changed).filter((k) => k.endsWith('.enabled')).map((k) => k.slice(0, -8));
    const p = (text) => el('p', { class: 'explain keep', text });  // here the explanations are the content: no ⓘ
    const out = [];

    // impact
    const bonus = Object.entries(R.impact.bonus).filter(([, w]) => w > 0), pen = Object.entries(R.impact.penalty).filter(([, w]) => w > 0);
    const tot = bonus.reduce((n, [, w]) => n + w, 0);
    const unused = [...Object.entries(R.impact.bonus), ...Object.entries(R.impact.penalty)].filter(([, w]) => !w).map(([k]) => COL_LABEL[k]);
    out.push(withId(card('Impact score', 'The leaderboard’s first column: what a player contributed in the range, 0–100', el('div', null,
      table(['Stat', ' Weight', ' Share of 100'], [
        ...bonus.map(([k, w]) => [COL_LABEL[k], mark(`impact.bonus.${k}`, nf(w)), `${nf((w / tot) * 100, 1)}`]),
        ...pen.map(([k, w]) => [`${COL_LABEL[k]} (penalty)`, mark(`impact.penalty.${k}`, nf(w)), `up to −${nf(w)}`])]),
      p('Each bonus stat counts against the best player in the range on a log scale: log₁₀(1 + 9 × value ÷ best) — the best gets 1, half the best 0.74, a tenth 0.28, nothing 0. So one player with 300 hours doesn’t flatten everyone else.'),
      p('The weights of the stats that say something in the range add up to 100 (a stat everyone is equal in, or Built without a world save, drops out and the rest are scaled up).'),
      p('A penalty is value ÷ the worst value among players with at least 1 h in the range, times its weight; under 1 h nobody pays a penalty. Impact = bonuses − penalties, never below 0.'),
      unused.length ? p(`Not counted here: ${unused.filter(Boolean).join(', ')}.`) : null), 'span-12'), 'impact'));

    // titles
    const defs = awardDefs();
    out.push(withId(card('Titles', 'One holder at a time — the best value in the range takes it, ties share', el('div', null,
      ...Object.entries(R.title_groups).map(([g, label]) => {
        const ts = defs.filter((t) => t.g === g);
        return ts.length ? el('div', null, el('h3', null, mark(`title_groups.${g}`, label)), table(['Title', 'Rule', ' Needs'], ts.map((t) => [
          mark(`titles.${t.k}.title`, `${t.ico} ${t.t}`), mark(`titles.${t.k}.rule`, t.rule),
          t.low ? 'lowest wins' : mark(`titles.${t.k}.min`, t.min < 1e-6 ? 'any' : `≥ ${t.f(t.min, [])}`)]))) : null;
      }),
      p('“Current world” titles read the latest world save, the others the selected range. The Discord feed (when set up) announces when a title changes hands — every title except Combat & gathering, which only the page computes.'),
      off.some((k) => k.startsWith('titles.')) ? p(`Switched off on this server: ${off.filter((k) => k.startsWith('titles.')).map((k) => k.slice(7)).join(', ')}.`) : null), 'span-12'), 'titles'));

    // medals
    out.push(withId(card('Medals', 'Top three of every leaderboard column', el('div', null,
      p('Every leaderboard column gives 🥇 🥈 🥉 to the top three in the range (fewer-is-better columns: players with at least 1 h). Ties share a place.'),
      p(`The Discord feed posts leaderboard shake-ups, all time, for: ${Object.entries(R.medals).map(([k, m]) => m.label).join(', ') || 'none'}.`)), 'span-6'), 'medals'));

    // milestones
    const ms = R.milestones;
    out.push(withId(card('Milestones', 'Round numbers — on the page (“Coming up”) and in the Discord feed', table(['Milestone', 'Steps'], [
      ['A player’s hours on the server', mark('milestones.player_hours', show(ms.player_hours))],
      ['Player-hours, all players', mark('milestones.hours', show(ms.hours))], ['Zones explored', mark('milestones.zones', show(ms.zones))],
      ['Pieces standing', mark('milestones.pieces', show(ms.pieces))], ['Deaths', mark('milestones.deaths', show(ms.deaths))],
      ['Kills, trees felled, items collected (page only)', mark('milestones.count', show(ms.count))],
      ['In-game days', mark('milestones.day_every', ms.day_every ? `every ${nf(ms.day_every)}` : 'off')]]), 'span-6'), 'milestones'));

    // badges
    const tiers = R.badge_tiers;
    out.push(withId(card('Badges', 'A player’s own all-time progress, from the server plugin — not a ranking', table(
      ['Badge', 'Counts', ...tiers.map((t, i) => ` ${t.icon} ${t.name}`)],
      Object.entries(R.badges).map(([k, b]) => [mark(`badges.${k}.name`, `${b.icon} ${b.name}`), b.unit,
        ...b.steps.map((v, i) => (i ? nf(v) : mark(`badges.${k}.steps`, nf(v))))])), 'span-12'), 'badges'));

    // trading cards
    const cr = R.cards;
    const statOf = { survived: 'Raids (raids survived)', built: 'Building (pieces built)', zones: 'Exploring (zones discovered)', dealt: 'Combat (damage dealt)', picked: 'Gathering (items picked up)' };
    out.push(withId(card('Trading cards', 'All time, on fixed yardsticks: their own progress, not a ranking', el('div', null,
      table(['Stat', ' 99 at'], [...Object.entries(cr.at).map(([k, v]) => [statOf[k] || k, mark(`cards.at.${k}`, nf(v))]),
        ['Survival (deaths per hour played)', mark('cards.dph', `50 at ${nf(cr.dph, 2)}/h`)]]),
      p('A stat is 99 × √(value ÷ its yardstick), at most 99 — a quarter of the yardstick gives 50. Survival is 99 ÷ (1 + deaths per hour ÷ the survival yardstick): 99 without deaths, 50 at the yardstick. Combat and Gathering only count where the server plugin logs them.'),
      el('p', { class: 'explain keep' }, 'Rarity from the average of the stats: Rare from ', mark('cards.tiers.rare', nf(cr.tiers.rare)), ', Epic from ',
        mark('cards.tiers.epic', nf(cr.tiers.epic)), ', Legendary from ', mark('cards.tiers.legendary', nf(cr.tiers.legendary)),
        '. A card keeps the best rarity it ever reached; a top-level badge makes it foil.')), 'span-6'), 'cards'));

    // traits
    out.push(withId(card('Bynames & spirit animals', 'What a player stands out in most, all time', el('div', null,
      table(['Trait', 'Byname', 'Animal', ' Weight'], Object.entries(R.traits).map(([k, t]) =>
        [k, mark(`traits.${k}.byname`, t.byname), `${t.icon} ${t.animal}`, mark(`traits.${k}.weight`, nf(t.weight, 1))])),
      p('A trait scores weight × the player’s value ÷ the best other player’s (at most 2; others need ≥1 h). The best trait gives the byname, the second the spirit animal.')), 'span-6'), 'traits'));

    // grades
    const subj = Object.entries(R.grades.subjects);
    out.push(withId(card('Report card', 'Fixed steps per subject, all time — not graded against the others', el('div', null,
      table(['Subject', ...GRADES.map((g) => ` ${g}`)], subj.map(([k, x]) => [mark(`grades.subjects.${k}.name`, x.name),
        ...x.steps.map((v, i) => (i ? `${x.low ? '≤' : '≥'} ${SUBJECT_VALUE[k][1](v)}` : mark(`grades.subjects.${k}.steps`, `${x.low ? '≤' : '≥'} ${SUBJECT_VALUE[k][1](v)}`)))])),
      el('p', { class: 'explain keep' }, 'Below D is F. Grades start after ', mark('grades.min_hours', `${nf(R.grades.min_hours)} h`), ' on the server.')), 'span-12'), 'grades'));

    const n = Object.keys(changed).length;
    return [...subHead('How scoring works', n ? `${plural(n, 'rule')} set by this server — marked ✎, hover for the default` : 'the default rules', true),
      el('div', { class: 'grid', style: { marginTop: '14px' } }, out)];
  }

  const VIEW_TITLE = { sessions: 'Sessions', deaths: 'Deaths', raids: 'Raids', unaccounted: 'Unaccounted kills', world: 'World', base: 'Base & gear', items: 'Items', item: 'Item', server: 'Server', achievements: 'Achievements', bosses: 'Boss fights', pets: 'Pets', search: 'Search', scoring: 'How scoring works' };

  // ------------------------------------------------------------------ routing / range

  // The hash carries the page, plus two extras every page understands: `card` (scroll to that card)
  // and `range` (the time range, see rangeParam). route() ignores both.
  function splitHash(hash) {
    const i = hash.indexOf('?');
    return i < 0 ? { path: hash || '#/', q: new URLSearchParams() } : { path: hash.slice(0, i) || '#/', q: new URLSearchParams(hash.slice(i + 1)) };
  }
  function withMeta(hash, meta = {}) {
    const { path, q } = splitHash(hash);
    for (const k of ['card', 'range']) { q.delete(k); if (meta[k]) q.set(k, meta[k]); }
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  }
  const metaOf = (hash = location.hash) => { const { q } = splitHash(hash); return { card: q.get('card'), range: q.get('range') }; };
  function route(hash = location.hash) {
    hash = withMeta(hash);
    let m = hash.match(/^#\/p\/([^/]+)(?:\/(activity|combat|gear|saga))?$/);
    if (m) return { player: decodeURIComponent(m[1]), tab: m[2] || 'overview' };
    m = hash.match(/^#\/item\/(.+)$/);
    if (m) return { view: 'item', arg: decodeURIComponent(m[1]) };
    m = hash.match(/^#\/creature\/(.+)$/);
    if (m) return { view: 'creature', arg: decodeURIComponent(m[1]) };
    m = hash.match(/^#\/fight\/(.+)$/);
    if (m) return { view: 'fight', arg: decodeURIComponent(m[1]) };
    m = hash.match(/^#\/pet\/(.+)$/);
    if (m) return { view: 'pet', arg: decodeURIComponent(m[1]) };
    m = hash.match(/^#\/ranking\/(\w+)$/);
    if (m) return { view: 'ranking', arg: m[1] };
    m = hash.match(/^#\/(sessions|deaths|raids|unaccounted|world|base|items|server|achievements|bosses|pets|search|scoring)(?:\?(.*))?$/);
    if (m) return { view: m[1], q: new URLSearchParams(m[2] || '') };
    return {};
  }
  // ---- back links: the pages clicked through, so "back" goes where you came from, not always to the overview.
  // One step per page: other tabs of a player or another filter of a list replace the step instead of adding one.
  const pageGroup = (r) => (r.player ? `p/${r.player}` : r.view ? `${r.view}/${r.arg || ''}` : 'home');
  function pageTitle(r) {
    if (r.player) return r.player;
    if (!r.view) return 'Overview';
    if (r.view === 'item') return itemName(r.arg);
    if (r.view === 'creature') return gatherLabel(r.arg);
    if (r.view === 'fight') return fightTitle(r.arg);
    if (r.view === 'ranking') return RANKINGS[r.arg]?.title || 'Ranking';
    if (r.view === 'pet') { const p = (S.data.pets || []).find((x) => x.k === r.arg); return p ? petName(p) : 'Pet'; }
    return VIEW_TITLE[r.view] || 'Back';
  }
  // On every navigation; returns the scroll position to restore when it went back a step.
  function trailStep(prevY) {
    const t = S.trail, hash = location.hash || '#/', g = pageGroup(route());
    if (t.length) t[t.length - 1].y = prevY;
    if (g === 'home') { S.trail = [{ hash, g, y: 0 }]; return null; }
    if (t.length >= 2 && t[t.length - 2].g === g) { t.pop(); t[t.length - 1].hash = hash; return t[t.length - 1].y; }
    if (t.length && t[t.length - 1].g === g) { t[t.length - 1].hash = hash; return null; }
    t.push({ hash, g, y: 0 });
    return null;
  }
  // Where this page sits (Overview › World › Items › Iron), led by a back link to the page before,
  // by the browser's own history — only when there is one (not for a link opened directly).
  function crumbs() {
    const r = route(), w = navWhere(r), g = navGroups().find((x) => x.k === w.g);
    const list = [['Overview', '#/']];
    if (g && g.k !== 'overview') {
      const pg = g.pages?.find((x) => x.k === w.k);
      if (!pg || pg.label !== g.label) list.push([g.label, null]);
      if (pg) list.push([pg.label, pg.href]);
    }
    const here = pageTitle(r), detail = !!r.player || ['item', 'creature', 'fight', 'pet', 'ranking'].includes(r.view);
    if ((detail || !g?.pages?.some((x) => x.k === w.k)) && list[list.length - 1][0] !== here) list.push([here, null]);
    const prev = S.trail.length >= 2 ? S.trail[S.trail.length - 2] : null;
    return el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
      prev ? el('a', { class: 'back', href: prev.hash, title: `Back to ${pageTitle(route(prev.hash))}`, text: '← Back',
        onclick: (e) => { e.preventDefault(); history.back(); } }) : null,
      el('ol', null, list.map(([t, href], i) => el('li', null, i === list.length - 1 ? el('span', { 'aria-current': 'page', text: t })
        : href ? el('a', { href, text: t }) : el('span', { text: t })))));
  }
  // ------------------------------------------------------------------ navigation
  // Desktop: a sidebar with the page groups, the players and the current page's cards (scroll-spied);
  // it folds to an icon rail (remembered), and is a rail below 1200 px that opens over the page.
  // Phones: a tab bar at the bottom; a group opens its pages in a sheet.

  const WIDE = '(min-width: 1200px)', PHONE = '(max-width: 640px)';
  const NAV_ICON = {
    overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    players: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    combat: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/>',
    world: '<path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
    achievements: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
    more: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    collapse: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
    expand: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    cmd: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    card: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    pet: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  };
  function navIcon(k, size = 18) {
    const s = sv('svg', { class: 'nav-ico', viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    s.innerHTML = NAV_ICON[k];
    return s;
  }
  // localStorage can be missing or throw (private mode, blocked site data): then nothing is remembered.
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* nothing to forget */ } },
  };
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Groups and their pages; a page only once there is data for it.
  function navGroups() {
    const d = S.data || {};
    const page = (k, label, href) => ({ k, label, href });
    return [
      { k: 'overview', label: 'Overview', href: '#/' },
      { k: 'players', label: 'Players', href: '#/?card=leaderboard', players: true,
        pages: [page('leaderboard', 'Leaderboard', '#/?card=leaderboard'), page('sessions', 'Sessions', '#/sessions'), page('scoring', 'Scoring', '#/scoring')] },
      { k: 'combat', label: 'Combat', href: d.fights?.length ? '#/bosses' : '#/deaths',
        pages: [d.fights?.length ? page('bosses', 'Boss fights', '#/bosses') : null, page('deaths', 'Deaths', '#/deaths'), page('raids', 'Raids', '#/raids'),
          d.gather?.length ? page('ranking', 'Rankings', '#/ranking/killers') : null,
          d.gather?.some((g) => g[2] === 'ukill') ? page('unaccounted', 'Unaccounted kills', '#/unaccounted') : null].filter(Boolean) },
      { k: 'world', label: 'World', href: '#/world',
        pages: [page('world', 'Map & exploration', '#/world'), d.world ? page('base', 'Base & gear', '#/base') : null,
          d.world ? page('items', 'Items', '#/items') : null, d.pets?.length ? page('pets', 'Pets', '#/pets') : null].filter(Boolean) },
      d.steam ? { k: 'achievements', label: 'Achievements', href: '#/achievements' } : null,
      { k: 'server', label: 'Server', href: '#/server' },
    ].filter(Boolean);
  }
  // Which group and page a route belongs to (detail pages count as their list).
  function navWhere(r) {
    if (r.player) return { g: 'players', k: `p:${r.player}` };
    switch (r.view) {
      case undefined: return { g: 'overview', k: 'overview' };
      case 'sessions': case 'scoring': return { g: 'players', k: r.view };
      case 'bosses': case 'fight': return { g: 'combat', k: 'bosses' };
      case 'deaths': case 'raids': case 'unaccounted': return { g: 'combat', k: r.view };
      case 'ranking': return { g: 'combat', k: 'ranking' };
      case 'creature': return { g: 'combat', k: null };
      case 'item': return { g: 'world', k: 'items' };
      case 'pet': return { g: 'world', k: 'pets' };
      case 'world': case 'base': case 'items': case 'pets': return { g: 'world', k: r.view };
      default: return { g: r.view, k: r.view };
    }
  }
  // A link to a card on the page that is already open: no navigation (the hash may not even change), just scroll.
  const sameCard = (href) => (e) => {
    const card = metaOf(href).card;
    if (!card || withMeta(href) !== withMeta(location.hash || '#/') || !document.getElementById(card)) return;
    e.preventDefault();
    closeSheet(); closeNavOverlay();
    jumpTo(card);
  };
  const navLink = (href, on, ...kids) => el('a', { class: 'sn-link', href, 'aria-current': on ? 'page' : null, onclick: sameCard(href) }, kids);

  // The most active players, plus whoever is online or open; the rest behind a button.
  function navPlayers(cur) {
    const online = new Set(S.data.online), all = S.players;
    const keep = S.navAll ? all : all.filter((p, i) => i < 8 || online.has(p) || p === cur);
    return [
      el('li', { class: 'sn-label', text: 'Vikings' }),
      keep.map((p) => el('li', null, navLink(`#/p/${encodeURIComponent(p)}`, p === cur,
        el('i', { class: 'sw', style: { background: colorOf(p) } }), el('span', { class: 'sn-text', text: p }),
        p === me() ? el('span', { class: 'sn-you', text: 'you' }) : null,
        online.has(p) ? el('span', { class: 'sn-on', title: 'Online now', 'aria-label': 'online' }) : null))),
      keep.length < all.length || S.navAll ? el('li', null, el('button', { type: 'button', class: 'sn-more',
        text: S.navAll ? 'Show fewer' : `All ${nf(all.length)} players`,
        onclick: () => { S.navAll = !S.navAll; renderNav(); if (!$('#sheet').hidden) openSheet(S.sheetK); } })) : null,
    ];
  }
  // numbered: g then the number jumps there (two digits on long pages)
  const tocList = () => el('ul', { class: 'sn-toc-list' }, S.sections.map((x, i) => el('li', null,
    el('a', { class: 'sn-link', href: withMeta(location.hash || '#/', { card: x.id, range: rangeParam() }), 'data-card': x.id,
      title: `${x.label} (g then ${i + 1})`, 'aria-keyshortcuts': `g ${[...String(i + 1)].join(' ')}`,
      onclick: (e) => { e.preventDefault(); closeSheet(); closeNavOverlay(); jumpTo(x.id); } },
    el('span', { class: 'sn-num', 'aria-hidden': 'true', text: String(i + 1) }), x.label))));

  function navMode() {
    const mode = matchMedia(PHONE).matches ? 'none' : matchMedia(WIDE).matches && store.get('gs.nav') !== 'rail' ? 'full' : 'rail';
    document.documentElement.dataset.nav = mode;
    return mode;
  }
  function toggleNav() {
    const side = $('#sidenav');
    if (matchMedia(WIDE).matches && !side.classList.contains('open')) {
      store.set('gs.nav', navMode() === 'full' ? 'rail' : 'full');
      navMode();
    } else side.classList.toggle('open');
    renderNav();
  }
  function closeNavOverlay() {
    const side = $('#sidenav');
    if (!side.classList.contains('open')) return;
    side.classList.remove('open');
    renderNav();
  }

  function renderNav() {
    if (!S.data) return;
    const r = route(), w = navWhere(r), side = $('#sidenav');
    const open = side.classList.contains('open'), rail = navMode() === 'rail' && !open;
    const groups = el('ul', { class: 'sn-groups' }, navGroups().map((g) => {
      const active = g.k === w.g, pages = g.pages || [];
      return el('li', { class: `sn-group${active ? ' active' : ''}` },
        el('a', { class: 'sn-link sn-top', href: g.href, title: keyTitle(g.label, pages.length ? `${g.k}:group` : g.k),
          'aria-keyshortcuts': goKey(pages.length ? `${g.k}:group` : g.k) ? `g ${goKey(pages.length ? `${g.k}:group` : g.k)}` : null,
          'aria-current': !pages.length && active ? 'page' : null, onclick: sameCard(g.href) },
          navIcon(g.k), el('span', { class: 'sn-text', text: g.label })),
        pages.length ? el('ul', { class: 'sn-sub' },
          pages.map((pg) => el('li', null, Object.assign(navLink(pg.href, active && pg.k === w.k, el('span', { class: 'sn-text', text: pg.label })), { title: keyTitle(pg.label, pg.k) },
            goKey(pg.k) ? { ariaKeyShortcuts: `g ${goKey(pg.k)}` } : null))),
          g.players ? navPlayers(r.player) : null) : null);
    }));
    const toc = S.sections?.length > 1 ? el('div', { class: 'sn-toc' }, el('div', { class: 'sn-label', text: 'On this page' }), tocList()) : null;
    const label = open ? 'Close' : rail ? 'Expand the sidebar' : 'Collapse';
    side.replaceChildren(meEntry(rail), groups, toc, el('button', { type: 'button', class: 'sn-toggle', title: label, 'aria-label': label, 'aria-expanded': String(!rail), onclick: toggleNav },
      navIcon(rail ? 'expand' : 'collapse', 16), el('span', { class: 'sn-text', text: open ? 'Close' : 'Collapse' })));
    renderTabbar(w);
    spy();
  }

  function renderTabbar(w) {
    const tab = (k, label, on, attrs) => el(attrs.href ? 'a' : 'button', { type: attrs.href ? null : 'button', class: 'tab', 'aria-current': on ? 'page' : null, ...attrs },
      navIcon(k, 20), el('span', { text: label }));
    const groups = navGroups(), main = groups.filter((g) => ['overview', 'players', 'combat', 'world'].includes(g.k));
    $('#tabbar').replaceChildren(...main.map((g) => (g.k === 'overview' ? tab(g.k, g.label, w.g === g.k, { href: '#/' })
      : tab(g.k, g.label, w.g === g.k, { 'aria-haspopup': 'dialog', onclick: (e) => openSheet(g.k, e.currentTarget) }))),
    tab('search', 'Search', w.g === 'search', { 'aria-haspopup': 'dialog', onclick: () => openPalette() }),
    tab('more', 'More', !main.some((g) => g.k === w.g) && w.g !== 'search', { 'aria-haspopup': 'dialog', onclick: (e) => openSheet('more', e.currentTarget) }));
  }

  // ---- phones: a group's pages in a sheet over the tab bar
  let sheetFrom = null;
  function openSheet(k, from) {
    const r = route(), w = navWhere(r), groups = navGroups(), g = groups.find((x) => x.k === k);
    const list = (items) => el('ul', { class: 'sheet-list' }, items);
    let body;
    if (g) {
      body = [el('div', { class: 'sheet-title', text: g.label }),
        list([...g.pages.map((pg) => el('li', null, navLink(pg.href, w.g === g.k && pg.k === w.k, pg.label))), g.players ? navPlayers(r.player) : null])];
    } else {
      const solo = groups.filter((x) => !x.pages && x.k !== 'overview');  // Overview has its own tab
      body = [el('div', { class: 'sheet-title', text: 'You' }), meEntry(false, true), el('div', { class: 'sheet-title', text: 'More' }),
        list(solo.map((x) => el('li', null, navLink(x.href, w.g === x.k, navIcon(x.k, 16), x.label)))),
        S.sections?.length > 1 ? [el('div', { class: 'sheet-title', text: 'On this page' }), tocList()] : null];
    }
    const panel = $('#sheet-panel');
    panel.setAttribute('aria-label', g ? g.label : 'More');
    panel.replaceChildren(el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }), ...body.flat());
    $('#sheet').hidden = false;
    document.body.classList.add('sheet-open');
    S.sheetK = k;
    if (from) sheetFrom = from;
    panel.focus();
    spy();
  }
  function closeSheet() {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    sheetFrom?.focus();
    sheetFrom = null;
  }

  // ---- cards: each gets a stable id from its title and a copy-link button
  const slug = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card';
  function decorateCards() {
    const out = [], all = [];
    for (const c of document.querySelectorAll('#view .card')) {
      const h = c.querySelector(':scope > .card-head > h2, :scope > summary > .card-head > h2');
      if (!h) continue;
      const label = h.textContent;
      if (!c.id) {
        const base = slug(label);
        let id = base, n = 1;
        while (document.getElementById(id)) id = `${base}-${++n}`;
        c.id = id;
      }
      h.append(el('a', { class: 'card-link', href: withMeta(location.hash || '#/', { card: c.id, range: rangeParam() }),
        title: 'Copy a link to this card', 'aria-label': `Copy a link to “${label}”`,
        onclick: (e) => { e.preventDefault(); copyCardLink(c.id); } }, navIcon('link', 13)));
      all.push({ id: c.id, label });
      if (!c.parentElement.closest('details')) out.push({ id: c.id, label });  // folded-away cards: their section is listed instead
    }
    S.sections = out;
    const r = route();  // list pages' cards stay searchable after leaving the page
    if (!r.player && !['item', 'creature', 'fight', 'pet', 'search'].includes(r.view)) S.seen.set(withMeta(location.hash || '#/'), { title: pageTitle(r), sections: all });
    const used = new Set();
    for (const h of document.querySelectorAll('#view .card-head > .hint, #view .phead .meta')) if (!h.closest('summary')) glossarize(h, used);
    foldInfo();
  }

  // ---- ⓘ: a card's explanations behind one small button in its title, so they don't crowd the numbers. Folded: the
  // subtitle when it's long or doesn't fit on one line, and every explanation paragraph (.explain; .keep ones stay —
  // where the explanation is the content). A page's subtitle the same, next to its heading. Measured again when the
  // width changes (what wraps on a phone fits on a desktop) and when a folded-away section opens.
  const INFO_LONG = 90;  // characters: longer than this folds even when it fits
  function lines(n) {
    const r = document.createRange();
    r.selectNodeContents(n);
    return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
  }
  function foldInfo() {
    const groups = [];
    for (const c of document.querySelectorAll('#view .card')) {
      const h = c.querySelector(':scope > .card-head > h2, :scope > summary > .card-head > h2');
      if (h) groups.push([c.id, h, [...c.querySelectorAll(':scope > .card-head > .hint, :scope .explain:not(.keep)')].filter((n) => n.closest('.card') === c)]);
    }
    const ph = document.querySelector('#view .phead'), h1 = ph?.querySelector('h1'), meta = ph?.querySelector('.meta');
    if (h1 && meta) groups.push(['page', h1, [meta]]);
    for (const [id, head, texts] of groups) {
      head.querySelector(':scope > .info-btn')?.remove();
      for (const n of texts) n.hidden = false;
      const fold = texts.filter((n) => n.classList.contains('explain') || n.textContent.length > INFO_LONG || lines(n) > 1);
      if (!fold.length) continue;
      const open = S.infoOpen.has(`${location.hash}|${id}`);
      for (const n of fold) n.hidden = !open;
      const btn = el('button', { type: 'button', class: 'info-btn', 'aria-expanded': String(open), title: open ? 'Hide the explanation' : 'What is this?',
        'aria-label': `${open ? 'Hide' : 'Show'} the explanation`,  // the i is CSS: a title's text stays its name
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();  // a card title inside <summary> must not fold the section
          const k = `${location.hash}|${id}`, now = !S.infoOpen.has(k);
          if (now) S.infoOpen.add(k); else S.infoOpen.delete(k);
          for (const n of fold) n.hidden = !now;
          btn.setAttribute('aria-expanded', String(now));
          btn.title = now ? 'Hide the explanation' : 'What is this?';
          btn.setAttribute('aria-label', `${now ? 'Hide' : 'Show'} the explanation`);
        } });
      head.insertBefore(btn, head.querySelector(':scope > .card-link'));
    }
  }
  let infoW = innerWidth, infoRaf = 0;
  addEventListener('resize', () => {
    if (innerWidth === infoW) return;  // a phone's URL bar showing or hiding changes only the height
    infoW = innerWidth;
    cancelAnimationFrame(infoRaf);
    infoRaf = requestAnimationFrame(foldInfo);
  }, { passive: true });
  document.addEventListener('toggle', (e) => { if (e.target.tagName === 'DETAILS' && e.target.open) foldInfo(); }, true);
  document.fonts?.ready.then(() => { if (S.data) foldInfo(); });
  // A card inside a folded section: unfold it first.
  function reveal(n) {
    for (let d = n.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  }

  // ---- glossary: the first mention of a term per page explains itself on hover, focus or tap
  const GLOSSARY = [
    [/\bplayer-hours?\b/i, 'Player-hours', 'Time online added up over all players: two Vikings playing for an hour make two player-hours.'],
    [/\bzones?\b/i, 'Zone', 'The world is built from 64 × 64 m squares, each generated the first time someone comes near. A new zone is new ground explored.'],
    [/\braids?\b/i, 'Raid', RAID_TEXT],
    [/\b(?:world objects|ZDOs?)\b/i, 'World objects', 'Everything the server keeps track of — buildings, dropped items, creatures, trees … (“ZDOs” in the game). Grows as the world is explored and built on.'],
    [/\bhealth removed\b/i, 'Health removed', 'Damage as the health a creature actually lost, after armour and resistances — not the number shown on hit, and never more than the health it had left.'],
    [/\bstars?\b/i, 'Stars', 'Creatures can spawn with one or two stars: more health (×2, ×3), harder hits and better drops.'],
    [/\b(?:world save|hourly snapshot|last save)\b/i, 'World save', 'The server saves the world about once an hour. Chests, buildings, pets and tames are read from that save, so they can be up to an hour old.'],
    [/\bserver plugin\b/i, 'Server plugin', 'A small add-on on the game server that logs combat, gathering, pets and equipment. Those numbers only exist since it was installed.'],
  ];
  function glossarize(root, used) {
    for (const [re, name, text] of GLOSSARY) {
      if (used.has(name)) continue;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (t.parentElement.closest('.term, a')) continue;
        const m = re.exec(t.data);
        if (!m) continue;
        const word = t.splitText(m.index);
        word.splitText(m[0].length);
        word.replaceWith(termTip(el('span', { class: 'term', tabindex: '0', role: 'button', 'aria-label': `${m[0]} — ${text}`, text: m[0] }), name, text));
        used.add(name);
        break;
      }
    }
  }
  function termTip(n, name, text) {
    const show = (e) => tip(e, el('div', { class: 't', text: name }), el('div', { class: 'note', text }));
    n.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(e); });
    n.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') untip(); });
    n.addEventListener('focus', show);
    n.addEventListener('blur', untip);
    n.addEventListener('click', (e) => { e.stopPropagation(); show(e); });
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show({ target: n, type: 'focus' }); } });
    return n;
  }
  function jumpTo(id) {
    const n = document.getElementById(id);
    if (!n) return;
    spyLock = id;
    reveal(n);
    if (n.tagName === 'DETAILS') n.open = true;
    S.card = id;
    syncUrl();
    n.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    n.classList.remove('flash');
    void n.offsetWidth;  // restart the animation
    n.classList.add('flash');
    spy();  // the jumped-to card is the current one even when nothing has to scroll
  }
  function copyCardLink(id) {
    S.card = id;
    syncUrl();
    const url = location.href;
    const ask = () => prompt('Copy this link:', url);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast('Link copied'), ask);
    else ask();
  }
  let toastT = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // ---- scroll-spy: the card at the top of the screen (below the pinned bars) is the current one. Cards side by side share a
  // top: a row counts as its first card. Right after a jump (a click in the list, g + number) it is the card jumped to,
  // until the visitor scrolls themselves — the end of the page, or a row, can't bring every card to the top.
  let spyRaf = 0, spied = null, spyLock = null;
  const unlockSpy = () => { if (spyLock) { spyLock = null; spy(); } };
  addEventListener('wheel', unlockSpy, { passive: true });
  addEventListener('touchmove', unlockSpy, { passive: true });
  addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'u', 'd'].includes(e.key) && !e.target.closest?.('input, textarea')) unlockSpy(); });
  addEventListener('hashchange', () => { spyLock = null; });
  function spy() {
    spyRaf = 0;
    const links = document.querySelectorAll('.sn-toc-list a[data-card]');
    if (!links.length || !S.sections?.length) return;
    const css = getComputedStyle(document.documentElement);
    const line = (parseFloat(css.getPropertyValue('--top-h')) || 0) + (parseFloat(css.getPropertyValue('--filters-h')) || 0) + 24;
    let cur = null;
    if (spyLock && document.getElementById(spyLock)) cur = spyLock;
    else {
      const tops = S.sections.map((x) => [x.id, document.getElementById(x.id)?.getBoundingClientRect().top]).filter((t) => t[1] != null);
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const cut = atEnd ? Math.max(...tops.map((t) => t[1])) : line;  // at the end: the last row
      let best = -Infinity;
      for (const [id, top] of tops) if (top <= cut + 1 && top > best + 1) { best = top; cur = id; }
    }
    for (const a of links) {
      if (a.dataset.card === cur) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    }
    // keep the current entry in view inside the sidebar, without moving the page
    const side = $('#sidenav'), a = cur && side.querySelector(`a[data-card="${CSS.escape(cur)}"]`);
    if (a && cur !== spied && side.scrollHeight > side.clientHeight) {
      const sr = side.getBoundingClientRect(), ar = a.getBoundingClientRect();
      if (ar.top < sr.top + 40 || ar.bottom > sr.bottom - 40) side.scrollTop += ar.top - sr.top - sr.height / 2;
    }
    spied = cur;
  }

  // ---- the time range in the URL, so a shared link shows what the sender saw. Presets by name,
  // whole days as dates (last day included), anything else in epoch seconds; 30 days is the default.
  const PRESET_PARAM = { 1: '24h', 7: '7d', 30: '30d', 0: 'all' };
  function rangeParam() {
    if (!S.data || S.preset === 30) return null;
    if (S.preset != null && PRESET_PARAM[S.preset]) return PRESET_PARAM[S.preset];
    const whole = (t) => dayStart(dayOf(t)) === t;
    return `${whole(S.a) ? dayOf(S.a) : S.a}..${S.b >= S.max ? 'now' : whole(S.b) ? dayOf(S.b - 1) : S.b}`;
  }
  function applyRangeParam(v) {
    if (!v) return false;
    const pre = Object.keys(PRESET_PARAM).find((k) => PRESET_PARAM[k] === v);
    if (pre != null) { applyPreset(Number(pre)); return true; }
    const m = v.match(/^([\d-]+)\.\.([\d-]+|now)$/);
    if (!m) return false;
    const when = (x, end) => (x === 'now' ? S.max : /^\d+$/.test(x) ? Number(x)
      : /^\d{4}-\d\d-\d\d$/.test(x) ? (end ? dayStart(dayOf(dayStart(x) + DAY + 2 * HOUR)) : dayStart(x)) : NaN);
    const a = when(m[1], false), b = Math.min(S.max, when(m[2], true));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return false;
    setRange(a, b, null);
    return true;
  }
  function syncUrl() {
    const now = location.hash || '#/', want = withMeta(now, { card: S.card, range: rangeParam() });
    if (want !== now) history.replaceState(history.state, '', want);
  }

  // ------------------------------------------------------------------ search
  // A palette over everything the page knows: players, pages and cards, bosses, items, creatures, pets,
  // fights, achievements and places, with filters (@player #page is: cat: biome: by: stars: in:chests range:)
  // and commands (>). The index comes from data.json and the game data and is rebuilt only when either
  // changes; matching is local, no requests. #/search?q= is the same as a page.

  const fold = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  const SGROUP = [  // type, heading, weight (also the group order when scores tie), icon
    ['cmd', 'Commands', 10, 'cmd'], ['player', 'Players', 9, 'players'], ['boss', 'Bosses', 8, 'combat'], ['page', 'Pages', 7, 'overview'],
    ['card', 'Cards', 6, 'card'], ['item', 'Items', 5, 'box'], ['creature', 'Creatures', 4, 'combat'], ['pet', 'Pets', 3, 'pet'],
    ['fight', 'Boss fights', 2, 'combat'], ['ach', 'Achievements', 2, 'achievements'], ['dungeon', 'Dungeons', 1, 'pin'], ['place', 'Places', 1, 'pin'],
  ];
  const SG = Object.fromEntries(SGROUP.map(([t, label, w, ico]) => [t, { label, w, ico }]));
  const IS = { player: 'player', players: 'player', page: 'page', pages: 'page', card: 'card', cards: 'card', boss: 'boss', bosses: 'boss',
    item: 'item', items: 'item', creature: 'creature', creatures: 'creature', mob: 'creature', mobs: 'creature', pet: 'pet', pets: 'pet', tame: 'pet',
    fight: 'fight', fights: 'fight', achievement: 'ach', achievements: 'ach', ach: 'ach', place: 'place', places: 'place', portal: 'place', sign: 'place',
    biome: 'place', dungeon: 'dungeon', dungeons: 'dungeon', cave: 'dungeon', caves: 'dungeon', crypt: 'dungeon', crypts: 'dungeon',
    cmd: 'cmd', command: 'cmd' };
  // g + key: go to a page
  // g + letter: every entry of the sidebar, top to bottom ("<group>:group" is a group's own link). The link itself comes from
  // the sidebar as it is, so pages a server doesn't have (no boss fights, no Steam) simply don't answer.
  // Sidebar shortcuts, g then a key, by one rule (AGENTS.md): an entry gets the first letter of its sidebar name that's
  // still free — its second, third, … letter when an earlier one is taken — and entries pick in order of importance, so
  // the more important of two with the same letter keeps it. Every entry is listed, also those a server has no data
  // for, so a key means the same on every server. A new entry goes in at its importance; the ones after it may move.
  const GO_ORDER = [['overview', 'Overview'], ['players:group', 'Players'], ['leaderboard', 'Leaderboard'], ['combat:group', 'Combat'],
    ['world:group', 'World'], ['deaths', 'Deaths'], ['sessions', 'Sessions'], ['world', 'Map & exploration'], ['raids', 'Raids'],
    ['bosses', 'Boss fights'], ['unaccounted', 'Unaccounted kills'], ['base', 'Base & gear'], ['items', 'Items'], ['server', 'Server'], ['achievements', 'Achievements'],
    ['ranking', 'Rankings'], ['pets', 'Pets'], ['scoring', 'Scoring']];
  const GO = (() => {
    const used = new Set();
    return GO_ORDER.map(([id, name]) => {
      const k = [...name.toLowerCase()].find((ch) => /[a-z]/.test(ch) && !used.has(ch));
      used.add(k);
      return [k, id];
    });
  })();
  const goKey = (id) => GO.find((x) => x[1] === id)?.[0];
  function goTarget(id) {  // [href, label] of a sidebar entry, or null
    for (const g of navGroups()) {
      if (id === `${g.k}:group` || (id === g.k && !g.pages?.length)) return [g.href, g.label];
      for (const pg of g.pages || []) if (pg.k === id) return [pg.href, pg.label];
    }
    return null;
  }
  const keyTitle = (label, id) => (goKey(id) ? `${label} (g then ${goKey(id)})` : label);
  const PLAYER_TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['combat', 'Combat & gathering'], ['gear', 'Gear & base'], ['saga', 'Saga & achievements']];
  // on a player page: t + key opens that tab, , and . step through them
  const TAB_KEYS = { o: 'overview', a: 'activity', c: 'combat', g: 'gear', s: 'saga' };
  const tabKey = (k) => Object.keys(TAB_KEYS).find((x) => TAB_KEYS[x] === k);
  const playerTabHref = (p, k) => `#/p/${encodeURIComponent(p)}${k === 'overview' ? '' : `/${k}`}`;
  const PAGE_DESC = {
    overview: 'Who played, when and how much — the big picture for the selected range.',
    leaderboard: 'Every Viking ranked: playtime, sessions, deaths, kills, gathering and more.',
    sessions: 'Every stay on the server: when, how long, and how it ended.',
    bosses: 'Every boss fight: who fought, how long it took, damage per player.',
    deaths: 'Who died, how often, when — and what it cost in skills.',
    raids: 'Attacks on the base: which kind, when, and who was there.',
    unaccounted: 'Deaths the server saw but could not credit to anyone — never guessed from who was near.',
    ranking: 'Full lists behind the overview’s top 10s.',
    world: 'The explored map, biomes, in-game days and who discovered what.',
    base: 'Everything built, stored, crafted and tamed, from the last world save.',
    items: 'Every item in the world, and the game’s data for all of them.',
    pets: 'Tamed animals: where they are, their health, and the graveyard.',
    achievements: 'Steam achievements of the players here.',
    server: 'Uptime, restarts, outages and world size.',
  };
  const spawnBiomes = (c) => [...new Set((c?.spawns || []).flatMap((s) => s.biomes || []))];
  function sEntry(t, label, href, o = {}) {
    const alias = (o.alias || []).map(fold);
    const hay = fold(`${o.sub || ''} ${o.kw || ''}`);
    return { ...o, t, label, href, sub: o.sub || '', full: fold(label), alias, hay, hayWords: hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean), rel: o.rel || 0,
      words: [fold(label), ...alias].join(' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean) };
  }

  let sIndex = null, sIndexKey = '';
  function searchIndex() {
    const d = S.data, w = d.world;
    const key = `${d.generated}|${!!S.gd}|${!!S.cd}|${me()}`;
    if (sIndex && key === sIndexKey) return sIndex;
    const out = [];
    // players
    for (const p of S.players) {
      const at = playerAllTime(p), href = `#/p/${encodeURIComponent(p)}`;
      out.push(sEntry('player', p, href, { rel: at?.online ? 4 : 0,
        sub: at ? `${p === me() ? 'you · ' : ''}${at.online ? 'online now' : `last seen ${fAgo(d.generated - at.last)}`} · ${fH(at.total)} played` : '',
        ico: () => el('i', { class: 'pal-dot', style: { background: colorOf(p) } }), prev: () => playerPreview(p),
        kids: () => PLAYER_TABS.map(([k, label]) => sEntry('page', `${p} · ${label}`, k === 'overview' ? href : `${href}/${k}`, { sub: 'Player page' })) }));
    }
    // pages
    for (const g of navGroups()) {
      for (const pg of g.pages?.length ? g.pages : [{ k: g.k, label: g.label, href: g.href }]) {
        out.push(sEntry('page', pg.label, pg.href, { sub: pg.k === g.k ? 'Page' : g.label, alias: [g.label], kbd: goKey(pg.k) ? `g ${goKey(pg.k)}` : null,
          ico: () => navIcon(g.k, 16), prev: () => pv(pg.label, g.label, [], PAGE_DESC[pg.k]) }));
      }
    }
    if (d.gather?.length) {
      for (const [k, r] of Object.entries(RANKINGS)) out.push(sEntry('page', r.title, `#/ranking/${k}`, { sub: 'Ranking', alias: ['ranking'], ico: () => navIcon('combat', 16), prev: () => pv(r.title, 'Ranking', [], r.hint) }));
    }
    // who killed what (all time), for by: and the previews
    const killers = new Map();
    for (const [, p, ev, what] of d.gather || []) if (ev === 'kill') { const b = what.split('*')[0]; (killers.get(b) || killers.set(b, new Set()).get(b)).add(p); }
    S.killers = killers;
    // bosses and creatures (one entry per name: some creatures have several prefabs)
    const fights = d.fights || [], next = w?.bosses.find((b) => !b[2]), times = w ? keyTimes() : {}, seen = new Set();
    for (const [k, c] of Object.entries(CD())) {
      if (!c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      const bs = spawnBiomes(c);
      if (c.boss) {
        const wb = w?.bosses.find((b) => b[1] === c.name), fs = fights.filter((f) => f.boss === k);
        const state = wb ? (wb[2] ? `Defeated${times[wb[0]] ? ` ${whenText(times[wb[0]])}` : ''}` : wb === next ? 'Next boss' : 'Ahead') : 'Boss';
        out.push(sEntry('boss', c.name, fs.length ? `#/bosses?boss=${encodeURIComponent(k)}` : creatureHref(k), { alias: [k], rel: wb && wb === next ? 3 : 0, biomes: bs,
          by: new Set(fs.flatMap((f) => Object.keys(f.players))), sub: [state, fs.length ? plural(fs.length, 'fight') : null].filter(Boolean).join(' · '),
          prev: () => bossPreview(k, c, state, fs), kids: fs.length ? () => [...fs].sort((x, y) => y.s - x.s).map(fightEntry) : null }));
      } else {
        out.push(sEntry('creature', c.name, creatureHref(k), { alias: [k], biomes: bs, by: killers.get(k),
          stars: Math.max(0, ...(c.spawns || []).map((s) => s.stars || 0)),
          sub: [bs.join(', '), c.hp ? `${nf(c.hp)} health` : null, c.tame ? 'tameable' : null].filter(Boolean).join(' · '), prev: () => creaturePreview(k, c) }));
      }
    }
    for (const f of fights) out.push(fightEntry(f));
    // items: the game's list plus anything only the world knows
    const drops = new Map();
    for (const [k, c] of Object.entries(CD())) for (const x of c.drops || []) (drops.get(x.item) || drops.set(x.item, []).get(x.item)).push(k);
    for (const n of new Set([...Object.keys(GD()), ...Object.keys(ITEMS())])) {
      const it = ITEMS()[n] || {}, g = GD()[n] || {}, name = itemName(n);
      const stored = it.kept || 0, inWorld = stored + total(it.crafted) + total(it.built) + total(it.shown);
      const cat = it.c ? catLabel(it.c) : ITEM_TYPE[g.type] || 'Item';
      out.push(sEntry('item', name, itemHref(n), { alias: [pretty(n), n], cat: fold(cat), rel: inWorld ? 3 : 0, inChests: stored > 0,
        by: new Set([...[it.crafted, it.built, it.shown].flatMap((m) => Object.keys(m || {})), ...foundBy(n).map((f) => f.k)]),
        biomes: [...new Set((drops.get(n) || []).flatMap((c) => spawnBiomes(CD()[c])))],
        sub: [cat, stored ? `${nf(stored)} in chests` : inWorld ? 'in the world' : null].filter(Boolean).join(' · '),
        ico: () => itemIcon(n, 'pal-img'), prev: () => itemPreview(n, drops.get(n) || []), posList: [...(it.at || []), ...(it.on || []), ...(it.tomb || [])].map(([x, z]) => [x, z]),
        kids: it.at?.length || it.on?.length || it.tomb?.length ? () => [
          ...(it.at || []).map(([x, z, k]) => sEntry('place', `${nf(k)} × ${name} at ${placeName(x, z)}`, mapHref(x, z, 6, `${name}: ${nf(k)}`), { sub: 'Chests in this 64 m zone · show on the map' })),
          ...(it.on || []).map(([x, z, k]) => sEntry('place', `${nf(k)} × ${name} on display at ${placeName(x, z)}`, mapHref(x, z, 6, `${name}: ${nf(k)} on display`), { sub: 'Item & armor stands in this 64 m zone · show on the map' })),
          ...(it.tomb || []).map(([x, z, k]) => sEntry('place', `${nf(k)} × ${name} in a tombstone at ${placeName(x, z)}`, mapHref(x, z, 6, `${name}: ${nf(k)} in a tombstone`), { sub: 'Tombstones in this 64 m zone · show on the map' }))] : null }));
    }
    // pets: named ones always, the rest with is:pet
    for (const p of d.pets || []) {
      const kind = gatherLabel(p.s), stars = Math.max(0, (p.lv || 1) - 1);
      out.push(sEntry('pet', petName(p), `#/pet/${encodeURIComponent(p.k)}`, { alias: [kind], quiet: !p.n, alive: p.status === 'alive', stars, rel: p.status === 'alive' ? 0 : -1, pos: [p.x, p.z],
        sub: [p.n ? kind : null, stars ? '★'.repeat(stars) : null, p.status].filter(Boolean).join(' · '), prev: () => petPreview(p) }));
    }
    // achievements: hidden ones only once someone here has them
    const st = STEAM();
    if (st?.achievements) {
      const got = new Map();
      for (const u of unlocks()) (got.get(u.a.k) || got.set(u.a.k, new Set()).get(u.a.k)).add(u.p);
      for (const a of st.achievements) {
        if (a.hidden && !got.has(a.k)) continue;
        const who = [...(got.get(a.k) || [])];
        out.push(sEntry('ach', a.n, '#/achievements', { kw: a.d, by: new Set(who), rel: -1, sub: who.length ? who.join(', ') : rarity(a.pct) || 'nobody here yet',
          prev: () => pv(a.n, 'Steam achievement', [['Global', rarity(a.pct)], ['Here', who.join(', ') || 'nobody yet']], a.d) }));
      }
    }
    // places: on the map where we know where (things players own: their 64 m zone)
    const M = w?.map;
    for (const [t, n] of w?.portals || []) {
      if (!t) continue;
      const mine = portalList().filter((p) => p[0] === t), at = mine[0], on = mine.filter(portalLinked).length;
      out.push(sEntry('place', `Portal “${t}”`, at ? mapHref(at[1], at[2], 5, `Portal “${t}”`) : '#/base?card=portals', { alias: ['portal'], pos: at ? [at[1], at[2]] : null,
        sub: `${mine.length > 1 ? `${plural(mine.length, 'portal')} · ` : ''}${on ? (mine.length > 2 ? `${nf(on)} linked` : 'linked') : 'not linked'}${at ? ` · ${placeName(at[1], at[2])}` : ''}` }));
    }
    const dtypes = new Map();
    for (const l of dungeons()) (dtypes.get(l[1]) || dtypes.set(l[1], []).get(l[1])).push(l);
    for (const [type, ls] of dtypes) {
      const entered = ls.filter((l) => visitsAt(l).length);
      out.push(sEntry('dungeon', type, `#/world?f=${encodeURIComponent(`dungeon:${tokSlug(type)}`)}`, { alias: ['dungeon', ...new Set(ls.map((l) => l[4]))], posList: ls.map((l) => [l[2], l[3]]),
        by: new Set(ls.flatMap((l) => visitsAt(l).map((v) => v[1]))), sub: `${nf(ls.length)} found · ${nf(entered.length)} entered · show them on the map`,
        kids: () => ls.map((l) => sEntry('place', `${type} at ${placeName(l[2], l[3])}`, mapHref(l[2], l[3], 6, type),
          { sub: visitsAt(l).length ? `Entered ${plural(visitsAt(l).length, 'time')} · last by ${visitsAt(l).slice(-1)[0][1]}` : 'Nobody went in yet' })) }));
    }
    for (const [kind, name, x, z] of M?.locations || []) {
      if (kind === 'start' || kind === 'dungeon') continue;
      const label = kind === 'altar' ? `${name} altar` : name, done = (w.bosses || []).some((b) => b[1] === name && b[2]);
      out.push(sEntry('place', label, mapHref(x, z, 5, label), { alias: [kind === 'altar' ? 'altar' : 'trader', 'vendor'], pos: [x, z], biomes: [],
        sub: `${kind === 'altar' ? `Boss altar${done ? ' · defeated' : ''}` : 'Trader'} · x ${nf(x)}, z ${nf(z)}`, ico: () => navIcon('pin', 16) }));
    }
    for (const b of M?.bases || []) {
      out.push(sEntry('place', `Base of ${b.builders[0]?.[0] || '?'}`, mapHref(b.x, b.z, 5, `Base of ${b.builders[0]?.[0] || '?'}`), { alias: ['base'], pos: [b.x, b.z],
        by: new Set(b.builders.map((x) => x[0])), sub: `${nf(b.pieces)} pieces · ${plural(b.chests, 'chest')} · ${b.builders.map((x) => x[0]).join(', ')}` }));
    }
    for (const [o, x, z] of M?.tombs || []) out.push(sEntry('place', `Tombstone of ${o}`, mapHref(x, z, 6, `Tombstone of ${o}`), { alias: ['tombstone', 'grave'], pos: [x, z], by: new Set([o]), sub: placeName(x, z) }));
    for (const [raw, kind, x, z] of M?.pins || []) { const n = plainText(raw); if (n) out.push(sEntry('place', n, mapHref(x, z, 6, n), { alias: ['pin'], pos: [x, z], rel: -1, sub: `Shared pin · ${placeName(x, z)}` })); }
    for (const raw of w?.signs || []) {
      const s = plainText(raw);
      out.push(sEntry('place', s.length > 60 ? `${s.slice(0, 59)}…` : s, '#/base?card=signs', { kw: s, alias: ['sign'], sub: 'Sign', rel: -1, prev: () => pv('Sign', null, [], s) }));
    }
    const zb = new Map();
    for (const z of d.zones) zb.set(biomeOf(z), (zb.get(biomeOf(z)) || 0) + 1);
    for (const [b] of BIOMES) if (zb.get(b)) out.push(sEntry('place', b, '#/world', { alias: ['biome'], biomes: [b], sub: `Biome · ${plural(zb.get(b), 'zone')} explored` }));
    // positions for near: — players where last seen, pets, items where they are kept, bosses at their altars
    for (const e of out) {
      if (e.t === 'player') { const m = d.positions?.players.find((x) => x.p === e.label); if (m) e.pos = [m.x, m.z]; }
      else if (e.t === 'boss') e.posList = (M?.locations || []).filter((l) => l[1] === e.label).map((l) => [l[2], l[3]]);
    }
    const m = me();  // the visitor's own things first
    if (m) for (const e of out) e.rel += e.t === 'player' && e.label === m ? 6 : e.by?.has?.(m) ? 1 : 0;
    sIndex = out; sIndexKey = key;
    return out;
  }
  const fightEntry = (f) => sEntry('fight', `${fightName(f)} · ${fDate(f.s)}`, fightHref(f), { rel: -2, by: new Set(Object.keys(f.players)), kw: Object.keys(f.players).join(' '),
    sub: `${OUTCOME[f.outcome] || f.outcome} · ${Object.keys(f.players).join(', ')}`, prev: () => fightPreview(f) });
  // cards: the open page's, and those of list pages opened before
  function cardEntries() {
    const here = withMeta(location.hash || '#/'), out = [];
    for (const [path, pg] of S.seen) {
      for (const x of pg.sections) {
        const href = withMeta(path, { card: x.id });
        out.push(sEntry('card', x.label, href, { rel: path === here ? 2 : -1, sub: path === here ? 'On this page' : `Card on ${pg.title}`,
          run: path === here ? () => jumpTo(x.id) : null }));
      }
    }
    return out;
  }
  const COMMANDS = () => [
    ['Last 24 hours', '24h day', () => applyPreset(1), '1'], ['Last 7 days', '7d week', () => applyPreset(7), '2'],
    ['Last 30 days', '30d month', () => applyPreset(30), '3'], ['All time', 'everything', () => applyPreset(0), '4'],
    ['Earlier range', 'previous back shift', () => shiftRange(-1), '['], ['Later range', 'next forward shift', () => shiftRange(1), ']'],
    ['Refresh now', 'reload update', manualRefresh, 'r'], ['Back to the top', 'scroll up', () => scrollTo({ top: 0 }), null],
    ['Fold or unfold the sidebar', 'collapse expand nav', toggleNav, null], ['Keyboard shortcuts', 'help keys', showKeys, '?'],
    ['My page', 'me mine you', goMe, 'm'], ['Which Viking are you?', 'me pick change who you', pickMe, null],
  ].map(([label, kw, run, kbd]) => sEntry('cmd', label, null, { kw, run, kbd, quiet: true }));

  // ---- query: words plus filters
  function parseQuery(raw) {
    const q = { raw, words: [], types: new Set(), f: {}, chips: [] };
    let s = raw.trim();
    if (s.startsWith('>')) { q.types.add('cmd'); q.chips.push(['>', 'Commands']); s = s.slice(1); }
    for (const tok of s.split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^(\w+):(.+)$/), v = m ? fold(m[2]) : '';
      if (tok[0] === '@') { q.types.add('player'); q.chips.push([tok, 'Players']); if (tok.length > 1) q.words.push(fold(tok.slice(1))); }
      else if (tok[0] === '#') { q.types.add('page'); q.types.add('card'); q.chips.push([tok, 'Pages & cards']); if (tok.length > 1) q.words.push(fold(tok.slice(1))); }
      else if (m && (m[1] === 'is' || m[1] === 'type') && (v === 'alive' || v === 'dead')) { q.types.add('pet'); q.f.alive = v === 'alive'; q.chips.push([tok, v === 'alive' ? 'Living pets' : 'Dead pets']); }
      else if (m && (m[1] === 'is' || m[1] === 'type') && IS[v]) { q.types.add(IS[v]); q.chips.push([tok, SG[IS[v]].label]); }
      else if (m && m[1] === 'cat') { q.types.add('item'); q.f.cat = v; q.chips.push([tok, `Category: ${m[2]}`]); }
      else if (m && m[1] === 'biome') { q.f.biome = v; q.chips.push([tok, `Biome: ${m[2]}`]); }
      else if (m && m[1] === 'by') { q.f.by = v; q.chips.push([tok, `By: ${m[2]}`]); }
      else if (m && m[1] === 'stars' && /^\d$/.test(v)) { q.f.stars = Number(v); q.chips.push([tok, `★ ${v}`]); }
      else if (m && m[1] === 'in' && v.startsWith('chest')) { q.types.add('item'); q.f.inChests = true; q.chips.push([tok, 'In chests']); }
      else if (m && m[1] === 'range') { q.f.range = m[2]; q.chips.push([tok, `Range: ${m[2]}`]); }
      else if (m && m[1] === 'near') { q.f.near = v; q.chips.push([tok, `Near: ${m[2]}`]); }
      else q.words.push(fold(tok));
    }
    return q;
  }
  function passes(e, q, byP) {
    if (q.types.size ? !q.types.has(e.t) : e.quiet && e.t !== 'cmd') return false;
    const f = q.f;
    if (f.cat != null && !(e.cat || '').startsWith(f.cat)) return false;
    if (f.biome && !(e.biomes || []).some((b) => fold(b).startsWith(f.biome))) return false;
    if (byP && !(e.by && [...e.by].some((p) => byP.has(p)))) return false;
    if (f.stars != null && !(e.t === 'pet' ? e.stars === f.stars : (e.stars ?? -1) >= f.stars)) return false;
    if (f.alive != null && e.alive !== f.alive) return false;
    if (f.inChests && !e.inChests) return false;
    if (f.at) {  // near: within NEAR m of the place it named
      const ps = e.pos ? [e.pos] : e.posList || [];
      if (!ps.some(([x, z]) => Math.hypot(x - f.at[0], z - f.at[1]) <= NEAR)) return false;
    }
    return true;
  }
  const NEAR = 1000;
  // The place near: names — a place, boss altar, base, player or pet with a position, best match first.
  function nearPos(v) {
    const cand = searchIndex().filter((e) => e.pos || e.posList?.length);
    const e = cand.find((x) => x.full === v) || cand.find((x) => x.full.startsWith(v)) || cand.find((x) => x.words.some((w) => w.startsWith(v)));
    return e ? (e.pos || e.posList[0]) : null;
  }
  // at most one letter wrong, missing, extra or swapped
  function near(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (i === a.length && i === b.length) return true;
    const rest = (x, y) => a.slice(x) === b.slice(y);
    return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2));
  }
  // Whole name, start of the name, start of a word, start of a word in the details; only when that finds
  // nothing at all (loose): inside a word, or one typo.
  function wordScore(w, e, loose) {
    if (e.full === w) return 100;
    let best = e.full.startsWith(w) ? 85 : 0;
    for (const x of e.words) best = Math.max(best, x === w ? 75 : x.startsWith(w) ? 60 : 0);
    if (best) return best;
    if (e.hayWords.some((x) => x.startsWith(w))) return 20;
    if (!loose) return 0;
    if (e.full.includes(w) || e.alias.some((a) => a.includes(w))) return 40;
    const typo = (x) => near(x, w) || near(x.slice(0, w.length), w) || near(x.slice(0, w.length + 1), w);
    if (w.length >= 4 && e.words.some(typo)) return 30;
    if (w.length >= 4 && e.hayWords.some(typo)) return 10;
    return e.hay.includes(w) ? 10 : 0;
  }
  function searchResults(raw, all = false) {
    const q = parseQuery(raw);
    const byP = q.f.by ? new Set(S.players.filter((p) => fold(p).includes(q.f.by))) : null;
    if (q.f.near) { q.f.at = nearPos(q.f.near); if (!q.f.at) return { q, total: 0, groups: [] }; }
    const pool = [...searchIndex(), ...cardEntries(), ...COMMANDS()].filter((e) => passes(e, q, byP));
    const find = (loose) => {
      const out = [], hrefs = new Set();
      for (const e of pool) {
        let sc = 0;
        for (const w of q.words) { const s = wordScore(w, e, loose); if (!s) { sc = -1; break; } sc += s; }
        if (sc < 0 || (e.t === 'cmd' && !q.types.has('cmd') && (!q.words.length || sc < 60 * q.words.length))) continue;
        if (e.href) { if (hrefs.has(e.href)) continue; hrefs.add(e.href); }  // a page and its card, a creature under two prefabs …
        out.push({ e, s: sc + SG[e.t].w * 2 + e.rel * 3 });
      }
      return out;
    };
    let hits = find(false);
    if (!hits.length && q.words.length) { hits = find(true); q.loose = true; }
    hits.sort((x, y) => y.s - x.s || x.e.label.localeCompare(y.e.label));
    const groups = new Map();
    for (const h of hits) (groups.get(h.e.t) || groups.set(h.e.t, []).get(h.e.t)).push(h.e);
    const cap = all || q.types.size === 1 ? Infinity : 5;
    return { q, total: hits.length, groups: [...groups].map(([t, es]) => ({ t, label: SG[t].label, items: es.slice(0, cap), more: Math.max(0, es.length - cap) })) };
  }
  // Nothing typed: recent picks, the pages, the players.
  function emptyResults() {
    const idx = searchIndex(), recent = [];
    for (const r of recentGet()) { const e = idx.find((x) => x.href === r.href) || (r.href ? sEntry(r.t in SG ? r.t : 'page', r.label, r.href) : null); if (e) recent.push(e); }
    const players = idx.filter((e) => e.t === 'player').sort((x, y) => y.rel - x.rel);
    return { q: parseQuery(''), total: 0, groups: [
      recent.length ? { t: 'recent', label: 'Recent', items: recent.slice(0, 6), more: 0 } : null,
      { t: 'page', label: 'Pages', items: idx.filter((e) => e.t === 'page' && e.kbd), more: 0 },
      { t: 'player', label: 'Players', items: players, more: 0 }].filter(Boolean) };
  }
  const recentGet = () => { try { return JSON.parse(store.get('gs.recent') || '[]'); } catch { return []; } };
  function recentAdd(e) {
    if (!e.href || e.t === 'cmd') return;
    store.set('gs.recent', JSON.stringify([{ t: e.t, label: e.label, href: e.href }, ...recentGet().filter((r) => r.href !== e.href)].slice(0, 8)));
  }

  // ---- previews: answer the question without opening the page
  const pv = (title, sub, rows, text, ico) => [
    el('div', { class: 'pv-head' }, ico || null, el('b', { text: title })), sub ? el('div', { class: 'pv-sub', text: sub }) : null,
    text ? el('p', { class: 'pv-text', text }) : null,
    el('dl', { class: 'pv-dl' }, rows.filter((r) => r && r[1] != null && r[1] !== '').flatMap(([k, v]) => [el('dt', { text: k }), el('dd', null, v)]))];
  const holders = (m) => Object.entries(m || {}).sort((x, y) => y[1] - x[1]).map(([p, n]) => `${p} ${nf(n)}`).join(', ');
  function playerPreview(p) {
    const at = playerAllTime(p), ses = S.data.sessions.filter((s) => s.p === p).length;
    const fs = (S.data.fights || []).filter((f) => f.players[p]);
    return pv(p, at?.online ? 'Online now' : at ? `Last seen ${fDateTime(at.last)}` : null, [
      ['Played', at ? fH(at.total) : null], ['Sessions', nf(ses)], ['First seen', at ? fDate(at.first) : null],
      ['Boss fights', fs.length ? `${nf(fs.length)} · ${nf(fs.filter((f) => f.outcome === 'killed').length)} won` : null]], null,
    el('i', { class: 'pal-dot big', style: { background: colorOf(p) } }));
  }
  function itemPreview(n, droppers) {
    const it = ITEMS()[n] || {}, g = GD()[n] || {};
    return pv(itemName(n), it.c ? catLabel(it.c) : ITEM_TYPE[g.type] || null, [
      ['In chests', it.kept ? nf(it.kept) : null],
      ['In tombstones', it.tomb?.length ? it.tomb.slice(0, 3).map(([x, z, k]) => `${nf(k)} at ${placeName(x, z)}`).join(' · ') : null],
      ['Found by', foundBy(n).length ? foundBy(n).slice(0, 4).map((f) => `${f.k} ${nf(f.v)}`).join(', ') : null],
      ['Kept at', it.at?.length ? it.at.slice(0, 3).map(([x, z, k]) => `${nf(k)} at ${placeName(x, z)}`).join(' · ') : null],
      ['Crafted', total(it.crafted) ? holders(it.crafted) : null], ['Built', total(it.built) ? `${nf(total(it.built))} standing` : null],
      ['On display', total(it.shown) ? nf(total(it.shown)) : null],
      ['Dropped by', droppers.length ? [...new Set(droppers.map((c) => gatherLabel(c)))].slice(0, 6).join(', ') : null],
      ['Used for', g.uses?.length ? plural(g.uses.length, 'recipe') : null], ['Weight', g.weight != null ? nf(g.weight, 1) : null]],
    g.desc || null, itemIcon(n, 'pal-img big'));
  }
  function creaturePreview(k, c) {
    const who = S.killers?.get(k);
    return pv(c.name, c.faction || 'Creature', [
      ['Health', c.hp ? nf(c.hp) : null], ['Lives in', spawnBiomes(c).join(', ') || null],
      ['Drops', (c.drops || []).length ? [...new Set(c.drops.map((x) => itemName(x.item)))].slice(0, 6).join(', ') : null],
      ['Weak to', c.weak?.join(', ')], ['Tameable', c.tame ? 'yes' : null], ['Killed by', who?.size ? [...who].join(', ') : null]]);
  }
  function bossPreview(k, c, state, fs) {
    const won = fs.filter((f) => f.outcome === 'killed');
    return pv(c.name, state, [['Health', c.hp ? nf(c.hp) : null], ['Lives in', spawnBiomes(c).join(', ') || null],
      ['Fights', fs.length ? `${nf(fs.length)} · ${nf(won.length)} won` : null],
      ['Last fight', fs.length ? fDateTime(Math.max(...fs.map((f) => f.s))) : null],
      ['Fastest kill', won.length ? fDur(Math.min(...won.map((f) => f.e - f.s))) : null]]);
  }
  function petPreview(p) {
    const stars = Math.max(0, (p.lv || 1) - 1);
    return pv(petName(p), [gatherLabel(p.s), stars ? '★'.repeat(stars) : null].filter(Boolean).join(' '), [
      ['Status', p.status], ['Tamed', p.first ? fDate(p.first) : null], ['Last seen', p.last ? fDateTime(p.last) : null], ['Health', p.max ? `max ${nf(p.max)}` : null]]);
  }
  function fightPreview(f) {
    return pv(fightName(f), `${OUTCOME[f.outcome] || f.outcome} · ${fDateTime(f.s)}`, [
      ['Took', f.e ? fDur(f.e - f.s) : null], ['Players', Object.keys(f.players).join(', ')], ['Damage', f.dmg ? nf(f.dmg) : null],
      ['Deaths', f.deaths.length ? f.deaths.map((x) => x[1]).join(', ') : 'none']]);
  }

  // ---- the palette
  const PAL = { sel: 0, flat: [], starts: [], from: null, stack: [], res: null };
  function buildPalette() {
    const input = el('input', { id: 'pal-input', class: 'pal-input', type: 'search', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go',
      placeholder: 'Search players, items, creatures, pages …', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list',
      oninput: () => { PAL.sel = 0; PAL.stack = []; drawPalette(); }, onkeydown: palKey });
    const root = el('div', { class: 'palette', id: 'palette', hidden: true, onclick: (e) => { if (e.target === e.currentTarget) closePalette(); } },
      el('div', { class: 'pal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
        el('div', { class: 'pal-top' }, navIcon('search', 18), input,
          el('button', { type: 'button', class: 'pal-close', 'aria-label': 'Close search', text: 'Esc', onclick: closePalette })),
        el('div', { class: 'pal-chips', id: 'pal-chips' }),
        el('div', { class: 'pal-body' }, el('div', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' }),
          el('div', { class: 'pal-prev', id: 'pal-prev', 'aria-live': 'polite' })),
        el('div', { class: 'pal-foot' }, [['↑↓', 'move'], ['↵', 'open'], ['Ctrl ↵', 'new tab'], ['→', 'more'], ['Tab', 'next group'], ['?', 'all shortcuts']]
          .map(([k, t]) => el('span', null, el('kbd', { text: k }), ` ${t}`)))));
    document.body.append(root);
    return root;
  }
  function openPalette(initial) {
    const root = $('#palette') || buildPalette(), input = $('#pal-input');
    if (root.hidden) { PAL.from = document.activeElement; PAL.stack = []; PAL.sel = 0; }
    if (initial != null) input.value = initial;
    root.hidden = false;
    document.body.classList.add('sheet-open');
    closeSheet(); closeNavOverlay(); untip();
    input.focus();
    input.select();
    drawPalette();
  }
  function closePalette() {
    const root = $('#palette');
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('sheet-open');
    PAL.from?.focus?.();
    PAL.from = null;
  }
  const SUGGEST = [['@', 'Players'], ['#', 'Pages & cards'], ['is:item', 'Items'], ['is:creature', 'Creatures'], ['is:boss', 'Bosses'], ['is:pet', 'Pets'],
    ['is:fight', 'Boss fights'], ['is:dungeon', 'Dungeons'], ['in:chests', 'In chests'], ['>', 'Commands']];
  function setQuery(v) { const i = $('#pal-input'); i.value = v; i.focus(); PAL.sel = 0; PAL.stack = []; drawPalette(); }
  function drawPalette() {
    const raw = $('#pal-input').value, kid = PAL.stack[PAL.stack.length - 1];
    const res = kid ? { q: parseQuery(''), total: 0, groups: [{ t: 'kids', label: kid.label, items: kid.kids(), more: 0 }] } : raw.trim() ? searchResults(raw) : emptyResults();
    PAL.res = res;
    // filter chips: the ones in use (click removes), or suggestions
    const chips = $('#pal-chips');
    if (kid) chips.replaceChildren(el('button', { type: 'button', class: 'chip', text: `← ${kid.label}`, onclick: () => { PAL.stack.pop(); PAL.sel = 0; drawPalette(); $('#pal-input').focus(); } }));
    else if (res.q.chips.length) {
      chips.replaceChildren(...res.q.chips.map(([tok, label]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', title: `Remove ${tok}`, text: `${label} ✕`,
        onclick: () => setQuery(raw.replace(tok, '').replace(/\s+/g, ' ').trimStart()) })));
    } else {
      chips.replaceChildren(...SUGGEST.map(([tok, label]) => el('button', { type: 'button', class: 'chip', text: label, title: tok,
        onclick: () => setQuery(`${tok}${/[@#>]$/.test(tok) ? '' : ' '}${raw.trimStart()}`) })));
    }
    // results
    PAL.flat = []; PAL.starts = [];
    const words = res.q.words, list = $('#pal-list');
    const opt = (e) => {
      const i = PAL.flat.push(e) - 1;
      return el('div', { class: 'pal-opt', role: 'option', id: `pal-o-${i}`, 'aria-selected': 'false',
        onpointermove: () => { if (PAL.sel !== i) palSelect(i, false); }, onclick: (ev) => palGo(e, ev.ctrlKey || ev.metaKey) },
      el('span', { class: 'pal-ico', 'aria-hidden': 'true' }, e.ico?.() || navIcon(SG[e.t]?.ico || 'overview', 16)),
      el('span', { class: 'pal-txt' }, el('span', { class: 'pal-label' }, marked(e.label, words)), e.sub ? el('span', { class: 'pal-sub', text: e.sub }) : null),
      e.kids ? el('span', { class: 'pal-more', title: '→ for more', text: '›' }) : null,
      e.kbd ? el('kbd', { text: e.kbd }) : null);
    };
    const groups = res.groups.map((g) => {
      PAL.starts.push(PAL.flat.length);
      return el('div', { class: 'pal-group', role: 'group', 'aria-label': g.label }, el('div', { class: 'pal-gh', 'aria-hidden': 'true', text: g.label }),
        g.items.map(opt),
        g.more ? opt(sEntry('page', `All ${nf(g.items.length + g.more)} ${g.label.toLowerCase()}`, null,
          { run: () => { location.hash = `#/search?q=${encodeURIComponent(`is:${g.t === 'ach' ? 'achievement' : g.t} ${raw}`.trim())}`; }, ico: () => navIcon('search', 16) })) : null);
    });
    if (raw.trim() && !kid) {
      PAL.starts.push(PAL.flat.length);
      groups.push(el('div', { class: 'pal-group', role: 'group', 'aria-label': 'Everything' },
        opt(sEntry('page', res.total ? `All ${plural(res.total, 'result')} on one page` : `Nothing found for “${raw.trim()}”`, null,
          { sub: res.total ? null : 'Fewer letters, or a filter like is:item or @name, usually help', run: () => { location.hash = `#/search?q=${encodeURIComponent(raw.trim())}`; }, ico: () => navIcon('search', 16) }))));
    }
    list.replaceChildren(...[res.q.loose ? el('div', { class: 'pal-note', text: 'No exact match — close ones:' }) : null, ...groups].filter(Boolean));
    palSelect(Math.min(PAL.sel, PAL.flat.length - 1), true);
  }
  // The words that matched, highlighted (mapped back through the accent folding).
  function marked(label, words) {
    if (!words.length) return label;
    let f = '';
    const at = [];
    for (let i = 0; i < label.length; i++) for (const c of fold(label[i])) { f += c; at.push(i); }
    const spans = words.map((w) => { const i = f.indexOf(w); return i < 0 ? null : [at[i], at[i + w.length - 1] + 1]; }).filter(Boolean).sort((x, y) => x[0] - y[0]);
    const out = [];
    let pos = 0;
    for (const [a, b] of spans) {
      if (a < pos) continue;
      out.push(label.slice(pos, a), el('mark', { text: label.slice(a, b) }));
      pos = b;
    }
    out.push(label.slice(pos));
    return out;
  }
  function palSelect(i, scroll) {
    if (i < 0 || !PAL.flat.length) { $('#pal-prev').replaceChildren(); $('#pal-input').removeAttribute('aria-activedescendant'); return; }
    PAL.sel = i;
    for (const o of document.querySelectorAll('#pal-list .pal-opt')) o.setAttribute('aria-selected', String(o.id === `pal-o-${i}`));
    const o = $(`#pal-o-${i}`);
    $('#pal-input').setAttribute('aria-activedescendant', o.id);
    if (scroll) o.scrollIntoView({ block: 'nearest' });
    const e = PAL.flat[i];
    $('#pal-prev').replaceChildren(...(e.prev ? e.prev() : pv(e.label, e.sub || SG[e.t]?.label, [], null)).flat().filter(Boolean),
      el('div', { class: 'pv-go hint', text: e.run ? 'Enter to run' : 'Enter to open · Ctrl+Enter in a new tab' }));
  }
  function palGo(e, newTab) {
    const q = PAL.res?.q;
    recentAdd(e);
    if (e.run) { closePalette(); e.run(); }
    else if (!e.href) return;
    else if (newTab) { window.open(`${location.pathname}${location.search}${withMeta(e.href, { range: rangeParam() })}`, '_blank', 'noopener'); return; }
    else {
      closePalette();
      const card = metaOf(e.href).card;
      if (withMeta(e.href) === withMeta(location.hash || '#/') && card) jumpTo(card);
      else location.hash = e.href;
    }
    if (q?.f.range) applyRangeParam(q.f.range);
  }
  function palKey(e) {
    const n = PAL.flat.length, input = e.currentTarget, atEnd = input.selectionStart === input.value.length;
    const move = (i) => { e.preventDefault(); if (n) palSelect((i + n) % n, true); };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(PAL.sel + 1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(PAL.sel - 1);
    else if (e.key === 'Tab' && PAL.starts.length > 1) {
      e.preventDefault();
      const g = PAL.starts.findLastIndex((s) => s <= PAL.sel), to = PAL.starts[(g + (e.shiftKey ? -1 : 1) + PAL.starts.length) % PAL.starts.length];
      palSelect(to, true);
    } else if (e.key === 'Enter') { e.preventDefault(); if (PAL.flat[PAL.sel]) palGo(PAL.flat[PAL.sel], e.ctrlKey || e.metaKey); }
    else if (e.key === 'ArrowRight' && atEnd && PAL.flat[PAL.sel]?.kids) { e.preventDefault(); PAL.stack.push(PAL.flat[PAL.sel]); PAL.sel = 0; drawPalette(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && PAL.stack.length && input.selectionStart === 0 && input.selectionEnd === 0) { e.preventDefault(); PAL.stack.pop(); PAL.sel = 0; drawPalette(); }
    else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (PAL.stack.length) { PAL.stack.pop(); PAL.sel = 0; drawPalette(); } else if (input.value) setQuery(''); else closePalette();
    }
  }

  // ---- the results as a page: #/search?q=
  function searchView(r) {
    const q0 = r.q?.get('q') || '', res = q0.trim() ? searchResults(q0, true) : null;
    const input = el('input', { class: 'search', type: 'search', value: q0, placeholder: 'Search …', 'aria-label': 'Search', enterkeyhint: 'search',
      onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#/search?q=${encodeURIComponent(e.target.value.trim())}`; } });
    const row = (e) => el('li', null, el('a', { class: 'pal-opt', href: e.href || location.hash, onclick: e.run ? (ev) => { ev.preventDefault(); e.run(); } : () => recentAdd(e) },
      el('span', { class: 'pal-ico', 'aria-hidden': 'true' }, e.ico?.() || navIcon(SG[e.t]?.ico || 'overview', 16)),
      el('span', { class: 'pal-txt' }, el('span', { class: 'pal-label' }, marked(e.label, res.q.words)), e.sub ? el('span', { class: 'pal-sub', text: e.sub }) : null)));
    return [
      ...subHead('Search', res ? `${plural(res.total, 'result')} for “${q0}”` : 'Players, items, creatures, pages and more', true),
      el('div', { class: 'search-bar' }, input, el('span', { class: 'hint', text: 'Filters: @player #page is:item|creature|boss|pet|fight|achievement|dungeon|place cat: biome: by: stars: near: in:chests range: · > for commands' })),
      el('div', { class: 'grid' }, res?.groups.length ? res.groups.map((g) => card(g.label, plural(g.items.length, 'result'), el('ul', { class: 'search-results' }, g.items.map(row)), 'span-12'))
        : el('div', { class: 'card span-12' }, el('div', { class: 'empty-state', text: res ? 'Nothing found. Fewer letters, or a filter like is:item or @name, usually help.' : 'Type something above, or press / anywhere.' }))),
    ];
  }

  // ---- keyboard: / or Ctrl+K search, u / d scroll, g + key to go (the sidebar), g + number to a section, t + key / , . for player tabs, 1–4 range presets, [ ] shift the range, ? for all of it
  function shiftRange(dir) {
    const span = S.b - S.a;
    let a = S.a + dir * span, b = S.b + dir * span;
    if (a < S.min) { a = S.min; b = S.min + span; }
    if (b > S.max) { b = S.max; a = S.max - span; }
    setRange(a, b, null);
  }
  const KEYS = [
    [['/', 'Ctrl K'], 'Search'], [['u', 'd'], 'Scroll up / down'],
    [['1', '2', '3', '4'], 'Last 24 h · 7 days · 30 days · all time'], [['[', ']'], 'Earlier / later range of the same length'],
    [['t', 'o a c g s'], 'On a player page: Overview · Activity · Combat & gathering · Gear & base · Saga & achievements'],
    [[',', '.'], 'On a player page: previous / next tab'],
    [['m'], 'Your page (asks who you are the first time)'], [['r'], 'Refresh now'], [['?'], 'This list'], [['Esc'], 'Close'],
    [['g', '1 2 …'], 'A section of this page, by its number under “On this page” (listed below)'],
  ];
  function showKeys() {
    closePalette();
    $('#keys')?.remove();  // rebuilt every time: the sections are this page's
    let root = null;
    {
      const secs = S.sections?.length > 1 ? S.sections : [];
      const goRows = GO.map(([k, id]) => [k, goTarget(id)]).filter((x) => x[1]).map(([k, t]) => [['g', k], t[1]]);
      const rows = [KEYS[0], ...goRows, ...KEYS.slice(1), ...secs.map((x, i) => [['g', String(i + 1)], `On this page: ${x.label}`])];
      root = el('div', { class: 'palette', id: 'keys', hidden: true, onclick: (e) => { if (e.target === e.currentTarget || e.target.closest('.pal-close')) closeKeys(); } },
        el('div', { class: 'pal-panel keys-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', tabindex: '-1' },
          el('div', { class: 'pal-top' }, el('b', { text: 'Keyboard shortcuts' }), el('button', { type: 'button', class: 'pal-close', 'aria-label': 'Close', text: 'Esc' })),
          el('div', { class: 'keys-body' }, el('table', { class: 'keys' }, el('tbody', null, rows.map(([ks, t]) => el('tr', null,
            el('td', null, ks.map((k, i) => [i ? el('span', { class: 'hint', text: ks[0] === 'g' || ks[0] === 't' ? ' then ' : ' ' }) : null, el('kbd', { text: k })])), el('td', { text: t }))))),
          el('p', { class: 'hint', text: 'In search: ↑↓ move, Enter opens, Ctrl+Enter opens in a new tab, → shows more (a player’s tabs, a boss’s fights), Tab jumps between groups.' }))));
      document.body.append(root);
    }
    root.hidden = false;
    document.body.classList.add('sheet-open');
    root.querySelector('.pal-panel').focus();
  }
  function closeKeys() {
    const root = $('#keys');
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('sheet-open');
  }
  function initKeys() {
    let gAt = 0, tAt = 0, gNum = '', gTimer = 0;
    // g then a number: that section of the page. Two digits on pages with 10+ sections: after a digit that could start
    // a longer number, a second digit is awaited briefly (Enter jumps right away).
    const goSection = () => {
      clearTimeout(gTimer);
      const n = Number(gNum), x = S.sections?.[n - 1];
      gNum = ''; gAt = 0;
      if (x) { closeSheet(); jumpTo(x.id); }
    };
    addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Escape') { closeKeys(); closePick(); return; }
      if ((!$('#keys')?.hidden && $('#keys')) || $('#pickme')) return;
      const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };  // before the page's own r (refresh)
      if (gNum && e.key === 'Enter') { consume(); goSection(); return; }
      if (gAt && Date.now() - gAt < 1500 && /^[0-9]$/.test(e.key) && S.sections?.length && (gNum || e.key !== '0')) {
        consume();
        gNum += e.key;
        clearTimeout(gTimer);
        if (Number(gNum) * 10 <= S.sections.length) { gAt = Date.now(); gTimer = setTimeout(goSection, 800); } else goSection();
        return;
      }
      if (gNum) goSection();  // something else after the first digit: that one it is
      if (gAt && Date.now() - gAt < 1500) {
        gAt = 0;
        const to = GO.find((x) => x[0] === e.key.toLowerCase()), t = to && goTarget(to[1]);
        if (t) { consume(); closeSheet(); location.hash = t[0]; }
        return;
      }
      const pr = route();
      if (tAt && Date.now() - tAt < 1500) {
        tAt = 0;
        const k = TAB_KEYS[e.key.toLowerCase()];
        if (k && pr.player) { consume(); closeSheet(); location.hash = playerTabHref(pr.player, k); }
        return;
      }
      if (e.key === '/') { consume(); openPalette(); }
      else if (e.key === 'u' || e.key === 'd') { consume(); scrollBy({ top: (e.key === 'd' ? 1 : -1) * innerHeight * 0.66, behavior: reducedMotion() ? 'auto' : 'smooth' }); }
      else if (e.key === 'g') { consume(); gAt = Date.now(); }
      else if (e.key === 't' && pr.player) { consume(); tAt = Date.now(); }
      else if ((e.key === ',' || e.key === '.') && pr.player) {
        consume();
        const i = PLAYER_TABS.findIndex(([k]) => k === pr.tab), n = PLAYER_TABS.length;
        location.hash = playerTabHref(pr.player, PLAYER_TABS[(i + (e.key === '.' ? 1 : n - 1)) % n][0]);
      }
      else if (e.key.length === 1 && '1234'.includes(e.key)) { consume(); applyPreset([1, 7, 30, 0][Number(e.key) - 1]); }
      else if (e.key === '[' || e.key === ']') { consume(); shiftRange(e.key === '[' ? -1 : 1); }
      else if (e.key === '?') { consume(); showKeys(); }
      else if (e.key === 'm') { consume(); goMe(); }
    }, { capture: true });
  }

  // ------------------------------------------------------------------ me
  // A visitor can say which Viking they are (this browser only): "You" at the top of the sidebar, their name
  // marked across the page, m to their page, their things first in search. The overview opens with what
  // changed since the last visit (a visit starts after 30 min away).

  const me = () => { const p = store.get('gs.me'); return p && S.players.includes(p) ? p : null; };
  const meHref = () => `#/p/${encodeURIComponent(me())}`;
  function setMe(p) {
    if (p) store.set('gs.me', p); else store.del('gs.me');
    toast(p ? `Hello, ${p}` : 'Forgotten');
    scheduleRender();
  }
  const goMe = () => { if (me()) location.hash = meHref(); else pickMe(); };
  function pickMe() {
    closePalette(); closeSheet(); closeNavOverlay(); closePick();
    const cur = me();
    const root = el('div', { class: 'palette', id: 'pickme', onclick: (e) => { if (e.target === e.currentTarget) closePick(); } },
      el('div', { class: 'pal-panel keys-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Which Viking are you?', tabindex: '-1' },
        el('div', { class: 'pal-top' }, el('b', { text: 'Which Viking are you?' }), el('button', { type: 'button', class: 'pal-close', 'aria-label': 'Close', text: 'Esc', onclick: closePick })),
        el('p', { class: 'hint pick-note', text: 'Remembered in this browser only — nothing is sent anywhere. Your name gets marked across the page, m takes you to your page, and search puts your things first.' }),
        el('div', { class: 'pick-list' },
          S.players.map((p) => el('button', { type: 'button', class: 'pal-opt', 'aria-pressed': String(p === cur), onclick: () => { closePick(); setMe(p); } },
            el('span', { class: 'pal-ico', 'aria-hidden': 'true' }, el('i', { class: 'pal-dot', style: { background: colorOf(p) } })),
            el('span', { class: 'pal-label', text: p }), p === cur ? el('span', { class: 'hint', text: 'you' }) : null)),
          cur ? el('button', { type: 'button', class: 'pal-opt', onclick: () => { closePick(); setMe(null); } },
            el('span', { class: 'pal-ico', 'aria-hidden': 'true', text: '✕' }), el('span', { class: 'pal-label', text: 'Forget me' })) : null)));
    document.body.append(root);
    document.body.classList.add('sheet-open');
    (root.querySelector('.pal-opt[aria-pressed="true"]') || root.querySelector('.pal-opt')).focus();
  }
  function closePick() {
    const root = $('#pickme');
    if (!root) return;
    root.remove();
    document.body.classList.remove('sheet-open');
  }
  // The sidebar's and the More sheet's first entry.
  function meEntry(rail, inSheet) {
    const m = me(), cur = route().player === m && m;
    if (!m) {
      return el('button', { type: 'button', class: 'sn-link sn-me', title: rail ? 'Which Viking are you?' : null, onclick: pickMe },
        el('span', { class: 'sn-avatar', 'aria-hidden': 'true', text: '?' }), el('span', { class: 'sn-text', text: 'Which Viking are you?' }));
    }
    return el('div', { class: 'sn-me-row' },
      el('a', { class: 'sn-link sn-me', href: meHref(), title: rail ? `You: ${m}` : null, 'aria-current': cur ? 'page' : null, onclick: inSheet ? () => closeSheet() : null },
        lookAvatar(m, 'sn-avatar sn-look', inSheet ? 'shme' : 'snme') || el('span', { class: 'sn-avatar', 'aria-hidden': 'true', style: { background: colorOf(m) }, text: [...m][0].toUpperCase() }),
        el('span', { class: 'sn-text' }, el('small', { text: 'You' }), m)),
      el('button', { type: 'button', class: 'sn-swap', title: 'Not you? Pick again', 'aria-label': 'Pick who you are', text: 'change', onclick: pickMe }));
  }
  // Mark the visitor's name: links to their page, their rows and bars, their labels on charts and maps.
  function markMe() {
    const m = me();
    for (const n of document.querySelectorAll('#view .is-me, #view .me-row')) n.classList.remove('is-me', 'me-row');
    if (!m) return;
    const href = meHref();
    for (const a of document.querySelectorAll('#view a[href]')) if (a.getAttribute('href') === href) { a.classList.add('is-me'); a.closest('tr, .hbar, li')?.classList.add('me-row'); }
    for (const n of document.querySelectorAll('#view td, #view .hbar .name, #view text, #view .winner, #view .who')) {
      if (n.textContent.trim() !== m) continue;
      n.classList.add('is-me');
      n.closest('tr, .hbar')?.classList.add('me-row');
    }
  }

  // ---- since your last visit
  function visitStart() {
    const now = Date.now() / 1000, seen = Number(store.get('gs.seen')) || 0;
    if (seen && now - seen > 30 * 60) store.set('gs.since', String(seen));
    store.set('gs.seen', String(now));
    S.since = Number(store.get('gs.since')) || null;
    setInterval(() => { if (document.visibilityState === 'visible') store.set('gs.seen', String(Date.now() / 1000)); }, 60 * 1000);
  }
  function sinceCard() {
    const t0 = S.since, d = S.data, m = me();
    if (!t0 || d.generated - t0 < 10 * 60) return null;
    const who = (p) => el('a', { class: 'plain', href: `#/p/${encodeURIComponent(p)}`, text: p });
    const join = (xs) => xs.flatMap((x, i) => (i ? [', ', x] : [x]));
    const out = [];
    const line = (ico, ...kids) => out.push(el('li', null, el('span', { class: 'since-ico', 'aria-hidden': 'true', text: ico }), el('span', null, kids)));
    // played
    const played = new Map();
    for (const s of d.sessions) if (s.end_t > t0) played.set(s.p, (played.get(s.p) || 0) + Math.min(s.end_t, d.generated) - Math.max(s.s, t0));
    if (played.size) line('🕑', join([...played].sort((x, y) => y[1] - x[1]).map(([p, v]) => [who(p), ` ${fH(v)}`])), ' played');
    // bosses and milestones
    const w = d.world, kt = keyTimes();
    const reached = Object.entries(kt).filter(([k, v]) => !v.before && v.to > t0 && (k.startsWith('defeated_') || MILESTONES[k]))
      .map(([k]) => w?.bosses.find((b) => b[0] === k)?.[1] ? `${w.bosses.find((b) => b[0] === k)[1]} defeated` : milestoneName(k));
    if (reached.length) line('★', reached.join(' · '));
    const fs = (d.fights || []).filter((f) => f.s > t0);
    if (fs.length) line('⚔', el('a', { class: 'plain', href: '#/bosses', text: plural(fs.length, 'boss fight') }), ` · ${nf(fs.filter((f) => f.outcome === 'killed').length)} won`);
    // deaths
    const died = new Map();
    for (const x of d.deaths) if (x.t > t0) died.set(x.p, (died.get(x.p) || 0) + 1);
    if (died.size) {
      const n = [...died.values()].reduce((a, b) => a + b, 0);
      line('☠', el('a', { class: 'plain', href: '#/deaths', text: plural(n, 'death') }), ' — ', join([...died].sort((x, y) => y[1] - x[1]).map(([p, k]) => [who(p), ` ${nf(k)}`])),
        m && died.get(m) ? ` (you: ${nf(died.get(m))})` : '');
    }
    const rs = d.raids.filter((r) => r.t > t0);
    if (rs.length) line('⚑', el('a', { class: 'plain', href: '#/raids', text: plural(rs.length, 'raid') }), m && rs.some((r) => r.players?.includes(m)) ? ` · you were there for ${nf(rs.filter((r) => r.players?.includes(m)).length)}` : '');
    const zs = d.zones.filter((z) => z.t > t0);
    if (zs.length) line('🗺', el('a', { class: 'plain', href: '#/world', text: `${plural(zs.length, 'new zone')} explored` }), m && zs.some((z) => z.by.includes(m)) ? ` · ${nf(zs.filter((z) => z.by.includes(m)).length)} with you there` : '');
    // building, storage, pets: last world save before the visit against the latest
    const hist = d.world_history || [], h0 = [...hist].reverse().find((h) => h.t <= t0), h1 = hist[hist.length - 1];
    if (h0 && h1 && h1 !== h0) {
      const pieces = (h) => Object.values(h.pieces || {}).reduce((a, b) => a + b, 0);
      const dp = pieces(h1) - pieces(h0), ds = (h1.stored || 0) - (h0.stored || 0), mine = m ? (h1.pieces?.[m] || 0) - (h0.pieces?.[m] || 0) : 0;
      const parts = [dp ? `${dp > 0 ? '+' : ''}${nf(dp)} building pieces${mine ? ` (yours: ${mine > 0 ? '+' : ''}${nf(mine)})` : ''}` : null,
        ds ? `${ds > 0 ? '+' : ''}${nf(ds)} items in chests` : null].filter(Boolean);
      if (parts.length) line('🏠', el('a', { class: 'plain', href: '#/base', text: parts.join(' · ') }));
    }
    // pets carry when they spawned (world clock), not when they were tamed. Bred and hatched ones spawn young; growing up
    // spawns the adult anew (a Chicken becomes a new Hen), so adults spawned since are the same animals again, not births.
    const w0 = worldAt(t0), since = (p) => w0 != null && p.born != null && p.born > w0;
    const born = (d.pets || []).filter((p) => since(p) && PET_YOUNG.has(p.s)).length;
    const grew = (d.pets || []).filter((p) => since(p) && PET_GROWN.has(p.s)).length;
    const lost = (d.pets || []).filter((p) => p.death?.t > t0).length;
    if (born || grew || lost) line('🐗', el('a', { class: 'plain', href: '#/pets', text: [born ? `${plural(born, 'pet')} born` : null,
      grew ? `${nf(grew)} grew up` : null, lost ? `${plural(lost, 'pet')} died` : null].filter(Boolean).join(' · ') }));
    if (STEAM()?.achievements) {
      const us = unlocks().filter((u) => u.t > t0);
      if (us.length) line('🏆', join(us.slice(0, 4).map((u) => [who(u.p), ` unlocked ${u.a.n}`])), us.length > 4 ? ` and ${nf(us.length - 4)} more` : '');
    }
    if (!out.length) return null;
    return card('Since your last visit', `${fAgo(d.generated - t0)} · ${fDateTime(t0)}`, el('ul', { class: 'since' }, out), 'span-12',
      el('button', { type: 'button', class: 'more-link since-done', text: 'Mark as seen', onclick: () => { store.set('gs.since', String(d.generated)); S.since = d.generated; scheduleRender(); } }));
  }

  // Per-route state that comes from the link itself (e.g. sort order).
  function enterRoute() {
    const r = route();
    if (r.view === 'sessions') Object.assign(S.sl, { key: r.q.get('sort') === 'dur' ? 'dur' : 's', asc: false, limit: 50 });
  }
  function go(p) { location.hash = `#/p/${encodeURIComponent(p)}`; }

  function setRange(a, b, preset) {
    S.a = Math.max(S.min, Math.min(a, S.max - HOUR));
    S.b = Math.min(S.max, Math.max(b, S.a + HOUR));
    S.preset = preset;
    syncRangeUI();
    scheduleRender();
  }
  function applyPreset(days) {
    setRange(days ? S.max - days * DAY : S.min, S.max, days);
  }
  function syncRangeUI() {
    const ra = $('#range-a'), rb = $('#range-b');
    for (const r of [ra, rb]) { r.min = S.min; r.max = S.max; r.step = HOUR; }
    ra.value = S.a; rb.value = S.b;
    const span = S.max - S.min || 1;
    const fill = $('#range-fill');
    fill.style.left = `${((S.a - S.min) / span) * 100}%`;
    fill.style.width = `${((S.b - S.a) / span) * 100}%`;
    $('#range-label').textContent = `${fDateTime(S.a)} – ${S.b >= S.max ? 'now' : fDateTime(S.b)} · ${fDur(S.b - S.a)}`;
    $('#range-toggle-label').textContent = `${fDate(S.a)} – ${S.b >= S.max ? 'now' : fDate(S.b)}`;
    const da = $('#date-a'), db = $('#date-b'), lo = dayOf(S.min), hi = dayOf(S.max);
    da.min = db.min = lo; da.max = db.max = hi;
    if (document.activeElement !== da) da.value = dayOf(S.a);
    if (document.activeElement !== db) db.value = dayOf(Math.max(S.a, S.b - 1));
    for (const btn of document.querySelectorAll('#presets button')) {
      btn.setAttribute('aria-pressed', String(S.preset !== null && Number(btn.dataset.preset) === S.preset));
    }
  }

  let raf = 0;
  function scheduleRender() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }
  function render() {
    const d = S.data;
    if (!d) return;
    untip();
    const r = route();
    document.title = r.player ? `${r.player} · ${d.title} stats` : r.view ? `${r.view === 'item' ? pretty(r.arg) : r.view === 'creature' ? gatherLabel(r.arg) : r.view === 'fight' ? fightTitle(r.arg) : pageTitle(r)} · ${d.title} stats` : `${d.title} · stats`;
    renderHeader();

    pending = [];
    const view = $('#view');
    const y = S.restoreY ?? scrollY;
    S.restoreY = null;
    const keep = keepUi(view, S.drawnHash === location.hash);
    S.drawnHash = location.hash;
    view.replaceChildren(...(!d.scoring ? [el('div', { class: 'empty-state', text: 'The stats are being updated — back in a minute.' })]
      : r.player ? playerView(r.player, r.tab) : r.view ? VIEWS[r.view](r) : overview()));
    for (const fn of pending) fn();
    pending = [];
    keep.restore(view);
    decorateCards();
    markMe();
    const target = S.focus && document.getElementById(S.focus), pinned = !target && S.pin && document.getElementById(S.pin);
    S.focus = null;
    if (target) {
      reveal(target);
      target.scrollIntoView({ behavior: reducedMotion() || S.pin ? 'auto' : 'smooth', block: 'start' });
      target.classList.add('flash');
    } else if (pinned) pinned.scrollIntoView({ block: 'start' });
    else scrollTo(0, y);
    renderNav();
    syncUrl();
  }
  // What a redraw must not take away: the input being typed in (its text and caret) and the open <details>.
  const keepKey = (n) => n.dataset.keep || `${n.getAttribute('aria-label') || ''}|${n.placeholder || ''}`;
  const detailsKey = (d) => `${d.closest('.card')?.id || d.closest('.card')?.querySelector('h2, .card-title')?.textContent || ''}|${d.querySelector('summary')?.textContent || ''}`;
  function keepUi(view, samePage) {
    const a = document.activeElement, typing = samePage && a && view.contains(a) && a.tagName === 'INPUT'
      ? { key: keepKey(a), value: a.value, from: a.selectionStart, to: a.selectionEnd } : null;
    const open = new Set(samePage ? [...view.querySelectorAll('details[open]')].map(detailsKey) : []);
    return {
      restore(v) {
        if (open.size) for (const d of v.querySelectorAll('details')) if (open.has(detailsKey(d))) d.open = true;
        const n = typing && [...v.querySelectorAll('input')].find((x) => keepKey(x) === typing.key);
        if (n) {
          if (n.value !== typing.value) n.value = typing.value;
          n.focus({ preventScroll: true });
          try { n.setSelectionRange(typing.from, typing.to); } catch { /* not a text input */ }
        }
      },
    };
  }
  // A reload (F5) starts from nothing in memory: the tab keeps scroll position per page, the maps (zoom, pan, filter line,
  // colour, ground) and the tables in sessionStorage, and the page picks them up after its first draw.
  const UI_KEY = 'gs.ui';
  const session = {
    get: () => { try { return JSON.parse(sessionStorage.getItem(UI_KEY) || 'null'); } catch { return null; } },
    set: (v) => { try { sessionStorage.setItem(UI_KEY, JSON.stringify(v, (k, x) => (x === Infinity ? 'Infinity' : x))); } catch { /* not kept */ } },
  };
  let scrolls = {};
  function saveUi() {
    if (S.data) scrolls[splitHash(location.hash).path] = scrollY;
    session.set({ scrolls, maps: S.maps, tables: S.tables, dungeonLine: S.dungeonLine ?? null });
  }
  function loadUi() {
    const u = session.get();
    if (!u) return null;
    const inf = (o) => { for (const k in o) if (o[k] === 'Infinity') o[k] = Infinity; return o; };
    scrolls = u.scrolls || {};
    if (u.dungeonLine != null) S.dungeonLine = normalizeOld(u.dungeonLine);
    for (const [k, m] of Object.entries(u.maps || {})) S.maps[k] = { ...m, noUser: false, line: withDefaultUser(normalizeOld(m.line ?? MAP_LINE_DEFAULT)), focused: m.focused ?? null };
    for (const [k, t] of Object.entries(u.tables || {})) S.tables[k] = inf(t);
    return scrolls[splitHash(location.hash).path] ?? null;
  }

  // Server state from the collector's signals: RCON answers every minute while the game server is up
  // (positions.ok = last answer); "New session server" in the log marks a (re)start (restarts).
  function serverState(d) {
    const now = Date.now() / 1000;
    if (now - d.generated > 300) return { k: 'unknown', t: 'Status unknown', tip: `no fresh data since ${fAgo(now - d.generated)}` };
    const ok = d.positions?.ok || 0, start = d.restarts?.at(-1) || 0;
    if (!d.positions) return null;  // a server without RCON: nothing to say
    if (d.generated - ok <= 180) return { k: 'online', t: 'Online', tip: `answering · up since ${fDateTime(start)}` };
    if (start > ok && d.generated - start <= 600) return { k: 'restarting', t: 'Restarting', tip: `starting since ${fAgo(d.generated - start)}, world still loading` };
    return { k: 'offline', t: 'Offline', tip: ok ? `last answer ${fAgo(d.generated - ok)}` : 'not answering' };
  }
  function renderServerState(d) {
    const s = serverState(d), pill = $('#server-pill');
    pill.hidden = !s;
    if (!s) return;
    pill.className = `pill server-pill ${s.k}`;
    $('#server-text').textContent = s.t;
    pill.title = `Server ${s.t.toLowerCase()} · ${s.tip}`;
  }

  function renderHeader() {
    const d = S.data;
    $('#title').textContent = d.title;
    // the support card, when the server's config has a link (servers[].support: url, label, text)
    const sup = d.support, ok = /^https?:\/\//.test(sup?.url || '');
    $('#support').hidden = !ok;
    if (ok) {
      $('#support-link').href = sup.url;
      if (sup.label) $('#support-link').lastChild.textContent = ` ${sup.label}`;
      if (sup.text) $('.support-text').textContent = sup.text;
    }
    const day = gameClock(Date.now() / 1000)?.day ?? d.day;
    $('#subtitle').textContent = [d.game === 'valheim' ? 'Valheim dedicated server' : d.game, day != null ? `day ${day}` : null, d.version].filter(Boolean).join(' · ');
    renderServerState(d);
    const pill = $('#online-pill'), n = d.online.length;
    pill.classList.toggle('on', n > 0);
    pill.classList.toggle('none', !n);
    $('#online-count').textContent = n ? String(n) : '';
    $('#online-text').textContent = n ? `online: ${d.online.join(', ')}` : 'Nobody online';
    pill.title = n ? `Online: ${d.online.join(', ')}` : '';
    pill.setAttribute('aria-label', n ? `${plural(n, 'player')} online — show details` : 'Nobody online — show details');
    $('#updated').textContent = `Updated ${fTime(d.generated)}`;
    if (!$('#online-pop').hidden) fillOnlinePop();
    renderClock();
  }

  // ---- in-game clock. The world clock only runs while someone is connected, so it is the
  // collector's anchor (last sleep, or the hourly world save) plus the time anyone was online since.
  const DAY_LEN = 1800, MORNING = 0.15;  // EnvMan: seconds per in-game day; sleeping wakes you at this raw fraction
  // EnvMan.RescaleDayFraction: raw 0.15–0.85 is stretched to 0.25–0.75, so daylight lasts 21 of the
  // 30 minutes and waking (raw 0.15) is 06:00. IsNight/IsAfternoon and the sky use the rescaled value.
  const rescale = (r) => (r < 0.15 ? (r / 0.15) * 0.25 : r <= 0.85 ? 0.25 + ((r - 0.15) / 0.7) * 0.5 : 0.75 + ((r - 0.85) / 0.15) * 0.25);
  const unscale = (f) => (f < 0.25 ? (f / 0.25) * 0.15 : f <= 0.75 ? 0.15 + ((f - 0.25) / 0.5) * 0.7 : 0.85 + ((f - 0.75) / 0.25) * 0.15);
  // [until rescaled fraction, icon, name]; night is the game's IsNight (before 06:00, from 18:00)
  const PHASES = [[0.25, '🌙', 'Night'], [0.3, '🌅', 'Dawn'], [0.5, '☀️', 'Morning'], [0.7, '🌤️', 'Afternoon'], [0.75, '🌇', 'Dusk'], [1, '🌙', 'Night']];
  function gameClock(now) {
    const k = S.data?.clock;
    if (!k) return null;
    const spans = S.data.sessions.map((s) => [Math.max(s.s, k.t), Math.min(s.e ?? now, now)]).filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0]);
    let on = 0, end = -Infinity;
    for (const [x, y] of spans) if (y > end) { on += y - Math.max(x, end); end = y; }
    const t = k.time + on, raw = (t % DAY_LEN) / DAY_LEN, f = rescale(raw);
    const i = PHASES.findIndex(([to]) => f < to), last = i === PHASES.length - 1;
    const min = Math.floor(f * 1440);
    return {
      k, worldTime: t, ico: PHASES[i][1], phase: PHASES[i][2], day: Math.floor((t - MORNING * DAY_LEN) / DAY_LEN),
      hhmm: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
      // real seconds (of someone online) until the next phase; after the evening night comes dawn
      next: PHASES[last ? 1 : i + 1][2], until: ((unscale(last ? PHASES[0][0] : PHASES[i][0]) - raw + 1) % 1) * DAY_LEN,
      running: S.data.sessions.some((s) => s.e == null),
    };
  }
  function renderClock() {
    const c = gameClock(Date.now() / 1000), pill = $('#clock-pill');
    pill.hidden = !c;
    if (!c) return;
    $('#clock-ico').textContent = c.ico;
    $('#clock-day').textContent = `Day ${nf(c.day)} ·`;
    $('#clock-time').textContent = c.hhmm;
    pill.classList.toggle('paused', !c.running);
    pill.setAttribute('aria-label', `In-game: day ${c.day}, ${c.phase.toLowerCase()}, ${c.hhmm}${c.running ? '' : ', time paused'} — show details`);
    if (!$('#clock-pop').hidden) fillClockPop(c);
  }
  function fillClockPop(c) {
    $('#clock-pop').replaceChildren(
      el('div', { class: 'pop-title', text: `${c.ico} ${c.phase} · day ${nf(c.day)}, ${c.hhmm}` }),
      el('div', { class: 'pop-line', text: c.running ? `${c.next} in ${fDur(c.until)}` : `Time stands still — nobody is online. ${c.next} comes ${fDur(c.until)} after someone joins.` }),
      el('div', { class: 'pop-foot', text: `Estimated from the ${c.k.src === 'save' ? 'hourly world save' : 'last time everyone slept'} (${fTime(c.k.t)}) plus the time anyone has been online since: the world clock only runs while someone is connected. An in-game day lasts 30 minutes.` }));
  }
  function toggleClockPop(open) {
    const pop = $('#clock-pop'), pill = $('#clock-pill');
    const c = S.data && gameClock(Date.now() / 1000);
    open = Boolean((open ?? pop.hidden) && c);
    if (open) { fillClockPop(c); toggleOnlinePop(false); }
    pop.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
  }

  // ---- "who's online" popover
  function fillOnlinePop() {
    const d = S.data;
    const live = d.sessions.filter((s) => s.e == null);
    $('#online-pop').replaceChildren(
      el('div', { class: 'pop-title', text: live.length ? `${plural(live.length, 'player')} online` : 'Nobody online' }),
      live.length ? el('ul', { class: 'pop-list' }, live.map((s) => el('li', null,
        el('a', { class: 'who plain', href: `#/p/${encodeURIComponent(s.p)}`, onclick: () => toggleOnlinePop(false) },
          el('i', { class: 'sw', style: { background: colorOf(s.p) } }), s.p),
        el('span', { class: 'hint', text: `since ${fTime(s.s)} · ${fDur(d.generated - s.s)}` })))) : null,
      el('div', { class: 'pop-foot', text: `As of ${fDateTime(d.generated)} · updates every ${fDur(d.interval || HOUR)}` }));
  }
  function toggleOnlinePop(open) {
    const pop = $('#online-pop'), pill = $('#online-pill');
    open = open ?? pop.hidden;
    if (open && S.data) { fillOnlinePop(); toggleClockPop(false); }
    pop.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
  }

  function initControls() {
    for (const btn of document.querySelectorAll('#presets button')) {
      btn.addEventListener('click', () => applyPreset(Number(btn.dataset.preset)));
    }
    const ra = $('#range-a'), rb = $('#range-b');
    const onInput = (which) => () => {
      let a = Number(ra.value), b = Number(rb.value);
      if (b - a < HOUR) { if (which === 'a') a = b - HOUR; else b = a + HOUR; }
      setRange(a, b, null);
    };
    ra.addEventListener('input', onInput('a'));
    rb.addEventListener('input', onInput('b'));
    // Dates are whole local days: from the start of "from" to the end of "to" (or now).
    const da = $('#date-a'), db = $('#date-b');
    const onDate = () => {
      if (!da.value || !db.value) return;
      let [ka, kb] = [da.value, db.value];
      if (ka > kb) [ka, kb] = [kb, ka];
      const nextDay = dayStart(dayOf(dayStart(kb) + DAY + 2 * HOUR));  // +26 h is in the next day even across DST
      setRange(dayStart(ka), Math.min(S.max, nextDay), null);
    };
    da.addEventListener('change', onDate);
    db.addEventListener('change', onDate);
    // Pin the filter bar under the header: its height changes as it wraps, so measure it.
    const header = $('.top'), filters = $('.filters');
    const setTop = () => document.documentElement.style.setProperty('--top-h', `${Math.round(header.getBoundingClientRect().height)}px`);
    new ResizeObserver(setTop).observe(header);
    setTop();
    // …and the filter bar, so a card scrolled to lands below both
    // and how far its pinned backdrop reaches: left to the content column (the sidebar's edge), right to the window's
    const measureFilters = () => {
      const r = filters.getBoundingClientRect(), root = document.documentElement.style, col = $('.content').getBoundingClientRect();
      root.setProperty('--filters-h', `${Math.round(r.height)}px`);
      root.setProperty('--fl-left', `${Math.max(0, Math.round(r.left - col.left))}px`);
      root.setProperty('--fl-right', `${Math.max(0, Math.round(document.documentElement.clientWidth - r.right))}px`);
    };
    new ResizeObserver(measureFilters).observe(filters);
    addEventListener('resize', measureFilters, { passive: true });
    // the sidebar: full, rail or (phones) none, and the scroll-spy
    navMode();
    for (const q of [WIDE, PHONE]) matchMedia(q).addEventListener('change', () => { $('#sidenav').classList.remove('open'); closeSheet(); renderNav(); });
    addEventListener('scroll', () => { if (!spyRaf) spyRaf = requestAnimationFrame(spy); }, { passive: true });
    $('#sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheet(); });
    let stuckRaf = 0;
    const checkStuck = () => {
      stuckRaf = 0;
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h')) || 0;
      filters.classList.toggle('stuck', scrollY > 0 && filters.getBoundingClientRect().top <= top + 1);
    };
    addEventListener('scroll', () => { if (!stuckRaf) stuckRaf = requestAnimationFrame(checkStuck); }, { passive: true });
    addEventListener('resize', checkStuck, { passive: true });
    checkStuck();  // a reload can land mid-page without a scroll event
    // Phones: dates and slider fold away (they'd eat the screen while pinned); the toggle opens them.
    $('#range-toggle').addEventListener('click', () => {
      const open = filters.classList.toggle('open');
      $('#range-toggle').setAttribute('aria-expanded', String(open));
    });
    // Back to the top: lower right, once the page has scrolled past roughly a screen.
    const toTop = el('button', { type: 'button', class: 'to-top', title: 'Back to the top', 'aria-label': 'Back to the top', text: '↑',
      onclick: () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) });
    document.body.append(toTop);
    const showTop = () => toTop.classList.toggle('show', scrollY > innerHeight * 0.8);
    addEventListener('scroll', showTop, { passive: true });
    showTop();
    // Whichever thumb is closer to the click takes it (both inputs overlap).
    $('#range-track').addEventListener('pointerdown', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const t = S.min + ((e.clientX - r.left) / r.width) * (S.max - S.min);
      const useA = Math.abs(t - S.a) < Math.abs(t - S.b);
      ra.style.zIndex = useA ? 2 : 1; rb.style.zIndex = useA ? 1 : 2;
    });
    addEventListener('hashchange', () => {
      S.sess.limit = 25; S.feed.limit = 120;
      const back = trailStep(scrollY);
      enterRoute();
      closeSheet(); closeNavOverlay();
      S.card = metaOf().card;
      S.pin = null;
      if (S.card && back == null) S.focus = S.card;
      if (back != null) S.restoreY = back;
      else if (!S.focus) scrollTo(0, 0);
      render();
    });
    $('#refresh').addEventListener('click', manualRefresh);
    $('#search-btn').addEventListener('click', () => openPalette());
    let markRaf = 0;
    new MutationObserver(() => { if (!markRaf) markRaf = requestAnimationFrame(() => { markRaf = 0; markMe(); }); }).observe($('#view'), { childList: true, subtree: true });
    initKeys();
    $('#online-pill').addEventListener('click', (e) => { e.stopPropagation(); toggleOnlinePop(); });
    $('#clock-pill').addEventListener('click', (e) => { e.stopPropagation(); toggleClockPop(); });
    // touch: a tap outside a map closes a map tooltip (on the map a tap opens or moves it)
    document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !e.target.closest('.mapbox')) untip(); });
    // touch has no hover: a tap on something with a title (that does nothing else) shows the title
    let lastPointer = 'mouse';
    document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, { capture: true });
    document.addEventListener('click', (e) => {
      if (lastPointer === 'mouse') return;
      const t = e.target.closest?.('#view [title]');
      if (!t || e.target.closest('a, button, input, select, summary, label, .hov, .mapbox')) return;
      tip(e, el('div', { class: 'note', text: t.getAttribute('title') }));
    });
    addEventListener('scroll', () => { if (lastPointer !== 'mouse') untip(); }, { passive: true });
    document.addEventListener('click', (e) => {
      if (e.target.isConnected && !e.target.closest('#sidenav')) closeNavOverlay();  // a sidebar button re-renders the sidebar: detached by now
      if (!e.target.closest('.online')) toggleOnlinePop(false);
      if (!e.target.closest('.clock')) toggleClockPop(false);
    });
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeSheet(); closeNavOverlay();
      if (!$('#online-pop').hidden) { toggleOnlinePop(false); $('#online-pill').focus(); }
      if (!$('#clock-pop').hidden) { toggleClockPop(false); $('#clock-pill').focus(); }
    });
    addEventListener('keydown', (e) => {
      if (e.key !== 'r' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
      manualRefresh();
    });
    let lastW = 0;
    new ResizeObserver(() => {
      const w = $('#view').clientWidth;
      if (Math.abs(w - lastW) > 4) { lastW = w; scheduleRender(); }
    }).observe($('#view'));
  }

  // The data comes in pieces (collector/valheim_gamestats/chunks.py): index.json names the files that make it up now, each named by its
  // content — so only new names are fetched (the rest is here already, or in the browser's cache for good) and joined.
  // A poll with nothing new is index.json alone; a new minute is index.json + live.
  const SERIES = { sessions: (x) => x.s, deaths: (x) => x.t, raids: (x) => x.t, days: (x) => x.t, restarts: (x) => x,
    zones: (x) => x.t, samples: (x) => x[0], gather: (x) => x[0], visits: (x) => x[0], peaks: (x) => x[0],
    feats: (x) => x[0], world_history: (x) => x.t };
  const parts = new Map();  // file name -> its content
  async function fetchData() {
    const r = await fetch('index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
    const index = await r.json();
    if (S.data && index.generated === S.data.generated) return S.data;
    await Promise.all(index.files.filter((n) => !parts.has(n)).map(async (n) => {
      const f = await fetch(`c/${n}`);
      if (!f.ok) throw new Error(`c/${n}: HTTP ${f.status}`);
      parts.set(n, await f.json());
    }));
    for (const n of [...parts.keys()]) if (!index.files.includes(n)) parts.delete(n);
    return join(index.files.map((n) => parts.get(n)));
  }
  // the files, oldest first, back into data.json: history concatenated and in time order (open ones sit in live)
  function join(files) {
    const data = {};
    for (const f of files) {
      for (const [k, v] of Object.entries(f)) data[k] = SERIES[k] && data[k] ? data[k].concat(v) : SERIES[k] ? v.slice() : v;
    }
    for (const [k, when] of Object.entries(SERIES)) if (data[k]) data[k].sort((a, b) => when(a) - when(b));  // stable: as written
    return data;
  }
  window.gamestats = { data: () => S.data, join };  // what the page is drawn from (site tests, curious visitors)

  async function refresh(force) {
    try {
      // Don't yank the page from under someone typing in a search box;
      // the next poll picks the new data up.
      const a = document.activeElement;
      if (!force && a?.tagName === 'INPUT' && (a.type === 'search' || a.dataset.keep)) return 'skip';
      const d = await fetchData();
      if (d.generated === S.data?.generated) {
        if (force) scheduleRender(); // still refresh "x min ago" labels
        return 'same';
      }
      const atEnd = S.b >= S.max;
      load(d);
      if (S.preset !== null) applyPreset(S.preset);
      else setRange(S.a, atEnd ? S.max : S.b, null);
      return 'new';
    } catch (e) { console.warn(e); return 'error'; }
  }

  async function manualRefresh() {
    const btn = $('#refresh');
    if (btn.classList.contains('spin')) return;
    btn.classList.add('spin');
    btn.setAttribute('aria-busy', 'true');
    const t0 = Date.now();
    if (S.data) await refresh(true); else start();
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0)))); // let the spin register
    btn.classList.remove('spin');
    btn.removeAttribute('aria-busy');
  }


  // The game's strings carry Unity rich text (`<color=orange>Geirrhafa</color>`, `<color=yellow>Valuable</color>`);
  // everything here is drawn as plain text, so the tags go.
  const noRichText = (k, v) => (typeof v === 'string' ? plainText(v) : v);

  // Game item data (names, stats, icons) — optional, so it loads beside data.json and redraws when in.
  async function loadGameData() {
    try {
      const r = await fetch('icons/valheim/items.json', { cache: 'no-cache' });
      if (!r.ok) return;
      S.gd = JSON.parse(await r.text(), noRichText);
      const rc = await fetch('icons/valheim/creatures.json', { cache: 'no-cache' }).catch(() => null);
      if (rc?.ok) S.cd = JSON.parse(await rc.text(), noRichText);
      // the rendered player figure: body, underwear, hair and beard layers (tools/render_looks.py) — optional
      const rl = await fetch('icons/valheim/looks/looks.json', { cache: 'no-cache' }).catch(() => null);
      if (rl?.ok) S.lk = await rl.json();
      if (S.data) scheduleRender();
    } catch (e) { console.warn('items.json', e); }
  }

  async function start() {
    if (!S.gd) loadGameData();
    try {
      load(await fetchData());
    } catch (e) {
      $('#view').replaceChildren(el('div', { class: 'card', style: { marginTop: '16px' } },
        el('div', { class: 'empty-state', text: 'Statistics are not available yet — the first collection run may still be in progress.' })));
      $('#subtitle').textContent = String(e.message || e);
      setTimeout(start, 60000);
      return;
    }
    if (!S.trail.length) trailStep(0);  // the page it was opened on
    if (S.since === undefined) visitStart();
    enterRoute();
    const meta = metaOf();
    S.card = meta.card;
    if (!uiLoaded) {  // a reload: back to where this tab was on this page
      uiLoaded = true;
      const y = loadUi();
      if (y != null && !S.card) S.restoreY = y;
      history.scrollRestoration = 'manual';
      addEventListener('pagehide', saveUi);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveUi(); });
      let t = 0;
      addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(saveUi, 400); }, { passive: true });
    }
    if (S.card) {
      // a link to a card: hold it in place while the page still fills in (game data, charts), until the visitor takes over
      S.focus = S.pin = S.card;
      const unpin = () => { S.pin = null; for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(t, unpin); };
      for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(t, unpin, { passive: true });
      setTimeout(unpin, 5000);
    }
    if (!applyRangeParam(meta.range)) applyPreset(S.preset);
    if (!polling) polling = setInterval(() => refresh(false), 20 * 1000);  // the data changes every minute; an unchanged poll is index.json alone
    if (!ticking) ticking = setInterval(renderClock, 10 * 1000);  // the in-game clock moves 48× real time
  }
  let polling = 0, ticking = 0, uiLoaded = false;

  initControls();
  start();
})();
