"""The combat rules, from the plugin's combat facts (events "cf"): who dealt and took how much damage, who killed what —
the collector's own, so a rule change recomputes everything it has facts for (docs/ATTRIBUTION.md).

A port of plugin/CombatCore.cs, kept line for line comparable: the same names (snake_case), the same order of
decisions, the same constants. Both are pinned to the same expected results on recorded fights (tests/combat/): change
one, change the other, and RULES (the cache key) with them.

Fed with the facts of one plugin run in order (Feeder); every result is (t, e, p, i, n) — the events the plugin itself
sent until now (dmg, wdmg, dw, kill, wkill, kw, taken, hit, cost, ukill, udmg, sdw, skw), at the time it was decided.

Stdlib only.
"""
import json
import math
import os

RULES = 2  # bump with any rule change: cached results of finished runs are recomputed

MATCH_RANGE = 4.0
ATTACKER_RANGE = 60.0
HIT_WINDOW = 3.0
MATCH_SECONDS = 6.0
SETTLE_SECONDS = 3.0
KEEP = 30.0
LOOT_RANGE = 3.0
LOOT_SECONDS = 2.0
HURT_SECONDS = 10.0
NOTE_SECONDS = 3.0
MELEE_SECONDS = 1.5
MELEE_MARGIN = 4.0
MELEE_REACH = 3.0
SUMMON_REACH = 3.0
SUMMON_MARGIN = 2.0
SUMMON_KILL_SECONDS = 10.0
ROUTED_SECONDS = 0.4
DOT_SECONDS = 8.0
FACTOR_DEFAULT = 0.7
COST_SECONDS = 2.0
COST_SKILL_MIN = 0.67
COST_FACTOR_DEFAULT = (1.0 + COST_SKILL_MIN) / 2.0
# Character.ApplyDamage: a creature takes 1/(1+0.3(n-1)) of a hit, n the players within 100 m (Game.GetPlayerDifficulty,
# at most 5; the plugin records it on each health fact since 1.22.0) — effective damage is what the hits would have done
SCALE_PER_PLAYER = 0.3
SCALE_PLAYERS_MAX = 5

# the events these rules produce — in a run with facts they replace what the plugin sent (collector.py)
RESULTS = {"dmg", "wdmg", "dw", "kill", "wkill", "kw", "taken", "hit", "cost", "ukill", "udmg", "sdw", "skw", "edmg"}
# ... of which only the collector's rules make these (the plugin's CombatCore.cs never did: no parity to check)
COLLECTOR_ONLY = {"edmg"}


def scale(near):
    """How much more a hit does than a creature lost, with near players around it (None: not recorded)."""
    if not near:
        return None
    return 1.0 + SCALE_PER_PLAYER * (min(int(near), SCALE_PLAYERS_MAX) - 1)


