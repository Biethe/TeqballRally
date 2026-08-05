import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
  Ball,
  predict,
  sampleFlight,
  solveLaunch,
  solveLaunchClearingNet,
  stepBall,
  type BallEvent,
  type BodyCollider,
  type FlightSample,
  type Side,
} from "./ball";
import {
  backflipAllowed,
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
  GRAVITY,
  GROUND_Y,
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
  WIN_SCORE,
  type CameraMode,
} from "./config";
import type { InputState } from "./input";
import type { AudioManager } from "./audio";
import type { RemotePlayer } from "./net/remote";

export type MatchState = "serve_move" | "serve_ready" | "serve_anim" | "rally" | "point" | "over";
export type ReplayControl = "toggle" | "skip" | "back" | "forward" | "zoom-in" | "zoom-out";

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
  /** Compact on-court marker shown while a highlight replay is running. */
  setReplay?(
    active: boolean,
    label?: string,
    paused?: boolean,
    zoom?: number,
    position?: number,
    duration?: number,
    segment?: string
  ): void;
}

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
const LUNGE_MAX = 1.0;
// Final polish only: nudge the ball at most this far onto the limb at the
// contact frame (covers prediction drift). Bigger misses stay visible.
const CONTACT_SNAP = 0.15;
// Final approach: within this window before the planned contact the ball is
// gently steered onto the limb, and released by the countdown itself (the
// animation callback can lag a frame, which let the ball fly past the limb).
const STEER_WINDOW = 0.15;
// Beyond this gap the touch is a genuine miss — no steering, no snap.
const STEER_MAX_GAP = 0.6;

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
// Guest-side character easing between the host's 20 Hz snapshots: run toward
// the reported spot, snap if the gap is too big to be a run, and take the
// position exactly once close, so the locomotion blend can reach idle.
const FOLLOWER_SNAP = 3.0;
const FOLLOWER_CONVERGE = 0.12;
const FOLLOWER_ARRIVE = 0.01;
// Precision gauge: shown only for kicks (once the ball has been set up by a
// control touch — never during receptions) and only against the CPU. The bar
// fills over this approach horizon (s); only the green segment sends a kick
// across the net toward the aimed opponent-side target.
const METER_HORIZON = 1.25;
// Keep a small tail after the planned contact so the enlarged green zone is
// visibly bounded instead of being clipped against the right edge of the bar.
const METER_POST_HORIZON = 0.25;
const METER_GRADE_SPAN = 0.6;
// The old green band was 0.30 seconds wide. This doubles it to 0.60 seconds;
// its edges line up with the GOOD/OFF quality threshold.
const METER_SWEET_HALF_WINDOW = METER_GRADE_SPAN / 2;
const UNCONTROLLED_QUALITY = 0.45;

// Highlights are deliberately short: they add a satisfying broadcast beat
// without turning every point into an interruption.
const REPLAY_BACKFLIP_CHANCE = 0.55;
const REPLAY_RECENT_WINDOW = 3.8;
const REPLAY_START_DELAY = 0.32;
// Replays deliberately breathe longer than the first implementation: the
// kick and its outgoing ball have time to read before play resumes.
const REPLAY_SPEED = 0.5;
const REPLAY_POST_CONTACT = 2.0;
const REPLAY_MIN_DURATION = 2.7;
const REPLAY_MAX_DURATION = 4.6;
const REPLAY_SCRUB_STEP = 0.75;
const REPLAY_ZOOM_MIN = -2;
const REPLAY_ZOOM_MAX = 3;
// A defender's locomotion is sampled sparsely and re-enacted during the
// highlight.  The replay is presentation-only, so a small path buffer is
// enough to preserve the readable run without storing a full physics trace.
const REPLAY_DEFENDER_SAMPLE_INTERVAL = 1 / 30;
const REPLAY_DEFENDER_TAIL = 0.12;

type ReplayActionKind = "serve" | "strike";

interface ReplayPoseSample {
  time: number;
  position: Vector3;
  rotationY: number;
}

/** A compact re-enactment seed captured when an action launches. */
interface ReplaySeed {
  kind: ReplayActionKind;
  side: Side;
  clip: string;
  startFrac: number;
  /** Speed ratio used by the original action when this seed was captured. */
  sourceSpeed: number;
  /** Seconds from the selected clip frame to ball contact at regular speed. */
  contactIn: number;
  yawOffset: number;
  actorPosition: Vector3;
  actorRotationY: number;
  opponentPosition: Vector3;
  opponentRotationY: number;
  ballOrigin: Vector3;
  ballVelocity: Vector3;
  ballWasHeld: boolean;
  lungeTarget: Vector3 | null;
  launchPosition: Vector3 | null;
  launchVelocity: Vector3 | null;
  /** Live clock when the action was selected, before its contact frame. */
  startedAt: number;
  launchedAt: number;
  backflip: boolean;
  /** Defender path captured while this action was live. */
  defenderSamples: ReplayPoseSample[];
}

interface ReplayPending {
  seed: ReplaySeed;
  label: string;
  delay: number;
}

interface ReplaySegment {
  seed: ReplaySeed;
  /** Position on the combined replay timeline. */
  start: number;
  /** Full presentation length of this action, including its outgoing ball. */
  duration: number;
  /** Presentation time at which this action launches the ball. */
  launchAt: number;
  label: string;
}

