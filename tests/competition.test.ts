import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompetition,
  describeCompetition,
  readCompetition,
  storeCompetition,
  type SavedCompetition,
} from "../src/competition";

/**
 * The suite runs on node, which has no storage. Only the methods
 * `competition.ts` touches are provided — a fuller fake would be testing
 * itself.
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const KEY = "teqopen.competition";
const PLAYERS = ["brazil", "england", "france", "spain"];

const league = (over: Partial<SavedCompetition> = {}): SavedCompetition => ({
  format: "league",
  players: PLAYERS,
  ballId: "pitch",
  round: 1,
  table: [
    { pts: 3, diff: 1 },
    { pts: 0, diff: -1 },
    { pts: 3, diff: 2 },
    { pts: 0, diff: -2 },
  ],
  ...over,
});

const cup = (over: Partial<SavedCompetition> = {}): SavedCompetition => ({
  format: "cup",
  players: PLAYERS,
  ballId: "pitch",
  round: 1,
  cup: { wonSemi: true, semiSets: [2, 1], sf2Sets: [2, 0], sf2WinA: true },
  ...over,
});

describe("a competition left half-played", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeStorage();
  });

  it("has nothing to come back to on a fresh install", () => {
    expect(readCompetition()).toBeNull();
  });

  it("comes back exactly as it was left", () => {
    // The point of the whole file: a player two rounds into a league who
    // closed the app gets those two rounds back, not a fresh table.
    storeCompetition(league());

    expect(readCompetition()).toEqual(league());
  });

  it("keeps the draw, so the tournament is the same one", () => {
    // The order is shuffled once when the run starts. If it were re-rolled on
    // resume the player would come back to different opponents in a bracket
    // they had already half-played.
    storeCompetition(cup());

    expect(readCompetition()?.players).toEqual(PLAYERS);
  });

  it("remembers the semi-finals a cup has already decided", () => {
    // These four facts settle who the final is against and whether it is for
    // the trophy or for third, so losing them would redraw the tournament.
    storeCompetition(cup({ cup: { wonSemi: false, semiSets: [0, 2], sf2Sets: [1, 2], sf2WinA: false } }));

    expect(readCompetition()?.cup).toEqual({
      wonSemi: false,
      semiSets: [0, 2],
      sf2Sets: [1, 2],
      sf2WinA: false,
    });
  });

  it("is forgotten once it finishes", () => {
    storeCompetition(league());
    clearCompetition();

    expect(readCompetition()).toBeNull();
  });
});

describe("a saved run that cannot be trusted", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeStorage();
  });

  /** Write a raw value past the type system, the way a bad save would sit. */
  const put = (v: unknown): void => localStorage.setItem(KEY, JSON.stringify(v));

  it("is treated as no run at all rather than a half-read one", () => {
    // Dropping the player into a tournament with the wrong opponents or the
    // wrong score is worse than telling them the saved run is gone.
    for (const bad of [
      "not json at all",
      42,
      null,
      {},
      { ...league(), format: "friendly" },
      { ...league(), players: ["brazil", "england"] }, // a truncated draw
      { ...league(), ballId: 7 },
      { ...league(), table: undefined }, // a league with no table
      { ...league(), table: [{ pts: 0, diff: 0 }] }, // a table missing players
      { ...league(), round: 9 }, // past the end of a three-round league
      { ...cup(), cup: undefined }, // a cup past its semi with no semi result
      { ...cup(), cup: { wonSemi: true, semiSets: [2], sf2Sets: [2, 0], sf2WinA: true } },
      { ...cup(), cup: { wonSemi: "yes", semiSets: [2, 1], sf2Sets: [2, 0], sf2WinA: true } },
      { ...cup(), round: 4 },
    ]) {
      put(bad);
      expect(readCompetition(), JSON.stringify(bad)).toBeNull();
    }
  });

  it("survives storage that is not there at all", () => {
    // Private browsing and a full quota both throw on write. The run plays out
    // in memory rather than the competition refusing to start.
    globalThis.localStorage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };

    expect(() => storeCompetition(league())).not.toThrow();
    expect(() => clearCompetition()).not.toThrow();
    expect(readCompetition()).toBeNull();
  });

  it("reads a cup that has not played its semi yet", () => {
    // Round 0 has no history to carry, so the absence of one is not corruption.
    put({ format: "cup", players: PLAYERS, ballId: "pitch", round: 0 });

    expect(readCompetition()).toEqual({
      format: "cup",
      players: PLAYERS,
      ballId: "pitch",
      round: 0,
    });
  });
});

describe("what the resume button says", () => {
  const label = (id: string): string => id.toUpperCase();

  it("names the round a league stopped at, counting from one", () => {
    expect(describeCompetition(league({ round: 1 }), label)).toBe("LEAGUE · ROUND 2 OF 3 · BRAZIL");
  });

  it("names the tie a cup stopped at", () => {
    expect(describeCompetition(cup({ round: 0 }), label)).toBe("CUP · SEMI-FINAL · BRAZIL");
    expect(describeCompetition(cup({ round: 1 }), label)).toBe("CUP · FINAL · BRAZIL");
  });
});
