/**
 * Clubs.
 *
 * Ten people, by invitation, with a board of their own. That is the whole
 * feature, and the size is the design: a club of ten is a group where every
 * name means something to everybody else, and where being fourth is a fact
 * about people you know rather than a number. A club of five hundred is a
 * chat room with a leaderboard attached, and the game already has a
 * leaderboard.
 *
 * **Invitation is a code, not a request-and-accept.** The same reasoning as
 * friends (`addFriend` in `accounts.mjs`): a club's invite code is not
 * published anywhere, so anybody typing one already got it from a member.
 * Building a request queue, a notification for it and a screen to approve it
 * would be three more surfaces protecting a permission that was already given
 * when the code was shared.
 *
 * What that costs is a leaked code, and the answer to a leaked code is that
 * the owner rotates it and removes whoever walked in. Both are one press. So
 * the club keeps two identifiers: an `id` that never changes and that
 * `player.clubId` points at, and an `invite` that is meant to be thrown away.
 * Rotating an invite that doubled as the id would orphan every member.
 */

import { randomBytes } from "node:crypto";
import { NameTakenError } from "./store.mjs";
import { ValidationError, normaliseName, publicProfile } from "./accounts.mjs";

/** Crockford base32 — no I, L, O or U, so a code survives being read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 8;
/**
 * Length of the invite code.
 *
 * Shorter than a player code because this one is typed in by somebody who was
 * told it, often out loud, and every character is a chance to give up. Six
 * Crockford characters is a billion codes — for a namespace holding the clubs
 * of one game, guessing one is not the attack to worry about, and rotation is
 * there for when a code gets out by the way they actually get out.
 */
const INVITE_LENGTH = 6;

/**
 * Most members a club may hold.
 *
 * Ten, and not configurable. It is the feature, not a tuning parameter: the
 * board fits on a phone without scrolling, and a full club is a thing that
 * happens — which is what makes a place in one worth something.
 */
export const MAX_CLUB_MEMBERS = 10;

export const CLUB_NAME_MIN = 3;
export const CLUB_NAME_MAX = 20;

function mintCode(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

async function mintClubId(store) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const id = mintCode(ID_LENGTH);
    if (!(await store.getClub(id))) return id;
  }
  throw new ValidationError("could not allocate a club id, try again", 503);
}

async function mintInvite(store) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const code = mintCode(INVITE_LENGTH);
    if (!(await store.clubByInvite(code))) return code;
  }
  throw new ValidationError("could not allocate an invite code, try again", 503);
}

/**
 * A club name, held to the same shape as a player name but a little longer.
 *
 * Longer because a club name is a group's name rather than a handle — "Paris
 * Rooftop Teq" is the sort of thing people actually type — and it is only ever
 * drawn on its own line, not squeezed beside a score.
 */
export function normaliseClubName(raw) {
  const name = normaliseName(raw, { min: CLUB_NAME_MIN, max: CLUB_NAME_MAX, what: "club name" });
  return name;
}

