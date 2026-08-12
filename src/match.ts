import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
  Ball,
  predict,
  sampleFlight,
  solveLaunch,
  solveLaunchClearingNet,
  type BallEvent,
  type BodyCollider,
  type FlightSample,
  type Side,
} from "./ball";
import {
  backflipFoot,
  Character,
  footFactor,
  pickReceptionClip,
  pickStrikeClip,
  serveClipForAim,
  serveContactOffset,
  HEAD_CONTACT_PUSH,
  SERVE_CLIPS,
  SERVE_TOSS_HAND,
} from "./character";
import {
  contactDelaySeconds,
  contactFraction,
  tableSurfaceY,
  tossFraction,
  windupStartFraction,
  BALL_RADIUS,
  CAMERA,
  COURT,
  clearTable,
  onTableFootprint,
  portraitCameraShot,
  GRAVITY,
  GROUND_Y,
  BALL_PACE,
  KICK_LOFT,
  KICK_POWER,
  KICK_SPEED_CAP,
  KICK_SPEED_CAP_DEFAULT,
  TABLE,
  MAX_TOUCHES,
  PLAYER_REACH,
  REACH_ASSIST,
  SERVE_EVERY,
  SERVE_NET_CLEARANCE,
  SERVE_POWER,
  SERVE_X,
  SETS_TO_WIN,
  SPAWN,
  TABLE_SCALE,
  WIN_SCORE,
  type CameraMode,
} from "./config";
import type { InputState } from "./input";
import type { AudioManager } from "./audio";
import { reconcile } from "./net/reconcile";
import {
  clampToPlay,
  canSmashFrom,
  loftFloor,
  loftFor,
  onTableHalf,
  rangeFor,
  scatter,
  spreadRadius,
  tableTarget,
  SPREAD,
  type StrikeAim,
} from "./aim";

/**
 * True while the game is being played by gesture on a phone held upright.
 * Hints have to name what the player can actually do, and in portrait there is
 * no STRIKE button to press.
 */
function portraitTouch(): boolean {
  if (typeof window === "undefined") return false;
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return touch && window.innerWidth < window.innerHeight;
}

export type MatchState = "serve_move" | "serve_ready" | "serve_anim" | "rally" | "point" | "over";

/**
 * Small, public match milestones. The guided practice flow listens to these
 * rather than guessing from transient physics state, so it can stop on the
 * exact frame a lesson becomes relevant.
 */
export type MatchEvent =
  | { type: "serve-ready"; side: Side }
  | { type: "serve-committed"; side: Side }
  | { type: "possession-start"; side: Side }
  | { type: "touch-committed"; side: Side; action: "strike" | "pop"; afterSetup?: boolean }
  | { type: "point-awarded"; winner: Side; reason: string }
  /**
   * The ball has just been given a new velocity by a serve, strike or pop —
   * the exact moment that decides the flight ahead.
   *
   * Online play is built on this: because `stepBall` is pure, sending this
   * launch state is all the other peer needs to reproduce the same trajectory.
   * It is an event rather than a call into a net layer so the controller stays
   * unaware of the network, and so the launch sites keep their single job.
   */
  | {
      type: "ball-launched";
      side: Side;
      action: "serve" | "strike" | "pop";
      pos: Vector3;
      vel: Vector3;
      clip: string;
      spin: number;
    };

export interface MatchUI {
  setScore(player: number, ai: number, server: Side, setsPlayer: number, setsAi: number): void;
  banner(text: string, sub?: string): void;
  hint(text: string | null): void;
  onMatchEnd(winner: Side): void;
  /** Precision bar: fill fraction (null hides it) plus the sweet zone bounds. */
  meter?(frac: number | null, sweetStart: number, sweetEnd: number): void;
  /** Flash the graded quality of the strike press that was just committed. */
  meterResult?(quality: number): void;
}

/** A press waiting for the ball to become hittable, with what it asked for. */
type BufferedPress =
  | { kind: "strike"; aim: StrikeAim; ttl: number }
  | { kind: "pop"; aimX: number; aimZ: number; ttl: number }
  | null;

const other = (s: Side): Side => (s === "player" ? "ai" : "player");
const sign = (s: Side): number => (s === "player" ? -1 : 1);

// Seconds between pressing a touch button and the animation's contact frame
// (when the ball actually leaves). Small enough to feel responsive, long
// enough for the wind-up to read.
const STRIKE_LEAD = 0.15;
const POP_LEAD = 0.12;
const STRIKE_SPEED = 1.3;
const POP_SPEED = 1.25;

// The ball flies its natural trajectory; the PLAYER moves to meet it. The
// contact frame may land anywhere in this window after the press — the planner
// picks the sampled moment whose ball height best matches the clip's contact
// height, and the character lunges so the limb is there at that moment.
const CONTACT_WINDOW = { min: 0.1, max: 0.4 };
// Furthest the character may glide during a wind-up to reach the ball (m).
const LUNGE_MAX = 1.0 * TABLE_SCALE;
// Final polish only: nudge the ball at most this far onto the limb at the
// contact frame (covers prediction drift). Bigger misses stay visible.
const CONTACT_SNAP = 0.18 * TABLE_SCALE;
/**
 * Final approach: inside this window before the planned contact the ball is
 * steered onto the limb, and released by the countdown itself (the animation
 * callback can lag a frame, which let the ball fly past the limb).
 *
 * It is long enough to be a curve rather than a correction. The gain ramps
 * from nearly nothing at the start of the window to fully committed at the
 * contact frame, so the ball bends onto the foot over several frames instead
 * of jumping onto it in the last two — the difference between a touch that
 * looks played and one that looks snapped.
 */
const STEER_WINDOW = 0.3;
/** Gain on the steering, per second, at the start and at the end of the window. */
const STEER_GAIN = { start: 5, end: 26 };
// Beyond this gap the touch is a genuine miss — no steering, no snap.
const STEER_MAX_GAP = 0.6 * TABLE_SCALE;
// How near an incoming ball a player has to be for the automatic first
// reception. Wider than PLAYER_REACH — being close should be enough — but only
// a little: a reception granted from two paces away stops reading as standing
// in the right place. Scaled with the court, so it stays the same distance in
// paces however big the table is drawn.
const AUTO_RECEPTION_REACH = 1.36 * TABLE_SCALE;
/**
 * Furthest a set-up touch can place the ball from the player who takes it.
 *
 * The old carry was a fixed 1.3 m in whatever direction was asked for, which
 * from a camera standing behind the player meant a lateral placement read
 * clearly and a forward or backward one barely read at all — the reception
 * looked like it only went left and right. A tap now places the ball where it
 * was tapped, up to this far, so playing the ball deep is a real option.
 */
const POP_CARRY = 2.4 * TABLE_SCALE;
/**
 * How long a tapped set-up keeps trying. Longer than a button press's buffer:
 * a tap is aimed at a moment as much as at a place, and the ball it is aimed
 * at is often still rising out of the player's own previous touch.
 */
const TAP_PRESS_BUFFER = 0.9;
// Holding the kick control this long charges it fully. Long enough that the
// difference between a tap and a held kick is a decision, short enough to make
// inside the second or so a ball hangs in the air.
const CHARGE_TIME = 0.8;
/** Power a kick released without any charge at all is struck at. */
const TAP_POWER = 0.3;
/** How fast the aim marker travels under a fully pushed stick, in m/s. */
const AIM_SPEED = 5.4;
/**
 * Power up to which a kick still lands roughly where it was aimed. Past it the
 * spread widens faster than the extra pace is worth, unless the striker's
 * precision has been improved enough to carry it.
 */
const SAFE_POWER = 0.62;

// Celebration pool: any of these NLA tracks present on the model may play,
// for point wins and the match win alike.
const CELEBRATIONS = ["EndOfGameVictory", "Celebration1", "Celebration2"];
// Beat between the rally ending and the winner starting to celebrate (s).
const CELEBRATE_DELAY = 0.4;
// Body capsule radius as a fraction of character height (the ball deflects
// off bodies instead of passing through the mesh).
const BODY_RADIUS = 0.15;
// A strike/pop press stays valid this long: if the touch can't start yet (ball
// an arm's length out of reach, possession not open until the bounce, previous
// animation finishing) it retries every frame instead of being dropped.
const PRESS_BUFFER = 0.35;
// One physical bounce registers several table contacts when the ball skims
// flat or rolls (a contact every few ms) — same-side contacts within this
// window count as the same bounce for the rules.
const TABLE_BOUNCE_DEBOUNCE = 0.25;
/**
 * Touches in a point before it counts as a long rally.
 *
 * Six is two full possessions: the ball has crossed the net and come back,
 * which is the smallest thing that is recognisably a rally rather than a serve
 * and a mistake.
 */
const LONG_RALLY_TOUCHES = 6;
// Guest-side character easing between the host's 20 Hz snapshots: run toward
// the reported spot, snap if the gap is too big to be a run, and take the
// position exactly once close, so the locomotion blend can reach idle.
const FOLLOWER_SNAP = 3.0;
const FOLLOWER_CONVERGE = 0.12;
const FOLLOWER_ARRIVE = 0.01;

/** Position on a sampled flight at (or just after) time `t`, clipped to before any ground bounce. */
function flightAt(flight: FlightSample[], t: number): Vector3 {
  let last = flight[0];
  for (const s of flight) {
    if (s.grounded) break;
    last = s;
    if (s.t >= t) break;
  }
  return last.pos;
}

