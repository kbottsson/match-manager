# Match Manager — Design Specification (v2, decisions locked)

**Status:** decisions D1–D12 settled. Ready for the build plan.
**Date:** 2026-11-07
**Revision:** v2.5 — **D12: controls live on the player's row.** ⚽ and ⇄ on every row (goal now 2 taps, sub 2 taps), bottom bar reduced to clock / their goal / undo, position change and minute edits behind the player's name. Cloudflare locked (D5); total minutes incl. goal (D4); 7/7/6 plan blocks.
**Author:** Hermes (for D, volunteer coach)
**Working dir:** `~/Projects/match-manager/`

---

## 0. Decisions — locked

| # | Decision | Locked |
|---|---|---|
| D1 | Where state lives | Local-first on the phone; cloud sync is an enhancement, never a dependency |
| D2 | Who edits | One editor per match, as a visible switch: `● COACH` vs `○ VIEW`. Everyone else reads. |
| D3 | Playing time | Derived from an append-only event log, never stored as counters |
| D4 | Goalie minutes | **Included.** Playing time is total minutes on the field — goal counts like any other minute. One number per player. |
| D5 | Hosting | **Cloudflare Workers + D1, locked** (no Vercel account; one vendor, static assets + SQLite in a single deploy). See §10. |
| D6 | Stack | No framework, no build step, vanilla ES modules |
| D7 | Language | **English and Swedish from the start, toggleable**, per-device, persisted |
| D8 | Positions | **G, LB, RB, LM, MM, RM, F, BN** — confirmed, see §4.6 |
| D9 | Fairness rule | **Deferred.** v1 reports the numbers (including the forecast); automated tolerance flags, red "cannot catch up" warnings and ranked sub recommendations come later. |
| D10 | Score | Both teams: our goal (scorer + optional assist), their goal (score only) |
| D11 | Clock | Manual START/STOP, referee-aligned, counts up, never auto-stops. Drift correction tucked behind the clock display, not a visible button. |
| D12 | Where controls live | **On the player's row.** ⚽ and ⇄ sit on every row; the bottom bar holds only clock, their goal and undo. Position changes and minute edits live behind the player's name. |

**Deferred by D9, explicitly out of v1:** tolerance thresholds, red/amber fairness flags, "this player can no longer reach the target" warnings, ranked substitution suggestions, fairness badges in history. The data those need is still captured, so adding them later is a UI layer, not a schema change.

---

## 1. Goal

A phone-sized web app a coach can operate one-handed, outdoors, in the cold, while watching a match — that answers, at a glance:

1. Who is on the field now, in which position?
2. How many minutes has each kid actually played — and how are those minutes split across goal, back, mid and forward?
3. What is the score, and who scored and assisted?
4. **Before kickoff:** if we play the plan I've drawn up, what does everyone's playing time look like?

## 2. Users and context of use

**Primary:** D, volunteer coach, one phone, on a touchline. Possibly gloves, low sun, rain, no signal.

**Secondary:** 1–3 other coaches who want to see live state without tapping; possibly a parent.

| Constraint | Design consequence |
|---|---|
| Zero connectivity on many pitches | Fully functional offline; cloud is sync only |
| Tapping while watching play | ≤ 2 taps per action, targets ≥ 56 px, no gestures, no long-press |
| Sunlight | Very high contrast, large type, no pastel greys |
| Cold hands / gloves | No text entry or sliders during play |
| Mistakes happen | Every action undoable; every event editable after the fact |
| Phone sleeps / tab backgrounded | Clock from absolute timestamps, never an interval counter |
| Mixed-language coaching staff | Every label localised, switchable mid-session |

## 3. Scope

### In scope (v1)

- Bilingual UI (EN / SV), toggle persisted per device.
- Roster: name, shirt number, preferred position (optional).
- **Pre-match planner**: position grid in time blocks, with an instant forecast of playing time and per-line distribution.
- Match setup: opponent, date, period count/length, availability, GK plan.
- Live: manual clock, on-field list by slot, bench, total minutes, goals, assists, substitutions, position changes, undo.
- Retroactive correction of any event.
- Recap + shareable text/PNG; match history.
- Installable PWA, offline-capable.
- Cloud sync: read-only viewers + edit-lease handover.

### Out of scope (v1)

- **The fairness rule and its flags/recommendations (D9).**
- Season aggregate statistics (data supports it; UI deferred), CSV export.
- Photos, birthdates, parent contacts, medical notes.
- Attendance, training plans, fees, comms, parent logins.
- Multi-team club administration; public team pages.

## 4. The football model

### 4.1 Shape of a match

- 7 on the field: **1 G + 2 backs (LB, RB) + 3 mids (LM, MM, RM) + 1 forward (F)**.
- ~9 available → 2 on the bench.
- 3 periods × 20 min = 60 min of playable time.
- Two substitutions per period, so each period is drawn as three blocks of 7 / 7 / 6 minutes (§4.7).

