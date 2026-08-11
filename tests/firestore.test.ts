import { describe, expect, it } from "vitest";
import { NameTakenError } from "../server/store.mjs";
import { FirestoreStore } from "../server/firestore.mjs";

/* The double below stands in for a client whose whole surface is async and
   whose types are the SDK's, so its methods are async without awaiting and its
   documents are untyped. Both are properties of the thing being imitated. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-this-alias, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

/**
 * The Firestore store, against a double.
 *
 * This is not a claim that the code works against Google's Firestore — nothing
 * short of pointing it at one proves that, and it will be pointed at one
 * before it carries a player. What it does check is the part that is mine: the
 * shape of every read and write, that the name index is taken inside a
 * transaction rather than beside it, and that a recovered token replaces the
 * old one instead of joining it.
 *
 * The double implements only the handful of Firestore calls the store makes,
 * and throws on anything else, so a query the double does not understand fails
 * here rather than in production.
 */

interface Doc {
  [key: string]: unknown;
}

/** A deliberately small stand-in: collections of documents, and nothing else. */
class FakeFirestore {
  readonly data = new Map<string, Map<string, Doc>>();
  /** Every operation, in order, so a test can assert on how it was done. */
  readonly log: string[] = [];

  collection(name: string) {
    if (!this.data.has(name)) this.data.set(name, new Map());
    const docs = this.data.get(name)!;
    const self = this;
    return {
      doc(id: string) {
        // A real DocumentReference can be read and written on its own as well
        // as inside a transaction or a batch, and the store uses both.
        return {
          __collection: name,
          __id: id,
          __docs: docs,
          async get() {
            self.log.push(`get ${name}/${id}`);
            const doc = docs.get(id);
            return { exists: doc !== undefined, data: () => doc };
          },
          async set(value: Doc) {
            self.log.push(`set ${name}/${id}`);
            docs.set(id, value);
          },
          async delete() {
            self.log.push(`delete ${name}/${id}`);
            docs.delete(id);
          },
        };
      },
      orderBy(field: string, dir: string) {
        return self.query(name, [], [[field, dir]]);
      },
      where(field: string, op: string, value: unknown) {
        return self.query(name, [[field, op, value]], []);
      },
      count() {
        return self.query(name, [], []).count();
      },
      limit(n: number) {
        return self.query(name, [], []).limit(n);
      },
    };
  }

  query(name: string, filters: [string, string, unknown][], orders: [string, string][]) {
    const self = this;
    const q = {
      where: (f: string, op: string, v: unknown) =>
        self.query(name, [...filters, [f, op, v]], orders),
      orderBy: (f: string, dir: string) => self.query(name, filters, [...orders, [f, dir]]),
      limit: (n: number) => ({ get: async () => self.run(name, filters, orders, n) }),
      count: () => ({
        get: async () => {
          self.log.push(`count ${name} ${JSON.stringify(filters)}`);
          const rows = await self.run(name, filters, orders, Infinity);
          return { data: () => ({ count: rows.docs.length }) };
        },
      }),
      get: async () => self.run(name, filters, orders, Infinity),
    };
    return q;
  }

  /** Read a possibly-nested field path, the way Firestore's own queries do. */
  static read(doc: Doc, path: string): unknown {
    return path.split(".").reduce<unknown>((v, key) => (v as Doc | undefined)?.[key], doc);
  }

  async run(
    name: string,
    filters: [string, string, unknown][],
    orders: [string, string][],
    limit: number
  ) {
    this.log.push(`query ${name} ${JSON.stringify({ filters, orders, limit })}`);
    let rows = [...(this.data.get(name) ?? new Map()).values()];
    for (const [field, op, value] of filters) {
      rows = rows.filter((doc) => {
        const v = FakeFirestore.read(doc, field) as number;
        if (op === ">") return v > (value as number);
        if (op === "<") return v < (value as number);
        if (op === "==") return v === value;
        throw new Error(`the double does not implement the operator ${op}`);
      });
    }
    for (const [field, dir] of [...orders].reverse()) {
      rows.sort((a, b) => {
        const av = FakeFirestore.read(a, field) as number;
        const bv = FakeFirestore.read(b, field) as number;
        return dir === "desc" ? bv - av : av - bv;
      });
    }
    const slice = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
    return { docs: slice.map((d) => ({ data: () => d })) };
  }

  async runTransaction(fn: (tx: unknown) => Promise<void>) {
    // Serial and non-retrying, which is enough: what is being checked is that
    // the reads and writes are inside one, not that Firestore retries it.
    const pending: (() => void)[] = [];
    const tx = {
      get: async (ref: { __docs: Map<string, Doc>; __id: string }) => {
        this.log.push(`tx.get ${ref.__id}`);
        const doc = ref.__docs.get(ref.__id);
        return { exists: doc !== undefined, data: () => doc };
      },
      set: (ref: { __docs: Map<string, Doc>; __id: string }, value: Doc) => {
        this.log.push(`tx.set ${ref.__id}`);
        pending.push(() => ref.__docs.set(ref.__id, value));
      },
      update: (ref: { __docs: Map<string, Doc>; __id: string }, patch: Doc) => {
        this.log.push(`tx.update ${ref.__id}`);
        pending.push(() => ref.__docs.set(ref.__id, { ...ref.__docs.get(ref.__id), ...patch }));
      },
      delete: (ref: { __docs: Map<string, Doc>; __id: string }) => {
        this.log.push(`tx.delete ${ref.__id}`);
        pending.push(() => ref.__docs.delete(ref.__id));
      },
    };
    await fn(tx);
    for (const apply of pending) apply();
  }

