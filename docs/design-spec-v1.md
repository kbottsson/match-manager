# Match Manager — Design Specification (v1, for review)

**Status:** draft for D's review. Nothing built yet.
**Date:** 2026-11-07
**Revision:** v1.2 — added explicit manual clock control (START/STOP, §4.5) and first-class `● COACH` / `○ VIEW` modes with a single-editor lease (§5.4, §9.1).
**Author:** Hermes (for D, volunteer coach)
**Working title:** Match Manager (working dir `~/Projects/match-manager/`)

---

## 0. Decision summary — read this bit first

Ten decisions shape the build. My recommendation is in bold; the rest of this doc is the reasoning.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where does match state live? | **Local-first on the phone (works with no signal) + cloud sync as an enhancement, not a dependency** |
| D2 | Who can edit a match? | **Exactly one coach at a time, and it is a visible switch: `● COACH` vs `○ VIEW` (read-only). Others are read-only by default and can take over explicitly.** |
| D3 | Playing time: stored counters or derived? | **Always derived from an append-only event log** (seconds-of-play integrated from lineup + subs) |
| D4 | Goalie handling | **Goalie is a per-period assignment by default** (a fair-share warning fires if one kid takes all 60 min) |
| D5 | Deployment target | **Cloudflare Workers + D1** (static app + tiny JSON API, one `wrangler deploy`, free tier). Fallback: GitHub Pages + Supabase |
| D6 | Framework / build step | **No framework, no build step** — vanilla ES modules, same as `wind-turbine-live` |
| D7 | UI language | **English strings in v1, externalised so Swedish is a file swap** |
| D8 | Positions | **Fixed named slots (GK, B1, B2, M1, M2, M3, F1); per-player preferred-position tags; cross-slot subbing allowed with a warning** |
| D9 | Fairness rule | **Configurable: target = fair share ±5 min; hard flag when a player can no longer reach the target** |
| D10 | Score for both teams? | **Yes — "our goal" (scorer + optional assist) and "their goal" (score only). Cheap, makes it a real match manager** |
| D11 | Clock control | **Explicit START/STOP toggle that mirrors the referee's watch. Clock counts up, never auto-stops, ±1:00 correction available. Playing time accrues only while the clock is running.** |

---

## 1. Goal

A phone-sized web app that a coach can actually operate one-handed, outdoors, in the cold, while watching a match — that answers four questions at a glance:

1. Who is on the field right now, and in which position?
2. How many minutes has each kid played, and is it fair?
3. What is the score, and who scored / assisted?
4. Who should I sub on and off next, to keep playing time fair?

Everything else is secondary.

## 2. Users and context of use

**Primary user:** D, volunteer coach, one phone, standing on a touchline. Possibly wearing gloves. Possibly in low sun or rain. Possibly with poor or zero mobile coverage.

**Secondary users:** 1–3 other coaches who want to see the live state (score, minutes) without being the one tapping. Maybe a parent checking the score.

**Context constraints that drive the design:**

| Constraint | Design consequence |
|---|---|
| Zero connectivity on many pitches | App must be fully functional offline. Cloud is a sync layer, never a prerequisite. |
| Tapping while watching play, not the screen | Max 2 taps per action. No modals with small controls. Tap targets ≥ 56 px. No long-press, no drag, no gestures. |
| Sunlight readability | Very high contrast, large type, no pastel greys. Optional dark theme for evening/gloom. |
| Cold hands / gloves | No slider, no text entry during live play (only on setup screens). |
| Mistakes happen | Every action is undoable, and every logged event is editable after the fact. |
| Phone may sleep / tab may be backgrounded | Clock computed from absolute wall-clock timestamps, never from an interval counter. |
| Match lasts ~75 min including breaks | No mid-match login. Session must survive backgrounding and screen lock. |

## 3. Scope

### In scope for v1

- Team roster (9–12 players, name + shirt number + preferred positions).
- Match setup: opponent, date, period count and length (defaults 3 × 20), who is available today, starting 7 + goalie plan.
- Live match screen: running clock, period indicator, score, on-field list by slot, bench list with minutes, quick actions (goal, sub, period start/end, undo).
- Automatic substitution suggestion ranked by playing-time deficit.
- Per-player totals: minutes played, minutes per period, minutes per position, goals, assists.
- Append-only event log with undo/void and post-hoc edit.
- Match recap: score, scorers, assists, minutes table; shareable as text and as an image.
- Match history list.
- Installable PWA, offline-capable.
- Cloud sync so other coaches can follow along read-only and so data survives a dead phone.

