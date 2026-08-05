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
import { SIM_DT } from "../config";
import { stepBall, type BallState, type Side } from "../ball";

export const PROTOCOL_VERSION = 1;

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

export type GameMessage =
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

export interface PeerMessage {
  t: "peer";
  joined: boolean;
}

export interface ErrorMessage {
  t: "error";
  reason: string;
}

export type SignalMessage =
  | JoinMessage
  | JoinedMessage
  | PeerMessage
  | ErrorMessage
  | QueueMessage
  | QueuedMessage
  | CancelMessage;
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
