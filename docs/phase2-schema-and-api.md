## Status

**Implemented and tested.** Server: `worker/`. Client: `public/sync.js`,
wired into `public/app.js`. Tests: `tests/sync.test.mjs` (unit) and
`tests/sync.e2e.mjs` (two real browsers against a real Worker and D1).

Settled during the build, where this document had only intent:

- `POST /api/auth/redeem` and `GET /api/me` both return `deviceId`. Without it a
  phone cannot tell its own lease from another's, and every paired device looks
  like a viewer.
- A coach invited **without** a team is club-wide, not powerless. Team scoping
  narrows a coach's reach; it does not gate it. Otherwise a coach invited before
  the teams exist can write nothing.
- `DELETE /api/invites/:id` — an invite is a bearer token, and the usual reason
  to revoke one is that it reached the wrong person.
- The worker's error envelope is `{ error: 'code', message, ...details }` — a
  string code. The client accepts that and the nested form.

---

# Phase 2 — sync schema and API

Status: draft for review · 2026-11-11 (rev 2)
Depends on: design-spec v2.5 (D1 local-first, D2 single editor, D3 derived minutes)

Rev 2 reworks access: a rotating recorder, a pool of coaches, more than one team,
members/devices/invites instead of one club key, and a lease keyed to a match
rather than to a club.

---

## 0. Scope

Phase 1 is a local-only PWA. Phase 2 adds a place for the recording phone to put
what it already recorded, so other phones can follow the same match.

**In scope:** write-behind sync, a read-only poll, one recorder per match,
invitations and revocation.

**Out of scope:** passwords, email, SSO, push notifications, per-field
permissions. The app must keep working with the network off — sync is an
enhancement, never a dependency.

---

## 1. Shape

```
  recording phone                Cloudflare                  viewer phone
  ┌──────────────┐          ┌────────────────────┐          ┌──────────────┐
  │ app (PWA)    │  writes  │ Worker  ──►  D1    │  polls   │ app (PWA)    │
  │ outbox       │ ───────► │  /events /docs     │ ◄─────── │ 5s, mostly   │
  │ localStorage │          │  /lease /auth      │          │ 204s         │
  └──────────────┘          └────────────────────┘          └──────────────┘
```

One Worker, one D1 database, one tenant per club. No Durable Objects in v1:
polling is the sync mechanism and the lease is a row.

---

## 2. Access model

The club has a **pool of coaches**. Any of them may be the recorder on a given
weekend, so "recorder" is not a role a person holds — it is a claim on a match.

### Entities

- **Tenant** — a club. All data belongs to one.
- **Member** — a person: owner, team admin, or coach.
- **Device** — a phone. One member may have several; each holds its own token.
- **Team** — a squad within the club (already exists in Phase 1).
- **Invite** — expiring link that creates a member + device.
- **View link** — expiring, read-only, no identity.
- **Lease** — per match: which device is recording it right now.

### Roles

| | Owner | Team admin | Coach | Viewer (link) |
|---|---|---|---|---|
| Read club data | ✓ | ✓ | ✓ | ✓ |
| Record a match | ✓ | their teams | their teams | — |
| Create/edit matches & plans | ✓ | their teams | their teams | — |
| Edit roster (names, numbers) | ✓ | their teams | — | — |
| Team membership & naming | ✓ | their teams | — | — |
| Create / close seasons | ✓ | — | — | — |
| Invite coaches | ✓ | to their teams | — | — |
| Invite admins, revoke anyone | ✓ | — | — | — |
| Rotate view links | ✓ | their teams | — | — |

Two rules keep this from becoming a permissions maze:

1. **Everyone can read the whole club.** Same volunteers, same kids, and a coach
   covering another team needs the roster. Editing is what gets scoped.
2. **Archiving a person enrolled in more than one team is owner-only.** It
   removes them from someone else's squad, which is not a side effect one coach
   should be able to cause.

### Tokens