### 4.2 The maths: one number, total minutes (D4)

```
slots on the field        = 7        (1 keeper + 6 outfield)
player-minutes available  = 7 × 60   = 420
```

**Playing time is every minute on the field, goal included.** One number per player — `MIN` — because that is what a parent and a ten-year-old both understand, and because in this squad keeping goal is a role one or two kids actively *want* rather than a duty being shared out. When only one or two players want the gloves, treating keeper minutes as a separate currency creates a fairness problem that doesn't exist.

Worked cases, 9 players available:

| Keeper arrangement | Keeper's MIN | Everyone else |
|---|---|---|
| one kid keeps the whole match | 60.0 | 360 ÷ 8 = **45.0 each** |
| keeper rotated | accrues normally, like anyone in a slot | 420 ÷ 9 = **46.7 average** |

Consequences that shape the UI:

- **The keeper's 60.0 is correct, not a fairness problem.** He is on the pitch for the whole match. v1 reports it plainly and does not editorialise (D9).
- **Goal minutes survive as a secondary detail, never a second column.** The engine keeps `gkMs ⊆ playMs`, so "of which in goal" is available for the forecast and recap (useful when a keeper rotates) without being added into anything or displayed twice.
- **The live screen therefore needs no GK column at all** — the slot already says `G`, and a keeper's minutes *are* his minutes.
- More minutes in goal is not extra credit towards anything. There is one metric, and it is minutes on the grass.

### 4.3 What the keeper does to spread

Since v1 ships no fairness rule (D9), this is about honest reporting rather than enforcement. One thing worth stating plainly: **a full-match keeper is structurally 15 minutes ahead of the outfield rotation**, and no amount of planning removes that without taking him out of goal. So:

- The recap sorts everyone by `MIN`; the keeper sits at the top, where he belongs.
- His lead is expected behaviour, never phrased as a gap to close.
- Spread-as-a-number returns with the fairness rule in Phase 3, at which point it will exclude a full-match keeper by definition.

One side effect worth knowing: if the keeper *does* rotate, taking a turn in goal does not cost that child minutes — he is on the field the whole block either way, so his total is unaffected. Under total-minutes accounting, GK duty is neutral rather than a penalty.

### 4.4 Late arrivals, early leavers

A player arriving 10 minutes into period 1 changes both the on-field count and the minutes denominator. Recorded as a `roster_change` event rather than an edit, so minutes earned before the change stay correct.

### 4.5 The clock is the referee's clock

Manual **START / STOP** as the primary control. The app does not keep its own idea of time; it keeps the referee's, and the coach is the interface.

```
  idle ──start period──▶ running ──STOP──▶ paused ──START──▶ running
                            │                                    │
                            └────────── end period ◀─────────────┘
                                            │
                                          ended  ──next period──▶ idle
```

| State | Header | Playing time accrues? |
|---|---|---|
| `idle` | `P2 · 00:00` + **START PERIOD 2** | no |
| `running` | `● 07:12 / 20:00` (green dot) | **yes** |
| `paused` | `‖ STOPPED 07:12` (amber, pulsing) | no |
| `ended` | `P2 ENDED 20:00` frozen | no |

- Counts **up** from `00:00`; overrun is simply `20:47` in red.
- **Never stops itself.** The referee may play added time; the app does not overrule him.
- **Paused time is never playing time.** Rule of thumb: *if you wouldn't credit the kid for it, the clock isn't running.*
- **Drift correction is tucked away, per D11:** tapping the clock face opens `−1:00 / +1:00 / set exact`. Not a button on the action bar. The correction is a logged `clock_adjust` event and moves everyone's minutes with it.
- **Stopped and forgotten** is the failure to design against: pulsing chip, plus a reminder banner after 3 minutes paused.

### 4.6 Positions and labels (D8)

Seven slots plus a bench tag. Codes are what the UI shows on a cramped grid; names are what the pickers and the recap show.

| Slot | English | Code | Svenska | Kod |
|---|---|---|---|---|
| GK | Goalie | **G** | Målvakt | **MÅL** |
| LB | Back Left | **LB** | Vänster Back | **VB** |
| RB | Back Right | **RB** | Höger Back | **HB** |
| LM | Left Mid | **LM** | Vänster Mid | **VM** |
| MM | Mid Mid | **MM** | Mitt Mid | **MM** |
| RM | Right Mid | **RM** | Höger Mid | **HM** |
| F | Forward | **F** | Anfallare | **A** |
| — | Bench | **BN** | Bänk | **BN** |

**Two corrections I made to your list — confirmed by D, so these are now the spec:**

