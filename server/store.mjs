/**
 * Where players are kept, and the interface any store has to satisfy.
 *
 * Every method is async, including the ones a JSON file could answer
 * instantly. That is not an accident: the store this actually deploys onto is
 * Firestore, and an interface shaped around the in-memory case would have had
 * to be torn up the day it moved. The cost is a few `await`s in a file that
 * did not need them.
 *
 * Two implementations:
 *
 *   JsonStore       one file, written atomically, everything in memory.
 *                   Right for local development and for a single machine.
 *                   Wrong for a container with an ephemeral disk, which is
 *                   why it is not what production runs.
 *
 *   FirestoreStore  server/firestore.mjs. What Cloud Run runs.
 *
 * Uniqueness of names and the token index are the two things a store has to
 * get right, so both are part of the interface rather than something callers
 * assemble: `create` and `rename` either take the name or fail, atomically.
 */

import { mkdir, readFile, rename as renameFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How long a change waits for company before the file is rewritten. */
const FLUSH_MS = 400;
/** …and the longest a change may wait, however busy it is. */
const MAX_FLUSH_DELAY_MS = 3000;

/** A name is unique case-insensitively; this is the key that decides it. */
export const nameKey = (name) => name.toLowerCase();

export class NameTakenError extends Error {
  constructor() {
    super("that name is taken");
    this.status = 409;
  }
}

export class JsonStore {
  /** @param {string} file Path to the JSON file backing the store. */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, any>} id → player record */
    this.players = new Map();
    /** @type {Map<string, string>} lowercased name → id */
    this.names = new Map();
    /** @type {Map<string, string>} token digest → id */
    this.tokens = new Map();
    /** @type {Map<string, any>} id → club record */
    this.clubs = new Map();
    /** @type {Map<string, string>} lowercased club name → club id */
    this.clubNames = new Map();
    /** @type {Map<string, string>} invite code → club id */
    this.invites = new Map();
    this.dirty = false;
    this.flushTimer = null;
    this.firstDirtyAt = 0;
    this.writing = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      for (const player of parsed.players ?? []) this.index(player);
      for (const club of parsed.clubs ?? []) this.indexClub(club);
    } catch (err) {
      // A missing file is a first run, not a failure. Anything else is worth
      // saying out loud before the server carries on with an empty store —
      // silently starting fresh on a corrupt file is how a community
      // disappears without anyone noticing.
      if (err?.code !== "ENOENT") {
        console.error("[store] could not read", this.file, err.message);
      }
    }
    return this;
  }

  index(player) {
    this.players.set(player.id, player);
    this.names.set(nameKey(player.name), player.id);
    this.tokens.set(player.tokenHash, player.id);
  }

  indexClub(club) {
    this.clubs.set(club.id, club);
    this.clubNames.set(nameKey(club.name), club.id);
    this.invites.set(club.invite, club.id);
  }

  async get(id) {
    return this.players.get(id) ?? null;
  }

  async byToken(digest) {
    const id = this.tokens.get(digest);
    return id ? (this.players.get(id) ?? null) : null;
  }

  async nameOwner(key) {
    return this.names.get(key) ?? null;
  }

  /** Add a player, or throw if the name went to somebody else first. */
  async create(player) {
    if (this.names.has(nameKey(player.name))) throw new NameTakenError();
    this.index(player);
    this.touch();
  }

  /** Take a new name for a player, atomically with releasing the old one. */
  async rename(player, name) {
    const key = nameKey(name);
    const owner = this.names.get(key);
    if (owner !== undefined && owner !== player.id) throw new NameTakenError();
    this.names.delete(nameKey(player.name));
    player.name = name;
    this.names.set(key, player.id);
    this.touch();
  }

  /** Persist changes made to a record the caller already holds. */
  async save(player) {
    // The token can be replaced by a recovery, so the index is rebuilt rather
    // than assumed. Cheap, and it cannot go stale.
    for (const [digest, id] of this.tokens) {
      if (id === player.id && digest !== player.tokenHash) this.tokens.delete(digest);
    }
    this.tokens.set(player.tokenHash, player.id);
    this.players.set(player.id, player);
    this.touch();
  }

  /** Mark the store changed; the file catches up shortly. */
  touch() {
    this.dirty = true;
    if (this.firstDirtyAt === 0) this.firstDirtyAt = Date.now();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const waited = Date.now() - this.firstDirtyAt;
    const delay = Math.max(0, Math.min(FLUSH_MS, MAX_FLUSH_DELAY_MS - waited));
    this.flushTimer = setTimeout(() => void this.flush(), delay);
    // A pending write must never hold the process open on its own.
    this.flushTimer.unref?.();
  }

  /**
   * Write the file. Temp file plus rename, so a crash mid-write leaves the
   * previous good file rather than half of a new one.
   */
  async flush() {
    if (this.writing) return this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    this.firstDirtyAt = 0;
    const snapshot = JSON.stringify({
      players: [...this.players.values()],
      clubs: [...this.clubs.values()],
    });
    this.writing = (async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot);
        await renameFile(tmp, this.file);
      } catch (err) {
        console.error("[store] write failed", err.message);
        // Put the flag back: the next change retries, and a store that failed
        // to write must not report itself as saved.
        this.dirty = true;
      } finally {
        this.writing = null;
      }
    })();
    return this.writing;
  }

  // ---- clubs ----

  async getClub(id) {
    return this.clubs.get(id) ?? null;
  }

  async clubByInvite(code) {
    const id = this.invites.get(code);
    return id ? (this.clubs.get(id) ?? null) : null;
  }

  async createClub(club) {
    if (this.clubNames.has(nameKey(club.name))) throw new NameTakenError();
    this.indexClub(club);
    this.touch();
  }

  /**
   * Persist a club the caller already holds.
   *
   * `previousInvite` is passed when the code was rotated, so the old one stops
   * resolving — an invite that still works after being replaced has not been
   * replaced.
   */
  async saveClub(club, opts = {}) {
    if (opts.previousInvite && opts.previousInvite !== club.invite) {
      this.invites.delete(opts.previousInvite);
    }
    this.indexClub(club);
    this.touch();
  }

  async renameClub(club, name) {
    const key = nameKey(name);
    const owner = this.clubNames.get(key);
    if (owner !== undefined && owner !== club.id) throw new NameTakenError();
    this.clubNames.delete(nameKey(club.name));
    club.name = name;
    this.clubNames.set(key, club.id);
    this.touch();
  }

  async deleteClub(club) {
    this.clubs.delete(club.id);
    this.clubNames.delete(nameKey(club.name));
    this.invites.delete(club.invite);
    this.touch();
  }

  /** Highest trophy counts first, ties settled by who got there first. */
  async leaderboard(limit) {
    return [...this.players.values()]
      .sort((a, b) => b.career.trophies - a.career.trophies || a.created - b.created)
      .slice(0, limit);
  }

  /** One-based position, counting everyone. */
  async rankOf(id) {
    const target = this.players.get(id);
    if (!target) return null;
    let rank = 1;
    for (const other of this.players.values()) {
      if (other.id === id) continue;
      if (
        other.career.trophies > target.career.trophies ||
        (other.career.trophies === target.career.trophies && other.created < target.created)
      ) {
        rank++;
      }
    }
    return rank;
  }

  async size() {
    return this.players.size;
  }

  async close() {
    await this.flush();
  }
}

/**
 * The store this process should use.
 *
 * Firestore when a project is configured, the JSON file otherwise — so
 * `npm run relay` works on a laptop with nothing set up, and production is one
 * environment variable away rather than a code path nobody exercises.
 */
export async function openStore(env = process.env) {
  if (env.FIRESTORE_PROJECT) {
    const { firestoreStore } = await import("./firestore.mjs");
    return firestoreStore(env.FIRESTORE_PROJECT, env.FIRESTORE_DATABASE).load();
  }
  const dir = env.DATA_DIR ?? join(process.cwd(), "data");
  return new JsonStore(join(dir, "players.json")).load();
}