- 32-byte random, base64url, stored **hashed** (SHA-256) in D1.
- Sent as `Authorization: Bearer <token>`, kept in `localStorage`.
- The token identifies the member; **the tenant is derived from it**, so no club
  key appears in a URL, a log or a `Referer` header.
- No sessions, no refresh, no cookies — which also sidesteps Safari's
  third-party-cookie blocking. Revocation is deleting the row.
- Serve the app from the **same origin** as the API in Phase 2: removes CORS and
  keeps cookie-based flows available later.

---

## 3. Workflows

### 3.1 First setup

One device holds the owner token, created once with the club. The recovery code
is shown exactly once and written down.

### 3.2 Sending an admin link for a second team

1. Owner creates the team (`P16 B`).
2. Owner taps **Invite** on that team, chooses *Team admin*, gets a link:
   `https://app/join#<token>`
3. It goes out in WhatsApp or the share sheet.
4. The coach taps it. The app states exactly what is granted:
   **"You've been invited to manage Uppåkra P16 B — Team admin."**
5. Accept mints a device token, records the member, and lands on that team's
   roster.

Rules: **single use**, **expires in 7 days**, listed in the members screen, and
the accepting device is named (`Amanda's iPhone`) so it can be revoked.

The token rides in the URL **fragment**, so it never reaches the server, an
access log or a `Referer`.

### 3.3 Inviting the coach pool

Same flow, role *Coach*. Ten of these at a pre-season meeting is the expected
path; the QR of the same link covers a room full of people at once.

### 3.4 Following along

An owner or team admin issues a **view link** per team, expiring at season end.
Read-only, no identity, shared in the group. Rotating it kills every copy.

### 3.5 The weekly recorder rotation

There is no assignment step. On Saturday the coach who is actually there opens
the match and taps **Start recording**, claiming the lease for that match.

- Already held → the phone shows `Amanda is recording` with *Take over*.
- Lease expires after 60 s without a heartbeat, so last week's recorder can never
  block this week's.
- Two matches at once is normal: the lease is per match, not per club.

### 3.6 Handover when a phone dies

Another coach taps *Take over*, their phone bootstraps from the synced log and
continues. Only unflushed events are lost — seconds, not the half.

### 3.7 Someone leaves

Revoke their device. Their `author` remains in the event log; nothing they
recorded disappears.

---

## 4. D1 schema

Two ideas: **documents** (latest state, last-write-wins) and **events**
(append-only, never mutated), plus the access tables.

```sql
CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- people in the club
CREATE TABLE members (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','team_admin','coach')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);

CREATE TABLE member_teams (
  tenant    TEXT NOT NULL,
  member_id TEXT NOT NULL,
  team_id   TEXT NOT NULL,
  PRIMARY KEY (tenant, member_id, team_id)
);

-- phones
CREATE TABLE devices (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,             -- sha256(token); the token is never stored
  label      TEXT,                      -- "Amanda's iPhone"
  created_at TEXT NOT NULL,
  last_seen  TEXT,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX devices_token ON devices (token_hash);

-- single-use, expiring invitations
CREATE TABLE invites (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role       TEXT NOT NULL,             -- team_admin | coach
  team_id    TEXT,                      -- null = all teams
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX invites_token ON invites (token_hash);

-- read-only, expiring, shareable
CREATE TABLE view_links (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  team_id    TEXT,                      -- null = whole club
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX view_links_token ON view_links (token_hash);

-- mutable state: club model, match records, match plans
CREATE TABLE docs (
  tenant     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('model','match','plan')),
  id         TEXT NOT NULL,             -- '' for the model, matchId otherwise
  body       TEXT NOT NULL,             -- JSON { v, ... }; rev is a column
  rev        INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, kind, id)
);

-- append-only history: the only source of truth for minutes and score
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- cursor, monotonic
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,             -- client uuid: idempotency key
  match_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  at_ms      INTEGER NOT NULL,
  clock_ms   INTEGER,
  period     INTEGER,
  payload    TEXT NOT NULL,
  author     TEXT,                      -- member id
  device     TEXT,                      -- device id
  void_of    TEXT,                      -- undo target
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX events_idem   ON events (tenant, id);
CREATE INDEX        events_cursor ON events (tenant, seq);
CREATE INDEX        events_match  ON events (tenant, match_id, seq);

-- who is recording which match, right now
CREATE TABLE lease (
  tenant   TEXT NOT NULL,
  match_id TEXT NOT NULL,
  holder   TEXT,                        -- device id
  name     TEXT,                        -- shown to viewers
  seen_at  INTEGER,
  PRIMARY KEY (tenant, match_id)
);
```

