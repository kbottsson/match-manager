# Match Manager

Playing time, substitutions, goals and assists for 7-a-side youth football
(3 × 20-minute periods, two substitutions per period).

## Live

- **App** — https://match.kbottsson.com
- **API** — https://api.kbottsson.com (health: `/api/health`)

The app is served as Workers static assets from `public/`; the API is the same
Worker, behind `/api/*`. One origin, so no CORS and no split deployment.

Built for one coach on one phone, on a touchline, in the cold, with no signal.

## Sync (phase 2)

The app is open to anyone; the boundary is **storage**, not entry (D13).

- **Unpaired** — a complete app in `localStorage`. No token, so it never calls a
  write endpoint. Says so on screen. Nothing is backed up.
- **Paired** — the device carries a token from an invite link (`/join#…`). The
  first pairing *adopts* the season already on the phone and pushes it up.
- **Two kinds of link.** An *invite* (`Club → Invite a coach`) adds a new member.
  A *device link* (`Club → Add another device`) attaches another phone to the
  person who is already signed in — same name, same rights, its own session, and
  no second membership. Both are one-time and revocable; the owner token can be
  used once as a device token via `/join#<token>`.
- **One recorder per match** — the server holds a 60-second lease. Whoever holds
  it writes; everyone else is `○ VIEW` and sees who is recording, with an
  explicit **Take over**.
- **Viewers poll** every 5 s while the match is live and visible; paused when
  hidden, backed off 5→10→20→30 s on failure, forced on `online` and on return.
- **Writes leave the phone through an outbox** that survives a reload, drains
  documents before the events that depend on them, and never loses an event to a
  failed request.

## What it does

- **Squad** — add players once; reused every match.
- **Plan** — a position grid in 7-minute blocks (7 / 7 / 6 per period), with an
  instant forecast of minutes per player and per line.
- **Live** — manual start/stop clock, per-row goal and substitution buttons,
  assists, position changes, undo.
- **Recap** — score, scorers, assists, minutes table, and a `Σ = 7 × elapsed`
  check that proves no substitution was missed.

Playing time counts every minute on the field, including in goal. One number
per player.

## Running it

No build step, no dependencies. Any static file server:

```sh
npm run serve        # python3 -m http.server 8080
```

Then open <http://localhost:8080>. Add `?seed=1` for a demo match so the screens
have something in them.

## Tests

```sh
npm test             # engine + i18n + store (node:test, 37 tests)
npm run test:ui      # drives the real page in headless Chrome (22 checks)
```

The engine is a pure projection of an append-only event log, so minutes are
never stored — they are derived. That is what makes undo exact and a missed
substitution fixable after the fact.

## Data

Everything lives in `localStorage` on the device. Nothing is sent anywhere.
Deleting the site data deletes the season, so the recap screen exists partly so
you can get the numbers out while you still have them.

Player names in the screenshots and demo seed are placeholders.

## Status

Phase 1 (single coach, offline). Phase 2 adds Cloudflare sync so other coaches
can watch read-only. Design: `docs/design-spec.md`.

## Testing

`npm test` and `tests/*.e2e.mjs` run against a local Worker with a throwaway
database. Anything verified against the live club must leave no state behind —
see [docs/testing.md](docs/testing.md).
