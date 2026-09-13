/**
 * Types for the store, hand-written because the server is plain ESM.
 *
 * The server ships as-is into an image that is not compiled, but the tests
 * that keep it honest are TypeScript, and a test file full of `any` is a test
 * file that stops catching things. `tests/accounts.test.ts` is what keeps
 * these in step with the code.
 */
import type { Career } from "../src/progress";

export interface PlayerRecord {
  id: string;
  name: string;
  /** SHA-256 of the bearer token. The token itself is never stored. */
  tokenHash: string;
  /** Salt and digest of the recovery code, which is likewise never stored. */
  recoverySalt: string;
  recoveryHash: string;
  /**
   * Unsalted digest of the same code, and the key it is found by. Absent on
   * accounts issued before the lookup existed; they heal on first recovery.
   */
  recoveryLookup?: string;
  /**
   * RevenueCat event ids already applied, newest last and bounded.
   *
   * An unanswered webhook is retried, so the same purchase arrives more than
   * once; coins credited twice are coins nobody paid for.
   */
  appliedEvents?: string[];
  created: number;
  lastSeen: number;
  lastMatchAt: number;
  matches: number;
  /** Player ids, mutual: a friendship one side cannot see is a bug. */
  friends: string[];
  /** The club they are in, or null. One at a time. */
  clubId?: string | null;
  career: Career;
}

export interface ClubRecord {
  id: string;
  name: string;
  ownerId: string;
  /** Player ids in join order, owner first. Decides who inherits the club. */
  members: string[];
  /** The code that is shared to invite people, and that the owner can rotate. */
  invite: string;
  created: number;
}

/** Every store speaks this. Async throughout, because Firestore is. */
export interface PlayerStore {
  load(): Promise<PlayerStore>;
  get(id: string): Promise<PlayerRecord | null>;
  byToken(digest: string): Promise<PlayerRecord | null>;
  /** The account a recovery code belongs to, by its lookup digest. */
  byRecovery(digest: string): Promise<PlayerRecord | null>;
  /**
   * An account issued before the lookup index existed, matched by offering the
   * code to each salted digest. A migration shim; see the implementations.
   */
  findLegacyRecovery?(match: (player: PlayerRecord) => boolean): Promise<PlayerRecord | null>;
  nameOwner(key: string): Promise<string | null>;
  /** Add a player, or throw NameTakenError if the name went to someone else. */
  create(player: PlayerRecord): Promise<void>;
  /** Take a new name, atomically with releasing the old one. */
  rename(player: PlayerRecord, name: string): Promise<void>;
  /** Persist changes to a record the caller already holds. */
  save(player: PlayerRecord): Promise<void>;
  /** Stop an old token digest working, after a recovery replaced it. */
  revokeToken?(digest: string): Promise<void>;
  /** The same for a recovery code that has been spent. */
  revokeRecovery?(digest: string): Promise<void>;
  getClub(id: string): Promise<ClubRecord | null>;
  clubByInvite(code: string): Promise<ClubRecord | null>;
  /** Add a club, or throw NameTakenError if the name went to someone else. */
  createClub(club: ClubRecord): Promise<void>;
  /** Persist a club; pass the old invite when it was rotated, so it stops working. */
  saveClub(club: ClubRecord, opts?: { previousInvite?: string }): Promise<void>;
  renameClub(club: ClubRecord, name: string): Promise<void>;
  deleteClub(club: ClubRecord): Promise<void>;
  leaderboard(limit: number): Promise<PlayerRecord[]>;
  rankOf(id: string): Promise<number | null>;
  size(): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export declare const nameKey: (name: string) => string;

export declare class NameTakenError extends Error {
  readonly status: number;
}

export declare class JsonStore implements PlayerStore {
  constructor(file: string);
  readonly file: string;
  /** Recovery lookup digest → player id. Exposed so tests can unindex one. */
  readonly recoveries: Map<string, string>;
  load(): Promise<this>;
  get(id: string): Promise<PlayerRecord | null>;
  byToken(digest: string): Promise<PlayerRecord | null>;
  byRecovery(digest: string): Promise<PlayerRecord | null>;
  findLegacyRecovery(match: (player: PlayerRecord) => boolean): Promise<PlayerRecord | null>;
  nameOwner(key: string): Promise<string | null>;
  create(player: PlayerRecord): Promise<void>;
  rename(player: PlayerRecord, name: string): Promise<void>;
  save(player: PlayerRecord): Promise<void>;
  getClub(id: string): Promise<ClubRecord | null>;
  clubByInvite(code: string): Promise<ClubRecord | null>;
  createClub(club: ClubRecord): Promise<void>;
  saveClub(club: ClubRecord, opts?: { previousInvite?: string }): Promise<void>;
  renameClub(club: ClubRecord, name: string): Promise<void>;
  deleteClub(club: ClubRecord): Promise<void>;
  leaderboard(limit: number): Promise<PlayerRecord[]>;
  rankOf(id: string): Promise<number | null>;
  size(): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Firestore when FIRESTORE_PROJECT is set, the JSON file otherwise. */
export declare function openStore(env?: Record<string, string | undefined>): Promise<PlayerStore>;