  batch() {
    const pending: (() => void)[] = [];
    return {
      set: (ref: { __docs: Map<string, Doc>; __id: string }, value: Doc) => {
        this.log.push(`batch.set ${ref.__id}`);
        pending.push(() => ref.__docs.set(ref.__id, value));
      },
      delete: (ref: { __docs: Map<string, Doc>; __id: string }) => {
        this.log.push(`batch.delete ${ref.__id}`);
        pending.push(() => ref.__docs.delete(ref.__id));
      },
      commit: async () => {
        for (const apply of pending) apply();
      },
    };
  }

  async terminate() {}
}

/** The store, holding the double instead of a real client. */
async function openFake() {
  const fake = new FakeFirestore();
  const store = await new FirestoreStore(fake).load();
  return { store, fake };
}

const record = (over: Record<string, unknown> = {}) => ({
  id: "AAAA1111",
  name: "Ana",
  tokenHash: "digest-1",
  recoverySalt: "s",
  recoveryHash: "h",
  created: 1000,
  lastSeen: 1000,
  lastMatchAt: 0,
  matches: 0,
  friends: [],
  career: {
    coins: 0,
    trophies: 0,
    best: 0,
    champions: {},
    day: "2026-08-10",
    progress: {},
    claimed: [],
    season: "2026-08",
    seasonBest: 0,
    titles: [],
  },
  ...over,
});

describe("the Firestore store", () => {
  it("writes the player and both indexes when it creates one", async () => {
    const { store } = await openFake();
    await store.create(record());

    expect(await store.get("AAAA1111")).toMatchObject({ name: "Ana" });
    expect(await store.nameOwner("ana")).toBe("AAAA1111");
    expect(await store.byToken("digest-1")).toMatchObject({ id: "AAAA1111" });
  });

  it("takes the name inside the transaction, not beside it", async () => {
    // Two writes with a gap between them is a race, and the race is exactly
    // two people claiming the same name at once.
    const { store, fake } = await openFake();
    await store.create(record());

    const read = fake.log.indexOf("tx.get ana");
    const write = fake.log.indexOf("tx.set ana");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(read);
  });

  it("refuses a name somebody else is holding", async () => {
    const { store } = await openFake();
    await store.create(record());

    await expect(store.create(record({ id: "BBBB2222", name: "ANA" }))).rejects.toThrow(
      NameTakenError
    );
  });

  it("frees the old name when one is changed", async () => {
    const { store } = await openFake();
    const player = record();
    await store.create(player);
    await store.rename(player, "Bea");

    expect(await store.nameOwner("ana")).toBeNull();
    expect(await store.nameOwner("bea")).toBe("AAAA1111");
    expect(player.name).toBe("Bea");
  });

  it("lets a player rename to a different case of their own name", async () => {
    const { store } = await openFake();
    const player = record();
    await store.create(player);

    await expect(store.rename(player, "ANA")).resolves.toBeUndefined();
    expect(await store.nameOwner("ana")).toBe("AAAA1111");
  });

  it("points the token index at the new digest when one is saved", async () => {
    const { store } = await openFake();
    const player = record();
    await store.create(player);

    player.tokenHash = "digest-2";
    await store.save(player);

    expect(await store.byToken("digest-2")).toMatchObject({ id: "AAAA1111" });
  });

  it("revokes the digest a recovery replaced", async () => {
    // Without this the phone the account was recovered away from keeps
    // playing it.
    const { store } = await openFake();
    const player = record();
    await store.create(player);
    player.tokenHash = "digest-2";
    await store.save(player);
    await store.revokeToken("digest-1");

    expect(await store.byToken("digest-1")).toBeNull();
  });

  it("orders the leaderboard the way the other store does", async () => {
    const { store } = await openFake();
    await store.create(record({ id: "A", name: "A", tokenHash: "ta", created: 1, career: { ...record().career, trophies: 10 } }));
    await store.create(record({ id: "B", name: "B", tokenHash: "tb", created: 2, career: { ...record().career, trophies: 30 } }));
    await store.create(record({ id: "C", name: "C", tokenHash: "tc", created: 3, career: { ...record().career, trophies: 10 } }));

    const rows = await store.leaderboard(10);
    expect(rows.map((r) => r.id)).toEqual(["B", "A", "C"]);
  });

  it("counts a rank without reading the whole table", async () => {
    const { store, fake } = await openFake();
    await store.create(record({ id: "A", name: "A", tokenHash: "ta", created: 1, career: { ...record().career, trophies: 10 } }));
    await store.create(record({ id: "B", name: "B", tokenHash: "tb", created: 2, career: { ...record().career, trophies: 30 } }));
    await store.create(record({ id: "C", name: "C", tokenHash: "tc", created: 3, career: { ...record().career, trophies: 10 } }));

    expect(await store.rankOf("B")).toBe(1);
    expect(await store.rankOf("A")).toBe(2);
    // …and the tie goes to whoever got there first.
    expect(await store.rankOf("C")).toBe(3);
    // Counting queries, not a full read: this has to stay cheap at the size
    // the game hopes the table reaches. The only document it may fetch is the
    // player whose rank was asked for.
    const forRank = fake.log.slice(fake.log.lastIndexOf("get players/C"));
    expect(forRank.filter((line) => line.startsWith("count "))).toHaveLength(2);
    expect(forRank.filter((line) => line.startsWith("query "))).toHaveLength(2);
  });

  it("has nothing to say about a player who does not exist", async () => {
    const { store } = await openFake();
    expect(await store.get("NOBODY00")).toBeNull();
    expect(await store.byToken("nope")).toBeNull();
    expect(await store.rankOf("NOBODY00")).toBeNull();
  });
});