1. You wrote Svenska `Vänster Back - M M`. I read that as **Mitt Mid - MM** (centre midfielder), since `VB` is already Vänster Back. Alternative wording if you prefer: *Mittfältare* or *Central Mid*.
2. You wrote `Höger Back - V M`. I read that as **Vänster Mid - VM** — i.e. a copy-paste from the back line.

**Other conventions applied:**
- Display order is always left→right within a line: `LB RB | LM MM RM | F`. Your list had the mids right-first; I normalised it so the plan grid and the live list read identically.
- **Left and right are the team's own** — facing the opponent's goal, as is standard. The grid can be mirrored if it reads better from the touchline (§16, item 3).
- Codes are localised: the same slot renders `LB` in English and `VB` in Swedish. One slot identity, two labels.
- `BN` is not a slot: it is the bench tag, used in the roster and in planned rest blocks.

### 4.7 The plan: a position grid in blocks (workflow 1)

Before kickoff the coach draws the match: who plays where, in each block of time.

**Grid.** Rows = time blocks, columns = the 7 slots. **Default block = 7 minutes, giving three blocks per period and therefore two substitutions per period** — exactly your coaching rhythm. Because three 7s make 21 minutes, the last block of each period is clipped to the period end: rows read `00–07`, `07–14`, `14–20`. Nine rows per match.

The dropdown also offers `5 min`, `10 min` and `6:40 exact` for the rare match where you want a different rhythm.

**The arithmetic worth knowing before you plan.** With 7 slots and 9 players, block length decides whether the forecast can land on an equal number at all:

| Block length | Blocks | One fixed keeper (8 sharing 6 outfield slots) | GK shared (9 sharing 7 slots) |
|---|---|---|---|
| **7 min (7/7/6)** — default | 9 | 6 × 46.0 + 2 × 42.0 → **spread 4.0** | 6 × 47.0 + 3 × 46.0 → **spread 1.0** |
| 10 min | 6 | 40 or 50 → spread 10 | 40 or 50 → spread 10 |
| 5 min | 12 | 45.0 each → **spread 0** | 45 or 50 → spread 5 |
| 6:40 exact | 9 | 40 or 46.7 → spread 6.7 | 46.7 each → **spread 0** |

**Why 7-minute blocks cannot give all eight the same number — and why that is fine.** Nine blocks × 6 outfield slots = 54 slot-blocks, and 54 does not divide by 8. Two players must therefore play one block fewer than the other six. A player on seven blocks scores at least 46 minutes; a player on six blocks scores at most 42. So a 4-minute spread is the arithmetic floor for this grid, no matter how cleverly you arrange it.

That is the price of matching your real rhythm, and it is a fair price: 4 minutes across a match is small, it is visible in the forecast before kickoff, and no plan on a 9-block grid can beat it. If the keeper rotates, the same grid drops to a 1-minute spread. Only `5 min` (twelve blocks × 6 slots = 72, which divides by 8) gives a genuinely flat 45.0 for all eight — and it costs you four blocks per period, i.e. three substitutions, which is not how you coach.

`6:40 exact` is worth knowing about: it is 20 ÷ 3, the same two-subs-per-period rhythm with equal blocks instead of 7/7/6. It is exact when the keeper rotates (46.7 each) but worse than 7/7/6 when one kid keeps all match (spread 6.7). So 7/7/6 is the better default for this squad.

**Forecast (shown immediately, beside the grid).** For every player:

```
MIN        planned minutes on the field, goal included   ← the playing-time number (D4)
of which G planned minutes in goal (secondary; matters when the keeper rotates)
G/B/M/F    planned minutes split by line
Σ check    planned MIN total vs 7 × match length
```

The Σ check is the trust anchor: if `Σ MIN ≠ 420`, a slot is empty or a player is double-booked, and the planner names the offending block. The spread is shown as a plain number with no threshold attached to it — arithmetic, not judgement, so it survives D9.

**Validation (integrity, not fairness):** every block fills all 7 slots; no player in two slots in one block; nobody planned who isn't marked available.

**The plan is advisory once the whistle goes.** The live screen does not police it; it offers one quiet hint on the sub sheet: *"planned for this block: Omar"*. That honours D9 while still making the plan useful in the moment.

## 5. Workflows

### 5.1 Workflow 1 — pre-match: roster and plan

1. **Roster** (once, reused weekly): add players — name, shirt number, preferred position (optional; used only to sort pickers).
2. **New match**: opponent, venue, kickoff, periods × length (default 3 × 20), block length (default 7 min → two subs per period).
3. **Availability**: tick who is here today.
4. **Plan**: fill the grid. Tap a cell → big picker of available players, those who prefer the position first. Tap a name in the grid → swap or clear. Bench is whatever is left in a block.
5. **Forecast panel**: MIN, of which in goal, per-line split, and the Σ check. Adjust the grid until it reads right.
6. **Start period 1** at the whistle; the plan seeds the period-1, block-1 lineup.