`rev` and `updated_at` are columns, never fields in the body. A plan body is
exactly `{ "v": 1, "cells": [ { "blockIndex": 0, "slot": "LB", "playerId": "p7" } ] }`
— the array `planForecast` already consumes, wrapped so it can grow.

### Why plans are documents and events are rows

A 9-block plan is 63 cells → **2.9 KB**. As rows: 63 writes per save; as a
document: one. Events are the opposite — immutable, individually addressable,
replayed to derive minutes, undone by appending a `void` that points at a target.
Blobbing events breaks undo, retry-safety and replay. Rule of thumb:
**rewritten → document, appended → row.**

### Canonical event order

`(at_ms, id)`, enforced at write time: the client stamps `atMs` strictly
increasing per match — Phase 1 already does this, so replay is identical on every
device.

---

## 5. API

All under `/api`, all `Authorization: Bearer <token>`.

### 5.1 Auth

**`POST /api/auth/redeem`** — exchange an invite for a device token.
```json
{ "invite": "<invite token>", "device": "Amanda's iPhone" }
```
```json
{ "token": "<device token>",
  "member": { "id": "mb1", "name": "Amanda", "role": "team_admin" },
  "tenant": { "id": "t1", "name": "Uppåkra P16" } }
```
`410 Gone` once used, expired or revoked.

**`GET /api/me`** → `{ member, role, teams[], tenant }`.

**`POST /api/members/invite`** — owner, or team admin scoped to their teams.
```json
{ "role": "team_admin", "teamId": "tm2", "expiresInHours": 168 }
```
```json
{ "url": "https://app/join#<invite token>", "expiresAt": "2026-11-18T12:00:00Z" }
```

**`DELETE /api/members/:id`** — revoke a member and every device they hold.

**`POST /api/view-links`** / **`DELETE /api/view-links/:id`** — issue or rotate.

### 5.2 Sync

**`POST /api/events`**
```json
{ "events": [ { "id": "e-8f21", "matchId": "m1", "type": "goal_for",
  "atMs": 1762950000000, "clockMs": 372000, "period": 1,
  "payload": { "scorer": "p11", "assist": "p8" } } ] }
```
```json
{ "seq": 412, "accepted": 1, "duplicates": 0 }
```
`INSERT OR IGNORE` on `(tenant, id)`. 200 events per request; the client chunks.
`author` and `device` are set server-side from the token, never trusted from the
body.

**`GET /api/sync?since=398&revs=<base64url JSON>`**

`revs` is what the client already holds — `{ "model": 4, "match:m1": 7, "plan:m1": 12 }`
— so only moved documents come back.
```json
{ "seq": 412,
  "events": [ /* seq > 398, in seq order */ ],
  "docs":   [ { "kind": "plan", "id": "m1", "rev": 13, "body": {} } ],
  "lease":  [ { "matchId": "m1", "holder": "dev-2", "name": "Amanda", "seenAt": 1762950240000 } ] }
```
`204 No Content` + `ETag` when the cursor and every rev are unchanged: the common
case, and it must cost no body. `revs=*` on first load returns everything.

**`PUT /api/docs/:kind/:id`** with `If-Match: <rev>` → `{ rev }`, or
`409 { rev, body }` and the client re-reads and retries once.

