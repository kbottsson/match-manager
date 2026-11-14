# Verifying against the live club

The app's tests run against a local Worker and a throwaway D1 (`tests/*.e2e.mjs`).
Some things can only be checked on the real deployment: TLS, custom domains, the
service worker, and the actual club row. Those checks write to **real data**, so
they follow one rule:

> **Anything a verification creates, it removes in the same turn — and then proves
> the club is back to what it was.**

Not "later", not "when convenient". A test that leaves state behind is a test
that quietly degrades the thing it is checking.

## Before

Take a baseline, so "restored" is a claim you can check rather than assume:

```bash
# who and what is in the club
curl -s -H "authorization: Bearer $TOKEN" https://match.kbottsson.com/api/members

# documents and events (the real content)
curl -s -H "authorization: Bearer $TOKEN" \
  "https://match.kbottsson.com/api/sync?since=0&revs=*"
```

Write the numbers down. Members, devices per member, pending invites, doc kinds,
event count.

## Prefer checks that create nothing

Most verification needs no state at all:

- `GET /api/health` — the Worker and D1 are alive
- unauthenticated requests — expect `401`, never `200`
- `GET /api/docs/:kind/:id` — read what is already there
- a headless browser on `/` and `/join#<bad-token>` — the shell loads, a bad link
  is refused, no pairing is written

Reach for the state-creating paths (device links, invites, redemption) only when
the thing under test *is* that path.

## When you must create something

1. **Capture the ids** the API returns (`deviceId`, member `id`, invite `id`) as
   you create them, and keep them for cleanup. The id is the only identifier that
   is always yours to hold.
2. **Label it where the label survives.** A member or invite name stays as you
   wrote it (`test-<purpose>`), so cleanup can match on it. A *device* label does
   not: the phone sends its own ("Mac", "iPhone"), so every test device looks
   like every other one. Clean those up by captured id, never by label.
3. **Use one throwaway browser profile per device**, deleted at the end. The
   token lives only in that profile, which is what makes the device row inert.

## After

Clean up **through the API**, not with SQL. The API is the authorised path and
these are all soft operations — the row stays as evidence, the credential dies.

```bash
# a device you created: retire it (this is also "I lost my phone")
curl -s -X DELETE -H "authorization: Bearer $TOKEN" \
  https://match.kbottsson.com/api/devices/<deviceId>

# a member you invited: revoke
curl -s -X DELETE -H "authorization: Bearer $TOKEN" \
  https://match.kbottsson.com/api/members/<id>

# an invite or device link, spent or not: revoke
curl -s -X DELETE -H "authorization: Bearer $TOKEN" \
  https://match.kbottsson.com/api/invites/<id>
```

Each of these returns `{ok}` and takes effect immediately: a retired device's
token answers `401` on the next request, which is the check worth making.

**SQL is the last resort**, for rows the API has no route for. It bypasses the
worker's own authorization, which is exactly why it needs a human confirmation —
if you find yourself reaching for it routinely, the API is missing an operation,
and adding that operation is the fix.

Then **re-run the baseline queries** and compare. Success is "identical", not
"the command exited 0".

## What counts as test state

| Created | How it ends |
|---|---|
| Device (via device link or owner token) | `DELETE /api/devices/:id` — retires it (revoked, not deleted) |
| Member (via invite) | `DELETE /api/members/:id` — revoke, then the row is inert |
| Invite / device link (spent or not) | `DELETE /api/invites/:id` — always revoke unspent ones |
| Documents (`match`, `plan`, `model`) | Delete only if the verification created them; never touch real ones |
| Events | Should be zero unless a match was actually recorded |

## Why this is a product feature, not a test chore

The same endpoint that cleans up a test device is the one a coach uses when a
phone is lost — `Club → Devices → Retire`. Both worth having, one implementation.
An operation that only tests can perform is an operation the product is missing.

## The failure this catches

Devices left behind are the ones that matter. A device row is a live credential
row: if the plaintext token still exists anywhere (a saved profile, a pasted
link), that is owner access sitting unattended. Four rows labelled "Mac" on an
owner account are also indistinguishable from a stolen phone in any future
"manage devices" screen — which is where someone revokes the wrong thing.

Cleaning up promptly is not tidiness; it is what keeps a security screen
trustworthy when it eventually exists.