Workflow 1 is a five-minute job the night before, and it is what makes workflow 2 easy.

### 5.2 Workflow 2 — in-match, period by period

- **Clock** START/STOP per §4.5. Periods 2 and 3 begin from the END PERIOD chip.
- **GOAL** → tap ⚽ on the scorer's row, then the assist prompt. Two taps, no picker.
- **SUB** → tap ⇄ on any row. From an on-field row the sheet opens with that player going off; from a bench row it opens with him coming on. Two taps.
- **POSITION** → tap the player's name → *change position* → tap the target slot; the app swaps with whoever is there. Three taps, and nobody leaves the field.
- **THEIR GOAL** in the bottom bar records the opponent's score; it belongs to no player, so it is one of the few match-level controls left.
- **Undo** for 6 s after every action, plus a permanent undo in the bar.
- Every event carries its period, so all stats are naturally period-by-period.

### 5.3 Post-match

Recap: score, goal timeline, minutes table sorted by `MIN`, G/B/M/F distribution, consistency line `Σ MIN 420.0 = 7 × 60 ✔`. Share as text or PNG. Saved to history.

### 5.4 Roles: Coach and Read-only (D2)

| Mode | Chip | Can do |
|---|---|---|
| **Coach** | `● COACH` (green) | everything |
| **Read-only** | `○ VIEW` (grey) | watch clock, score, on-field set, minutes. Nothing writable. |

- **Opens read-only** on any device that doesn't hold the lease. The app names the recorder: *"Read-only. D is recording this match."*
- **One editor.** The lease lives server-side (`matches.recorder_id`), so two phones cannot both believe they are coach.
- **Take over is explicit.** Confirm prompt if the holder was active within 2 minutes; on confirm the lease moves and the old device flips to `○ VIEW` with a named banner.
- **Takeover never loses data.** Unsent events from the demoted device are still accepted (idempotent by id) and tagged with their author.
- **Hand the phone over:** coach → `○ VIEW` instantly; returning to coach mode needs a two-step confirm, so a pocket tap can't unlock it.
- **Offline caveat:** with no connectivity the lease is unknowable, so the chip reads `● COACH · offline` in amber. The server's lease wins on reconnect.

## 6. Screens

Six screens.

### 6.1 Planner (pre-match)

```
┌──────────────────────────────────────────────────┐
│  PLAN · UPPÅKRA P16 vs X    [7 min ▾]    EN/SV   │
├──────────────────────────────────────────────────┤
│           G    LB   RB   LM   MM   RM   F        │
│  P1 00-07 Leo  Sam  Noah Omar Hugo Vill Isak     │
│  P1 07-14 Leo  Noah Axel Omar Elis Vill Isak     │
│  P1 14-20 Leo  Sam  Noah Elis Hugo Axel Vill     │
│  P2 00-07 Leo  Sam  Elis Omar Hugo Axel Isak     │
│  P2 07-14 Leo  Sam  Noah Omar Hugo Vill Isak     │
│  P2 14-20 Leo  Sam  Noah Elis Hugo Axel Vill     │
│  P3 00-07 Leo  Noah Axel Omar Elis Vill Isak     │
│  P3 07-14 Leo  Sam  Elis Omar Hugo Axel Isak     │
│  P3 14-20 Leo  Sam  Noah Elis Hugo Axel Vill     │
├──────────────────────────────────────────────────┤
│  FORECAST           MIN   of G                   │
│  Leo               60.0   60.0                   │
│  Sam               46.0      —                   │
│  Omar              42.0      —                   │
│  ···                                             │
│                                                  │
│  Σ MIN 420.0 ✓   spread 4.0                      │
└──────────────────────────────────────────────────┘
```

- Cells are large; the grid scrolls horizontally only below ~375 px.
- Codes are localised (`LB` / `VB`).
- The forecast updates on every cell change. Spread as a plain number plus the Σ check make it self-auditing with no rules engine (D9).

### 6.2 Live — every action anchored to a player

