/**
 * Wire protocol for online 1v1.
 *
 * The model is authority handoff, not lockstep. Teqball's possession
 * alternates: at any instant exactly one player is about to touch the ball, and
 * every source of randomness in the game (aim spray, clip choice, whiffs) is
 * rolled at the moment of a strike. So the striking peer rolls its own dice,
 * computes the launch, and sends the *result* — a position and a velocity.
 * From there `stepBall` is a pure function of that state, so both peers
 * reproduce the same flight without needing a seeded PRNG or a shared
 * simulation, and every strike resynchronises the ball from scratch.
 *
 * Time is counted in simulation ticks (SIM_DT each). A message carries the tick
 * it was produced on; the receiver fast-forwards by however many ticks have
 * passed, so a late packet still lands the ball where it should be.
 *
 * Rules arbitration stays with the host: it owns the score and the match state,
 * and the guest displays what it is told. That avoids two peers disagreeing
 * about a point while keeping the latency-sensitive part — the ball — local.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { KIT_NAME_MAX, KIT_NUMBER_MAX, SIM_DT } from "../config";
import { CRESTS, type CrestId, type PersonalKit } from "../kit";
import { stepBall, type BallState, type Side } from "../ball";

/**
 * Bumped to 3 for the two fields that make a guest's screen agree with the
 * host's match: `viewTick` on an input, so a press is judged against the ball
 * the player was looking at, and the anchors on a snapshot, so a predicted
 * character runs the same assist the host runs. 2 added the playback fields
 * (clip windows, fx stream).
 *
 * The relay refuses to seat peers of different versions together, so a version
 * change is a clean break rather than a negotiation.
 */
export const PROTOCOL_VERSION = 4;

/**
 * Crockford base32: no I, L, O or U. The first three are the characters people
 * misread off a screen, and dropping U keeps a random code from spelling
 * something unfortunate. I and L fold onto 1 and O onto 0 when a player types
 * one, so a misread is still a successful join.
 */
export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 5;

export type PeerRole = "host" | "guest";

export interface Vec3Wire {
  x: number;
  y: number;
  z: number;
}

/** Where a peer's own character is, sent continuously. Each peer owns its own. */
export interface MoveMessage {
  t: "move";
  tick: number;
  pos: Vec3Wire;
  /** Facing, radians. */
  yaw: number;
  /** Locomotion intent, so the receiver can blend the right jog clip. */
  moveX: number;
  moveZ: number;
}

/**
 * A struck ball. The sender has already applied its own aim error and picked
 * its clip; this is the outcome, and it is authoritative for the flight.
 */
export interface StrikeMessage {
  t: "strike";
  tick: number;
  pos: Vec3Wire;
  vel: Vec3Wire;
  /** Animation clip the striker played, so the receiver shows the same move. */
  clip: string;
  /** Visual spin multiplier passed to Ball.launch. */
  spin: number;
}

/**
 * Guest -> host: what the guest's controls are doing.
 *
 * The host runs the only match, so the guest sends intent rather than results.
 * Presses are latched by the sender until acknowledged by a snapshot, because
 * dropping the frame a strike was pressed on loses the shot entirely.
 */
export interface InputMessage {
  t: "input";
  tick: number;
  /**
   * The host tick the guest's screen was showing when these controls were
   * read — its playback clock, not its own step counter.
   *
   * This is what makes a press mean what the player meant by it. A guest's
   * timeline is led to the host's present, so it presses at host time V and
   * the host hears about it at V plus a trip; judging the press against the
   * ball at *that* moment asks a different question than the one the player
   * answered. At rally pace a few ticks of fall is a whole height band, which
   * is why the joined player kept meeting a ball with the wrong limb, and why
   * the second seat used to be handed a quiet 15% of extra reach to paper
   * over it.
   *
   * Optional: a peer too old to send it is judged live, exactly as before.
   */
  viewTick?: number;
  moveX: number;
  moveZ: number;
  strike: boolean;
  /** Kick control still down: the guest is charging one. */
  hold?: boolean;
  /** Power the guest's own scheme decided (a portrait swipe), 0..1. */
  power?: number;
  /** Taps the guest's kick was made of, 1..3 (their landscape scheme). */
  taps?: number;
  /** Arc the guest's kick asked for; 1 is neutral. */
  loft?: number;
  pop: boolean;
  confirm: boolean;
  /**
   * The guest is playing by gesture on an upright phone.
   *
   * The two schemes do not mean the same thing by the same numbers: in
   * portrait the axes carry a swipe — its length is carry and its pace is
   * power — while in landscape they are a stick offset onto the table. The
   * host has no other way to know which it is being sent, and reading a swipe
   * as a stick aimed every guest kick somewhere nobody asked for.
   *
   * Optional: a peer that does not send it is taken as landscape, which is
   * what the host assumed before the flag existed.
   */
  portrait?: boolean;
  /**
   * The axes on this frame are a tap's carry vector, not a stick.
   *
   * Sent with `pop` for a set-up being asked for, and without it to shape a
   * first touch the host is about to take automatically. The host cannot tell
   * the two apart from the numbers — a tapped carry and a walk direction are
   * both a short court-space vector — and reading a placement as a walk is how
   * a guest ends up jogging away from the ball it just asked to play.
   */
  tapAim?: boolean;
}

