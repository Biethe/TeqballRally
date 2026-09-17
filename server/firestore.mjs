import { Firestore } from "@google-cloud/firestore";
import { NameTakenError, nameKey } from "./store.mjs";

/**
 * The store Cloud Run runs on.
 *
 * Same interface as `JsonStore`, six collections:
 *
 *   players/{id}          the record
 *   names/{lowercase}     → { id }, so a name can only be held by one player
 *   tokens/{digest}       → { id }, so authenticating is one read, not a query
 *   clubs/{id}            the club record
 *   clubNames/{lowercase} → { id }, the same uniqueness rule for club names
 *   clubInvites/{code}    → { id }, so joining is one read rather than a scan
 *
 * The index collections exist because Firestore has no unique constraint and
 * no cheap "find by field" — a document id *is* the index. Writing them in a
 * transaction alongside the record is what makes "take this name" an operation
 * that either happens or does not, rather than two writes with a race between
 * them.
 *
 * Credentials come from the environment: on Cloud Run that is the service
 * account, with nothing to configure and no key file to leak.
 */

const PLAYERS = "players";
const NAMES = "names";
const TOKENS = "tokens";
/** Recovery lookup digest → player id, so a code alone finds its account. */
const RECOVERIES = "recoveries";
/** How many players the legacy recovery scan will read. See findLegacyRecovery. */
const LEGACY_SCAN_LIMIT = 2000;
const CLUBS = "clubs";
const CLUB_NAMES = "clubNames";
const CLUB_INVITES = "clubInvites";

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

  async byRecovery(digest) {
    const index = await this.db.collection(RECOVERIES).doc(digest).get();
    if (!index.exists) return null;
    return this.get(index.data().id);
  }

  /**
   * Find an account issued before the lookup index existed.
   *
   * A full read of the players, which is exactly what this store exists to
   * avoid — so it is bounded, and it runs only when the index has already said
   * no. Firestore cannot ask for documents that are *missing* a field, so
   * there is no narrower query to make.
   *
   * A migration shim with a natural end: recovering mints a fresh code, which
   * is written with a lookup, so every account leaves this set the first time
   * it is used. Delete this once none are left.
   */
  async findLegacyRecovery(match) {
    const page = await this.db.collection(PLAYERS).limit(LEGACY_SCAN_LIMIT).get();
    for (const doc of page.docs) {
      const player = doc.data();
      if (player.recoveryLookup) continue;
      if (match(player)) return player;
    }
    return null;
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
      if (player.recoveryLookup) {
        tx.set(this.db.collection(RECOVERIES).doc(player.recoveryLookup), { id: player.id });
      }
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
    // Same for the recovery code, which is spent and replaced every time one
    // is used: the new digest is written and the old one deleted below, so a
    // slip of paper somebody photographed stops finding the account.
    if (player.recoveryLookup) {
      batch.set(this.db.collection(RECOVERIES).doc(player.recoveryLookup), { id: player.id });
    }
    await batch.commit();
  }

  /** Point an old token digest at nothing, after a recovery replaced it. */
  async revokeToken(digest) {
    await this.db.collection(TOKENS).doc(digest).delete();
  }

  /** The same, for the recovery code the replaced one was found by. */
  async revokeRecovery(digest) {
    await this.db.collection(RECOVERIES).doc(digest).delete();
  }

  /** Delete a player from Firestore and purge all index documents. */
  async deletePlayer(player) {
    const key = nameKey(player.name);
    const batch = this.db.batch();
    batch.delete(this.db.collection(PLAYERS).doc(player.id));
    batch.delete(this.db.collection(NAMES).doc(key));
    if (player.tokenHash) {
      batch.delete(this.db.collection(TOKENS).doc(player.tokenHash));
    }
    if (player.recoveryLookup) {
      batch.delete(this.db.collection(RECOVERIES).doc(player.recoveryLookup));
    }
    await batch.commit();
  }

  // ---- clubs ----
  //
  // Same shape as the players above and for the same reasons: the two index
  // collections exist because Firestore has no unique constraint and no cheap
  // find-by-field, and they are written inside the transaction so that taking
  // a club name is one operation rather than a race.

  async getClub(id) {
    const doc = await this.db.collection(CLUBS).doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async clubByInvite(code) {
    const index = await this.db.collection(CLUB_INVITES).doc(code).get();
    if (!index.exists) return null;
    return this.getClub(index.data().id);
  }

  async createClub(club) {
    const key = nameKey(club.name);
    await this.db.runTransaction(async (tx) => {
      const nameRef = this.db.collection(CLUB_NAMES).doc(key);
      const held = await tx.get(nameRef);
      if (held.exists && held.data().id !== club.id) throw new NameTakenError();
      tx.set(nameRef, { id: club.id });
      tx.set(this.db.collection(CLUB_INVITES).doc(club.invite), { id: club.id });
      tx.set(this.db.collection(CLUBS).doc(club.id), club);
    });
  }

  async saveClub(club, opts = {}) {
    const batch = this.db.batch();
    batch.set(this.db.collection(CLUBS).doc(club.id), club);
    batch.set(this.db.collection(CLUB_INVITES).doc(club.invite), { id: club.id });
    // A rotated invite has to stop resolving, or the code the owner just
    // replaced still lets people in — which is the entire point of rotating.
    if (opts.previousInvite && opts.previousInvite !== club.invite) {
      batch.delete(this.db.collection(CLUB_INVITES).doc(opts.previousInvite));
    }
    await batch.commit();
  }

  async renameClub(club, name) {
    const from = nameKey(club.name);
    const to = nameKey(name);
    await this.db.runTransaction(async (tx) => {
      const toRef = this.db.collection(CLUB_NAMES).doc(to);
      const held = await tx.get(toRef);
      if (held.exists && held.data().id !== club.id) throw new NameTakenError();
      if (from !== to) tx.delete(this.db.collection(CLUB_NAMES).doc(from));
      tx.set(toRef, { id: club.id });
      tx.update(this.db.collection(CLUBS).doc(club.id), { name });
    });
    club.name = name;
  }

  async deleteClub(club) {
    const batch = this.db.batch();
    batch.delete(this.db.collection(CLUBS).doc(club.id));
    batch.delete(this.db.collection(CLUB_NAMES).doc(nameKey(club.name)));
    batch.delete(this.db.collection(CLUB_INVITES).doc(club.invite));
    await batch.commit();
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