```
┌──────────────────────────────────────────────────┐
│ ● COACH   P2   ● 07:12 / 20:00    UPPÅKRA 2–1    │
│ ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░      │
│  00–07 ✓    07–14 ◀ now    14–20                 │
├──────────────────────────────────────────────────┤
│ ON FIELD (7)                              MIN    │
│  G   Leo 4                     38.5  [⚽] [⇄]    │
│  LB  Sam 7                     31.0  [⚽] [⇄]    │
│  RB  Noah 2                    45.5  [⚽] [⇄]    │
│  LM  Elis 9                    40.0  [⚽] [⇄]    │
│  MM  Hugo 3                    33.5  [⚽] [⇄]    │
│  RM  Axel 5                    46.5  [⚽] [⇄]    │
│  F   Ville 11                  44.0  [⚽] [⇄]    │
├──────────────────────────────────────────────────┤
│ BENCH (2)                                 MIN    │
│     Omar 8                     12.0      [⇄]     │
│     Isak 6                     48.5      [⇄]     │
├──────────────────────────────────────────────────┤
│ ┌────────────────┐ ┌─────────────┐ ┌──────┐      │
│ │ ‖   STOP       │ │ THEIR GOAL  │ │  ⟲   │      │
│ └────────────────┘ └─────────────┘ └──────┘      │
└──────────────────────────────────────────────────┘
```

Design notes:

- **The player-context rule (D12).** Almost every action in a match is *about a
  player*, so the control lives on that player's row: ⚽ logs a goal for him, ⇄
  substitutes him. The bottom bar keeps only the three things that belong to no
  single player — the clock, their goal, undo. This is why there is no "who
  scored?" picker: the row already answered it.
- **⚽ appears on on-field rows only.** A benched player cannot score, and the
  missing button says so more clearly than a disabled one.
- **44 px targets with a 10 px gap.** The density is the price of the saved tap.
  It is affordable because neither button commits anything — both open a
  reviewable step (§6.3) — and every action carries a 6 s undo.
- **Position-grouped list, not a pitch diagram.** A pitch is delightful in a mock
  and horrible to tap with a glove. A read-only pitch view can come later.
- **One minute column, `MIN`.** Goal minutes are included (D4), so the position
  cell already tells you who is in goal — a keeper's minutes *are* his minutes.
- One decimal, tabular figures: coaches argue about half-minutes, and it makes
  the Σ checks verifiable.

### 6.3 The three player sheets

Every write lands in one of four places, all anchored to the player that was tapped:

| Entry point | Opens with | Then |
|---|---|---|
| ⚽ on an on-field row | Scorer pinned, **"Assist?"** | Tap a teammate, or **No assist — save goal** |
| ⇄ on an on-field row | That player pinned red, **going off**, "Who comes on?" | Tap a bench player |
| ⇄ on a bench row | That player pinned green, **coming on**, "Who comes off?" | Tap an on-field player |
| Tap the player's name | Player sheet: log goal, substitute off, **change position**, edit minutes | *Change position* opens the seven slots, each labelled with its current occupant |

Tap counts: assisted goal **2**, unassisted goal **2**, substitution **2**,
position change **3** (name → change position → slot).

The sub sheet has two mirrored states from one component — the only difference is
which side is already chosen. That is what makes "the row is the context" work
from either end.

The `planned:` hint on the sub sheet remains the only nod to the plan:
information, not a recommendation (D9).

### 6.4 Roster

Players: name, number, preferred position, active toggle. Add / edit / archive. Reused across matches.

### 6.5 Recap

Score, goal timeline, minutes table sorted by `MIN`, G/B/M/F distribution, Σ check.

### 6.6 History

Past matches: date, opponent, score. No fairness badge — badges are a rule, and rules left with D9.

## 7. Data model

### 7.1 Principle: append-only events, derived state

Nothing is stored as "minutes played"; minutes are a projection. Which buys: exact undo, trivial multi-device merge (union by id), retroactive correction of a missed tap, and an audit trail.

```sql
-- Cloud (D1 or Turso — both SQLite, same SQL)

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,           -- capability URL component
  code_hash TEXT,                      -- coach PIN
  formation TEXT NOT NULL DEFAULT 'G,LB,RB,LM,MM,RM,F',
  period_count INTEGER NOT NULL DEFAULT 3,
  period_minutes INTEGER NOT NULL DEFAULT 20,
  block_minutes INTEGER NOT NULL DEFAULT 10,
  gk_plan TEXT NOT NULL DEFAULT 'fixed',   -- 'fixed' | 'rotate'
  locale TEXT NOT NULL DEFAULT 'sv',
  created_at TEXT NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,                  -- first name only
  shirt_no INTEGER,
  pref_positions TEXT,                 -- 'LB,LM' etc.
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  opponent TEXT, venue TEXT, kickoff_at TEXT,
  period_count INTEGER NOT NULL,
  period_minutes INTEGER NOT NULL,
  block_minutes INTEGER NOT NULL,
  gk_plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup',    -- setup|live|final
  recorder_id TEXT,                        -- edit lease
  recorder_since TEXT,
  recorder_seen_at TEXT,                   -- heartbeat; drives the 120 s busy rule
  updated_at TEXT NOT NULL
);

CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  available INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (match_id, player_id)
);

-- The plan: one row per filled cell. Configuration, not match history —
-- editable until that block's period starts, never part of the event log.
CREATE TABLE plan_blocks (
  match_id TEXT NOT NULL REFERENCES matches(id),
  block_index INTEGER NOT NULL,        -- 0..n
  period INTEGER NOT NULL,
  block_start_ms INTEGER NOT NULL,     -- offset from period start
  slot TEXT NOT NULL,                  -- 'G','LB','RB','LM','MM','RM','F'
  player_id TEXT NOT NULL REFERENCES players(id),
  PRIMARY KEY (match_id, block_index, slot)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,                 -- client UUID
  match_id TEXT NOT NULL REFERENCES matches(id),
  type TEXT NOT NULL,
  at_ms INTEGER NOT NULL,              -- wall clock when recorded
  clock_ms INTEGER,                    -- match clock at capture (advisory)
  period INTEGER,
  payload TEXT NOT NULL,
  void_of TEXT,                        -- event id this voids
  author TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_match ON events(match_id, at_ms);

-- operational, not football data
CREATE TABLE match_sessions (
  id TEXT PRIMARY KEY, match_id TEXT NOT NULL, device_id TEXT NOT NULL,
  label TEXT, role TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT
);
```