### Explicitly out of scope for v1

- Season statistics / league tables / aggregated player stats across matches (nice, and easy to add later — the event log supports it).
- Player photos, birthdates, parent contact details, medical info.
- Attendance, training planning, fees, communications.
- Public team pages, parent logins, push notifications.
- Multi-team / multi-club administration.
- Video or live commentary.

## 4. The football model (and the maths that drives the UI)

### 4.1 Shape of a match

- 7 on the field: 1 GK + 2 backs + 3 midfielders + 1 attacker.
- ~9 players available per match → 2 on the bench, 7 on the field.
- 3 periods × 20 min = 60 min of playable time.
- 2 substitution events per period → each period naturally splits into 3 segments of ~6:40.

### 4.2 The number that matters

```
player-minutes available = 7 slots × 60 min = 420
fair share per player     = 420 / 9        = 46.7 min
```

So the target is "everyone around 47 minutes". In an ideal world with perfect thirds, the spread is under a minute; in practice it lands 40–52. The app's job is to keep the spread small **without** the coach having to do arithmetic on the touchline.

Configurable rule (D9):

- **Target** = fair share, recomputed live (it changes if a 9th player arrives late or a player leaves).
- **Tolerance** ±5 min → amber flag.
- **Infeasible** → red flag: `played + remaining match time < target` means *this kid cannot catch up; get them on now*.

### 4.3 The goalie trap (why GK needs first-class handling)

If one kid keeps goal for all 60 minutes, they bank 60 min and the other eight share 360 → **45 min each maximum**. A coach running "fair playing time" has now created a structural unfairness that no amount of substitution planning can fix. So:

- Goalie is assigned **per period** by default (a rotating plan: P1 Leo, P2 Sam, P3 Noah → 20 min each in goal, other periods outfield).
- The plan can be set to "same all match" if that is the team's reality.
- The fairness engine evaluates actual on-field minutes, not intent, and flags a GK who exceeds the target by more than the tolerance.

### 4.4 Late arrivals, early leavers

A player showing up 10 minutes into period 1 changes both the on-field count and the fair-share denominator. This is a `roster_change` event, not an edit of the roster, so the maths stays retroactively correct: minutes before the change were earned against a 8-player denominator, after against 9.

### 4.5 The clock is the referee's clock

The app does not keep its own idea of time. It keeps **the referee's**, and the coach is the interface. That means a manual **START / STOP** toggle as the primary control, not an autonomous stopwatch.

**States**

```
  idle ──start period──▶ running ──STOP──▶ paused ──START──▶ running
                            │                                    │
                            └────────── end period ◀─────────────┘
                                            │
                                          ended  ──next period──▶ idle
```

| State | Header shows | Playing time accrues? |
|---|---|---|
| `idle` | `P2 · 00:00` + **START PERIOD 2** | no |
| `running` | `● 07:12 / 20:00` (green dot) | **yes** |
| `paused` | `‖ STOPPED 07:12` (amber, pulsing) | no |
| `ended` | `P2 ENDED 20:00` frozen | no |

**Rules**

- The clock **counts up** from `00:00` to the period length. `07:12 / 20:00` reads unambiguously as elapsed-of-total, and overrun is simply `20:47` in red.
- **It never stops itself.** Hitting 20:00 is information, not an event — a referee may play 40 seconds of added time and the coach must not have the app decide otherwise.
- **Every stop is a real stop.** Time between STOP and START is excluded from all playing-time maths, so the fairness numbers track effort, not wall clock. Rule of thumb for the coach: *if you wouldn't credit the kid for it, the clock isn't running.*
- **Alignment beats precision.** Start on the whistle, stop on the whistle. When the referee calls "two minutes left" the coach taps the clock → sheet with **−1:00 / +1:00 / set exact**, and the app matches the ref from that moment on.
- A clock adjustment retroactively shifts the current period's running time (and therefore everyone on the field for it), because if you were 2 minutes out, the kids really did play 2 minutes fewer than you thought. The adjustment is a logged, undoable event, shown in the timeline.
- **Stopped and forgotten** is the failure mode to design against: pausing for a chat and never restarting would under-credit everyone. So a pulsing `STOPPED` chip in the header, plus a reminder banner if the clock sits paused for more than 3 minutes.
- Haptics confirm the toggle without looking (`navigator.vibrate` where supported; colour change always).



