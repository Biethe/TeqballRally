import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonStore, type PlayerRecord } from "../server/store.mjs";
import { ValidationError, register } from "../server/accounts.mjs";
import {
  CLUB_NAME_MAX,
  MAX_CLUB_MEMBERS,
  clubOf,
  clubView,
  createClub,
  joinClub,
  leaveClub,
  looksLikeInvite,
  normaliseClubName,
  removeMember,
  renameClub,
  rotateInvite,
  tidyInvite,
} from "../server/clubs.mjs";
import { arrived, reset as resetPresence } from "../server/presence.mjs";

/**
 * Clubs.
 *
 * Ten people by invitation, which makes the interesting cases the edges of
 * that sentence: the eleventh, the owner walking out, and a code that was
 * shared with somebody it should not have been.
 */

let dir: string;
let store: JsonStore;

async function player(name: string): Promise<PlayerRecord> {
  return (await register(store, name)).player;
}

/** A club with an owner, handed back together so tests can name both. */
async function clubOfOne(name = "Rooftop Teq") {
  const owner = await player("Owner");
  const club = await createClub(store, owner, name);
  return { owner, club };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teq-clubs-"));
  store = new JsonStore(join(dir, "players.json"));
  resetPresence();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("club names", () => {
  it("takes an ordinary name and tidies the spacing", () => {
    expect(normaliseClubName("  Paris   Rooftop Teq ")).toBe("Paris Rooftop Teq");
  });

  it("allows a longer name than a player has", () => {
    // A club name is a group's name, not a handle, and it is only ever drawn
    // on its own line.
    expect(normaliseClubName("A".repeat(CLUB_NAME_MAX))).toHaveLength(CLUB_NAME_MAX);
    expect(() => normaliseClubName("A".repeat(CLUB_NAME_MAX + 1))).toThrow(ValidationError);
  });

  it("refuses one that is too short, or shaped wrong", () => {
    expect(() => normaliseClubName("no")).toThrow(ValidationError);
    expect(() => normaliseClubName(" -leading")).toThrow(ValidationError);
    expect(() => normaliseClubName("trailing- ")).toThrow(ValidationError);
    expect(() => normaliseClubName(42)).toThrow(ValidationError);
  });

  it("says what it is complaining about", () => {
    // "name must be 3-16 characters" on a club form is a message about the
    // wrong field.
    expect(() => normaliseClubName("x")).toThrow(/club name/);
  });

  it("will not hand the same name to two clubs", async () => {
    await clubOfOne("Rooftop Teq");
    const other = await player("Other");
    await expect(createClub(store, other, "rooftop teq")).rejects.toThrow(/taken/);
  });
});

describe("invite codes", () => {
  it("folds the three letters Crockford folds, and leaves Q alone", () => {
    // O reads as zero, I and L read as one. Q is *in* the alphabet, and
    // folding it would make any code containing one impossible to type back.
    expect(tidyInvite("ol i-q")).toBe("011Q");
    expect(tidyInvite("q7z9wy")).toBe("Q7Z9WY");
  });

  it("recognises the shape, and only that shape", () => {
    expect(looksLikeInvite("Q7Z9WY")).toBe(true);
    expect(looksLikeInvite("Q7Z9W")).toBe(false);
    expect(looksLikeInvite("Q7Z9WYA")).toBe(false);
    // The letters Crockford leaves out never appear in a minted code.
    expect(looksLikeInvite("Q7Z9WU")).toBe(false);
  });

  it("mints one that survives being read out loud", async () => {
    const { club } = await clubOfOne();
    expect(looksLikeInvite(club.invite)).toBe(true);
    expect(tidyInvite(club.invite)).toBe(club.invite);
  });
});

describe("making and joining a club", () => {
  it("makes the founder the owner and the first member", async () => {
    const { owner, club } = await clubOfOne();

    expect(club.ownerId).toBe(owner.id);
    expect(club.members).toEqual([owner.id]);
    expect(owner.clubId).toBe(club.id);
  });

  it("lets somebody in with the invite code", async () => {
    const { club } = await clubOfOne();
    const joiner = await player("Joiner");
    await joinClub(store, joiner, club.invite);

    expect(joiner.clubId).toBe(club.id);
    expect((await store.getClub(club.id))!.members).toContain(joiner.id);
  });

  it("takes a code typed the way a person types one", async () => {
    const { club } = await clubOfOne();
    const joiner = await player("Joiner");
    // Lower case, with a stray space in the middle.
    const typed = `${club.invite.slice(0, 3).toLowerCase()} ${club.invite.slice(3)}`;
    await joinClub(store, joiner, typed);

    expect(joiner.clubId).toBe(club.id);
  });

  it("refuses a code nobody holds", async () => {
    const joiner = await player("Joiner");
    await expect(joinClub(store, joiner, "ZZZZZZ")).rejects.toThrow(/no club/);
    expect(joiner.clubId).toBeNull();
  });

  it("refuses something that is not a code at all, without a lookup", async () => {
    const joiner = await player("Joiner");
    await expect(joinClub(store, joiner, "hello")).rejects.toThrow(/not an invite code/);
  });

  it("keeps a player in one club at a time", async () => {
    const { club } = await clubOfOne("First Club");
    const other = await player("Other");
    await createClub(store, other, "Second Club");

    await expect(joinClub(store, other, club.invite)).rejects.toThrow(/leave your club/);
  });

  it("stops at ten", async () => {
    const { club } = await clubOfOne();
    for (let i = 1; i < MAX_CLUB_MEMBERS; i++) {
      await joinClub(store, await player(`Member ${i}`), club.invite);
    }
    expect((await store.getClub(club.id))!.members).toHaveLength(MAX_CLUB_MEMBERS);

    const eleventh = await player("Eleventh");
    await expect(joinClub(store, eleventh, club.invite)).rejects.toThrow(/full/);
    expect(eleventh.clubId).toBeNull();
  });

  it("lets somebody back in after a member leaves", async () => {
    // A full club is a thing that happens; a permanently full one is a bug.
    const { club } = await clubOfOne();
    const members: PlayerRecord[] = [];
    for (let i = 1; i < MAX_CLUB_MEMBERS; i++) {
      const p = await player(`Member ${i}`);
      await joinClub(store, p, club.invite);
      members.push(p);
    }
    await leaveClub(store, members[0]);

    const late = await player("Late");
    await joinClub(store, late, club.invite);
    expect(late.clubId).toBe(club.id);
  });
});

describe("leaving", () => {
  it("takes a member off the roster and clears their pointer", async () => {
    const { club } = await clubOfOne();
    const joiner = await player("Joiner");
    await joinClub(store, joiner, club.invite);
    await leaveClub(store, joiner);

    expect(joiner.clubId).toBeNull();
    expect((await store.getClub(club.id))!.members).not.toContain(joiner.id);
  });

  it("hands the club on when the owner goes, rather than closing it", async () => {
    // Nine people must not lose their club because one person moved on.
    const { owner, club } = await clubOfOne();
    const second = await player("Second");
    const third = await player("Third");
    await joinClub(store, second, club.invite);
    await joinClub(store, third, club.invite);

    await leaveClub(store, owner);
    const after = (await store.getClub(club.id))!;

    // The longest-serving member left, which is the one who joined first.
    expect(after.ownerId).toBe(second.id);
    expect(after.members).toEqual([second.id, third.id]);
  });

  it("disbands when the last member leaves", async () => {
    const { owner, club } = await clubOfOne();
    await leaveClub(store, owner);

    expect(await store.getClub(club.id)).toBeNull();
    expect(owner.clubId).toBeNull();
    // And the name comes free, rather than being held by nothing.
    const next = await player("Next");
    await expect(createClub(store, next, club.name)).resolves.toBeTruthy();
  });

  it("frees the invite code when the club goes", async () => {
    const { owner, club } = await clubOfOne();
    const invite = club.invite;
    await leaveClub(store, owner);

    const hopeful = await player("Hopeful");
    await expect(joinClub(store, hopeful, invite)).rejects.toThrow(/no club/);
  });

  it("refuses to leave a club you are not in", async () => {
    const loner = await player("Loner");
    await expect(leaveClub(store, loner)).rejects.toThrow(/not in a club/);
  });
});

describe("the owner's powers", () => {
  it("puts somebody out", async () => {
    const { owner, club } = await clubOfOne();
    const joiner = await player("Joiner");
    await joinClub(store, joiner, club.invite);

    await removeMember(store, owner, joiner.id);
    expect(joiner.clubId).toBeNull();
    expect((await store.getClub(club.id))!.members).not.toContain(joiner.id);
  });

  it("and nobody else can", async () => {
    const { owner, club } = await clubOfOne();
    const joiner = await player("Joiner");
    const third = await player("Third");
    await joinClub(store, joiner, club.invite);
    await joinClub(store, third, club.invite);

    await expect(removeMember(store, joiner, third.id)).rejects.toThrow(/owner/);
    expect(third.clubId).toBe(club.id);
    // Nor can they rename it, or replace the code people are using.
    await expect(renameClub(store, joiner, "Hijacked")).rejects.toThrow(/owner/);
    await expect(rotateInvite(store, joiner)).rejects.toThrow(/owner/);
    expect(owner.clubId).toBe(club.id);
  });

  it("cannot remove themselves, which is what leaving is for", async () => {
    const { owner } = await clubOfOne();
    await expect(removeMember(store, owner, owner.id)).rejects.toThrow(/leave the club/);
  });

  it("refuses somebody who is not in the club", async () => {
    const { owner } = await clubOfOne();
    const stranger = await player("Stranger");
    await expect(removeMember(store, owner, stranger.id)).rejects.toThrow(/not in this club/);
  });

  it("rotates the code, and the old one stops working", async () => {
    // The answer to a leaked invite. Without this, a code that got out is a
    // club that can never be closed again.
    const { owner, club } = await clubOfOne();
    const leaked = club.invite;
    await rotateInvite(store, owner);

    expect(club.invite).not.toBe(leaked);
    const walkIn = await player("Walk In");
    await expect(joinClub(store, walkIn, leaked)).rejects.toThrow(/no club/);
    await joinClub(store, walkIn, club.invite);
    expect(walkIn.clubId).toBe(club.id);
  });

  it("renames the club, and frees the old name", async () => {
    const { owner, club } = await clubOfOne("Old Name");
    await renameClub(store, owner, "New Name");

    expect((await store.getClub(club.id))!.name).toBe("New Name");
    const other = await player("Other");
    await expect(createClub(store, other, "Old Name")).resolves.toBeTruthy();
  });

  it("will not rename onto a name somebody else holds", async () => {
    const { owner } = await clubOfOne("Ours");
    const other = await player("Other");
    await createClub(store, other, "Theirs");

    await expect(renameClub(store, owner, "Theirs")).rejects.toThrow(/taken/);
  });
});

describe("the club board", () => {
  it("ranks members by trophies, not by when they joined", async () => {
    const { owner, club } = await clubOfOne();
    const strong = await player("Strong");
    await joinClub(store, strong, club.invite);
    strong.career = { ...strong.career, trophies: 900 };
    await store.save(strong);
    owner.career = { ...owner.career, trophies: 100 };
    await store.save(owner);

    const view = await clubView(store, club, owner.id);
    expect(view.members.map((m) => m.name)).toEqual(["Strong", "Owner"]);
  });

  it("marks the owner rather than pinning them to the top", async () => {
    // Being in charge is not the same as being top, and pretending otherwise
    // would make the ranking a lie.
    const { owner, club } = await clubOfOne();
    const strong = await player("Strong");
    await joinClub(store, strong, club.invite);
    strong.career = { ...strong.career, trophies: 900 };
    await store.save(strong);

    const view = await clubView(store, club, owner.id);
    expect(view.members[0].name).toBe("Strong");
    expect(view.members[0].owner).toBe(false);
    expect(view.members.find((m) => m.owner)?.name).toBe("Owner");
  });

  it("adds up what the club is worth, and counts who is on right now", async () => {
    const { owner, club } = await clubOfOne();
    const second = await player("Second");
    await joinClub(store, second, club.invite);
    owner.career = { ...owner.career, trophies: 300 };
    second.career = { ...second.career, trophies: 120 };
    await store.save(owner);
    await store.save(second);
    arrived(second.id);

    const view = await clubView(store, club, owner.id);
    expect(view.trophies).toBe(420);
    expect(view.online).toBe(1);
    expect(view.full).toBe(false);
  });

  it("shows the invite code to the owner and to nobody else", async () => {
    const { owner, club } = await clubOfOne();
    const joiner = await player("Joiner");
    await joinClub(store, joiner, club.invite);

    expect((await clubView(store, club, owner.id)).invite).toBe(club.invite);
    // Everybody can share a club they are in; one person decides who is in it.
    expect((await clubView(store, club, joiner.id)).invite).toBeNull();
  });

  it("never leaks a secret", async () => {
    const issued = await register(store, "Secretive");
    const club = await createClub(store, issued.player, "Quiet Club");
    const json = JSON.stringify(await clubView(store, club, issued.player.id));

    expect(json).not.toContain(issued.token);
    expect(json).not.toContain("Hash");
  });

  it("survives a member whose record has gone", async () => {
    const { owner, club } = await clubOfOne();
    club.members = [...club.members, "GONEGONE"];
    await store.saveClub(club);

    const view = await clubView(store, club, owner.id);
    expect(view.members).toHaveLength(1);
  });
});

describe("a club that is not there any more", () => {
  it("reads as no club, and tidies the pointer", async () => {
    // The club was disbanded while this player was away. Reporting a club that
    // is not there would leave them on a screen with nothing behind it.
    const { owner, club } = await clubOfOne();
    const joiner = await player("Joiner");
    await joinClub(store, joiner, club.invite);
    await removeMember(store, owner, joiner.id);
    joiner.clubId = "DEADBEEF";

    expect(await clubOf(store, joiner)).toBeNull();
    expect(joiner.clubId).toBeNull();
  });
});

describe("clubs across a restart", () => {
  it("keeps the roster, the name and the code", async () => {
    const { club } = await clubOfOne("Persistent Club");
    const joiner = await player("Joiner");
    await joinClub(store, joiner, club.invite);
    await store.flush();

    const reopened = await new JsonStore(join(dir, "players.json")).load();
    const found = await reopened.getClub(club.id);
    expect(found?.name).toBe("Persistent Club");
    expect(found?.members).toHaveLength(2);
    // And the indexes are rebuilt, not just the record.
    expect((await reopened.clubByInvite(club.invite))?.id).toBe(club.id);
    const other = await player("Other");
    await expect(createClub(reopened, other, "Persistent Club")).rejects.toThrow(/taken/);
  });
});
