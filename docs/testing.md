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

1. **Label it as test state**, unmistakably: `deviceLabel: "test:<purpose>"`,
   member name `test-<purpose>`. Cleanup matches on the marker, never on a
   real-looking name — a future real "Amanda" must never be caught by cleanup.
2. **Capture the ids** the API returns (`deviceId`, member `id`, invite `id`) as
   you create them, and keep them for the cleanup step. Do not re-derive them by
   name afterwards.
3. **Use one throwaway browser profile per device**, deleted at the end. The
   token lives only in that profile, which is what makes the device row inert.

## After

```bash
# devices: delete by explicit id, never by label alone
npx wrangler d1 execute match-manager --remote --command \
  "DELETE FROM devices WHERE id IN ('<id>','<id>') AND label = 'test:<purpose>';"

# members: revoke (keeps the audit trail), or delete the test rows outright
curl -s -X DELETE -H "authorization: Bearer $TOKEN" \
  https://match.kbottsson.com/api/members/<id>

# invites and device links: revoke
curl -s -X DELETE -H "authorization: Bearer $TOKEN" \
  https://match.kbottsson.com/api/invites/<id>
```

Then **re-run the baseline queries** and compare. Success is "identical", not
"the command exited 0".

## What counts as test state

| Created | How it ends |
|---|---|
| Device (via device link or owner token) | `DELETE FROM devices` by explicit id |
| Member (via invite) | `DELETE /api/members/:id` — revoke, then the row is inert |
| Invite / device link (spent or not) | `DELETE /api/invites/:id` — always revoke unspent ones |
| Documents (`match`, `plan`, `model`) | Delete only if the verification created them; never touch real ones |
| Events | Should be zero unless a match was actually recorded |

## The failure this catches

Devices left behind are the ones that matter. A device row is a live credential
row: if the plaintext token still exists anywhere (a saved profile, a pasted
link), that is owner access sitting unattended. Four rows labelled "Mac" on an
owner account are also indistinguishable from a stolen phone in any future
"manage devices" screen — which is where someone revokes the wrong thing.

Cleaning up promptly is not tidiness; it is what keeps a security screen
trustworthy when it eventually exists.