## 5. Core interaction flows

### 5.1 Pre-match (2–3 min, at home or on the bench)

1. Open app → **Today's match** card (or "New match").
2. Match setup: opponent, venue, period count/length, kickoff.
3. Availability: toggle who is here today (roster pre-filled).
4. Lineup: assign the starting 7 to slots. App proposes a lineup from last match + preferred positions.
5. Goalie plan: choose fixed or rotate-per-period; pick the GK for each period.
6. Tap **Start period 1**.

### 5.2 In-match (the only screen that matters)

- Clock, period and score are always visible in the header.
- **START / STOP is the biggest control on the screen.** Start on the referee's whistle, stop on it, start again when play resumes. Minutes freeze while stopped.
- Tap a player row → player action sheet (goal, assist, sub off, edit minutes).
- Tap **GOAL** → who scored? (grid of on-field players, huge buttons) → optional assist → done. 3 taps worst case, 2 taps typical.
- Tap **SUB** → sheet pre-filled with the recommended swap(s): "OFF Hugo, ON Omar — Omar is 7.2 min behind target". Confirm or change. 2 taps typical.
- Period break → **END PERIOD** (header chip). Clock stops, period totals freeze, and the next period waits at `00:00` until the coach taps start. Breaks are untimed.
- Tap the clock itself → adjust sheet (`−1:00 / +1:00 / set exact`) for when the referee announces the time.
- **Undo** appears as a toast for 6 s after every logged event, and permanently in the header — reverses the last event, whatever it was.

### 5.3 Post-match

- **Finish match** → recap with score, scorers/assists, minutes table, per-period minutes, fairness check.
- Share: `navigator.share()` text, or a generated PNG (nice for the team WhatsApp group).
- Match saved to history; synced to cloud.

### 5.4 Roles: Coach mode and Read-only (other coaches)

Two modes, one visible switch, always shown in the header:

| Mode | Chip | Can do |
|---|---|---|
| **Coach** | `● COACH` (green) | everything: clock, subs, goals, lineup, edits |
| **Read-only** | `○ VIEW` (grey) | watch clock, score, on-field set, minutes, suggestions. Nothing writable. |

Rules of the road:

- **Opens read-only.** Any device other than the one that claimed the match joins in `○ VIEW`. The app says who is recording: *"Read-only. D is recording this match."*
- **One coach records.** Edit mode is a lease held by one device; the server holds the lease, so two phones cannot both believe they are coach.
- **Taking over is explicit, never silent.** A viewer taps **Take over recording**. If the current recorder touched the app in the last 2 minutes they get *"D is recording right now — take over anyway?"*. On confirm the lease moves, the old device drops to `○ VIEW` and shows a banner: *"Amanda took over. You are now view-only."*
- **Takeover never loses data.** Events the demoted device logged but had not yet sent are still accepted (they are idempotent by id) and marked with their author.
- **Switching down is instant and free.** The coach can tap `● COACH → ○ VIEW` any time — including to hand the phone to a parent or a player. Re-entering coach mode needs a two-step confirm, so a stray tap in a pocket cannot unlock editing.
- Switching modes is **not** logged in the football event log (it is not a match fact). It is kept as an operational lease with an audit trail in `match_sessions`.

## 6. Screens

Five screens. Nothing else.

### 6.1 Live (the critical one)

```
┌──────────────────────────────────────────────────┐
│ ● COACH    ● 07:12 / 20:00      UPPÅKRA 2–1 X    │
│ ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░      │
├──────────────────────────────────────────────────┤
│ ON FIELD (7)                              MIN    │
│  GK   Leo (4)                    [GK]   38.5     │
│  B    Sam (7)                           31.0     │
│  B    Noah (2)                          45.5     │
│  M    Elias (9)                         40.0     │
│  M    Hugo (3)                          33.5 ⚠   │
│  M    Axel (5)                          46.5 ⚠   │
│  F    Ville (11)                        44.0     │
├──────────────────────────────────────────────────┤
│ BENCH (2)                                 MIN    │
│  Omar (8)   ▸ 7.2 behind         12.0  [ON]      │
│  Isak (6)   ▸ 1.9 ahead          48.5  [ON]      │
├──────────────────────────────────────────────────┤
│ ┌────────────────┐ ┌─────────┐ ┌─────────┐       │
│ │ ‖   STOP       │ │ ⚽ GOAL │ │ ⇄  SUB  │        │
│ └────────────────┘ └─────────┘ └─────────┘       │
└──────────────────────────────────────────────────┘

── VIEW-ONLY VARIANT — another coach's phone ──

┌──────────────────────────────────────────────────┐
│ ○ VIEW     ● 07:12 / 20:00      UPPÅKRA 2–1 X    │
│ ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░      │
├──────────────────────────────────────────────────┤
│  Read-only.  D is recording this match.          │
│  Goals, subs and minutes stream in live.         │
│                                                  │
│  ON FIELD (7)                            MIN     │
│   GK  Leo (4)                     38.5           │
│   B   Noah (2)                    45.5           │
│   M   Axel (5)                    46.5 ⚠         │
│   ...                                            │
│                                                  │
│          [ TAKE OVER RECORDING ]                 │
└──────────────────────────────────────────────────┘
```