**`POST /api/matches/:id/lease`**
```json
{ "action": "claim" | "heartbeat" | "takeover" | "release" }
```
```json
{ "holder": "dev-1", "name": "Derek", "seenAt": 1762950240000, "mine": true }
```
`409` on `claim`/`heartbeat` when another device holds it, returning the holder so
the phone drops to viewer without guessing. Stale after **60 s** without a
heartbeat, so a viewer shows "reconnecting", not "offline forever".

**`GET /api/health`** → `{ "ok": true, "seq": 412 }`.

---

## 6. Client outbox

Every mutation already flows through four functions:

| Local write | Outbox item |
|---|---|
| `act(type, payload)` | `{ kind: 'event', event }` |
| `store.savePlan(id, cells)` | `{ kind: 'doc', kind: 'plan', id }` — debounce 500 ms |
| `saveMatch(m)` | `{ kind: 'doc', kind: 'match', id }` — debounce 2 s |
| `persistModel()` | `{ kind: 'doc', kind: 'model', id: '' }` — debounce 5 s |

Written locally before the network is touched. Items coalesce by `(kind, id)`;
events never coalesce, only batch.

**Flush:** immediately on `online`, on foreground, and at full time (wait for
ack); on debounce expiry; every 30 s while a match is live and the queue is not
empty; best effort on `pagehide`.

**Failure:** backoff 5 → 10 → 20 → 30 s, reset on success. The outbox survives
reloads, so a closed tab is not a lost action.

---

## 7. Polling

Viewers only; the recording phone does not poll.

- **5 s** while a match is live and visible, jittered ±1 s so ten phones don't
  fire in lockstep
- **idle backoff** to 15 s after two minutes with nothing new, snapping back on
  any change — with ten followers this cuts steady-state load by about two thirds
- **paused** when hidden; immediate fetch on return
- **stopped** after `finalize`
- **not running** on History or Roster — those fetch once on open

Two rules matter more than the interval: **never re-render under an open sheet or
a focused input**, and **show freshness** (`updated 4s ago`) so a stalled poll is
distinguishable from a quiet match.

---

## 8. Conflicts

| Data | Rule | Losing case |
|---|---|---|
| Events | unique on `(tenant, id)`, append-only | none — duplicate dropped |
| Plan | LWW, `rev` guards staleness | recorder's last save wins |
| Match record | LWW, **status monotonic** (`setup < live < final`) | server refuses a backwards move |
| Model | LWW per document | simultaneous roster edit; acceptable behind the lease |
| Lease | explicit takeover, never silent | loser drops to viewer |

Nothing merges. Merging documents needs a CRDT or a cell-level op log and buys
nothing at this scale.

---

## 9. Limits and cost

Per match: ~40 events, ~3 plan writes, ~4 match writes, ~120 lease heartbeats.
Ten viewers polling every five seconds for an hour is ~7,200 requests, of which
~6,600 are bodiless `204`s. A weekend of four matches stays inside the free
tier's 100k requests/day; the idle backoff is what keeps it comfortable.

---

## 10. Migration and backfill

On first successful sync: `PUT /docs/model`, then each match and plan, then
events in chunks of 200, then set the local cursor. Documents first, so a viewer
arriving mid-backfill never sees events for a match it cannot name.

A second phone pairs by opening an invite link, then bootstraps with
`GET /api/sync?since=0&revs=*`.

---

## 11. Open questions

1. **Owner recovery** — losing the only owner device means losing admin. Plan:
   pair a second owner device in week one and keep the recovery code offline.
2. **History visibility** — one tenant means an invite is also the key to every
   past season. Probably right; state it in the invite copy.
3. **Panic button** — revocation is per device; there is no "invalidate
   everything now". Noted, not built.
4. **Clock skew** — `at_ms` comes from the phone. Accept within ±2 min rather
   than trying to correct it.
5. **Multi-club** — a coach helping at two clubs holds two tokens and needs a
   club switcher. Out of scope until it happens.