export class MatchController {
  state: MatchState = "serve_move";
  /** Practice keeps the rules, scoring, and resets, but never ends the match. */
  practice = false;
  /** Points in the current set. */
  score: Record<Side, number> = { player: 0, ai: 0 };
  /** Sets won; first to SETS_TO_WIN takes the game. */
  sets: Record<Side, number> = { player: 0, ai: 0 };
  /**
   * Totals for the whole match, which the career is settled from.
   *
   * Separate from `score` because that one resets between sets: a challenge
   * asking for forty points means forty points in the match, and reading them
   * off a counter that goes back to zero twice would be wrong in a way nobody
   * would notice until a player complained the challenge never finished.
   */
  tally: { points: Record<Side, number>; longRallies: number } = {
    points: { player: 0, ai: 0 },
    longRallies: 0,
  };
  /** Touches by both sides in the point being played, for the long-rally count. */
  private pointTouches = 0;
  /**
   * Two-human mode: the "ai" side is driven by `versusInput` (court-space,
   * fed each frame by the app from the second controller) instead of the AI.
   */
  versus = false;
  /**
   * Online play: the "ai" side is a remote human. Set alongside `versus`, and
   * takes precedence over it — the second seat is filled from the network
   * rather than from a second local controller.
   */
  /**
   * Online guest: this controller shows a match it does not run.
   *
   * Scoring, serve order and every rule decision belong to the host. The guest
   * applies the snapshots it is sent and animates between them, because two
   * rule engines fed by different inputs will not agree for a single rally.
   */
  netFollower = false;
  versusInput: InputState = {
    moveX: 0,
    moveZ: 0,
    strikePressed: false,
    strikeHeld: false,
    strikePower: 0,
    popPressed: false,
    confirmPressed: false,
  };
  serveOwner: Side = "player";
  /** Last side to send the ball over the net (serve or return). */
  lastHitter: Side = "player";
  /** Which side may touch the ball (set once it bounces on their half). */
  strikeableSide: Side | null = null;
  /** Touches used in the current possession (max MAX_TOUCHES per teqball rules). */
  touchCount = 0;
  /** A training lesson can freeze simulation at an event boundary. */
  private tutorialFrozen = false;
  private eventListeners = new Set<(event: MatchEvent) => void>();

  readonly ball: Ball;
  readonly chars: Record<Side, Character>;
  /** Optional ring mesh showing the player's current strike target. */
  aimMarker: Mesh | null = null;
  /** Optional X mesh showing where the airborne ball will first come down. */
  landingMarker: Mesh | null = null;
  /** Cached prediction for the landing marker (refreshed with the intercepts). */
  private landingSpot: { pos: Vector3; onTable: boolean } | null = null;
  /** Buffered strike/pop presses, retried until they land or expire. */
  private bufferedPress: BufferedPress = null;
  private bufferedPress2: BufferedPress = null;
  /**
   * Where each side's next kick is aimed, in world x/z on the court plane.
   *
   * A point, not a pair of stick offsets bent onto the table: the aim can sit
   * anywhere on the court, including places a kick has no business landing.
   * That is what makes a miss the player's own doing rather than the game's.
   */
  private aimSpot: Record<Side, Vector3> = {
    player: new Vector3(TABLE.halfLen * 0.6, 0, 0),
    ai: new Vector3(-TABLE.halfLen * 0.6, 0, 0),
  };
  /** Seconds each side has held its kick control, 0 when nothing is charging. */
  private charging: Record<Side, number> = { player: 0, ai: 0 };
  /** Table-bounce debounce state (see TABLE_BOUNCE_DEBOUNCE). */
  private tableEventCooldown = 0;
  private lastTableSide: Side | null = null;
  /** After the player's own pop: spot to auto-run to so the drop stays in reach. */
  private selfSetupSpot: Vector3 | null = null;
  /** Same, for the second human in versus mode. */
  private selfSetupSpot2: Vector3 | null = null;
  /**
   * Set while a touch wind-up is in flight. For serves: where the toss arc
   * ends (the ball relaunches from there at contact). For rally touches also
   * carries the countdown to the planned contact, the striking character/clip
   * (live steering target) and the release callback. Rule events are suspended
   * while set, so the committed touch can't be faulted mid-wind-up.
   */
  private contactSync: {
    point: Vector3;
    char?: Character;
    clip?: string;
    timeLeft?: number;
    fire?: () => void;
  } | null = null;

  /**
   * Plan a touch so the PLAYER meets the BALL (never the other way around):
   * scan the ball's sampled natural flight for the moment inside the wind-up
   * window whose height best matches the clip's contact height and whose
   * horizontal gap the character can cover, and return the clip start fraction
   * that puts the contact frame exactly on that moment.
   */
  private planContact(
    char: Character,
    clip: string,
    speed: number,
    flight: FlightSample[]
  ): { t: number; pos: Vector3; startFrac: number } {
    const cp = char.clipContactPoint(clip);
    const contactY = cp ? cp.y : char.position.y + char.height * 0.5;
    // The clip can't wind up longer than its pre-contact frames allow.
    const maxLead = Math.min(CONTACT_WINDOW.max, contactDelaySeconds(clip, speed, 0));
    let best = flight[0];
    let bestCost = Infinity;
    for (const s of flight) {
      // Never schedule the contact on a ball that already bounced on the
      // floor — the touch must happen before the ball touches down.
      if (s.t > maxLead || s.grounded) break;
      const overreach = cp ? Math.max(0, Math.hypot(s.pos.x - cp.x, s.pos.z - cp.z) - LUNGE_MAX) : 0;
      const cost =
        Math.abs(s.pos.y - contactY) + 1.5 * overreach + (s.t < CONTACT_WINDOW.min ? 0.5 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = s;
      }
    }
    return { t: best.t, pos: best.pos, startFrac: windupStartFraction(clip, speed, best.t) };
  }

  /**
   * Start the lunge that carries the clip's contact point onto the planned
   * ball position, and open the wind-up window (rule events suspend; the
   * release fires from the countdown in update()).
   */
  private beginContactLunge(
    char: Character,
    clip: string,
    plan: { t: number; pos: Vector3 },
    fire: () => void
  ): void {
    this.contactSync = { point: plan.pos.clone(), char, clip, timeLeft: plan.t, fire };
    const target = this.contactLungeTarget(char, clip, plan.pos);
    if (target && plan.t >= 0.05) char.lungeTo(target, plan.t);
  }

  /** Target root position that places a clip's striking limb on `point`. */
  private contactLungeTarget(char: Character, clip: string, point: Vector3): Vector3 | null {
    const cp = char.clipContactPoint(clip);
    if (!cp) return null;
    let dx = point.x - cp.x;
    let dz = point.z - cp.z;
    const d = Math.hypot(dx, dz);
    if (d > LUNGE_MAX) {
      dx *= LUNGE_MAX / d;
      dz *= LUNGE_MAX / d;
    }
    const sideSign = char.faceDir === -1 ? -1 : 1;
    const tx = sideSign * Math.min(COURT.maxX, Math.max(COURT.minX, sideSign * (char.position.x + dx)));
    const tz = Math.max(-COURT.maxZ, Math.min(COURT.maxZ, char.position.z + dz));
    // The half runs to the middle line now, so a lunge has to be steered
    // around the table rather than stopped short of its end.
    const clear = clearTable(tx, tz);
    return new Vector3(clear.x, char.position.y, clear.z);
  }

  /**
   * Final polish at the contact frame: nudge the ball the last few centimetres
   * onto the limb. Capped at CONTACT_SNAP so it can never read as a warp —
   * a genuinely missed lunge stays a visible near-miss.
   */
  private snapBallToLimb(char: Character, clip: string): void {
    const limb = char.clipContactPoint(clip);
    if (limb && Vector3.Distance(limb, this.ball.state.pos) <= CONTACT_SNAP) {
      this.ball.state.pos.copyFrom(limb);
    }
  }

  /** The serve toss arc's end point; consumed at the serve's contact frame. */
  private consumeContactPoint(): Vector3 | null {
    const p = this.contactSync?.point ?? null;
    this.contactSync = null;
    return p;
  }

  /** Where the incoming ball becomes playable on each side (refreshed periodically). */
  private interceptSpot: Vector3 | null = null;
  /** Same, for the second human's side in versus mode. */
  private interceptSpot2: Vector3 | null = null;
  private repredictIn = 0;

  /**
   * First point of the ball's future path — after the bounce on `side`'s
   * half — where it hangs at playable height off the table. This is where the
   * reach assist pulls that side's human when they push toward it.
   */
  private computeIntercept(side: Side): Vector3 | null {
    if (this.ball.held || this.touchCount > 0) return null;
    const sgn = sign(side);
    let samples: FlightSample[];
    if (this.strikeableSide === side) {
      // Already bounced: every future sample is playable territory.
      samples = sampleFlight(this.ball.state, 1.5);
    } else if (this.lastHitter === other(side)) {
      const p = predict(this.ball.state, 3);
      if (p.tableBounce?.side !== side) return null;
      samples = p.samples; // post-bounce samples only
    } else {
      return null;
    }
    for (const s of samples) {
      if (s.grounded) break; // past a floor bounce the ball is dead
      // A ball still over the table is about to bounce, not to be received.
      const offTable = !onTableFootprint(s.pos.x, s.pos.z);
      const h = s.pos.y - GROUND_Y;
      if (offTable && sgn * s.pos.x > 0 && h < 1.15 && h > 0.3) {
        // Slightly behind the arrival point, so the assist parks the player
        // beside the flight path (in reach) rather than chest-first into it.
        const clear = clearTable(
          sgn * Math.min(COURT.maxX, Math.max(COURT.minX, sgn * s.pos.x + 0.3)),
          Math.max(-COURT.maxZ, Math.min(COURT.maxZ, s.pos.z))
        );
        return new Vector3(clear.x, GROUND_Y, clear.z);
      }
    }
    return null;
  }

