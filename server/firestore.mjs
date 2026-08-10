import { Firestore } from "@google-cloud/firestore";
import { NameTakenError, nameKey } from "./store.mjs";

/**
 * The store Cloud Run runs on.
 *
 * Same interface as `JsonStore`, three collections:
 *
 *   players/{id}          the record
 *   names/{lowercase}     → { id }, so a name can only be held by one player
 *   tokens/{digest}       → { id }, so authenticating is one read, not a query
 *
 * The two index collections exist because Firestore has no unique constraint
 * and no cheap "find by field" — a document id *is* the index. Writing them in
 * a transaction alongside the player is what makes "take this name" an
 * operation that either happens or does not, rather than two writes with a
 * race between them.
 *
 * Credentials come from the environment: on Cloud Run that is the service
 * account, with nothing to configure and no key file to leak.
 */

const PLAYERS = "players";
const NAMES = "names";
const TOKENS = "tokens";

export class FirestoreStore {
  /**
   * @param db A Firestore client. Taken rather than built so that the store
   * can be exercised against a double — building the client inside the
   * constructor is also where credentials are picked up, and a test that has
   * to mock a module boundary to avoid that is testing a different program.
   */
  constructor(db) {
    this.db = db;
  }

  async load() {
    // Nothing to read up front — the whole point of moving off a file is not
    // holding every player in memory. This exists so the two stores open the
    // same way, and so a misconfigured project fails at boot rather than on
    // the first player to sign up.
    await this.db.collection(PLAYERS).limit(1).get();
    return this;
  }

  async get(id) {
    const doc = await this.db.collection(PLAYERS).doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async byToken(digest) {
    const index = await this.db.collection(TOKENS).doc(digest).get();
    if (!index.exists) return null;
    return this.get(index.data().id);
  }

  async nameOwner(key) {
    const doc = await this.db.collection(NAMES).doc(key).get();
    return doc.exists ? doc.data().id : null;
  }

  async create(player) {
    const key = nameKey(player.name);
    await this.db.runTransaction(async (tx) => {
      const nameRef = this.db.collection(NAMES).doc(key);
      const held = await tx.get(nameRef);
      if (held.exists && held.data().id !== player.id) throw new NameTakenError();
      tx.set(nameRef, { id: player.id });
      tx.set(this.db.collection(TOKENS).doc(player.tokenHash), { id: player.id });
      tx.set(this.db.collection(PLAYERS).doc(player.id), player);
    });
  }

  async rename(player, name) {
    const from = nameKey(player.name);
    const to = nameKey(name);
    await this.db.runTransaction(async (tx) => {
      const toRef = this.db.collection(NAMES).doc(to);
      const held = await tx.get(toRef);
      if (held.exists && held.data().id !== player.id) throw new NameTakenError();
      if (from !== to) tx.delete(this.db.collection(NAMES).doc(from));
      tx.set(toRef, { id: player.id });
      tx.update(this.db.collection(PLAYERS).doc(player.id), { name });
    });
    player.name = name;
  }

  async save(player) {
    const batch = this.db.batch();
    batch.set(this.db.collection(PLAYERS).doc(player.id), player);
    // A recovery replaces the token, so the new digest is written and the old
    // one is left to be swept. Leaving it would let a lost phone keep playing
    // the account it was just recovered away from, so it is deleted here.
    batch.set(this.db.collection(TOKENS).doc(player.tokenHash), { id: player.id });
    await batch.commit();
  }

  /** Point an old token digest at nothing, after a recovery replaced it. */
  async revokeToken(digest) {
    await this.db.collection(TOKENS).doc(digest).delete();
  }

  async leaderboard(limit) {
    // trophies descending, then oldest account first — the same tie-break the
    // JSON store uses, so a player's rank does not change with the backend.
    const snap = await this.db
      .collection(PLAYERS)
      .orderBy("career.trophies", "desc")
      .orderBy("created", "asc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data());
  }

  async rankOf(id) {
    const player = await this.get(id);
    if (!player) return null;
    // Everyone strictly above, plus everyone level with them who got there
    // first. Two counting queries rather than reading the table: this has to
    // stay cheap when the table is the size the game hopes it will be.
    const above = await this.db
      .collection(PLAYERS)
      .where("career.trophies", ">", player.career.trophies)
      .count()
      .get();
    const level = await this.db
      .collection(PLAYERS)
      .where("career.trophies", "==", player.career.trophies)
      .where("created", "<", player.created)
      .count()
      .get();
    return above.data().count + level.data().count + 1;
  }

  async size() {
    const total = await this.db.collection(PLAYERS).count().get();
    return total.data().count;
  }

  /** Nothing is buffered, so there is nothing to flush. Kept for the interface. */
  async flush() {}

  async close() {
    await this.db.terminate();
  }
}

/** The store production runs: a real client, credentials from the environment. */
export function firestoreStore(projectId, databaseId) {
  return new FirestoreStore(
    new Firestore({
      projectId,
      ...(databaseId ? { databaseId } : {}),
      ignoreUndefinedProperties: true,
    })
  );
}