/**
 * Host -> guest: the whole authoritative frame.
 *
 * One message rather than several, because the parts have to agree: a ball
 * that belongs to a different tick than the score it was won by is how two
 * screens end up telling different stories.
 */
export interface SnapshotMessage {
  t: "snap";
  tick: number;
  /** Ball position and velocity; `held` while it is in a hand between points. */
  ballPos: Vec3Wire;
  ballVel: Vec3Wire;
  ballHeld: boolean;
  /**
   * How fast this flight is spinning, as the multiplier `Ball.launch` was
   * given: about 0.45 for a floated set-up, 0.7 and up for a smash.
   *
   * Purely how it looks, and it still has to cross. A guest never calls
   * `launch` — its ball is placed from this timeline — so without it every
   * ball spins at the default 1, and a delicate pop reads as a drive. A
   * scalar: nothing to mirror. Optional, and absent means 1.
   */
  ballSpin?: number;
  /** Both characters, in the sender's frame. */
  hostPos: Vec3Wire;
  guestPos: Vec3Wire;
  /**
   * Court velocities — and the thing that actually carries each character
   * between frames on the guest.
   *
   * This is `Character.velocity`, already eased by MOVE_TAU and set to exactly
   * zero the step a run reaches its target. The guest used to difference two
   * 30 Hz positions instead, which lagged every stop by two ticks and then
   * multiplied the stale speed by the lead — so a joined player overshot the
   * end of every run to a drop spot and was snapped back. A dozen bytes.
   */
  hostVel: Vec3Wire;
  guestVel: Vec3Wire;
  /**
   * Action clip each character is playing, or null. A guest runs no rules and
   * so never starts one itself; without this a kick is just the ball changing
   * direction beside a motionless player. Clip names are not mirrored — a
   * player's own right foot is their right foot from either end of the table.
   */
  hostClip: string | null;
  guestClip: string | null;
  /**
   * The host ticks at which each playing clip is at fraction 0 and fraction 1.
   * Two ticks rather than one because clips run at different speeds and start
   * part-way through; a window pins the animation in the same time base as the
   * ball and the positions, so the guest plays it at the right fraction of the
   * right instant instead of restarting it from zero whenever a frame arrives.
   */
  hostClipFrom?: number;
  hostClipTo?: number;
  guestClipFrom?: number;
  guestClipTo?: number;
  /**
   * Which playing of the clip this is.
   *
   * The window moves now — the host restates it from the clip's real progress
   * every step, because the renderer and the fixed step are different clocks —
   * so the guest can no longer tell one playing from the next by the window's
   * start. A number that only changes when a clip actually starts says it
   * outright. Optional: without one the guest falls back to the start, which
   * is what it used to key on.
   */
  hostClipSeq?: number;
  guestClipSeq?: number;
  /**
   * Whether each seat's feet are owned by the semi-assisted run to the drop
   * spot (`runLocked` in the match). The guest needs to know about its own
   * seat: while locked, its stick is not driving the character on the host,
   * so predicting from that stick locally would fight the authoritative run
   * and saw the joined player tugged toward every ball. Optional because an
   * older peer never sends them, and an absent flag means the old behaviour.
   */
  hostLocked?: boolean;
  guestLocked?: boolean;
  /**
   * Where each seat's next touch is due — `anchor` in the match — or absent
   * when no touch of theirs is coming.
   *
   * The guest predicts its own character to keep its stick immediate, but the
   * host moves that same character with a reach assist and a leash aimed at
   * this spot. Predicting with a bare stick instead is not a small error that
   * settles: it is the whole assist, regenerated every step, and `reconcile`
   * chases it without ever arriving while the player is moving. Sending the
   * one point both are aiming at lets the two run the same equation.
   *
   * Optional, like the locks: an older host sends none and its guest predicts
   * the way it used to.
   */
  hostAnchor?: Vec3Wire | null;
  guestAnchor?: Vec3Wire | null;
  /**
   * Seconds until the ball gets to each anchor. The assist is a question about
   * time, not distance — how much slack there is between the ball's arrival
   * and the run needed to meet it — so the point alone is not enough to run
   * the same equation the host runs. A scalar: nothing to mirror.
   */
  hostAnchorEta?: number;
  guestAnchorEta?: number;
  /**
   * How much each seat has left in their legs, and how much of that they will
   * ever get back — `Character.effort` and `Character.reserve`.
   *
   * A guest runs no rules and so never drains either, which cost it twice. The
   * stamina bars on its HUD sat full for the whole match, hiding the one thing
   * the game sells supplies to fix. And, less visibly and much worse, its own
   * character was *predicted* at full effort while the host moved that same
   * character on empty legs — effort scales both the acceleration and the top
   * speed, so a tired player was predicted up to a third faster than the host
   * was actually moving them, every step, for as long as the rally lasted.
   * That is not noise `reconcile` absorbs; it is a constant pull the joined
   * player feels as rubber-banding exactly when the points are longest.
   *
   * Four numbers. Optional, and absent leaves both at full, which is what an
   * older host implied.
   */
  hostEffort?: number;
  guestEffort?: number;
  hostReserve?: number;
  guestReserve?: number;
  /**
   * Which seat may touch the ball, and how many touches that seat has spent,
   * in the host's frame.
   *
   * The guest runs no rules, so it knows neither on its own — and a portrait
   * guest needs both, because there a tap means "play the ball" when the ball
   * is due and "walk there" when it is not, and that question cannot be
   * answered without them. Two facts rather than the whole rule engine: the
   * host still decides what the tap did.
   *
   * Optional, like the locks: an older host sends neither and its guest falls
   * back to treating every tap as a walk, which is what it did before.
   */
  strikeable?: "host" | "guest" | null;
  touches?: number;
  /**
   * Seconds left on the serve clock, or absent when it is not running.
   *
   * The countdown belongs to both screens: the server has to know they are
   * being hurried, and the receiver has to be able to see that the point
   * coming their way was earned by the clock rather than conjured. A scalar
   * that means the same thing to both seats, so it crosses unchanged.
   */
  serveClock?: number;
  /** Score in the host's frame: [host, guest]. */
  score: [number, number];
  /**
   * Points won across the whole match by each seat, host frame, and the long
   * rallies the match produced.
   *
   * A guest runs no rules, so it counts neither — and it reports both to the
   * server at the final whistle. Reporting zero points beside a real set count
   * is a result the server refuses as impossible, which is why a guest that
   * won could not be paid for it, and why neither side was paid at all: one
   * report alone settles nothing. The rallies are a property of the match
   * rather than of a seat, so they cross unchanged.
   */
  tally?: [number, number];
  rallies?: number;
  sets: [number, number];
  /** Whose serve, in the host's frame. */
  serveOwner: Side;
  phase: string;
}

