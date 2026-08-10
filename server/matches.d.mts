/** Types for the live-match record. See the note in `store.d.mts`. */

export interface LiveReport {
  won: boolean;
  points: number;
  sets: number;
  rallies: number;
  championId: string;
  setsPlayed: number;
  settled: boolean;
}

export interface LiveMatch {
  id: string;
  players: [string | null, string | null];
  startedAt: number;
  /** Whose socket the relay saw go, if either did. */
  left: string | null;
  leftAt: number;
  reports: Map<string, LiveReport>;
}

export declare const TTL_MS: number;
export declare function begin(a: string | null, b: string | null): string;
export declare function get(id: unknown): LiveMatch | null;
export declare function departed(id: string, playerId: string | null): void;
export declare function opponentOf(match: LiveMatch, playerId: string): string | null;
export declare function isPlayerIn(match: LiveMatch, playerId: string): boolean;
export declare function sweepMatches(now?: number): void;
/** Forget everything. Only for tests. */
export declare function reset(): void;
