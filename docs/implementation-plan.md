# Match Manager — Implementation Plan

> **Design authority:** `docs/design-spec.md` (v2.4). This file is the build order, not the design.
> Every task is small enough to verify before moving on. Tests come before UI for anything arithmetical.

**Goal:** a phone-first PWA that plans and records a 7-a-side match (3 × 20, 7-minute blocks) offline, with bilingual UI, then syncs to Cloudflare for read-only viewers.

**Stack:** vanilla ES modules, no build step, no framework. `node --test` for the engine and i18n. Cloudflare Workers + D1 for Phase 2.

---

## Phase 1 — local-first app (usable at the next match, no backend)

### Task 1 — Engine core ✅ DONE
`engine.js`: `blockLayout`, `planForecast`, `project`, `benchList`, `onFieldList`, `canCreditGoal`.
Tests: `tests/engine.test.mjs` — 18 passing.

**Verified:** the 7/7/6 plan produces exactly 6 × 46.0 + 2 × 42.0, keeper 60.0, Σ 420.0, spread 4.0. The invariant `Σ playMs === 7 × runningMs` holds over 200 randomised event storms (subs, moves, stop/starts).

### Task 2 — i18n (D7)
- `i18n/en.js`, `i18n/sv.js` — same key set, flat object, plus `POS` codes and names.
- `i18n/index.js` — `t(key, lang)`, `setLang`, `getLang` (localStorage `mm.lang`, fallback to browser language, else `sv`).
- `tests/i18n.test.mjs` — key parity both directions; no `sv` value equal to its `en` counterpart unless on an allowlist (numbers, `MÅL`, `MM`, `BN`); every `SLOTS` entry has a label in both languages.

### Task 3 — Store (device state)
- `store.js` — `loadTeam`, `saveTeam`, `loadMatch`, `appendEvent`, `loadEvents`, `voidEvent`, schema `mm.v1.*`, all synchronous writes on every tap (spec §8).
- `tests/store.test.mjs` with a tiny in-memory localStorage shim: append is durable, void rewrites nothing (append-only), corrupt JSON falls back to an empty log rather than throwing.

### Task 4 — App shell
- `index.html` (one page, three views: plan / live / recap), `styles.css` (56 px targets, AA contrast, no pastel), `app.js` (routing, render, event wiring).
- Render is a pure function of `project(events, config, Date.now())` — no local mutable UI state for minutes.

### Task 5 — Planner screen
- Grid from `blockLayout`, cell picker (available players first, then by preferred position), instant forecast panel.
- Validation surfaced from `planForecast().errors`, naming the offending block.
- Block-length dropdown: 7 min (default), 5, 10, 6:40.

### Task 6 — Live screen
- Clock: START/STOP, END PERIOD, period chip, overrun in red, `clock_adjust` behind the clock face.
- On-field list by slot with `MIN` column and per-row `⚽` / `⇄` buttons (D12); ⚽ absent on bench rows.
- GOAL → assist prompt (2 taps), with *change* returning to scorer selection. THEIR GOAL in the bar.
- SUB sheet in two mirrored states: off-first from an on-field row, on-first from a bench row.
- Player sheet behind the name tap: change position (slot grid showing occupants), edit minutes.
- Undo toast (6 s) + permanent undo in the header.

### Task 7 — Resume and correction
- On load with a running clock, resume from wall time + dismissible *Adjust clock* banner.
- Timeline view: void any event, retroactively insert a sub at a given clock time.
- Σ imbalance warning when minutes don't reconcile.

### Task 8 — Recap + history
- Recap: score, goal timeline, minutes table sorted by MIN, G/B/M/F split, `Σ MIN 420.0 = 7 × 60 ✔`.
- Share: `navigator.share()` text + PNG render; history list.

### Task 9 — PWA + deploy
- `manifest.webmanifest`, `sw.js` (app-shell cache), icons.
- Deploy to GitHub Pages for a real touchline test (same files Cloudflare will serve later).

**Phase 1 exit criteria:** acceptance criteria 1–16, 19 from the spec pass on a real phone, offline, in the cold.

---

## Phase 2 — sharing (Cloudflare, D5)

### Task 10 — Worker skeleton
- `worker/index.js`: static asset passthrough + `/api/*` router; `wrangler.toml`; local `wrangler dev`.
- `schema.sql` from spec §7.1 applied with `wrangler d1 execute`.

### Task 11 — Endpoints
`POST /api/teams`, `GET /api/teams/:slug/state`, `POST /api/teams/:slug/plan`, `POST /api/teams/:slug/events` (idempotent by id, 409 when the lease is gone), `POST /api/teams/:slug/takeover`, `POST /api/teams/:slug/release`, `GET /api/teams/:slug/matches`.

### Task 12 — Edit lease (D2)
- `recorder_id` / `recorder_seen_at`, 30 s heartbeat, `409 recorder_busy` inside 120 s.
- Client: `● COACH` / `○ VIEW` chip, take-over confirm, demoted device flips within one poll.

### Task 13 — Sync queue
- Ordered push, retry with backoff, unsent events survive a kill, union-by-id on pull, no duplicates when two devices overlap.

### Task 14 — Domain + CI
- Porkbun domain → Cloudflare DNS; `wrangler deploy` on push to `main`.

---

## Phase 3 — only if v1 earns it

15. Fairness rule (D9): tolerance flags, "cannot catch up" warnings, ranked sub recommendations.
16. Season aggregates + CSV export for the club.
17. Read-only pitch view; printable season card.

---

## Conventions

- **Engine purity:** `engine.js` never touches `Date.now()` — callers pass `nowMs`. That is what makes the 200-round invariant test deterministic.
- **Append-only:** nothing is ever edited or deleted in the event log; corrections are new events (`void`).
- **No build step:** if a change needs a bundler, the change is wrong.
- **Commit per task**, tests green before the next one.