/**
 * Each peer's chosen character and ball, exchanged before the match loads.
 *
 * Neither side can pick the other's model for it, and both have to be known
 * before anything is loaded — without this each peer showed a stand-in for
 * its opponent. Ids, not geometry, so there is nothing to mirror.
 */
export interface SetupMessage {
  t: "setup";
  tick: number;
  character: string;
  ball: string;
  /**
   * The marks this peer has put on their own shirt: the name across the
   * shoulders, the number under it, and the crest.
   *
   * Only the personal part. The colours belong to the character and both ends
   * already have the roster, so `kitForCharacter` puts the two together —
   * there is nothing here that a peer could use to paint somebody else's
   * shirt in a colour the character does not own.
   *
   * Optional: a peer that sends none wears the character's kit as the artist
   * made it, which is what both sides used to see of each other.
   */
  kit?: PersonalKit;
}

/**
 * A pause negotiated between the players.
 *
 * A request rather than a unilateral freeze: stopping someone else's game
 * without asking is the kind of thing a stranger would abuse, so the opponent
 * decides. Offered only in private games, where the two people already know
 * each other.
 */
export interface PauseMessage {
  t: "pause";
  tick: number;
  action: "request" | "accept" | "decline" | "resume";
}

/**
 * A rematch negotiated between the players, from the end screen.
 *
 * Shaped like the pause for the same reason: one peer asks, the other decides,
 * and both act on the same transition. Unlike the pause there is no resume —
 * completion starts the new match, and leaving is what the LEAVE button is for.
 */
export interface RematchMessage {
  t: "rematch";
  tick: number;
  action: "request" | "accept" | "decline";
}

/** Host-only: the authoritative score and phase. */
export interface StateMessage {
  t: "state";
  tick: number;
  scorePlayer: number;
  scoreAi: number;
  setsPlayer: number;
  setsAi: number;
  serveOwner: Side;
  phase: string;
}