/** Tidy a typed invite code the way the player probably meant it. */
export function tidyInvite(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    // The three Crockford folds: O reads as zero, I and L read as one. Q is in
    // the alphabet and is left alone — folding it away would make any code
    // containing one impossible to type back in.
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function looksLikeInvite(code) {
  return new RegExp(`^[0-9A-HJKMNP-TV-Z]{${INVITE_LENGTH}}$`).test(code);
}

/** The club a player is in, or null. Total: a dangling id reads as no club. */
export async function clubOf(store, player) {
  if (!player.clubId) return null;
  const club = await store.getClub(player.clubId);
  if (!club) {
    // The club was disbanded while this player was away. Tidy the pointer
    // rather than reporting a club that is not there.
    player.clubId = null;
    await store.save(player);
    return null;
  }
  return club;
}

/**
 * The club as its members see it: the roster, ordered, and what it adds up to.
 *
 * Ordered by trophies rather than by join date, because the board is the point
 * of the club and a board in the order people arrived is a list. The owner is
 * marked rather than pinned — being in charge is not the same as being top,
 * and pretending otherwise would make the ranking a lie.
 *
 * `invite` is only included for the owner. Everybody can share a club they are
 * in, but only one person should be deciding who is in it.
 */
export async function clubView(store, club, viewerId) {
  const found = await Promise.all(club.members.map((id) => store.get(id)));
  const members = found
    .filter((p) => p !== null)
    .map((p) => ({ ...publicProfile(p), owner: p.id === club.ownerId }))
    .sort((a, b) => b.trophies - a.trophies || a.name.localeCompare(b.name));
  return {
    id: club.id,
    name: club.name,
    ownerId: club.ownerId,
    created: club.created,
    members,
    /** Every member's trophies added up — the number a club is proud of. */
    trophies: members.reduce((sum, m) => sum + m.trophies, 0),
    online: members.filter((m) => m.online).length,
    full: members.length >= MAX_CLUB_MEMBERS,
    /** Present only for the owner; everyone else is shown nothing to leak. */
    invite: club.ownerId === viewerId ? club.invite : null,
  };
}

/** Refuse anything that would put a player in two clubs at once. */
function mustBeClubless(player) {
  if (player.clubId) {
    throw new ValidationError("leave your club before joining another", 409);
  }
}

function mustOwn(club, player) {
  if (club.ownerId !== player.id) {
    throw new ValidationError("only the club owner can do that", 403);
  }
}

/** Start a club. The player who makes it owns it and is its first member. */
export async function createClub(store, player, rawName, now = new Date()) {
  mustBeClubless(player);
  const name = normaliseClubName(rawName);
  const club = {
    id: await mintClubId(store),
    name,
    ownerId: player.id,
    // Join order, owner first. Only used to decide who inherits the club.
    members: [player.id],
    invite: await mintInvite(store),
    created: now.getTime(),
  };
  try {
    await store.createClub(club);
  } catch (err) {
    if (err instanceof NameTakenError) throw new ValidationError("that club name is taken", 409);
    throw err;
  }
  player.clubId = club.id;
  await store.save(player);
  return club;
}

/** Join by invite code. Mutual immediately, for the reason at the top. */
export async function joinClub(store, player, rawCode) {
  mustBeClubless(player);
  const code = tidyInvite(rawCode);
  if (!looksLikeInvite(code)) throw new ValidationError("that is not an invite code");
  const club = await store.clubByInvite(code);
  if (!club) throw new ValidationError("no club with that invite code", 404);
  if (club.members.includes(player.id)) return club;
  if (club.members.length >= MAX_CLUB_MEMBERS) {
    throw new ValidationError(`that club is full (${MAX_CLUB_MEMBERS} members)`, 409);
  }
  club.members = [...club.members, player.id];
  await store.saveClub(club);
  player.clubId = club.id;
  await store.save(player);
  return club;
}

/**
 * Leave.
 *
 * The owner leaving hands the club to the longest-serving member left rather
 * than disbanding it — nine people should not lose their club because one
 * person moved on. The last member out does disband it, because an empty club
 * holding a name is just a name nobody can have.
 */
export async function leaveClub(store, player) {
  const club = await clubOf(store, player);
  if (!club) throw new ValidationError("you are not in a club", 409);
  return removeFrom(store, club, player);
}

/** Put somebody out of the club. The owner's decision, and only theirs. */
export async function removeMember(store, player, rawId) {
  const club = await clubOf(store, player);
  if (!club) throw new ValidationError("you are not in a club", 409);
  mustOwn(club, player);
  const id = typeof rawId === "string" ? rawId.trim().toUpperCase() : "";
  if (id === player.id) throw new ValidationError("to leave, leave the club", 400);
  if (!club.members.includes(id)) throw new ValidationError("they are not in this club", 404);
  const member = await store.get(id);
  // A removed member whose record has gone is still removed from the roster:
  // the club must not keep a slot for somebody who cannot come back.
  if (!member) {
    club.members = club.members.filter((m) => m !== id);
    await store.saveClub(club);
    return club;
  }
  return removeFrom(store, club, member);
}

async function removeFrom(store, club, member) {
  const remaining = club.members.filter((m) => m !== member.id);
  member.clubId = null;
  await store.save(member);
  if (remaining.length === 0) {
    await store.deleteClub(club);
    return null;
  }
  club.members = remaining;
  if (club.ownerId === member.id) club.ownerId = remaining[0];
  await store.saveClub(club);
  return club;
}

/** A fresh invite code, which stops the old one working. Owner only. */
export async function rotateInvite(store, player) {
  const club = await clubOf(store, player);
  if (!club) throw new ValidationError("you are not in a club", 409);
  mustOwn(club, player);
  const previous = club.invite;
  club.invite = await mintInvite(store);
  await store.saveClub(club, { previousInvite: previous });
  return club;
}

/** Rename the club. Owner only, and the name has to be free. */
export async function renameClub(store, player, rawName) {
  const club = await clubOf(store, player);
  if (!club) throw new ValidationError("you are not in a club", 409);
  mustOwn(club, player);
  const name = normaliseClubName(rawName);
  if (name === club.name) return club;
  try {
    await store.renameClub(club, name);
  } catch (err) {
    if (err instanceof NameTakenError) throw new ValidationError("that club name is taken", 409);
    throw err;
  }
  return club;
}