Design notes:
- Position-grouped **list**, not a pitch diagram. A pitch looks delightful in a mock and is horrible to tap with a glove. The pitch can exist later as a read-only visual.
- Minutes to one decimal — coaches argue about 0.5 min, and it makes the maths verifiable.
- ⚠ = outside tolerance (amber) or infeasible (red, with a filled dot).
- Only four buttons. Everything else lives behind row taps and one overflow menu.
- Bottom action bar sits in thumb reach; nothing above 80 % of screen height is interactive during play.

### 6.2 Sub sheet

```
┌──────────────────────────────────────────────────┐
│  SUBSTITUTION                    Period 2 · 07:12│
│                                                  │
│  RECOMMENDED                                     │
│   OUT  Hugo (3)   M2      33.5   (14.0 over)     │
│   IN   Omar (8)   M2      12.0   (21.5 behind)   │
│                                                   │
│  [ CONFIRM ]     [ CHOOSE DIFFERENTLY ]          │
│                                                   │
│  Everyone within tolerance → "no change needed"  │
└──────────────────────────────────────────────────┘
```

`CHOOSE DIFFERENTLY` reveals two big lists (who comes off / who goes on) with minutes and deficit on every row. Position mismatch produces an amber note ("Sam normally plays back, you're putting him in midfield") but never blocks — the coach is in charge.

### 6.3 Match setup

Sections: match details → availability (checkbox grid) → starting 7 (drops into slots) → goalie plan. One scrollable page, one primary button, **Start period 1**. Not used under time pressure, so it can be denser.

### 6.4 Recap

Score, goal timeline (period + clock), minutes table sorted by minutes with fair-share column and spread, goals/assists totals, and a consistency line: `420 on-field minutes logged = 7 × 60 ✓`. That consistency check is the trust anchor: if it does not balance, the coach knows a sub was missed.

### 6.5 History

List of matches: date, opponent, score, and a spread badge ("fairness: ±4.1 min"). Tap for recap. Season totals deferred to v2 but the data is already there.

## 7. Data model

### 7.1 Principle: append-only events, derived state

Nothing is stored as "minutes played". Minutes are a **projection** of the event log. Consequences, all of them good:

- Undo is trivial and exact (`void` the event; re-project).
- Two devices can merge logs with no conflict resolution beyond set-union (events have client-generated UUIDs).
- A missed tap is fixable retroactively (insert a `sub` event at the right clock time, or edit its timestamp).
- Full audit trail if two coaches disagree about the score.