/** Host-only: a point resolved. Sent once, reliably, ahead of the next serve. */
export interface PointMessage {
  t: "point";
  tick: number;
  winner: Side;
  reason: string;
}

export interface PingMessage {
  t: "ping";
  /** Sender's clock in ms; echoed back untouched so only the sender reads it. */
  sent: number;
  tick: number;
}

export interface PongMessage {
  t: "pong";
  sent: number;
  tick: number;
}

/** What kind of ball contact an fx event describes. */
export type FxKind = "kick" | "table" | "net" | "ground" | "side" | "body";

export const FX_KINDS: readonly FxKind[] = ["kick", "table", "net", "ground", "side", "body"];

/**
 * Host -> guest: a contact happened, on this host tick.
 *
 * The guest plays the timeline a fixed interval behind, so the event rides the
 * same clock: its sound fires when the playback point crosses its tick, beside
 * the bounce or kick that caused it, rather than on arrival — which is half a
 * round trip away from where the screen shows the contact.
 */
export interface FxMessage {
  t: "fx";
  tick: number;
  kind: FxKind;
  /** Where the contact happened, when it has a place worth showing. */
  pos?: Vec3Wire;
}

/**
 * One of a fixed set of things a player can say, mid-match.
 *
 * Only the id crosses. The words are looked up on the far side, so two players
 * on different languages read the same message in their own — and, more to the
 * point, nothing a player types ever reaches anybody. A fixed catalogue is not
 * user-generated content, which keeps this out of the moderation and reporting
 * obligations that come with a chat box, and keeps it out of the trouble that
 * comes with strangers being able to write to each other.
 *
 * Carries no geometry, so `reframe` passes it through untouched.
 */
export interface EmoteMessage {
  t: "emote";
  /**
   * When it was said. Nothing reads it — a message is shown on arrival, not
   * scheduled — but `NetConnection.send` stamps every game message so that no
   * call site can forget one that does matter, and pause and rematch carry it
   * on the same terms.
   */
  tick: number;
  /** An id from the catalogue in `src/emotes.ts`. */
  id: string;
}

export type GameMessage =
  | PauseMessage
  | RematchMessage
  | SetupMessage
  | InputMessage
  | SnapshotMessage
  | FxMessage
  | EmoteMessage
  | MoveMessage
  | StrikeMessage
  | StateMessage
  | PointMessage
  | PingMessage
  | PongMessage;

// ---------------------------------------------------------------- signalling

export interface JoinMessage {
  t: "join";
  v: number;
  room: string;
  /** The account this seat is played from, if there is one. */
  token?: string;
}

/**
 * Ask to be paired with whoever else is waiting.
 *
 * Private rooms only work between people who already know each other, which
 * for a new game means nobody plays. The queue is the path for a player with
 * no one to invite: the relay mints a room and seats the two longest-waiting
 * players in it.
 */
export interface QueueMessage {
  t: "queue";
  v: number;
  token?: string;
}

/** Relay -> client: waiting for an opponent. `ahead` is the queue position. */
export interface QueuedMessage {
  t: "queued";
  ahead: number;
}

/** Leave the queue without closing the socket. */
export interface CancelMessage {
  t: "cancel";
}

/** Relay -> client, once the room is known. */
export interface JoinedMessage {
  t: "joined";
  room: string;
  role: PeerRole;
  /** True once both seats are filled. */
  ready: boolean;
}

/** A verified opponent, as the relay knows them. Absent for a guest. */
export interface PeerIdentity {
  id: string;
  name: string;
  trophies: number;
  tier: string;
}

export interface PeerMessage {
  t: "peer";
  joined: boolean;
  /**
   * Who is on the other side, verified by the relay against their token.
   *
   * Verified rather than announced by the peer itself: a name a client can
   * choose for itself is a name that can be somebody else's, and the whole
   * point of an account is that the person across the net is who the card
   * says they are. Null means they are playing without one.
   */
  who?: PeerIdentity | null;
  /**
   * The relay's name for this match, sent once both seats are filled.
   *
   * Both sides report their result against it, which is what lets the server
   * check the two stories against each other instead of believing one.
   */
  match?: string | null;
}

export interface ErrorMessage {
  t: "error";
  reason: string;
}

/**
 * A rematch begins: the host asks the relay to mint a fresh match id for the
 * same room (sent bare), and the relay answers both seats with it. A result
 * settles once per id, so the new match needs a name of its own before either
 * side reports it.
 */
export interface NewMatchMessage {
  t: "newmatch";
  match?: string;
}

/**
 * Say who is here, without asking for a seat.
 *
 * Joining a room is how a socket used to become an identified one, which meant
 * a player counted as present only while they were already looking for a game
 * — and a friend could only be reached at the one moment they least needed
 * reaching. This is the same identification with none of the seating.
 */