interface ReplayPlayback {
  segments: ReplaySegment[];
  label: string;
  elapsed: number;
  duration: number;
  activeSegment: number;
  launched: boolean;
  paused: boolean;
  /** -2..3; positive steps move the camera closer to the fixed replay shot. */
  zoom: number;
}

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
   * Two-human mode: the "ai" side is driven by `versusInput` (court-space,
   * fed each frame by the app from the second controller) instead of the AI.
   */
  versus = false;
  /**
   * Online play: the "ai" side is a remote human. Set alongside `versus`, and
   * takes precedence over it — the second seat is filled from the network
   * rather than from a second local controller.
   */
  remote: RemotePlayer | null = null;
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
  private bufferedPress: { kind: "strike" | "pop"; ttl: number } | null = null;
  private bufferedPress2: { kind: "strike" | "pop"; ttl: number } | null = null;
  /** Table-bounce debounce state (see TABLE_BOUNCE_DEBOUNCE). */
  private tableEventCooldown = 0;
  private lastTableSide: Side | null = null;
  /**
   * Precision bar: seconds until the ball's ideal strike moment for the
   * player, refreshed with the intercepts; `age` accumulates between refreshes.
   */
  private strikeWindow: { tIdeal: number; age: number } | null = null;
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
    return new Vector3(tx, char.position.y, tz);
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
      const offTable = sgn * s.pos.x > COURT.minX || Math.abs(s.pos.z) > 0.95;
      const h = s.pos.y - GROUND_Y;
      if (offTable && sgn * s.pos.x > 0 && h < 1.15 && h > 0.3) {
        // Slightly behind the arrival point, so the assist parks the player
        // beside the flight path (in reach) rather than chest-first into it.
        return new Vector3(
          sgn * Math.min(COURT.maxX, Math.max(COURT.minX, sgn * s.pos.x + 0.3)),
          GROUND_Y,
          Math.max(-COURT.maxZ, Math.min(COURT.maxZ, s.pos.z))
        );
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

  private movePlayer(input: InputState, dt: number): void {
    const player = this.chars.player;
    const [mx, mz] = this.bendAssist(player.position, this.interceptSpot, input.moveX, input.moveZ);
    player.move(mx, mz, player.def.speed, dt);
  }

  private totalPoints = 0;
  private timer = 0;
  private pointWinner: Side | null = null;
  /** Advances only with live simulation; timestamps replay seeds. */
  private matchClock = 0;
  /** Last actual strike/serve launch, eligible to become a highlight. */
  private lastReplaySeed: ReplaySeed | null = null;
  /** Kept separately so a memorable flip can survive one later return. */
  private lastBackflipSeed: ReplaySeed | null = null;
  private serveReplaySeed: ReplaySeed | null = null;
  /** The currently live action whose defender path is still being sampled. */
  private replayRecordingSeed: ReplaySeed | null = null;
  private replayPending: ReplayPending | null = null;
  private replay: ReplayPlayback | null = null;
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
  private updateAsFollower(dt: number): void {
    this.matchClock += dt;
    this.ball.update(dt);
    for (const side of ["player", "ai"] as Side[]) {
      const target = this.followerPose[side];
      const c = this.chars[side];
      if (target && !c.busy) {
        const dx = target.x - c.position.x;
        const dz = target.z - c.position.z;
        const gap = Math.hypot(dx, dz);
        if (gap > FOLLOWER_SNAP) {
          c.position.x = target.x;
          c.position.z = target.z;
          c.velocity.setAll(0);
        } else if (gap > FOLLOWER_ARRIVE) {
          const speed = Math.min(gap / FOLLOWER_CONVERGE, c.def.speed);
          const step = Math.min(gap, speed * dt);
          c.position.x += (dx / gap) * step;
          c.position.z += (dz / gap) * step;
          c.velocity.set((dx / gap) * speed, 0, (dz / gap) * speed);
        } else {
          c.position.x = target.x;
          c.position.z = target.z;
          c.velocity.setAll(0);
        }
      }
      c.update(dt);
    }
  }

  /** Latest reported positions for each side, set from the host's snapshots. */
  private followerPose: Record<Side, { x: number; z: number } | null> = { player: null, ai: null };

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
    score: [number, number];
    sets: [number, number];
    serveOwner: Side;
  }): void {
    this.ball.state.pos.set(snap.ballPos.x, snap.ballPos.y, snap.ballPos.z);
    this.ball.state.vel.set(snap.ballVel.x, snap.ballVel.y, snap.ballVel.z);
    this.ball.held = snap.ballHeld;
    this.followerPose.player = { x: snap.selfPos.x, z: snap.selfPos.z };
    this.followerPose.ai = { x: snap.opponentPos.x, z: snap.opponentPos.z };
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

  /** Capture the exact setup for a replayable action. */
  private makeReplaySeed(
    kind: ReplayActionKind,
    side: Side,
    clip: string,
    startFrac: number,
    sourceSpeed: number,
    contactIn: number,
    yawOffset = 0
  ): ReplaySeed {
    const actor = this.chars[side];
    const opponent = this.chars[other(side)];
    const seed: ReplaySeed = {
      kind,
      side,
      clip,
      startFrac,
      sourceSpeed,
      contactIn,
      yawOffset,
      actorPosition: actor.position.clone(),
      actorRotationY: actor.root.rotation.y,
      opponentPosition: opponent.position.clone(),
      opponentRotationY: opponent.root.rotation.y,
      ballOrigin: this.ball.state.pos.clone(),
      ballVelocity: this.ball.state.vel.clone(),
      ballWasHeld: this.ball.held,
      lungeTarget: null,
      launchPosition: null,
      launchVelocity: null,
      startedAt: this.matchClock,
      launchedAt: -Infinity,
      backflip: clip.startsWith("Backflip"),
      defenderSamples: [
        {
          time: 0,
          position: opponent.position.clone(),
          rotationY: opponent.root.rotation.y,
        },
      ],
    };
    // Keep sampling from the instant the action is selected, not just from
    // contact. The defender can already be moving during the wind-up.
    this.replayRecordingSeed = seed;
    return seed;
  }

  /** The live launch is the only moment a replay seed becomes valid. */
  private commitReplaySeed(seed: ReplaySeed, launchPosition: Vector3, launchVelocity: Vector3): void {
    seed.launchPosition = launchPosition.clone();
    seed.launchVelocity = launchVelocity.clone();
    seed.launchedAt = this.matchClock;
    this.lastReplaySeed = seed;
    if (seed.backflip) this.lastBackflipSeed = seed;
    this.replayRecordingSeed = seed;
  }

  /** Presentation path length in live seconds for a replay segment. */
  private replaySourceDuration(seed: ReplaySeed): number {
    const launchAt = seed.contactIn * (seed.sourceSpeed / REPLAY_SPEED);
    const duration = Math.min(REPLAY_MAX_DURATION, Math.max(REPLAY_MIN_DURATION, launchAt + REPLAY_POST_CONTACT));
    return duration * (REPLAY_SPEED / Math.max(0.1, seed.sourceSpeed));
  }

  /** Sample the non-kicking character while a replayable action is live. */
  private recordReplayDefenderSample(seed: ReplaySeed | null = this.replayRecordingSeed, force = false): void {
    if (!seed) return;
    const time = this.matchClock - seed.startedAt;
    if (time < -1e-4 || time > this.replaySourceDuration(seed) + REPLAY_DEFENDER_TAIL) {
      if (seed === this.replayRecordingSeed) this.replayRecordingSeed = null;
      return;
    }
    const last = seed.defenderSamples[seed.defenderSamples.length - 1];
    if (!force && last && time - last.time < REPLAY_DEFENDER_SAMPLE_INTERVAL) return;
    const defender = this.chars[other(seed.side)];
    seed.defenderSamples.push({
      time,
      position: defender.position.clone(),
      rotationY: defender.root.rotation.y,
    });
  }

  /** Restore the defender's sampled position, facing, and locomotion speed. */
  private applyReplayDefenderPose(seed: ReplaySeed, sourceTime: number): void {
    const defender = this.chars[other(seed.side)];
    const samples = seed.defenderSamples;
    if (samples.length === 0) {
      defender.position.copyFrom(seed.opponentPosition);
      defender.root.rotation.y = seed.opponentRotationY;
      defender.velocity.setAll(0);
      return;
    }

    const first = samples[0];
    let before = first;
    let after = first;
    for (let i = 1; i < samples.length; i++) {
      const sample = samples[i];
      if (sample.time >= sourceTime) {
        after = sample;
        break;
      }
      before = sample;
      after = sample;
    }
    const span = after.time - before.time;
    const t = span > 1e-5 ? Math.max(0, Math.min(1, (sourceTime - before.time) / span)) : 0;
    defender.position.copyFrom(Vector3.Lerp(before.position, after.position, t));
    const yawDelta = Math.atan2(Math.sin(after.rotationY - before.rotationY), Math.cos(after.rotationY - before.rotationY));
    defender.root.rotation.y = before.rotationY + yawDelta * t;
    if (span > 1e-5 && after !== before) {
      defender.velocity.copyFrom(after.position.subtract(before.position).scale(1 / span));
    } else {
      defender.velocity.setAll(0);
    }
  }

  /** Decide whether the point deserves a short broadcast-style re-enactment. */
  private queueReplayForPoint(winner: Side, setWinning: boolean): void {
    if (this.practice || this.replayPending || this.replay) return;
    // The point can be awarded from the physics callback before the normal
    // character-update tail of this frame. Capture that last defender pose so
    // the replay does not freeze one frame before the ball lands.
    this.recordReplayDefenderSample(this.replayRecordingSeed, true);
    const fresh = (seed: ReplaySeed | null): seed is ReplaySeed =>
      !!seed &&
      seed.launchPosition !== null &&
      seed.launchVelocity !== null &&
      this.matchClock - seed.launchedAt <= REPLAY_RECENT_WINDOW;
    const pointSeed = fresh(this.lastReplaySeed) && this.lastReplaySeed.side === winner ? this.lastReplaySeed : null;
    const flipSeed = fresh(this.lastBackflipSeed) ? this.lastBackflipSeed : null;
    const useSetPoint = setWinning && pointSeed !== null;
    const useBackflip = !useSetPoint && flipSeed !== null && Math.random() < REPLAY_BACKFLIP_CHANCE;
    if (!useSetPoint && !useBackflip) return;
    const seed = useSetPoint ? pointSeed : flipSeed!;
    const matchWinning = setWinning && this.sets[winner] + 1 >= SETS_TO_WIN;
    this.replayPending = {
      seed,
      label: useSetPoint ? (matchWinning ? "MATCH POINT" : "SET POINT") : "BACKFLIP REPLAY",
      delay: REPLAY_START_DELAY,
    };
  }

  /** Build one highlight segment: every replay begins directly on its kick. */
  private buildReplaySegments(seed: ReplaySeed): ReplaySegment[] {
    const launchAt = seed.contactIn * (seed.sourceSpeed / REPLAY_SPEED);
    const duration = Math.min(REPLAY_MAX_DURATION, Math.max(REPLAY_MIN_DURATION, launchAt + REPLAY_POST_CONTACT));
    return [
      {
        seed,
        start: 0,
        duration,
        launchAt,
        label: seed.kind === "serve" ? "SERVE" : seed.backflip ? "BACKFLIP KICK" : "KICK",
      },
    ];
  }

  /** Re-stage a seed at an arbitrary presentation time without touching rules. */
  private stageReplayAt(replay: ReplayPlayback, targetTime: number, freeze: boolean): void {
    const max = Math.max(0, replay.duration - 1e-5);
    const time = Math.max(0, Math.min(max, targetTime));
    let segmentIndex = replay.segments.findIndex((s) => time < s.start + s.duration);
    if (segmentIndex < 0) segmentIndex = replay.segments.length - 1;
    const segment = replay.segments[segmentIndex];
    const localTime = Math.max(0, time - segment.start);
    const { seed } = segment;
    const actor = this.chars[seed.side];
    const opponent = this.chars[other(seed.side)];

    // Clear the prior segment before restoring the deterministic seed. This
    // is presentation-only: the live point state remains untouched beneath it.
    for (const side of ["player", "ai"] as Side[]) {
      this.chars[side].resumePresentation();
      this.chars[side].stopAction();
      this.chars[side].velocity.setAll(0);
    }
    actor.position.copyFrom(seed.actorPosition);
    actor.root.rotation.y = seed.actorRotationY;
    opponent.position.copyFrom(seed.opponentPosition);
    opponent.root.rotation.y = seed.opponentRotationY;

    this.placeReplayBall(seed, segment.launchAt, localTime);
    const played =
      localTime > 0
        ? actor.seekAction(seed.clip, {
            startFrac: seed.startFrac,
            speed: REPLAY_SPEED,
            yawOffset: seed.yawOffset,
            elapsed: localTime,
          })
        : actor.playAction(seed.clip, {
            startFrac: seed.startFrac,
            speed: REPLAY_SPEED,
            yawOffset: seed.yawOffset,
          });
    if (played && seed.lungeTarget && segment.launchAt > 0.04) {
      if (localTime <= 0) {
        actor.lungeTo(seed.lungeTarget, segment.launchAt);
      } else if (localTime < segment.launchAt) {
        const p = localTime / segment.launchAt;
        const eased = p * p * (3 - 2 * p);
        actor.position.copyFrom(Vector3.Lerp(seed.actorPosition, seed.lungeTarget, eased));
        actor.lungeTo(seed.lungeTarget, segment.launchAt - localTime);
      } else {
        actor.position.copyFrom(seed.lungeTarget);
      }
    }

    // The kick is deterministic, but the defender is not: they were already
    // moving during the live rally. Re-stage that sampled run on every seek,
    // including when the replay is paused.
    this.applyReplayDefenderPose(seed, localTime * (REPLAY_SPEED / Math.max(0.1, seed.sourceSpeed)));

    replay.elapsed = time;
    replay.activeSegment = segmentIndex;
    replay.launched = localTime >= segment.launchAt;
    if (freeze) {
      this.chars.player.pausePresentation();
      this.chars.ai.pausePresentation();
    }
  }

  /** Put the replay ball at an exact time by re-simulating a copied state. */
  private placeReplayBall(seed: ReplaySeed, launchAt: number, localTime: number): void {
    const factor = REPLAY_SPEED / seed.sourceSpeed;
    const physicalTime = localTime * factor;
    const state = { pos: seed.ballOrigin.clone(), vel: seed.ballVelocity.clone() };
    let held = seed.ballWasHeld;
    if (localTime >= launchAt && seed.launchPosition && seed.launchVelocity) {
      if (!held && seed.contactIn > 0) stepBall(state, seed.contactIn);
      state.pos.copyFrom(seed.launchPosition);
      state.vel.copyFrom(seed.launchVelocity);
      held = false;
      const afterContact = Math.max(0, physicalTime - seed.contactIn);
      if (afterContact > 0) stepBall(state, afterContact);
    } else if (!held && physicalTime > 0) {
      stepBall(state, physicalTime);
    }
    this.ball.state.pos.copyFrom(state.pos);
    this.ball.state.vel.copyFrom(state.vel);
    this.ball.held = held;
    this.ball.mesh?.position.copyFrom(state.pos);
  }

  /** Re-stage the saved setup + finish sequence at slow speed, never rules/input. */
  private startReplay(pending: ReplayPending): void {
    const { seed } = pending;
    if (!seed.launchPosition || !seed.launchVelocity) {
      this.replayPending = null;
      return;
    }
    const segments = this.buildReplaySegments(seed);
    const duration = segments.reduce((total, segment) => total + segment.duration, 0);

    // Start the winner's normal celebration only after the replay returns to
    // the between-points state, rather than fighting the replay action.
    if (this.pointWinner) this.celebration = { side: this.pointWinner, delay: CELEBRATE_DELAY };
    this.replay = {
      segments,
      label: pending.label,
      elapsed: 0,
      duration,
      activeSegment: 0,
      launched: false,
      paused: false,
      zoom: 0,
    };
    this.replayPending = null;
    this.stageReplayAt(this.replay, 0, false);
    this.aimMarker?.setEnabled(false);
    this.landingMarker?.setEnabled(false);
    this.ui.meter?.(null, 0, 0);
    this.syncReplayUI();
  }

  /** True while the action is being re-enacted (as distinct from its short start delay). */
  get isReplayActive(): boolean {
    return this.replay !== null;
  }

  /** True from the point highlight being scheduled until it has been dismissed. */
  get hasReplayPresentation(): boolean {
    return this.replay !== null || this.replayPending !== null;
  }

  /** Route an explicit replay control without ever touching live match state. */
  controlReplay(control: ReplayControl): boolean {
    if (!this.replay) {
      // A fast skip during the short pre-replay beat remains useful and avoids
      // an accidental pause screen just before a highlight starts.
      if (control === "skip" && this.replayPending) {
        this.replayPending = null;
        return true;
      }
      return false;
    }

    if (control === "skip") {
      this.finishReplay();
      return true;
    }
    if (control === "toggle") {
      this.setReplayPaused(!this.replay.paused);
      return true;
    }
    if (control === "back" || control === "forward") {
      this.seekReplay(control === "back" ? -REPLAY_SCRUB_STEP : REPLAY_SCRUB_STEP);
      return true;
    }
    const delta = control === "zoom-in" ? 1 : -1;
    const next = Math.max(REPLAY_ZOOM_MIN, Math.min(REPLAY_ZOOM_MAX, this.replay.zoom + delta));
    if (next !== this.replay.zoom) {
      this.replay.zoom = next;
      this.syncReplayUI();
    }
    return true;
  }

  /** Discrete timeline seek. It works while playing or paused and never runs rules. */
  private seekReplay(delta: number): void {
    const replay = this.replay;
    if (!replay) return;
    const target = Math.max(0, Math.min(replay.duration - 1e-5, replay.elapsed + delta));
    this.stageReplayAt(replay, target, replay.paused);
    this.syncReplayUI();
  }

  private setReplayPaused(paused: boolean): void {
    const replay = this.replay;
    if (!replay || replay.paused === paused) return;
    replay.paused = paused;
    for (const side of ["player", "ai"] as Side[]) {
      if (paused) this.chars[side].pausePresentation();
      else this.chars[side].resumePresentation();
    }
    this.syncReplayUI();
  }

  private syncReplayUI(): void {
    const replay = this.replay;
    const segment = replay ? replay.segments[replay.activeSegment] : undefined;
    this.ui.setReplay?.(
      !!replay,
      replay?.label,
      replay?.paused,
      replay?.zoom,
      replay?.elapsed,
      replay?.duration,
      segment?.label
    );
  }

  /** Advance the presentation-only replay; physics events are intentionally ignored. */
  private updateReplay(dt: number): void {
    const replay = this.replay;
    if (!replay) return;
    if (replay.paused) return;
    let remaining = dt;
    while (remaining > 1e-6 && this.replay === replay) {
      const segment = replay.segments[replay.activeSegment];
      const local = replay.elapsed - segment.start;
      const untilEnd = Math.max(0, segment.duration - local);
      const step = Math.min(remaining, untilEnd);
      if (step > 0) this.advanceReplaySegment(replay, segment, local, step);
      replay.elapsed += step;
      remaining -= step;
      if (local + step >= segment.duration - 1e-5) {
        const next = replay.activeSegment + 1;
        if (next >= replay.segments.length) {
          this.finishReplay();
          return;
        }
        this.stageReplayAt(replay, replay.segments[next].start, false);
      }
    }
    this.syncReplayUI();
  }

  /** Advance the current segment while retaining the normal action playback. */
  private advanceReplaySegment(replay: ReplayPlayback, segment: ReplaySegment, local: number, dt: number): void {
    const { seed } = segment;
    const end = local + dt;
    const advanceBall = (span: number) => {
      if (span <= 0) return;
      if (!this.ball.held) this.ball.update(span * (REPLAY_SPEED / seed.sourceSpeed));
      else this.ball.mesh?.position.copyFrom(this.ball.state.pos);
    };
    if (!replay.launched && end >= segment.launchAt) {
      advanceBall(segment.launchAt - local);
      this.ball.state.pos.copyFrom(seed.launchPosition!);
      this.ball.launch(seed.launchVelocity!);
      replay.launched = true;
      advanceBall(end - segment.launchAt);
    } else {
      advanceBall(dt);
    }
    this.applyReplayDefenderPose(seed, end * (REPLAY_SPEED / Math.max(0.1, seed.sourceSpeed)));
    this.chars.player.update(dt);
    this.chars.ai.update(dt);
  }

  private finishReplay(): void {
    if (!this.replay) return;
    // Stopping a paused group directly can leave its next render frame frozen;
    // resume first so Character.stopAction() restores ordinary locomotion.
    for (const side of ["player", "ai"] as Side[]) this.chars[side].resumePresentation();
    this.replay = null;
    this.ball.held = true;
    this.ball.state.vel.setAll(0);
    this.chars.player.stopAction();
    this.chars.ai.stopAction();
    this.chars.player.velocity.setAll(0);
    this.chars.ai.velocity.setAll(0);
    this.syncReplayUI();
  }

  // ---------------------------------------------------------------- serve

  /** Follows the held aim before the serve, so the ball rides the right hand. */
  private serveClip: string = SERVE_CLIPS[0];
  /** Landing aim for the serve (court space); live for the player, rolled once for the AI. */
  private serveAim = { fwd: 0, lat: 0 };

  private beginServeCycle(): void {
    this.state = "serve_move";
    this.servePhase = "idle";
    this.replay = null;
    this.replayPending = null;
    this.replayRecordingSeed = null;
    this.serveReplaySeed = null;
    this.lastReplaySeed = null;
    this.lastBackflipSeed = null;
    this.ui.setReplay?.(false);
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
    this.serveReplaySeed = this.makeReplaySeed("serve", this.serveOwner, clip, 0, 1, contactF * durSec);

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
    if (this.serveReplaySeed) {
      this.commitReplaySeed(this.serveReplaySeed, this.ball.state.pos, v);
      this.serveReplaySeed = null;
    }
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
  private canTouch(side: Side): boolean {
    if (this.state !== "rally" || this.servePhase === "toss") return false;
    if (this.strikeableSide !== side) return false;
    if (this.pendingTouch) return false; // a queued touch is already waiting
    const c = this.chars[side];
    if (c.busy) return false;
    const chest = c.position.add(new Vector3(0, c.height * 0.55, 0));
    return Vector3.Distance(chest, this.ball.state.pos) <= PLAYER_REACH;
  }

  /** A committed touch waiting for the ball to drop back into striking range. */
  private pendingTouch: {
    side: Side;
    kind: "strike" | "pop";
    aimX: number;
    aimZ: number;
    wait: number;
  } | null = null;

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

  /** Attempt the return strike for `side`. Aim values in [-1, 1]: forward = deeper. */
  tryStrike(side: Side, aimFwd: number, aimLat: number): boolean {
    if (!this.canTouch(side)) return false;
    const c = this.chars[side];
    const popped = this.touchCount > 0; // ball was set up by a control touch

    // Ball still climbing (or way overhead): queue the touch until it drops.
    const wait = this.touchWait(c);
    if (wait > 0) {
      this.pendingTouch = { side, kind: "strike", aimX: aimFwd, aimZ: aimLat, wait };
      this.strikeWindow = null; // system-timed touch: the bar no longer applies
      return true;
    }

    // Grade the player's press timing against the precision gauge: perfect =
    // pressing STRIKE_LEAD before the ideal contact moment. A kick without an
    // active gauge (direct volley, early queued press) stays playable but
    // inaccurate; a visible meter shot must land in green to cross the net.
    // The AI (and both humans in versus) stay neutral (null).
    let quality: number | null = null;
    let meteredShot = false;
    let inGreenZone = true;
    if (side === "player" && !this.versus) {
      const w = this.strikeWindow;
      meteredShot = w !== null;
      if (w) {
        const timingOffset = w.tIdeal - w.age - STRIKE_LEAD;
        inGreenZone = Math.abs(timingOffset) <= METER_SWEET_HALF_WINDOW;
        quality = Math.max(0.1, Math.min(1, 1 - Math.abs(timingOffset) / METER_GRADE_SPAN));
      } else {
        quality = UNCONTROLLED_QUALITY;
      }
      this.strikeWindow = null;
      if (w) this.ui.meterResult?.(quality);
    }

    this.lastHitter = side;
    this.strikeableSide = null;
    this.touchCount = 0;
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
    let clip = pickStrikeClip(ballHeight, lateral, c.height, c.def.strongFoot);
    // Backflip finish: only reachable off a pop-up that left the ball high,
    // and only with a foot this player's traits allow. If the natural foot is
    // barred but the other one qualifies, a near-centre ball can still be
    // flipped with it.
    if (popped && ballHeight > c.height * 0.7 && Math.random() < 0.65) {
      const natural = lateral >= 0 ? "right" : "left";
      const off = natural === "right" ? "left" : "right";
      let foot: typeof natural | null = null;
      if (backflipAllowed(c.def, natural)) foot = natural;
      else if (backflipAllowed(c.def, off) && Math.abs(lateral) < 0.45) foot = off;
      if (foot) {
        const flip = foot === "right" ? "BackflipRightFoot" : "BackflipLeftFoot";
        if (c.groups.has(flip)) clip = flip;
      }
    }
    const plan = this.planContact(c, clip, STRIKE_SPEED, flight);
    const replayYawOffset = clip.startsWith("Backflip") ? Math.PI : 0;
    const replaySeed = this.makeReplaySeed(
      "strike",
      side,
      clip,
      plan.startFrac,
      STRIKE_SPEED,
      plan.t,
      replayYawOffset
    );
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
      const opp = other(side);
      // A miss outside the visible green segment is deliberately short: it
      // lands on the hitter's table half instead of being secretly steered to
      // the opponent-side target. Direct volleys (no visible meter) retain
      // the game's normal, less-accurate behavior.
      const fallsShort = meteredShot && !inGreenZone;
      // Gauge quality rules a successful meter kick. A perfect press (q≈1)
      // bites exactly where aimed; an uncontrolled direct volley wobbles.
      const depthWobble =
        quality === null ? 0 : (Math.random() - 0.5) * 0.9 * (1 - quality);
      const tx = sign(opp) * Math.min(1.45, Math.max(0.3, 0.85 + aimFwd * 0.5 + depthWobble));
      // Held direction picks the landing side of the table; aiming shrinks the
      // random spray but a residual remains, scaled by the striker's precision
      // and by which foot hits (weak-foot kicks wobble, strong-foot ones bite).
      const ff = footFactor(c.def, clip);
      const sprayAmp =
        ((0.2 * ff.spray) / c.def.precision) * (quality === null ? 1 : 2.6 - 2.35 * quality);
      const spray = (Math.random() - 0.5) * sprayAmp * (1 - 0.7 * Math.min(1, Math.abs(aimLat)));
      const tz = Math.max(-0.68, Math.min(0.68, aimLat * 0.62 + spray));
      let target: Vector3;
      if (fallsShort) {
        // Safely inside the hitter's own table half: the existing rules award
        // the opponent once this visibly short shot lands there.
        const shortX = sign(side) * 0.85;
        const shortZ = Math.max(-0.55, Math.min(0.55, aimLat * 0.45 + (Math.random() - 0.5) * 0.12));
        target = new Vector3(shortX, tableSurfaceY(shortX) + 0.02, shortZ);
      } else {
        target = new Vector3(tx, tableSurfaceY(tx) + 0.02, tz);
      }
      const dist = Vector3.Distance(this.ball.state.pos, target);
      // Stronger kicks fly flatter and faster (shorter flight time).
      let power = (KICK_POWER[clip] ?? 1) * c.def.power * ff.power;
      if (quality !== null) power *= 0.88 + 0.18 * quality;
      // The arc follows the contact height: a low volley must loft over the
      // net, while a high contact is drilled flatter. Kicks initiated close to
      // the table also flatten — there is no runway to need a lob — while deep
      // ones float a touch more. On top of that, each clip's KICK_LOFT floats
      // (>1) or flattens (<1) the arc.
      const relH = (this.ball.state.pos.y - GROUND_Y) / c.height;
      const clipLoft = KICK_LOFT[clip] ?? 1;
      const prox = Math.min(1, Math.max(0, (Math.abs(this.ball.state.pos.x) - TABLE.halfLen) / 2.2));
      let loft = Math.min(1.1, Math.max(0.35, 1.25 - relH)) * clipLoft * (0.78 + 0.32 * prox);
      // The smash: a foot volley or backflip taken while the ball is still
      // high, or a header right at the table, flies near-flat and straight and
      // only skims the net.
      const smash =
        ((clip.includes("FootKick") || clip.startsWith("Backflip")) && relH > 0.55) ||
        (clip.includes("HeadKick") && relH > 0.75 && prox < 0.35);
      if (smash) loft = Math.min(loft, 0.42);
      const clearance = smash ? 0.02 : relH > 0.7 ? 0.05 : clipLoft < 1 ? 0.08 : 0.14;
      // Floor the flight time so the launch stays under this clip's speed cap:
      // headers are quick but human, only foot smashes and backflips get the
      // full whip (a clamped launch would also sag below the net clearance).
      const cap = KICK_SPEED_CAP[clip] ?? KICK_SPEED_CAP_DEFAULT;
      const flight = Math.max(((0.5 + dist * 0.055) * loft) / power, dist / cap);
      const v = solveLaunchClearingNet(this.ball.state.pos, target, flight, clearance);
      this.commitReplaySeed(replaySeed, this.ball.state.pos, v);
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
      yawOffset: replayYawOffset,
    });
    if (played) {
      // This is calculated after playAction applies the backflip yaw offset,
      // so the replay uses the same lunge target as the live strike.
      replaySeed.lungeTarget = this.contactLungeTarget(c, clip, plan.pos);
      this.beginContactLunge(c, clip, plan, launch);
    }
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
  tryControlTouch(side: Side, aimX = 0, aimZ = 0): boolean {
    if (!this.canTouch(side)) return false;
    if (this.touchCount >= MAX_TOUCHES - 1) return this.tryStrike(side, aimX, aimZ);
    const c = this.chars[side];

    // Ball still climbing (or way overhead): queue the touch until it drops.
    const wait = this.touchWait(c);
    if (wait > 0) {
      this.pendingTouch = { side, kind: "pop", aimX, aimZ, wait };
      return true;
    }

    this.touchCount++;
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
      const rise = 1.1 + Math.random() * 0.5;
      const vy = Math.sqrt(2 * GRAVITY * rise);
      const t = (2 * vy) / GRAVITY;
      const len = Math.hypot(aimX, aimZ);
      let target: Vector3;
      if (len > 0.2) {
        const carry = Math.min(1, len) * 1.3; // how far the pop travels at full deflection
        target = c.position.add(new Vector3((aimX / len) * carry, 0, (aimZ / len) * carry));
      } else {
        target = c.position.add(c.forward.scale(0.5));
      }
      const own = sign(side); // own half: sign of x
      target.x = own * Math.min(COURT.maxX - 0.2, Math.max(0.6, own * target.x));
      target.z = Math.max(-COURT.maxZ + 0.2, Math.min(COURT.maxZ - 0.2, target.z));
      const v = new Vector3((target.x - pos.x) / t, vy, (target.z - pos.z) / t);
      this.ball.launch(v, 0.45); // a set-up pop floats with little spin
      this.audio.playKick();
      this.emitLaunch(side, "pop", clip, 0.45);
      // Auto-run there (slightly behind, so the ball drops in front of the player).
      const spot = new Vector3(target.x - c.forward.x * 0.35, GROUND_Y, target.z);
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
          this.emit({ type: "possession-start", side: e.side });
          if ((e.side === "player" || this.versus) && this.possessionHints < 2) {
            this.possessionHints++;
            this.ui.hint("Hold a direction to aim · STRIKE returns · RECEPTION sets up");
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
    this.strikeWindow = null;
    this.landingSpot = null;
    this.tableEventCooldown = 0;
    this.lastTableSide = null;
    const setWinning = !this.practice && this.score[winner] + 1 >= WIN_SCORE;
    this.score[winner]++;
    this.totalPoints++;
    this.queueReplayForPoint(winner, setWinning);
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
      this.updateAsFollower(dt);
      return;
    }
    if (this.replay) {
      this.updateReplay(dt);
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
          const k = Math.min(1, dt * 12);
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
            this.ui.hint("Hold a direction to aim · STRIKE serves");
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
            if (p.kind === "strike") this.tryStrike(p.side, p.aimX, p.aimZ);
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
          // Precision gauge: (re)estimate when the player's ideal kick moment
          // comes. Kicks only — the ball must have been set up by a control
          // touch first — and single-player only.
          if (
            !this.versus &&
            this.strikeableSide === "player" &&
            this.touchCount > 0 &&
            !this.chars.player.busy &&
            !this.pendingTouch
          ) {
            const tIdeal = this.idealContactIn("player");
            this.strikeWindow = tIdeal === null ? null : { tIdeal, age: 0 };
          } else if (this.strikeableSide !== "player" || this.touchCount === 0) {
            this.strikeWindow = null;
          }
        }
        if (this.strikeWindow) this.strikeWindow.age += dt;
        // After the player's own pop, run to the drop spot automatically —
        // the stick then only aims the finish (the direction that steered the
        // pop would otherwise keep carrying the player past the ball).
        const selfSetup =
          this.strikeableSide === "player" && this.touchCount > 0 && this.selfSetupSpot !== null;
        if (player.busy) player.velocity.setAll(0);
        else if (selfSetup) player.moveToward(this.selfSetupSpot!, player.def.speed, dt);
        else this.movePlayer(input, dt);
        // Presses are buffered briefly and retried, so pressing just before
        // the ball becomes strikeable (or drops into reach) still lands the
        // touch instead of being swallowed.
        if (input.strikePressed) this.bufferedPress = { kind: "strike", ttl: PRESS_BUFFER };
        else if (input.popPressed) this.bufferedPress = { kind: "pop", ttl: PRESS_BUFFER };
        if (this.bufferedPress) {
          const bp = this.bufferedPress;
          const done =
            bp.kind === "strike"
              ? this.tryStrike("player", input.moveX, input.moveZ)
              : this.tryControlTouch("player", input.moveX, input.moveZ);
          bp.ttl -= dt;
          if (done || bp.ttl <= 0) this.bufferedPress = null;
        }
        // Online: the opponent is neither simulated from input nor by the AI.
        // Its pose is reported by the peer and its strikes arrive already
        // resolved, so there is nothing to decide here — only to follow.
        if (this.remote) this.remote.update(dt, this.chars.ai);
        else if (this.versus) this.updateVersusRally(dt);
        else aiUpdate(dt);
        break;
      }
      case "point": {
        this.timer += dt;
        player.velocity.setAll(0);
        ai.velocity.setAll(0);
        if (this.replayPending) {
          this.replayPending.delay -= dt;
          if (this.replayPending.delay <= 0) {
            this.startReplay(this.replayPending);
            if (this.replay) return;
          }
          break;
        }
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
    this.recordReplayDefenderSample();
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

  /**
   * Seconds until the ball's ideal strike moment for `side` — the first
   * sampled point where it is dropping through comfortable contact height —
   * or null when no such moment is coming.
   */
  private idealContactIn(side: Side): number | null {
    const c = this.chars[side];
    const flight = sampleFlight(this.ball.state, 1.6);
    let prevY = this.ball.state.pos.y;
    for (const s of flight) {
      if (s.grounded) break;
      const relH = (s.pos.y - GROUND_Y) / c.height;
      const descending = s.pos.y < prevY;
      prevY = s.pos.y;
      if (descending && relH <= 0.62 && relH >= 0.28) return s.t;
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

  /** Drive the precision bar from the player's approach window. */
  private updateMeter(): void {
    const w = this.strikeWindow;
    const active =
      w !== null &&
      !this.versus &&
      this.state === "rally" &&
      this.strikeableSide === "player" &&
      this.touchCount > 0 &&
      !this.pendingTouch &&
      !this.chars.player.busy;
    if (!active || !w) {
      this.ui.meter?.(null, 0, 0);
      return;
    }
    const remaining = w.tIdeal - w.age;
    if (remaining < -METER_POST_HORIZON) {
      this.ui.meter?.(null, 0, 0);
      return;
    }
    const meterSpan = METER_HORIZON + METER_POST_HORIZON;
    const frac = Math.min(1, Math.max(0, (METER_HORIZON - remaining) / meterSpan));
    // The green band matches the exact gate used by tryStrike() and keeps a
    // visible off-zone strip on both sides of the enlarged timing window.
    const sweetStart = Math.min(
      1,
      Math.max(0, (METER_HORIZON - (STRIKE_LEAD + METER_SWEET_HALF_WINDOW)) / meterSpan)
    );
    const sweetEnd = Math.min(
      1,
      Math.max(0, (METER_HORIZON - (STRIKE_LEAD - METER_SWEET_HALF_WINDOW)) / meterSpan)
    );
    this.ui.meter?.(frac, sweetStart, sweetEnd);
  }

  /**
   * Show where a strike or serve aimed with the current stick would land, for
   * whichever human could hit right now (in versus, P2 gets it too).
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
    marker.setEnabled(side !== null);
    if (!side) return;
    // Mirror of the target computation in tryStrike / launchServe (no spray).
    const inp = side === "player" ? input : this.versusInput;
    const fwd = side === "player" ? inp.moveX : -inp.moveX; // + = deeper for that side
    const tx = sign(other(side)) * Math.min(1.4, Math.max(0.35, 0.85 + fwd * 0.5));
    const tz = Math.max(-0.62, Math.min(0.62, inp.moveZ * 0.62));
    marker.position.set(tx, tableSurfaceY(tx) + 0.025, tz);
    marker.scaling.setAll(1 + 0.08 * Math.sin(performance.now() / 180));
  }

  /** Versus mode: drive the "ai" character from the second human's input. */
  private updateVersusRally(dt: number): void {
    const v = this.versusInput;
    const c = this.chars.ai;
    // After P2's own pop, auto-run to the drop spot (mirror of player 1).
    const selfSetup =
      this.strikeableSide === "ai" && this.touchCount > 0 && this.selfSetupSpot2 !== null;
    if (c.busy) c.velocity.setAll(0);
    else if (selfSetup) c.moveToward(this.selfSetupSpot2!, c.def.speed, dt);
    else {
      // Same reach assist as player 1, toward this side's intercept.
      const [mx, mz] = this.bendAssist(c.position, this.interceptSpot2, v.moveX, v.moveZ);
      c.move(mx, mz, c.def.speed, dt);
    }
    // Aim semantics match tryStrike: fwd + = deeper into the opponent's half
    // (court -x for this side), lat = court z. Presses buffer like player 1's.
    if (v.strikePressed) this.bufferedPress2 = { kind: "strike", ttl: PRESS_BUFFER };
    else if (v.popPressed) this.bufferedPress2 = { kind: "pop", ttl: PRESS_BUFFER };
    if (this.bufferedPress2) {
      const bp = this.bufferedPress2;
      const done =
        bp.kind === "strike"
          ? this.tryStrike("ai", -v.moveX, v.moveZ)
          : this.tryControlTouch("ai", v.moveX, v.moveZ);
      bp.ttl -= dt;
      if (done || bp.ttl <= 0) this.bufferedPress2 = null;
    }
  }

  /** Apply replay-only camera magnification while preserving the chosen view mode. */
  private applyReplayZoom(camera: TargetCamera, target: Vector3): void {
    const zoom = this.replay?.zoom ?? 0;
    if (zoom === 0) return;
    if (zoom > 0) {
      // Zooming in is safe: it only pulls the eye toward the authored target.
      const distanceScale = 1 - zoom * 0.1;
      camera.position.copyFrom(Vector3.Lerp(target, camera.position, distanceScale));
      return;
    }
    // Never push the eye backward through the gym shell for a zoom-out. Keep
    // the authored, arena-safe camera position and widen its lens instead.
    // This also works for P2's asymmetric court camera and the top preset.
    camera.fov = Math.min(2.05, camera.fov + -zoom * 0.1);
  }

  /** Place one of the fixed match cameras without changing player controls. */
  private updateCameraForSide(camera: TargetCamera, side: Side, mode: CameraMode): void {
    const playerOne = side === "player";
    const mirror = playerOne ? -1 : 1;

    if (mode === "court") {
      // Each mode owns its lens settings. This is important after returning
      // from the wide, clipped top view in split screen.
      camera.minZ = 0.1;
      if (playerOne) {
        const target = new Vector3(0, GROUND_Y + CAMERA.lookY, 0);
        camera.position.set(-SPAWN.x - CAMERA.back, GROUND_Y + CAMERA.height, 0);
        camera.setTarget(target);
        // Match the scene's responsive default in solo play, while retaining
        // the deliberately wider half-width lens in local versus. This also
        // restores the correct lens after leaving the wide top view.
        camera.fov = this.versus ? 1.0 : window.innerWidth < window.innerHeight ? 1.1 : 0.85;
        this.applyReplayZoom(camera, target);
      } else {
        // The imported gym is asymmetric. A literal mirror of P1's camera is
        // outside its far wall, so P2 gets a deliberately interior position.
        const target = new Vector3(0, GROUND_Y + CAMERA.p2Court.lookY, 0);
        camera.position.set(CAMERA.p2Court.x, GROUND_Y + CAMERA.p2Court.height, 0);
        camera.setTarget(target);
        camera.fov = CAMERA.p2Court.fov;
        this.applyReplayZoom(camera, target);
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
      this.applyReplayZoom(camera, target);
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
    this.applyReplayZoom(camera, target);
  }

  /** Fixed match camera for P1 / the single-player view. */
  updateCamera(camera: TargetCamera, mode: CameraMode = "court"): void {
    this.updateCameraForSide(camera, "player", mode);
  }

  /** Fixed match camera for the P2 split-screen view. */
  updateCamera2(camera: TargetCamera, mode: CameraMode = "court"): void {
    this.updateCameraForSide(camera, "ai", mode);
  }
}
