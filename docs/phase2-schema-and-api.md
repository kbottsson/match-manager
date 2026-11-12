# Phase 2 — sync schema and API

Status: draft for review · 2026-11-11
Depends on: design-spec v2.5 (D1 local-first, D2 single editor, D3 derived minutes)

---

## 0. Scope

Phase 1 is a local-only PWA. Phase 2 adds a place for the recording phone to put
what it already recorded, so a second phone can watch the same match.

**In scope:** write-behind sync of the existing data model, a read-only poll for
viewers, one edit lease.

**Out of scope:** accounts, logins, per-user permissions, push notifications,
anything that changes what the app can do. The app must keep working with the
network switched off — sync is an enhancement, never a dependency.

---

## 1. Shape

```
  recording phone                Cloudflare                  viewer phone
  ┌──────────────┐          ┌────────────────────┐          ┌──────────────┐
  │ app (PWA)    │  writes  │ Worker  ──►  D1    │  polls   │ app (PWA)    │
  │ localStorage │ ───────► │  /events /docs     │ ◄─────── │ 5s, 204-ish  │
  │ outbox       │          │  /lease            │          │ read-only    │
  └──────────────┘          └────────────────────┘          └──────────────┘
```

One Worker, one D1 database, one tenant row per club. No Durable Objects in v1:
polling is the sync mechanism, and the lease is a row.

---

## 2. Tenancy and auth

A tenant is a club. `tenants.key` is a long random string (≥ 24 bytes,
base64url) that doubles as the bearer token — the same "unguessable slug"
principle as the design spec. It is created once, stored on each device when a
coach pairs, and never appears in the app UI.

```
Authorization: Bearer <tenant key>
```

No user accounts. Anyone holding the key can write; in practice that is one coach
and a couple of viewers, and the lease decides who may. This is a deliberate
trade: the alternative (accounts, invitations, sessions) costs a week and solves
a problem this club does not have.

Transport is HTTPS only. CORS allows `https://kbottsson.github.io` while the app
stays on GitHub Pages; if the app moves to Cloudflare the origin moves and CORS
goes away.

---

## 3. D1 schema

Two ideas only: **documents** (latest state, last-write-wins) and **events**
(append-only, never mutated).

```sql
-- one row per club
CREATE TABLE tenants (
  key        TEXT PRIMARY KEY,
  club_name  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- mutable state: the club model, each match record, each match plan
CREATE TABLE docs (
  tenant     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('model', 'match', 'plan')),
  id         TEXT NOT NULL,              -- '' for the model, matchId otherwise
  body       TEXT NOT NULL,              -- JSON { v, ... }; rev lives in a column
  rev        INTEGER NOT NULL,           -- increments per accepted write
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, kind, id)
);

-- rev and updated_at are columns, never fields inside the body. A plan body is
-- exactly { "v": 1, "cells": [ { "blockIndex": 0, "slot": "LB", "playerId": "p7" } ] }
-- — the same array planForecast already consumes, wrapped so it can grow later.

-- append-only history; the only source of truth for minutes and score
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- cursor, monotonic
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,              -- client uuid: idempotency key
  match_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  at_ms      INTEGER NOT NULL,
  clock_ms   INTEGER,
  period     INTEGER,
  payload    TEXT NOT NULL,              -- JSON
  author     TEXT,
  void_of    TEXT,                       -- undo target
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX events_idem   ON events (tenant, id);
CREATE INDEX        events_cursor ON events (tenant, seq);
CREATE INDEX        events_match  ON events (tenant, match_id, seq);

-- who is recording right now
CREATE TABLE lease (
  tenant   TEXT PRIMARY KEY,
  holder   TEXT,                         -- device id
  name     TEXT,                         -- what the viewer shows
  seen_at  INTEGER                       -- epoch ms of last heartbeat
);
```

### Why plans are a document, not rows

A 9-block plan is 63 cells → **2.9 KB** of JSON. As rows it is 63 writes per
save; as one document it is one. Thirty matches a season is 85 KB total. The
table stays small enough that a full-season bootstrap is a single response.

### Why events are not a document

Undo works by appending a `void` that references its target; replay is the only
way to derive minutes; retries after a dropped connection must not double-count.
All three need immutable, individually-addressable rows with a client-supplied
id.

### Canonical event order

`(at_ms, id)` — not arrival order. Two phones can interleave; this makes replay
deterministic regardless of who synced first. The Phase 1 app replays in array
order, so this is a small change on the client: sort on load.

---

## 4. API

All endpoints under `/api/t/:key`. All require the bearer key.

### 4.1 `POST /events` — append (idempotent)

```json
{
  "events": [
    { "id": "e-8f21", "matchId": "m1", "type": "goal_for",
      "atMs": 1762950000000, "clockMs": 372000, "period": 1,
      "payload": { "scorer": "p11", "assist": "p8" }, "author": "coach" }
  ]
}
```

`200`:
```json
{ "seq": 412, "accepted": 1, "duplicates": 0 }
```

Insert is `INSERT OR IGNORE` on `(tenant, id)`, so a retry is free. Max 200
events per request; the client chunks beyond that.

### 4.2 `GET /sync` — the poll

```
GET /api/t/:key/sync?since=398&revs=<base64url JSON>
```

`revs` is what the client already holds, so the server only returns what moved:

```json
{ "model": 4, "match:m1": 7, "plan:m1": 12 }
```

`200`:
```json
{
  "seq": 412,
  "events": [ /* rows with seq > 398, ordered by seq */ ],
  "docs":   [ { "kind": "plan", "id": "m1", "rev": 13, "body": { ... } } ],
  "lease":  { "holder": "dev-2", "name": "Amanda", "seenAt": 1762950240000 }
}
```