export interface HelloMessage {
  t: "hello";
  v: number;
  token: string;
}

/**
 * Ask a friend to play, now.
 *
 * The inviter has already minted a private room and taken the host seat in it,
 * so this carries nothing but who to ask and where to come. That keeps the
 * invite out of the business of making matches: accepting is an ordinary join
 * by code, down the path that already works, and a declined invite costs
 * nothing but a room nobody used.
 */
export interface InviteMessage {
  t: "invite";
  /** Player code of the friend being asked. */
  to: string;
  /** The room they should join to accept. */
  room: string;
}

/**
 * Relay -> somebody who might want a game. `from` is verified, never announced.
 *
 * Two kinds, told apart by `open`.
 *
 * A **friend** asking by name carries a `room`: they have already minted one
 * and taken the host seat, so accepting is an ordinary join by code.
 *
 * An **open callout** carries none, and that is the whole of its design. It is
 * sent by the relay, not by a player, to everybody idle the moment somebody is
 * left waiting in the quick-match queue — so accepting is not joining a room,
 * it is simply asking for a quick match yourself, and the relay pairs the two
 * of you because one of you is already waiting. No room to mint, no code to
 * carry, nothing to go stale, and it works for a player with no account, who
 * has no presence link to be reached on but can still queue.
 *
 * The first shape of this did mint a room and the caller advertised it. That
 * was worse in three ways at once: it replaced the queue, so two people
 * searching at the same moment minted different rooms and never met; it needed
 * a tie-break for when both called out; and it left an empty room behind every
 * time nobody answered.
 *
 * The presentation differs as much as the mechanism. A friend asking by name
 * has earned an interruption; a stranger reaching everybody who happens to be
 * online has earned a notice that can be ignored.
 */
export interface InvitedMessage {
  t: "invited";
  from: PeerIdentity;
  /** Where to go, for a friend's invite. Absent on an open callout. */
  room?: string;
  /** True when the relay sent this on behalf of somebody in the queue. */
  open?: boolean;
}

/**
 * Whoever was waiting is waiting no longer — stop offering it.
 *
 * A callout reaches everybody and only one of them can have the game, so
 * without this the rest are left looking at an offer that cannot be taken and
 * find that out by tapping it. No room, because an open callout never named
 * one: there is only ever one of these on screen.
 */
export interface CalloutGoneMessage {
  t: "callout-gone";
}

/**
 * An answer, and what became of it.
 *
 * "declined" travels back so the asker is told rather than left watching a
 * lobby; "gone" is the relay's own answer when the friend is not connected,
 * which it knows and the asker cannot.
 */
export interface InviteReplyMessage {
  t: "invite-reply";
  /** Who answered, on the way back; who to tell, on the way out. */
  to?: string;
  answer: "declined" | "gone";
  /** Their name, so the asker is told who, not which id. */
  who?: string;
}

export type SignalMessage =
  | JoinMessage
  | JoinedMessage
  | PeerMessage
  | ErrorMessage
  | QueueMessage
  | QueuedMessage
  | CancelMessage
  | NewMatchMessage
  | HelloMessage
  | InviteMessage
  | InvitedMessage
  | InviteReplyMessage
  | CalloutGoneMessage;
export type NetMessage = GameMessage | SignalMessage;

// ------------------------------------------------------------------- helpers

