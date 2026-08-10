/**
 * The rules both ends of the game have to agree about.
 *
 * The server settles matches rather than trusting posted totals, so it needs
 * the same arithmetic the client runs. This module is the seam: it re-exports
 * exactly the pure, environment-free pieces of that arithmetic, and
 * `scripts/build-rules.mjs` bundles it into `server/rules.mjs`.
 *
 * Nothing may be exported from here that touches `localStorage`, `document` or
 * the DOM. `readCareer` and `storeCareer` are deliberately absent for that
 * reason — the server has its own store, and the browser keeps its own copy.
 */

export {
  MAX_TOUCHES,
  SETS_TO_WIN,
  WIN_SCORE,
  CHARACTERS,
  type CharacterDef,
} from "./config";

export {
  ALL_CHALLENGES,
  DAILY_COUNT,
  creditFor,
  dailyChallenges,
  dayKey,
  isComplete,
  secondsUntilRollover,
  type Challenge,
  type ChallengeKind,
  type MatchTally,
} from "./challenges";

export {
  TIERS,
  coinsFor,
  nextTier,
  rankChange,
  tierFor,
  tierProgress,
  trophyDelta,
  type Difficulty,
  type Tier,
} from "./league";

export {
  MAX_LEVEL,
  STARTING_CHAMPION,
  UNLOCK_AT,
  XP_PER_LEVEL,
  buyUpgrade,
  claimChallenge,
  freshCareer,
  isUnlocked,
  levelOf,
  rollOver,
  settleMatch,
  upgradeCost,
  withCareer,
  type Career,
  type ChampionState,
  type MatchOutcome,
} from "./progress";
