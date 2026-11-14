/**
 * store.js — device state. Synchronous, tiny, and written on every tap.
 *
 * Deliberately dumb: localStorage is a key-value box and the whole dataset is
 * a few hundred KB at most. IndexedDB would be complexity without benefit.
 *
 * Nothing here knows about the network. Phase 2 adds a sync queue on top.
 */

import { stampEvents } from './engine.js';

const P = 'mm.v1.';
const K = {
  team: P + 'team',
  teams: P + 'teams',
  clubs: P + 'clubs',
  seasons: P + 'seasons',
  people: P + 'people',
  entries: P + 'entries',
  matches: P + 'matches',
  events: (id) => P + 'events.' + id,
  plan: (id) => P + 'plan.' + id,
  lang: P + 'lang',
};

export function createStore(storage = globalThis.localStorage) {
  const read = (key, fallback) => {
    try {
      const raw = storage.getItem(key);
      if (raw == null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      // A corrupt value must never take the app down mid-match.
      return fallback;
    }
  };

  const write = (key, value) => {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // quota or private mode — the UI surfaces this
    }
  };

  const asArray = (v) => (Array.isArray(v) ? v : []);
  const listMatches = () => asArray(read(K.matches, []));

  return {
    /* ---- team ---- */
    loadTeam: () => read(K.team, null),
    saveTeam: (team) => write(K.team, team),

    /* ---- language ---- */
    loadLang: () => read(K.lang, null),
    saveLang: (lang) => write(K.lang, lang),

    /* ---- matches ---- */
    /** Everything the user should see: a deleted match is a tombstone, not a row. */
    listMatches: () => asArray(read(K.matches, [])).filter((m) => !m.deletedAt),
    /** Including tombstones — for syncing, which must carry the deletion up. */
    allMatches: () => asArray(read(K.matches, [])),
    loadMatch(id) {
      return asArray(read(K.matches, [])).find((m) => m.id === id) || null;
    },
    saveMatch(match) {
      const all = listMatches();
      const i = all.findIndex((m) => m.id === match.id);
      if (i === -1) all.push(match);
      else all[i] = match;
      return write(K.matches, all);
    },

    /* ---- clubs / seasons / people / enrolments ---- */
    loadClubs: () => asArray(read(K.clubs, [])),
    saveClubs: (list) => write(K.clubs, list),
    loadSeasons: () => asArray(read(K.seasons, [])),
    saveSeasons: (list) => write(K.seasons, list),
    loadPeople: () => asArray(read(K.people, [])),
    savePeople: (list) => write(K.people, list),
    loadEntries: () => asArray(read(K.entries, [])),
    saveEntries: (list) => write(K.entries, list),

    /* ---- teams (named groups picked from the roster) ---- */
    loadTeams: () => asArray(read(K.teams, [])),
    saveTeams: (list) => write(K.teams, list),

    /* ---- plan (configuration, not history) ---- */
    loadPlan: (matchId) => asArray(read(K.plan(matchId), [])),
    savePlan: (matchId, cells) => write(K.plan(matchId), cells),

    /* ---- events (append-only) ---- */
    /** Canonical order: (atMs, id). Every consumer replays in this order. */
    loadEvents: (matchId) => asArray(read(K.events(matchId), []))
      .slice()
      .sort((a, b) => (Number(a.atMs) || 0) - (Number(b.atMs) || 0)
        || String(a.id).localeCompare(String(b.id))),

    /** Appends one event. Returns the event, or null if storage refused it. */
    appendEvent(matchId, event) {
      const saved = this.appendEvents(matchId, [event]);
      return saved.length ? saved[0] : null;
    },

    appendEvents(matchId, events) {
      if (!events.length) return [];
      const all = asArray(read(K.events(matchId), []));
      // Strictly increasing timestamps: the replay order is (atMs, id), and a
      // shared millisecond would otherwise fall through to a random id.
      const stamped = stampEvents(all, events);
      all.push(...stamped);
      return write(K.events(matchId), all) ? stamped : [];
    },

    /**
     * Merges events that arrived from another device. Their atMs is already
     * authoritative and strictly ordered by the writer, so they are never
     * re-stamped here — only duplicates are dropped, by id.
     * Returns how many were new.
     */
    mergeEvents(matchId, incoming) {
      if (!incoming?.length) return 0;
      const all = asArray(read(K.events(matchId), []));
      const have = new Set(all.map((e) => e.id));
      const fresh = incoming.filter((e) => e && e.id && !have.has(e.id));
      if (!fresh.length) return 0;
      all.push(...fresh);
      return write(K.events(matchId), all) ? fresh.length : 0;
    },

    /**
     * Soft-deletes by appending a void event. The original stays in the log —
     * that is what makes undo exact and the history auditable.
     */
    voidEvent(matchId, eventId, atMs = Date.now(), author = null) {
      return this.appendEvent(matchId, {
        id: uid(),
        type: 'void',
        atMs,
        payload: {},
        voidOf: eventId,
        author,
      });
    },

    /**
     * Deletes a match by marking it, not by dropping the row.
     *
     * The club holds a copy of every match. Removing the row locally only made
     * the next sync put it back — a deletion that silently undoes itself. A
     * tombstone travels with the record, so every device agrees, and the history
     * of what was deleted survives.
     */
    deleteMatch(id, at = new Date().toISOString()) {
      const all = asArray(read(K.matches, []));
      const i = all.findIndex((m) => m.id === id);
      if (i === -1) return false;
      all[i] = { ...all[i], deletedAt: at };
      return write(K.matches, all);
    },

    /* ---- bulk ---- */
    exportAll() {
      const matches = read(K.matches, []);
      return {
        v: 1,
        exportedAt: new Date().toISOString(),
        team: read(K.team, null),
        teams: read(K.teams, []),
        clubs: read(K.clubs, []),
        seasons: read(K.seasons, []),
        people: read(K.people, []),
        entries: read(K.entries, []),
        matches,
        plan: Object.fromEntries(matches.map((m) => [m.id, read(K.plan(m.id), [])])),
        events: Object.fromEntries(matches.map((m) => [m.id, read(K.events(m.id), [])])),
      };
    },

    importAll(data) {
      if (!data || data.v !== 1) return false;
      write(K.team, data.team);
      write(K.teams, data.teams || []);
      write(K.clubs, data.clubs || []);
      write(K.seasons, data.seasons || []);
      write(K.people, data.people || []);
      write(K.entries, data.entries || []);
      write(K.matches, data.matches || []);
      for (const [id, cells] of Object.entries(data.plan || {})) write(K.plan(id), cells);
      for (const [id, evs] of Object.entries(data.events || {})) write(K.events(id), evs);
      return true;
    },

    clearAll() {
      for (const key of Object.keys(storage)) {
        if (typeof key === 'string' && key.startsWith(P)) storage.removeItem(key);
      }
    },
  };
}

/** Client-side event id: crypto.randomUUID when available. */
export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
