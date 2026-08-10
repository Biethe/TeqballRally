/** Types for the accounts module. See the note in `store.d.mts`. */
import type { Career, MatchOutcome } from "../src/progress";
import type { JsonStore, PlayerRecord } from "./store.mjs";

export declare const NAME_MIN: number;
export declare const NAME_MAX: number;
export declare const MATCH_COOLDOWN_MS: number;
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
}

export declare function normaliseName(raw: unknown): string;
export declare function publicProfile(player: PlayerRecord, rank?: number | null): PublicProfile;
export declare function privateProfile(
  store: JsonStore,
  player: PlayerRecord
): PublicProfile & { career: Career };
export declare function register(store: JsonStore, name: unknown, now?: Date): PlayerRecord;
export declare function rename(store: JsonStore, player: PlayerRecord, name: unknown): PlayerRecord;
export declare function authenticate(store: JsonStore, token: unknown): PlayerRecord | null;
export declare function validateResult(body: unknown): {
  championId: string;
  difficulty: "easy" | "normal" | "hard";
  tally: { won: boolean; points: number; sets: number; rallies: number };
};
export declare function recordMatch(
  store: JsonStore,
  player: PlayerRecord,
  body: unknown,
  now?: Date
): { career: Career; outcome: MatchOutcome };
export declare function claim(
  store: JsonStore,
  player: PlayerRecord,
  challengeId: unknown,
  now?: Date
): Career;
export declare function upgrade(store: JsonStore, player: PlayerRecord, championId: unknown): Career;
export declare function leaderboard(store: JsonStore, limit: number): PublicProfile[];
