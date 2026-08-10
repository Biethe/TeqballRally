/**
 * Types for the store, hand-written because the server is plain ESM.
 *
 * The server ships as-is into an image that carries `ws` and nothing else, so
 * it is not compiled — but the tests that keep it honest are TypeScript, and a
 * test file full of `any` is a test file that stops catching things. These
 * declarations exist for the tests; `tests/accounts.test.ts` is what keeps
 * them in step with the code.
 */
import type { Career } from "../src/progress";

export interface PlayerRecord {
  id: string;
  name: string;
  /** Secret. Never leaves the server except once, at registration. */
  token: string;
  created: number;
  lastSeen: number;
  lastMatchAt: number;
  matches: number;
  career: Career;
}

export declare class JsonStore {
  constructor(file: string);
  readonly file: string;
  readonly size: number;
  load(): Promise<this>;
  get(id: string): PlayerRecord | null;
  byTokenValue(token: string): PlayerRecord | null;
  nameTaken(name: string, exceptId?: string | null): boolean;
  add(player: PlayerRecord): void;
  rename(player: PlayerRecord, name: string): void;
  touch(): void;
  flush(): Promise<void>;
  leaderboard(limit: number): PlayerRecord[];
  rankOf(id: string): number | null;
}

export declare function defaultStore(): JsonStore;