```sql
-- Cloud (D1 / SQLite). On the phone the same shapes live in localStorage.

CREATE TABLE teams (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,          -- 'Uppåkra IF P16'
  slug          TEXT UNIQUE NOT NULL,   -- capability URL component
  code_hash     TEXT,                   -- coach PIN, hashed
  formation     TEXT NOT NULL DEFAULT 'GK,B1,B2,M1,M2,M3,F1',
  period_count  INTEGER NOT NULL DEFAULT 3,
  period_minutes INTEGER NOT NULL DEFAULT 20,
  tol_minutes   REAL NOT NULL DEFAULT 5.0,
  created_at    TEXT NOT NULL
);

CREATE TABLE players (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id),
  name          TEXT NOT NULL,          -- first name only
  shirt_no      INTEGER,
  pref_positions TEXT,                  -- 'GK,B' | 'M,F' | NULL
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id),
  opponent      TEXT,
  venue         TEXT,
  kickoff_at    TEXT,
  period_count  INTEGER NOT NULL,
  period_minutes INTEGER NOT NULL,
  gk_plan       TEXT NOT NULL DEFAULT 'rotate',  -- 'rotate' | 'fixed'
  gk_by_period  TEXT,                   -- JSON {"1":"playerId","2":...}
  status        TEXT NOT NULL DEFAULT 'setup',   -- setup|live|final
  recorder_id   TEXT,                   -- device holding the edit lease
  recorder_since TEXT,
  recorder_seen_at TEXT,                -- heartbeat, drives the 120 s busy rule
  updated_at    TEXT NOT NULL
);

-- operational, not football data: who held edit mode and when
CREATE TABLE match_sessions (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  device_id  TEXT NOT NULL,
  label      TEXT,                      -- "D · iPhone"
  role       TEXT NOT NULL,             -- 'coach' | 'view'
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

CREATE TABLE match_players (
  match_id   TEXT NOT NULL REFERENCES matches(id),
  player_id  TEXT NOT NULL REFERENCES players(id),
  available  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,   -- client UUID v4
  match_id   TEXT NOT NULL REFERENCES matches(id),
  type       TEXT NOT NULL,
  at_ms      INTEGER NOT NULL,   -- wall clock (epoch ms) when recorded
  clock_ms   INTEGER,            -- match clock at capture — advisory only
  payload    TEXT NOT NULL,      -- JSON
  void_of    TEXT,               -- event id this voids (soft delete)
  author     TEXT,               -- device/coach label
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_match ON events(match_id, at_ms);
```

### 7.2 Event types

| type | payload | notes |
|---|---|---|
| `lineup` | `{assignments:{GK:"p1",B1:"p2",...}}` | initial 7 |
| `period_start` | `{period:1}` | opens a period: clock resets to 00:00, state → `running` |
| `clock_stop` | `{period:1, reason?:"referee"}` | manual STOP: freezes the clock; paused time is excluded from playing time |
| `clock_start` | `{period:1}` | manual START after a stop; resumes from the frozen value |
| `clock_adjust` | `{period:1, fromMs:960000, toMs:1080000}` | align to the referee ("two minutes left"); rewrites the current period's running time, so minutes move with it. Logged, undoable. |
| `period_end` | `{period:1}` | closes the period: stops the clock, freezes period totals, next period sits at `idle` |
| `sub` | `{off:["p3"],on:["p8"],slots:{p8:"M2"}}` | rolling subs, 1..n pairs in one event |
| `goal_for` | `{scorer:"p11",assist:"p9"\|null,own_goal:false}` | scorer must be on field (validated) |
| `goal_against` | `{}` | score only |
| `roster_change` | `{player:"p5",available:false}` | late arrival / early leave |
| `note` | `{text:"..."}` | free text, unused in v1 UI beyond overflow |
| `finalize` | `{}` | locks the match, triggers recap |

### 7.3 Projection (the engine)

```js
// pure function; the entire app is a view over this
project(events, config) => {
  period,                        // 1..3
  state,                         // 'idle' | 'running' | 'paused' | 'ended'
  clockMs,                       // running time in the current period
  runningSince,                  // epoch ms of the last START, null when paused
  pausedMs,                      // total paused time in this period (display only)
  periodTotals: [ms, ms, ms],    // frozen running time per completed period
  onField: { slot -> playerId },
  perPlayer: { playerId -> {
      playMs,               // total on-field; paused time never accrues
      byPeriod: [ms, ms, ms],
      byPosition: { GK: ms, B: ms, M: ms, F: ms },
      stints: [{ fromMs, toMs, slot, period }],
      goals, assists,
      offMs, currentStintMs, onNow
  }},
  score: { for, against },
  timeline: [...],
  flags: [{ playerId, kind: 'over'|'under'|'infeasible', deltaMs }]
}
```

`clockMs` is derived, never accumulated: it is `(now - runningSince)` plus the running time already banked for this period, and it only advances while `state === 'running'`. STOP/START therefore cannot drift, and a backgrounded tab or a dead phone resumes with the correct value. `totalRunningMs` = `Σ periodTotals` + current `clockMs`.

