/** Types for the accounts module. See the note in `store.d.mts`. */
import type { Career, MatchOutcome } from "../src/progress";
import type { SeasonEnd } from "../src/season";
import type { PlayerRecord, PlayerStore } from "./store.mjs";

export declare const NAME_MIN: number;
export declare const NAME_MAX: number;
export declare const MATCH_COOLDOWN_MS: number;
export declare const MAX_FRIENDS: number;
export declare const FORFEIT_AFTER_SETS: number;
export declare const MAX_TALLY: { points: number; sets: number; rallies: number };

export declare class ValidationError extends Error {
  constructor(message: string, status?: number);
  readonly status: number;
}

export interface PublicProfile {
  id: string;
  name: string;
  trophies: number;
  best: number;
  tier: string;
  matches: number;
  rank: number | null;
  /** A socket open right now, which is what "can I play them" really asks. */
  online: boolean;
  lastSeen: number;
}

/** A new or recovered account, with the two secrets that are only sent once. */
export interface Issued {
  player: PlayerRecord;
  token: string;
  recoveryCode: string;
}

export declare function normaliseName(
  raw: unknown,
  opts?: { min?: number; max?: number; what?: string }
): string;
export declare function publicProfile(player: PlayerRecord, rank?: number | null): PublicProfile;
export declare function privateProfile(
  store: PlayerStore,
  player: PlayerRecord,
  now?: Date
): Promise<PublicProfile & { career: Career }>;
/** Bring a career up to the current season, saving if that changed anything. */
export declare function freshen(
  store: PlayerStore,
  player: PlayerRecord,
  now?: Date
): Promise<SeasonEnd | null>;
export declare function register(store: PlayerStore, name: unknown, now?: Date): Promise<Issued>;
export declare function rename(
  store: PlayerStore,
  player: PlayerRecord,
  name: unknown
): Promise<PlayerRecord>;
export declare function recover(store: PlayerStore, id: unknown, code: unknown): Promise<Issued>;
export declare function regenerateRecovery(
  store: PlayerStore,
  player: PlayerRecord
): Promise<string>;
export declare function authenticate(
  store: PlayerStore,
  token: unknown
): Promise<PlayerRecord | null>;
export declare function validateResult(body: unknown): {
  championId: string;
  difficulty: "easy" | "normal" | "hard";
  tally: { won: boolean; points: number; sets: number; rallies: number };
};
export declare function recordMatch(
  store: PlayerStore,
  player: PlayerRecord,
  body: unknown,
  now?: Date
): Promise<{ career: Career; outcome: MatchOutcome }>;
export declare function claim(
  store: PlayerStore,
  player: PlayerRecord,
  challengeId: unknown,
  now?: Date
): Promise<Career>;
export declare function upgrade(
  store: PlayerStore,
  player: PlayerRecord,
  championId: unknown,
  now?: Date
): Promise<Career>;
export declare function leaderboard(
  store: PlayerStore,
  limit: number,
  now?: Date
): Promise<PublicProfile[]>;
export declare function addFriend(
  store: PlayerStore,
  player: PlayerRecord,
  code: unknown
): Promise<PlayerRecord>;
export declare function removeFriend(
  store: PlayerStore,
  player: PlayerRecord,
  id: unknown
): Promise<void>;
export declare function friendsOf(
  store: PlayerStore,
  player: PlayerRecord
): Promise<PublicProfile[]>;
/**
 * Settle an online match from both sides' reports, or from a walkover the
 * relay itself witnessed. Resolves `{ pending: true }` when one report has
 * arrived with nothing to corroborate it.
 */
export declare function recordOnlineMatch(
  store: PlayerStore,
  player: PlayerRecord,
  body: unknown,
  now?: Date
): Promise<{ career: Career; outcome: MatchOutcome } | { pending: true }>;
