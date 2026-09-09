/**
 * A cup or league run, written down so closing the app does not end it.
 *
 * A competition is three or four matches back to back, which is a long sitting
 * on a phone — long enough that it will routinely be interrupted by a bus
 * stop, a phone call, or the battery. Until now every one of them lived in
 * closure variables in `main.ts` and died with the page: a player two rounds
 * into a cup who backed out to answer a message came back to nothing.
 *
 * Saved between rounds, never during one. A round is the unit the competition
 * already thinks in — the standings screen between rounds is a natural place
 * to have finished something — and the alternative, snapshotting a live match,
 * means serialising the ball, the characters and the rally state and keeping
 * all three in step with every future change to them. Quitting mid-match
 * therefore costs that match and nothing more.
 *
 * Only ids are stored, never whole character definitions: a `CharacterDef`
 * carries career level and traits that are recomputed on load, and a saved
 * copy of one would go stale the moment the player levelled up.
 */

const KEY = "teqopen.competition";

export type CompetitionFormat = "cup" | "league";

/** A league player's running total. Indexed like `SavedCompetition.players`. */
export interface LeagueRow {
  pts: number;
  diff: number;
}

/**
 * What the cup has already decided.
 *
 * The semi-finals settle the whole shape of the final — who the human plays,
 * whether it is for the trophy or for third — so a resumed run has to know
 * their results or it would redraw a different tournament.
 */
export interface CupProgress {
  /** Whether the human won their semi-final. */
  wonSemi: boolean;
  /** The human's semi-final scoreline. */
  semiSets: [number, number];
  /** The simulated other semi: its scoreline, and whether the first name won. */
  sf2Sets: [number, number];
  sf2WinA: boolean;
}

export interface SavedCompetition {
  format: CompetitionFormat;
  /**
   * Character ids in draw order, the human first.
   *
   * The draw is shuffled when a competition starts, so the order is part of
   * the saved run rather than something that can be recomputed — reshuffling
   * on resume would change who the player was about to face.
   */
  players: string[];
  ballId: string;
  /** The round about to be played, 0-based. */
  round: number;
  /** League only: the table so far. */
  table?: LeagueRow[];
  /** Cup only: the semi-finals, once they are behind us. */
  cup?: CupProgress;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readSets(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const pair = v as unknown[];
  const a = pair[0];
  const b = pair[1];
  if (typeof a !== "number" || typeof b !== "number") return null;
  return [Math.max(0, Math.round(a)), Math.max(0, Math.round(b))];
}

/**
 * The competition in progress, or null when there is none.
 *
 * Anything that does not parse into a complete, self-consistent run is treated
 * as no run at all. A half-read competition would put the player into a
 * tournament with the wrong opponents or the wrong score, which is worse than
 * telling them the saved one is gone.
 */
export function readCompetition(): SavedCompetition | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)) return null;

    const format = stored.format === "cup" || stored.format === "league" ? stored.format : null;
    if (!format) return null;

    const players = Array.isArray(stored.players)
      ? stored.players.filter((p): p is string => typeof p === "string")
      : [];
    // Both formats are four-handed. Fewer names than that is a truncated save.
    if (players.length !== 4) return null;

    const ballId = typeof stored.ballId === "string" ? stored.ballId : null;
    if (!ballId) return null;

    const round = Math.max(0, Math.round(num(stored.round, 0)));

    if (format === "league") {
      if (!Array.isArray(stored.table) || stored.table.length !== players.length) return null;
      const table: LeagueRow[] = [];
      for (const row of stored.table) {
        if (!isRecord(row)) return null;
        table.push({ pts: Math.max(0, Math.round(num(row.pts, 0))), diff: Math.round(num(row.diff, 0)) });
      }
      // Three rounds in a four-player round robin; a finished league should
      // have been cleared, so a saved one past the end is corrupt.
      if (round > 2) return null;
      return { format, players, ballId, round, table };
    }

    // A cup saved at round 0 has not played its semi yet and needs no history.
    if (round === 0) return { format, players, ballId, round };
    const c = stored.cup;
    if (!isRecord(c)) return null;
    const semiSets = readSets(c.semiSets);
    const sf2Sets = readSets(c.sf2Sets);
    if (!semiSets || !sf2Sets || typeof c.wonSemi !== "boolean" || typeof c.sf2WinA !== "boolean") {
      return null;
    }
    if (round > 1) return null;
    return {
      format,
      players,
      ballId,
      round,
      cup: { wonSemi: c.wonSemi, semiSets, sf2Sets, sf2WinA: c.sf2WinA },
    };
  } catch {
    return null;
  }
}

export function storeCompetition(run: SavedCompetition): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(run));
  } catch {
    // Private browsing, a full quota: the run still plays out in this session,
    // it just will not survive being closed. Losing the save is not a reason
    // to refuse the competition.
  }
}

/** Forget the saved run — it finished, or the player started a new one. */
export function clearCompetition(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: a save that cannot be removed also could not be written.
  }
}

/** How a saved run reads on the button offering to go back into it. */
export function describeCompetition(run: SavedCompetition, labelFor: (id: string) => string): string {
  const who = labelFor(run.players[0]);
  if (run.format === "league") return `LEAGUE · ROUND ${run.round + 1} OF 3 · ${who}`;
  return run.round === 0 ? `CUP · SEMI-FINAL · ${who}` : `CUP · FINAL · ${who}`;
}
