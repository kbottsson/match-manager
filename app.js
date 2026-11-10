/**
 * app.js — the whole UI. Views are pure functions of (state, projection);
 * every write goes through `act()` so the event log stays the only truth.
 */
import {
  project, planForecast, blockLayout, benchList, onFieldList,
  canCreditGoal, SLOTS, MIN,
} from './engine.js';
import { createStore, uid } from './store.js';
import { t, setLang, getLang, detectLang, pos as posLabel } from './i18n/index.js';

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const store = createStore();

const s = {
  lang: 'sv',
  team: null,
  match: null,
  plan: [],
  events: [],
  sheet: null,
  toast: null,
  route: null,
  tab: 'match',
  creating: false,
  editingTeam: null,
};

function config() {
  return {
    periodCount: s.match?.periodCount ?? 3,
    periodMinutes: s.match?.periodMinutes ?? 20,
    blockMinutes: s.match?.blockMinutes ?? 7,
  };
}

function proj() {
  return project(s.events, config(), Date.now());
}

const T = (key, vars) => t(key, vars);
const P = (slot, field) => posLabel(slot, field);

/* ------------------------------------------------------------------ *
 * persistence
 * ------------------------------------------------------------------ */

function boot() {
  s.lang = store.loadLang() || detectLang();
  setLang(s.lang);
  s.team = store.loadTeam();
  const matches = store.listMatches();
  // Migration: an existing roster with no teams becomes one team holding everyone.
  if (s.team?.players?.length && !store.loadTeams().length) {
    store.saveTeams([{ id: 't-default', name: s.team.name || 'Team 1',
      playerIds: s.team.players.map((p) => p.id) }]);
  }
  // Land on the live match only; everything else is opened from the list.
  s.match = matches.find((m) => m.status === 'live') || null;
  if (s.match) {
    s.plan = store.loadPlan(s.match.id);
    s.events = store.loadEvents(s.match.id);
  }
  document.documentElement.lang = s.lang;
}

function switchLang() {
  s.lang = s.lang === 'sv' ? 'en' : 'sv';
  setLang(s.lang);
  store.saveLang(s.lang);
  document.documentElement.lang = s.lang;
  render();
}

function saveMatch(match = s.match) {
  if (!match) return;
  store.saveMatch(match);
}

/**
 * Writes one event. Everything else in the UI is a consequence of this.
 */
function act(type, payload = {}, { silent = false } = {}) {
  if (!s.match) return null;
  const p = proj();
  const ev = {
    id: uid(),
    type,
    atMs: Date.now(),
    clockMs: p.clockMs,
    period: p.period,
    payload,
    author: 'coach',
  };
  store.appendEvent(s.match.id, ev);
  s.events.push(ev);
  if (!silent) {
    const summary = describe(ev);
    if (summary) showToast(summary, ev.id);
  }
  return ev;
}

function undoEvent(evId) {
  if (!s.match) return;
  const v = store.voidEvent(s.match.id, evId);
  if (v) s.events.push(v);
  s.toast = null;
  render();
}

function undoLast() {
  const p = proj();
  const voided = new Set(s.events.map((e) => e.voidOf).filter(Boolean));
  const live = s.events.filter((e) => !voided.has(e.id) && e.type !== 'void');
  const last = [...live].reverse().find((e) => e.type !== 'void');
  if (last) undoEvent(last.id);
}

function describe(ev) {
  const pl = ev.payload || {};
  const nm = (id) => s.team?.players.find((x) => x.id === id)?.name ?? '';
  switch (ev.type) {
    case 'goal_for':
      return pl.assist
        ? `⚽ ${nm(pl.scorer)} · ${T('assists')} ${nm(pl.assist)}`
        : `⚽ ${nm(pl.scorer)}`;
    case 'goal_against': return '⚽ ' + T('theirGoal');
    case 'sub': return `⇄ ${nm(pl.off?.[0])} → ${nm(pl.on?.[0])}`;
    case 'move': return `↗ ${nm(pl.player)} · ${P(pl.to)}`;
    case 'period_start': return `${T('periodN', { n: pl.period })} · ${T('start')}`;
    case 'period_end': return `${T('periodN', { n: pl.period })} · ${T('endPeriod')}`;
    default: return null;
  }
}

let toastTimer = null;
function showToast(html, evId) {
  // A multi-step action (Apply) must undo as one gesture, so the toast can
  // carry several event ids.
  const ids = Array.isArray(evId) ? evId : evId ? [evId] : [];
  s.toast = { html, evId: ids.join(',') };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { s.toast = null; render(); }, 6000);
  render();
}

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

const fmtMin = (ms) => (ms / MIN).toFixed(1);
const mmss = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const player = (id) => s.team?.players.find((p) => p.id === id) || { id, name: '?', no: '' };

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function routeNow() {
  if (!s.team || !s.team.players?.length) return 'setup';
  if (s.creating) return 'setup';
  if (s.route === 'team' && s.editingTeam) return 'team';
  if (s.route === 'home') return 'setup';
  if (!s.match) return 'setup';
  if (s.match.status === 'live') return 'live';
  if (s.match.status === 'final') return s.route === 'setup' ? 'setup' : 'recap';
  return s.route === 'plan' ? 'plan' : 'setup';
}

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

function render() {
  const app = document.getElementById('app');
  // NOTE: do not write the derived route back into s.route. s.route is the
  // user's *requested* route (home / plan / live); overwriting it with the
  // resolved one made "home" last exactly one render, so the next tap bounced
  // straight back into the live match.
  const route = routeNow();

  if (route === 'live') app.innerHTML = viewLive();
  else if (route === 'team') app.innerHTML = viewTeam();
  else if (route === 'plan') app.innerHTML = viewPlan();
  else if (route === 'recap') app.innerHTML = viewRecap();
  else app.innerHTML = viewSetup();

  if (s.sheet) app.insertAdjacentHTML('beforeend', renderSheet());
  if (s.toast) app.insertAdjacentHTML('beforeend', `<div class="toast">${s.toast.html}
    <button data-act="undo:${s.toast.evId}">${T('undo')}</button></div>`);
}

/* ------------------------------------------------------------------ *
 * Next change — the plan, read against the pitch
 * ------------------------------------------------------------------ */

function planCell(blockIndex, slot) {
  return s.plan.find((x) => x.blockIndex === blockIndex && x.slot === slot)?.playerId || null;
}

/** Substitution pairs to reach `blockIndex`'s plan from the pitch as it is now. */
function pairsFor(blockIndex, p, known) {
  const planned = SLOTS.map((sl) => planCell(blockIndex, sl)).filter((id) => id && known.has(id));
  // A half-filled block can't be trusted as a target: it would read as
  // "everyone not listed must come off".
  if (planned.length !== SLOTS.length) return null;
  const onPitch = Object.keys(p.onField).map((sl) => p.onField[sl]).filter(Boolean);

  const outs = SLOTS
    .filter((sl) => p.onField[sl] && !planned.includes(p.onField[sl]))
    .map((sl) => ({ slot: sl, id: p.onField[sl] }));

  const benchIn = SLOTS
    .map((sl) => ({ slot: sl, id: planCell(blockIndex, sl) }))
    .filter((x) => x.id && known.has(x.id) && !onPitch.includes(x.id))
    .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);

  const pairs = [];
  const used = new Set();
  for (const out of outs) {
    const same = benchIn.find((x) => x.slot === out.slot && !used.has(x.id));
    const any = same || benchIn.find((x) => !used.has(x.id));
    if (!any) continue;
    used.add(any.id);
    pairs.push({ off: out.id, on: any.id, slot: out.slot });
  }
  return pairs;
}

/** True when exactly the players planned for `blockIndex` are the ones out there. */
function pitchIsPlan(blockIndex, p, known) {
  const want = SLOTS.map((sl) => planCell(blockIndex, sl)).filter((id) => id && known.has(id));
  if (want.length !== SLOTS.length) return false;
  const on = Object.keys(p.onField).map((sl) => p.onField[sl]).filter(Boolean);
  if (on.length !== want.length) return false;
  return on.every((id) => want.includes(id));
}

