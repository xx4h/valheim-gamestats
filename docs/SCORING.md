# Scoring: what counts how much

Two questions decide every ranking on the page:

- **Who gets credit** for something: who explored a zone, who killed the troll. That is fixed, the same on every
  server, and written down in [ATTRIBUTION.md](ATTRIBUTION.md).
- **How much it counts**: what the impact score weighs, which titles exist and what it takes to get one, the steps of a
  badge, a trading card's yardsticks. That is up to each server's owner, and it's what this document is about.

The defaults live in one file, [`collector/valheim_gamestats/scoring.json`](../collector/valheim_gamestats/scoring.json).
A server changes them with **overrides** in its configuration. The collector merges the overrides into the defaults,
checks them, and publishes the result with the data (the `scoring` key). Both the page and the Discord feed compute
from that one copy. Visitors see the rules in force on the page under **Players → Scoring** (`#/scoring`); anything the
server changed is marked ✎, with the default on hover.

| System | Where it shows | What you can change | `scoring.json` |
|---|---|---|---|
| [Impact score](#impact-score) | leaderboard, first column and default order | the weight of every leaderboard stat, as a bonus or a penalty | `impact` |
| [Titles](#titles) | Titles card; Discord when a title changes hands; weekly recap | on/off, minimum, group, icon, name, rule text; group names | `titles`, `title_groups` |
| [Medals](#medals) | Discord "leaderboard shake-up" posts | which columns are announced, their labels | `medals` |
| [Badges](#badges) | player page; the medal and foil on the trading card | on/off, steps, name, icon, unit; the level names and icons | `badges`, `badge_tiers` |
| [Trading cards](#trading-cards) | player page; Discord when a card evolves | yardsticks, rarity thresholds | `cards` |
| [Bynames & spirit animals](#bynames--spirit-animals) | player page (card, saga) | on/off, weight, byname, animal | `traits` |
| [Report card](#report-card) | player page | on/off, grade steps, name, comments; hours before grading | `grades` |
| [Milestones](#milestones) | "Coming up" card; Discord milestone posts | the steps | `milestones` |

## Changing the rules

### Where

**With the Helm chart:** `scoring` in the values applies to every server, and `servers[].scoring` applies to one server
and wins over the global block:

```yaml
scoring:                       # every server
  impact:
    bonus: { built: 30, dist: 5 }
    penalty: { deaths: 0 }
  titles:
    ragequit: { enabled: false }
    marathon: { min: 7200 }
servers:
  - id: my-valheim
    scoring:                   # this server only, on top of the above
      badges:
        slayer: { steps: [5, 50, 500, 5000, 50000] }
```

The chart ships a `values.schema.json`, so Helm refuses an unknown key, a wrong type or a negative number before
anything is installed:

```
- at '/servers/0/scoring/titles': additional properties 'marthon' not allowed
```

**Without Kubernetes:** the same blocks go into `config.json`: `"scoring"` at the top level, and `"scoring"` in a
server's entry ([MANUAL-DEPLOYMENT.md](MANUAL-DEPLOYMENT.md)).

### How overrides work

- **Name only what you change.** Mappings merge key by key, and everything you leave out keeps its default.
- **Lists replace the whole list.** A badge's `steps` or a milestone list is given in full.
- **`enabled: false`** switches an entry off: a title, a medal column, a badge, a trait or a report-card subject. It
  disappears from the page and the feed. `enabled: true` in a server's block switches back on what the global block
  turned off.
- **A weight of 0** takes a stat out of the impact score (or a trait out of the byname).
- **Numbers** must be ≥ 0. **Texts** must not be empty. Keys that aren't in `scoring.json` are errors, not ignored.
- **`low` and `pair` are fixed.** They say how a title is measured (the lowest value wins; the holder is a pair of
  players), not how much it counts.
- **Rule texts** may contain `{tz}`, which is replaced by the server's time zone.

### Checking a configuration

```
python3 -m valheim_gamestats.scoring check config.json
python3 -m valheim_gamestats.scoring show config.json my-valheim
```

Run both from `collector/`, with the package installed, or in the running collector container (`/config/config.json`).

- **`check`** validates every server's overrides and lists what they change. It exits 1 and names every problem:

  ```
  [my-valheim] scoring: impact.bonus.bilt: unknown — one of play, nDays, sessions, …; titles.marathon.low: fixed — it's how the metric works, not how much it counts
  ```

- **`show`** prints the rules a server ends up with.

Besides the types, the collector also checks:

- every title's group exists;
- a badge has one step per level, each bigger than the last;
- grade steps go from A+ to D, each worse than the one before;
- milestone lists go up;
- `0 < rare < epic < legendary ≤ 99`;
- at least one impact bonus is above 0.

The collector checks the configuration when it starts. With a mistake it logs `config: …` and exits with code 2. It
never runs half-configured.

### What happens when the rules change

- **The chart restarts the collector** (the config's checksum is on the pod). The next round publishes the new rules,
  and an open page picks them up within a minute.
- **The new rules apply to all of history.** Everything is computed from the events, so a changed minimum or weight
  applies to past sessions too. Nothing is stored per rule.
- **A changed rule isn't news.** The Discord feed learns the new title holders, medal standings, card rarities and
  already-passed milestones silently, then posts only real changes from there on.
- **Trading cards.** A card keeps the best rarity it ever reached. When the card rules (`cards`) change, those kept
  rarities are reset to what the cards are now; under different yardsticks, "best ever" means something else.

## The systems, with the math

### Impact score

What a player contributed in the selected range, from 0 to 100. It's the leaderboard's first column and its default
order. Every leaderboard stat can carry a **bonus** weight (more is better) or a **penalty** weight (less is better):

| Stat | Key | Default | Measures (in the range) |
|---|---|---|---|
| Playtime | `play` | 22 | time online |
| Days | `nDays` | 14 | days with any playtime |
| Sessions | `sessions` | 6 | sessions |
| Longest | `longest` | 4 | the longest session |
| Ø session | `avg` | 3 | the average session |
| Built | `built` | 18 | their pieces standing in the world now (world save) |
| Zones | `found` | 14 | zones they discovered |
| Collected | `picked` | 10 | items picked up (plugin) |
| Felled | `felled` | 5 | trees felled (plugin) |
| Mined | `mined` | 5 | rocks and ore mined out (plugin) |
| Kills | `kills` | 8 | creatures killed (plugin) |
| Dmg dealt | `dealt` | 6 | damage dealt to creatures (plugin) |
| Travelled | `dist` | 0 | metres on foot, swimming, sailing, riding (plugin) |
| Max health | `hpmax` | 0 | highest max health (plugin) |
| Deaths/h | `dph` (penalty) | 10 | deaths per hour played |
| Drain | `drain` (penalty) | 6 | the skill drain of their penalised deaths: 1 − (1 − loss)ⁿ, with loss the world's skill loss per death (5 % by default) and n the deaths that weren't free "soft deaths" |
| Deaths | `deaths` (penalty) | 4 | deaths |
| Dmg taken | `taken` (penalty) | 0 | health lost (plugin) |
| Hits taken | `hitsTaken` (penalty) | 0 | times their health dropped (plugin) |

A stat counts only when the server has it: the plugin stats need the plugin, and Built needs the world save. It must
also be *informative* in the range, meaning not every player has the same value. Then, for player *p*:

- **Bonus.** Each counted bonus stat *k* scores `s = log₁₀(1 + 9 · v / best)`, where *v* is the player's value and
  *best* the highest among players with any playtime in the range.
  - The best player gets 1, half the best 0.74, a tenth 0.28, nothing 0.
  - The log scale keeps one player with 300 hours from flattening everyone else.
  - The weights of the counted stats are scaled to add up to 100, so stat *k* adds `100 · wₖ / Σw · s`.
  - When a stat drops out of a range, the others share its weight.
- **Penalty.** Each counted penalty stat scores `v / worst`, where *worst* is the highest value among players with at
  least 1 h in the range. It subtracts `wₖ · v / worst`, so the worst player loses the whole weight.
  - Players under 1 h pay no penalty: that's too little to judge.
  - Rates (deaths per hour, drain) weigh more than raw deaths by default, because raw deaths mostly punish playing a
    lot.
- **Impact** = the bonuses − the penalties, and never below 0.

Hovering over the column header lists the weights in force for the range. Hovering over a player's impact shows what
it's made of.

### Titles

One holder at a time, per title. The player with the **highest value** in the range takes it, provided it's at least
`min`; ties share. A title marked `low` goes to the **lowest** value instead, and `min` doesn't apply.

- **Pair titles** (`pair`) go to two players together.
- **"Current world" titles** read the latest world save instead of the range.

| Field | |
|---|---|
| `group` | the heading it's listed under: a key of `title_groups` (`time`, `risk`, `fight`, `body`, `explore`, `base`) |
| `icon`, `title`, `rule` | what the page and the feed show; `rule` is the hover text and the line in Discord |
| `min` | the least value that qualifies, in the metric's unit (below) |
| `low`, `pair` | fixed: lowest wins / held by two players |
| `enabled` | `false` switches it off |

The unit of `min`:

| Unit | Titles |
|---|---|
| seconds | `marathon`, `untouchable`, `bigday`, `night`, `morning`, `wfh`, `company`, `lonewolf`, `inseparable`, `immortal`, `sneaky` |
| metres | `edgelord`, `sprinter`, `mountaineer`, `skydiver`, `globetrotter`, `fish`, `seadog`, `rider` |
| health / damage | `tank`, `oneforteam` |
| metres per second | `speeddemon` |
| share, 0–1 | `decorator`, `woodage` |
| lowest wins, no `min` | `ships`, `fastdeath`, `dejavu`, `flyer`, `homebody`, `passenger`, `tetris`, `lastbreath` |
| a count | every other title (days, sessions, deaths, zones, pieces, items, raids, kills, …) |

`scoring.json` lists all 86 titles. The page's Scoring section shows them with their rules, as the server has them.

**Discord.** The feed watches the all-time holders of every title except *Combat & gathering* (the page computes those
from the plugin's per-player breakdowns).

- A title that changes hands and stays changed for 10 minutes gets a post.
- The Sunday recap lists the week's titles, except the "current world" ones.

### Medals

**On the page,** every leaderboard column gives 🥇 🥈 🥉 to its top three in the range; ties share a place.
Fewer-is-better columns only rank players with at least 1 h. This isn't configurable.

**In Discord,** a "leaderboard shake-up" is posted when someone takes or climbs to a podium place in one of the
`medals` columns. Those standings are all-time, and a change must hold for 10 minutes.

- The columns are `play`, `sessions`, `longest`, `nDays`, `deaths` (fewest), `built` and `found`.
- Each has a `label`, and `enabled: false` stops announcing it.

### Badges

A player's own all-time progress from the plugin's stats. It's a set of goals, not a ranking.

- **Levels.** A badge has one step per level in `badge_tiers` (Bronze, Silver, Gold, Platinum, Diamond). The level is
  the number of steps reached.
- **Fields.** `name`, `icon` and `unit` (the word after the number) can be changed. `steps` are five numbers, each
  bigger than the last.
- **Level names.** `badge_tiers` renames or re-icons the levels: five entries, each `{name, icon}`. An empty `{}`
  keeps that level as it is.
- **Trading card.** The card shows a player's highest badge level. A badge at the top level makes the card **foil**.

| Badge | Counts |
|---|---|
| `slayer` | kills |
| `berserker` | damage dealt |
| `bossbane` | boss kills |
| `archer` | kills with a bow or crossbow in hand |
| `lumberjack` | trees felled |
| `prospector` | rocks and ore mined out |
| `collector` | items picked up |
| `forager` | berries, mushrooms, flowers and crops picked up |

### Trading cards

All-time stats from 0 to 99, each against a fixed yardstick. They show the player's own progress, not a ranking
against the others.

- **Counts.** `stat = round(99 · min(1, √(v / at)))`, where `at` is the stat's yardstick in `cards.at`. A quarter of
  the yardstick gives 50:

  | Stat | `cards.at` key | Counts | Default yardstick |
  |---|---|---|---|
  | Raids | `survived` | raids survived | 50 |
  | Building | `built` | pieces standing | 5,000 |
  | Exploring | `zones` | zones discovered | 2,000 |
  | Combat | `dealt` | damage dealt (plugin) | 250,000 |
  | Gathering | `picked` | items picked up (plugin) | 25,000 |

- **Survival.** `round(99 / (1 + deaths per hour / dph))`, with `cards.dph` 0.5 by default. That's 99 without deaths,
  50 at one death every two hours.
- **Rarity** comes from the average of the stats. Combat and Gathering only count where the plugin logs them;
  otherwise a 0 would drag every card down. The average is Legendary from `cards.tiers.legendary` (75), Epic from
  `epic` (50), Rare from `rare` (25), Common below that.
- **Best rarity.** A card keeps the best rarity it ever reached. The collector keeps it with the Discord feed, so it
  needs `notify`; without it, a card shows its rarity now.
- **Discord** announces a card that evolved, after 10 minutes. A drop isn't news.

### Bynames & spirit animals

Every player gets a byname ("Ragnar the Tireless") and a spirit animal from the traits they stand out in most, all
time.

- **Score.** A trait scores `weight · min(2, v / top)`, where *top* is the best value among the *other* players with
  at least 1 h. A trait the player has none of scores 0.
- **Byname and animal.** The best-scoring trait gives the byname; the second (or the only one) gives the animal.
- **Weights.** Quirky traits that hinge on one event weigh less by default (0.5–0.6). A weight of 0, or
  `enabled: false`, takes a trait out.
- **Text.** `byname`, `icon`, `animal` and `why` (the animal's line in the saga) are texts.

| Trait | Measures |
|---|---|
| `deaths` | deaths per hour |
| `survival` | 1 ÷ deaths per hour (at least 0.05) |
| `explore` | zones discovered |
| `build` | pieces standing |
| `hoard` | loot taken from world chests |
| `night` | share of playtime 00:00–05:00 |
| `company` | share of playtime with others online |
| `lone` | share of playtime alone |
| `restless` | sessions per hour played |
| `storm` | raids per hour played |
| `tireless` | the longest session |
| `honey` | honey picked up |
| `wreck` | the most pieces torn down between two hourly saves |

### Report card

Fixed steps per subject, all time: the player's own record, not graded against the others.

- **Grade.** It's the first of A+, A, B, C, D whose step the value reaches (at least the step, or at most for a
  lower-is-better subject); below D is F.
- **Not graded yet.** Players with fewer than `grades.min_hours` (5) hours aren't graded.
- **The teacher's comment** praises the subject where the player does best against its C step, and complains about
  the worst one when it's below 0.8 × C.

| Subject | Measures | Default steps A+ … D |
|---|---|---|
| `attendance` | share of days online since joining | 0.9, 0.75, 0.55, 0.35, 0.2 |
| `survival` (lower is better) | deaths per hour | 0.15, 0.3, 0.6, 1.2, 2.5 |
| `construction` | pieces per hour played | 40, 20, 10, 4, 1.5 |
| `exploration` | zones per hour played | 40, 25, 15, 8, 4 |
| `teamwork` | share of playtime with others online | 0.9, 0.75, 0.55, 0.35, 0.2 |
| `punctuality` | how regular their login time is (1 = always the same) | 0.8, 0.65, 0.5, 0.35, 0.2 |

`name`, `good` (the praise) and `bad` (the complaint) are texts. `steps` are five numbers, each worse than the one
before.

### Milestones

Round numbers. The page's "Coming up" card shows the next one at the range's pace, and the Discord feed posts when one
is passed. Every list goes up; an empty list means none.

| Key | Steps of | Where |
|---|---|---|
| `player_hours` | one player's hours on the server | Discord |
| `hours` | player-hours, all players | page, Discord |
| `zones` | zones explored | page, Discord |
| `pieces` | pieces standing | page, Discord |
| `deaths` | deaths | page, Discord |
| `count` | kills, trees felled, items collected | page |
| `day_every` | every N in-game days (0: off) | page, Discord |

## Examples

**A builders' server.** Building and exploring count most, and dying hardly matters:

```yaml
scoring:
  impact:
    bonus: { built: 40, found: 20, play: 15, kills: 2, dealt: 0 }
    penalty: { dph: 2, drain: 0, deaths: 0 }
  cards: { at: { built: 20000 } }
```

**A hardcore server.** Survival is the score:

```yaml
scoring:
  impact:
    penalty: { dph: 25, drain: 15, deaths: 10 }
  grades:
    subjects:
      survival: { steps: [0.05, 0.1, 0.2, 0.4, 0.8] }
```

**A family server.** No titles that make fun of dying or of playing little:

```yaml
scoring:
  titles:
    daredevil: { enabled: false }
    badhour: { enabled: false }
    dejavu: { enabled: false }
    fastdeath: { enabled: false }
    flyer: { enabled: false }
    ragequit: { enabled: false }
    pact: { enabled: false }
    casualty: { enabled: false }
    passenger: { enabled: false }
    ghost: { enabled: false }
  traits:
    deaths: { enabled: false }
```

## For developers

- **Numbers and texts** of how much something counts go into `scoring.json`, nowhere else. `test_scoring.py` fails if
  the page (`site/app.js`) or the feed (`notify.py`) define a table of their own again.
- **How a thing is measured** stays in code:
  - in the page: `awardMetrics()` and the `TITLE_FMT`, `BADGE_VALUE`, `TRAIT_VALUE` and `SUBJECT_VALUE` tables;
  - in the feed: `stats()`, `extra_metrics()`, `METRIC` and `FMT` in `notify.py`.
- **A new title, badge, trait or subject**:
  1. Add its entry to `scoring.json`.
  2. Add its measure to the page (and to `notify.py` for the Discord feed).
  3. Add a row in [ATTRIBUTION.md](ATTRIBUTION.md) if it credits players, and its tests.
  4. Regenerate the chart's schema: `python3 -m valheim_gamestats.scoring schema > chart/valheim-gamestats/values.schema.json`.
     `test_scoring.py` fails while it's stale.
- **The page reads the rules** with `SC()`; `#/scoring` is `scoringView()`.
- **The rules travel as their own chunk** (`c/scoring-….json`), keeping the order of `scoring.json`.