`204 No Content` + `ETag` when the cursor and every rev are unchanged. That is
the common case — 11 of every 12 polls — and it must cost no body at all.

`revs=*` on first load returns everything: full bootstrap.

### 4.3 `PUT /docs/:kind/:id` — write a document

```
If-Match: 12
{ "body": { ... } }
```

`200`: `{ "rev": 13 }`
`409`: `{ "rev": 13, "body": { ... } }` — the client re-reads and retries once.

`If-Match: *` creates. Sending a rev you no longer hold is the only way to get a
409; because only the recorder writes, a 409 nearly always means a stale queued
write from the same device.

### 4.4 `POST /lease`

```json
{ "action": "heartbeat" | "takeover" | "release", "holder": "dev-1", "name": "Derek" }
```

`200`: `{ "holder": "dev-1", "name": "Derek", "seenAt": 1762950240000, "mine": true }`
`409` on `heartbeat` when someone else holds it, with the current holder so the
phone can drop to viewer mode without guessing.

Lease is considered stale after **60 s** without a heartbeat (2 missed beats at
30 s). A viewer seeing a stale lease shows "reconnecting", not "offline forever".

### 4.5 `GET /health`

`{ "ok": true, "seq": 412 }` — for uptime checks and for the app to distinguish
"no signal" from "server is down".

---

## 5. The client outbox

Every mutation already flows through three functions. They gain one line each:

| Local write | Outbox item |
|---|---|
| `act(type, payload)` | `{ kind: 'event', event }` |
| `store.savePlan(id, cells)` | `{ kind: 'doc', kind: 'plan', id }` (debounced 500 ms) |
| `saveMatch(m)` | `{ kind: 'doc', kind: 'match', id }` (debounced 2 s) |
| `persistModel()` | `{ kind: 'doc', kind: 'model', id: '' }` (debounced 5 s) |

The outbox is a single array in localStorage, written before the network is
touched. Items are coalesced by `(kind, id)` — ten plan saves collapse to one —
and events are never coalesced, only batched.

**Flush triggers**

- immediately: `online`, app foregrounded, full time (and wait for ack)
- debounce expiry: 500 ms plan, 2 s match, 5 s model
- periodic: every 30 s while a match is live and the outbox is non-empty
- `pagehide` with `keepalive` (best effort)

**Failure**: exponential backoff 5 → 10 → 20 → 30 s, reset on success. The
outbox survives reloads, so a closed tab is not a lost action.

---

## 6. The poll

Viewers only. The recording phone never polls; it is the source of truth and
only writes (it may read the lease from its own responses).

- **5 s** while a match is live and the page is visible
- **paused** entirely when hidden; an immediate `GET /sync` on return
- **stopped** after `finalize` (one last fetch)
- **not running** on History or Roster — those fetch once on open
- **backoff** on error: 5 → 10 → 20 → 30 s

Two rules that matter more than the interval:

1. **Never re-render under an open sheet or a focused input.** A poll applies to
   state and defers the DOM update until the sheet closes. Otherwise a timer
   reaches into the screen and wipes what somebody is typing.
2. **Show freshness.** `updated 4s ago` beside the clock. A stalled poll and a
   quiet match look identical otherwise.

---

## 7. Conflicts, and what happens to each

| Data | Rule | Losing case |
|---|---|---|
| Events | unique on `(tenant, id)`; append-only | none — a duplicate is dropped |
| Plan | last write wins, `rev` guards staleness | recorder's last save is authoritative |
| Match record | last write wins, **status monotonic** (`setup < live < final`) | server refuses a backwards transition |
| Model (roster/club/seasons) | last write wins per document | a simultaneous roster edit loses; acceptable behind the lease |
| Lease | explicit takeover, never silent | the loser drops to viewer |

Nothing merges. Merging documents needs a CRDT or a cell-level op log and buys
nothing at this scale — the lease means there is normally one writer.

---

## 8. Limits and cost

Per match: ~40 event rows, ~3 plan writes, ~4 match writes, ~120 lease
heartbeats. Two viewer phones polling for 60 minutes: ~1,440 requests, ~1,400
rows read, and 1,300 of those requests return `204` with no body.

Against the Workers Free plan (100k requests/day, D1 5M rows read and 100k rows
written per day) a full weekend of matches is well under 1% of a day's budget.

**What breaks first:** nothing about this project. If the free tier is exceeded,
writes fail until midnight UTC — hence the parking-lot note that $5/month is
insurance against a mid-match cap, not a capacity need.

---

## 9. Migration and backfill

Phase 1 devices already hold everything. On first successful sync:

1. `PUT /docs/model` with the club model
2. `PUT /docs/match/:id` for every match, `PUT /docs/plan/:id` for every plan
3. `POST /events` in chunks of 200 for every match's log

Then set the local cursor to the response `seq`. Ordering matters: documents
first, so a viewer that arrives mid-backfill never sees events for a match it
cannot name.

A second phone pairs by entering the club key (or scanning a QR the first phone
shows) and runs `GET /sync?since=0&revs=*`.

---

## 10. Open questions

1. **Pairing UX** — QR code, typed key, or a link the coach sends? Leaning QR
   from the recorder's screen, with the key shown as text for fallback.
2. **Does history sync?** Everything lives in one tenant, so a new phone gets the
   full archive. That is probably right, but it means the key is also the key to
   past seasons.
3. **Key rotation** — no story yet. If a key leaks, the club is readable. Accept
   for v1; note it.
4. **Clock source** — `at_ms` comes from the phone. Two phones with skewed
   clocks could order events oddly. Cap acceptable skew (±2 min) or let the
   server stamp arrival and keep `at_ms` for display only.