/**
 * What to do at this boundary, read against the pitch rather than the plan.
 *
 * Order matters: if the block you are IN doesn't match its plan (you were late,
 * or a sub happened early), that change is still owed — it stays on screen as
 * overdue instead of silently sliding to the next boundary.
 *
 * Substitutions only. The planner rotates players through positions, and
 * bubbling six "move" prompts at every boundary is noise; positions live on the
 * plan sheet.
 */
function nextChange(p) {
  if (p.state === 'idle' || p.state === 'ended') return null;
  const c = config();
  const blocks = blockLayout(c).filter((b) => b.period === p.period);
  if (!blocks.length) return null;

  let i = blocks.findIndex((b) => p.clockMs < b.startMs + b.lengthMs);
  if (i < 0) i = blocks.length - 1;
  const cur = blocks[i];
  const nxt = blocks[i + 1];
  const known = new Set(s.team.players.map((pl) => pl.id));

  // Still owed for the block we are in? Only if you have not moved on yet —
  // i.e. the pitch is still the previous block's lineup. Applying early puts a
  // later lineup out there, which must not read as "overdue" in reverse.
  const prev = blocks[i - 1];
  const owed = prev && pitchIsPlan(prev.blockIndex, p, known)
    ? pairsFor(cur.blockIndex, p, known)
    : null;
  if (owed && owed.length) {
    return { msTo: 0, lateMs: Math.max(0, p.clockMs - cur.startMs), pairs: owed, moves: [], overdue: true };
  }

  if (!nxt) return null;

  const ahead = pairsFor(nxt.blockIndex, p, known);
  if (ahead && ahead.length) {
    return { msTo: Math.max(0, nxt.startMs - p.clockMs), lateMs: 0, pairs: ahead, moves: [], overdue: false };
  }

  // A small planned position swap with no substitution is still worth a nudge.
  const onPitch = Object.keys(p.onField).map((sl) => p.onField[sl]).filter(Boolean);
  const moves = SLOTS
    .filter((sl) => {
      const want = planCell(nxt.blockIndex, sl);
      return want && known.has(want) && p.onField[sl] !== want && onPitch.includes(want);
    })
    .map((sl) => ({ player: planCell(nxt.blockIndex, sl), to: sl }));
  if (!moves.length || moves.length > 2) return null;
  return { msTo: Math.max(0, nxt.startMs - p.clockMs), lateMs: 0, pairs: [], moves, overdue: false };
}

function changeStrip(p) {
  const nc = nextChange(p);
  if (!nc) return '';
  const nm = (id) => {
    const pl = player(id);
    return pl ? `<b>${esc(pl.name)} ${esc(pl.no)}</b>` : '<b>—</b>';
  };
  const items = [
    ...nc.pairs.map(({ off, on }) => `${nm(off)} → ${nm(on)}`),
    ...nc.moves.map((m) => `${nm(m.player)} → ${P(m.to)}`),
  ];
  const label = nc.overdue ? T('overdue') : T('nextChangeIn');
  const clock = nc.overdue ? `+${mmss(nc.lateMs)}` : mmss(nc.msTo);
  return `<div class="nxt${nc.overdue ? ' late' : ''}">
      <div class="nxr">
        <div class="l1"><span class="lab">${label}</span>
          <span class="cd">${clock}</span></div>
        <div class="chg">${items.join(' · ')}</div>
      </div>
      <button class="apply" data-act="applyplan">${T('apply')}</button>
    </div>`;
}

function headerLive(p, showScore = true) {
  const late = p.clockMs > (config().periodMinutes * MIN);
  const pct = Math.min(100, (p.clockMs / (config().periodMinutes * MIN)) * 100);
  const stateChip = p.state === 'paused'
    ? `<span class="chip warn dot">${T('stopped')}</span>`
    : `<span class="chip coach dot">${T('coach')}</span>`;
  return `<header>
    <div class="toprow">
      <button class="back" data-act="home" aria-label="${T('home')}">‹</button>
      ${stateChip}
      <button class="chip period" data-act="periodsheet">${T('periodN', { n: p.period })}<span style="font-size:11px;opacity:.65;margin-left:1px">▾</span></button>
      <button class="chip period" data-act="plansheet">${T('plan')}</button>
      <span class="grow"></span>
      <span>${esc(s.match?.opponent || s.team.name)}</span>
    </div>
    <div class="scoreline">
      <div class="clock${late ? ' late' : ''}" data-clock>
        ${mmss(p.clockMs)}<span class="of">/${config().periodMinutes}:00</span>
      </div>
      ${showScore ? `<div class="score">${p.score.for}<span class="dash">–</span>${p.score.against}</div>` : ''}
    </div>
    <div class="progress${late ? ' late' : ''}" data-progress><i style="width:${pct}%"></i></div>
  </header>${changeStrip(p)}`;
}

function headerPlain(title, sub, right = '') {
  return `<header>
    <div class="toprow"><span>${esc(title)}</span><span class="grow"></span>${right}</div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:2px">
      <div style="font-size:17px;font-weight:700;letter-spacing:-.02em">${esc(sub)}</div>
    </div>
  </header>`;
}

/* ------------------------------------------------------------------ *
 * Setup: squad, match, history
 * ------------------------------------------------------------------ */

function viewSetup() {
  const tabs = [['match', T('tabMatch')], ['squad', T('tabSquad')], ['teams', T('tabTeams')], ['history', T('tabHistory')]]
    .map(([k, label]) => `<button class="tab${s.tab === k ? ' on' : ''}" data-act="tab:${k}">${label}</button>`)
    .join('');
  const body = s.tab === 'squad' ? squadCard()
    : s.tab === 'teams' ? teamsTab()
    : s.tab === 'history' ? historyCard()
    : matchTab();
  const lang = `<button class="chip period" data-act="lang">${T('language')}</button>`;
  return headerPlain(s.team?.name || T('app'), T('tab' + s.tab[0].toUpperCase() + s.tab.slice(1)), lang)
    + `<div class="view"><div class="tabs">${tabs}</div><div class="setup">${body}</div></div>`;
}

function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(s.lang === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'short' });
}

function selectMatch(match) {
  s.match = match;
  s.plan = store.loadPlan(match.id);
  s.events = store.loadEvents(match.id);
  s.creating = false;
  s.sheet = null;
}

/**
 * Match tab: the live match if there is one, then everything planned ahead.
 * Planning several matches in advance is the whole point of this list.
 */
function teamsTab() {
  const list = teams();
  return `<div class="card">
      <h3>${T('tabTeams')}</h3>
      ${list.length
        ? list.map((t) => `<button class="matchrow" data-act="openteam:${t.id}">
            <span class="opp">${esc(t.name)}</span>
            <span class="dt">${T('playersN', { n: t.playerIds.length })}</span>
            <span style="color:var(--ink3);font-size:17px;line-height:1">›</span>
          </button>`).join('')
        : `<div class="muted">${T('noTeams')}</div>`}
      <button class="btn wide" style="margin-top:12px" data-act="newteam">+ ${T('newTeam')}</button>
    </div>`;
}