### 7.2 Event types

| type | payload | notes |
|---|---|---|
| `lineup` | `{assignments:{G:"p1",LB:"p2",...}}` | opening seven, seeded from plan block 0 |
| `period_start` | `{period:1}` | clock resets to 00:00, state → `running` |
| `clock_stop` | `{period:1}` | freezes the clock; paused time is never playing time |
| `clock_start` | `{period:1}` | resumes from the frozen value |
| `clock_adjust` | `{period:1, fromMs, toMs}` | referee alignment; moves minutes with it, logged, undoable |
| `period_end` | `{period:1}` | closes the period, freezes totals |
| `sub` | `{off:["p3"],on:["p8"],slots:{p8:"MM"}}` | rolling subs, 1..n pairs |
| `move` | `{player:"p5",from:"LM",to:"F"}` | **position change, nobody leaves the field** |
| `goal_for` | `{scorer:"p11",assist:"p9"\|null,own_goal:false}` | scorer must be on field |
| `goal_against` | `{}` | score only |
| `roster_change` | `{player:"p5",available:false}` | late arrival / early leave |
| `note` | `{text:"..."}` | overflow menu |
| `finalize` | `{}` | locks the match, triggers recap |

### 7.3 Projection

```js
project(events, config) => {
  period, state,                     // idle|running|paused|ended
  clockMs, runningSince, pausedMs,
  periodTotals: [ms, ms, ms],
  onField: { slot -> playerId },
  perPlayer: { playerId -> {
      playMs,            // total minutes on the field, goal included — THE number (D4)
      gkMs,              // subset of playMs spent in the G slot; display only, never added
      byPeriod: [ms,ms,ms],
      bySlot: { G: ms, LB: ms, MM: ms, ... },
      byLine: { G: ms, B: ms, M: ms, F: ms },
      stints: [...], goals, assists, onNow, currentStintMs
  }},
  score: { for, against },
  timeline: [...]
}
```

`clockMs` is derived, never accumulated: `now − runningSince` plus time already banked this period, advancing only while `state === 'running'`. STOP/START therefore cannot drift, and a backgrounded tab or dead phone resumes correctly.

**Invariants asserted in every test run:**

```
Σ playMs == 7 × totalRunningMs
Σ gkMs   == 1 × totalRunningMs      (and gkMs ⊆ playMs, per player)
```

Two lines that catch essentially every clock, sub and position-change bug in one property test over random event sequences.

### 7.4 Substitution UI (D9-adjusted)

No ranked recommendations in v1. The engine still computes total minutes for everyone; the sheet sorts the bench by fewest `playMs` and prints the number. The ranked-deficit algorithm from the v1 draft returns as **Phase 3** work, since it only means something once the fairness rule is back.

## 8. Clock and data robustness

| Failure | Handling |
|---|---|
| Screen locks / tab backgrounded / iOS suspends JS | Clock from `Date.now()` deltas; correct immediately on resume |
| A sub is tapped 40 s late | Event carries its clock time; `±30 s` offered on the saved event for 10 s |
| A sub is forgotten entirely | Retroactive insert from the timeline; Σ check flags the imbalance |
| Clock stopped and forgotten | Pulsing amber chip; reminder after 3 min paused |
| App killed while the clock ran | Resumes from wall time (it *was* running); dismissible *Adjust clock* banner |
| Clock drifts from the referee | Tap the clock face → `−1:00 / +1:00 / set exact`, logged and undoable |
| Phone dies mid-match | Every tap written synchronously to localStorage; new phone resumes and re-syncs |
| Two coaches recording | `● COACH` / `○ VIEW` lease (§9) |
| Period overruns | Clock counts past 20:00 in red; manual END PERIOD |
| Safari evicting storage (non-installed sites, 7 days) | PWA install prompt + cloud sync + JSON export |