export function vec(v: { x: number; y: number; z: number }): Vec3Wire {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Reflect a point or vector through the net.
 *
 * Both players must experience themselves as the near side, x < 0, with the
 * primary camera and the unmirrored control mapping — being the away player is
 * a worse game, so neither peer should have to be it. The host's frame is
 * canonical and the guest mirrors everything crossing the wire in both
 * directions.
 *
 * The transform is a 180-degree rotation about the vertical axis, so it
 * preserves the court's handedness: negating x alone would turn every player's
 * left into their right.
 */
export function mirror(v: Vec3Wire): Vec3Wire {
  return { x: -v.x, y: v.y, z: -v.z };
}

/** Which side of the table a peer occupies in the canonical (host) frame. */
export function canonicalSide(role: PeerRole): Side {
  return role === "host" ? "player" : "ai";
}

/**
 * The other seat's name for a seat. Absent stays absent, so an older host that
 * never reports possession is not turned into one that reports "nobody".
 */
function swapSeat(seat: "host" | "guest" | null | undefined): "host" | "guest" | null | undefined {
  if (seat === undefined) return undefined;
  if (seat === "host") return "guest";
  if (seat === "guest") return "host";
  return null;
}

/**
 * Convert a message between a peer's own frame and the canonical one. The host
 * is already canonical, so this is identity for it; the guest reflects. The
 * same function serves both directions because a reflection is its own inverse.
 */
export function reframe<T extends GameMessage>(msg: T, role: PeerRole): T {
  if (role === "host") return msg;
  switch (msg.t) {
    case "move":
      return { ...msg, pos: mirror(msg.pos) };
    case "strike":
      return { ...msg, pos: mirror(msg.pos), vel: mirror(msg.vel) };
    case "input":
      // Court-space stick directions reflect with everything else, exactly as
      // the second local player's already do in split screen.
      return { ...msg, moveX: -msg.moveX, moveZ: -msg.moveZ };
    case "snap":
      // A snapshot reflects *and* swaps seats: the host's "host" is the
      // guest's opponent. Mirroring the vectors without swapping who is who
      // would put each player in the other's body.
      return {
        ...msg,
        ballPos: mirror(msg.ballPos),
        ballVel: mirror(msg.ballVel),
        hostPos: mirror(msg.guestPos),
        guestPos: mirror(msg.hostPos),
        hostVel: mirror(msg.guestVel),
        guestVel: mirror(msg.hostVel),
        hostClip: msg.guestClip,
        guestClip: msg.hostClip,
        hostClipFrom: msg.guestClipFrom,
        hostClipTo: msg.guestClipTo,
        guestClipFrom: msg.hostClipFrom,
        guestClipTo: msg.hostClipTo,
        hostClipSeq: msg.guestClipSeq,
        guestClipSeq: msg.hostClipSeq,
        hostLocked: msg.guestLocked,
        guestLocked: msg.hostLocked,
        // Anchors are points on the court, so they swap seats and reflect with
        // every other position. Absent stays absent.
        hostAnchor: msg.guestAnchor ? mirror(msg.guestAnchor) : msg.guestAnchor,
        guestAnchor: msg.hostAnchor ? mirror(msg.hostAnchor) : msg.hostAnchor,
        hostAnchorEta: msg.guestAnchorEta,
        guestAnchorEta: msg.hostAnchorEta,
        // Legs belong to a seat, so they swap with the seat. Scalars, so
        // nothing reflects. `ballSpin` is a property of the flight rather than
        // of either player and crosses untouched, below.
        hostEffort: msg.guestEffort,
        guestEffort: msg.hostEffort,
        hostReserve: msg.guestReserve,
        guestReserve: msg.hostReserve,
        // Possession swaps seats with everything else: the host's "guest" is
        // this peer's own side. The touch count belongs to the possession
        // rather than to a seat, so it crosses unchanged.
        strikeable: swapSeat(msg.strikeable),
        score: [msg.score[1], msg.score[0]],
        sets: [msg.sets[1], msg.sets[0]],
        tally: msg.tally ? [msg.tally[1], msg.tally[0]] : undefined,
        serveOwner: msg.serveOwner === "player" ? "ai" : "player",
      };
    case "fx":
      // The tick is host time on both ends; only the place reflects.
      return msg.pos ? { ...msg, pos: mirror(msg.pos) } : msg;
    default:
      // Scores, phases and clock probes carry no geometry.
      return msg;
  }
}

export function toVector3(v: Vec3Wire): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

/** Seconds represented by a tick delta, clamped to something sane. */
export function ticksToSeconds(ticks: number): number {
  return ticks * SIM_DT;
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds / SIM_DT);
}

/**
 * How far to fast-forward a message that was produced `sentTick` ago.
 *
 * Negative deltas (a peer slightly ahead of us, or a reordered packet) produce
 * zero rather than winding the simulation backwards. The upper clamp stops a
 * long stall from being "caught up" by simulating seconds of flight in one go,
 * which would teleport the ball far past anything the player saw.
 */
export const MAX_CATCHUP_TICKS = secondsToTicks(0.5);

export function catchupTicks(sentTick: number, localTick: number): number {
  return Math.max(0, Math.min(MAX_CATCHUP_TICKS, localTick - sentTick));
}

function isFiniteVec(v: unknown): v is Vec3Wire {
  if (typeof v !== "object" || v === null) return false;
  const { x, y, z } = v as Record<string, unknown>;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/**
 * Whether a decoded frame is a strike we can safely act on. Worth checking
 * rather than trusting: a NaN reaching the ball state poisons every subsequent
 * step, and the result is an unplayable match with no obvious cause.
 */
export function isValidStrike(msg: unknown): msg is StrikeMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<StrikeMessage>;
  return (
    m.t === "strike" &&
    Number.isFinite(m.tick) &&
    isFiniteVec(m.pos) &&
    isFiniteVec(m.vel) &&
    typeof m.clip === "string" &&
    Number.isFinite(m.spin)
  );
}