function viewTeam() {
  const t = s.editingTeam;
  const list = roster();
  return `<header>
      <div class="toprow">
        <button class="back" data-act="backteam" aria-label="${T('cancel')}">‹</button>
        <span>${T('tabTeams')}</span>
        <span class="grow"></span>
        <button class="chip period" data-act="saveteam2">${T('save')}</button>
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:2px">
        <div style="font-size:17px;font-weight:700;letter-spacing:-.02em">${esc(t.name || T('newTeam'))}</div>
      </div>
    </header>`
    + `<div class="view"><div class="setup">
      <div class="card">
        <h3>${T('teamNameLbl')}</h3>
        <form id="teamnameform">
          <div class="field" style="margin:0">
            <input name="teamname" value="${esc(t.name || '')}" placeholder="P16 A" autocomplete="off">
          </div>
        </form>
      </div>
      <div class="card">
        <h3>${T('teamPlayers')} · ${t.playerIds.length}/${list.length}</h3>
        ${list.length
          ? `<div class="chiprow" style="padding:0">${list.map((pl) => `<button
              class="tog ${t.playerIds.includes(pl.id) ? 'on' : 'off'}"
              data-act="togmember:${pl.id}">${esc(pl.name)}</button>`).join('')}</div>`
          : `<div class="muted">${T('rosterEmpty')}</div>`}
      </div>
      ${t.isNew ? '' : `<button class="btn wide" style="color:var(--red);border-color:#e6cfcc"
        data-act="deleteteam">${T('deleteTeam')}</button>`}
    </div></div>`;
}

function matchTab() {
  if (!s.team.players.length) return `<div class="empty">${T('squadEmpty')}</div>`;

  // A match is played by a team, so there has to be one first.
  if (!teams().length) {
    return `<div class="card">
      <h3>${T('newMatch')}</h3>
      <div class="muted">${T('noTeamForMatch')}</div>
      <button class="btn primary" style="width:100%;margin-top:12px" data-act="goto:teams">${T('newTeam')}</button>
    </div>`;
  }

  const all = store.listMatches();
  const live = all.find((m) => m.status === 'live');
  const upcoming = all
    .filter((m) => m.status === 'setup')
    .sort((a, b) => String(a.kickoff || '9999').localeCompare(String(b.kickoff || '9999')));

  if (s.creating || (!live && !upcoming.length)) return newMatchForm(!all.length);

  const liveP = live ? project(store.loadEvents(live.id), live, Date.now()) : null;

  return `
    ${live ? `<div class="card">
      <h3>${T('inProgress')}</h3>
      <div style="font-size:16px;font-weight:700">${esc(live.opponent || '—')}</div>
      <div style="font:700 15px/1 var(--num);margin-top:8px">${liveP.score.for}–${liveP.score.against}
        · ${T('periodN', { n: liveP.period })}</div>
      <button class="btn primary" style="width:100%;margin-top:12px" data-act="resume">${T('resume')}</button>
    </div>` : ''}
    <div class="card">
      <h3>${T('upcoming')}</h3>
      ${upcoming.length
        ? upcoming.map((m) => `<button class="matchrow" data-act="openmatch:${m.id}">
            <span class="dt">${shortDate(m.kickoff)}</span>
            <span class="opp">${esc(m.opponent || '—')}</span>
            <span style="color:var(--ink3);font-size:17px;line-height:1">›</span>
          </button>`).join('')
        : `<div class="muted">${T('noUpcoming')}</div>`}
      <button class="btn wide" style="margin-top:12px" data-act="newmatch">+ ${T('planAnother')}</button>
    </div>`;
}

