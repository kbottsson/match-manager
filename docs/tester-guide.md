# Match Manager — quick start for testers

A small app for running a 7-a-side match: playing time, substitutions, goals
and assists. Built for a phone on a touchline — big buttons, works with no
signal.

**https://kbottsson.github.io/match-manager/**

No account, no sign-up, no cost. It's an early build, so expect rough edges —
that's what I want your eyes on.

---

## 1. Put it on your home screen (30 seconds)

Open the link in **Safari**, tap **Share**, then **Add to Home Screen**.

Worth doing rather than bookmarking: it opens full-screen without the browser
bar, it works offline once loaded, and Safari otherwise clears the app's stored
data if you don't open it for a week.

## 2. Add your players (once)

**Roster** tab → add each kid's first name and shirt number.

First names only. Everything you type stays on your phone — nothing is uploaded
anywhere and I can't see it.

## 3. Make a team

**Teams** tab → **+ New team** → name it (e.g. "P16 A") → tap the players you
want in it → **Save**.

Roster is "everyone in the club". A team is "the group that plays together" —
you can have more than one, and edit them any time.

## 4. Plan a match

**Match** tab → **+ Plan another match** → opponent, date, and which team.
Then fill in the grid: tap a cell, pick a player.

A period is three blocks (7 / 7 / 6 minutes), so two substitutions per period.
The **bench row** under each period shows who is sitting out in each block, and
the forecast at the bottom shows everyone's minutes. Tap **Save** when it reads
right — it saves as you go, so you can also just leave.

Kids who can't make it: untick them at the top of the plan screen
(*"Who is here today"*). Their cells empty out and they drop off the bench.

## 5. On match day

- **Start period 1** when the ref whistles; **Stop/Start** if play stops.
- **⚽** on a player's row = goal → tap who assisted, or *No assist*.
- **⇄** on a row = substitution. From an on-field player it asks who comes on;
  from a bench player it asks who comes off. Same two taps either way.
- Tap a player's **name** for more: log goal, sub off, **change position**.
- The **period chip** at the top holds *End period* and *End match*.
- The **‹** at top left goes home mid-match — the clock keeps running.

---

## Good to know

- **Minutes include time in goal.** One number per player.
- Every action can be **undone** — a toast appears for a few seconds, and there's
  a ⟲ button in the bottom bar.
- Nothing syncs yet. What you record on your phone stays there.

## Known gaps

- Single coach only — no shared/read-only view for a second phone yet.
- No hand-editing of minutes, and no season totals.
- No availability calendar: you mark absences on the plan screen, per match.

## What I'd like to hear

Whatever annoys you, in your own words. Specifically:

1. Could you run a full match end to end without getting stuck?
2. Is the plan grid readable on your phone, or too much scrolling?
3. Are the ⚽ / ⇄ buttons on each row too easy to hit by mistake?
4. Anything you'd expect to find and couldn't.

Screenshots are more useful than descriptions — and please say what you were
doing when it went wrong.

**To try it without entering anything real:** add `?seed=1` to the end of the
link and it loads a fake match already in progress.
