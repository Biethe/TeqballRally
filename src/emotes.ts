import type { StringKey } from "./i18n";

/**
 * The things a player can say to the person across the net.
 *
 * A fixed list, and fixed for two separate reasons that happen to agree.
 *
 * **It is not a chat box.** Nothing a player writes reaches anybody, so there
 * is no moderation to do, nothing to report, and no way for a stranger to say
 * something to a stranger that this file did not already say. That keeps the
 * feature out of the user-generated-content obligations entirely, which is
 * what makes it shippable at all.
 *
 * **Only the id crosses the wire.** Two players on different languages read
 * the same message in their own, which a typed sentence could never manage,
 * and a message costs eight bytes rather than a packet.
 *
 * Everything here is generous or neutral. There is no "unlucky", no slow
 * clap, and no thumbs-down, because the whole set is available to somebody who
 * has just lost a point to a stranger and the catalogue is the only thing
 * standing between that and what they would otherwise like to say.
 *
 * **Append-only.** The ids are on the wire, so removing or renumbering one
 * makes an older build show nothing where a newer build said something.
 */

export interface Emote {
  /** What crosses the wire. Never reused, never removed. */
  id: string;
  /** Carries the meaning at a glance, which is all a player has mid-rally. */
  emoji: string;
  says: StringKey;
}

export const EMOTES: readonly Emote[] = [
  { id: "gl", emoji: "👊", says: "emote.gl" },
  { id: "nice", emoji: "🔥", says: "emote.nice" },
  { id: "shot", emoji: "👏", says: "emote.shot" },
  { id: "close", emoji: "😮", says: "emote.close" },
  { id: "mine", emoji: "🙈", says: "emote.mine" },
  { id: "thanks", emoji: "🙏", says: "emote.thanks" },
  { id: "wp", emoji: "🤝", says: "emote.wp" },
  { id: "again", emoji: "🔁", says: "emote.again" },
];

/** Look one up, or nothing when a newer build said something this one lacks. */
export function emoteFor(id: string): Emote | null {
  return EMOTES.find((e) => e.id === id) ?? null;
}

/**
 * How long a message stays on screen, in milliseconds.
 *
 * Long enough to read between rallies, short enough that it is gone before it
 * becomes part of the furniture.
 */
export const EMOTE_SHOWN_MS = 2600;

/**
 * The shortest gap between two messages from the same player.
 *
 * Not politeness — a rate limit. Without one the whole point of a fixed
 * catalogue is lost, because a button pressed forty times a second says
 * something no individual message in this file does.
 */
export const EMOTE_COOLDOWN_MS = 2000;