function newMatchForm(onlyOption = false) {
  return `<div class="card">
    <h3>${T('newMatch')}</h3>
    <form id="matchform">
      <div class="field"><label>${T('opponent')}</label>
        <input name="opponent" required placeholder="Lunds BK" autocomplete="off"></div>
      <div class="field"><label>${T('kickoff')} <span style="color:var(--ink3);font-weight:400">(${T('optional')})</span></label>
        <div class="dtwrap"><input name="kickoff" type="date"></div></div>
      <div class="rowline">
        <div class="field"><label>${T('periods')}</label>
          <input name="periods" type="number" min="1" max="6" value="3" inputmode="numeric"></div>
        <div class="field"><label>${T('minutesEach')}</label>
          <input name="minutes" type="number" min="5" max="45" value="20" inputmode="numeric"></div>
      </div>
      <div class="field"><label>${T('teamForMatch')}</label>
        <select name="teamid">${teams().map((tm) => `<option value="${tm.id}">${esc(tm.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${T('blockLength')}</label>
        <select name="block">
          <option value="7" selected>${T('block7')}</option>
          <option value="5">${T('block5')}</option>
          <option value="10">${T('block10')}</option>
        </select></div>
      <div class="rowline" style="margin-top:4px">
        ${onlyOption ? '' : `<button class="btn wide" data-act="cancelnew">${T('cancel')}</button>`}
        <button class="btn primary" data-act="creatematch">${T('createMatch')}</button>
      </div>
    </form>
  </div>`;
}

function squadCard() {
  const players = roster();
  const rows = players.length
    ? players.map((p) => `<div class="matchrow">
        <span style="font:600 12px/1 var(--num);color:var(--ink3);width:26px">${esc(p.no || '')}</span>
        <span class="opp">${esc(p.name)}</span>
        <button class="chip period" data-act="delplayer:${p.id}">${T('deletePlayer')}</button>
      </div>`).join('')
    : `<div class="muted">${T('rosterEmpty')}</div>`;

  return `<div class="card">
      <h3>${T('tabSquad')}</h3>
      ${rows}
      <form id="playerform" style="margin-top:12px">
        <div class="rowline">
          <div class="field" style="flex:2"><label>${T('playerName')}</label>
            <input name="name" required autocomplete="off" placeholder="Leo"></div>
          <div class="field" style="flex:1"><label>${T('shirtNo')}</label>
            <input name="no" type="number" min="1" max="99" inputmode="numeric" placeholder="4"></div>
        </div>
        <button class="btn wide" data-act="addplayer">${T('addPlayer')}</button>
      </form>
    </div>
    <div class="card">
      <h3>${T('clubName')}</h3>
      <form id="teamform">
        <div class="field"><label>${T('clubName')}</label>
          <input name="teamname" value="${esc(s.team?.name || '')}" placeholder="Uppåkra P16" autocomplete="off"></div>
        <button class="btn wide" data-act="saveteam">${T('save')}</button>
      </form>
    </div>`;
}

function historyCard() {
  const all = store.listMatches().filter((m) => m.status === 'final');
  if (!all.length) return `<div class="empty">${T('noMatches')}</div>`;
  return `<div class="card"><h3>${T('tabHistory')}</h3>${all.slice().reverse().map((m) => {
    const evs = store.loadEvents(m.id);
    const p = project(evs, m, Date.now());
    return `<div class="matchrow">
      <span class="dt">${esc((m.kickoff || '').slice(5)) || '—'}</span>
      <span class="opp">${esc(m.opponent || '—')}</span>
      <span class="sc">${p.score.for}–${p.score.against}</span>
    </div>`;
  }).join('')}</div>`;
}

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

function viewPlan() {
  const c = config();
  const blocks = blockLayout(c);
  const pool = squad();
  const f = planForecast(s.plan, c, pool);
  const cellAt = (bi, slot) => s.plan.find((x) => x.blockIndex === bi && x.slot === slot)?.playerId;

  // One table per period: positions are rows, the period's time blocks are columns.
  const tables = [];
  for (let period = 1; period <= c.periodCount; period++) {
    const list = blocks.filter((b) => b.period === period);
    if (!list.length) continue;
    const span = `${list[0].label.split('–')[0]}–${list[list.length - 1].label.split('–')[1]}`;

    const head = `<tr><th></th>${list.map((b) => `<th>${b.label}</th>`).join('')}</tr>`;
    const rows = SLOTS.map((slot) => `<tr>
        <td class="lbl">${P(slot)}</td>
        ${list.map((b) => {
          const pid = cellAt(b.blockIndex, slot);
          return `<td class="cell${pid ? '' : ' empty'}${pid && slot === 'G' ? ' gk' : ''}"
            data-act="cell:${b.blockIndex}:${slot}">${pid ? esc(player(pid).name) : '+'}</td>`;
        }).join('')}
      </tr>`).join('');

    const benchRow = `<tr class="bench">
        <td class="lbl">${T('benchShort')}</td>
        ${list.map((b) => {
          const used = new Set(s.plan.filter((x) => x.blockIndex === b.blockIndex).map((x) => x.playerId));
          const rest = pool.filter((pl) => !used.has(pl.id));
          return `<td class="cell">${rest.length ? rest.map((r) => esc(r.name)).join(', ') : '—'}</td>`;
        }).join('')}
      </tr>`;

    tables.push(`<div class="phead2">${T('periodN', { n: period }).toUpperCase()}<span>${span}</span></div>
      <div class="ptable"><table>${head}${rows}${benchRow}</table></div>`);
  }

  const forecast = Object.values(f.players)
    .sort((a, b2) => b2.minMs - a.minMs)
    .map((pl) => `<div class="ln"><span class="nm2">${esc(player(pl.id).name)}</span>
      <span class="track"><i class="${pl.minMs >= 46 * MIN ? 'hi' : ''}" style="width:${(pl.minMs / (c.periodCount * c.periodMinutes * MIN) * 100).toFixed(1)}%"></i></span>
      <span class="v">${fmtMin(pl.minMs)}</span>
      <span class="g">${pl.gkMs ? fmtMin(pl.gkMs) : '—'}</span></div>`).join('');

  const err = f.errors[0];
  const errHtml = err ? `<div class="err">${err.kind === 'empty_slots'
    ? T('emptySlot', { block: err.blockIndex + 1, slot: err.missing?.map(P).join(', ') })
    : T('doubleBooked', { block: (err.blockIndex ?? 0) + 1, name: player(err.playerId).name })}</div>` : '';

  const squadBar = `<div class="squadbar">
      <div class="squadhead"><span>${T('squadTitle')}</span>
        <span>${T('squadOf', { n: pool.length, total: teamRoster().length })}</span></div>
      <div class="chiprow">${teamRoster().map((pl) => `<button
          class="tog ${inSquad(pl.id) ? 'on' : 'off'}" data-act="togplayer:${pl.id}">${esc(pl.name)}</button>`).join('')}</div>
    </div>`;

  return headerPlain(`${T('plan')} · ${esc(s.team.name)} · ${c.periodCount} × ${c.periodMinutes}`,
    s.match?.opponent || '',
    `<button class="chip period" data-act="saveplan">${T('save')}</button>`)
    + `<div class="view">
      ${errHtml}
      ${squadBar}
      ${tables.join('')}
      <div class="fc">
        <div class="hd"><span>${T('forecast')}</span><span>${T('min')} · ${P('G')}</span></div>
        ${forecast || `<div class="ln"><span class="nm2"></span><span class="muted">—</span></div>`}
        <div class="sum"><span>Σ ${fmtMin(f.totalMs)} / ${fmtMin(f.expectedMs)}</span>
          <span>${T('spread')} ${fmtMin(f.spreadMs)}</span></div>
      </div>
      <div class="note">${T('tapEmptyCell')}</div>
      <div style="padding:0 12px 22px">
        <button style="color:var(--red);font-size:12px;text-decoration:underline;padding:8px 0"
          data-act="deletematch">${T('deleteMatch')}</button>
      </div>
    </div>
    <div class="actions">
      <button class="btn wide" data-act="autoplan">${T('autoFill')}</button>
      <button class="btn primary" data-act="startmatch">${T('startMatch')}</button>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

function blockStrip(p) {
  const c = config();
  const blocks = blockLayout(c).filter((b) => b.period === p.period);
  const cur = blocks.findIndex((b) => p.clockMs >= b.startMs && p.clockMs < b.startMs + b.lengthMs);
  return `<div class="blocks">${blocks
    .map((b, i) => `<div class="blk${i === cur ? ' on' : ''}">${b.label}</div>`).join('')}</div>`;
}

function playerRow(p, { slot, playerId, minMs }, bench = false) {
  const pl = player(playerId);
  const goal = bench ? '' : `<button class="rbtn goal" data-act="goal:${playerId}" aria-label="${T('goal')}">⚽</button>`;
  return `<div class="row${slot === 'G' ? ' keeper' : ''}">
    <span class="slot"${bench ? ' style="color:#bcb5a8"' : ''}>${bench ? '·' : P(slot)}</span>
    <button class="nm" data-act="player:${playerId}">${esc(pl.name)}<span class="no">${esc(pl.no)}</span></button>
    <span class="min">${fmtMin(minMs)}</span>
    ${goal}
    <button class="rbtn" data-act="sub:${playerId}" aria-label="${T('sub')}">⇄</button>
  </div>`;
}

function viewLive() {
  const p = proj();
  const c = config();
  const on = onFieldList(p).map((x) => playerRow(p, x));
  const bench = benchList(p, squad()).map((x) =>
    playerRow(p, { slot: null, playerId: x.id, minMs: x.minMs }, true));

  return headerLive(p)
    + `<div class="view">
        ${blockStrip(p)}
        <div class="sechead"><span>${T('onField')} (${on.length})</span><span>${T('min')}</span></div>
        <div class="list">${on.join('') || `<div class="empty">${T('noMatch')}</div>`}</div>
        <div class="sechead"><span>${T('bench')} (${bench.length})</span><span>${T('min')}</span></div>
        <div class="list">${bench.join('') || '<div class="empty">—</div>'}</div>
      </div>
      ${actionBar(p, c)}`;
}

function actionBar(p, c) {
  const lastPeriod = p.period >= c.periodCount;

  if (p.state === 'idle' || p.state === 'ended') {
    const next = p.state === 'idle' ? p.period : p.period + 1;
    if (p.state === 'ended' && lastPeriod) {
      return `<div class="actions">
        <button class="btn start" data-act="finalize">${T('fullTime')}</button>
        <button class="btn undo" data-act="undo:last">⟲</button>
      </div>`;
    }
    return `<div class="actions">
      <button class="btn start" data-act="clock:start">${T('startPeriod', { n: next })}</button>
      ${p.state === 'ended' ? `<button class="btn goala" data-act="theirgoal">${T('theirGoal')}</button>` : ''}
      <button class="btn undo" data-act="undo:last">⟲</button>
    </div>`;
  }

  const stop = p.state === 'running'
    ? `<button class="btn stop" data-act="clock:stop"><span class="ico">❚❚</span>${T('stop')}</button>`
    : `<button class="btn start" data-act="clock:start"><span class="ico">▶</span>${T('start')}</button>`;

  return `<div class="actions">
    ${stop}
    <button class="btn goala" data-act="theirgoal">${T('theirGoal')}</button>
    <button class="btn undo" data-act="undo:last">⟲</button>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Sheets
 * ------------------------------------------------------------------ */

function gridOf(items) {
  return `<div class="grid2">${items.map(({ slot, id, right, cur }) => `
    <button class="gbtn${cur ? ' cur' : ''}" data-act="${cur ? 'noop' : `pick:${id}`}">
      <span class="sl">${slot ? P(slot) : ''}</span>${esc(player(id).name)}
      <span class="no">${right ?? ''}</span>
    </button>`).join('')}</div>`;
}

/** Read-only view of the plan, from inside a live match. */
function planSheetHtml() {
  const c = config();
  const p = proj();
  const blocks = blockLayout(c);
  const out = [];

  for (let period = 1; period <= c.periodCount; period++) {
    const list = blocks.filter((b) => b.period === period);
    if (!list.length) continue;
    const span = `${list[0].label.split('–')[0]}–${list[list.length - 1].label.split('–')[1]}`;

    // Periods you have already left collapse to a single line: they take up
    // height and you can't act on them.
    if (period !== p.period) {
      const done = period < p.period;
      out.push(`<div class="pcoll"><span>${T('periodN', { n: period })}${done ? ` · ${T('played')}` : ''}</span>
        <span class="r">${done ? '✓' : T('blocksN', { n: list.length })}</span></div>`);
      continue;
    }

    const cur = list.find((b) => p.clockMs >= b.startMs && p.clockMs < b.startMs + b.lengthMs) || list[0];
    const isNow = (b) => b.blockIndex === cur.blockIndex;

    const head = `<tr><th></th>${list.map((b) => `<th class="${isNow(b) ? 'now' : ''}">${b.label}${
      isNow(b) ? `<span class="nowl">${T('now')}</span>` : ''}</th>`).join('')}</tr>`;

    const rows = SLOTS.map((slot) => `<tr>
        <td class="lbl">${P(slot)}</td>
        ${list.map((b) => {
          const pid = planCell(b.blockIndex, slot);
          const gk = pid && slot === 'G' ? ' gk' : '';
          return `<td class="cell${pid ? '' : ' empty'}${gk}${isNow(b) ? ' now' : ''}">${
            pid ? esc(player(pid)?.name || '—') : '+'}</td>`;
        }).join('')}
      </tr>`).join('');

    const benchRow = `<tr class="bench">
        <td class="lbl">${T('benchShort')}</td>
        ${list.map((b) => {
          const used = new Set(s.plan.filter((x) => x.blockIndex === b.blockIndex).map((x) => x.playerId));
          const rest = teamRoster().filter((pl) => !used.has(pl.id));
          return `<td class="cell${isNow(b) ? ' now' : ''}">${
            rest.length ? rest.map((r) => esc(r.name)).join(', ') : '—'}</td>`;
        }).join('')}
      </tr>`;

    out.push(`<div class="phead2">${T('periodN', { n: period }).toUpperCase()}<span>${span}</span></div>
      <div class="ptable"><table>${head}${rows}${benchRow}</table></div>`);
  }

  return `<div class="scrim" data-act="sheet:close"></div>
    <div class="sheet tall">
      <div class="grab"></div>
      <h2>${T('plan')}<span class="when">${T('periodN', { n: p.period })} · ${mmss(p.clockMs)}</span></h2>
      <div class="psub">${esc(s.team.name)} · ${c.periodCount} × ${c.periodMinutes} · ${T('readOnlyPlay')}</div>
      <div class="pbody">${out.join('')}
        <div class="plegend"><span class="sw"></span>${T('youAreHere')}</div>
      </div>
      <button class="sheetclose" data-act="sheet:close">${T('close')}</button>
    </div>`;
}

function renderSheet() {
  const p = proj();
  const sh = s.sheet;
  if (sh.kind === 'planview') return planSheetHtml();
  const when = `<span class="when">${T('periodN', { n: p.period })} · ${mmss(p.clockMs)}</span>`;
  const onIds = Object.values(p.onField).filter(Boolean);
  const close = `<button class="sheetclose" data-act="sheet:close">${T('cancel')}</button>`;

  if (sh.kind === 'assist') {
    const others = onIds.filter((id) => id !== sh.playerId);
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${T('goal')}${when}</h2>
      <div class="picked">⚽ ${esc(player(sh.playerId).name)}
        <span class="no">${esc(player(sh.playerId).no)}</span>
        <button class="chg" data-act="sheet:close">${T('change')}</button></div>
      <div class="q">${T('assistQ')}</div>
      <div class="qsub">${T('assistHint')}</div>
      <div class="grid2">${others.map((id) => `<button class="gbtn" data-act="assist:${id}">
        <span class="sl">${P(slotOfPlayer(p, id))}</span>${esc(player(id).name)}
        <span class="no">${esc(player(id).no)}</span></button>`).join('')}</div>
      <button class="noassist" data-act="assist:none">${T('noAssist')}</button>
    </div>`;
  }

  if (sh.kind === 'subOut' || sh.kind === 'subIn') {
    const isOut = sh.kind === 'subOut';
    const pl = player(sh.playerId);
    const slot = slotOfPlayer(p, sh.playerId);
    const list = isOut
      ? benchList(p, squad()).map((x) => ({ slot: null, id: x.id, right: fmtMin(x.minMs) }))
      : onIds.map((id) => ({ slot: slotOfPlayer(p, id), id, right: fmtMin(p.players[id]?.playMs || 0) }));
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${T('sub')}${when}</h2>
      <div class="picked${isOut ? ' off' : ''}">⇄ ${esc(pl.name)}<span class="no">${esc(pl.no)}</span>
        <span class="chg">${[slot ? P(slot) : '', fmtMin(p.players[sh.playerId]?.playMs || 0)].filter(Boolean).join(' · ')}
        ${isOut ? T('goingOff') : T('comingOn')}</span></div>
      <div class="q">${isOut ? T('whoComesOn') : T('whoComesOff')}</div>
      <div class="grid2">${list.map(({ slot: sl, id, right }) => `
        <button class="gbtn" data-act="subpick:${id}">
          <span class="sl">${sl ? P(sl) : ''}</span>${esc(player(id).name)}
          <span class="no">${right}</span></button>`).join('')}</div>
      ${close}
    </div>`;
  }

  if (sh.kind === 'player') {
    const pl = player(sh.playerId);
    const onField = onIds.includes(sh.playerId);
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${T('player')}${when}</h2>
      <div class="picked" style="background:#f6f3ee;color:var(--ink)">
        ${esc(pl.name)}<span class="no">${esc(pl.no)}</span>
        <span class="chg">${onField ? P(slotOfPlayer(p, sh.playerId)) : T('bench')} ·
          ${fmtMin(p.players[sh.playerId]?.playMs || 0)}</span></div>
      <div class="pacts">
        ${onField ? `<button class="pact" data-act="goal:${sh.playerId}"><span class="i">⚽</span>${T('logGoal')}</button>
        <button class="pact" data-act="sub:${sh.playerId}"><span class="i">⇄</span>${T('subOff')}</button>
        <button class="pact" data-act="position:${sh.playerId}"><span class="i">↗</span>${T('changePosition')}</button>`
        : `<button class="pact" data-act="sub:${sh.playerId}"><span class="i">⇄</span>${T('subOn')}</button>`}
      </div>
      ${close}
    </div>`;
  }

  if (sh.kind === 'position') {
    const items = SLOTS.map((sl) => {
      const occupant = p.onField[sl];
      return { slot: sl, id: sh.playerId === occupant ? sh.playerId : occupant, right: '',
        cur: sl === slotOfPlayer(p, sh.playerId) };
    }).filter((x) => x.id);
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${T('changePosition')}${when}</h2>
      <div class="picked" style="background:#f6f3ee;color:var(--ink)">${esc(player(sh.playerId).name)}
        <span class="no">${esc(player(sh.playerId).no)}</span>
        <span class="chg">${T('currentlyAt', { slot: P(slotOfPlayer(p, sh.playerId)) })}</span></div>
      <div class="q">${T('moveTo')}</div>
      <div class="grid2">${items.map(({ slot: sl, id, cur }) => `
        <button class="gbtn${cur ? ' cur' : ''}" data-act="${cur ? 'noop' : `moveto:${sl}`}">
          <span class="sl">${P(sl)}</span>${esc(player(id).name)}
          <span class="no">${fmtMin(p.players[id]?.playMs || 0)}</span></button>`).join('')}</div>
      ${close}
    </div>`;
  }

  if (sh.kind === 'cell') {
    const taken = new Set(s.plan.filter((x) => x.blockIndex === sh.blockIndex).map((x) => x.playerId));
    const items = squad().map((pl) => ({
      slot: null, id: pl.id, right: esc(pl.no), cur: false,
    }));
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${P(sh.slot)} · ${T('periodN', { n: Math.floor(sh.blockIndex / (blockLayout(config()).length / config().periodCount)) + 1 })}</h2>
      <div class="q">${T('player')}</div>
      <div class="grid2">${items.map(({ id, right }) => `
        <button class="gbtn" data-act="setcell:${id}">
          <span class="sl"></span>${esc(player(id).name)}<span class="no">${right}</span>
          ${taken.has(id) ? '<span class="no" style="margin-left:6px">●</span>' : ''}
        </button>`).join('')}</div>
      <button class="noassist" data-act="setcell:none">—</button>
    </div>`;
  }

  if (sh.kind === 'period') {
    const last = p.period >= config().periodCount;
    const running = p.state === 'running' || p.state === 'paused';
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${T('periodN', { n: p.period })}<span class="when">${T('period')} ${p.period}/${config().periodCount}</span></h2>
      <div class="q">${mmss(p.clockMs)} <span style="color:var(--ink3);font-weight:500">/ ${config().periodMinutes}:00</span></div>
      <div class="pacts">
        ${running ? `<button class="pact" data-act="endperiod"><span class="i">⏹</span>${T('endPeriod')}</button>` : ''}
        <button class="pact" data-act="clockadjust"><span class="i">🕐</span>${T('adjustClock')}</button>
        <button class="pact" data-act="finalize"><span class="i">🏁</span>${T('endMatch')}</button>
      </div>
      ${close}
    </div>`;
  }

  if (sh.kind === 'clock') {
    const cur = Math.round(p.clockMs / MIN);
    return `<div class="scrim" data-act="sheet:close"></div><div class="sheet">
      <div class="grab"></div><h2>${T('adjustClock')}${when}</h2>
      <div class="q">${mmss(p.clockMs)} / ${config().periodMinutes}:00</div>
      <div class="grid2" style="grid-template-columns:1fr 1fr 1fr">
        <button class="gbtn" data-act="adjust:${cur - 1}">−1:00</button>
        <button class="gbtn" data-act="adjust:${cur + 1}">+1:00</button>
        <button class="gbtn" data-act="adjust:${config().periodMinutes}">${config().periodMinutes}:00</button>
      </div>
      <div class="setexact">
        <input name="exactmin" type="number" min="0" max="120" step="1" value="${cur}" inputmode="numeric">
        <button data-act="setexact">${T('setExact')}</button>
      </div>
      ${close}
    </div>`;
  }

  return '';
}

function slotOfPlayer(p, id) {
  return Object.keys(p.onField).find((sl) => p.onField[sl] === id) || null;
}

/* ------------------------------------------------------------------ *
 * Recap
 * ------------------------------------------------------------------ */

function recapText() {
  const p = proj();
  const goals = p.timeline.filter((e) => e.type === 'goal_for');
  const lines = [`${s.team.name} – ${s.match.opponent || ''}  ${p.score.for}–${p.score.against}`];
  if (goals.length) {
    lines.push(goals.map((g) => {
      const who = player(g.payload.scorer).name;
      const a = g.payload.assist ? ` (${player(g.payload.assist).name})` : '';
      return `${mmss(g.clockMs || 0)} ${who}${a}`;
    }).join(', '));
  }
  const mins = Object.values(p.players)
    .sort((x, y) => y.playMs - x.playMs)
    .map((x) => `${player(x.id).name} ${fmtMin(x.playMs)}`);
  lines.push(mins.join(' · '));
  return lines.join('\n');
}

function viewRecap() {
  const p = proj();
  const goals = p.timeline.filter((e) => e.type === 'goal_for');
  const mins = Object.values(p.players).sort((a, b) => b.playMs - a.playMs);
  const expected = 7 * config().periodCount * config().periodMinutes * MIN;
  const total = mins.reduce((a, x) => a + x.playMs, 0);
  const balanced = Math.abs(total - expected) < MIN * 0.15;

  const goalRows = goals.map((g) => `<div class="matchrow">
      <span class="dt">${mmss(g.clockMs || 0)}</span>
      <span class="opp">${esc(player(g.payload.scorer).name)}
        ${g.payload.assist ? `<span class="muted">← ${esc(player(g.payload.assist).name)}</span>` : ''}</span>
    </div>`).join('');

  const minRows = mins.map((x) => `<div class="ln">
      <span class="nm2">${esc(player(x.id).name)}</span>
      <span class="track"><i class="${x.playMs >= 46 * MIN ? 'hi' : ''}" style="width:${(x.playMs / (config().periodCount * config().periodMinutes * MIN) * 100).toFixed(1)}%"></i></span>
      <span class="v">${fmtMin(x.playMs)}</span>
    </div>`).join('');

  return headerPlain(T('recap'), s.match?.opponent || '', `<span class="chip period">${T('fullTime')}</span>`)
    + `<div class="view">
      <div class="setup" style="gap:10px">
        <div class="card">
          <h3>${T('finalScore')}</h3>
          <div style="font:700 34px/1 var(--num)">${p.score.for}<span style="color:var(--ink3)">–</span>${p.score.against}</div>
        </div>
        ${goals.length ? `<div class="card"><h3>${T('goals')}</h3>${goalRows}</div>` : ''}
        <div class="card"><h3>${T('minutes')}</h3>
          <div class="fc" style="margin:0;border:0">${minRows}</div>
          <div class="note" style="margin:8px 0 0">Σ ${fmtMin(total)} = 7 × ${config().periodCount * config().periodMinutes}
            <span style="color:${balanced ? 'var(--green)' : 'var(--red)'}">${balanced ? '✔' : '≠'}</span></div>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn wide" data-act="done">${T('done')}</button>
      <button class="btn primary" data-act="share">${T('share')}</button>
    </div>`;
}

async function share() {
  const text = recapText();
  try {
    if (navigator.share) await navigator.share({ text });
    else if (navigator.clipboard) { await navigator.clipboard.writeText(text); showToast('✓ copied', null); }
  } catch { /* user cancelled */ }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function createMatch(form) {
  const f = new FormData(form);
  const m = {
    id: uid(),
    opponent: String(f.get('opponent') || '').trim() || '—',
    kickoff: String(f.get('kickoff') || ''),
    periodCount: Math.max(1, Math.min(6, Number(f.get('periods')) || 3)),
    periodMinutes: Math.max(5, Math.min(45, Number(f.get('minutes')) || 20)),
    blockMinutes: Number(f.get('block')) || 7,
    teamId: String(f.get('teamid') || teams()[0]?.id || ''),
    status: 'setup',
    createdAt: new Date().toISOString(),
  };
  s.match = m;
  s.plan = [];
  s.events = [];
  s.creating = false;
  saveMatch(m);
  store.savePlan(m.id, []);
  s.route = 'plan';
  render();
}

function addPlayer(form) {
  const f = new FormData(form);
  const name = String(f.get('name') || '').trim();
  if (!name) return;
  const no = String(f.get('no') || '').trim();
  s.team.players.push({ id: uid(), name, no });
  store.saveTeam(s.team);
  form.reset();
  render();
}

function saveTeamForm(form) {
  const f = new FormData(form);
  const name = String(f.get('teamname') || '').trim();
  if (name) s.team.name = name;
  store.saveTeam(s.team);
  render();
}

/** The master list of kids, added once. */
function roster() {
  return s.team?.players || [];
}

function teams() {
  return store.loadTeams();
}

function teamById(id) {
  return teams().find((t) => t.id === id) || null;
}

function saveTeamsList(list) {
  store.saveTeams(list);
}

/** The squad a team brings: roster members picked into this match's team. */
function teamRoster() {
  const t = teamById(s.match?.teamId);
  if (!t) return roster();
  return roster().filter((p) => t.playerIds.includes(p.id));
}

/** Who is actually here today: the team minus this match's absences. */
function inSquad(id) {
  return !(s.match?.unavailable || []).includes(id);
}

function squad() {
  return teamRoster().filter((p) => inSquad(p.id));
}

/** Plan cells and availability must not reference a kid who left the roster. */
function purgePlayer(id) {
  s.team.players = roster().filter((p) => p.id !== id);
  store.saveTeam(s.team);
  if (s.match) {
    if (Array.isArray(s.match.unavailable)) {
      s.match.unavailable = s.match.unavailable.filter((x) => x !== id);
    }
    s.plan = s.plan.filter((c) => c.playerId !== id);
    store.savePlan(s.match.id, s.plan);
    saveMatch();
  }
}

function ensureTeam() {
  if (!s.team) s.team = { id: uid(), name: '', players: [] };
  if (!s.team.players) s.team.players = [];
  return s.team;
}

function autoPlan() {
  const c = config();
  const blocks = blockLayout(c);
  const players = squad();
  if (!players.length) return;
  const keeper = players.find((p) => (p.pref || '').includes('G')) || players[0];
  const outfield = players.filter((p) => p.id !== keeper.id);
  if (!outfield.length) return;

  const cells = [];
  let idx = 0;
  for (const b of blocks) {
    cells.push({ blockIndex: b.blockIndex, slot: 'G', playerId: keeper.id });
    for (const slot of ['LB', 'RB', 'LM', 'MM', 'RM', 'F']) {
      cells.push({ blockIndex: b.blockIndex, slot, playerId: outfield[idx % outfield.length].id });
      idx++;
    }
  }
  s.plan = cells;
  store.savePlan(s.match.id, s.plan);
  render();
}

function startMatch() {
  if (!s.match) return;
  if (squad().length < SLOTS.length) {
    showToast(`⚠ ${T('squadOf', { n: squad().length, total: roster().length })}`, null);
    return;
  }
  if (!s.plan.length) autoPlan();
  const first = blockLayout(config())[0];
  const assignments = {};
  for (const cell of s.plan.filter((x) => x.blockIndex === first.blockIndex)) {
    assignments[cell.slot] = cell.playerId;
  }
  if (Object.keys(assignments).length !== SLOTS.length) {
    s.sheet = { kind: 'cell', blockIndex: 0, slot: 'G' };
    showToast('⚠ ' + T('emptySlot', { block: 1, slot: P('G') }), null);
    return;
  }
  s.match.status = 'live';
  saveMatch();
  act('lineup', { assignments }, { silent: true });
  act('period_start', { period: 1 }, { silent: true });
  s.route = 'live';
  render();
}

function handle(ev) {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const [action, a, b] = el.dataset.act.split(':');
  const p = proj();
  const form = el.closest('form');

  switch (action) {
    case 'noop': return;

    case 'tab': s.tab = a; render(); return;
    case 'lang': switchLang(); return;
    case 'nav': s.route = a === 'plan' ? 'plan' : null; render(); return;
    case 'home': s.route = 'home'; s.tab = 'match'; s.sheet = null; render(); return;
    case 'resume': {
      const live = store.listMatches().find((m) => m.status === 'live');
      if (live) selectMatch(live);
      s.route = 'live'; s.sheet = null; render(); return;
    }
    case 'openmatch': {
      const m = store.listMatches().find((x) => x.id === a);
      if (m) { selectMatch(m); s.route = 'plan'; }
      render(); return;
    }
    case 'newmatch': s.creating = true; s.route = null; render(); return;
    case 'goto': s.tab = a; s.creating = false; render(); return;

    case 'newteam':
      s.editingTeam = { id: uid(), name: '', playerIds: [], isNew: true };
      s.route = 'team'; render(); return;
    case 'openteam': {
      const t = teamById(a);
      if (t) { s.editingTeam = { ...t, playerIds: [...t.playerIds] }; s.route = 'team'; }
      render(); return;
    }
    case 'togmember': {
      const t = s.editingTeam;
      // Typing then tapping a player must not lose the name: capture it first,
      // because the editor re-renders from state.
      const input = document.querySelector('#teamnameform [name="teamname"]');
      if (input) t.name = input.value;
      t.playerIds = t.playerIds.includes(a) ? t.playerIds.filter((x) => x !== a) : [...t.playerIds, a];
      render(); return;
    }
    case 'saveteam2': {
      const t = s.editingTeam;
      const input = document.querySelector('#teamnameform [name="teamname"]');
      const name = (input?.value || '').trim() || T('newTeam');
      const list = teams().filter((x) => x.id !== t.id);
      list.push({ id: t.id, name, playerIds: [...t.playerIds] });
      saveTeamsList(list);
      s.editingTeam = null; s.route = null;
      showToast(`✓ ${T('saved')}`, null);
      return;
    }
    case 'deleteteam': {
      if (!confirm(T('confirmDeleteTeam'))) return;
      saveTeamsList(teams().filter((x) => x.id !== s.editingTeam.id));
      s.editingTeam = null; s.route = null; render(); return;
    }
    case 'backteam': s.editingTeam = null; s.route = null; render(); return;
    case 'cancelnew': s.creating = false; render(); return;
    case 'periodsheet': s.sheet = { kind: 'period' }; render(); return;
    case 'plansheet': s.sheet = { kind: 'planview' }; render(); return;
    case 'applyplan': {
      const nc = nextChange(p);
      if (!nc) return;
      const ids = [];
      for (const pair of nc.pairs) {
        // Re-read the pitch before each change: two planned swaps can chain.
        const cur = proj();
        const onNow = Object.keys(cur.onField).map((sl) => cur.onField[sl]).filter(Boolean);
        if (!onNow.includes(pair.off) || onNow.includes(pair.on)) continue;
        const slot = Object.keys(cur.onField).find((sl) => cur.onField[sl] === pair.off) || pair.slot;
        const ev = act('sub', { off: [pair.off], on: [pair.on], slots: { [pair.on]: slot } }, { silent: true });
        if (ev) ids.push(ev.id);
      }
      for (const m of nc.moves) {
        const cur = proj();
        const from = Object.keys(cur.onField).find((sl) => cur.onField[sl] === m.player);
        if (!from || from === m.to) continue;
        const ev = act('move', { player: m.player, from, to: m.to }, { silent: true });
        if (ev) ids.push(ev.id);
      }
      if (ids.length) {
        const msg = ids.length === 1 ? T('appliedOne') : T('applied', { n: ids.length });
        showToast(`✓ ${msg}`, ids);
      }
      s.sheet = null;
      render(); return;
    }
    case 'clockadjust': s.sheet = { kind: 'clock' }; render(); return;
    case 'endperiod': {
      act('period_end', { period: p.period });
      s.sheet = null; render(); return;
    }
    case 'done': s.route = 'setup'; s.sheet = null; render(); return;
    case 'sheet': s.sheet = null; render(); return;

    case 'creatematch': if (form) createMatch(form); return;
    case 'addplayer': if (form) addPlayer(form); return;
    case 'saveteam': if (form) saveTeamForm(form); return;
    case 'saveplan': {
      saveMatch();
      s.route = null;
      showToast(`✓ ${T('saved')}`, null);
      return;
    }
    case 'togplayer': {
      const list = Array.isArray(s.match.unavailable) ? s.match.unavailable : [];
      const nowOut = !list.includes(a);
      s.match.unavailable = nowOut ? [...list, a] : list.filter((x) => x !== a);
      if (nowOut) {
        // A kid who is not here cannot be in the plan.
        s.plan = s.plan.filter((c) => c.playerId !== a);
        store.savePlan(s.match.id, s.plan);
      }
      saveMatch();
      render(); return;
    }
    case 'delplayer': purgePlayer(a); render(); return;
    case 'deletematch': {
      if (!confirm(T('confirmDelete'))) return;
      store.deleteMatch(s.match.id);
      s.match = null; s.events = []; s.plan = []; s.route = null; render(); return;
    }

    case 'autoplan': autoPlan(); return;
    case 'startmatch': startMatch(); return;
    case 'finalize': {
      if (!confirm(T('confirmEnd'))) return;
      act('finalize', {}, { silent: true });
      s.match.status = 'final'; saveMatch();
      s.route = 'recap'; s.sheet = null; render(); return;
    }

    case 'clock': {
      if (a === 'start') {
        if (p.state === 'idle' || p.state === 'ended') {
          act('period_start', { period: p.state === 'idle' ? p.period : p.period + 1 }, { silent: true });
        } else {
          act('clock_start', { period: p.period }, { silent: true });
        }
      } else if (a === 'stop') {
        act('clock_stop', { period: p.period }, { silent: true });
      }
      render(); return;
    }
    case 'setexact': {
      const el = document.querySelector('#app .setexact [name="exactmin"]');
      const mins = Math.max(0, Math.min(120, Number(el?.value) || 0));
      act('clock_adjust', { period: p.period, toMs: mins * MIN }, { silent: true });
      s.sheet = null; render(); return;
    }

    case 'adjust': {
      act('clock_adjust', { period: p.period, toMs: Math.max(0, Number(a) || 0) * MIN });
      s.sheet = null; render(); return;
    }

    case 'theirgoal': act('goal_against', {}); render(); return;

    case 'goal': s.sheet = { kind: 'assist', playerId: a }; render(); return;
    case 'assist': {
      act('goal_for', { scorer: s.sheet.playerId, assist: a === 'none' ? null : a });
      s.sheet = null; render(); return;
    }

    case 'sub': {
      const onField = Object.values(p.onField).includes(a);
      s.sheet = { kind: onField ? 'subOut' : 'subIn', playerId: a };
      render(); return;
    }
    case 'subpick': {
      const sh = s.sheet;
      const isOut = sh.kind === 'subOut';
      const off = isOut ? sh.playerId : a;
      const on = isOut ? a : sh.playerId;
      const slot = Object.keys(p.onField).find((sl) => p.onField[sl] === off);
      act('sub', { off: [off], on: [on], slots: { [on]: slot } });
      s.sheet = null; render(); return;
    }

    case 'player': s.sheet = { kind: 'player', playerId: a }; render(); return;
    case 'position': s.sheet = { kind: 'position', playerId: a }; render(); return;
    case 'moveto': {
      const sh = s.sheet;
      const from = Object.keys(p.onField).find((sl) => p.onField[sl] === sh.playerId);
      act('move', { player: sh.playerId, from, to: a });
      s.sheet = null; render(); return;
    }

    case 'cell': s.sheet = { kind: 'cell', blockIndex: Number(a), slot: b }; render(); return;
    case 'setcell': {
      const { blockIndex, slot } = s.sheet;
      s.plan = s.plan.filter((x) => !(x.blockIndex === blockIndex && (x.slot === slot || x.playerId === a)));
      if (a !== 'none') s.plan.push({ blockIndex, slot, playerId: a });
      store.savePlan(s.match.id, s.plan);
      s.sheet = null; render(); return;
    }

    case 'undo': {
      if (a === 'last') { undoLast(); return; }
      const ids = String(a).split(',').filter(Boolean);
      // Undo newest-first so the projection never sees an inconsistent log.
      for (const id of [...ids].reverse()) {
        const v = store.voidEvent(s.match.id, id);
        if (v) s.events.push(v);
      }
      s.toast = null;
      render(); return;
    }
    case 'share': share(); return;

    default: return;
  }
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

function tick() {
  if (routeNow() !== 'live') return;
  const p = proj();
  if (p.state !== 'running') return;
  const clk = document.querySelector('[data-clock]');
  if (clk) {
    const late = p.clockMs > config().periodMinutes * MIN;
    clk.classList.toggle('late', late);
    clk.innerHTML = `${mmss(p.clockMs)}<span class="of">/${config().periodMinutes}:00</span>`;
  }
  const bar = document.querySelector('[data-progress]');
  if (bar) {
    const pct = Math.min(100, (p.clockMs / (config().periodMinutes * MIN)) * 100);
    bar.querySelector('i').style.width = pct + '%';
  }
}

document.addEventListener('click', (ev) => {
  const clockEl = ev.target.closest('[data-clock]');
  if (clockEl && !ev.target.closest('[data-act]')) {
    s.sheet = { kind: 'clock' };
    render();
    return;
  }
  handle(ev);
});

// Buttons inside forms must not submit them; we read the form on demand.
document.addEventListener('submit', (e) => e.preventDefault());

/* ------------------------------------------------------------------ *
 * Demo seed — only runs with ?seed=1, so the app can be shown (and
 * screenshotted) with a realistic match without touching real data.
 * ------------------------------------------------------------------ */

function seedDemo() {
  const now = Date.now();
  const M = 60000;
  const players = [
    ['Leo', 4], ['Sam', 7], ['Noah', 2], ['Elis', 9], ['Hugo', 3],
    ['Axel', 5], ['Ville', 11], ['Omar', 8], ['Isak', 6],
  ].map(([name, no]) => ({ id: 'p' + no, name, no }));

  s.team = { id: 't1', name: 'Uppåkra P16', players };
  store.saveTeam(s.team);
  store.saveTeams([{ id: 'tm1', name: 'P16 A', playerIds: players.map((p) => p.id) }]);

  const match = {
    id: 'm1', opponent: 'Lunds BK', kickoff: new Date(now).toISOString().slice(0, 10),
    periodCount: 3, periodMinutes: 20, blockMinutes: 7, status: 'live', teamId: 'tm1',
  };
  s.match = match;
  store.saveMatch(match);

  const rows = [
    ['Leo', 'Sam', 'Noah', 'Omar', 'Hugo', 'Ville', 'Isak'],
    ['Leo', 'Noah', 'Axel', 'Omar', 'Elis', 'Ville', 'Isak'],
    ['Leo', 'Sam', 'Noah', 'Elis', 'Hugo', 'Axel', 'Ville'],
    ['Leo', 'Sam', 'Elis', 'Omar', 'Hugo', 'Axel', 'Isak'],
    ['Leo', 'Sam', 'Noah', 'Omar', 'Hugo', 'Ville', 'Isak'],
    ['Leo', 'Sam', 'Noah', 'Elis', 'Hugo', 'Axel', 'Ville'],
    ['Leo', 'Noah', 'Axel', 'Omar', 'Elis', 'Ville', 'Isak'],
    ['Leo', 'Sam', 'Elis', 'Omar', 'Hugo', 'Axel', 'Isak'],
    ['Leo', 'Sam', 'Noah', 'Elis', 'Hugo', 'Axel', 'Ville'],
  ];
  const slots = ['G', 'LB', 'RB', 'LM', 'MM', 'RM', 'F'];
  const byName = Object.fromEntries(players.map((p) => [p.name, p.id]));
  s.plan = [];
  rows.forEach((row, blockIndex) => row.forEach((nm, i) => {
    s.plan.push({ blockIndex, slot: slots[i], playerId: byName[nm] });
  }));
  store.savePlan(match.id, s.plan);

  const t0 = now - 27.2 * M;
  let n = 0;
  const ev = (type, at, payload = {}) => ({
    id: 'seed' + (++n), type, atMs: at, clockMs: null, payload, author: 'coach',
  });
  const assignments = {};
  slots.forEach((sl, i) => { assignments[sl] = byName[rows[0][i]]; });

  const events = [
    ev('lineup', t0 - 1000, { assignments }),
    ev('period_start', t0, { period: 1 }),
    ev('goal_for', t0 + 6 * M, { scorer: byName.Ville, assist: byName.Omar }),
    ev('sub', t0 + 7 * M, { off: [byName.Isak], on: [byName.Elis], slots: { [byName.Elis]: 'F' } }),
    ev('sub', t0 + 14 * M, { off: [byName.Hugo], on: [byName.Axel], slots: { [byName.Axel]: 'MM' } }),
    ev('period_end', t0 + 20 * M, { period: 1 }),
    ev('period_start', now - 7.2 * M, { period: 2 }),
    ev('goal_against', now - 5 * M, {}),
    ev('goal_for', now - 3 * M, { scorer: byName.Omar, assist: byName.Axel }),
  ];
  store.appendEvents(match.id, events);
  s.events = events;
}

boot();
ensureTeam();
if (new URLSearchParams(location.search).get('seed') === '1') { seedDemo(); }
// First run: land where the work is, not on an empty tab.
if (!s.team.players.length) s.tab = 'squad';
// ?seed=1&plan=1 lands on the planner with the demo squad already planned
if (new URLSearchParams(location.search).get('plan') === '1' && s.match) {
  s.match.status = 'setup';
  s.route = 'plan';
}
render();
setInterval(tick, 250);

// Re-project when the tab wakes: the clock is wall-clock derived.
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
