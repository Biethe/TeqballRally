import { apiBase } from "./net/endpoint";
import type { Career } from "./progress";
import type { MatchOutcome } from "./progress";

/**
 * The player's account, from the game's side.
 *
 * The game plays perfectly well without one. Everything here is additive: the
 * career already works offline, and signing in makes it the server's copy
 * instead of the device's — which is what makes a leaderboard mean anything and
 * what makes a name follow someone onto a new phone.
 *
 * So every call here is allowed to fail. A request that does not come back
 * leaves the local career exactly as it was and the game carries on; the only
 * thing lost is the leaderboard position, and it catches up on the next match.
 * Nothing in this module may ever block a player from starting a game.
 */

export interface Identity {
  id: string;
  name: string;
  /** The secret this device signs in with. Never shown, never sent anywhere else. */
  token: string;
}

export interface Profile {
  id: string;
  name: string;
  trophies: number;
  best: number;
  tier: string;
  matches: number;
  rank: number | null;
}

export interface LeaderboardRow extends Profile {
  rank: number;
}

export interface LeaderboardView {
  rows: LeaderboardRow[];
  total: number;
  me: Profile | null;
}

/** A finished match, in the shape the server scores. */
export interface MatchReport {
  championId: string;
  difficulty: "easy" | "normal" | "hard";
  won: boolean;
  points: number;
  sets: number;
  rallies: number;
}

const KEY = "teqopen.identity";
/**
 * Longest any request may take before the game stops waiting for it.
 *
 * Short on purpose. This sits between a player and the screen after their
 * match; a server having a bad minute must cost them a moment, not the game.
 */
const TIMEOUT_MS = 6000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The signed-in identity, or null. Total: a corrupt store reads as signed out. */
export function readIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<Identity>;
    if (
      typeof stored.id !== "string" ||
      typeof stored.name !== "string" ||
      typeof stored.token !== "string"
    ) {
      return null;
    }
    return { id: stored.id, name: stored.name, token: stored.token };
  } catch {
    return null;
  }
}

export function storeIdentity(identity: Identity | null): void {
  try {
    if (identity) localStorage.setItem(KEY, JSON.stringify(identity));
    else localStorage.removeItem(KEY);
  } catch {
    // Private browsing: the account works for this session and is forgotten
    // afterwards, which is better than refusing to sign in at all.
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = (text ? JSON.parse(text) : null) as Record<string, unknown> | null;
    if (!res.ok) {
      const message = typeof parsed?.error === "string" ? parsed.error : `request failed (${res.status})`;
      throw new ApiError(message, res.status);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // A timeout, a refused connection, a phone in a tunnel: all the same thing
    // to the caller, which is "not now".
    throw new ApiError("could not reach the server", 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Claim a name and get an account. The only call that returns a token. */
export async function signUp(name: string): Promise<{ identity: Identity; profile: Profile; career: Career }> {
  const body = await request<Profile & { token: string; career: Career }>("/api/players", {
    method: "POST",
    body: { name },
  });
  const identity: Identity = { id: body.id, name: body.name, token: body.token };
  storeIdentity(identity);
  return { identity, profile: body, career: body.career };
}

export async function fetchMe(token: string): Promise<Profile & { career: Career }> {
  return request<Profile & { career: Career }>("/api/players/me", { token });
}

export async function changeName(token: string, name: string): Promise<Profile & { career: Career }> {
  return request<Profile & { career: Career }>("/api/players/me/name", {
    method: "POST",
    body: { name },
    token,
  });
}

/**
 * Report a finished match and take back the career the server holds.
 *
 * The server scores it from the same rules the client just ran, so the two
 * agree unless something was tampered with — in which case the server's answer
 * is the one that counts, and adopting it is the whole point.
 */
export async function reportMatch(
  token: string,
  report: MatchReport
): Promise<{ career: Career; outcome: MatchOutcome; rank: number | null }> {
  return request("/api/players/me/matches", { method: "POST", body: report, token });
}

export async function claimOnServer(token: string, challengeId: string): Promise<Career> {
  const body = await request<{ career: Career }>("/api/players/me/claim", {
    method: "POST",
    body: { challengeId },
    token,
  });
  return body.career;
}

export async function upgradeOnServer(token: string, championId: string): Promise<Career> {
  const body = await request<{ career: Career }>("/api/players/me/upgrade", {
    method: "POST",
    body: { championId },
    token,
  });
  return body.career;
}

export async function fetchLeaderboard(token?: string): Promise<LeaderboardView> {
  return request<LeaderboardView>("/api/leaderboard?limit=50", { token });
}

export async function lookUpPlayer(code: string): Promise<Profile> {
  return request<Profile>(`/api/players/${encodeURIComponent(code.trim().toUpperCase())}`);
}

/**
 * Whether a name will be accepted, checked here so the screen can say so
 * before a round trip.
 *
 * Kept deliberately in step with `normaliseName` on the server, which is the
 * one that decides. This is a courtesy, not the rule.
 */
export const NAME_MIN = 3;
export const NAME_MAX = 16;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,14}[\p{L}\p{N}]$/u;

export function tidyName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function nameProblem(raw: string): "short" | "long" | "characters" | null {
  const name = tidyName(raw);
  if (name.length < NAME_MIN) return "short";
  if (name.length > NAME_MAX) return "long";
  if (!NAME_RE.test(name)) return "characters";
  return null;
}
