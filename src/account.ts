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
  /** A socket open right now, which is what "can I play them" really asks. */
  online: boolean;
  /** When they were last seen, for the ones who are not. */
  lastSeen: number;
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

/** What registering or recovering hands back, secrets included. */
export interface Issued {
  identity: Identity;
  profile: Profile;
  career: Career;
  /**
   * Shown to the player once and never retrievable. The screen has to make
   * them look at it, because the server cannot show it again — it only kept a
   * salted digest.
   */
  recoveryCode: string;
}

/** Claim a name and get an account. One of two calls that return the secrets. */
export async function signUp(name: string): Promise<Issued> {
  return claimAccount("/api/players", { name });
}

/**
 * Take an account over onto this device with its recovery code.
 *
 * The code alone, because the code alone is unique to one account — and the
 * person typing it has already lost the phone that knew anything else. Asking
 * for a player id beside it meant somebody holding the slip they were told to
 * write down still could not get back in.
 *
 * The previous device stops working the moment this succeeds, which is the
 * point: this is what somebody does when a phone is gone.
 */
export async function restore(code: string): Promise<Issued> {
  return claimAccount("/api/players/recover", { code });
}

async function claimAccount(path: string, body: Record<string, string>): Promise<Issued> {
  const res = await request<Profile & { token: string; recoveryCode: string; career: Career }>(
    path,
    { method: "POST", body }
  );
  const identity: Identity = { id: res.id, name: res.name, token: res.token };
  storeIdentity(identity);
  return { identity, profile: res, career: res.career, recoveryCode: res.recoveryCode };
}

