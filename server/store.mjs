/**
 * Where players are kept.
 *
 * One interface, one implementation. The implementation is a JSON file written
 * atomically — no database, no schema migration, no ORM — because the whole
 * dataset is a few hundred bytes per player and the thing that would actually
 * sink this project is a weekend spent on infrastructure instead of on the
 * game.
 *
 * It is a real limitation and worth naming: a container with an ephemeral
 * filesystem (Cloud Run's default) loses the file when it restarts. That is
 * fine for a preview deployment and not fine for a community, which is why the
 * seam is here rather than the reads and writes being scattered through the
 * request handlers. Swapping this for Firestore — already in the project's
 * stack, since Hosting serves the game — is one file.
 *
 * Writes are debounced and coalesced: a hundred players finishing a match in
 * the same second should cost one write, not a hundred.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How long a change waits for company before the file is rewritten. */
const FLUSH_MS = 400;
/** …and the longest a change may wait, however busy it is. */
const MAX_FLUSH_DELAY_MS = 3000;

export class JsonStore {
  /** @param {string} file Path to the JSON file backing the store. */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, any>} id → player record */
    this.players = new Map();
    /** @type {Map<string, string>} lowercased name → id, for uniqueness */
    this.byName = new Map();
    /** @type {Map<string, string>} token → id */
    this.byToken = new Map();
    this.dirty = false;
    this.flushTimer = null;
    this.firstDirtyAt = 0;
    this.writing = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      for (const player of parsed.players ?? []) {
        this.index(player);
      }
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

  /** @param {any} player */
  index(player) {
    this.players.set(player.id, player);
    this.byName.set(player.name.toLowerCase(), player.id);
    this.byToken.set(player.token, player.id);
  }

  get(id) {
    return this.players.get(id) ?? null;
  }

  byTokenValue(token) {
    const id = this.byToken.get(token);
    return id ? (this.players.get(id) ?? null) : null;
  }

  nameTaken(name, exceptId = null) {
    const owner = this.byName.get(name.toLowerCase());
    return owner !== undefined && owner !== exceptId;
  }

  add(player) {
    this.index(player);
    this.touch();
  }

  rename(player, name) {
    this.byName.delete(player.name.toLowerCase());
    player.name = name;
    this.byName.set(name.toLowerCase(), player.id);
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
    const snapshot = JSON.stringify({ players: [...this.players.values()] });
    this.writing = (async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot);
        await rename(tmp, this.file);
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

  /** Highest trophy counts first. Recomputed per call — see the note in relay. */
  leaderboard(limit) {
    return [...this.players.values()]
      .sort((a, b) => b.career.trophies - a.career.trophies || a.created - b.created)
      .slice(0, limit);
  }

  /** One-based position in the leaderboard, counting everyone. */
  rankOf(id) {
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

  get size() {
    return this.players.size;
  }
}

/** The store the server runs with, rooted at DATA_DIR (default ./data). */
export function defaultStore() {
  const dir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  return new JsonStore(join(dir, "players.json"));
}