/** A player code as the relay writes them: eight Crockford characters. */
export function isPlayerCode(v: unknown): v is string {
  return typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(v.trim().toUpperCase());
}

/**
 * An invite worth forwarding: a friend to send it to, and a room to send them
 * to. Checked before the relay looks anybody up, so a malformed frame costs a
 * regex rather than a store read.
 */
export function isValidInvite(msg: unknown): msg is InviteMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<InviteMessage>;
  // `typeof` first: stringifying whatever arrived would let the number 12345
  // through as a room code, which is five characters of the alphabet and not
  // a code anybody typed.
  return (
    m.t === "invite" &&
    isPlayerCode(m.to) &&
    typeof m.room === "string" &&
    isValidRoomCode(m.room.toUpperCase())
  );
}

/**
 * An invitation as it reaches whoever might take it.
 *
 * A friend's invite must name a room, because accepting it is joining that
 * room. An open callout must not: there is nothing to join, and accepting it
 * is asking for a quick match of your own. Requiring a code of both would have
 * thrown every callout away on arrival — which is precisely what an earlier
 * version of this did, silently, for the several hours it took to notice that
 * the notice never appeared.
 */
export function isValidInvited(msg: unknown): msg is InvitedMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<InvitedMessage>;
  if (m.t !== "invited") return false;
  if (typeof m.from?.id !== "string" || typeof m.from?.name !== "string") return false;
  if (m.open === true) return m.room === undefined;
  // `typeof` first: stringifying whatever arrived would let the number 12345
  // through as a room code, which is five characters of the alphabet and not
  // a code anybody typed.
  return typeof m.room === "string" && isValidRoomCode(m.room.toUpperCase());
}

/** The withdrawal of one. Nothing to check but the name. */
export function isValidCalloutGone(msg: unknown): msg is CalloutGoneMessage {
  if (typeof msg !== "object" || msg === null) return false;
  return (msg as Partial<CalloutGoneMessage>).t === "callout-gone";
}

/**
 * A message worth showing.
 *
 * The id is checked against the catalogue by the caller, not here: this file
 * is shared with the relay's plain ESM and must not reach into the game's
 * modules. What it can say is that the shape is right and the id is short
 * enough not to be an attack.
 */
export function isValidEmote(msg: unknown): msg is EmoteMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<EmoteMessage>;
  return m.t === "emote" && typeof m.id === "string" && m.id.length > 0 && m.id.length <= 32;
}

export const PAUSE_ACTIONS = ["request", "accept", "decline", "resume"] as const;

export function isValidPause(msg: unknown): msg is PauseMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<PauseMessage>;
  return m.t === "pause" && (PAUSE_ACTIONS as readonly string[]).includes(m.action ?? "");
}

export const REMATCH_ACTIONS = ["request", "accept", "decline"] as const;

export function isValidRematch(msg: unknown): msg is RematchMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<RematchMessage>;
  return m.t === "rematch" && (REMATCH_ACTIONS as readonly string[]).includes(m.action ?? "");
}

/**
 * The personal kit off the wire, made safe rather than trusted.
 *
 * Both fields are painted onto a texture, so their length is the thing that
 * matters: the limits are the ones the settings screen enforces on the player's
 * own kit, applied again here because the other end is a peer rather than a
 * text field. An unknown crest falls back to none.
 */
export function readKit(v: unknown): PersonalKit | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const k = v as Record<string, unknown>;
  const text = (raw: unknown, max: number) =>
    typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const crest = (CRESTS as readonly string[]).includes(k.crest as string)
    ? (k.crest as CrestId)
    : "none";
  return { name: text(k.name, KIT_NAME_MAX), number: text(k.number, KIT_NUMBER_MAX), crest };
}

export function isValidSetup(msg: unknown): msg is SetupMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<SetupMessage>;
  // The ids are looked up against the roster by the caller, which falls back
  // to a default; this only guarantees there is a string to look up.
  return m.t === "setup" && typeof m.character === "string" && typeof m.ball === "string";
}

export function isValidInput(msg: unknown): msg is InputMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<InputMessage>;
  return (
    m.t === "input" &&
    Number.isFinite(m.tick) &&
    Number.isFinite(m.moveX) &&
    Number.isFinite(m.moveZ) &&
    typeof m.strike === "boolean" &&
    typeof m.pop === "boolean" &&
    typeof m.confirm === "boolean"
  );
}

/**
 * The shape values, made safe rather than made a reason to reject a frame.
 *
 * A nonsense `taps` or `loft` must become a legal shot, not a dropped message:
 * rejecting the frame would throw away the movement riding on it too, so one
 * bad field would stutter the other player's character rather than merely
 * flattening their kick. Absent stays absent, and the shot falls back to
 * neutral on its own.
 */
