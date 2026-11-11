/**
 * store.js — device state. Synchronous, tiny, and written on every tap.
 *
 * Deliberately dumb: localStorage is a key-value box and the whole dataset is
 * a few hundred KB at most. IndexedDB would be complexity without benefit.
 *
 * Nothing here knows about the network. Phase 2 adds a sync queue on top.
 */

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
    listMatches,
    loadMatch: (id) => listMatches().find((m) => m.id === id) || null,
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
    loadEvents: (matchId) => asArray(read(K.events(matchId), [])),

    /** Appends one event. Returns the event, or null if storage refused it. */
    appendEvent(matchId, event) {
      const all = asArray(read(K.events(matchId), []));
      all.push(event);
      return write(K.events(matchId), all) ? event : null;
    },

    appendEvents(matchId, events) {
      if (!events.length) return [];
      const all = asArray(read(K.events(matchId), []));
      all.push(...events);
      return write(K.events(matchId), all) ? events : [];
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

    /** Hard-deletes a match and its plan/events. Used only by an explicit confirm. */
    deleteMatch(id) {
      const all = listMatches().filter((m) => m.id !== id);
      try { storage.removeItem(K.events(id)); storage.removeItem(K.plan(id)); } catch { /* ignore */ }
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
