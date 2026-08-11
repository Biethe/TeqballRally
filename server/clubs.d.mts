/** Types for the clubs module. See the note in `store.d.mts`. */
import type { ClubRecord, PlayerRecord, PlayerStore } from "./store.mjs";
import type { PublicProfile } from "./accounts.mjs";

export declare const MAX_CLUB_MEMBERS: number;
export declare const CLUB_NAME_MIN: number;
export declare const CLUB_NAME_MAX: number;

/** A member as the board shows them: a public profile plus who is in charge. */
export interface ClubMember extends PublicProfile {
  owner: boolean;
}

/** A club as its members see it. */
export interface ClubView {
  id: string;
  name: string;
  ownerId: string;
  created: number;
  /** Ordered by trophies; the owner is marked, not pinned. */
  members: ClubMember[];
  /** Every member's trophies added up. */
  trophies: number;
  online: number;
  full: boolean;
  /** The invite code, for the owner only. Null for everybody else. */
  invite: string | null;
}

export declare function normaliseClubName(raw: unknown): string;
export declare function tidyInvite(raw: unknown): string;
export declare function looksLikeInvite(code: string): boolean;
export declare function clubOf(
  store: PlayerStore,
  player: PlayerRecord
): Promise<ClubRecord | null>;
export declare function clubView(
  store: PlayerStore,
  club: ClubRecord,
  viewerId: string
): Promise<ClubView>;
export declare function createClub(
  store: PlayerStore,
  player: PlayerRecord,
  name: unknown,
  now?: Date
): Promise<ClubRecord>;
export declare function joinClub(
  store: PlayerStore,
  player: PlayerRecord,
  code: unknown
): Promise<ClubRecord>;
/** Null when the last member left and the club was disbanded. */
export declare function leaveClub(
  store: PlayerStore,
  player: PlayerRecord
): Promise<ClubRecord | null>;
export declare function removeMember(
  store: PlayerStore,
  player: PlayerRecord,
  id: unknown
): Promise<ClubRecord | null>;
export declare function rotateInvite(
  store: PlayerStore,
  player: PlayerRecord
): Promise<ClubRecord>;
export declare function renameClub(
  store: PlayerStore,
  player: PlayerRecord,
  name: unknown
): Promise<ClubRecord>;