describe("clubs in Firestore", () => {
  const club = (over: Record<string, unknown> = {}) => ({
    id: "CLUB0001",
    name: "Rooftop Teq",
    ownerId: "AAAA1111",
    members: ["AAAA1111"],
    invite: "Q7Z9WY",
    created: 2000,
    ...over,
  });

  it("writes the club and both its indexes in one transaction", async () => {
    // The same reason as players: Firestore has no unique constraint, so the
    // name index has to be taken inside the transaction or two clubs race for
    // it and both win.
    const { store, fake } = await openFake();
    await store.createClub(club());

    expect(fake.log).toContain("tx.get rooftop teq");
    expect(fake.log).toContain("tx.set rooftop teq");
    expect(fake.log).toContain("tx.set Q7Z9WY");
    expect(fake.log).toContain("tx.set CLUB0001");
    expect(fake.data.get("clubs")!.get("CLUB0001")).toBeTruthy();
  });

  it("refuses a name another club already holds", async () => {
    const { store } = await openFake();
    await store.createClub(club());
    await expect(store.createClub(club({ id: "CLUB0002", invite: "AAAAAA" }))).rejects.toThrow(
      NameTakenError
    );
  });

  it("finds a club by its invite code in one read of the index", async () => {
    const { store } = await openFake();
    await store.createClub(club());

    expect((await store.clubByInvite("Q7Z9WY"))?.id).toBe("CLUB0001");
    expect(await store.clubByInvite("NOPE00")).toBeNull();
  });

  it("stops the old code resolving when the invite is rotated", async () => {
    // A replaced invite that still lets people in has not been replaced, which
    // is the entire point of being able to rotate one.
    const { store } = await openFake();
    const c = club();
    await store.createClub(c);
    const previous = c.invite;
    c.invite = "NEW111";
    await store.saveClub(c, { previousInvite: previous });

    expect(await store.clubByInvite(previous)).toBeNull();
    expect((await store.clubByInvite("NEW111"))?.id).toBe("CLUB0001");
  });

  it("leaves the code alone on an ordinary save", async () => {
    const { store } = await openFake();
    const c = club();
    await store.createClub(c);
    c.members = [...c.members, "BBBB2222"];
    await store.saveClub(c);

    expect((await store.clubByInvite("Q7Z9WY"))?.members).toHaveLength(2);
  });

  it("moves the name index when a club is renamed", async () => {
    const { store } = await openFake();
    const c = club();
    await store.createClub(c);
    await store.renameClub(c, "Cellar Teq");

    expect((await store.getClub("CLUB0001"))?.name).toBe("Cellar Teq");
    expect(c.name).toBe("Cellar Teq");
    // The old name is free, and taking it is not blocked by a stale index.
    await expect(
      store.createClub(club({ id: "CLUB0002", name: "Rooftop Teq", invite: "AAAAAA" }))
    ).resolves.toBeUndefined();
  });

  it("will not rename onto a name another club holds", async () => {
    const { store } = await openFake();
    const first = club();
    await store.createClub(first);
    await store.createClub(club({ id: "CLUB0002", name: "Cellar Teq", invite: "AAAAAA" }));

    await expect(store.renameClub(first, "Cellar Teq")).rejects.toThrow(NameTakenError);
  });

  it("takes the record and both indexes away when a club is disbanded", async () => {
    // A leftover index entry is a name nobody can have and a code that
    // resolves to nothing.
    const { store } = await openFake();
    const c = club();
    await store.createClub(c);
    await store.deleteClub(c);

    expect(await store.getClub("CLUB0001")).toBeNull();
    expect(await store.clubByInvite("Q7Z9WY")).toBeNull();
    await expect(
      store.createClub(club({ id: "CLUB0002", invite: "AAAAAA" }))
    ).resolves.toBeUndefined();
  });
});