## 9. Roles, sync and handover

### 9.1 The edit lease

- `recorder_id` / `recorder_since` / `recorder_seen_at` are the lease; exactly one device holds it.
- Claim atomically on open; heartbeat every 30 s and on every write.
- `POST /takeover` returns `409 recorder_busy` if the holder was seen < 120 s ago; the client prompts, then retries with `force=1`.
- A device that loses the lease stops writing at once, flips to `○ VIEW`, and keeps its queue — those events are still accepted later, tagged with `author`.
- Offline the lease is unknowable: the chip reads `● COACH · offline` in amber.

### 9.2 Event sync

- Local is authoritative for the coach: tap → engine → localStorage → sync queue.
- Sync is a **grow-only set**: `INSERT OR IGNORE` by id; pull with `since`. Union by id ⇒ no conflict resolution, no data loss.
- Coach pushes within ~1 s when online; viewers poll every 3–5 s while live. No websockets for 2–4 observers.
- A whole match offline is fine; the log ships when the phone finds signal.

## 10. Tech stack and hosting (D5 locked: Cloudflare)

**Decision: Cloudflare Workers + D1.** One vendor, one `wrangler deploy`, static assets and SQLite together, no second account for a database, no cold starts, generous free tier (100k requests/day; D1 5 GB, 5M row reads/day — a whole season is ~6k rows).

Why not Vercel: there's no Vercel account to reuse, and Vercel brings no database, so it would mean pairing with Turso — two dashboards instead of one, for no code benefit. The comparison is kept below only as the reasoning of record; the choice is not in play.

| | Cloudflare (Workers + D1) — **chosen** | Vercel (Hobby + Turso) — not used |
|---|---|---|
| Static app | Yes, same deploy | Yes |
| API | Worker, no cold starts | Serverless functions |
| Database | **D1 built in** (SQLite) | None; needs Turso or Neon |
| Accounts | 1 | 2 |
| Deploy | `wrangler deploy` | git push |

The frontend never talks to a database, only to ~6 JSON endpoints behind a thin adapter (~150 lines), so this is not a lock-in — but it is now decided, and the schema is written for SQLite either way.

Stack either way: vanilla ES modules, hand-written CSS, no framework, no build; `engine.js` pure and unit-tested with `node --test`; `localStorage` for device state; PWA manifest + service worker; Porkbun domain.

```
POST /api/teams                     create team (+ PIN)
GET  /api/teams/:slug/state         match + roster + plan + events (view mode OK)
POST /api/teams/:slug/plan          save plan blocks (coach only)
POST /api/teams/:slug/events        append events (idempotent; 409 if lease lost)
POST /api/teams/:slug/takeover      claim the lease (?force=1 after the prompt)
POST /api/teams/:slug/release       drop to view-only
GET  /api/teams/:slug/matches       history
```

## 11. Internationalisation (D7)

- Two string files, one key set: `i18n/en.js`, `i18n/sv.js`. No runtime library, no build — a plain object and a `t()` helper.
- **Toggle in the header/overflow**, persisted in `localStorage`, applied to `<html lang>`, with dates and numbers via `Intl` (`sv-SE` / `en-GB`).
- Default: browser language, else Swedish (the team is in Lund). Never a mixed UI.
- Localised beyond generic labels: **position names and codes** (§4.6), period wording, and the share text — the recap that lands in the team chat should read Swedish on a Swedish phone.
- Drift guard: a test asserts both files have identical key sets, and that no `sv` value is accidentally left as its English placeholder.

## 12. Privacy and children's data

- First names + shirt numbers only. No surnames, birthdates, photos, parent contacts.
- Unguessable team slug, `noindex, nofollow`, no analytics, no third-party scripts or CDN fonts.
- Two kinds of link: the slug opens `○ VIEW` for anyone who has it (fine for the team chat); writing also needs the lease and the team PIN.
- "Delete team" hard-deletes everything; per-match delete too. No automatic expiry; the whole dataset stays under 1 MB.

## 13. Non-functional

| Area | Requirement |
|---|---|
| First paint | < 1 s on 4G; app shell cached after first load |
| Interaction | < 100 ms tap → UI; no network in the critical path |
| Screen | Designed for 390 × 844; works at 360 px; the plan grid may scroll horizontally only below 375 px |
| Accessibility | ≥ 16 px body, ≥ 56 px targets, WCAG AA contrast, `prefers-reduced-motion` |
| Data safety | Nothing pending in memory: every tap persisted before the UI settles |
| Bundle | < 80 KB uncompressed including both i18n files |
| Role safety | In `○ VIEW` the action bar is absent from the DOM, not merely disabled |

