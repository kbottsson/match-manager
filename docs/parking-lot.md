# Parking lot

Things we deliberately chose **not** to build yet, written down so they don't get
re-invented or half-built by accident. Each entry says what it is, why it waits,
and what would make it worth picking up.

Nothing here is committed. Moving something out of the lot is a decision, not a
default.

---

## Team × season as two controls

**Raised:** 2026-11-11 · **Parked by:** D

The roster screen ships with one combined control: **club + year**. A second
dropdown for **team** would let the app be run at club level (many teams, one
season) rather than inside a single team.

### How the pieces relate today

```
Club ─┬─ Season ─┬─ Roster   (people enrolled this season, each with a number)
      │          └─ Teams ──── squads, drawn from that season's roster
      │                 └───── Matches belong to a team
      └─ People            (identity, survives every season)
```

So year and team are **not two independent axes**. The year scopes the roster;
the team is a selection from it. You cannot have "P16 A" without a season
underneath it, and one kid can sit in two teams in the same season (playing up
an age group) without being enrolled twice.

### Why the second dropdown is still the right end state

At club level the useful question is not "who is enrolled in 2026" but
*"who is in P16 this year"* — the same data, filtered. That is a view, not a new
dimension, which is exactly why it can wait: **storage is already season-first,
with teams referencing the season roster**, so adding the team dropdown later is
UI work with no migration.

### The design question to settle when we build it

There are two different things a "team" dropdown could mean, and they are not
the same screen:

1. **Filter** — show the season roster narrowed to one team's players.
2. **Manage** — edit *that team's squad* (add/remove people from it).

(1) is a filter on the roster list. (2) is an editing surface that belongs with
Teams, not Roster. Pick one before building; doing both in one dropdown is how
you end up with a screen that saves when you thought it was filtering.

### Trigger

When there is more than one team per season *and* someone other than the coach
of a single team needs to use the app.

---

## Fairness rules

**Raised:** 2026-11-07 · **Parked by:** D (decision D9)

v1 reports minutes and a spread number; it never ranks or recommends. No red
"cannot catch up" warnings, no automated substitution suggestions. The coach
decides who plays; the app only does the arithmetic honestly.

**Trigger:** after a full season of real use, if the numbers alone turn out to be
insufficient.

---

## Player card and season totals

**Status:** agreed, next up — not parked

Tapping a player opens their record: appearances, minutes, average, goals,
assists, and the position split (G/B/M/F). Ranking view lives in History behind
a `Matches | Players` toggle. Depends on the person/enrolment split landing
first, which it has not yet.

---

## Position-aware Apply

**Raised:** 2026-11-11 · **Parked by:** default

`Apply` on the next-change strip lands incoming players in the outgoing player's
slot. If a plan intends a different position for them, the result won't match
the plan. Fixing it properly needs a permutation-aware swap routine (apply a
cycle of moves using the bench as scratch space).

**Why it waits:** the planner rotates players through positions every block, so
"apply the planned positions" is rarely what a coach wants mid-match anyway.

**Trigger:** if position planning is used deliberately, block by block.

---

## Re-plan from here

**Raised:** 2026-11-11 · **Parked by:** default

When a match goes off-script — injury, keeper swap, a player leaving — the
remaining blocks are fiction. A "re-plan the rest from the current lineup"
action would regenerate them.

**Trigger:** after a match where the plan was visibly abandoned mid-way.

---

## Abandoned matches

A match that is deleted, or never finalised, leaves no trace in History. If it
had minutes recorded, those minutes are invisible to any total.

**Trigger:** if totals ever disagree with a coach's memory.

---

## Cloud sync and the read-only viewer

**Status:** specified (D1, D2), not built

Phase 2: Cloudflare Workers + D1, `POST /api/teams/:slug/events`, an edit lease
with an explicit takeover, and a `○ VIEW` mode for a second phone. Phase 1 is
deliberately local-only.

**Trigger:** the second coach wants to look at the same match while it is
happening.

---

## Export

Recap text share exists. A season export (CSV or a printable summary per player)
does not.

**Trigger:** sending something to parents or the club at the end of a season.
