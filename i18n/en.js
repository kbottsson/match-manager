/**
 * English strings. One flat key set shared by every screen.
 * Position codes and names are here too, because they are the most
 * language-specific thing in the app (LB ↔ VB).
 */
export default {
  app: 'Match Manager',

  // roles / modes
  coach: 'Coach',
  view: 'View',
  readOnly: 'Read-only. {name} is recording this match.',
  readOnlySub: 'Goals, subs and minutes stream in live.',
  takeover: 'Take over recording',
  coachOffline: 'Coach · offline',

  // clock
  period: 'Period',
  periodN: 'Period {n}',
  fullTime: 'Full time',
  start: 'Start',
  stop: 'Stop',
  startPeriod: 'Start period {n}',
  endPeriod: 'End period',
  stopped: 'Stopped',
  adjustClock: 'Adjust clock',
  setExact: 'Set exact',
  runningLate: 'Past period length',

  // match actions
  goal: 'Goal',
  theirGoal: 'Their goal',
  sub: 'Sub',
  undo: 'Undo',
  assistQ: 'Assist?',
  assistHint: 'Tap a teammate, or save without one',
  noAssist: 'No assist — save goal',
  change: 'change',
  whoComesOn: 'Who comes on?',
  whoComesOff: 'Who comes off?',
  comingOn: 'coming on',
  goingOff: 'going off',
  confirm: 'Confirm',
  cancel: 'Cancel',

  // player sheet
  player: 'Player',
  logGoal: 'Log goal',
  subOff: 'Substitute off',
  subOn: 'Substitute on',
  editMinutes: 'Edit minutes',
  changePosition: 'Change position',
  moveTo: 'Move to which slot?',
  currentlyAt: 'currently {slot}',

  // sections
  onField: 'On field',
  bench: 'Bench',
  min: 'Min',
  inGoal: 'in goal',
  plannedFor: 'planned for this block',
  nextBlock: 'Next block',

  // plan
  plan: 'Plan',
  planFor: 'Plan · {team}',
  forecast: 'Forecast',
  blockLength: 'Block length',
  block7: '7 min',
  block5: '5 min',
  block10: '10 min',
  blockThirds: '6:40',
  spread: 'spread',
  sumCheck: 'Σ {total} = 7 × {length}',
  emptySlot: 'Block {block}: empty slot {slot}',
  doubleBooked: 'Block {block}: {name} is in two slots',
  unavailable: 'Not available today',

  // recap
  recap: 'Recap',
  goals: 'Goals',
  minutes: 'Minutes',
  assists: 'Assists',
  share: 'Share recap',
  finalScore: 'Final score',

  // misc
  language: 'Svenska',
  nextChangeIn: 'Next change in', apply: 'Apply', now: 'Now',
  played: 'played', blocksN: '{n} blocks', readOnlyPlay: 'read-only during play',
  youAreHere: 'Current block', applied: '{n} changes applied',
  appliedOne: '1 change applied', close: 'Close',
  save: 'Save',
  delete: 'Delete',
  history: 'History',
  noMatches: 'No matches yet',

  tabMatch: 'Match', tabSquad: 'Roster', tabHistory: 'History', tabTeams: 'Teams',
  clubName: 'Club',
  newMatch: 'New match', opponent: 'Opponent', venue: 'Venue', kickoff: 'Date',
  periods: 'Periods', minutesEach: 'Minutes per period',
  createMatch: 'Create match', openPlan: 'Plan the match', startMatch: 'Start match',
  squadEmpty: 'No players yet. Add your squad once — it is reused every match.',
  addPlayer: 'Add player', playerName: 'Player', shirtNo: 'No.',
  teamName: 'Team name', done: 'Done', deleteMatch: 'Delete match',
  noMatch: 'No match yet', inProgress: 'In progress',
  positionPrefs: 'Preferred positions', optional: 'optional',
  deletePlayer: 'Remove', confirmDelete: 'Delete this match and its log?',
  benchShort: 'BENCH', autoFill: 'Auto-fill',
  home: 'Home', resume: 'Resume',
  upcoming: 'Upcoming', planAnother: 'Plan another match', notStarted: 'Not started',
  endMatch: 'End match', confirmEnd: 'End this match now? The clock stops and the match is closed.',
  noUpcoming: 'No matches planned.',
  squadTitle: 'Who is here today', squadOf: '{n} of {total}', saved: 'Saved',
  newTeam: 'New team', teamNameLbl: 'Team name', teamPlayers: 'Players from the roster',
  noTeams: 'No teams yet. Create one and pick players from the roster.',
  deleteTeam: 'Delete team', teamForMatch: 'Team', playersN: '{n} players',
  confirmDeleteTeam: 'Delete this team? Matches keep their history.',
  noTeamForMatch: 'Create a team first — Teams tab.',
  rosterEmpty: 'Add the kids once here — then pick who is playing each match.',
  tapEmptyCell: 'Tap a cell to place a player. The bench row shows who is sitting out that block.',

  pos: {
    G: { code: 'G', name: 'Goalie' },
    LB: { code: 'LB', name: 'Back left' },
    RB: { code: 'RB', name: 'Back right' },
    LM: { code: 'LM', name: 'Left mid' },
    MM: { code: 'MM', name: 'Mid mid' },
    RM: { code: 'RM', name: 'Right mid' },
    F: { code: 'F', name: 'Forward' },
  },
  benchTag: { code: 'BN', name: 'Bench' },
};