def dist(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def flat(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2)


class Player:
    """An online player as the server saw them: character (body), dead, position, what they hold, their client."""
    __slots__ = ("name", "body", "dead", "pos", "held", "client")

    def __init__(self, name, body, dead, pos, held, client=0):
        self.name, self.body, self.dead, self.pos, self.held, self.client = name, body, dead, pos, held, client


class Meta:
    """The prefabs' facts: CombatMeta."""

    def __init__(self):
        self.ragdolls = {}   # ragdoll → creature kinds
        self.drops = {}      # creature → item → chance
        self.timed = set()
        self.noragdoll = set()
        self.costs = {}      # "Item/animation" → (flat, percent)
        self.reach = {}      # "Creature/animation" → reach
        self.names = {}      # creature → name token
        self.weapons = {}    # item → (ranged, reach, harmful)
        self.dots = {}       # item → fire + spirit + poison


class _Death:
    __slots__ = ("pos", "time", "name", "health", "attackers", "counted", "kind", "by", "hurt", "decided", "uid", "signal",
                 "credited", "players", "listed", "via", "scale")

    def __init__(self, **kw):
        self.counted = self.decided = self.credited = False
        self.signal = self.scale = None
        self.attackers = []
        for k, v in kw.items():
            setattr(self, k, v)


class _Summon:
    __slots__ = ("time", "kind", "follow", "pos", "reach", "target", "owner")

    def __init__(self, time, kind, follow, pos, reach, owner):
        self.time, self.kind, self.follow, self.pos, self.reach = time, kind, follow, pos, reach
        self.target, self.owner = None, owner


class _Routed:
    __slots__ = ("time", "player", "kind", "direct", "dot")

    def __init__(self, time, player, kind, direct, dot):
        self.time, self.player, self.kind, self.direct, self.dot = time, player, kind, direct, dot


class _Budget:
    __slots__ = ("player", "weapon", "left", "until", "cap")

    def __init__(self, player, weapon, left, until, cap):
        self.player, self.weapon, self.left, self.until, self.cap = player, weapon, left, until, cap


class _Corpse:
    __slots__ = ("pos", "time", "creature", "level", "ragdoll")

    def __init__(self, pos, time, creature, level, ragdoll):
        self.pos, self.time, self.creature, self.level, self.ragdoll = pos, time, creature, level, ragdoll


def prefab(mob):
    return mob.split("*", 1)[0]


def with_variant(kind, variant):
    return kind + ":" + variant if variant else kind


def plain(weapon):
    return weapon.split(":", 1)[0] if weapon and ":" in weapon else weapon


class Core:
    """CombatCore. out(t, e, p, i, n) gets every result; died(name, remaining) every counted death (coverage)."""

    def __init__(self, out, died=None):
        self._out = out
        self.died = died or (lambda name, remaining: None)
        self.now = 0.0
        self._deaths, self._corpses, self._seen_corpses = [], [], set()
        self._killers, self._kill_via = {}, {}
        self._attacks, self._held, self._hurt = {}, {}, {}
        self._loot, self._notes = [], []
        self._hit_by, self._used_attacks = {}, set()
        self._routed, self._budgets, self._factors, self._last_on = {}, {}, {}, {}
        self._with_ragdoll = set()
        self._summons, self._via = [], {}
        self._costs, self._cost_factor = {}, {}
        self._scale, self._scales = None, {}  # the health drop being credited: its scale; per creature: its last
        self._meta = Meta()

    def _add(self, e, p, i, n):
        self._out(self.now, e, p or "", i, n)

    # ---- inputs ----------------------------------------------------------------------------------------------------

    def meta(self, meta):
        self._meta = meta or Meta()
        self._with_ragdoll = set()
        for kinds in self._meta.ragdolls.values():
            self._with_ragdoll.update(kinds)

    def summon(self, t, uid, kind, animation, follow, pos, owner=0, variant=None):
        self.now = t
        self._summons = [a for a in self._summons if t - a.time <= KEEP]
        r = self._meta.reach.get(kind + "/" + str(animation))
        reach = r if r and r > 0 else SUMMON_REACH
        self._summons.append(_Summon(t, with_variant(kind, variant), follow, pos, reach, owner))

    def _routed_hit(self, t, uid, player, kind, direct, dot):
        if len(self._routed) > 2000:
            self._routed.clear()
        lst = self._routed.setdefault(uid, [])
        lst[:] = [h for h in lst if t - h.time <= ROUTED_SECONDS]
        if direct > 0:
            lst.append(_Routed(t, player, kind, direct, dot))
        if dot > 0:
            self._open(uid, player, kind if kind is not None else self._armed(player, t), dot * self._factor(uid), t, 0.5 * dot)

    def _open(self, uid, player, weapon, amount, t, cap):
        if len(self._budgets) > 2000:
            self._budgets.clear()
        lst = self._budgets.setdefault(uid, [])
        lst[:] = [b for b in lst if not (b.until < t or b.left <= 0.01)]
        lst.append(_Budget(player, weapon, amount, t + DOT_SECONDS, cap))

    def _factor(self, uid):
        lst = self._factors.get(uid)
        if not lst:
            return FACTOR_DEFAULT
        s = sorted(lst)
        return s[len(s) // 2]

    def loot(self, t, uid, item, by, pos):
        self.now = t
        self._loot = [x for x in self._loot if t - x[0] <= 2 * LOOT_SECONDS + SETTLE_SECONDS]
        if len(self._loot) < 1000:
            self._loot.append((t, item, by, pos))

    def kill_note(self, t, sender, to, kind):
        self.now = t
        self._notes = [n for n in self._notes if t - n[0] <= 2 * NOTE_SECONDS + SETTLE_SECONDS]
        if len(self._notes) < 1000 and to:
            self._notes.append((t, sender, to, kind))

    def hit(self, t, uid, player, damage, dot=0.0):
        self.now = t
        if not player or damage + dot <= 0:
            return
        self._routed_hit(t, uid, player, None, damage, dot)
        if len(self._hit_by) > 5000:
            self._hit_by.clear()
        self._hit_by.setdefault(uid, set()).add(player)

    def summon_hit(self, t, uid, follow, kind, damage, dot=0.0, variant=None):
        self.now = t
        kind = with_variant(kind, variant)
        if not follow or damage + dot <= 0:
            return
        self._routed_hit(t, uid, follow, kind, damage, dot)
        self._via.setdefault(uid, {})[follow] = (t, kind)

    def attack(self, t, player, weapon, animation=None):
        self.now = t
        cost = self._meta.costs.get(weapon + "/" + animation) if animation is not None else None
        if cost is not None:
            pending = self._costs.setdefault(player, [])
            pending[:] = [c for c in pending if t - c[0] <= COST_SECONDS]
            pending.append((t, weapon, cost[0], cost[1]))
        lst = self._attacks.setdefault(player, [])
        lst[:] = [a for a in lst if t - a[0] <= KEEP]
        lst.append((t, weapon))

    def player_health(self, player, before, after, max_before, max_after, t=0.0):
        self.now = t
        after = max(0.0, after)
        lost = before - after
        if lost <= 0.01:
            return 0.0
        if max_after < max_before - 0.01 and abs(after - max_after) < 0.01:
            return 0.0
        pending = self._costs.get(player)
        if pending is not None:
            pending[:] = [c for c in pending if t - c[0] <= COST_SECONDS]
            if pending:
                c = pending[0]
                full = c[2] + before * c[3] / 100.0
                margin = max(0.5, 0.02 * full)
                capped = after <= 1.0 + margin and full * COST_SKILL_MIN >= before - 1.0 - margin
                if capped or (full * COST_SKILL_MIN - margin <= lost <= full + margin):
                    pending.pop(0)
                    if not capped and full > 0:
                        self._cost_factor[player] = min(1.0, lost / full)
                    self._add("cost", player, c[1], lost)
                    return 0.0
                if lost > full + margin:
                    pending.pop(0)
                    cost = min(before - 1.0, full * self._cost_factor.get(player, COST_FACTOR_DEFAULT))
                    self._add("cost", player, c[1], cost)
                    lost -= cost
        self._add("taken", player, "", lost)
        self._add("hit", player, "", 1)
        return lost

    def creature_health(self, t, uid, mob, pos, before, after, on_list, owner=0, near=None):
        self.now = t
        self._remember(on_list, all_=False)
        after_clamped = max(0.0, after)
        lost = before - after_clamped
        if lost <= 0.01:
            return
        if len(self._hurt) > 5000:
            self._hurt.clear()
        self._hurt[uid] = t
        attackers = self._fighting(on_list, pos)
        if len(self._scales) > 5000:
            self._scales.clear()
        self._scale = self._scales[uid] = scale(near)
        try:
            self._attribute(uid, mob, pos, lost, t, on_list, owner)
        finally:
            self._scale = None
        if after_clamped <= 0:
            if len(self._killers) > 1000:
                self._killers.clear()
                self._kill_via.clear()
            via = self._via_of(uid, pos, t, attackers)
            self._killers[uid] = self._with(attackers, via)
            self._kill_via[uid] = via

    def destroyed(self, t, uid, mob, tamed, pos, synced_health, max_health, on_list, players, by=0):
        self.now = t
        self._remember(players, all_=True)
        h = synced_health if synced_health is not None else max_health if max_health is not None else 0.0
        death = _Death(pos=pos, time=t, name=mob, health=max(0.0, h),
                       via=(self._kill_via[uid] if uid in self._kill_via
                            else self._via_of(uid, pos, t, self._fighting(on_list, pos))),
                       kind=prefab(mob), by=by, listed=self._names(on_list), uid=uid, players=players or [],
                       hurt=uid in self._hurt and t - self._hurt[uid] <= HURT_SECONDS, scale=self._scales.pop(uid, None))
        death.attackers = self._killers[uid] if uid in self._killers else self._with(self._fighting(on_list, pos), death.via)
        for d in (self._killers, self._kill_via, self._via, self._hurt):
            d.pop(uid, None)
        if tamed:
            death.counted = True
            self._deaths.append(death)
            return
        if (synced_health if synced_health is not None else 1.0) <= 0:
            death.signal = "health 0"
            death.counted = True
        self._deaths.append(death)

    def ragdoll(self, t, uid, creature, level, pos, ragdoll=None):
        self.now = t
        if uid in self._seen_corpses:
            return
        self._seen_corpses.add(uid)
        self._corpses.append(_Corpse(pos, t, creature, level, ragdoll))

    def tick(self, now, players=None):
        self.now = now
        self._remember(players, all_=True)
        for k in range(len(self._corpses) - 1, -1, -1):
            corpse = self._corpses[k]
            if now - corpse.time < SETTLE_SECONDS:
                continue
            del self._corpses[k]
            match = None
            kinds = self._meta.ragdolls.get(corpse.ragdoll) if corpse.ragdoll is not None else None
            for d in self._deaths:
                if (abs(d.time - corpse.time) <= MATCH_SECONDS and dist(d.pos, corpse.pos) <= MATCH_RANGE
                        and (kinds is None or d.kind in kinds)
                        and (match is None or dist(d.pos, corpse.pos) < dist(match.pos, corpse.pos))):
                    match = d
            if match is not None and match.counted:
                continue
            if match is None:
                kind = corpse.creature if kinds is None else "/".join(kinds)
                who = f"{kind}*{corpse.level - 1}" if corpse.level > 1 else kind
                self.died(who, 0.0)
                self._unaccounted(who)
                continue
            match.signal = "ragdoll"
            match.counted = True
        for d in self._deaths:
            if not d.counted and not d.decided and d.signal is None and self._noted(d, consume=False):
                d.signal = "kill note"
                d.counted = True
        for d in self._deaths:
            if not d.counted and not d.decided and now - d.time >= SETTLE_SECONDS and self._corpseless(d.kind):
                self._settle(d)
        for d in self._deaths:
            if d.signal is not None and not d.credited and now - d.time >= SETTLE_SECONDS:
                self._credit_death(d)
        for d in self._deaths:
            if now - d.time > 2 * MATCH_SECONDS + SETTLE_SECONDS and not d.counted and not d.decided:
                self._gone(d)
        self._deaths = [d for d in self._deaths if now - d.time <= 2 * MATCH_SECONDS + SETTLE_SECONDS]
        if not self._corpses and len(self._seen_corpses) > 1000:
            self._seen_corpses.clear()

    def _corpseless(self, kind):
        return kind in self._meta.noragdoll or (len(self._meta.ragdolls) > 0 and kind not in self._with_ragdoll)

    def _settle(self, d):
        d.decided = True
        table = self._meta.drops.get(d.kind)
        if (d.kind not in self._meta.timed and table is not None and d.by != 0
                and any(x[2] == d.by and x[1] in table and flat(x[3], d.pos) <= LOOT_RANGE
                        and -LOOT_SECONDS / 2 <= x[0] - d.time <= LOOT_SECONDS for x in self._loot)):
            d.signal = "loot"
            d.counted = True
            self._credit_death(d)
            return
        self._gone(d)

    def _credit_death(self, d):
        d.credited = True
        killers = list(d.attackers)
        via = dict(d.via or {})
        for p, (time, kind) in self._via.get(d.uid or "", {}).items():
            if d.time - time <= SUMMON_KILL_SECONDS and p not in killers:
                via[p] = kind
                killers.append(p)

        def add(p):
            via.pop(p, None)
            if p not in killers:
                killers.append(p)
        for p in self._noted(d):
            add(p)
        hitters = self._hit_by.get(d.uid or "")
        if hitters is not None:
            for p in self._fighting([x for x in d.players if x.name in hitters], d.pos):
                add(p)
        for p in self._struck(d, ranged=False):
            add(p)
        if not killers:
            for p in self._struck(d, ranged=True):
                add(p)
        self._hit_by.pop(d.uid or "", None)
        self._via.pop(d.uid or "", None)
        self._kill(killers, d.name, d.time, d.signal, d, via)
        for p in killers:
            self._last_on.pop((d.uid or "", p), None)
        if killers and d.health > 0:
            self._scale = d.scale  # what was left of it: as the creature's last drop was scaled
            try:
                self._damage(killers, d.name, d.health, d.time, via=via)
            finally:
                self._scale = None

    def _noted(self, d, consume=True):
        names = []
        for i in range(len(self._notes) - 1, -1, -1):
            n = self._notes[i]
            if n[1] == d.by and d.by != 0 and abs(n[0] - d.time) <= NOTE_SECONDS and self._is_kind(n[3], d.kind):
                if n[2] not in names:
                    names.append(n[2])
                if consume:
                    del self._notes[i]
        return names

    def _is_kind(self, token, kind):
        name = self._meta.names.get(kind)
        return name == token if name is not None else token.endswith("_" + kind.lower())

    def _struck(self, d, ranged):
        names = []
        for p in d.players:
            lst = self._attacks.get(p.name)
            if not p.body or p.dead or lst is None:
                continue
            distance = dist(p.pos, d.pos)
            for time, weapon in reversed(lst):
                if time > d.time or d.time - time > HIT_WINDOW or (p.name, time) in self._used_attacks:
                    continue
                w = self._meta.weapons.get(weapon, (False, MELEE_REACH, True))
                if not w[2] or w[0] != ranged:
                    continue
                reach = ATTACKER_RANGE if w[0] else w[1] + MELEE_MARGIN
                if (w[0] or d.time - time <= MELEE_SECONDS) and distance <= reach:
                    if len(self._used_attacks) > 5000:
                        self._used_attacks.clear()
                    self._used_attacks.add((p.name, time))
                    names.append(p.name)
                    break
        return names

    def _gone(self, d):
        d.decided = True
        if d.hurt:
            self._add("gone", None, d.name, 1)  # no player: never summed (collector QUIET), kept for the coverage

    # ---- attack history ----------------------------------------------------------------------------------------------

    def between(self, player, start, end):
        return [w for (t, w) in self._attacks.get(player, []) if start <= t <= end]

    def last(self, player, at):
        for t, w in reversed(self._attacks.get(player, [])):
            if t <= at and at - t <= KEEP:
                return w
        return None

    # ---- the rules -------------------------------------------------------------------------------------------------

    @staticmethod
    def _fighting(on_list, pos):
        return [p.name for p in on_list if p.body and not p.dead and dist(p.pos, pos) <= ATTACKER_RANGE]

    def _unaccounted(self, mob):
        self._add("ukill", None, mob, 1)

    @staticmethod
    def _names(players):
        return [p.name + ("(dead)" if p.dead else "" if p.body else "(no character)") for p in players or []]

    def _attribute(self, uid, mob, pos, lost, t, on_list, owner):
        left = lost
        routed = self._routed.get(uid)
        if routed is not None:
            routed[:] = [h for h in routed if t - h.time <= ROUTED_SECONDS]
            best = None
            factor = self._factor(uid)
            for h in routed:
                if (h.time <= t + 0.05 and left >= 0.3 * h.direct * factor
                        and (best is None or abs(left - h.direct * factor) < abs(left - best.direct * factor))):
                    best = h
            if best is not None:
                routed.remove(best)
                expected = best.direct * factor
                share = min(left, 1.5 * expected)
                f = share / best.direct
                if not routed and 0.05 < f < 2 and share < left + 0.01:
                    fs = self._factors.setdefault(uid, [])
                    fs.append(f)
                    if len(fs) > 20:
                        fs.pop(0)
                self._credit(uid, best.player, best.kind if best.kind is not None else self._armed(best.player, t), mob, share)
                left -= share
                if left <= 0.01:
                    return
        budgets = self._budgets.get(uid)
        if budgets is not None:
            budgets[:] = [b for b in budgets if not (b.until < t or b.left <= 0.01)]
            open_ = [b for b in budgets if left <= b.cap + 0.01]
            total = sum(b.left for b in open_)
            if total > 0.01:
                take = min(left, total)
                for b in open_:
                    share = take * b.left / total
                    b.left -= share
                    self._credit(uid, b.player, b.weapon, mob, share)
                left -= take
                if left <= 0.01:
                    return
        hits = []
        routed_hitters = self._hit_by.get(uid, set())
        for p in on_list:
            if not p.body or p.dead or dist(p.pos, pos) > ATTACKER_RANGE:
                continue
            if (p.client != owner) if owner != 0 else (p.name in routed_hitters):
                continue
            for weapon in self.between(p.name, t - HIT_WINDOW, t):
                if self._harmful(weapon):
                    hits.append((p.name, weapon))
        for a in self._summons_at(uid, pos, t):
            if owner != 0 and a.owner != 0 and a.owner != owner:
                continue
            a.target = uid
            self._via.setdefault(uid, {})[a.follow] = (t, a.kind)
            hits.append((a.follow, a.kind))
        if not hits:
            for p in on_list:
                if p.body and not p.dead and ((p.client == owner) if owner != 0 else (p.name not in routed_hitters)):
                    for weapon in self.between(p.name, t - DOT_SECONDS, t):
                        dot = self._meta.dots.get(weapon)
                        if dot is not None and dot > 0 and left <= 0.5 * dot + 0.01:
                            hits.append((p.name, weapon))
                            break
        if not hits:
            self._add("udmg", None, mob, left)
            return
        ordered = [h for h in hits if self._is_summon(h[1])] + [h for h in hits if not self._is_summon(h[1])]
        for p, weapon in ordered:
            self._credit(uid, p, weapon, mob, left / len(hits))

    def _credit(self, uid, player, weapon, mob, amount):
        if len(self._last_on) > 5000:
            self._last_on.clear()
        self._last_on[(uid, player)] = weapon
        self._dealt(player, weapon, mob, amount)

    def _armed(self, player, at):
        for t, w in reversed(self._attacks.get(player, [])):
            if t <= at and at - t <= KEEP and self._harmful(w):
                return w
        return self._weapon_of(player, at)

    def _is_summon(self, weapon):
        return any(a.kind == weapon for a in self._summons)

    def _harmful(self, weapon):
        w = self._meta.weapons.get(weapon)
        return w is None or w[2]

    def _damage(self, attackers, mob, amount, at, uid=None, pos=None, via=None):
        hits = []
        for p in attackers:
            if via is None or p not in via:
                for weapon in self.between(p, at - HIT_WINDOW, at):
                    hits.append((p, weapon))
        if uid is not None and pos is not None:
            for a in self._summons_at(uid, pos, at):
                a.target = uid
                self._via.setdefault(uid, {})[a.follow] = (at, a.kind)
                hits.append((a.follow, a.kind))
        if not hits:
            for p in attackers:
                hits.append((p, via[p] if via is not None and p in via else self._weapon_of(p, at)))
        for p, weapon in hits:
            self._dealt(p, weapon, mob, amount / len(hits))

    def _kill(self, attackers, mob, at, signal=None, death=None, via=None):
        self.died(mob, death.health if death is not None else 0.0)
        if not attackers:
            self._unaccounted(mob)
            return
        for p in attackers:
            key = (death.uid, p) if death is not None and death.uid is not None else None
            if key is not None and key in self._last_on:
                weapon = self._last_on[key]
            elif via is not None and p in via:
                weapon = via[p]
            else:
                weapon = self._armed(p, at)
            self._add("kill", p, mob, 1)
            self._add("wkill", p, plain(weapon), 1)
            self._add("kw", p, f"{plain(weapon)}>{mob}", 1)
            if weapon != plain(weapon):
                self._add("skw", p, f"{weapon}>{mob}", 1)

    def _dealt(self, player, weapon, mob, amount):
        p = plain(weapon)
        self._add("dmg", player, mob, amount)
        self._add("wdmg", player, p, amount)
        self._add("dw", player, f"{p}>{mob}", amount)
        if weapon != p:
            self._add("sdw", player, f"{weapon}>{mob}", amount)
        if self._scale is not None:
            self._add("edmg", player, mob, amount * self._scale)

    def _summons_at(self, uid, pos, at):
        return [a for a in self._summons if at - HIT_WINDOW <= a.time <= at and (a.target is None or a.target == uid)
                and dist(a.pos, pos) <= a.reach + SUMMON_MARGIN]

    def _via_of(self, uid, pos, at, fighting):
        via = {}
        for p, (time, kind) in self._via.get(uid, {}).items():
            if at - time <= SUMMON_KILL_SECONDS and p not in fighting:
                via[p] = kind
        for a in self._summons_at(uid, pos, at):
            if a.follow not in via and a.follow not in fighting:
                a.target = uid
                via[a.follow] = a.kind
        return via

    @staticmethod
    def _with(attackers, via):
        out = list(attackers)
        for p in via:
            if p not in out:
                out.append(p)
        return out

    def _weapon_of(self, player, at):
        held = self._held.get(player)
        return self.last(player, at) or (held if held is not None else "Unarmed")

    def _remember(self, players, all_):
        if players is None:
            return
        if all_:
            self._held.clear()
        for p in players:
            self._held[p.name] = p.held if p.body else None


# ---- the facts → the core ---------------------------------------------------------------------------------------------

def _pos(f):
    return (float(f.get("x") or 0), float(f.get("y") or 0), float(f.get("z") or 0))


def _players(lst):
    return [Player(p.get("n"), bool(p.get("b")), bool(p.get("d")), _pos(p), p.get("h"), int(p.get("c") or 0)) for p in lst or []]


def _variant(f):
    right, left = f.get("rh"), f.get("lh")
    return left if right is None else right if left is None else right + "+" + left


class Feeder:
    """The facts of one plugin run, in order, into a Core: the meta from its parts, a tick before each fact (the core
    settles deaths on ticks; the plugin ticks every second, the facts' own times are as good), summons' players from
    their attack triggers. t: the time to use for each fact (the store's, wall clock)."""

    LATER = ("fire", "spirit", "poison")

    def __init__(self, out, died=None):
        self.core = Core(out, died)
        self._meta = None
        self._follows, self._holding = {}, {}

    def feed(self, t, f):
        k = f.get("k")
        if k == "meta0":
            self._meta = Meta()
            return
        if k == "meta":
            self._meta_part(f)
            return
        if self._meta is not None:  # the meta's parts came in one go at the start: complete now
            self.core.meta(self._meta)
            self._meta = None
        self.core.tick(t)
        if k == "attack":
            self.core.attack(t, f.get("p"), f.get("w"), f.get("an"))
        elif k == "player":
            self.core.player_health(f.get("p"), float(f["b"]), float(f["a"]), float(f["mb"]), float(f["ma"]), t)
        elif k == "health":
            self.core.creature_health(t, f.get("u"), f.get("m"), _pos(f), float(f["b"]), float(f["a"]), _players(f.get("l")),
                                      int(f.get("own") or 0), f.get("n"))
        elif k == "trig":
            if f.get("tamed") and f.get("fol"):
                v = _variant(f)
                self._follows[f.get("u")] = f.get("fol")
                if v:
                    self._holding[f.get("u")] = v
                self.core.summon(t, f.get("u"), f.get("m", "").split("*", 1)[0], f.get("tr"), f.get("fol"), _pos(f),
                                 int(f.get("own") or 0), v)
        elif k == "hit":
            d = f.get("d") or {}
            later = sum(float(v) for kk, v in d.items() if kk in self.LATER)
            direct = sum(float(v) for v in d.values()) - later
            am = f.get("am") or ""
            if am.startswith("player:"):
                self.core.hit(t, f.get("u"), am[7:], direct, later)
            elif f.get("att") in self._follows:
                self.core.summon_hit(t, f.get("u"), self._follows[f["att"]], am.split("*", 1)[0], direct, later,
                                     self._holding.get(f["att"]))
        elif k == "killnote":
            self.core.kill_note(t, int(f.get("fromid") or 0), f.get("to"), f.get("kind"))
        elif k == "destroy":
            h, mh = f.get("h"), f.get("mh")
            self.core.destroyed(t, f.get("u"), f.get("m"), bool(f.get("tamed")), _pos(f), None if h is None else float(h),
                                None if mh is None else float(mh), _players(f.get("l")), _players(f.get("ps")),
                                int(f.get("own") or 0))
        elif k == "ragdoll":
            self.core.ragdoll(t, f.get("u"), f.get("c"), int(f.get("lv") or 1), _pos(f), f.get("r"))
        elif k == "drop":
            self.core.loot(t, f.get("u"), f.get("i"), int(str(f.get("u", "0:")).split(":")[0] or 0), _pos(f))

    def end(self, t):
        """The run ended (or the facts so far): deaths still waiting for their credit get it, as a running server would."""
        self.core.tick(t + 2 * MATCH_SECONDS + 2 * SETTLE_SECONDS, [])

    def _meta_part(self, f):
        m = self._meta if self._meta is not None else Meta()
        self._meta = m
        s, d = f.get("s"), f.get("d")
        if s == "noragdoll":
            m.noragdoll.update(d)
        elif s == "ragdolls":
            m.ragdolls.update(d)
        elif s == "cost":
            m.costs.update({k: (float(v["f"]), float(v["p"])) for k, v in d.items()})
        elif s == "drops":
            m.drops.update(d)
        elif s == "timed":
            m.timed.update(d)
        elif s == "reach":
            m.reach.update({k: float(v) for k, v in d.items()})
        elif s == "names":
            m.names.update(d)
        elif s == "dots":
            m.dots.update({k: float(v) for k, v in d.items()})
        elif s == "weapons":
            m.weapons.update({k: (bool(v["ranged"]), float(v["reach"]), bool(v["harmful"])) for k, v in d.items()})


# ---- the collector: results from facts, where there are facts ----------------------------------------------------------

def recompute(evs, cache_path=None):
    """The events with the combat results recomputed: in every plugin run (from one "plugin" start event to the next) that
    stored combat facts, every result event (RESULTS — the plugin's and any added by hand) is replaced by what these
    rules make of the facts, per minute and rounded as the plugin flushes them. Runs without facts stay as they are.
    Each run's results are cached (cache_path, keyed by RULES and its facts): a run is computed again only when its facts
    changed (the running one, as new facts come) or the rules did."""
    starts = [ev["t"] for ev in evs if ev.get("e") == "plugin"]
    runs = []  # (start, end, facts)
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else float("inf")
        runs.append([start, end, []])
    if not runs:
        return evs
    r = 0
    for ev in evs:
        if ev.get("e") != "cf":
            continue
        while r + 1 < len(runs) and ev["t"] >= runs[r + 1][0]:
            r += 1
        if runs[r][0] <= ev["t"] < runs[r][1]:
            runs[r][2].append(ev)
    runs = [x for x in runs if x[2]]
    if not runs:
        return evs
    cache = _load(cache_path)
    keep = {}
    results = []
    for start, _end, facts in runs:
        key = f"{start:.3f}"
        sig = [len(facts), facts[-1]["t"]]
        hit = cache.get(key)
        if hit is not None and hit.get("sig") == sig:
            got = hit["results"]
        else:
            got = _run(facts)
        keep[key] = {"sig": sig, "results": got}
        results.extend({"t": t, "e": e, "p": p, "i": i, "n": n} for t, e, p, i, n in got)
    if cache_path is not None and keep != cache:
        _save(cache_path, keep)
    windows = [(start, end) for start, end, _ in runs]

    def replaced(ev):
        if ev.get("e") not in RESULTS:
            return False
        return any(start <= ev["t"] < end for start, end in windows)
    out = [ev for ev in evs if not replaced(ev)] + results
    out.sort(key=lambda ev: ev["t"])
    return out


def _run(facts):
    """One run's facts → its results per minute: [[t, e, p, i, n]], n rounded (the plugin's Gather.Flush)."""
    sums = {}

    def out(t, e, p, i, n):
        if e not in RESULTS:
            return  # "gone": never summed
        key = (int(t // 60), e, p, i)
        sums[key] = sums.get(key, 0) + n
    feeder = Feeder(out)
    last = facts[0]["t"]
    for ev in facts:
        last = ev["t"]
        feeder.feed(last, ev)
    feeder.end(last)
    res = []
    for (minute, e, p, i), n in sums.items():
        if round(n) >= 1:
            res.append([minute * 60 + 59, e, p, i, round(n)])
    res.sort(key=lambda x: x[0])
    return res


def _load(path):
    if not path:
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data.get("runs", {}) if data.get("rules") == RULES else {}


def _save(path, runs):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"rules": RULES, "runs": runs}, f, separators=(",", ":"))
    os.replace(tmp, path)
