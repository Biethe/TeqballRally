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
  created: number;
  lastSeen: number;
  lastMatchAt: number;
  matches: number;
  career: Career;
}

/** Every store speaks this. Async throughout, because Firestore is. */
export interface PlayerStore {
  load(): Promise<PlayerStore>;
  get(id: string): Promise<PlayerRecord | null>;
  byToken(digest: string): Promise<PlayerRecord | null>;
  nameOwner(key: string): Promise<string | null>;
  /** Add a player, or throw NameTakenError if the name went to someone else. */
  create(player: PlayerRecord): Promise<void>;
  /** Take a new name, atomically with releasing the old one. */
  rename(player: PlayerRecord, name: string): Promise<void>;
  /** Persist changes to a record the caller already holds. */
  save(player: PlayerRecord): Promise<void>;
  /** Stop an old token digest working, after a recovery replaced it. */
  revokeToken?(digest: string): Promise<void>;
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
  load(): Promise<this>;
  get(id: string): Promise<PlayerRecord | null>;
  byToken(digest: string): Promise<PlayerRecord | null>;
  nameOwner(key: string): Promise<string | null>;
  create(player: PlayerRecord): Promise<void>;
  rename(player: PlayerRecord, name: string): Promise<void>;
  save(player: PlayerRecord): Promise<void>;
  leaderboard(limit: number): Promise<PlayerRecord[]>;
  rankOf(id: string): Promise<number | null>;
  size(): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Firestore when FIRESTORE_PROJECT is set, the JSON file otherwise. */
export declare function openStore(env?: Record<string, string | undefined>): Promise<PlayerStore>;