Testing strategy: `project()` and `suggestSubs()` are pure and get the bulk of the tests via `node --test` (D's existing pattern in `wind-turbine-live`). Property test worth having: *for any random sequence of starts, stops, subs, adjustments and period boundaries, `sum(playMs) == 7 × totalRunningMs`* — that single invariant catches most clock bugs, including the pause ones.

### 7.4 Substitution suggestion algorithm

```
suggestSubs(state, k=2):
  target    = (clockMs * onFieldCount) / availableCount        # per-player fair share so far
  deficit(p)= target - playMs(p)

  onField   = current 7
  bench     = available & not on field

  bringOn   = bench sorted by deficit desc
              (red-flag players first: those who cannot reach target even by playing the rest)

  takeOff   = onField sorted by deficit asc        # most over-played first
              .filter(p => currentStintMs(p) >= minStintMs)   # default 3 min, avoid yo-yo
              .filter(p => slot(p) != 'GK' || gkIsRotating)

  pairs     = greedily match each bringOn to the takeOff whose slot best fits
              bringOn's preferred positions; amber note on mismatch
```

The suggestion is a *proposal*, never an auto-action. The coach confirms. If everyone is within tolerance, the sheet says so and the coach can still sub.

## 8. Clock robustness (this is where naive implementations die)

| Failure | Handling |
|---|---|
| Screen locks, tab backgrounded, iOS suspends JS | Clock derives from `Date.now()` deltas, not `setInterval`. On resume the clock is immediately correct. Only display refresh ticks. |
| A sub is tapped 40 s late (coach was watching the play) | Sub event records its clock time; long-press-free correction: the sub sheet has a "±30 s" adjust on the confirmed event for 10 seconds after saving. |
| Coach forgets a sub entirely | Retroactive insert: edit any event's clock time from the timeline. App flags imbalance: "on-field minutes do not add up to 7 × elapsed — a substitution may be missing." |
| Phone dies mid-match | Events are written to localStorage synchronously on every tap; nothing is pending in memory. New phone → open match → resume as recorder → re-sync. |
| Two coaches both record by accident | Visible `● COACH` / `○ VIEW` chip plus a server-held edit lease. The second device is view-only until it explicitly takes over. |
| Period overruns (injury time) | Clock keeps running past 20:00 and shows `20:47`, red. Coach ends the period manually. |
| Clock stopped and forgotten (coach talks, ball lost, water break) | Pulsing amber `‖ STOPPED` chip in the header; a reminder banner after 3 minutes paused; minutes freeze so nobody is over-credited in the meantime. |
| App killed/screen off while the clock was running | On reopen the clock resumes from wall time — it *was* running. A dismissible banner offers *Adjust clock* in case the pause was real. |
| Clock drifts from the referee | Tap the clock → `−1:00 / +1:00 / set exact`. The correction is a logged `clock_adjust` event, so it is visible and undoable. |

## 9. Roles, sync and handover

### 9.1 The edit lease

- `matches.recorder_id` + `recorder_since` + `recorder_seen_at` are the lease. Exactly one device holds it.
- Claiming: opening a match with no lease → coach mode, atomically (`UPDATE … WHERE recorder_id IS NULL`).
- Heartbeat: the coach device pings `recorder_seen_at` every 30 s and on every write.
- Handover: `POST /takeover` moves the lease and returns 409 *`recorder_busy`* if the holder was seen < 120 s ago — the client then shows the confirm prompt and retries with `force=1`.
- Any device that loses the lease stops writing immediately, flips to `○ VIEW`, and keeps its unsent events queued. Those are still accepted later (idempotent by id, tagged with `author`) — so a goal logged one second before someone else took over is never lost.
- Offline reality: if there is no connectivity, the lease is unknowable. Two offline devices can therefore both believe they are coach. Mitigation is social, not technical — the app shows `● COACH · offline` (a distinct amber chip) so it is obvious you are running on a local claim that has not been confirmed by the server. On reconnect, the server's lease wins and the loser is told.

### 9.2 Event sync

- **Local is authoritative for the coach.** Every tap → live engine update → append to localStorage → enqueue for sync.
- **Sync is a grow-only set of events.** Client POSTs its un-synced event ids; server inserts `INSERT OR IGNORE` by primary key. Pull = `GET /events?match_id=…&since=…`. Union by id ⇒ no conflict resolution, no last-write-wins data loss.
- **Latency:** the coach device pushes within ~1 s of each event when online; viewers poll every 3–5 s while the match is live (or on visibility change). Realtime websockets are unnecessary for 2–4 observers and add cost/complexity; revisit only if it feels laggy.
- **Offline for the whole match:** perfectly fine. Log ships up when the phone finds signal, even days later.

## 10. Tech stack and hosting

### Recommended

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla ES modules, hand-written CSS, no framework, no build | Matches `wind-turbine-live`; nothing to break, nothing to upgrade, `python -m http.server` works |
| Engine | `engine.js` — pure functions, zero DOM | Fully unit-testable with `node --test` |
| Phone storage | `localStorage` (versioned key, JSON) | Event volume is trivial (~200 events/match, ~30 KB). IndexedDB is unnecessary complexity. |
| PWA | `manifest.webmanifest` + service worker (app-shell cache) | Install to home screen = fullscreen, no URL bar, and protects against Safari's 7-day storage eviction |
| Backend | Cloudflare Worker: static asset serving + ~6 JSON endpoints | One deploy target, free tier (100k req/day), no server to maintain |
| DB | Cloudflare D1 (SQLite) | Same SQL as above, 5 GB free |
| Domain | Porkbun registration → Cloudflare DNS | D's registrar preference; cost ~€10/yr |
| CI | `wrangler deploy` from a GitHub Actions on push to `main` | Or just deploy from the laptop |

API surface (deliberately tiny):

```
POST /api/teams                      create team (+ PIN)
GET  /api/teams/:slug/state          match + roster + events (works for view mode)
POST /api/teams/:slug/events         append events (idempotent by id; 409 if you lost the lease)
POST /api/teams/:slug/takeover       claim the edit lease (?force=1 after the confirm prompt)
POST /api/teams/:slug/release        drop to view-only, hand the lease back
GET  /api/teams/:slug/matches        history
```

### Fallback if Cloudflare is unwanted

GitHub Pages (static app, same files) + **Supabase** free tier for the tables and a tiny REST layer via its auto-generated API. Slightly more setup, no wrangler, no vendor lock either way — the frontend code is identical.

### Why not "frontend-only, no backend"

It is genuinely tempting (and it is my Phase 1 — see §13), but without a server there is no way for a second coach to watch, and no recovery when the recorder's phone dies. Those were explicit requirements.

## 11. Privacy and children's data

Small but real: this is a database of named 10-year-olds.

- **First names + shirt numbers only.** No surnames, no birthdates, no photos, no parent contacts.
- **No public discovery:** team slug is an unguessable random string; `noindex, nofollow`; no sitemap; no analytics, no third-party scripts, no fonts from a CDN.
- **Two kinds of link.** The team slug opens the app in `○ VIEW` for anyone who has it (fine to drop in the team chat). Writing requires also holding the edit lease, which needs the team PIN on a new device.
- **Deletion:** "Delete team" hard-deletes players, matches and events. Per-match delete too.
- **Retention:** nothing expires automatically (a season log is the point), but the whole dataset is under 1 MB.
- No cookies beyond a session token; no consent banner needed given no tracking.

If the club ever wants this officially, the data is minimal enough to be defensible. Flag if you want a one-page GDPR note for the club.

## 12. Non-functional requirements

| Area | Requirement |
|---|---|
| First paint | < 1 s on 4G, app shell cached after first load |
| Interaction | < 100 ms from tap to updated UI; no network in the critical path |
| Screen | Designed for 390 × 844 (iPhone 14/15 class) up; works at 360 px |
| Accessibility | Min 16 px body, 56 px targets, WCAG AA contrast, respects `prefers-reduced-motion` |
| Resilience | Zero data loss on crash/kill: state written on every tap |
| Bundle size | Target < 60 KB total (uncompressed, excluding icons) |
| Battery | No animation loops, no polling while the screen is off |
| Role safety | In `○ VIEW` the action bar is absent from the DOM, not merely disabled — no accidental writes are possible, and a handed-over phone cannot alter a match |

## 13. Build phases

**Phase 1 — local-first app (the thing you can use at the next match)**
1. Repo scaffold: `index.html`, `app.js`, `engine.js`, `styles.css`, `node --test` harness.
2. `project()` engine: lineup, period boundaries, clock start/stop/adjust, subs, clock from wall time. Tests first, including the `7 × runningMs` invariant.
3. Roster + match setup screens, localStorage persistence.
4. Live screen: clock state machine (idle/running/paused/ended), the START/STOP toggle, score, on-field/bench lists, per-player minutes.
5. Goal + assist capture; sub sheet with the suggestion algorithm.
6. Undo/void + retroactive edit; imbalance warning. Local `○ VIEW` lock (works with no backend — it is just UI state).
7. Recap + share text; match history.
8. PWA manifest + service worker; deploy to GitHub Pages for a real-device test.

**Phase 2 — sharing**
9. Worker + D1 schema; event append/pull endpoints; idempotent inserts.
10. Sync queue, the edit lease, `● COACH` / `○ VIEW` mode switching, take-over handover, author tagging.
11. Team code + slug; move to Cloudflare with Porkbun domain; CI deploy.

**Phase 3 — nice-to-haves, only if v1 is loved**
12. Season totals, CSV export for the club.
13. Pitch view (read-only), per-position fairness report, printable season card.

Estimate: Phase 1 is a focused day; Phase 2 half a day; Phase 3 is whenever.

## 14. Acceptance criteria (how we know it works)

1. With 9 available players, the setup screen refuses to start the match until exactly 7 are placed and a goalie is assigned.
2. After a period start and two substitutions, `Σ minutes == 7 × elapsed` to within 0.1 min, shown on the recap.
3. Lock the phone for 5 minutes mid-period, unlock: the clock reads ~5:00 later, not ~0:00.
4. Airplane mode for the whole match: every action works; events sync when connectivity returns (verified in D1).
5. Undo a substitution: on-field set, minutes and suggestions all revert exactly.
6. Two coaches: follower sees a logged goal within 5 s; follower cannot write without taking over.
7. A player added 10 min into period 1 changes the fair-share denominator for the rest of the match, and past minutes stay intact.
8. A goal credited to a player who is on the bench is blocked with a clear message.
9. One player at 60 min while the rest sit at 45 triggers a red fairness flag on the recap.
10. Recap share text fits a WhatsApp message and is copyable in one tap.
11. **Clock stop/start:** stop for 2:00 mid-period then restart — every player's minutes are 2:00 lower than wall-clock elapsed, and `Σ minutes = 7 × runningMs`.
12. **Overrun:** period 1 runs to 21:30 because the referee played on — the clock keeps counting, renders red, and minutes reflect 21:30.
13. **Clock adjust:** set the clock from 16:00 to 18:00 — everyone on the field gains 2:00, the adjustment shows in the timeline, undo restores clock and minutes.
14. **Read-only cannot write:** a `○ VIEW` device has no action bar in the DOM; tapping where GOAL used to be does nothing.
15. **Handover:** coach A taps *Take over* on B's phone while B is active → confirm prompt appears; on confirm A records and B's app flips to `○ VIEW` within one poll (≤ 5 s) with a named banner.
16. **No lost events:** coach B logs a goal offline, coach A takes over, B reconnects — the goal appears once, attributed to B.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Coach stops tapping halfway through a match (the classic failure) | Sub sheet is 2 taps; the "who's behind" hint gives an immediate reason to tap. If logging lapses, minutes degrade gracefully and the imbalance flag says so. |
| Fairness rule fights reality (e.g. a kid who must play, or a keeper) | Everything is a flag, never a block. Rules configurable per team. |
| Safari evicting storage for non-installed sites | PWA install prompt + cloud sync from Phase 2 + JSON export button |
| Spec creep into a club platform | v1 out-of-scope list in §3 is a contract; season stats wait for Phase 3 |
| Cold-weather usability untested | Test on the touchline at the next match before building anything else — this is why Phase 1 ends with a deployed, real-device test |

## 16. Open decisions I need from you

1. **Mode handover details** — you've settled single-editor (D2), so the only remaining questions: when a second coach taps *Take over* mid-match, is a confirm prompt right (my default: prompt only if the current coach was active in the last 2 minutes), and should read-only viewers also see the sub *suggestions*, or keep those coach-only?
2. **Goalie** — does this team rotate keepers per period, keep one keeper, or is it improvised? It changes the default `gk_plan` and how hard the fairness flag pushes.
3. **Language** — English UI for v1, Swedish as the second locale? (Other coaches may be Swedish speakers.)
4. **Positions** — are the 7 slots fixed all match, or do kids rotate lines during the match? (Affects whether per-position minutes are a headline number or a footnote.)
5. **Hosting account** — do you have (or want) a Cloudflare account? If you'd rather avoid wrangler, I'll take the GitHub Pages + Supabase path. Either way a Porkbun domain, e.g. `matchdag.se`-ish — you pick the name.
6. **Do we want the opponent's score tracked?** I have assumed yes (D10). It's one extra button and makes the recap meaningful.

---

**Next step is yours:** review §0 and §16. Once those are settled I'll turn this into a task-by-task implementation plan and start building Phase 1.