export function readTaps(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(3, Math.max(1, Math.round(v)));
}

export function readLoft(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(2, Math.max(0.5, v));
}

/** Possession as reported, or undefined when the host does not report it. */
export function readStrikeable(v: unknown): "host" | "guest" | null | undefined {
  if (v === null) return null;
  if (v === "host" || v === "guest") return v;
  return undefined;
}

/** Touches spent in the possession, or undefined when not reported. */
export function readTouches(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.round(v));
}

/**
 * The host tick a guest's press was aimed at, clamped into the window the host
 * still remembers.
 *
 * Never further back than the protocol's own catch-up bound, and never ahead
 * of now: a peer that asks to be judged against a moment the host has
 * forgotten, or one that has not happened, gets the nearest one it is entitled
 * to rather than a rewind of its own choosing.
 */
export function readViewTick(v: unknown, now: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(now - MAX_CATCHUP_TICKS, Math.min(now, Math.round(v)));
}

/** Two finite numbers, which is the shape of every per-seat pair here. */
export function isScorePair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n));
}

/**
 * A snapshot drives the guest's entire display, so a malformed one would put
 * the ball, both players and the score into an unrecoverable state at once.
 */
export function isValidSnapshot(msg: unknown): msg is SnapshotMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<SnapshotMessage>;
  const optTick = (v: number | undefined) => v === undefined || Number.isFinite(v);
  return (
    m.t === "snap" &&
    Number.isFinite(m.tick) &&
    isFiniteVec(m.ballPos) &&
    isFiniteVec(m.ballVel) &&
    typeof m.ballHeld === "boolean" &&
    isFiniteVec(m.hostPos) &&
    isFiniteVec(m.guestPos) &&
    isFiniteVec(m.hostVel) &&
    isFiniteVec(m.guestVel) &&
    (m.hostClip === null || typeof m.hostClip === "string") &&
    (m.guestClip === null || typeof m.guestClip === "string") &&
    optTick(m.hostClipFrom) &&
    optTick(m.hostClipTo) &&
    optTick(m.guestClipFrom) &&
    optTick(m.guestClipTo) &&
    isScorePair(m.score) &&
    isScorePair(m.sets) &&
    (m.serveOwner === "player" || m.serveOwner === "ai")
  );
}

/** An fx event is small and harmless; a malformed one is simply not played. */
export function isValidFx(msg: unknown): msg is FxMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<FxMessage>;
  return (
    m.t === "fx" &&
    Number.isFinite(m.tick) &&
    (FX_KINDS as readonly string[]).includes(m.kind ?? "") &&
    (m.pos === undefined || isFiniteVec(m.pos))
  );
}

export function isValidMove(msg: unknown): msg is MoveMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<MoveMessage>;
  return (
    m.t === "move" &&
    Number.isFinite(m.tick) &&
    isFiniteVec(m.pos) &&
    Number.isFinite(m.yaw) &&
    Number.isFinite(m.moveX) &&
    Number.isFinite(m.moveZ)
  );
}

/**
 * Reproduce a remote strike locally. Sets the exact launch state the striker
 * computed, then advances the pure ball physics by the transit time, so both
 * peers converge on the same trajectory regardless of when the packet arrived.
 */
export function applyStrike(state: BallState, msg: StrikeMessage, localTick: number): void {
  state.pos.set(msg.pos.x, msg.pos.y, msg.pos.z);
  state.vel.set(msg.vel.x, msg.vel.y, msg.vel.z);
  const ticks = catchupTicks(msg.tick, localTick);
  for (let i = 0; i < ticks; i++) stepBall(state, SIM_DT);
}

export function makeStrike(tick: number, state: BallState, clip: string, spin = 1): StrikeMessage {
  return { t: "strike", tick, pos: vec(state.pos), vel: vec(state.vel), clip, spin };
}

// -------------------------------------------------------------- room codes

/** Generate a room code. `rand` is injectable so tests are deterministic. */
export function makeRoomCode(rand: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Normalise a code a player typed: upper-case, punctuation and spaces dropped,
 * and the excluded look-alikes folded onto the character they resemble.
 *
 * A generated code never contains I, L, O or U, so a player typing one has
 * misread something — I/L is a 1, O is a 0, and U can only be a V. Folding
 * them turns a misread into a successful join instead of a dead end.
 */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V")
    .slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  return [...code].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

// ------------------------------------------------------------ (de)serialising

export function encode(msg: NetMessage): string {
  return JSON.stringify(msg);
}

/** Parse a frame off the wire. Returns null for anything malformed. */
export function decode(raw: string): NetMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "string") return null;
  return parsed as NetMessage;
}