/** A fresh recovery code, from a device that is already signed in. */
export async function newRecoveryCode(token: string): Promise<string> {
  const body = await request<{ recoveryCode: string }>("/api/players/me/recovery", {
    method: "POST",
    token,
  });
  return body.recoveryCode;
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
 * Permanently delete the signed-in player account from the server and local storage.
 */
export async function deleteAccount(token: string): Promise<{ deleted: boolean }> {
  try {
    const res = await request<{ deleted: boolean }>("/api/players/me/delete", {
      method: "POST",
      token,
    });
    storeIdentity(null);
    return res;
  } catch (err) {
    storeIdentity(null);
    throw err;
  }
}

/**
 * Wipe all local gameplay saves and identity from localStorage.
 */
export function wipeLocalAccountData(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem("teqopen.career");
    localStorage.removeItem("teqopen.prefs");
  } catch {
    // ignore
  }
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

/** A finished online match, as the server scores it. */
export interface OnlineReport {
  matchId: string;
  championId: string;
  won: boolean;
  points: number;
  sets: number;
  rallies: number;
  /** The other side's sets, so the server can tell how far the match got. */
  opponentSets: number;
}

/**
 * Report an online result.
 *
 * Resolves `{ pending: true }` when the server is still waiting for the other
 * side. That is not a failure and must not be shown as one — it means the
 * trophies are real but not yet counted, and the next screen simply says
 * nothing about a rank.
 */
export async function reportOnlineMatch(
  token: string,
  report: OnlineReport
): Promise<{ career: Career; outcome: MatchOutcome; rank: number | null } | { pending: true }> {
  return request("/api/players/me/online", { method: "POST", body: report, token });
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

/**
 * How many people are reachable right now.
 *
 * Needs no account, because it is a count and not a list: it answers "is
 * there anybody to play" and says nothing at all about who. Quick match reads
 * it to decide how hard to look — see `searchWindow` in `main.ts`.
 */
export async function fetchOnlineCount(): Promise<number> {
  const body = await request<{ count: number }>("/api/online", {});
  return Number.isFinite(body.count) ? body.count : 0;
}

export async function fetchFriends(token: string): Promise<Profile[]> {
  const body = await request<{ friends: Profile[] }>("/api/players/me/friends", { token });
  return body.friends;
}

/** Add somebody by the code on their card. Mutual immediately. */
export async function addFriend(token: string, code: string): Promise<Profile[]> {
  const body = await request<{ friends: Profile[] }>("/api/players/me/friends", {
    method: "POST",
    body: { code: code.trim().toUpperCase() },
    token,
  });
  return body.friends;
}

export async function removeFriend(token: string, id: string): Promise<Profile[]> {
  const body = await request<{ friends: Profile[] }>("/api/players/me/friends/remove", {
    method: "POST",
    body: { id },
    token,
  });
  return body.friends;
}

/** A member of a club: a public profile, plus who is in charge. */
export interface ClubMember extends Profile {
  owner: boolean;
}

/** A club as its members see it. */
export interface Club {
  id: string;
  name: string;
  ownerId: string;
  created: number;
  /** Ordered by trophies. The owner is marked, not pinned. */
  members: ClubMember[];
  /** Every member's trophies added up. */
  trophies: number;
  online: number;
  full: boolean;
  /** The invite code — present for the owner, null for everybody else. */
  invite: string | null;
}

/** Longest a club name may be. Longer than a player's; see the server. */
export const CLUB_NAME_MIN = 3;
export const CLUB_NAME_MAX = 20;
/** Members a club holds. Shown on the screen, so it is not a secret constant. */
export const MAX_CLUB_MEMBERS = 10;

/** The club this player is in, or null. */
export async function fetchClub(token: string): Promise<Club | null> {
  const body = await request<{ club: Club | null }>("/api/clubs/me", { token });
  return body.club;
}

export async function createClub(token: string, name: string): Promise<Club> {
  const body = await request<{ club: Club }>("/api/clubs", {
    method: "POST",
    body: { name },
    token,
  });
  return body.club;
}

export async function joinClub(token: string, code: string): Promise<Club> {
  const body = await request<{ club: Club }>("/api/clubs/join", {
    method: "POST",
    body: { code: tidyInvite(code) },
    token,
  });
  return body.club;
}

/** Leave. Resolves to null, which is also what the club becomes if you were last. */
export async function leaveClub(token: string): Promise<null> {
  await request<{ club: null }>("/api/clubs/leave", { method: "POST", token });
  return null;
}

export async function renameClub(token: string, name: string): Promise<Club> {
  const body = await request<{ club: Club }>("/api/clubs/me/name", {
    method: "POST",
    body: { name },
    token,
  });
  return body.club;
}

/** A fresh invite code. The old one stops working — that is the point. */
export async function newInviteCode(token: string): Promise<Club> {
  const body = await request<{ club: Club }>("/api/clubs/me/invite", { method: "POST", token });
  return body.club;
}

/** Owner only. Null when removing the last other member disbanded the club. */
export async function removeMember(token: string, id: string): Promise<Club | null> {
  const body = await request<{ club: Club | null }>("/api/clubs/me/remove", {
    method: "POST",
    body: { id },
    token,
  });
  return body.club;
}

/**
 * Tidy a typed invite code the way the server does.
 *
 * Deliberately in step with `tidyInvite` in `server/clubs.mjs`, which is the
 * one that decides. Q is left alone: it is in the Crockford alphabet, and
 * folding it would make any code containing one impossible to type back in.
 */
export function tidyInvite(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function looksLikeInvite(raw: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(tidyInvite(raw));
}

export function clubNameProblem(raw: string): "short" | "long" | "characters" | null {
  const name = tidyName(raw);
  if (name.length < CLUB_NAME_MIN) return "short";
  if (name.length > CLUB_NAME_MAX) return "long";
  if (!new RegExp(`^[\\p{L}\\p{N}][\\p{L}\\p{N} _-]{1,${CLUB_NAME_MAX - 2}}[\\p{L}\\p{N}]$`, "u").test(name)) {
    return "characters";
  }
  return null;
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

/**
 * Tidy a typed recovery code the same way the server does.
 *
 * Deliberately in step with `tidyRecovery` in `server/secrets.mjs`, which is
 * the one that decides — this only spares a round trip for something the
 * screen can see is wrong.
 */
export function tidyCode(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const groups: string[] = [];
  for (let i = 0; i < cleaned.length; i += 4) groups.push(cleaned.slice(i, i + 4));
  return groups.join("-");
}

/** True when a typed code is the right shape to be worth sending. */
export function looksLikeCode(raw: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(tidyCode(raw));
}

/** A player code is eight Crockford characters, and nothing else. */
export function looksLikePlayerCode(raw: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(raw.trim().toUpperCase());
}

/**
 * How long ago somebody was last seen, in the roughest terms that are useful.
 *
 * Rough on purpose: a friends list is asking "recently or not", and reporting
 * that somebody was here 43 minutes ago is both more precise than the answer
 * needs and more than they agreed to share.
 */
export function lastSeenLabel(at: number, now = Date.now()): "now" | "today" | "week" | "long" {
  const minutes = (now - at) / 60_000;
  if (minutes < 10) return "now";
  if (minutes < 60 * 24) return "today";
  if (minutes < 60 * 24 * 7) return "week";
  return "long";
}