## 14. Acceptance criteria

**Planner (workflow 1)**
1. With 9 available and 7-minute blocks, the grid has 9 rows (3 per period: 00–07, 07–14, 14–20) and 7 columns; every cell opens a picker of available players.
2. Filling every block with 7 players yields `Σ MIN 420.0 ✓` (7 × 60).
3. With 9 available and one fixed keeper, the best achievable plan is 6 players on 46.0 and 2 on 42.0 — spread 4.0, and the planner cannot do better because 54 outfield slot-blocks don't divide by 8. Switching block length to 5 min gets all eight to 45.0.
4. A block with an empty slot, or a player in two slots of one block, is refused with the offending block named.
5. Forecast updates on every cell edit, showing MIN, "of which G", and the G/B/M/F split per player.
6. Marking a player unavailable removes them from the picker and re-flags any block that had them.

**Live (workflow 2)**
7. Setup refuses to start until exactly 7 are placed, including one `G`.
8. Stop the clock 2:00 mid-period then restart: everyone's `playMs` is 2:00 lower than wall-clock elapsed.
9. After any sequence of subs and position moves, both §7.3 invariants hold within 0.1 min.
10. `MOVE` swaps two players' slots without changing anyone's minutes at that instant.
11. Undo of any event restores on-field set, slots, minutes, score and timeline exactly.
12. A goal credited to a benched player is blocked.
13. A full-match keeper reads `MIN 60.0` (with `of which G 60.0`) and sorts to the top of the recap table, not out of it.
14. Recap consistency line reads `Σ MIN 420.0 = 7 × 60 ✔`.

**Clock, roles, i18n, offline**
15. Locked phone for 5 minutes mid-period → clock is ~5:00 later on unlock.
16. Airplane mode for a whole match: everything works; events sync on reconnect.
17. `○ VIEW` device has no action bar; a take-over flips the old device within ≤ 5 s with a named banner.
18. Coach logs a goal offline, other coach takes over, first reconnects → goal appears once, attributed correctly.
19. Toggling EN↔SV switches every visible label including position codes (`LB` ↔ `VB`) and survives a reload.
20. A key-parity test fails the build if `sv` is missing a key that `en` has.

**Player-context actions (D12)**
21. A goal is logged in exactly two taps: ⚽ on the scorer's row → tap an assister or *No assist*. No player picker appears at any point.
22. ⇄ on a bench row opens the sheet with that player already marked *coming on* and the seven on-field players offered; ⇄ on an on-field row opens the mirror state. Both complete in two taps.
23. The ⚽ button does not exist on bench rows in the DOM, not merely disabled.
24. *Change position* from the player sheet lists all seven slots with the current occupant named on each, marks the player's own slot, and performs a swap in one tap.
25. After a wrongly-tapped ⚽, the assist sheet's *change* link returns to scorer selection without leaving an event in the log.

## 15. Risks

| Risk | Mitigation |
|---|---|
| **Deferring the fairness rule (D9) removes the app's judgement layer** — v1 gives you the numbers but won't say "sub Hugo off". | Deliberate. The plan, forecast and minutes cover the decision; the ranked engine is Phase 3 and the schema already supports it. Pulling it forward is ~a day. |
| 7-minute blocks leave a 4-minute spread (two kids play 6 blocks, six play 7) | Unavoidable arithmetic: 54 slot-blocks don't divide by 8. It is shown in the forecast before kickoff, and it is the smallest spread any 9-block grid can produce. 5-minute blocks give 0 spread but cost a third substitution per period. |
| Coach stops tapping halfway through | Sub sheet is 2 taps, the plan hint gives a reason to tap, minutes degrade honestly with a Σ imbalance warning |
| Plan drawn but ignored on the day | Advisory by design; the hint is quiet rather than nagging |
| Swedish/English strings drift | Key-parity test |
| Safari evicts storage for non-installed sites | PWA install + cloud sync + export |
| Scope creep into a club platform | §3 contract; season stats wait |

## 16. Decisions — all closed

Every decision is now settled. The two that were still open are set to my recommendation, and both are trivial to flip later, so the build is not blocked on them:

1. **Keeper: `gk_plan = fixed`** — one kid keeps the whole match (`MIN 60.0`), the other eight share the outfield minutes. If the two willing keepers start splitting periods, switching a match to `rotate` is a per-match setting and improves the 7-minute forecast from a 4.0 spread to 1.0.
2. **Grid orientation: team's own perspective**, `LB` on the left. If it reads wrong from the touchline it is a CSS mirror, not a data change.

---

**Next:** implementation plan at `docs/implementation-plan.md`, Phase 1 build in progress (engine + planner, no backend, deployable to GitHub Pages for a real touchline test before the Cloudflare sync layer goes on).
