/** Types for the Firestore store. See the note in `store.d.mts`. */
import type { PlayerRecord, PlayerStore } from "./store.mjs";

export declare class FirestoreStore implements PlayerStore {
  /** Takes a Firestore client rather than building one, so it can be doubled. */
  constructor(db: unknown);
  load(): Promise<this>;
  get(id: string): Promise<PlayerRecord | null>;
  byToken(digest: string): Promise<PlayerRecord | null>;
  nameOwner(key: string): Promise<string | null>;
  create(player: PlayerRecord): Promise<void>;
  rename(player: PlayerRecord, name: string): Promise<void>;
  save(player: PlayerRecord): Promise<void>;
  revokeToken(digest: string): Promise<void>;
  leaderboard(limit: number): Promise<PlayerRecord[]>;
  rankOf(id: string): Promise<number | null>;
  size(): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** The store production runs: a real client, credentials from the environment. */
export declare function firestoreStore(projectId: string, databaseId?: string): FirestoreStore;