  /**
   * Player run with a soft reach assist: pushing roughly toward the incoming
   * ball's interception point bends the run onto it (stronger the more
   * directly they push), so the player — not the ball — closes the final gap.
   * No input, or input away from the ball, is never overridden.
   */
  /** Bend a court-space stick push toward the side's intercept spot (reach assist). */
  private bendAssist(pos: Vector3, spot: Vector3 | null, mx: number, mz: number): [number, number] {
    const len = Math.hypot(mx, mz);
    if (len > 0.2 && spot) {
      const dx = spot.x - pos.x;
      const dz = spot.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05 && d < REACH_ASSIST.radius) {
        const dot = (mx * dx + mz * dz) / (len * d);
        if (dot > 0.15) {
          const k = REACH_ASSIST.strength * dot;
          mx = mx * (1 - k) + (dx / d) * len * k;
          mz = mz * (1 - k) + (dz / d) * len * k;
        }
      }
    }
    return [mx, mz];
  }

  /**
   * Tap-to-place steering: the player runs to chosen spots instead of being
   * pushed by an axis. Portrait touch play has no stick, so its aim gestures
   * own the axes and movement is a separate instruction.
   */
  tapSteering = false;
  private moveTarget: Vector3 | null = null;

  /** Send the player to a court spot. null cancels and leaves them standing. */
  setMoveTarget(spot: Vector3 | null): void {
    this.moveTarget = spot ? spot.clone() : null;
  }

  /**
   * A tap on the court, from portrait play. One gesture, one rule: a tap where
   * the ball is is a touch, a tap where the ball is not is a shift.
   *
   * With the ball still on its way there is time to go somewhere, so the tap
   * sends the player there. With the ball already in the vicinity there is no
   * time to go anywhere and no point trying, so the same tap plays it — and
   * plays it *to the tapped spot*, which is what makes a set-up placed deep as
   * available as one placed wide.
   *
   * The first touch of a possession is taken automatically, so there the tap
   * only leaves its direction behind for the reception to use. Every touch
   * after it has to be asked for, and the tap is the asking: without this,
   * portrait had no way at all to play a second touch.
   */
  tapAt(spot: Vector3 | null): void {
    if (!spot) return;
    const c = this.chars.player;
    if (!this.touchImminent()) {
      this.setMoveTarget(spot);
      return;
    }
    const dx = spot.x - c.position.x;
    const dz = spot.z - c.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    // The distance tapped is the distance played, up to the full carry. A
    // floor keeps a tap right at the player's feet from being a null placement.
    const carry = Math.min(1, Math.max(0.3, len / POP_CARRY));
    const aim = { x: (dx / len) * carry, z: (dz / len) * carry };
    // A tap that meant a touch must never also be remembered as somewhere to
    // walk. That was the "stored shift": the tap missed its touch, quietly
    // became a destination, and released the player across the court later.
    this.moveTarget = null;
    if (this.touchCount === 0 && this.autoFirstReception) {
      this.receptionAim = aim;
      return;
    }
    const pending = this.pendingTouch;
    if (pending && pending.side === "player" && pending.kind === "pop") {
      // Already committed and waiting for the ball to drop: re-aim it where
      // the player is now pointing rather than queue a second one behind it.
      pending.aimX = aim.x;
      pending.aimZ = aim.z;
      return;
    }
    this.bufferedPress = { kind: "pop", aimX: aim.x, aimZ: aim.z, ttl: TAP_PRESS_BUFFER };
  }

  /**
   * True while the ball is close enough that the next touch is already due.
   *
   * Deliberately not `canTouch`: this asks where the ball is, not whether a
   * touch could start this instant. A tap arriving while the previous touch's
   * animation is still playing is the player asking for the next one, and
   * treating it as anything else is how a tap turns into an unwanted walk.
   */
  private touchImminent(): boolean {
    if (this.state !== "rally" || this.ball.held) return false;
    if (this.strikeableSide !== "player") return false;
    const c = this.chars.player;
    const chest = c.position.add(new Vector3(0, c.height * 0.55, 0));
    return Vector3.Distance(chest, this.ball.state.pos) <= AUTO_RECEPTION_REACH * 1.6;
  }

  /** Where a tap asked the next set-up touch to put the ball, as a carry vector. */
  private receptionAim: { x: number; z: number } | null = null;

  private movePlayer(input: InputState, dt: number): void {
    const player = this.chars.player;
    if (this.moveTarget) {
      if (player.moveToward(this.moveTarget, player.def.speed, dt) === 0) this.moveTarget = null;
      return;
    }
    if (this.tapSteering) {
      // Nothing asked for: ease to a stop rather than freeze mid-stride.
      player.move(0, 0, 0, dt);
      return;
    }
    const [mx, mz] = this.bendAssist(player.position, this.interceptSpot, input.moveX, input.moveZ);
    player.move(mx, mz, player.def.speed, dt);
  }


  private totalPoints = 0;
  private timer = 0;
  private pointWinner: Side | null = null;
  /** Advances only with live simulation. */
  private matchClock = 0;
  private servePhase: "idle" | "toss" | "launched" = "idle";
  private pendingEvents: BallEvent[] = [];

  constructor(
    ball: Ball,
    playerChar: Character,
    aiChar: Character,
    private ui: MatchUI,
    private audio: AudioManager
  ) {
    this.ball = ball;
    this.chars = { player: playerChar, ai: aiChar };
    playerChar.setSide(-1);
    aiChar.setSide(1);
    playerChar.position.set(-SPAWN.x, GROUND_Y + SPAWN.lift, SPAWN.z);
    aiChar.position.set(SPAWN.x, GROUND_Y + SPAWN.lift, SPAWN.z);
    this.beginServeCycle();
    this.ui.setScore(0, 0, this.serveOwner, 0, 0);
  }

  /** Listen for stable match milestones; returns an unsubscribe callback. */
  subscribe(listener: (event: MatchEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Freeze only the simulation; the app can keep rendering the teachable moment. */
  setTutorialFrozen(frozen: boolean): void {
    this.tutorialFrozen = frozen;
  }

  get isTutorialFrozen(): boolean {
    return this.tutorialFrozen;
  }

  /**
   * Guest-side frame: no rules, only presentation.
   *
   * The ball keeps stepping locally between snapshots — `stepBall` is pure and
   * identical on both peers, so this interpolates correctly rather than
   * guessing, and each arriving snapshot corrects any drift. Characters are
   * eased toward their reported positions rather than snapped, so a 20 Hz feed
   * still reads as running.
   */
  private updateAsFollower(dt: number, input: InputState): void {
    this.matchClock += dt;
    this.ball.update(dt);
    for (const side of ["player", "ai"] as Side[]) {
      const target = this.followerPose[side];
      const c = this.chars[side];

      // Prediction, for this peer's own character only. Waiting for the host
      // to answer put a full round trip between pressing a direction and the
      // player leaning that way, which is the one delay a player feels
      // directly. Moving locally and correcting afterwards removes it.
      //
      // Only during a rally: between points the host walks players to serve
      // and receive spots, and predicting from a stick that is not driving
      // that would fight it the whole way.
      if (side === "player" && !c.busy && this.followerPhase === "rally") {
        c.move(input.moveX, input.moveZ, c.def.speed, dt);
        if (target) {
          const fixed = reconcile({ x: c.position.x, z: c.position.z }, target, dt);
          c.position.x = fixed.x;
          c.position.z = fixed.z;
        }
        c.update(dt);
        continue;
      }

      if (target && !c.busy) {
        const dx = target.x - c.position.x;
        const dz = target.z - c.position.z;
        const gap = Math.hypot(dx, dz);
        if (gap > FOLLOWER_SNAP) {
          c.position.x = target.x;
          c.position.z = target.z;
        } else if (gap > FOLLOWER_ARRIVE) {
          const speed = Math.min(gap / FOLLOWER_CONVERGE, c.def.speed);
          const step = Math.min(gap, speed * dt);
          c.position.x += (dx / gap) * step;
          c.position.z += (dz / gap) * step;
        } else {
          c.position.x = target.x;
          c.position.z = target.z;
        }
        // The blend runs off what the host reported, not off how far this
        // frame happened to travel.
        const v = this.followerVel[side];
        c.velocity.set(v.x, 0, v.z);
      }
      c.update(dt);
    }
  }

  /** Latest reported pose, court velocity and action clip, per side. */
  private followerPose: Record<Side, { x: number; z: number } | null> = { player: null, ai: null };
  private followerVel: Record<Side, { x: number; z: number }> = {
    player: { x: 0, z: 0 },
    ai: { x: 0, z: 0 },
  };
  private followerClip: Record<Side, string | null> = { player: null, ai: null };
  /** Host's match phase; prediction only runs during a rally. */
  private followerPhase = "";

  /**
   * Take one side of a snapshot.
   *
   * The reported velocity is kept as well as the position, because the
   * locomotion blend reads velocity and the residual speed of easing toward a
   * 20 Hz target sits below its threshold — a character that slid while
   * standing still in an idle pose was exactly that.
   *
   * A clip that has changed is started here, since a guest runs no rules and
   * would otherwise never play a kick, reception or serve at all.
   */
  private applyFollowerSide(
    side: Side,
    pos: { x: number; z: number },
    vel: { x: number; z: number },
    clip: string | null
  ): void {
    this.followerPose[side] = { x: pos.x, z: pos.z };
    this.followerVel[side] = { x: vel.x, z: vel.z };
    if (clip !== this.followerClip[side]) {
      this.followerClip[side] = clip;
      if (clip) this.chars[side].playAction(clip);
      else this.chars[side].stopAction();
    }
  }

  /**
   * Apply an authoritative frame from the host. Everything here is already in
   * this peer's own coordinates — the wire layer reflects and swaps seats
   * before it arrives.
   */
  applySnapshot(snap: {
    ballPos: { x: number; y: number; z: number };
    ballVel: { x: number; y: number; z: number };
    ballHeld: boolean;
    selfPos: { x: number; z: number };
    opponentPos: { x: number; z: number };
    selfVel: { x: number; z: number };
    opponentVel: { x: number; z: number };
    selfClip: string | null;
    opponentClip: string | null;
    score: [number, number];
    sets: [number, number];
    serveOwner: Side;
    phase: string;
  }): void {
    this.followerPhase = snap.phase;
    this.ball.state.pos.set(snap.ballPos.x, snap.ballPos.y, snap.ballPos.z);
    this.ball.state.vel.set(snap.ballVel.x, snap.ballVel.y, snap.ballVel.z);
    this.ball.held = snap.ballHeld;
    this.applyFollowerSide("player", snap.selfPos, snap.selfVel, snap.selfClip);
    this.applyFollowerSide("ai", snap.opponentPos, snap.opponentVel, snap.opponentClip);
    const changed =
      this.score.player !== snap.score[0] ||
      this.score.ai !== snap.score[1] ||
      this.sets.player !== snap.sets[0] ||
      this.sets.ai !== snap.sets[1] ||
      this.serveOwner !== snap.serveOwner;
    this.score.player = snap.score[0];
    this.score.ai = snap.score[1];
    this.sets.player = snap.sets[0];
    this.sets.ai = snap.sets[1];
    this.serveOwner = snap.serveOwner;
    if (changed) {
      this.ui.setScore(this.score.player, this.score.ai, this.serveOwner, this.sets.player, this.sets.ai);
    }
  }

  private emit(event: MatchEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  /**
   * Announce the ball's new flight, right after it was launched. The vectors
   * are cloned because the live ball state keeps mutating every step, and a
   * listener that forwards this over a network must not have it change
   * underneath it.
   */
  private emitLaunch(side: Side, action: "serve" | "strike" | "pop", clip: string, spin: number): void {
    this.emit({
      type: "ball-launched",
      side,
      action,
      pos: this.ball.state.pos.clone(),
      vel: this.ball.state.vel.clone(),
      clip,
      spin,
    });
  }

  // ---------------------------------------------------------------- serve

  /** Follows the held aim before the serve, so the ball rides the right hand. */
  private serveClip: string = SERVE_CLIPS[0];
  /** Landing aim for the serve (court space); live for the player, rolled once for the AI. */
  private serveAim = { fwd: 0, lat: 0 };

  private beginServeCycle(): void {
    this.state = "serve_move";
    this.servePhase = "idle";
    // A point celebration may still be playing; it must not block the walk
    // to the serve spot.
    this.chars.player.stopAction();
    this.chars.ai.stopAction();
    this.strikeableSide = null;
    this.touchCount = 0;
    this.selfSetupSpot = null;
    this.selfSetupSpot2 = null;
    this.contactSync = null;
    this.pendingTouch = null;
    this.moveTarget = null;
    // A charge only ever advances during a rally, so one held when the point
    // ended would otherwise sit there — on the power bar, and on the next
    // kick — until something else cleared it.
    this.charging = { player: 0, ai: 0 };
    this.receptionAim = null;
    this.celebration = null;
    this.interceptSpot = null;
    this.repredictIn = 0;
    if (this.serveOwner === "ai" && !this.versus) {
      // The AI rolls its aim once; its clip follows the same aim→clip rule.
      const ownLat = Math.random() * 2 - 1; // + = the AI's own left (-z in court space)
      this.serveClip = serveClipForAim(ownLat);
      this.serveAim = { fwd: Math.random() * 1.4 - 0.7, lat: -ownLat };
    } else {
      // Neutral aim until the player holds a direction (updated live below).
      this.serveClip = serveClipForAim(0);
      this.serveAim = { fwd: 0, lat: 0 };
    }
    this.ball.held = true;
    this.ui.hint(null);
  }

  /**
   * Re-pick the player's serve clip from the held lateral aim (+ = own left):
   * left aim → right-foot serve, right aim → left-foot serve, centre → head
   * serve. Only switches when the aim leaves the current clip's band, so the
   * head-serve side isn't re-rolled every frame.
   */
  private updateServeClipFromAim(ownLat: number): void {
    const cur = this.serveClip;
    const inBand =
      ownLat > 0.25
        ? cur === "ServeRightFoot"
        : ownLat < -0.25
          ? cur === "ServeLeftFoot"
          : cur.startsWith("HeadServe");
    if (!inBand) this.serveClip = serveClipForAim(ownLat);
  }

  private serveSpot(): Vector3 {
    return new Vector3(sign(this.serveOwner) * SERVE_X, GROUND_Y, 0);
  }

  /**
   * Walk the receiver behind their own service line during every serve phase
   * (per the rules, the receiver must stand behind it too, like the server) —
   * the serve used to become "ready" the moment the server arrived, stranding
   * a far-out receiver mid-court with a stale velocity (jogging in place).
   * moveToward zeroes the velocity on arrival, which also stops the jog blend.
   */
  private walkReceiverHome(dt: number): void {
    const recvSide = other(this.serveOwner);
    const recv = this.chars[recvSide];
    if (recv.busy) return;
    const backX = Math.max(SPAWN.x, SERVE_X);
    recv.moveToward(new Vector3(sign(recvSide) * backX, GROUND_Y, SPAWN.z), recv.def.speed, dt);
  }

  private handPos(c: Character): Vector3 {
    return c.position.add(c.forward.scale(0.3)).add(new Vector3(0, c.height * 0.58, 0));
  }

  /** Live position of the serving palm, so the ball rides it until the toss. */
  private serveHandPos(server: Character): Vector3 {
    const handName = SERVE_TOSS_HAND[this.serveClip] ?? "RightHand";
    const hand = server.findNode(handName);
    if (!hand) return this.handPos(server);
    hand.computeWorldMatrix(true);
    const p = hand.getAbsolutePosition().clone();
    // The hand bone's origin is the wrist, which would sink the ball into the
    // forearm mesh: push it out along forearm→wrist to the palm, and lift it
    // a little so it rests on the palm instead of being centred inside it.
    const fore = server.findNode(handName.replace("Hand", "ForeArm"));
    if (fore) {
      fore.computeWorldMatrix(true);
      const dir = p.subtract(fore.getAbsolutePosition());
      const len = dir.length();
      if (len > 1e-4) p.addInPlace(dir.scale((server.height * 0.075) / len));
    }
    p.y += BALL_RADIUS * 0.5;
    return p;
  }

  /**
   * Track the player's held aim through the serve phases. The clip (and with
   * it the carrying hand) follows the aim only while `allowClipChange` — once
   * the serve animation starts it is locked. Input +z is the player's left,
   * matching serveClipForAim's own-frame convention.
   */
  private updatePlayerServeAim(input: InputState, allowClipChange: boolean): void {
    if (this.serveOwner !== "player") return;
    this.serveAim = { fwd: input.moveX, lat: input.moveZ };
    if (allowClipChange) this.updateServeClipFromAim(input.moveZ);
  }

  /** Versus mode: the second human's held aim while they own the serve. */
  private updateVersusServeAim(allowClipChange: boolean): void {
    if (!this.versus || this.serveOwner !== "ai") return;
    const v = this.versusInput;
    // versusInput is court-space; the ai side attacks -x and its own left is -z.
    this.serveAim = { fwd: -v.moveX, lat: v.moveZ };
    if (allowClipChange) this.updateServeClipFromAim(-v.moveZ);
  }

  private startServe(): void {
    const server = this.chars[this.serveOwner];
    const clip = this.serveClip;
    const group = server.groups.get(clip);
    if (!group) {
      // Fallback: launch directly without an animation.
      this.launchServe();
      return;
    }
    const durSec = (group.to - group.from) / 60;
    const tossF = tossFraction(clip);
    const contactF = contactFraction(clip);
    const airTime = Math.max(0.25, (contactF - tossF) * durSec);
    this.state = "serve_anim";
    this.ui.hint(null);
    server.playAction(clip, {
      speed: 1.0,
      callbacks: [
        {
          frac: tossF,
          fn: () => {
            // Toss: a real ballistic arc from the hand that rises, peaks and
            // falls onto the striking limb exactly at the contact frame.
            const from = this.serveHandPos(server);
            let to =
              server.clipContactPoint(clip) ??
              server.position.add(serveContactOffset(clip, server.forward, server.height));
            // Head serves: the measured point is the Head bone origin, inside
            // the skull — land the ball on the forehead instead.
            if (clip.startsWith("HeadServe")) to = to.add(server.forward.scale(HEAD_CONTACT_PUSH));
            this.contactSync = { point: to.clone() };
            this.servePhase = "toss";
            this.ball.place(from);
            this.ball.launch(solveLaunch(from, to, airTime));
          },
        },
        {
          frac: contactF,
          fn: () => this.launchServe(),
        },
      ],
    });
  }

  private launchServe(): void {
    const contactPoint = this.consumeContactPoint();
    if (contactPoint) this.ball.state.pos.copyFrom(contactPoint);
    const recv = other(this.serveOwner);
    const server = this.chars[this.serveOwner];
    // Same aim mapping as rally strikes; aiming shrinks the random spray but a
    // residual remains, scaled by the server's precision and serving foot.
    const aim = this.serveAim;
    const tx = sign(recv) * Math.min(1.4, Math.max(0.35, 0.85 + aim.fwd * 0.5));
    const ff = footFactor(server.def, this.serveClip);
    const sprayAmp = (0.25 * ff.spray) / server.def.precision;
    const spray = (Math.random() - 0.5) * sprayAmp * (1 - 0.7 * Math.min(1, Math.abs(aim.lat)));
    const tz = Math.max(-0.62, Math.min(0.62, aim.lat * 0.62 + spray));
    const target = new Vector3(tx, tableSurfaceY(tx) + 0.02, tz);
    const dist = Vector3.Distance(this.ball.state.pos, target);
    // Foot serves fly faster and flatter than head serves.
    const power = (SERVE_POWER[this.serveClip] ?? 1) * server.def.power * ff.power;
    const v = solveLaunchClearingNet(
      this.ball.state.pos,
      target,
      (0.55 + dist * 0.07) / power,
      SERVE_NET_CLEARANCE
    );
    this.servePhase = "launched";
    this.lastHitter = this.serveOwner;
    this.strikeableSide = null;
    this.touchCount = 0;
    this.ball.launch(v);
    this.audio.playKick();
    this.state = "rally";
    this.emitLaunch(this.serveOwner, "serve", this.serveClip, 1);
    this.emit({ type: "serve-committed", side: this.serveOwner });
  }

  // ---------------------------------------------------------------- touches

  /** Common gate for any touch: in a rally, in possession, free and in reach. */
  private canTouch(side: Side, reach = PLAYER_REACH): boolean {
    if (this.state !== "rally" || this.servePhase === "toss") return false;
    if (this.strikeableSide !== side) return false;
    if (this.pendingTouch) return false; // a queued touch is already waiting
    const c = this.chars[side];
    if (c.busy) return false;
    const chest = c.position.add(new Vector3(0, c.height * 0.55, 0));
    return Vector3.Distance(chest, this.ball.state.pos) <= reach;
  }

  /**
   * Semi-automatic reception: standing near an incoming ball is enough to take
   * the first touch of a possession. No press, no timing — being there is the
   * whole requirement.
   *
   * Only the first touch. What to do with the ball once it is under control —
   * set it up again, or finish — stays entirely the player's, and that is
   * where the interesting decision was all along. Chasing the ball down to
   * make contact at all never was one.
   *
   * The vicinity is wider than the reach a pressed touch needs, because "near
   * it" has to actually mean near it. The gap is well inside what the contact
   * lunge can cover (LUNGE_MAX), so the reception still visibly connects.
   */
  autoFirstReception = true;
  private autoReceive(side: Side): void {
    if (!this.autoFirstReception || this.touchCount > 0 || this.ball.held) return;
    if (!this.canTouch(side, AUTO_RECEPTION_REACH)) return;
    // Steered by the last tap if there was one, and set up just in front of
    // the receiver if there was not.
    const aim = side === "player" ? this.receptionAim : null;
    this.receptionAim = null;
    this.tryControlTouch(side, aim?.x ?? 0, aim?.z ?? 0, AUTO_RECEPTION_REACH);
  }

  /** A committed touch waiting for the ball to drop back into striking range. */
  private pendingTouch:
    | { side: Side; kind: "strike"; aim: StrikeAim; wait: number }
    | { side: Side; kind: "pop"; aimX: number; aimZ: number; wait: number }
    | null = null;

  /**
   * Seconds to hold a just-pressed touch before starting its wind-up, so the
   * contact lands once the ball has dropped into striking range. 0 = wind up
   * now. Prevents the ball-still-rising case (e.g. a pop pressed right after
   * an own pop) from striking thin air above the player.
   */
  private touchWait(char: Character): number {
    const flight = sampleFlight(this.ball.state, 1.4);
    let prevY = this.ball.state.pos.y;
    for (const s of flight) {
      if (s.grounded) break; // a ball about to touch down must be hit now or never
      const relH = (s.pos.y - GROUND_Y) / char.height;
      const descending = s.pos.y < prevY;
      prevY = s.pos.y;
      if (descending && relH <= 0.9 && relH >= 0.15) {
        return s.t <= CONTACT_WINDOW.max ? 0 : Math.min(1.1, s.t - 0.28);
      }
    }
    return 0;
  }

  /**
   * What the next kick is asking for.
   *
   * Portrait aims by direction rather than by point: a swipe says "that way,
   * this hard", so the target is placed in front of the striker at a distance
   * the power decides. Landscape hands back the marker the stick has been
   * moving. Either way the power is the charge if one was held, and whatever
   * the input scheme decided for itself if not.
   */
  private aimFor(side: Side, input: InputState): StrikeAim {
    const charged = this.charging[side];
    const power =
      charged > 0
        ? TAP_POWER + (1 - TAP_POWER) * Math.min(1, charged / CHARGE_TIME)
        : Math.max(TAP_POWER, input.strikePower);
    this.charging[side] = 0;
    if (!this.portraitControls || side !== "player") {
      return { target: this.aimSpot[side].clone(), power };
    }
    const c = this.chars[side];
    const len = Math.hypot(input.moveX, input.moveZ);
    // A swipe with no usable direction (or an aim that has gone stale) is
    // played straight ahead rather than dropped.
    const dx = len > 0.05 ? input.moveX / len : sign(other(side));
    const dz = len > 0.05 ? input.moveZ / len : 0;
    const reach = rangeFor(power);
    const target = clampToPlay(new Vector3(c.position.x + dx * reach, 0, c.position.z + dz * reach));
    this.aimSpot[side] = target.clone();
    return { target, power };
  }

  /**
   * Advance a held kick: the stick moves this side's aim marker instead of the
   * player, and the charge grows. Returns true while that is happening, so the
   * caller can keep the striker still.
   *
   * Portrait never charges — its swipe already said how hard — and a side that
   * cannot strike right now cannot line one up either.
   */
  private updateCharge(side: Side, input: InputState, dt: number): boolean {
    const aimable =
      this.state === "rally" &&
      this.strikeableSide === side &&
      !this.chars[side].busy &&
      !this.pendingTouch &&
      !(this.portraitControls && side === "player");
    if (!input.strikeHeld || !aimable) {
      // The release arrives on the same frame as the press it fired, and this
      // runs first: clearing the charge here would throw away the very thing
      // that press is about to spend. aimFor() clears it when it reads it.
      if (!input.strikeHeld && !input.strikePressed) this.charging[side] = 0;
      return false;
    }
    this.charging[side] += dt;
    const spot = this.aimSpot[side];
    spot.x += input.moveX * AIM_SPEED * dt;
    spot.z += input.moveZ * AIM_SPEED * dt;
    this.aimSpot[side] = clampToPlay(spot);
    return true;
  }

  /** Portrait touch play: no aim marker, and the swipe carries the aim. */
  portraitControls = false;

  /**
   * Attempt the return strike for `side`, aimed at a point on the court and
   * struck at a chosen power.
   *
   * Where it actually lands is that point plus a spread: wider the harder the
   * ball is struck, wider again for a contact taken at full stretch, narrower
   * for a precise striker. Nothing clamps the result back onto the table, so a
   * kick aimed at the line and hit flat out can and should miss.
   */
  tryStrike(side: Side, aim: StrikeAim): boolean {
    if (!this.canTouch(side)) return false;
    const c = this.chars[side];
    const popped = this.touchCount > 0; // ball was set up by a control touch
    const power = Math.min(1, Math.max(0, aim.power));

    // Ball still climbing (or way overhead): queue the touch until it drops.
    const wait = this.touchWait(c);
    if (wait > 0) {
      this.pendingTouch = { side, kind: "strike", aim: { target: aim.target.clone(), power }, wait };
      return true;
    }

    this.lastHitter = side;
    this.strikeableSide = null;
    this.touchCount = 0;
    this.pointTouches++;
    if (side === "player") {
      this.ui.hint(null);
      this.selfSetupSpot = null;
    } else {
      this.selfSetupSpot2 = null;
    }

    // Pick the clip from where the ball will NATURALLY be around contact time
    // — its flight is sampled, never altered; the character goes to the ball.
    const flight = sampleFlight(this.ball.state, CONTACT_WINDOW.max + 0.05);
    const probe = flightAt(flight, STRIKE_LEAD);
    const lateral = (probe.z - c.position.z) * (side === "player" ? -1 : 1);
    const ballHeight = probe.y - GROUND_Y; // height above the ground plane
    // Where they are standing decides which shots are even on the menu: the
    // hard ones need the middle line. See `canSmashFrom`.
    const nearMiddle = canSmashFrom(c.position.x);
    let clip = pickStrikeClip(ballHeight, lateral, c.height, c.def.strongFoot, power, nearMiddle);
    // Backflip finish: only reachable off a pop-up that left the ball high,
    // and only with a foot this player's traits allow. If the natural foot is
    // barred but the other one qualifies, a near-centre ball can still be
    // flipped with it.
    if (nearMiddle && popped && ballHeight > c.height * 0.7 && Math.random() < 0.65) {
      // Which foot comes over is decided by where the player is standing, not
      // by where the ball is: see `backflipFoot`. The stance is signed in the
      // player's own frame, the same way `lateral` above is.
      const stance = c.position.z * (side === "player" ? -1 : 1);
      const foot = backflipFoot(stance, c.def);
      if (foot) {
        const flip = foot === "right" ? "BackflipRightFoot" : "BackflipLeftFoot";
        if (c.groups.has(flip)) clip = flip;
      }
    }
    const plan = this.planContact(c, clip, STRIKE_SPEED, flight);
    const yawOffset = clip.startsWith("Backflip") ? Math.PI : 0;
    // The ball leaves at the planned contact moment, from wherever its natural
    // flight put it — the lunge carried the limb there, so the visual contact
    // and the launch coincide. Fired by the countdown in update(); the
    // animation callback is only a fallback (hence the idempotence guard).
    let fired = false;
    const launch = () => {
      if (fired) return;
      fired = true;
      this.contactSync = null;
      if (this.state !== "rally") return; // safety: the point ended mid-wind-up
      this.snapBallToLimb(c, clip);
      // Where it was aimed, plus the spread that aim earned. The stretch term
      // is how far the striker had to reach for the contact: a ball taken at
      // arm's length is not struck as cleanly as one met in front.
      const ff = footFactor(c.def, clip);
      const chest = c.position.add(new Vector3(0, c.height * 0.55, 0));
      const stretch = Vector3.Distance(chest, this.ball.state.pos) / PLAYER_REACH;
      const radius = spreadRadius({
        power,
        precision: c.def.precision,
        footSpray: ff.spray,
        stretch,
      });
      const landed = scatter(aim.target, radius, Math.random);
      // Aiming past the far edge is allowed — that is how a kick misses — but
      // a target beyond the court is not a shot anyone meant to play.
      const wanted = clampToPlay(landed);
      const onTable = onTableHalf(wanted, sign(other(side)));
      const surfaceY = onTable ? tableSurfaceY(wanted.x) : GROUND_Y;
      const target = new Vector3(wanted.x, surfaceY + 0.02, wanted.z);
      const dist = Vector3.Distance(this.ball.state.pos, target);
      // Stronger kicks fly flatter and faster (shorter flight time).
      let kickPower = (KICK_POWER[clip] ?? 1) * c.def.power * ff.power;
      kickPower *= 0.72 + 0.5 * power;
      // The arc follows the requested power first — a soft kick floats, a hard
      // one is drilled — and then the contact: a low volley must still loft
      // over the net while a high contact is hit down. Kicks taken close to
      // the table flatten (there is no runway for a lob), deep ones float a
      // touch more, and each clip's KICK_LOFT nudges it again.
      const relH = (this.ball.state.pos.y - GROUND_Y) / c.height;
      const clipLoft = KICK_LOFT[clip] ?? 1;
      const prox = Math.min(1, Math.max(0, (Math.abs(this.ball.state.pos.x) - TABLE.halfLen) / 2.2));
      let loft =
        loftFor(power) * Math.min(1.1, Math.max(0.35, 1.25 - relH)) * clipLoft * (0.78 + 0.32 * prox);
      // The rule the whole shot selection hangs off: from behind the smash
      // range the ball has to go up, however hard it was asked for. Applied
      // to the arc rather than to the input, so a player who swipes flat out
      // from the back still gets their pace — as a lob.
      loft = Math.max(loft, loftFloor(c.position.x));
      // The smash: a foot volley or backflip taken while the ball is still
      // high, or a header right at the table, flies near-flat and straight and
      // only skims the net.
      const smash =
        nearMiddle &&
        power > 0.7 &&
        (((clip.includes("FootKick") || clip.startsWith("Backflip")) && relH > 0.55) ||
          (clip.includes("HeadKick") && relH > 0.75 && prox < 0.35));
      if (smash) loft = Math.min(loft, 0.42);
      // A backflip is struck above the head and comes down steeply, and the
      // higher it is met the steeper it gets. This is the one shot in the game
      // that should look unanswerable when it is set up properly.
      if (clip.startsWith("Backflip")) {
        loft = Math.min(loft, 0.34 - 0.12 * Math.min(1, Math.max(0, relH - 0.7) / 0.4));
      }
      const clearance = smash ? 0.02 : relH > 0.7 ? 0.05 : clipLoft < 1 ? 0.08 : 0.14;
      // Floor the flight time so the launch stays under this clip's speed cap:
      // headers are quick but human, only foot smashes and backflips get the
      // full whip (a clamped launch would also sag below the net clearance).
      const cap = (KICK_SPEED_CAP[clip] ?? KICK_SPEED_CAP_DEFAULT) * BALL_PACE;
      const flight = Math.max(((0.5 + dist * 0.055) * loft) / (kickPower * BALL_PACE), dist / cap);
      // How close the ball actually came to where it was sent, for the HUD.
      if (side === "player" && !this.versus) {
        this.ui.meterResult?.(Math.max(0, 1 - Vector3.Distance(wanted, aim.target) / SPREAD.max));
      }
      const v = solveLaunchClearingNet(this.ball.state.pos, target, flight, clearance);
      this.ball.launch(v, 0.7 + relH); // smashes visibly spin faster
      this.audio.playKick();
      this.emitLaunch(side, "strike", clip, 0.7 + relH);
      this.emit({ type: "touch-committed", side, action: "strike", afterSetup: popped });
    };

    const played = c.playAction(clip, {
      startFrac: plan.startFrac,
      speed: STRIKE_SPEED,
      callbacks: [{ frac: contactFraction(clip), fn: launch }],
      // Bicycle kicks are performed with the back to the net.
      yawOffset,
    });
    if (played) this.beginContactLunge(c, clip, plan, launch);
    else launch();
    return true;
  }

  /**
   * Control touch (reception/prep): pops the ball up instead of returning it,
   * spending one of the MAX_TOUCHES touches. The held direction (court space)
   * steers where the ball comes down, so the player places their own set-up;
   * with no direction held it hovers just in front. The last allowed touch
   * must cross the net, so it is converted into a strike.
   */
  tryControlTouch(side: Side, aimX = 0, aimZ = 0, reach = PLAYER_REACH): boolean {
    if (!this.canTouch(side, reach)) return false;
    if (this.touchCount >= MAX_TOUCHES - 1) {
      // Out of touches: the set-up becomes the finish, aimed where this side's
      // aim already points and struck at a middling pace.
      return this.tryStrike(side, { target: this.aimSpot[side].clone(), power: 0.55 });
    }
    const c = this.chars[side];

    // Ball still climbing (or way overhead): queue the touch until it drops.
    const wait = this.touchWait(c);
    if (wait > 0) {
      this.pendingTouch = { side, kind: "pop", aimX, aimZ, wait };
      return true;
    }

    this.touchCount++;
    this.pointTouches++;
    if (side === "player") this.ui.hint(null);

    // Pop the ball at the planned contact moment so it rises and comes down
    // at the aimed spot (clamped to this side's half of the court). Fired by
    // the countdown in update(); the animation callback is only a fallback.
    let fired = false;
    const pop = () => {
      if (fired) return;
      fired = true;
      this.contactSync = null;
      if (this.state !== "rally") return;
      this.snapBallToLimb(c, clip);
      const pos = this.ball.state.pos;
      const len = Math.hypot(aimX, aimZ);
      let target: Vector3;
      if (len > 0.2) {
        const carry = Math.min(1, len) * POP_CARRY;
        target = c.position.add(new Vector3((aimX / len) * carry, 0, (aimZ / len) * carry));
      } else {
        target = c.position.add(c.forward.scale(0.5 * TABLE_SCALE));
      }
      // Further to travel, longer in the air: a set-up played across the court
      // has to hang long enough for its own player to arrive under it.
      const rise = (1.0 + 0.55 * Math.min(1, len) + Math.random() * 0.3) * TABLE_SCALE;
      const vy = Math.sqrt(2 * GRAVITY * rise);
      const t = (2 * vy) / GRAVITY;
      const own = sign(side); // own half: sign of x
      // Never onto your own table. Playing the ball onto your own half is a
      // fault, and a set-up the player asked for must not be the thing that
      // loses them the point — a forward tap plays deep, not into the table.
      target.x =
        own * Math.min(COURT.maxX - 0.2, Math.max(TABLE.halfLen + 0.25, own * target.x));
      target.z = Math.max(-COURT.maxZ + 0.2, Math.min(COURT.maxZ - 0.2, target.z));
      const v = new Vector3((target.x - pos.x) / t, vy, (target.z - pos.z) / t);
      this.ball.launch(v, 0.45); // a set-up pop floats with little spin
      this.audio.playKick();
      this.emitLaunch(side, "pop", clip, 0.45);
      // Auto-run there (slightly behind, so the ball drops in front of the player).
      const spot = new Vector3(target.x - c.forward.x * 0.35 * TABLE_SCALE, GROUND_Y, target.z);
      if (side === "player") this.selfSetupSpot = spot;
      else if (this.versus) this.selfSetupSpot2 = spot;
      this.emit({ type: "touch-committed", side, action: "pop" });
    };

    // Clip choice and timing use the ball's sampled natural flight; the
    // character lunges to meet it (see tryStrike).
    const flight = sampleFlight(this.ball.state, CONTACT_WINDOW.max + 0.05);
    const probe = flightAt(flight, POP_LEAD);
    const lateral = (probe.z - c.position.z) * (side === "player" ? -1 : 1);
    const clip = pickReceptionClip(probe.y - GROUND_Y, lateral, c.height, c.def.strongFoot);
    const plan = this.planContact(c, clip, POP_SPEED, flight);
    const played = c.playAction(clip, {
      startFrac: plan.startFrac,
      speed: POP_SPEED,
      callbacks: [{ frac: contactFraction(clip), fn: pop }],
    });
    if (played) {
      this.beginContactLunge(c, clip, plan, pop);
    } else pop();
    return true;
  }

  // ---------------------------------------------------------------- rules

  private onBallEvent(e: BallEvent): void {
    if (this.state !== "rally" || this.servePhase === "toss") return;
    // A touch is committed: its wind-up is playing and the ball will be struck
    // at the contact frame — bounces in between must not decide the point.
    if (this.contactSync) return;
    switch (e.type) {
      case "table": {
        // A flat skim or a rolling ball touches the table every few ms; those
        // contacts are one physical bounce, not a "double bounce".
        if (this.tableEventCooldown > 0 && this.lastTableSide === e.side) {
          this.tableEventCooldown = TABLE_BOUNCE_DEBOUNCE;
          break;
        }
        this.tableEventCooldown = TABLE_BOUNCE_DEBOUNCE;
        this.lastTableSide = e.side;
        if (e.side === this.lastHitter) {
          this.awardPoint(other(this.lastHitter), "Landed on own side!");
        } else if (this.strikeableSide === e.side) {
          // Second bounce on the receiver's half without a return.
          this.awardPoint(this.lastHitter, "Double bounce!");
        } else {
          this.strikeableSide = e.side;
          this.touchCount = 0;
          // A fresh possession starts aimed at the middle of the other half,
          // so an aim left in a corner never carries silently into it.
          this.aimSpot[e.side] = new Vector3(sign(other(e.side)) * TABLE.halfLen * 0.6, 0, 0);
          this.charging[e.side] = 0;
          this.receptionAim = null;
          this.emit({ type: "possession-start", side: e.side });
          if ((e.side === "player" || this.versus) && this.possessionHints < 2) {
            this.possessionHints++;
            this.ui.hint(
              portraitTouch()
                ? "Swipe to return — fast and flat, or slow and looped"
                : "Hold STRIKE to aim and charge · release to kick"
            );
          }
        }
        break;
      }
      case "ground":
      case "side": {
        if (this.strikeableSide !== null) {
          this.awardPoint(this.lastHitter, "Unreturned!");
        } else {
          this.awardPoint(other(this.lastHitter), "Missed the table!");
        }
        break;
      }
      case "body": {
        // A body deflection while the ball is playable spends a touch (as in
        // the real rules — any body part is a touch); past the limit it's a
        // fault. Pre-bounce body hits just deflect: the existing table/ground
        // rules then decide the point.
        if (e.side === this.strikeableSide && this.bodyTouchCooldown <= 0) {
          this.bodyTouchCooldown = 0.3;
          this.touchCount++;
          this.pointTouches++;
          if (this.touchCount > MAX_TOUCHES) {
            this.awardPoint(other(e.side), "Too many touches!");
          }
        }
        break;
      }
      case "net":
        break;
    }
  }

  /** Debounce so one physical deflection can't count as several touches. */
  private bodyTouchCooldown = 0;

  private possessionHints = 0;

  private awardPoint(winner: Side, reason: string): void {
    if (this.state !== "rally") return;
    this.ui.hint(null);
    this.state = "point";
    this.pointWinner = winner;
    this.timer = 0;
    this.strikeableSide = null;
    this.selfSetupSpot = null;
    this.selfSetupSpot2 = null;
    this.contactSync = null;
    this.pendingTouch = null;
    this.interceptSpot = null;
    this.bufferedPress = null;
    this.bufferedPress2 = null;
    this.landingSpot = null;
    // Intent does not survive the point it was formed in. A destination tapped
    // during the rally must not walk the player off their spot as the next
    // serve is being set up.
    this.moveTarget = null;
    this.receptionAim = null;
    this.tableEventCooldown = 0;
    this.lastTableSide = null;
    this.score[winner]++;
    this.totalPoints++;
    this.tally.points[winner]++;
    // A rally the players actually had, rather than a serve nobody returned.
    if (this.pointTouches >= LONG_RALLY_TOUCHES) this.tally.longRallies++;
    this.pointTouches = 0;
    this.emit({ type: "point-awarded", winner, reason });
    this.audio.playApplause();
    // The point winner celebrates after a short beat, while the banner shows
    // (the match-end celebration in finishPoint takes over on the final point).
    this.chars[winner].velocity.setAll(0);
    this.celebration = { side: winner, delay: CELEBRATE_DELAY };
    const who = winner === "player" ? "Your point" : "CPU point";
    this.ui.banner(`${who} — ${this.score.player} : ${this.score.ai}`, reason);
  }

  /** Scheduled point celebration (a short beat after the rally ends). */
  private celebration: { side: Side; delay: number } | null = null;

  /**
   * Play a random clip from the celebration pool. With `fitSec`, prefers clips
   * that fit the window naturally and speeds one up as a last resort.
   */
  private playCelebration(side: Side, fitSec = 0, onEnd?: () => void): void {
    const c = this.chars[side];
    const avail = CELEBRATIONS.filter((n) => c.groups.has(n));
    if (avail.length === 0) return;
    const durOf = (n: string): number => {
      const g = c.groups.get(n)!;
      return (g.to - g.from) / 60;
    };
    const fitting = fitSec > 0 ? avail.filter((n) => durOf(n) <= fitSec * 1.4) : avail;
    const pool = fitting.length > 0 ? fitting : avail;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    const speed = fitSec > 0 ? Math.max(1, durOf(clip) / fitSec) : 1;
    c.playAction(clip, { speed, onEnd });
  }

  private finishPoint(): void {
    if (this.practice) {
      this.serveOwner = "player";
      this.initialServer = "player";
      this.ui.setScore(this.score.player, this.score.ai, this.serveOwner, this.sets.player, this.sets.ai);
      this.beginServeCycle();
      return;
    }

    if (this.score.player >= WIN_SCORE || this.score.ai >= WIN_SCORE) {
      const setWinner: Side = this.score.player >= WIN_SCORE ? "player" : "ai";
      this.sets[setWinner]++;
      if (this.sets[setWinner] >= SETS_TO_WIN) {
        // Game over: the set just won was the deciding one.
        this.state = "over";
        const loser = other(setWinner);
        const winChar = this.chars[setWinner];
        this.playCelebration(setWinner, 0, () => winChar.playAction("Idle", { loop: true }));
        this.chars[loser].playAction("Defeat", {
          onEnd: () => this.chars[loser].playAction("Idle", { loop: true }),
        });
        this.ui.onMatchEnd(setWinner);
        return;
      }
      // Next set: scores reset, the other side serves first.
      this.ui.banner(
        `Set ${this.sets.player + this.sets.ai} — ${this.score.player} : ${this.score.ai}`,
        `Sets ${this.sets.player} : ${this.sets.ai}`
      );
      this.score = { player: 0, ai: 0 };
      this.totalPoints = 0;
      this.initialServer = other(this.initialServer);
    }
    this.serveOwner =
      Math.floor(this.totalPoints / SERVE_EVERY) % 2 === 0
        ? this.initialServer
        : other(this.initialServer);
    this.ui.setScore(this.score.player, this.score.ai, this.serveOwner, this.sets.player, this.sets.ai);
    this.beginServeCycle();
  }

  private initialServer: Side = "player";

  reset(): void {
    this.tutorialFrozen = false;
    this.score = { player: 0, ai: 0 };
    this.sets = { player: 0, ai: 0 };
    this.tally = { points: { player: 0, ai: 0 }, longRallies: 0 };
    this.pointTouches = 0;
    this.totalPoints = 0;
    this.matchClock = 0;
    this.possessionHints = 0;
    this.initialServer = this.practice ? "player" : Math.random() < 0.5 ? "player" : "ai";
    this.serveOwner = this.initialServer;
    this.pointWinner = null;
    this.chars.player.stopAction();
    this.chars.ai.stopAction();
    this.ui.setScore(0, 0, this.serveOwner, 0, 0);
    this.beginServeCycle();
  }

  // ---------------------------------------------------------------- update

  update(dt: number, input: InputState, aiUpdate: (dt: number) => void): void {
    if (this.tutorialFrozen) return;
    // Online guest: the host owns the rules, so running them here too would
    // produce a second, disagreeing match. Only presentation advances.
    if (this.netFollower) {
      this.updateAsFollower(dt, input);
      return;
    }
    this.matchClock += dt;
    const player = this.chars.player;
    const ai = this.chars.ai;

    // Committed rally touch: release the ball on the planned-contact countdown
    // (frame-exact, unlike the animation callback which can lag and let the
    // ball fly behind the limb), and steer it the last few centimetres onto
    // the striking limb so the contact reads clean. A gap beyond
    // STEER_MAX_GAP stays an honest miss.
    const cs = this.contactSync;
    if (cs?.fire && cs.timeLeft !== undefined) {
      cs.timeLeft -= dt;
      if (cs.timeLeft <= 0) {
        cs.fire();
      } else if (cs.timeLeft <= STEER_WINDOW && !this.ball.held && cs.char && cs.clip) {
        const limb = cs.char.clipContactPoint(cs.clip);
        const b = this.ball.state;
        if (limb && Vector3.Distance(limb, b.pos) < STEER_MAX_GAP) {
          const t = cs.timeLeft;
          // Ease in: barely a nudge at the far edge of the window, fully
          // committed at the contact frame. A constant gain applied over three
          // frames is a visible jerk; this is a curve onto the foot.
          const closing = 1 - t / STEER_WINDOW;
          const gain = STEER_GAIN.start + (STEER_GAIN.end - STEER_GAIN.start) * closing * closing;
          const k = Math.min(1, dt * gain);
          b.vel.x += ((limb.x - b.pos.x) / t - b.vel.x) * k;
          b.vel.y += ((limb.y - b.pos.y) / t + 0.5 * GRAVITY * t - b.vel.y) * k;
          b.vel.z += ((limb.z - b.pos.z) / t - b.vel.z) * k;
        }
      }
    }
    if (this.tutorialFrozen) return;

    // Drain physics events collected this frame. During a rally the ball
    // deflects off character bodies — except a character mid-touch-animation,
    // whose sanctioned contact is the planned limb strike.
    this.bodyTouchCooldown = Math.max(0, this.bodyTouchCooldown - dt);
    this.tableEventCooldown = Math.max(0, this.tableEventCooldown - dt);
    let colliders: BodyCollider[] | undefined;
    if (this.state === "rally") {
      colliders = (["player", "ai"] as Side[])
        // A body mid-touch-animation or waiting on a queued touch is exempt:
        // its sanctioned contact is the upcoming limb strike.
        .filter((s) => !this.chars[s].busy && this.pendingTouch?.side !== s)
        .map((s) => {
          const c = this.chars[s];
          return { side: s, base: c.position, height: c.height, radius: c.height * BODY_RADIUS };
        });
    }
    this.ball.update(dt, (e) => this.pendingEvents.push(e), colliders);
    for (const e of this.pendingEvents) {
      this.onBallEvent(e);
      if (this.tutorialFrozen) break;
    }
    this.pendingEvents.length = 0;
    if (this.tutorialFrozen) return;

    switch (this.state) {
      case "serve_move": {
        const server = this.chars[this.serveOwner];
        const d = server.moveToward(this.serveSpot(), server.def.speed, dt);
        this.walkReceiverHome(dt);
        this.updatePlayerServeAim(input, true);
        this.updateVersusServeAim(true);
        this.ball.place(this.serveHandPos(server));
        if (d === 0) {
          this.state = "serve_ready";
          this.timer = 0;
          if (this.serveOwner === "player" || this.versus)
            this.ui.hint(
              portraitTouch() ? "Swipe where you want to serve" : "Hold a direction to aim · STRIKE serves"
            );
          this.emit({ type: "serve-ready", side: this.serveOwner });
        }
        break;
      }
      case "serve_ready": {
        const server = this.chars[this.serveOwner];
        this.walkReceiverHome(dt);
        this.updatePlayerServeAim(input, true);
        this.updateVersusServeAim(true);
        this.ball.place(this.serveHandPos(server));
        this.timer += dt;
        if (this.serveOwner === "player") {
          if (input.strikePressed) this.startServe();
        } else if (this.versus ? this.versusInput.strikePressed : this.timer > 1.1) {
          this.startServe();
        }
        break;
      }
      case "serve_anim": {
        this.walkReceiverHome(dt);
        // The clip is locked, but the landing aim stays live until contact.
        this.updatePlayerServeAim(input, false);
        this.updateVersusServeAim(false);
        // Ball rides the tossing hand until the ball-leaves-hand frame.
        if (this.servePhase === "idle") {
          this.ball.place(this.serveHandPos(this.chars[this.serveOwner]));
        }
        break;
      }
      case "rally": {
        // A queued touch fires its wind-up once the ball has dropped back
        // into striking range (cancelled if possession changed meanwhile).
        if (this.pendingTouch) {
          const p = this.pendingTouch;
          p.wait -= dt;
          if (this.strikeableSide !== p.side) {
            this.pendingTouch = null;
          } else if (p.wait <= 0) {
            this.pendingTouch = null;
            if (p.kind === "strike") this.tryStrike(p.side, p.aim);
            else this.tryControlTouch(p.side, p.aimX, p.aimZ);
          }
        }
        // Track where the incoming ball can be intercepted, for the reach assist.
        this.repredictIn -= dt;
        if (this.repredictIn <= 0) {
          this.repredictIn = 0.15;
          this.interceptSpot = this.computeIntercept("player");
          this.interceptSpot2 = this.versus ? this.computeIntercept("ai") : null;
          this.landingSpot = this.ball.held ? null : this.computeLandingSpot();
        }
        // Holding the kick control hands the stick to the aim marker and
        // charges the shot; the player stands still while they line it up.
        const aiming = this.updateCharge("player", input, dt);
        // After the player's own pop, run to the drop spot automatically —
        // the stick then only aims the finish (the direction that steered the
        // pop would otherwise keep carrying the player past the ball).
        const selfSetup =
          this.strikeableSide === "player" && this.touchCount > 0 && this.selfSetupSpot !== null;
        // The auto-run owns the feet while it lasts, so anywhere the player had
        // asked to stand is spent, not stored. Left queued, it used to take
        // over the moment the auto-run finished and walk them away from the
        // ball they had just set up.
        if (selfSetup) this.moveTarget = null;
        // Busy means an action clip owns the root (it may be lunging): the
        // locomotion velocity has to be gone, not merely decaying.
        if (player.busy) player.velocity.setAll(0);
        else if (aiming) player.move(0, 0, 0, dt);
        else if (selfSetup) player.moveToward(this.selfSetupSpot!, player.def.speed, dt);
        else this.movePlayer(input, dt);
        // Presses are buffered briefly and retried, so releasing just before
        // the ball becomes strikeable (or drops into reach) still lands the
        // touch instead of being swallowed.
        if (input.strikePressed) {
          this.bufferedPress = { kind: "strike", aim: this.aimFor("player", input), ttl: PRESS_BUFFER };
        } else if (input.popPressed) {
          this.bufferedPress = { kind: "pop", aimX: input.moveX, aimZ: input.moveZ, ttl: PRESS_BUFFER };
        }
        if (this.bufferedPress) {
          const bp = this.bufferedPress;
          const done =
            bp.kind === "strike"
              ? this.tryStrike("player", bp.aim)
              : this.tryControlTouch("player", bp.aimX, bp.aimZ);
          bp.ttl -= dt;
          if (done || bp.ttl <= 0) this.bufferedPress = null;
        } else {
          // Nothing pressed: the first touch of the possession is taken for
          // them. A buffered press is checked first so a player going for a
          // direct return never has it received out from under them.
          this.autoReceive("player");
        }
        // Online play arrives here as an ordinary two-human match: the second
        // seat's controls come off the wire into versusInput, exactly where a
        // second local controller would put them.
        if (this.versus) this.updateVersusRally(dt);
        else aiUpdate(dt);
        break;
      }
      case "point": {
        this.timer += dt;
        player.velocity.setAll(0);
        ai.velocity.setAll(0);
        if (this.celebration) {
          this.celebration.delay -= dt;
          if (this.celebration.delay <= 0) {
            // Fit inside what remains of the between-points window.
            this.playCelebration(this.celebration.side, 2.3 - CELEBRATE_DELAY - 0.1);
            this.celebration = null;
          }
        }
        if (this.timer > 1.4) this.ball.held = true;
        if (this.timer > 2.3 && this.pointWinner !== null) {
          this.pointWinner = null;
          this.finishPoint();
        }
        break;
      }
      case "over":
        break;
    }

    if (this.tutorialFrozen) return;

    this.updateAimMarker(input);
    this.updateLandingMarker();
    this.updateMeter();
    player.update(dt);
    ai.update(dt);
  }

  /** Where the airborne ball will first come down (table half or floor). */
  private computeLandingSpot(): { pos: Vector3; onTable: boolean } | null {
    const p = predict(this.ball.state, 3);
    if (p.tableBounce) return { pos: p.tableBounce.pos.clone(), onTable: true };
    for (const s of sampleFlight(this.ball.state, 3)) {
      if (s.grounded) return { pos: s.pos.clone(), onTable: false };
    }
    return null;
  }

  /** Show/track the landing X while a rally ball is in the air. */
  private updateLandingMarker(): void {
    const m = this.landingMarker;
    if (!m) return;
    const spot = this.landingSpot;
    const show =
      this.state === "rally" && !this.ball.held && this.servePhase !== "toss" && spot !== null;
    m.setEnabled(show);
    if (show && spot) {
      const y = spot.onTable ? tableSurfaceY(spot.pos.x) : GROUND_Y;
      m.position.set(spot.pos.x, y + 0.02, spot.pos.z);
    }
  }

  /**
   * Drive the power bar from the kick being charged.
   *
   * The marked band is where the spread is still tight enough to trust a line:
   * past it the ball goes harder and lands less reliably, which is the whole
   * trade the bar exists to show.
   */
  private updateMeter(): void {
    const held = this.charging.player;
    if (held <= 0 || this.versus) {
      this.ui.meter?.(null, 0, 0);
      return;
    }
    const charge = Math.min(1, held / CHARGE_TIME);
    const power = TAP_POWER + (1 - TAP_POWER) * charge;
    const safeUpTo = (SAFE_POWER - TAP_POWER) / (1 - TAP_POWER);
    this.ui.meter?.(power, 0, Math.max(0, Math.min(1, safeUpTo)));
  }

  /**
   * Show where the current aim would send the ball, for whichever human could
   * hit right now (in versus, P2 gets one too).
   *
   * Portrait has no marker at all: its kick is aimed by the swipe that fires
   * it, so there is nothing to show before the gesture and nothing to move.
   */
  private updateAimMarker(input: InputState): void {
    const marker = this.aimMarker;
    if (!marker) return;
    const inServe =
      this.state === "serve_move" || this.state === "serve_ready" || this.state === "serve_anim";
    let side: Side | null = null;
    if (this.state === "rally" && this.strikeableSide) side = this.strikeableSide;
    else if (inServe) side = this.serveOwner;
    if (side === "ai" && !this.versus) side = null; // the CPU aims in private
    if (side === "player" && this.portraitControls) side = null;
    marker.setEnabled(side !== null);
    if (!side) return;
    if (inServe) {
      // The serve still aims by held direction, onto the opponent's half.
      const inp = side === "player" ? input : this.versusInput;
      const fwd = side === "player" ? inp.moveX : -inp.moveX;
      const spot = tableTarget(sign(other(side)), fwd, inp.moveZ);
      marker.position.set(spot.x, tableSurfaceY(spot.x) + 0.025, spot.z);
    } else {
      const spot = this.aimSpot[side];
      const onTable = onTableHalf(spot, sign(other(side)));
      const y = onTable ? tableSurfaceY(spot.x) : GROUND_Y;
      marker.position.set(spot.x, y + 0.025, spot.z);
    }
    // A charging kick swells the marker, so the power in the bar is also
    // visible where the player is actually looking.
    const charge = Math.min(1, this.charging[side] / CHARGE_TIME);
    marker.scaling.setAll(1 + 0.35 * charge + 0.08 * Math.sin(performance.now() / 180));
  }

  /** Versus mode: drive the "ai" character from the second human's input. */
  private updateVersusRally(dt: number): void {
    const v = this.versusInput;
    const c = this.chars.ai;
    // After P2's own pop, auto-run to the drop spot (mirror of player 1).
    const selfSetup =
      this.strikeableSide === "ai" && this.touchCount > 0 && this.selfSetupSpot2 !== null;
    const aiming = this.updateCharge("ai", v, dt);
    if (c.busy || aiming) c.velocity.setAll(0);
    else if (selfSetup) c.moveToward(this.selfSetupSpot2!, c.def.speed, dt);
    else {
      // Same reach assist as player 1, toward this side's intercept.
      const [mx, mz] = this.bendAssist(c.position, this.interceptSpot2, v.moveX, v.moveZ);
      c.move(mx, mz, c.def.speed, dt);
    }
    // The second seat aims and charges exactly as the first does; its axes
    // arrive already expressed in court space, so the marker moves in world
    // coordinates for both. Presses buffer like player 1's.
    if (v.strikePressed) {
      this.bufferedPress2 = { kind: "strike", aim: this.aimFor("ai", v), ttl: PRESS_BUFFER };
    } else if (v.popPressed) {
      this.bufferedPress2 = { kind: "pop", aimX: v.moveX, aimZ: v.moveZ, ttl: PRESS_BUFFER };
    }
    if (this.bufferedPress2) {
      const bp = this.bufferedPress2;
      const done =
        bp.kind === "strike"
          ? this.tryStrike("ai", bp.aim)
          : this.tryControlTouch("ai", bp.aimX, bp.aimZ);
      bp.ttl -= dt;
      if (done || bp.ttl <= 0) this.bufferedPress2 = null;
    } else {
      this.autoReceive("ai");
    }
  }

  /**
   * Where the portrait camera currently sits laterally, and the frame time it
   * is being smoothed over.
   *
   * Wall-clock rather than simulation time on purpose: this is presentation,
   * it must not consume a fixed step, and it must not differ between two peers
   * running the same match at different frame rates.
   */
  private cameraZ = 0;
  private cameraX = -SPAWN.x - CAMERA.portrait.back;
  private cameraDt = 1 / 60;
  private cameraLast = 0;

  private updateCameraForSide(camera: TargetCamera, side: Side, mode: CameraMode): void {
    const playerOne = side === "player";
    const mirror = playerOne ? -1 : 1;
    // Portrait pins the lens horizontally (see scene.ts): a vertically-fixed
    // field of view on a tall screen crops the court's width away.
    const portrait = window.innerWidth < window.innerHeight;
    camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;

    if (mode === "court") {
      // Each mode owns its lens settings. This is important after returning
      // from the wide, clipped top view in split screen.
      camera.minZ = 0.1;
      if (playerOne) {
        // Portrait plays from closer in, so the players read at phone size.
        const shot = portrait && !this.versus ? CAMERA.portrait : CAMERA;
        const baseX = -SPAWN.x - shot.back;
        // Portrait follows the player, because portrait is where it has to:
        // the lens is pinned horizontally, so the frame narrows towards the
        // near end and a player deep in their own half is barely a metre from
        // either edge of it. Landscape stays locked off.
        let camX = baseX;
        if (portrait && !this.versus) {
          const c = this.chars.player;
          const want = portraitCameraShot(c.position.x, c.position.z, baseX);
          const k = Math.min(1, this.cameraDt / CAMERA.portrait.tau);
          this.cameraZ += (want.z - this.cameraZ) * k;
          this.cameraX += (want.x - this.cameraX) * k;
          camX = this.cameraX;
        } else {
          this.cameraZ = 0;
          this.cameraX = baseX;
          camX = baseX;
        }
        // The camera and what it looks at slide together, so the court is
        // panned across rather than swivelled at — a swivel from this close
        // reads as the whole arena leaning.
        const target = new Vector3(0, GROUND_Y + shot.lookY, this.cameraZ);
        camera.position.set(camX, GROUND_Y + shot.height, this.cameraZ);
        camera.setTarget(target);
        // Match the scene's responsive default in solo play, while retaining
        // the deliberately wider half-width lens in local versus. This also
        // restores the correct lens after leaving the wide top view.
        camera.fov = this.versus ? 1.0 : portrait ? CAMERA.portrait.fov : CAMERA.fov;
      } else {
        // The imported gym is asymmetric. A literal mirror of P1's camera is
        // outside its far wall, so P2 gets a deliberately interior position.
        const target = new Vector3(0, GROUND_Y + CAMERA.p2Court.lookY, 0);
        camera.position.set(CAMERA.p2Court.x, GROUND_Y + CAMERA.p2Court.height, 0);
        camera.setTarget(target);
        camera.fov = CAMERA.p2Court.fov;
      }
      return;
    }

    if (mode === "side") {
      // The previous outer sideline crosses a concourse prop. Use the clear
      // opposite side, mirrored for each half of a local-versus match.
      camera.fov = CAMERA.side.fov;
      camera.minZ = CAMERA.side.minZ;
      const target = new Vector3(0, GROUND_Y + CAMERA.side.lookY, 0);
      camera.position.set(0, GROUND_Y + CAMERA.side.height, mirror * CAMERA.side.distance);
      camera.setTarget(target);
      return;
    }

    // A high 90° side orbit. Its ~75° downward pitch and wide lens retain the
    // entire court in each half-width viewport; the near plane hides the
    // nearby roof trusses without affecting players, table, or ball.
    // A full-width solo view can use a tighter lens so players remain legible;
    // each half of local versus keeps the wider split-safe framing.
    camera.fov = this.versus ? CAMERA.top.fov : CAMERA.top.soloFov;
    camera.minZ = CAMERA.top.minZ;
    const target = new Vector3(0, GROUND_Y + CAMERA.top.lookY, 0);
    camera.position.set(
      mirror * CAMERA.top.offsetX,
      GROUND_Y + CAMERA.top.height,
      mirror * CAMERA.top.offsetZ
    );
    camera.setTarget(target);
  }

  /** The match camera, once a frame. */
  updateCamera(camera: TargetCamera, mode: CameraMode = "court"): void {
    const now = performance.now();
    // Clamped: a tab that was in the background for a minute must not snap the
    // camera, and a first frame has no previous one to measure against.
    this.cameraDt = this.cameraLast ? Math.min(0.1, (now - this.cameraLast) / 1000) : 1 / 60;
    this.cameraLast = now;
    this.updateCameraForSide(camera, "player", mode);
  }
}
