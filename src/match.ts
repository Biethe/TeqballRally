import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
  Ball,
  capLaunchApex,
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
  Character,
  MIN_EFFORT,
  MIN_RESERVE,
  bodyPartOf,
  footFactor,
  assistStrength,
  nearAnchorPush,
  leashPush,
  reachSlack,
  pickReceptionClip,
  chooseStrike,
  strikeBackflipFoot,
  STRIKE_CEILING,
  serveClipForAim,
  serveContactOffset,
  HEAD_CONTACT_PUSH,
  CLIP_CONTACT_BONE,
  SERVE_CLIPS,
  SERVE_TOSS_HAND,
} from "./character";
import { KICK_INPUT, kickLoft, kickPower } from "./kickinput";
import {
  gradeContact,
  receptionPaceFactor,
  setupShape,
  strikeShape,
  timingSense,
  volleyPaceFactor,
} from "./touch";
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
  ANCHOR_STEP_BACK,
  AUTO_RECEPTION_REACH,
  AUTO_RUN,
  RECEPTION_ZONE,
  LUNGE_MAX,
  PLAYER_REACH,
  REACH_ASSIST,
  SERVE_EVERY,
  SERVE_CLEARANCE,
  VENUE_MODIFIERS,
  SERVE_POWER,
  SERVE_X,
  TABLE_SCALE,
  WIN_SCORE,
  CLIPS,
  clipStartFraction,
  SIM_DT,
  SPAWN,
  SETS_TO_WIN,
  type BodyPart,
  type CameraMode,
} from "./config";
import type { InputState } from "./input";
import { aiServePattern } from "./ai";
import type { AudioManager } from "./audio";
import { reconcile } from "./net/reconcile";
import { MAX_CATCHUP_TICKS, type FxKind } from "./net/protocol";
import { PlaybackBuffer, clipFractionAt, clipWindowSpeed, type ClipSample } from "./net/playback";
import {
  distanceToVolume,
  trajectoryVsVolume,
  type WorldVolume,
} from "./interaction";
import {
  clampToPlay,
  clampToTargetHalf,
  canSmashFrom,
  loftFloor,
  loftFor,
  landingDeviation,
  spreadRadius,
  swipeShot,
  swipeTarget,
  serveTarget,
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

const MATCH_STATES: readonly string[] = [
  "serve_move",
  "serve_ready",
  "serve_anim",
  "rally",
  "point",
  "over",
];

/** The phase a snapshot reports arrives as a bare string; this vouches for it. */
function isMatchState(v: string): v is MatchState {
  return MATCH_STATES.includes(v);
}

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
  /** Power bar: fill fraction (null hides it) plus the safe-power band bounds. */
  meter?(frac: number | null, sweetStart: number, sweetEnd: number): void;
  /** How much is left in each player's legs, 0..1. */
  /**
   * How much is left in each player's legs, 0..1, and the ceiling it can
   * recover to. The ceiling is shown because a player has to be able to see
   * that part of the bar is gone for the rest of the match rather than merely
   * waiting to come back.
   */
  stamina?(player: number, ai: number, playerMax: number, aiMax: number): void;
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

/**
 * How the legs empty and fill, per second at a flat run.
 *
 * A match is meant to be a slow decline, not a sawtooth. Three numbers do it:
 *
 * `drain` is what running costs, and it is steep enough to be felt inside a
 * single long rally. `rest` is what standing still buys back — deliberately a
 * fifth of the drain, so recovery is a breather rather than a reset, and it
 * only applies while a player is genuinely still. And `reserveLoss` is the
 * fraction of every drained drop that never comes back at all: it comes off
 * the ceiling recovery works up to (`Character.reserve`), which only ever
 * falls.
 *
 * That last one is the whole model. Without it, resting returned a player to
 * exactly where they started and a match was a series of independent points;
 * with it, the first set is genuinely paid for in the third, a player who
 * chased everything early is visibly labouring later, and fitness — with
 * everything sold for it — is worth having.
 */
const EFFORT = { drain: 0.10, rest: 0.01, restBetweenPoints: 0.02, reserveLoss: 0.30 };
/** Below this fraction of top speed a player counts as standing still. */
const STILL_ENOUGH = 0.2;
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
/**
 * Power a press with no tap count of its own is struck at.
 *
 * The landscape scheme always sends one (see `kickinput.ts`), so this is the
 * floor for a synthesised press — one arriving over the network from a peer
 * too old to send tiers, or one a test made by hand. It has to be a playable
 * kick rather than the softest possible touch.
 */
const TAP_POWER = 0.3;
/**
 * The arc a served ball can be given, as a multiplier on its flight.
 *
 * A tap serves flat and fast; a long hold floats it. Neutral (1) sits between
 * them and is what an unshaped serve gets, so the scale runs both ways around
 * the serve the game has always had.
 */
const SERVE_ARC = { flat: 0.78, floated: 1.6 };
/** How fast the aim marker travels under a fully pushed stick, in m/s. */
const AIM_SPEED = 13.0;
/**
 * Power up to which a kick still lands roughly where it was aimed. Past it the
 * spread widens faster than the extra pace is worth, unless the striker's
 * precision has been improved enough to carry it.
 */
const SAFE_POWER = 0.62;

// Point celebration pool: Celebration* animations for upon point winning.
const POINT_CELEBRATIONS = ["Celebration1", "Celebration2"];
// Match-end victory pool: EndOfGameVictory, MenuPose_Backflip, Stunt2, Stunt3.
const MATCH_WIN_CELEBRATIONS = ["EndOfGameVictory", "MenuPose_Backflip", "Stunt2", "Stunt3"];
// Beat between the rally ending and the winner starting to celebrate (s).
const CELEBRATE_DELAY = 0.4;
// Body capsule radius as a fraction of character height (the ball deflects
// off bodies instead of passing through the mesh).
const BODY_RADIUS = 0.15;
// A strike/pop press stays valid this long: if the touch can't start yet (ball
// an arm's length out of reach, possession not open until the bounce, previous
// animation finishing) it retries every frame instead of being dropped.
const PRESS_BUFFER = 0.35;
// The stick only aims the automatic reception past this magnitude: a resting
// thumb on the nub must not turn every first touch sideways, and the same
// 0.25 convention is what the walking code reads as "asking to move".
const RECEPTION_STICK_DEADZONE = 0.25;
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
// Guest-side guards for the playback timeline: a gap beyond this is not a
// correction but a cold start or a reset, and is taken outright; smaller
// joins glide over FOLLOWER_BLEND_SECONDS.
const FOLLOWER_SNAP = 3.0;
/**
 * How long a server has to play the ball before the point is given away.
 *
 * Against another person only. Eight seconds is a long time to stand holding a
 * ball and no time at all to be rushed by, which is the balance wanted: it
 * ends a stall without ever being something a player has to race.
 */
export const SERVE_CLOCK_SECONDS = 8;
/**
 * How far a guest's clip may drift from the host's before it is pulled back.
 *
 * A twelfth of a clip is about five frames of a kick: past that the swing and
 * the ball are visibly describing different moments, and under it a correction
 * costs more in jitter than the drift costs in truth.
 */
const CLIP_RESYNC_FRACTION = 0.08;
/** How much of it is counted down on screen. */
export const SERVE_CLOCK_COUNTDOWN = 3;
const FOLLOWER_BLEND_SECONDS = 0.25;

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

/**
 * Where a side's next contact is due, and when the ball gets there.
 *
 * The two travel together because every assist that reads the spot also has to
 * ask whether the player can still be at it in time: a metre away is help
 * worth giving with a second in hand and a lost point with a tenth.
 */
export interface Anchor {
  pos: Vector3;
  eta: number;
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
  /**
   * Which seats' feet are currently owned by the run to the drop spot
   * (`runLocked`), mirrored every rally step. The online snapshot carries it,
   * so a guest whose feet the host has taken over stops predicting from a
   * stick that is no longer driving anything.
   */
  lockedState: Record<Side, boolean> = { player: false, ai: false };
  /**
   * Where each seat's next touch is due, for the snapshot to carry.
   *
   * `bendAssist` and `holdNearAnchor` both aim here, so a guest predicting its
   * own character has to be given the same point or the two integrate
   * different equations every step — and the gap between them is not noise
   * `reconcile` can absorb, it is the whole assist, made again each frame.
   */
  get anchorState(): Record<Side, Anchor | null> {
    return this.anchor;
  }
  /**
   * Online host: this controller's match is being published to a guest. Gates
   * the clip-window and fx bookkeeping, which a local match has no use for.
   */
  netPublish = false;
  /**
   * The host-tick window in which each seat's action clip plays: the tick at
   * which the clip is at fraction 0 and the one at which it is at fraction 1.
   * Carried by the snapshot so the guest plays the clip in the same time base
   * as the ball and the positions — at the right fraction of the right
   * instant, instead of restarting it from zero on arrival.
   */
  clipWindow: Record<
    Side,
    { clip: string; from: number; to: number; dur: number; seq: number } | null
  > = {
    player: null,
    ai: null,
  };
  /**
   * Instance number for a clip start, so the guest can tell one playing of a
   * clip from the next one.
   *
   * It used to infer that from the window's `from`, which was fine only while
   * `from` never moved. It moves now — the window is restated from the clip's
   * real progress every step — so identity needs saying rather than deducing.
   */
  private clipSeq = 0;
  /** Clips started since the last drain; the session stamps them with its tick. */
  private clipStarts: { side: Side; clip: string; startFrac: number; durTicks: number }[] = [];
  /** Contacts since the last drain, for the guest's fx stream (capped). */
  private fxQueue: { kind: FxKind; pos?: { x: number; y: number; z: number } }[] = [];
  /** Guest: inbound fx events awaiting their moment on the playback clock. */
  private guestFx: { tick: number; kind: FxKind }[] = [];
  versusInput: InputState = {
    moveX: 0,
    moveZ: 0,
    strikePressed: false,
    strikeHeld: false,
    strikePower: 0,
    popPressed: false,
    confirmPressed: false,
  };
  /**
   * Online host: the tick the second seat's screen was showing when it sent
   * the controls now sitting in `versusInput`. Null for a local second
   * controller, or a peer too old to say.
   *
   * Everything a press is *judged* by is read at this instant instead of now —
   * see `seenBall`. The press itself is executed live, so the ball still goes
   * where the ball really is.
   */
  versusViewTick: number | null = null;
  /**
   * The ball's recent past, in host ticks, so a press can be judged against
   * the moment it was made.
   *
   * Only the host keeps it, and only while publishing: a local match has
   * nobody to rewind for. One entry per simulation step, bounded by the same
   * half-second the rest of the protocol fast-forwards within.
   */
  private ballHistory: { tick: number; pos: Vector3; vel: Vector3 }[] = [];
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
  /** Arrow hanging over whoever is about to serve; hidden the rest of the time. */
  serveMarker: Mesh | null = null;
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
    player: new Vector3(TABLE.halfLen * 0.55, 0, 0),
    ai: new Vector3(-TABLE.halfLen * 0.55, 0, 0),
  };

  /** Reinitialize the strike aim at the center of the opponent's side of the table. */
  private resetAimSpot(side?: Side): void {
    if (side) {
      const attack = sign(other(side));
      this.aimSpot[side] = new Vector3(attack * TABLE.halfLen * 0.55, 0, 0);
    } else {
      this.aimSpot = {
        player: new Vector3(sign(other("player")) * TABLE.halfLen * 0.55, 0, 0),
        ai: new Vector3(sign(other("ai")) * TABLE.halfLen * 0.55, 0, 0),
      };
    }
  }
  /**
   * What each side's kick sequence is currently asking for, for the HUD.
   *
   * Mirrored off the input each step rather than accumulated here: the tap
   * counting happens in `kickinput.ts`, against event timestamps, and a second
   * copy of it running off the simulation clock would disagree with the first
   * on exactly the frames that matter.
   */
  private kickAim: Record<Side, { taps: number; held: number }> = {
    player: { taps: 0, held: 0 },
    ai: { taps: 0, held: 0 },
  };
  /**
   * Portrait's power bar has no tap sequence to track, so the bar instead
   * echoes the power a swipe kick just committed at, for a moment. Frames, not
   * seconds: it is HUD plumbing, not simulation state, and never read by rules.
   */
  private meterEcho: { power: number; frames: number } | null = null;
  /** Table-bounce debounce state (see TABLE_BOUNCE_DEBOUNCE). */
  private tableEventCooldown = 0;
  private lastTableSide: Side | null = null;
  /**
   * After a player's own set-up: the ball is in the air and going nowhere
   * else, so the feet are owned by the run to its drop spot until they arrive
   * (`runLocked`). Cleared when a strike commits or a new possession starts.
   */
  private autoSetupRun: Record<Side, boolean> = { player: false, ai: false };
  /**
   * Arrival latch for the locked run: once a side is close enough to the
   * anchor (`AUTO_RUN.arrive`) the stick is heard again, until the anchor
   * moves far enough (`AUTO_RUN.reengage`) that the arrival no longer covers
   * it and the run picks back up.
   */
  private autoRunArrived: Record<Side, boolean> = { player: false, ai: false };
  /**
   * Horizontal pace each side last struck the ball at (m/s).
   *
   * The reception of that strike is judged against this rather than against
   * `ball.state.vel`, which the table bounce has already damped by the time
   * the ball is playable — a smash and its own bounce-back would otherwise
   * read as the same ball.
   */
  private struckPace: Record<Side, number> = { player: 0, ai: 0 };

  /** The pace the ball this side must answer arrived at (the other side's last strike). */
  incomingPace(side: Side): number {
    return this.struckPace[other(side)];
  }
  /**
   * Which part of the body played this possession's previous touch.
   *
   * The teqball rule — never the same part twice in a row — is enforced from
   * here, at the moment the clip is chosen, because the game chooses the limb.
   * Faulting a player for a limb they did not pick would be punishing them for
   * the animation system's decision; picking a legal limb instead turns the
   * rule into the thing it should be, which is a reason to care what the last
   * touch was.
   */
  private lastPart: Record<Side, BodyPart | null> = { player: null, ai: null };
  /**
   * Set while a touch wind-up is in flight. For serves: where the toss arc
   * ends (the ball relaunches from there at contact). For rally touches also
   * carries the countdown to the planned contact, the striking character/clip
   * (live steering target) and the release callback. Rule events are suspended
   * while set, so the committed touch can't be faulted mid-wind-up.
   */
  private contactSync: {
    point: Vector3;
    timeLeft?: number;
    fire?: () => void;
  } | null = null;

  /**
   * Plan a touch so the PLAYER meets the BALL (never the other way around):
   * scan the ball's sampled natural flight for the moment inside the wind-up
   * window whose height best matches the clip's contact height and whose
   * horizontal gap the character can cover, and return the clip start fraction
   * that puts the contact frame exactly on that moment.
   *
   * The plan also carries how *good* the contact it found is (see `touch.ts`).
   * That is deliberate: everything the grade is made of — the height the ball
   * will be at, how far the limb still has to travel, where in the window the
   * contact falls — is known here and nowhere else, so grading it anywhere else
   * would mean measuring the same contact twice and eventually disagreeing
   * about it.
   */
  /**
   * Evaluate a single candidate clip against the incoming ball trajectory.
   *
   * Returns null if the ball cannot reach this interaction volume, or if the
   * volume is not reachable by the player in time.
   */
  private evaluateCandidate(
    char: Character,
    clip: string,
    flight: FlightSample[],
    maxLead: number,
    earlyBy: number,
    speed: number
  ): { t: number; pos: Vector3; startFrac: number; quality: number; sense: -1 | 0 | 1; worldVol: WorldVolume } | null {
    const worldVol = char.contactVolumeTransform(clip);
    if (!worldVol) return null;

    // Find the first trajectory sample that intersects the volume (with ball radius)
    const hit = trajectoryVsVolume(worldVol, flight, BALL_RADIUS);
    if (!hit.hit) return null;

    const t = hit.t;
    if (t > maxLead || t < CONTACT_WINDOW.min) return null;

    // Check reachability: distance needed from limb's rest position to the ball's hit point
    const volCenter = worldVol.center;
    const lunge = LUNGE_MAX * char.def.agility;
    const lungeDist = Math.hypot(hit.pos.x - volCenter.x, hit.pos.z - volCenter.z);
    const unreachedLunge = Math.max(0, lungeDist - lunge);

    // If the ball is too far for the character's lunge to bridge, reject this candidate
    if (unreachedLunge > 0.08) return null;

    // Compute quality based on how well the ball trajectory fits the volume and visual tightness
    const window = CONTACT_WINDOW.max * char.def.volley;
    const maxLeadSec = Math.min(window, contactDelaySeconds(clip, speed, 0));
    const sweet = (CONTACT_WINDOW.min + maxLeadSec) / 2;
    const half = Math.max(0.08, (maxLeadSec - CONTACT_WINDOW.min) / 2);
    const timing = t - sweet + earlyBy;
    
    const volDist = Math.max(0, distanceToVolume(worldVol, hit.pos) - BALL_RADIUS);
    const visualGap = volDist + unreachedLunge;

    const quality = gradeContact({
      heightError: hit.pos.y - volCenter.y,
      reach: lungeDist,
      timing,
      height: char.height,
      lunge,
      window: half,
      visualGap,
    });

    const startFrac = windupStartFraction(clip, speed, t);
    const sense = timingSense(timing, half);

    return {
      t,
      pos: hit.pos.clone(),
      startFrac,
      quality,
      sense,
      worldVol,
    };
  }

  /**
   * Plan a touch using the animation-derived interaction volumes.
   *
   * Evaluates all valid contact clips for the incoming ball trajectory,
   * selects the best reachable candidate, and returns the contact plan.
   */
  private planContact(
    char: Character,
    clip: string,
    speed: number,
    flight: FlightSample[],
    earlyBy = 0
  ): { t: number; pos: Vector3; startFrac: number; quality: number; sense: -1 | 0 | 1 } {
    const window = CONTACT_WINDOW.max * char.def.volley;
    const maxLead = Math.min(window, contactDelaySeconds(clip, speed, 0));

    // Get all candidate clips for this type of touch
    const candidates = this.getCandidateClips(char, clip, speed);
    let best: { t: number; pos: Vector3; startFrac: number; quality: number; sense: -1 | 0 | 1; worldVol: WorldVolume } | null = null;
    let bestScore = -Infinity;

    for (const candidateClip of candidates) {
      const result = this.evaluateCandidate(char, candidateClip, flight, maxLead, earlyBy, speed);
      if (!result) continue;

      // Score combines quality and reachability
      const score = result.quality * 100 - (result.t * 10); // prefer earlier contact
      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }

    // Fallback to original single-clip logic if no volume-based candidate worked
    if (!best) {
      const cp = char.clipContactPoint(clip);
      const contactY = cp ? cp.y : char.position.y + char.height * 0.5;
      const window = CONTACT_WINDOW.max * char.def.volley;
      const maxLead = Math.min(window, contactDelaySeconds(clip, speed, 0));
      let bestSample = flight[0];
      let bestCost = Infinity;
      const lunge = LUNGE_MAX * char.def.agility;
      for (const s of flight) {
        if (s.t > maxLead || s.grounded) break;
        const lungeDist = cp ? Math.hypot(s.pos.x - cp.x, s.pos.z - cp.z) : 0;
        const overreach = Math.max(0, lungeDist - lunge);
        const cost =
          Math.abs(s.pos.y - contactY) + 1.5 * overreach + (s.t < CONTACT_WINDOW.min ? 0.5 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          bestSample = s;
        }
      }
      const sweet = (CONTACT_WINDOW.min + maxLead) / 2;
      const half = Math.max(0.08, (maxLead - CONTACT_WINDOW.min) / 2);
      const timing = bestSample.t - sweet;
      const reachDist = cp ? Math.hypot(bestSample.pos.x - cp.x, bestSample.pos.z - cp.z) : 0;
      const unreached = Math.max(0, reachDist - lunge);
      const quality = gradeContact({
        heightError: bestSample.pos.y - contactY,
        reach: reachDist,
        timing,
        height: char.height,
        lunge,
        window: half,
        visualGap: unreached,
      });
      return {
        t: bestSample.t,
        pos: bestSample.pos,
        startFrac: windupStartFraction(clip, speed, bestSample.t),
        quality,
        sense: timingSense(timing, half),
      };
    }

    return {
      t: best.t,
      pos: best.pos,
      startFrac: best.startFrac,
      quality: best.quality,
      sense: best.sense,
    };
  }

  /**
   * Get all candidate clips for a given touch type.
   */
  private getCandidateClips(char: Character, originalClip: string, speed: number): string[] {
    const contactY = char.clipContactPoint(originalClip)?.y ?? char.position.y + char.height * 0.5;
    const isStrike = speed > 1.0;
    const candidates: string[] = [];
    const originalPart = bodyPartOf(originalClip) ?? "foot";

    // Get all candidate clips of the chosen body part that have interaction volumes
    for (const [clip, def] of char.interactionVolumes) {
      if (!CLIPS[clip] || CLIPS[clip].contact < 0) continue;
      if (def.part !== originalPart) continue;
      if (isStrike && def.part === "head" && contactY / char.height < 0.7) continue;
      candidates.push(clip);
    }

    if (!candidates.includes(originalClip)) {
      candidates.unshift(originalClip);
    }

    return candidates;
  }


  /**
   * Start the lunge that carries the clip's contact volume onto the planned
   * ball position, and open the wind-up window (rule events suspend; the
   * release fires from the countdown in update()).
   */
  private beginContactLunge(
    char: Character,
    clip: string,
    plan: { t: number; pos: Vector3 },
    fire: () => void
  ): void {
    const worldVol = char.contactVolumeTransform(clip);
    this.contactSync = { point: (worldVol?.center ?? plan.pos).clone(), timeLeft: plan.t, fire };
    const target = worldVol && this.contactLungeTarget(char, worldVol.center, plan.pos);
    if (target && plan.t >= 0.05) char.lungeTo(target, plan.t);
  }

  /** Target root position that places a clip's interaction volume on `point`. */
  private contactLungeTarget(char: Character, volCenter: Vector3, point: Vector3): Vector3 {
    let dx = point.x - volCenter.x;
    let dz = point.z - volCenter.z;
    const d = Math.hypot(dx, dz);
    // Agility is how far a player can stretch for a ball at the edge of reach.
    const reach = LUNGE_MAX * char.def.agility;
    if (d > reach) {
      dx *= reach / d;
      dz *= reach / d;
    }
    const sideSign = char.faceDir === -1 ? -1 : 1;
    const minX = Math.max(COURT.minX, char.minCourtX ?? COURT.minX);
    const tx = sideSign * Math.min(COURT.maxX, Math.max(minX, sideSign * (char.position.x + dx)));
    const tz = Math.max(-COURT.maxZ, Math.min(COURT.maxZ, char.position.z + dz));
    // The half runs to the middle line now, so a lunge has to be steered
    // around the table rather than stopped short of its end.
    const clear = clearTable(tx, tz);
    return new Vector3(clear.x, char.position.y, clear.z);
  }

  /** The serve toss arc's end point; consumed at the serve's contact frame. */
  private consumeContactPoint(): Vector3 | null {
    const p = this.contactSync?.point ?? null;
    this.contactSync = null;
    return p;
  }

  /**
   * Where each side's next contact is due, refreshed on the prediction cadence.
   *
   * One spot, three jobs: the reach assist bends a run onto it, the reception
   * zone is drawn around it, and the auto-run after a set-up heads for it. They
   * used to be three separate answers — an intercept point, a stored pop
   * target, and whatever the lunge decided at contact time — which is how a
   * player could be assisted toward one place, walked to a second and end up
   * striking at a third.
   */
  /**
   * How far the leash is currently letting each side stray, in metres.
   *
   * Infinity until a set-up pins them; see `leashRadius`, which only ever
   * shrinks it. Reset wherever the leash releases, or the next possession
   * would start pinned to the last one's slack.
   */
  private leashSlack: Record<Side, number> = { player: Infinity, ai: Infinity };
  private anchor: Record<Side, Anchor | null> = { player: null, ai: null };

  private repredictIn = 0;

  /**
   * How far the ball is from this side's chest, which is what every reach in
   * the game is measured against — the touch is played with the body, not with
   * the spot on the floor the character stands on.
   */
  private ballFromChest(side: Side, ball: Vector3 = this.ball.state.pos): number {
    const c = this.chars[side];
    const chest = c.position.add(new Vector3(0, c.height * 0.55, 0));
    return Vector3.Distance(chest, ball);
  }

  /**
   * Remember where the ball was on this tick.
   *
   * Called once per simulation step by the session that owns the clock, which
   * is the only thing that knows the tick the guest's frames are stamped in.
   */
  recordBallAt(tick: number): void {
    this.ballHistory.push({
      tick,
      pos: this.ball.state.pos.clone(),
      vel: this.ball.state.vel.clone(),
    });
    while (this.ballHistory.length > MAX_CATCHUP_TICKS + 2) this.ballHistory.shift();
  }

  /**
   * The ball as this side last saw it — the whole of the lag compensation.
   *
   * A guest's screen is led to the host's present, so it presses at host time
   * V and the host hears about it a trip later. Judging that press against the
   * ball as it is *now* asks a different question from the one the player
   * answered: at rally pace a few ticks of fall is a whole height band, which
   * is how a chest ball became a knee and a ball that was plainly in reach was
   * refused. The second seat used to be given a silent 15% of extra reach to
   * paper over it, which widened the window without aligning it.
   *
   * Only the reach test and the limb choice read this. The contact itself is
   * planned and struck against the live ball, because the ball has to be met
   * where the ball actually is — the rewind decides *whether* and *with what*,
   * never *where*.
   *
   * Everything else — the local player, a local second controller, a peer too
   * old to stamp its frames — gets the live ball, which is what it saw.
   */
  private seenBall(side: Side): Vector3 {
    if (side !== "ai" || !this.versus || this.versusViewTick === null) return this.ball.state.pos;
    const at = this.versusViewTick;
    for (let i = this.ballHistory.length - 1; i >= 0; i--) {
      if (this.ballHistory[i].tick <= at) return this.ballHistory[i].pos;
    }
    return this.ball.state.pos;
  }

  /** The flight this side was looking at, for the decisions a press is judged by. */
  private seenFlight(side: Side, seconds: number): ReturnType<typeof sampleFlight> {
    if (side !== "ai" || !this.versus || this.versusViewTick === null) {
      return sampleFlight(this.ball.state, seconds);
    }
    const at = this.versusViewTick;
    for (let i = this.ballHistory.length - 1; i >= 0; i--) {
      const e = this.ballHistory[i];
      if (e.tick <= at) return sampleFlight({ pos: e.pos, vel: e.vel }, seconds);
    }
    return sampleFlight(this.ball.state, seconds);
  }

  /**
   * A step behind a point on the ball's flight, clamped into the court and
   * pushed clear of the table.
   *
   * The step back is what puts the ball down *in front of* the player rather
   * than on top of them. Both anchors want the same thing from the same two
   * lines, so they ask for it in one place.
   */
  private standingSpot(side: Side, on: Vector3): Vector3 {
    const sgn = sign(side);
    const clear = clearTable(
      sgn * Math.min(COURT.maxX, Math.max(COURT.minX, sgn * on.x + ANCHOR_STEP_BACK)),
      Math.max(-COURT.maxZ, Math.min(COURT.maxZ, on.z))
    );
    return new Vector3(clear.x, GROUND_Y, clear.z);
  }

  /**
   * Where `side` should be standing for the next touch, or null when no touch
   * of theirs is due.
   *
   * Two cases, one answer. A ball on its way over is met where it first hangs
   * at playable height (`computeIntercept`); a ball this player has just set up
   * for themselves is met where it comes back down. Both are read off the
   * ball's own flight rather than from what a touch intended, so a set-up that
   * came off the body badly moves the anchor to where the ball actually is —
   * which is exactly the recovery a poor first touch should demand.
   */
  private computeAnchor(side: Side): Anchor | null {
    if (this.ball.held) return null;
    if (this.strikeableSide === side && this.touchCount > 0) {
      // A set-up popped very high or driven flat has no sample in `dropSpot`'s
      // height window, and it answers null. Keeping the last known anchor
      // rather than dropping it matters twice over: it is what the leash is
      // measured against, so losing it un-pins the player at the exact moment
      // the ball is hardest to stay with, and it is where the auto-run is
      // heading, which otherwise stops dead.
      // The retained anchor's `eta` goes stale with it, which costs nothing:
      // only the incoming-ball assist reads the clock, and this branch is a
      // ball the player set up themselves, where the run is not on a gate.
      return this.dropSpot(side, sampleFlight(this.ball.state, 1.8)) ?? this.anchor[side];
    }
    return this.computeIntercept(side);
  }

  /**
   * The descending, playable part of a flight: where a player can stand and
   * meet this ball at a sensible height, a step behind the drop so the ball
   * comes down in front of them rather than on top of them.
   */
  private dropSpot(side: Side, flight: FlightSample[]): Anchor | null {
    const c = this.chars[side];
    const ideal = c.height * 0.55;
    let prevY = this.ball.state.pos.y;
    let best: { pos: Vector3; t: number; cost: number } | null = null;
    for (const s of flight) {
      if (s.grounded) break;
      const descending = s.pos.y <= prevY + 0.002;
      prevY = s.pos.y;
      const h = s.pos.y - GROUND_Y;
      if (!descending || h < 0.25 || h > 1.3) continue;
      const cost = Math.abs(h - ideal);
      if (!best || cost < best.cost) best = { pos: s.pos, t: s.t, cost };
    }
    if (!best) return null;
    return { pos: this.standingSpot(side, best.pos), eta: best.t };
  }

  /**
   * First point of the ball's future path — after the bounce on `side`'s
   * half — where it hangs at playable height off the table. This is where the
   * reach assist pulls that side's human when they push toward it.
   */
  private computeIntercept(side: Side): Anchor | null {
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
        return { pos: this.standingSpot(side, s.pos), eta: s.t };
      }
    }
    return null;
  }

  /**
   * Bend a run the player is already making onto the spot the ball is coming
   * to, so they arrive in reach rather than a boot's width off it.
   *
   * Three things have to be true before it touches anything: the player is
   * pushing, they are pushing roughly the right way, and the ball has not
   * already won the race. The last of those is `assistStrength`, and it is
   * what keeps this an assist — a shot placed where the player cannot get to
   * it in time is a point, and no amount of bending should change that.
   *
   * It never starts a run and never lengthens one. Standing still, or pushing
   * away, is answered with exactly what was asked for.
   */
  private bendAssist(
    side: Side,
    pos: Vector3,
    anchor: Anchor | null,
    mx: number,
    mz: number,
    speed: number
  ): [number, number] {
    if (!anchor) return [mx, mz];
    const earned = this.assistEarned(side, pos, anchor, speed);
    if (earned <= 0) return [mx, mz];
    const len = Math.hypot(mx, mz);
    if (len <= 0.2) return [mx, mz];
    const dx = anchor.pos.x - pos.x;
    const dz = anchor.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= 0.05 || d >= REACH_ASSIST.radius) return [mx, mz];
    const dot = (mx * dx + mz * dz) / (len * d);
    if (dot <= 0.15) return [mx, mz];
    const k = REACH_ASSIST.strength * dot * earned;
    return [mx * (1 - k) + (dx / d) * len * k, mz * (1 - k) + (dz / d) * len * k];
  }

  /**
   * Keep a player within reach of the ball they are about to play, without
   * taking the controls off them.
   *
   * Inside the zone nothing happens at all: the player owns their feet, and the
   * metre and a half around the contact point is where every decision worth
   * making about a touch is made — which side of the ball to stand, how square
   * to be, how far to let it drop. Leaving it costs progressively more of the
   * push that is doing the leaving, and only well outside it does a slow leash
   * start drawing them back.
   *
   * Deliberately not a wall and deliberately not a lock. A player who means to
   * leave — to cover a drop shot, to reset — still can; what they can no longer
   * do is drift out of a reception they had already started, which is the
   * failure this exists for. Nothing here moves the character directly: it
   * only reshapes the direction they asked for, so the run keeps its weight and
   * the animation keeps its footing.
   */
  private holdNearAnchor(
    side: Side,
    pos: Vector3,
    anchor: Anchor | null,
    mx: number,
    mz: number,
    speed: number
  ): [number, number] {
    if (!anchor) return [mx, mz];
    const toX = anchor.pos.x - pos.x;
    const toZ = anchor.pos.z - pos.z;
    // The two are alternatives, never layered: inside your own set-up the hard
    // cap replaces the soft zone entirely.
    if (this.leashed(side)) {
      return leashPush(toX, toZ, mx, mz, this.leashRadius(side, pos, anchor.pos));
    }
    return nearAnchorPush(toX, toZ, mx, mz, speed, this.assistEarned(side, pos, anchor, speed));
  }

  /**
   * How much help the assist has earned this frame, from 0 to 1.
   *
   * Two things switch it off entirely. Until the ball has bounced on this
   * side's half it is not yet their ball, and drawing a player onto a shot
   * they have not been given is the game reading the rally for them. And once
   * the ball is going to beat them however hard they run, closing the gap is
   * help they have not earned — which is what leaves a fast or well-placed
   * shot able to win the point.
   */
  private assistEarned(side: Side, pos: Vector3, anchor: Anchor, speed: number): number {
    if (this.strikeableSide !== side) return 0;
    const d = Math.hypot(anchor.pos.x - pos.x, anchor.pos.z - pos.z);
    return assistStrength(reachSlack(d, anchor.eta, speed));
  }

  /**
   * Whether this side is pinned to a set-up of their own making.
   *
   * The condition is `computeAnchor`'s self-setup branch verbatim, so the
   * anchor being measured against and the rule holding the player to it cannot
   * come apart.
   *
   * Portrait is exempt. It steers by tapping the court, and a tap the game
   * declines to walk toward reads as a dead control rather than as a boundary
   * — there is no stick pushing against the edge to make the limit felt.
   */
  private leashed(side: Side): boolean {
    if (this.portraitFor(side)) return false;
    return this.strikeableSide === side && this.touchCount > 0;
  }

  /**
   * The radius the leash is currently enforcing — shrinking toward the cap,
   * never growing.
   *
   * A player can end up outside the circle through no fault of their own: the
   * momentum `Character.move` was already easing when the leash engaged,
   * `clearTable` pushing them clear of the table, or the anchor itself moving
   * as `computeAnchor` re-reads the flight. A fixed radius would answer all
   * three by hauling them inward, which is the one thing this must never do —
   * so the circle instead starts wherever they are and closes to the cap as
   * they come in.
   */
  private leashRadius(side: Side, pos: Vector3, anchor: Vector3): number {
    const d = Math.hypot(anchor.x - pos.x, anchor.z - pos.z);
    const slack = Math.max(RECEPTION_ZONE.hardCap, Math.min(this.leashSlack[side], d));
    this.leashSlack[side] = slack;
    return slack;
  }

  /**
   * Whether this side's feet are owned by the run back under their own set-up.
   *
   * This is the only place the game takes the feet, and only ever for a ball
   * this player put up themselves. It cannot be refused and cannot be pushed
   * out of: a ball already in the air is going nowhere else, so there is
   * nothing left for the stick to decide and everything to lose by letting a
   * thumb walk away from it. An oriented reception played wide used to strand
   * the player exactly here — the run switched itself off the moment the ball
   * cleared a lateral band, which is precisely when it was needed.
   *
   * A ball coming *at* the player is never locked. That approach belongs to
   * them: `bendAssist` and `holdNearAnchor` shape the run they are making, and
   * a shot placed where they cannot reach it in time is still a point.
   *
   * The run releases at the drop so the stick can choose which side of the
   * ball to take it on, and picks back up if the anchor moves further than the
   * arrival covers — the recovery a set-up that came off the body badly should
   * demand.
   */
  private runLocked(side: Side): boolean {
    if (this.state !== "rally" || this.ball.held) return false;
    if (!(this.strikeableSide === side && this.touchCount > 0 && this.autoSetupRun[side])) {
      this.autoRunArrived[side] = false;
      return false;
    }
    const anchor = this.anchor[side];
    if (anchor === null) return false;
    const c = this.chars[side];
    const d = Math.hypot(anchor.pos.x - c.position.x, anchor.pos.z - c.position.z);
    // Hysteresis, so a player standing on the drop is not flicked between the
    // run and the stick frame by frame as the anchor breathes.
    if (d <= AUTO_RUN.arrive) this.autoRunArrived[side] = true;
    else if (d > AUTO_RUN.reengage) this.autoRunArrived[side] = false;
    return !this.autoRunArrived[side];
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
    // Online guest: the touch belongs to the host's match, so the tap leaves
    // as intent on the next input frame instead of into the local buffered
    // press — which a follower runs no rules to spend. The carry vector is the
    // whole of it; `resolveFollowerInput` puts it on the wire.
    if (this.netFollower) {
      this.followerTap = {
        aimX: aim.x,
        aimZ: aim.z,
        pop: this.touchCount > 0 || !this.autoFirstReception,
      };
      return;
    }
    const pending = this.pendingTouch;
    if (pending && pending.side === "player" && pending.kind === "pop") {
      // Already committed and waiting for the ball to drop: re-aim it where
      // the player is now pointing rather than queue a second one behind it.
      pending.aimX = aim.x;
      pending.aimZ = aim.z;
    }
    if (this.touchCount === 0 && this.autoFirstReception) {
      this.receptionAim.player = aim;
      return;
    }
    if (pending && pending.side === "player" && pending.kind === "pop") {
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
  private touchImminent(side: Side = "player"): boolean {
    if (this.state !== "rally" || this.ball.held) return false;
    if (this.strikeableSide !== side) return false;
    return this.ballFromChest(side) <= AUTO_RECEPTION_REACH * 1.6;
  }

  /**
   * The last stretch of an approach, where the stick stops being a run and
   * becomes the shape of the touch.
   *
   * On an incoming ball one stick does two jobs: it steers the approach, and
   * held at the moment of contact it aims the set-up (`autoReceive`). Those
   * only ever conflict at the very end — a player holding a direction as the
   * ball lands on them is crafting a touch, not asking to walk away from one —
   * so here the feet go to the assist and the push is read as aim alone.
   *
   * Deliberately only the last stretch. Everything before it belongs to the
   * player: a ball can still be left, and a ball that beats them to the spot
   * is still a point.
   */
  private receptionSettling(side: Side): boolean {
    return this.touchCount === 0 && this.anchor[side] !== null && this.touchImminent(side);
  }

  /**
   * Where a tap asked each side's automatic first touch to put the ball, as a
   * carry vector.
   *
   * Per seat because online the second seat is a phone too, and one held
   * upright places its reception by tapping exactly as this one does. Its taps
   * arrive on the input frame rather than through `tapAt`.
   */
  private receptionAim: Record<Side, { x: number; z: number } | null> = {
    player: null,
    ai: null,
  };

  private movePlayer(input: InputState, dt: number): void {
    const player = this.chars.player;
    const anchor = this.anchor.player;
    if (this.moveTarget) {
      // A tapped destination is still a destination, but a tap that would walk
      // the player out of a reception they are already in is answered as far as
      // the zone allows and no further — the same rule the stick gets, so the
      // two schemes cannot disagree about where a player may stand.
      const dx = this.moveTarget.x - player.position.x;
      const dz = this.moveTarget.z - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.05) {
        this.moveTarget = null;
        player.move(0, 0, 0, dt);
        return;
      }
      const [mx, mz] = this.holdNearAnchor(
        "player",
        player.position,
        anchor,
        dx / d,
        dz / d,
        player.def.speed
      );
      // Ease into the last stride rather than arriving at full pace.
      player.move(mx, mz, Math.min(player.def.speed, d / Math.max(dt, 1e-3)), dt);
      return;
    }
    if (this.tapSteering) {
      // Nothing asked for: ease to a stop, but still drift back toward a ball
      // that is dropping somewhere else — in portrait the player has no stick
      // to hold, so standing still must not mean standing out of the play.
      const [mx, mz] = this.holdNearAnchor("player", player.position, anchor, 0, 0, player.def.speed);
      player.move(mx, mz, player.def.speed, dt);
      return;
    }
    // Full pace. Getting to a ball placed away from you is the effort the
    // assist is there to reward, not to stand in for, and it cannot be made
    // at a walk.
    const speed = player.def.speed;
    const [bx, bz] = this.bendAssist("player", player.position, anchor, input.moveX, input.moveZ, speed);
    const [mx, mz] = this.holdNearAnchor("player", player.position, anchor, bx, bz, speed);
    player.move(mx, mz, speed, dt);
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

  /**
   * Freeze only the simulation; the app can keep rendering the teachable moment.
   *
   * The characters are told separately because their clips do not run on our
   * clock — Babylon plays animation groups off the scene's render loop. Without
   * this the world stopped but the legs did not, and a player frozen mid-stride
   * jogged on the spot through the whole of the coach's explanation.
   */
  setTutorialFrozen(frozen: boolean): void {
    this.tutorialFrozen = frozen;
    this.chars.player.setAnimationsFrozen(frozen);
    this.chars.ai.setAnimationsFrozen(frozen);
  }

  get isTutorialFrozen(): boolean {
    return this.tutorialFrozen;
  }

  /**
   * Guest-side frame: no rules, only presentation.
   *
   * Everything on screen is read off one playback timeline — a clock running
   * a fixed interval behind the newest authoritative frame — so the ball,
   * both players, the action clips and the contact sounds all describe the
   * same instant. Between reported frames the ball rides the shared pure
   * physics and the players are interpolated, which is what turns a 30 Hz
   * feed into smooth 60 Hz motion. The one exception is this peer's own
   * character during a rally, which is predicted from the stick so controls
   * stay instant; it rides the timeline whenever the host owns its feet.
   */
  private updateAsFollower(dt: number, input: InputState): void {
    this.matchClock += dt;
    if (this.playback.consumeReengaged()) {
      // The feed came back after starving: the timeline restarted wherever
      // the host is now. Glide onto it instead of snapping the screen.
      this.followerBlend.player = FOLLOWER_BLEND_SECONDS;
      this.followerBlend.ai = FOLLOWER_BLEND_SECONDS;
    }
    const view = this.playback.advance(this.followerColliders());
    if (view) {
      // The instant this screen is showing, in the host's ticks. It rides out
      // on every input frame so a press is judged against the ball the player
      // was actually looking at when they made it.
      this.followerRenderTick = view.renderTick;
      this.ball.held = view.ballHeld;
      this.ball.state.pos.set(view.ball.x, view.ball.y, view.ball.z);
      this.ball.state.vel.set(view.ballVel.x, view.ballVel.y, view.ballVel.z);
      this.ball.update(0); // mesh follows; no physics with dt 0
      this.fireDueFx(view.renderTick);
      this.updateFollowerClips(
        view.renderTick,
        view.selfClip,
        view.opponentClip,
        view.mode === "buffered"
      );
    }
    // The landing X is help the joined player needs as much as the host's;
    // it reads the same delayed ball state the ball itself is shown in, so
    // the marker and the flight always agree.
    this.followerMarkerIn -= dt;
    if (this.followerMarkerIn <= 0) {
      this.followerMarkerIn = 0.15;
      this.landingSpot =
        this.followerPhase === "rally" && !this.ball.held ? this.computeLandingSpot() : null;
      this.updateFollowerLandingMarker();
    }
    this.updateServeMarker();
    // The time left to reach the anchor runs down between frames like any
    // other clock; only the spot is authoritative.
    if (this.followerSelfAnchor) {
      this.followerSelfAnchor.eta = Math.max(0, this.followerSelfAnchor.eta - dt);
    }
    let selfPredicted = false;
    for (const side of ["player", "ai"] as Side[]) {
      const c = this.chars[side];

      // Prediction, for this peer's own character only. Waiting for the host
      // to answer put a full round trip between pressing a direction and the
      // player leaning that way, which is the one delay a player feels
      // directly. Moving locally and correcting afterwards removes it.
      //
      // Only during a rally: between points the host walks players to serve
      // and receive spots, and predicting from a stick that is not driving
      // that would fight it the whole way. And only while the host is
      // listening to the stick at all: while the run to the drop spot owns
      // the feet there (`selfLocked`), predicting from it is predicting from
      // nothing, and the two would race every reception.
      const predicting =
        side === "player" &&
        !c.busy &&
        this.followerPhase === "rally" &&
        !this.followerSelfLocked;
      if (predicting) {
        selfPredicted = true;
        this.predictSelf(c, input, dt);
        if (this.followerSelfPose) {
          const fixed = reconcile(
            { x: c.position.x, z: c.position.z },
            this.followerSelfPose,
            dt
          );
          c.position.x = fixed.x;
          c.position.z = fixed.z;
        }
        c.update(dt);
        continue;
      }
      if (side === "player" && this.selfPredicting) {
        // Prediction just let go of the feet — busy, locked, or the point
        // ended — and the timeline takes over from wherever the prediction
        // left the character. Glide rather than snap across the join.
        this.followerBlend.player = FOLLOWER_BLEND_SECONDS;
      }

      if (view) {
        const tv = side === "player" ? view.self : view.opponent;
        const gap = Math.hypot(tv.x - c.position.x, tv.z - c.position.z);
        if (gap > FOLLOWER_SNAP || c.busy) {
          // Take it outright. Either it is too far to be a correction — a cold
          // start or a reset — or the character is mid-touch, and a character
          // mid-touch belongs entirely to the host.
          //
          // Easing is there to hide a *prediction* error, and during a clip
          // nothing is being predicted. Easing anyway is what stopped the limb
          // ever arriving: the contact lunge darts half a metre onto the ball
          // in a fifth of a second, and a quarter-second correction chasing it
          // is always behind — so the guest watched a reception animation play
          // out with the ball beyond the foot, and then the ball bend toward a
          // contact it never saw happen.
          c.position.x = tv.x;
          c.position.z = tv.z;
          this.followerBlend[side] = 0;
        } else if (this.followerBlend[side] > 0 || gap > 0.05) {
          this.followerBlend[side] = Math.max(0, this.followerBlend[side] - dt);
          const fixed = reconcile({ x: c.position.x, z: c.position.z }, { x: tv.x, z: tv.z }, dt);
          c.position.x = fixed.x;
          c.position.z = fixed.z;
        } else {
          // The timeline is already smooth at 60 Hz: take it exactly. Easing
          // toward it would only add a second, slower motion on top.
          c.position.x = tv.x;
          c.position.z = tv.z;
        }
        // Velocity comes from the timeline's own positions, so the locomotion
        // blend describes the motion actually on screen.
        c.velocity.set(tv.vx, 0, tv.vz);
      }
      c.update(dt);
    }
    this.selfPredicting = selfPredicted;
  }

  /**
   * Move this peer's own character the way the host is about to move it.
   *
   * Prediction only works if both ends integrate the same equation. The host
   * does not walk this seat on a bare stick: it bends the push onto the
   * contact point and leashes it to the reception zone (`updateVersusRally`),
   * and it roots the player entirely while a kick is being lined up. A
   * prediction that skipped all three did not drift by a little noise that
   * `reconcile` could absorb — it regenerated the whole of the assist every
   * step, so the correction chased a gap it could never close, and the joined
   * player was permanently somewhere other than where the host had them.
   *
   * The anchor comes off the snapshot; without one (an older host, or no touch
   * due) the assist is a no-op and this is the bare stick it used to be.
   */
  private predictSelf(c: Character, input: InputState, dt: number): void {
    // Charging a kick roots the striker over there. Walking through it here
    // would fight the freeze for as long as the charge is held.
    const lining = input.strikeHeld || (input.strikeTapsSoFar ?? 0) > 0;
    if (!this.tapSteering && lining && this.strikeableSide === "player") {
      c.velocity.setAll(0);
      return;
    }
    // Portrait has no stick. What the host receives is the direction that
    // walks to the tapped spot — `resolveFollowerInput` builds it — so that is
    // what has to be predicted from, not the axes, which in portrait carry
    // only a swipe's leftover aim.
    let mx = input.moveX;
    let mz = input.moveZ;
    if (this.tapSteering) {
      mx = 0;
      mz = 0;
      const t = this.moveTarget;
      if (t) {
        const dx = t.x - c.position.x;
        const dz = t.z - c.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.12) {
          mx = dx / d;
          mz = dz / d;
        }
      }
    }
    const anchor = this.followerSelfAnchor;
    const speed = c.def.speed;
    const [bx, bz] = this.bendAssist("player", c.position, anchor, mx, mz, speed);
    const [hx, hz] = this.holdNearAnchor("player", c.position, anchor, bx, bz, speed);
    c.move(hx, hz, speed, dt);
  }

  /**
   * Hang the arrow over whoever is about to serve, and nowhere else.
   *
   * Read off `serveOwner` and the phase, both of which a guest already has
   * from the snapshot in its own frame — so this needs nothing on the wire and
   * says the same thing on both phones.
   */
  private updateServeMarker(): void {
    const m = this.serveMarker;
    if (!m) return;
    const phase = this.netFollower ? this.followerPhase : this.state;
    const serving = phase === "serve_move" || phase === "serve_ready" || phase === "serve_anim";
    m.setEnabled(serving);
    if (!serving) return;
    const c = this.chars[this.serveOwner];
    // A little clear of the head, and turning, because a still marker over a
    // still player reads as scenery.
    m.position.set(c.position.x, c.position.y + c.height + 0.42, c.position.z);
    m.rotation.y = (performance.now() / 900) % (Math.PI * 2);
  }

  /**
   * The two bodies the guest's ball can bounce off, as the host sees them.
   *
   * The host deflects a ball that meets a character standing in its way, and
   * the guest's extrapolation ran without them — so a ball the host bounced
   * off a shoulder carried straight on here, through the player, and was
   * dragged back when the truth arrived.
   *
   * Read off the drawn positions, because those are where the bodies are on
   * this screen. A character mid-clip is exempt, exactly as on the host, whose
   * sanctioned contact is the limb strike rather than the body; the mirrored
   * clip is how a guest knows which one that is.
   */
  private followerColliders(): BodyCollider[] {
    const out: BodyCollider[] = [];
    for (const side of ["player", "ai"] as Side[]) {
      const c = this.chars[side];
      if (c.busy) continue;
      out.push({ side, base: c.position, height: c.height, radius: c.height * BODY_RADIUS });
    }
    return out;
  }

  /**
   * Fire every contact whose tick the playback clock has reached. A kick is
   * the one with a sound; the other kinds carry their moment for the day they
   * get one.
   */
  private fireDueFx(renderTick: number): void {
    if (this.guestFx.length === 0) return;
    const remaining: typeof this.guestFx = [];
    for (const fx of this.guestFx) {
      if (fx.tick <= renderTick) {
        if (fx.kind === "kick") this.audio.playKick();
      } else {
        remaining.push(fx);
      }
    }
    this.guestFx = remaining;
  }

  /**
   * Play each side's action clip at the fraction its window gives the
   * playback clock. Starting a clip here rather than on snapshot arrival is
   * the whole of the animation sync: the guest's kick winds up and strikes at
   * the same instant as the ball's launch, wherever in the clip the frame
   * happened to arrive.
   */
  private updateFollowerClips(
    renderTick: number,
    selfClip?: ClipSample | null,
    opponentClip?: ClipSample | null,
    /** The timeline is running on real frames, not carrying or frozen. */
    live = true
  ): void {
    const clips = { player: selfClip, ai: opponentClip };
    for (const side of ["player", "ai"] as Side[]) {
      const w = clips[side] !== undefined ? clips[side] : this.followerClipWin[side];
      const c = this.chars[side];
      if (!w || !w.clip) {
        // The host says this character is doing nothing, so it must be doing
        // nothing — whether or not this screen believes it started the clip.
        if (this.followerClipKey[side] || c.currentActionClip) {
          c.cancelActionToLoco();
          this.followerClipKey[side] = null;
        }
        continue;
      }
      const from = w.from ?? Number.NEGATIVE_INFINITY;
      const to = w.to ?? Number.POSITIVE_INFINITY;
      // Identity is the instance number when the host sends one. Keying on the
      // window's start stopped working the moment the host began restating the
      // window from the clip's real progress, because then the start moves
      // every frame and every frame looks like a new clip.
      const key = `${w.clip}@${w.seq ?? from}`;
      if (this.followerClipKey[side] === key) {
        if (renderTick >= to) {
          // Over. Cancel what is playing, and keep the key: clearing it sent
          // the next step back round to the "not played yet" branch, which
          // skipped the clip, set the key again, and came straight back here —
          // a cancel every other step, each one slamming the locomotion blend
          // back to full weight. That is a character standing frozen and
          // shivering rather than walking.
          if (c.currentActionClip) c.cancelActionToLoco();
          continue;
        }
        // Hold the clip to the playback clock rather than starting it once and
        // letting it run. A guest's animation is presentation: it belongs to
        // the host's clock, and this device's render loop is a different one,
        // drifting from the fixed step whenever frames are being dropped.
        //
        // Only while that clock is actually moving. A starving feed freezes
        // the render point, and a clip pinned to a frozen clock is a player
        // standing stock still in the middle of a kick until the frames come
        // back — which is the pose a joined player kept arriving at the
        // service line still wearing.
        //
        // And only when it has drifted enough to be worth a correction.
        // Seeking every step would hand every wobble in the host's own frame
        // rate straight to this screen; letting a small difference ride is
        // what keeps the swing smooth between corrections.
        if (!live) continue;
        const frac = clipFractionAt(from, to, renderTick);
        if (c.currentActionClip !== w.clip) {
          // It ran itself off the end before the clock reached it. Put it back
          // where it belongs rather than leaving the player standing.
          c.playAction(w.clip, { startFrac: frac, speed: clipWindowSpeed(w.clip, from, to) });
          continue;
        }
        const at = c.actionFraction;
        if (at === null || Math.abs(at - frac) > CLIP_RESYNC_FRACTION) c.seekAction(frac);
        continue;
      }
      // A clip instance this screen has not played yet. Where in it the host
      // is, clamped into the clip: a render point short of the window means
      // the clip has only just started over there, and the head is where to
      // begin. There used to be no branch for that at all — the clip was
      // neither played nor remembered, so it sat waiting for the clock to
      // drift into range and then appeared, out of its moment, usually at the
      // next serve.
      const frac = clipFractionAt(from, to, renderTick);
      if (frac >= 1) {
        // Genuinely finished before this screen ever reached it: a late join,
        // or a stall long enough to have missed the whole thing. Remembered so
        // it is never replayed out of time.
        this.followerClipKey[side] = key;
        continue;
      }
      c.playAction(w.clip, { startFrac: frac, speed: clipWindowSpeed(w.clip, from, to) });
      this.followerClipKey[side] = key;
    }
  }

  /**
   * The landing marker as the follower sees it. Shown wherever the delayed
   * ball is heading; the phase gate sits with the caller, which owns the
   * rhythm the marker refreshes on.
   */
  private updateFollowerLandingMarker(): void {
    const m = this.landingMarker;
    if (!m) return;
    const spot = this.landingSpot;
    const show = spot !== null;
    m.setEnabled(show);
    if (show && spot) {
      const onTable = Math.abs(spot.pos.x) <= TABLE.halfLen && Math.abs(spot.pos.z) <= TABLE.halfWid;
      const y = onTable ? tableSurfaceY(spot.pos.x) : GROUND_Y;
      m.position.set(spot.pos.x, y + 0.025, spot.pos.z);
    }
  }

  /**
   * The controls a guest actually sends, given what its taps asked for.
   *
   * The wire carries a stick, and portrait has no stick: its taps become a
   * local move target that the host can never see. So the target is turned
   * back into the stick direction that walks there, here, each step before the
   * frame is sent — and the leftover swipe aim is scrubbed from the axes,
   * because on the host those axes are *movement*, and aim leaking into them
   * marched the guest diagonally after every kick.
   */
  resolveFollowerInput(input: InputState): InputState {
    if (!this.netFollower || !this.tapSteering) return input;
    // On the frame of a press the axes are that press's aim, and the host
    // reads them as exactly that. Scrubbing would un-aim every swipe.
    if (input.strikePressed || input.popPressed) return input;
    // A tap the host has to answer: either a set-up being asked for, which
    // travels as a pop with the carry on the axes — exactly the shape
    // `updateVersusRally` builds one from — or the shape of a first touch that
    // is about to be taken automatically, which is the carry alone.
    const tap = this.followerTap;
    if (tap) {
      this.followerTap = null;
      return {
        ...input,
        popPressed: tap.pop,
        moveX: tap.aimX,
        moveZ: tap.aimZ,
        tapAim: true,
      };
    }
    const target = this.moveTarget;
    const c = this.chars.player;
    if (target) {
      const dx = target.x - c.position.x;
      const dz = target.z - c.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.12) return { ...input, moveX: dx / d, moveZ: dz / d };
      this.moveTarget = null;
    }
    return { ...input, moveX: 0, moveZ: 0 };
  }

  /**
   * The guest's single playback timeline. Every arriving frame joins it, and
   * everything on screen — the ball and both characters — is read off one
   * clock, because a chase-eased character beside a snapped ball was two
   * objects from two different moments.
   *
   * That clock is led forward to the instant the host is playing rather than
   * held behind it. Behind, the screen was beautifully consistent and the
   * joined player could not time a touch: their own character was drawn live
   * and the ball was not, so every press after the automatic first touch
   * reached the host after the moment it was aimed at.
   */
  private playback = new PlaybackBuffer();
  /**
   * A tap this guest made that the host has yet to hear about.
   *
   * One at a time, cleared as it is sent: a tap is a moment, and two of them
   * queued behind each other would play the older one against a ball that has
   * moved on.
   */
  private followerTap: { aimX: number; aimZ: number; pop: boolean } | null = null;
  /**
   * Latest reported clip window per side, in host ticks. A clip with no
   * reported window keeps the infinite one: started on first sight at its
   * head, which is all an older host could ever offer.
   */
  private followerClipWin: Record<Side, ClipSample | null> = {
    player: null,
    ai: null,
  };
  /** Clip instance ("name@from") playing or already passed, per side. */
  private followerClipKey: Record<Side, string | null> = { player: null, ai: null };
  /** Seconds of gliding onto the timeline left, per side. */
  private followerBlend: Record<Side, number> = { player: 0, ai: 0 };
  /** This peer's own character was predicted last step. */
  private selfPredicting = false;
  /** Latest lead-carried self pose; the reconcile target while predicting. */
  private followerSelfPose: { x: number; z: number } | null = null;
  /** Host's match phase; prediction only runs during a rally. */
  private followerPhase = "";
  /**
   * The host currently owns this peer's feet (the run to the drop spot is
   * engaged there), so local prediction from the stick is suspended and the
   * character follows the timeline instead.
   */
  private followerSelfLocked = false;
  private followerMarkerIn = 0;
  /**
   * Frames still arriving from the match that just ended.
   *
   * A rematch restarts this peer the moment it is agreed, for responsiveness,
   * but the host is a trip behind: whichever peer resets first spends that trip
   * receiving snapshots that still say "over". Applying them puts the old score
   * back on the board and blows the final whistle a second time, which is the
   * result screen reappearing over a rally that has already started.
   *
   * Cleared by the first frame that is not "over", which is the host saying it
   * has restarted too. Bounded, so a host that never does cannot mute its guest
   * for good.
   */
  private followerAwaitingRestart = 0;
  /**
   * Seconds left on the serve clock, or null when it is not running.
   *
   * Published on the snapshot, because the countdown belongs to both screens:
   * the server has to know they are being hurried, and the receiver has to be
   * able to see that the point coming their way was earned by the clock rather
   * than conjured.
   */
  serveClockLeft: number | null = null;
  /** Guest: the countdown as the host reports it. */
  private followerServeClock: number | null = null;
  /** Last whole second shown, so the hint is written once per number. */
  private serveClockShown: number | null = null;

  /**
   * Show the last few seconds of the serve clock, and nothing before them.
   *
   * Counted down rather than displayed throughout: a clock on screen for the
   * whole eight seconds is a clock the player is reading instead of playing,
   * and the point of this one is only to stop a match stalling.
   */
  private showServeClock(left: number): void {
    const whole = Math.ceil(left);
    if (whole > SERVE_CLOCK_COUNTDOWN) {
      if (this.serveClockShown !== null) {
        this.serveClockShown = null;
        this.ui.hint(null);
      }
      return;
    }
    if (this.serveClockShown === whole) return;
    this.serveClockShown = whole;
    this.ui.hint(String(whole));
  }
  /** Host tick this screen is showing, or null before the first frame. */
  private followerRenderTick: number | null = null;
  /**
   * Where the host says this peer's own next touch is due.
   *
   * The prediction runs the same reach assist and leash the host runs, and
   * both aim here. Without it the guest walked on a bare stick while the host
   * walked on an assisted one, and the gap between the two was regenerated
   * every step for `reconcile` to chase and never catch.
   */
  private followerSelfAnchor: Anchor | null = null;

  /** Guest: the host instant on screen, for stamping outgoing controls. */
  get renderTick(): number | null {
    return this.followerRenderTick;
  }

  /**
   * Apply an authoritative frame from the host. Everything here is already in
   * this peer's own coordinates — the wire layer reflects and swaps seats
   * before it arrives.
   *
   * The frame does not go straight to the screen: it joins the playback
   * timeline, and the screen reads that timeline a fixed interval behind the
   * newest frame. Ball, players, clips and sounds all come off the same
   * clock, which is the whole of what makes a guest's screen agree with
   * itself — an earlier design showed the ball half a round trip in the past
   * under a player drawn now, and no amount of easing made two moments look
   * like one.
   *
   * `lead` is how old the frame already is in simulation ticks. Only the
   * predicted self pose is carried forward by it: that one object is shown
   * live, so its reconcile target must be live too.
   */
  /**
   * How far ahead of the newest frame the guest's screen is read, in ticks.
   *
   * Set by the session from the measured round trip, every step, because the
   * route can change under a phone that is walking between cells.
   */
  setPlaybackLead(ticks: number): void {
    this.playback.setLead(ticks);
  }

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
    /** Host ticks bracketing each clip: fraction 0 and fraction 1. */
    selfClipFrom?: number;
    selfClipTo?: number;
    opponentClipFrom?: number;
    opponentClipTo?: number;
    /** Which playing of each clip this is. */
    selfClipSeq?: number;
    opponentClipSeq?: number;
    /** The host owns this peer's feet (the run to the drop spot is engaged). */
    selfLocked?: boolean;
    /** Where this peer's next touch is due, in its own frame. */
    selfAnchor?: { x: number; y: number; z: number } | null;
    /** Seconds until the ball reaches that spot. */
    selfAnchorEta?: number;
    /** Possession, already in this peer's seat names. */
    strikeable?: "host" | "guest" | null;
    /** Touches spent in the possession. */
    touches?: number;
    /** Seconds left on the serve clock, or absent when it is not running. */
    serveClock?: number;
    /** Points won by each seat across the match, in this peer's frame. */
    tally?: [number, number];
    /** Long rallies the match has produced; not a per-seat number. */
    rallies?: number;
    /** The host tick the frame was sampled at; keys the playback timeline. */
    tick: number;
    score: [number, number];
    sets: [number, number];
    serveOwner: Side;
    phase: string;
  }, lead = 0): void {
    // The follower runs no rules, so it would never notice the match ending on
    // its own: the host's engine decides it and keeps it to itself. Reading
    // the phase change here is what gives the joined player the same final
    // whistle — winner, celebration, result screen — instead of a court that
    // simply stops making sense.
    if (this.followerAwaitingRestart > 0) {
      if (snap.phase === "over") {
        this.followerAwaitingRestart--;
        return;
      }
      this.followerAwaitingRestart = 0;
    }
    const prevPhase = this.followerPhase;
    const finishedNow = snap.phase === "over" && prevPhase !== "over" && this.state !== "over";
    this.followerPhase = snap.phase;
    this.followerSelfLocked = snap.selfLocked === true;
    // The spot the host's assist is pulling this character toward, so the
    // prediction can pull toward the same one. `eta` is not on the wire and
    // nothing on this path reads it.
    this.followerSelfAnchor = snap.selfAnchor
      ? {
          pos: new Vector3(snap.selfAnchor.x, snap.selfAnchor.y, snap.selfAnchor.z),
          // The eta was measured when the frame was sampled, so it is already
          // that much shorter by the time it is read here. The spot itself
          // does not move with the clock; the time left to get there does.
          eta: Math.max(0, (snap.selfAnchorEta ?? 0) - lead * SIM_DT),
        }
      : null;
    // The three rules facts a tap needs an answer from, taken from the host
    // rather than worked out here. Without them `touchImminent` can only ever
    // say no on a follower, and a portrait guest's tap becomes a walk every
    // time — which is why the joined player could take the first touch and
    // then nothing at all. Nothing else on the follower path reads `state`:
    // the rules switch it gates is upstream of `updateAsFollower`.
    if (isMatchState(snap.phase)) this.state = snap.phase;
    if (snap.strikeable !== undefined) {
      this.strikeableSide =
        snap.strikeable === null ? null : snap.strikeable === "host" ? "player" : "ai";
    }
    if (snap.touches !== undefined) this.touchCount = snap.touches;
    // What the match has been worth so far. A follower counts none of this
    // itself, and reports it to the server at the final whistle — a win with
    // no points behind it is a result the server refuses as impossible.
    if (snap.tally) {
      this.tally.points.player = snap.tally[0];
      this.tally.points.ai = snap.tally[1];
    }
    if (snap.rallies !== undefined) this.tally.longRallies = snap.rallies;
    // The countdown is the host's, shown here on the host's numbers.
    this.followerServeClock = snap.serveClock ?? null;
    if (this.followerServeClock === null) {
      if (this.serveClockShown !== null) {
        this.serveClockShown = null;
        this.ui.hint(null);
      }
    } else {
      this.showServeClock(this.followerServeClock);
    }
    if (finishedNow) {
      this.state = "over";
      // Sets arrive already in this peer's frame ([me, them]), so the winner
      // is read straight off them.
      this.matchWinner = snap.sets[0] >= SETS_TO_WIN ? "player" : "ai";
      this.ui.onMatchEnd(this.matchWinner);
    }
    // The crowd's cheer arrives with the phase change, the same beat as the
    // host's — not with a frame that happens to carry it.
    if (
      (snap.phase === "point" || snap.phase === "over") &&
      prevPhase !== "point" &&
      prevPhase !== "over" &&
      prevPhase !== ""
    ) {
      this.audio.playApplause();
    }

    // Clip windows. A clip reported without one keeps the infinite window:
    // played from its head on first sight, which degrades to the old
    // behaviour rather than to nothing.
    const win = (clip: string | null, from?: number, to?: number, seq?: number) =>
      clip
        ? {
            clip,
            from: from ?? Number.NEGATIVE_INFINITY,
            to: to ?? Number.POSITIVE_INFINITY,
            seq,
          }
        : null;
    const selfClip = win(snap.selfClip, snap.selfClipFrom, snap.selfClipTo, snap.selfClipSeq);
    const opponentClip = win(
      snap.opponentClip,
      snap.opponentClipFrom,
      snap.opponentClipTo,
      snap.opponentClipSeq
    );
    this.followerClipWin.player = selfClip;
    this.followerClipWin.ai = opponentClip;

    // The whole frame joins the playback timeline, keyed by the host's tick.
    this.playback.push({
      tick: snap.tick,
      ball: { x: snap.ballPos.x, y: snap.ballPos.y, z: snap.ballPos.z },
      ballVel: { x: snap.ballVel.x, y: snap.ballVel.y, z: snap.ballVel.z },
      ballHeld: snap.ballHeld,
      self: { x: snap.selfPos.x, z: snap.selfPos.z },
      opponent: { x: snap.opponentPos.x, z: snap.opponentPos.z },
      selfVel: { x: snap.selfVel.x, z: snap.selfVel.z },
      opponentVel: { x: snap.opponentVel.x, z: snap.opponentVel.z },
      selfClip,
      opponentClip,
    });

    // The one object shown live: its reconcile target is carried forward by
    // the frame's age, so prediction corrects against where the host is now,
    // not where it was when the frame was sampled.
    const seconds = lead * SIM_DT;
    this.followerSelfPose = {
      x: snap.selfPos.x + snap.selfVel.x * seconds,
      z: snap.selfPos.z + snap.selfVel.z * seconds,
    };

    // An fx event older than the playback point can never be due again — a
    // reconnect lands ticks far ahead, and without this the guest would play
    // an entire rally's sounds in one burst on return.
    if (this.guestFx.length > 0) {
      const floor = snap.tick - MAX_CATCHUP_TICKS;
      this.guestFx = this.guestFx.filter((fx) => fx.tick >= floor);
    }

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
    // Every launch is a kick the guest should hear beside the contact, on the
    // playback clock rather than on arrival.
    this.pushFx("kick", this.ball.state.pos);
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

  /**
   * Take everything the match produced for the wire this step, stamped in the
   * session's tick — the same clock the snapshots carry, which is what lets
   * the guest line clips and sounds up with the positions they belong to.
   * Called by the session once per host step.
   */
  drainNet(tick: number): { kind: FxKind; pos?: { x: number; y: number; z: number } }[] {
    for (const cs of this.clipStarts) {
      const from = tick - cs.startFrac * cs.durTicks;
      this.clipWindow[cs.side] = {
        clip: cs.clip,
        from,
        to: from + cs.durTicks,
        dur: cs.durTicks,
        seq: ++this.clipSeq,
      };
    }
    this.clipStarts.length = 0;
    // Restate every live window from where its clip actually is.
    //
    // The window is stamped in simulation ticks and the clip is played by the
    // renderer, and those are two different clocks: the fixed step caps its
    // delta at `MAX_FRAME_DT` and drops the remainder, while an animation
    // group advances on the frame's real delta. A device dropping frames runs
    // its animations ahead of its own simulation, so a window predicted once
    // at the clip's start stops containing the clip within a touch or two.
    //
    // The guest reads that window to decide what to play and from where. Left
    // to drift it hands over a window the render point has already passed, or
    // has not reached — which is a touch that plays no animation, and an
    // animation that appears out of nowhere at the next serve. Restating it
    // costs one read of the animatable and cannot drift, because it is never
    // more than one step old.
    for (const side of ["player", "ai"] as Side[]) {
      const w = this.clipWindow[side];
      if (!w) continue;
      const c = this.chars[side];
      if (c.currentActionClip !== w.clip) {
        this.clipWindow[side] = null;
        continue;
      }
      const frac = c.actionFraction;
      if (frac === null) continue;
      const from = tick - frac * w.dur;
      this.clipWindow[side] = { ...w, from, to: from + w.dur };
    }
    const out = this.fxQueue;
    this.fxQueue = [];
    return out;
  }

  private pushFx(kind: FxKind, pos?: Vector3): void {
    if (!this.netPublish) return;
    // A cap rather than a queue without end: a burst of contacts is still one
    // rally's worth of sounds, and anything beyond that is a stuck ball.
    if (this.fxQueue.length >= 32) return;
    this.fxQueue.push({ kind, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined });
  }

  /**
   * Guest: an fx event arrived. Held until the playback clock crosses its
   * tick, so the sound sits beside the bounce or kick that caused it.
   */
  queueFx(entry: { tick: number; kind: FxKind }): void {
    if (this.guestFx.length >= 32) return;
    this.guestFx.push(entry);
  }

  /**
   * Start a seat's action clip and, when publishing, record the tick window
   * the guest needs to play it at the right fraction of the right instant.
   */
  private playSideAction(
    side: Side,
    clip: string,
    opts: {
      startFrac?: number;
      speed?: number;
      callbacks?: { frac: number; fn: () => void }[];
      onEnd?: () => void;
      loop?: boolean;
    } = {}
  ): boolean {
    const played = this.chars[side].playAction(clip, opts);
    if (played && this.netPublish) {
      const frames = CLIPS[clip]?.frames;
      if (frames) {
        const durTicks = frames / (opts.speed ?? 1);
        // The same floor playAction applies, so the window describes the clip
        // as actually started; a loop has no fraction to begin at.
        const startFrac = opts.loop ? 0 : Math.max(opts.startFrac ?? 0, clipStartFraction(clip));
        this.clipStarts.push({ side, clip, startFrac, durTicks });
      }
    }
    return played;
  }

  private stopSideAction(side: Side): void {
    // Back onto the feet, not merely stopped: `playAction` zeroed the
    // locomotion weights on the way in, and stopping without restoring them
    // leaves the character frozen on the frame it was cut at.
    this.chars[side].cancelActionToLoco();
    this.clipWindow[side] = null;
  }

  // ---------------------------------------------------------------- serve

  /** Follows the held aim before the serve, so the ball rides the right hand. */
  private serveClip: string = SERVE_CLIPS[0];
  /** Landing aim for the serve (court space); live for the player, rolled once for the AI. */
  private serveAim = { fwd: 0, lat: 0 };
  /**
   * Pace and arc the server asked for, 0..1 and a flight multiplier.
   *
   * Neutral until a control scheme says otherwise, and neutral is exactly
   * today's serve — so a CPU serve, or one from a peer too old to send a
   * shape, comes out unchanged.
   */
  private serveShot = { power: 0.5, loft: 1 };

  private beginServeCycle(): void {
    this.state = "serve_move";
    // A fresh clock, and a fresh countdown to write.
    this.serveClockLeft = null;
    this.serveClockShown = null;
    // A new point means the game is no longer over, so the victory shot must
    // let go of the camera — otherwise a rematch plays out in close-up.
    this.matchWinner = null;
    this.victoryPos = null;
    this.victoryTarget = null;
    this.servePhase = "idle";
    // Back to neutral: a shape asked for on the last serve must not ride into
    // this one, and the CPU never asks for one at all.
    this.serveShot = { power: 0.5, loft: 1 };
    // A point celebration may still be playing; it must not block the walk
    // to the serve spot.
    this.stopSideAction("player");
    this.stopSideAction("ai");
    this.chars.player.minCourtX = SERVE_X;
    this.chars.ai.minCourtX = SERVE_X;
    this.strikeableSide = null;
    this.touchCount = 0;
    this.autoSetupRun = { player: false, ai: false };
    this.autoRunArrived = { player: false, ai: false };
    this.lockedState = { player: false, ai: false };
    this.struckPace = { player: 0, ai: 0 };
    this.leashSlack = { player: Infinity, ai: Infinity };
    this.lastPart = { player: null, ai: null };
    this.contactSync = null;
    this.pendingTouch = null;
    this.moveTarget = null;
    // A charge only ever advances during a rally, so one held when the point
    // ended would otherwise sit there — on the power bar, and on the next
    // kick — until something else cleared it.
    this.kickAim = { player: { taps: 0, held: 0 }, ai: { taps: 0, held: 0 } };
    this.receptionAim = { player: null, ai: null };
    this.celebration = null;
    this.anchor = { player: null, ai: null };
    this.repredictIn = 0;
    this.resetAimSpot();
    if (this.serveOwner === "ai" && !this.versus) {
      // The AI's serve follows a pattern keyed by the point index — side
      // alternates, depth cycles — so it is a serve a receiver can learn to
      // read, and the clip (which follows the aim) shows the tell.
      const pattern = aiServePattern(this.totalPoints);
      const ownLat = pattern.lat; // + = the AI's own left (-z in court space)
      this.serveClip = serveClipForAim(ownLat);
      this.serveAim = { fwd: pattern.fwd, lat: -ownLat };
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
   * Walk the receiver back behind their own service line between points.
   *
   * Behind the line because the rulebook puts the receiver there too, and
   * because every point should start from the same place rather than from
   * wherever the last one happened to end.
   *
   * `steerable` is the receiver's own controls, when a human holds them. Given
   * a direction they drive themselves and the walk stands down: a player
   * setting themselves for the return is doing something deliberate, and
   * hauling them back to a mark while they do it is the game wrestling the
   * stick. Left alone they finish the walk — an abandoned half-trip is what
   * strands somebody mid-court, diagonal to everything, looking like the
   * character set off on its own. moveToward zeroes the velocity on arrival,
   * which also stops the jog blend.
   */
  private walkReceiverHome(dt: number, steerable: InputState | null = null): void {
    const recvSide = other(this.serveOwner);
    const recv = this.chars[recvSide];
    if (recv.busy) return;
    if (steerable && Math.hypot(steerable.moveX, steerable.moveZ) > 0.25) {
      recv.move(steerable.moveX, steerable.moveZ, recv.def.speed, dt);
      return;
    }
    const mark = new Vector3(sign(recvSide) * (SERVE_X + 0.15), GROUND_Y, SPAWN.z);
    recv.moveToward(mark, recv.def.speed, dt);
  }

  /**
   * The receiver's own controls, if a human is holding them and may use them.
   *
   * Null while the CPU receives, and null in portrait, where the axes carry a
   * swipe's leftover aim rather than anywhere the player asked to stand.
   */
  private receiverInput(input: InputState): InputState | null {
    if (this.tapSteering) return null;
    const recvSide = other(this.serveOwner);
    if (recvSide === "player") return input;
    if (recvSide === "ai" && this.versus) return this.versusInput;
    return null;
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
  /**
   * The pace and arc a committed press asked its serve for.
   *
   * Both schemes say it the way they say everything else — landscape by how
   * many times the button was tapped and how long the last press was held,
   * portrait by the shape and speed of the swipe — so nothing new has to be
   * learned to serve.
   *
   * The arc is remapped rather than passed straight through, and that is the
   * one place the serve differs from a rally kick. A kick's neutral is
   * "whatever the contact implies", so its scale only ever climbs from there.
   * A serve's neutral is a fixed shape, so the axis has to run *both* ways
   * around it — a tap has to be able to ask for a flatter, faster ball than
   * the standard one, not merely fail to loft it.
   */
  private serveShotFor(input: InputState, side: Side): { power: number; loft: number } {
    if (this.portraitFor(side)) {
      const attack = sign(other(side));
      // No ground loft: `loftFloor` is a rally rule about getting a struck ball
      // over the net from deep in the court, and a serve solves its own
      // clearance from behind the service line.
      const shot = swipeShot(input.moveX * attack, input.strikePower, 0);
      return { power: shot.power, loft: shot.loft };
    }
    const taps = input.strikeTaps;
    const power = taps ? kickPower(taps) : 0.5;
    const held = input.strikeLoft ?? 1;
    // [1, loftMax] from the kick scheme, spread across [flat, floated] here.
    const t = (held - 1) / (KICK_INPUT.loftMax - 1);
    return { power, loft: SERVE_ARC.flat + (SERVE_ARC.floated - SERVE_ARC.flat) * t };
  }

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
    this.serveClockLeft = null;
    this.serveClockShown = null;
    const contactF = contactFraction(clip);
    const airTime = Math.max(0.25, (contactF - tossF) * durSec);
    this.state = "serve_anim";
    this.ui.hint(null);
    this.playSideAction(this.serveOwner, clip, {
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
    // Same aim mapping as rally strikes. The landing drifts toward the aimed
    // sideline by what the server's traits allow — deterministic, so a wide
    // serve curls wide every time, and the skill is leaving a hand's width of
    // inward aim for the drift to spend. A centre serve drifts not at all,
    // which keeps the neutral serve exactly the one it has always been.
    const aim = this.serveAim;
    const spot = serveTarget(sign(recv), aim.fwd, aim.lat);
    const tx = spot.x;
    const ff = footFactor(server.def, this.serveClip);
    // The serve trait does both halves of a good serve: it tightens where the
    // ball can be put and it puts pace on it. A strong server can go near the
    // line at speed; a weak one has to choose.
    const sprayAmp = (0.25 * ff.spray) / (server.def.precision * server.def.serve);
    const spray = 0.5 * sprayAmp * (1 - 0.7 * Math.min(1, Math.abs(aim.lat))) * Math.sign(aim.lat);
    const tz = Math.max(-0.62, Math.min(0.62, spot.z + spray));
    const target = new Vector3(tx, tableSurfaceY(tx) + 0.02, tz);
    const dist = Vector3.Distance(this.ball.state.pos, target);
    // Foot serves fly faster and flatter than head serves.
    const power = (SERVE_POWER[this.serveClip] ?? 1) * server.def.power * ff.power * server.def.serve;
    // What the server asked for, on top of what their clip and traits give.
    // Neutral is 0.5 and 1, and `0.78 + 0.44 * 0.5` is exactly 1 — so a serve
    // nobody shaped solves the identical velocity it always has, and the CPU's
    // serve and every number tuned behind it are untouched by this being
    // controllable at all. `tests/serve.test.ts` holds that.
    const shot = this.serveShot;
    const paced = power * (0.78 + 0.44 * shot.power);
    // Pace has to shape the arc, not just the flight time, or it says nothing.
    // `solveLaunchClearingNet` only ever *lengthens* a flight to clear the net,
    // so from behind the service line the clearance is what the serve actually
    // ends up being — ask three different paces for the same clearance and all
    // three come back at the same speed, having each been lengthened to the same
    // arc. A driven serve passes closer to the tape, which is also just true.
    //
    // `1.25 - 0.5 * 0.5` is exactly 1, so neutral is still untouched.
    const arc = shot.loft * (1.25 - 0.5 * shot.power);
    const clearance = Math.min(
      SERVE_CLEARANCE.max,
      Math.max(SERVE_CLEARANCE.min, SERVE_CLEARANCE.base * arc)
    );
    const v = capLaunchApex(
      this.ball.state.pos,
      solveLaunchClearingNet(
        this.ball.state.pos,
        target,
        ((0.55 + dist * 0.07) * shot.loft) / paced,
        clearance
      ),
      GROUND_Y + 2 * server.height
    );
    this.struckPace[this.serveOwner] = Math.hypot(v.x, v.z);
    this.servePhase = "launched";
    this.lastHitter = this.serveOwner;
    this.strikeableSide = null;
    this.touchCount = 0;
    this.resetAimSpot(this.serveOwner);
    this.ball.launch(v);
    this.audio.playKick();
    this.state = "rally";
    this.chars.player.minCourtX = COURT.minX;
    this.chars.ai.minCourtX = COURT.minX;
    this.emitLaunch(this.serveOwner, "serve", this.serveClip, 1);
    this.emit({ type: "serve-committed", side: this.serveOwner });
  }

  // ---------------------------------------------------------------- touches

  /** Common gate for any touch: in a rally, in possession, free and in reach. */
  private canTouch(side: Side, reach = PLAYER_REACH): boolean {
    if (this.state !== "rally" || this.servePhase === "toss") return false;
    if (this.strikeableSide !== side) return false;
    if (this.pendingTouch) return false; // a queued touch is already waiting
    if (this.chars[side].busy) return false;
    // Judged against the ball this seat was looking at when it pressed, not
    // the one a round trip later. `seenBall` is the live ball for everyone
    // but a remote second seat, and this used to carry a flat 15% of extra
    // reach for that seat instead — a fudge that let through touches nobody
    // could see and still refused ones they could.
    return this.ballFromChest(side, this.seenBall(side)) <= reach;
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
  /**
   * Whether the venue is an enclosed building.
   *
   * The side camera stands outside it when it is: the shot is solved from the
   * court, and the court is inside a hall whose wall is nearer than the lens
   * needs to be. Rather than move the camera in — which would stop the whole
   * court fitting, the thing that view was fixed for — the near plane is
   * pushed past the wall so the camera looks through it.
   */
  indoorVenue = false;
  venueId: string = "football";
  private autoReceive(side: Side, stick: InputState | null): void {
    if (!this.autoFirstReception || this.touchCount > 0 || this.ball.held) return;
    // One vicinity for both seats. This used to be 15% wider for a remote
    // second seat, the same latency fudge `canTouch` carried, and it is the
    // more visible of the two: the first touch is automatic, so a guest was
    // shown their player collecting balls that were plainly beyond them, with
    // no press of their own to explain it. What the delay actually costs is
    // answered by `seenBall` inside `canTouch` now.
    const reach = AUTO_RECEPTION_REACH;
    if (!this.canTouch(side, reach)) return;
    const tapAim = this.receptionAim[side];
    this.receptionAim[side] = null;
    let aimX = 0;
    let aimZ = 0;
    if (tapAim) {
      aimX = tapAim.x;
      aimZ = tapAim.z;
    } else if (stick && !this.portraitFor(side)) {
      const mag = Math.hypot(stick.moveX, stick.moveZ);
      if (mag > RECEPTION_STICK_DEADZONE) {
        aimX = stick.moveX;
        aimZ = stick.moveZ;
      }
    }
    this.tryControlTouch(side, aimX, aimZ, reach);
  }

  /** A committed touch waiting for the ball to drop back into striking range. */
  private pendingTouch:
    | { side: Side; kind: "strike"; aim: StrikeAim; wait: number; asked: number }
    | { side: Side; kind: "pop"; aimX: number; aimZ: number; wait: number; asked: number }
    | null = null;

  /**
   * Seconds to hold a just-pressed touch before starting its wind-up, so the
   * contact lands once the ball has dropped into striking range. 0 = wind up
   * now. Prevents the ball-still-rising case (e.g. a pop pressed right after
   * an own pop) from striking thin air above the player.
   */
  /**
   * Which side of their own half a player is standing on, in their own frame.
   *
   * Which foot a flip comes over on is decided by where the player is standing,
   * not by where the ball is. Signed the same way `lateral` is inside
   * `tryStrike`, and shared with `flipReady` so the two cannot disagree about
   * which flip is available.
   */
  private stanceOf(side: Side): number {
    return this.chars[side].position.z * (side === "player" ? -1 : 1);
  }

  /**
   * Whether a flip is genuinely the shot this side is about to play.
   *
   * Asked before the clip is chosen, because the answer decides how long the
   * strike is allowed to wait — and waiting for a ball to fall to shoulder
   * height when the shot is a bicycle kick is waiting for it to be gone.
   *
   * It has to ask the real question rather than "does this character own a
   * flip", because `chooseStrike` drops the flip when the previous touch was
   * also a foot. Every clause here mirrors one of its gates: a flip is a finish
   * (`touchCount > 0`), it is never played twice off the same body part, the
   * character and stance have to allow it, and the model has to carry the clip.
   */
  private flipReady(side: Side): boolean {
    if (this.touchCount === 0) return false;
    if (this.lastPart[side] === "foot") return false;
    const c = this.chars[side];
    const foot = strikeBackflipFoot(this.stanceOf(side), c.def);
    if (!foot) return false;
    return c.groups.has(foot === "right" ? "BackflipRightFoot" : "BackflipLeftFoot");
  }

  private touchWait(char: Character, maxRel = STRIKE_CEILING.normal): number {
    const flight = sampleFlight(this.ball.state, 1.4);
    let prevY = this.ball.state.pos.y;
    for (const s of flight) {
      if (s.grounded) break; // a ball about to touch down must be hit now or never
      const relH = (s.pos.y - GROUND_Y) / char.height;
      const descending = s.pos.y < prevY;
      prevY = s.pos.y;
      if (descending && relH <= maxRel && relH >= 0.15) {
        return s.t <= CONTACT_WINDOW.max ? 0 : Math.min(1.1, s.t - 0.28);
      }
    }
    return 0;
  }

  /**
   * What the next kick is asking for.
   *
   * Landscape hands back the marker the stick has been moving, struck at the
   * charge that was held.
   *
   * Portrait reads the swipe itself. The sideways half of the gesture aims the
   * ball; the *steepness* of it chooses the shot — up the court for a flat
   * drive, back toward the player for a lob, across for the ordinary rally
   * ball — and how fast it was drawn decides how much of that shot's pace it
   * gets. One gesture, one finger, three learnable outcomes, and no button
   * anywhere: see `swipeShot`.
   *
   * A downward swipe used to aim the kick *backwards*, at a point in the
   * player's own half — the one gesture in the scheme that could only ever
   * lose a point. It is now the lob, which is the shot a player reaching for
   * that direction was always trying to play.
   */
  private aimFor(side: Side, input: InputState): StrikeAim {
    // The tapped kick: how many taps decided the speed, and how long the last
    // press was held decided the arc — two answers from one button, worked out
    // in `kickinput.ts` before the press ever reached here. Portrait takes the
    // branch below, where a single swipe says both at once.
    //
    // The fallback matters as much as the tiers. A press with no tap count is
    // a synthesised one — the network, a test — and it still has to produce a
    // playable kick rather than the softest possible touch.
    if (!this.portraitFor(side)) {
      const taps = input.strikeTaps;
      const power = taps ? kickPower(taps) : Math.max(TAP_POWER, input.strikePower || 0.55);
      const loft = input.strikeLoft ?? 1;
      const attack = sign(other(side));
      const spot = this.aimSpot[side];
      const center = new Vector3(attack * TABLE.halfLen * 0.55, 0, 0);
      if (input.moveX !== 0 || input.moveZ !== 0) {
        spot.x = center.x + input.moveX * (TABLE.halfLen * 0.48);
        spot.z = center.z + input.moveZ * (TABLE.halfWid * 0.95);
        this.aimSpot[side] = clampToPlay(spot);
      }
      if (side === "player") this.lastPlayerAim = { power, loft };
      return { target: this.aimSpot[side].clone(), power, loft };
    }
    const c = this.chars[side];
    const attack = sign(other(side));
    // Read raw, not normalised to a direction. The axes carry how far the
    // thumb actually went, and that is what makes the two of them independent:
    // normalising divided the reach back out, so a wide swipe and a wide-and-
    // lifted one asked for the same arc, and swipe length meant nothing at all.
    // Forward is measured toward the opponent's end; lateral stays in court
    // space, because that is the axis the target is built on.
    const forward = input.moveX * attack;
    const lateral = input.moveZ;
    // The gesture's own pace, which the input scheme put in `strikePower`, and
    // the flattest arc this spot on the court allows — see `swipeShot`.
    const shot = swipeShot(forward, input.strikePower, loftFloor(c.position.x));
    const target = swipeTarget(c.position, attack, lateral, shot);
    this.aimSpot[side] = target.clone();
    if (side === "player") this.lastPlayerAim = { power: shot.power, loft: shot.loft };
    return { target, power: shot.power, loft: shot.loft };
  }

  /**
   * Move this side's aim marker with the stick. Returns true while a held press
   * is being lined up, so the caller can keep the striker still.
   *
   * Two windows, and the second one is why a wide shot is possible at all.
   *
   * A press being physically down is the obvious one. On its own it was also
   * the only one, and it made aiming and charging the same gesture: the marker
   * starts each possession in the middle of the opponent's half, the stick
   * only moves it while the button is down, and a press past `KICK_INPUT.hold`
   * is a lob rather than a drive. Reaching a corner therefore cost the flat
   * shot the player was reaching for — so in practice the marker stayed in the
   * middle of the table and the whole width of the court went unused.
   *
   * The second is the run back under your own set-up. The game owns the feet
   * there (`runLocked`), so the stick is doing nothing whatsoever for the
   * length of a hang — the one moment in a rally with a free control and a
   * decision worth making with it. Aiming during it costs nothing and asks for
   * nothing, and the shot is still committed by the press that follows.
   *
   * The two never overlap: this window is a set-up already played
   * (`touchCount > 0`), and the settle before a *first* touch reads the stick
   * as the shape of that reception instead (`receptionSettling`).
   *
   * Portrait never charges — its swipe already said how hard — and a side that
   * cannot strike right now cannot line one up either.
   */
  private updateAiming(side: Side, input: InputState, dt: number, setupRun: boolean): boolean {
    const aimable =
      this.state === "rally" &&
      this.strikeableSide === side &&
      !this.chars[side].busy &&
      !this.pendingTouch &&
      !this.portraitFor(side);
    // Tracked before the early return: between taps no press is down, and the
    // bar still has to show the tier already banked.
    this.kickAim[side] = aimable
      ? { taps: input.strikeTapsSoFar ?? 0, held: input.strikeHoldSoFar ?? 0 }
      : { taps: 0, held: 0 };
    if (!aimable) return false;
    const lining = input.strikeHeld || (input.strikeTapsSoFar != null && input.strikeTapsSoFar > 0);
    // The free window: the run is carrying them, so nothing else wants the
    // stick. `setupRun` is `runLocked`, which is only ever true for a set-up
    // this side played — passed in rather than asked for again, because it
    // carries the arrival latch and is not a question to ask twice a frame.
    if (!lining && !setupRun) return false;
    const spot = this.aimSpot[side];
    spot.x += input.moveX * AIM_SPEED * dt;
    spot.z += input.moveZ * AIM_SPEED * dt;
    // Held to the half being attacked, not to the whole court: the other half
    // is behind the net, and an aim there is a marker on the floor by the
    // player's own feet rather than an instruction.
    this.aimSpot[side] = clampToTargetHalf(spot, sign(other(side)));
    // Only a held press roots the striker. Aiming mid-run must not, or it
    // would stop the run it is borrowing the stick from.
    return lining;
  }

  /**
   * What the player's last kick actually asked for.
   *
   * Written for the input harness, which otherwise has no way to see whether a
   * hold's arc survived the trip from the button to the ball — it used to watch
   * the charge accumulator, which no longer exists. Read by nothing in the
   * game itself — `scripts/verify-portrait.mjs` is the only consumer, so it
   * looks unused to a grep over `src/` alone.
   */
  lastPlayerAim: { power: number; loft: number } | null = null;

  /** Portrait touch play: no aim marker, and the swipe carries the aim. */
  portraitControls = false;
  /**
   * The second seat is playing by gesture on an upright phone.
   *
   * Online, that seat is a stranger's phone and it may be held either way, so
   * the scheme is reported on their input frames rather than assumed from
   * ours. Before this existed the host read every guest as landscape, which
   * turned a portrait guest's swipe — a carry length and a pace — into a stick
   * offset onto the table, and left its serve looking for a tap count that
   * scheme never sends.
   */
  versusPortrait = false;

  /**
   * Which control scheme is driving a seat.
   *
   * Always this, never `portraitControls` directly: that field is only ever
   * this device's own scheme, and the second seat's may differ.
   */
  private portraitFor(side: Side): boolean {
    return side === "player" ? this.portraitControls : this.versusPortrait;
  }

  /**
   * Attempt the return strike for `side`, aimed at a point on the court and
   * struck at a chosen power.
   *
   * Where it actually lands is that point displaced by the contact's own
   * geometry: the spread grows the harder the ball is struck, again for a
   * contact taken at full stretch, and shrinks for a precise striker — and
   * its direction is the contact's (early carries long, stretched squirts
   * sideways), so the same shot lands the same way twice. Nothing clamps the
   * result back onto the table, so a kick aimed at the line and hit flat out
   * can and should miss.
   */
  tryStrike(side: Side, aim: StrikeAim, timingSlip = 0): boolean {
    if (!this.canTouch(side)) return false;
    const c = this.chars[side];
    const popped = this.touchCount > 0; // ball was set up by a control touch
    // A direct return — no control touch first — meets the ball at the pace it
    // was struck with, and that is a technique question: the volley trait sets
    // the pace this character can take cleanly, and past it the ball sprays
    // (see `PACE.volley`). A set-up ball was slowed by the touch that made it,
    // so it costs nothing here.
    const volleyFactor = popped
      ? 1
      : volleyPaceFactor(this.struckPace[other(side)], c.def.volley);
    const power = Math.min(1, Math.max(0, aim.power));

    // Ball still climbing (or way overhead): queue the touch until it drops —
    // but only as far as this touch actually needs. A flip is struck above the
    // head, so it waits for a much higher ball than anything played off the body.
    const wait = this.touchWait(c, this.flipReady(side) ? STRIKE_CEILING.flip : STRIKE_CEILING.normal);
    if (wait > 0) {
      this.pendingTouch = {
        side,
        kind: "strike",
        aim: { target: aim.target.clone(), power, loft: aim.loft },
        wait,
        asked: wait + timingSlip,
      };
      return true;
    }

    this.lastHitter = side;
    this.strikeableSide = null;
    this.touchCount = 0;
    this.resetAimSpot(side);
    this.pointTouches++;
    this.autoSetupRun[side] = false;
    this.autoRunArrived[side] = false;
    this.leashSlack[side] = Infinity;
    if (side === "player") this.ui.hint(null);
    // Portrait has no tap sequence the bar can track, so the bar echoes the
    // power this kick committed at — the swipe's one visible consequence.
    if (side === "player" && this.portraitControls && !this.versus) {
      this.meterEcho = { power, frames: 45 };
    }

    // Pick the clip from where the ball will NATURALLY be around contact time
    // — its flight is sampled, never altered; the character goes to the ball.
    const flight = sampleFlight(this.ball.state, CONTACT_WINDOW.max + 0.05);
    // The limb comes from the ball this seat was looking at; the contact is
    // planned on the live flight below. A remote seat's press is a few ticks
    // of fall old by the time it lands here, and a few ticks of fall is a
    // whole height band — which is why a joined player kept meeting a chest
    // ball with a knee. For everyone else `seenFlight` is `flight`.
    const probe = flightAt(this.seenFlight(side, CONTACT_WINDOW.max + 0.05), STRIKE_LEAD);
    const lateral = (probe.z - c.position.z) * (side === "player" ? -1 : 1);
    const ballHeight = probe.y - GROUND_Y; // height above the ground plane
    // Where they are standing decides which shots are even on the menu: the
    // hard ones need the middle line. See `canSmashFrom`.
    const nearMiddle = canSmashFrom(c.position.x);
    const stance = this.stanceOf(side);
    let clip = chooseStrike(ballHeight, lateral, stance, c.def, popped, {
      avoid: this.lastPart[side],
    });
    // A model without the clip falls back to a kick rather than standing still.
    if (!c.groups.has(clip) && clip.startsWith("Backflip")) {
      clip = `${lateral >= 0 ? "Right" : "Left"}FootKick`;
    }
    // Backflips are played facing away from the table. `clipYawOffset` owns
    // that turn and applies it to the plan and the pose alike, so the reason
    // it exists is written there rather than restated here.
    //
    // It costs frequency, deliberately. The contact sits further from the body
    // than `LUNGE_MAX` can carry a player mid-swing, so a flip only commits when
    // they were already well placed — `chooseStrike` falls back to a foot kick
    // otherwise. Earned rather than automatic-looking.
    const plan = this.planContact(c, clip, STRIKE_SPEED, flight, timingSlip);
    // How well this contact was met, decided before a frame of it has played
    // and never revisited: the same approach to the same ball always earns the
    // same touch. A clean strike goes where it was aimed; a scrappy one keeps
    // most of its pace and loses the line, which is what makes rushing an
    // attack a real risk rather than a slower ball. A direct return against a
    // fast ball starts from behind (see `volleyFactor`).
    const quality = plan.quality * volleyFactor;
    const graded = strikeShape(quality);
    this.lastPart[side] = bodyPartOf(clip) ?? this.lastPart[side];
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
      // Align ball to striking limb's actual world position at contact
      const boneName = CLIP_CONTACT_BONE[clip];
      const limbNode = boneName ? c.findNode(boneName) : null;
      if (limbNode) {
        const contactPos = limbNode.getAbsolutePosition().clone();
        if (clip.includes("Head")) {
          contactPos.addInPlace(c.forward.scale(HEAD_CONTACT_PUSH));
        } else {
          contactPos.addInPlace(c.forward.scale(BALL_RADIUS * 0.4));
        }
        if (Vector3.Distance(this.ball.state.pos, contactPos) < 0.45) {
          this.ball.state.pos.copyFrom(contactPos);
        }
      }

      // Where it was aimed, plus the spread that aim earned. The stretch term
      // is how far the striker had to reach for the contact: a ball taken at
      // arm's length is not struck as cleanly as one met in front.
      const ff = footFactor(c.def, clip);
      const chest = c.position.add(new Vector3(0, c.height * 0.55, 0));
      const stretch = Vector3.Distance(chest, this.ball.state.pos) / PLAYER_REACH;
      const radius =
        spreadRadius({
          power,
          precision: c.def.precision,
          footSpray: ff.spray,
          stretch,
        }) * graded.spread;
      // Where it actually lands: the aim displaced by the contact's own
      // geometry, so the same shot lands the same way twice and every miss is
      // the striker's to learn from.
      const landed = landingDeviation(aim.target, this.ball.state.pos, radius, {
        power,
        sense: plan.sense,
        lateral,
        stretch,
      });
      // Aiming past the far edge is allowed — that is how a kick misses — but
      // a target beyond the court is not a shot anyone meant to play.
      const wanted = clampToPlay(landed);
      const onTable = Math.abs(wanted.x) <= TABLE.halfLen && Math.abs(wanted.z) <= TABLE.halfWid;
      const surfaceY = onTable ? tableSurfaceY(wanted.x) : GROUND_Y;
      const target = new Vector3(wanted.x, surfaceY + 0.02, wanted.z);
      const dist = Vector3.Distance(this.ball.state.pos, target);
      // Stronger kicks fly flatter and faster (shorter flight time).
      let kickPower = (KICK_POWER[clip] ?? 1) * c.def.power * ff.power * graded.power;
      kickPower *= 0.72 + 0.5 * power;
      // The arc follows the requested power first — a soft kick floats, a hard
      // one is drilled — and then the contact: a low volley must still loft
      // over the net while a high contact is hit down. Kicks taken close to
      // the table flatten (there is no runway for a lob), deep ones float a
      // touch more, and each clip's KICK_LOFT nudges it again.
      const relH = (this.ball.state.pos.y - GROUND_Y) / c.height;
      const clipLoft = KICK_LOFT[clip] ?? 1;
      const prox = Math.min(1, Math.max(0, (Math.abs(this.ball.state.pos.x) - TABLE.halfLen) / 2.2));
      // `aim.loft` is what a portrait swipe asked for — up drills the ball,
      // down floats it — and 1 leaves the arc entirely to the power and the
      // contact, which is what a charged landscape kick sends.
      let loft =
        loftFor(power) *
        (aim.loft ?? 1) *
        Math.min(1.1, Math.max(0.35, 1.25 - relH)) *
        clipLoft *
        (0.78 + 0.32 * prox);
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
      //
      // A backstop now rather than the main knob. Since the flip band moved
      // above head height, the height term above has already saturated at 0.35
      // (it bottoms out at relH 0.9) and the natural loft comes out under this
      // clamp, so the shot is decided by `KICK_SPEED_CAP` — the flip goes as
      // fast as a flip is allowed to go. This still binds at the bottom of the
      // band, where a wide ball can be flipped from as low as 0.78.
      if (clip.startsWith("Backflip")) {
        loft = Math.min(loft, 0.34 - 0.12 * Math.min(1, Math.max(0, relH - 0.7) / 0.4));
      }
      const clearance = smash ? 0.02 : relH > 0.7 ? 0.05 : clipLoft < 1 ? 0.08 : 0.14;
      // Floor the flight time so the launch stays under this clip's speed cap:
      // headers are quick but human, only foot smashes and backflips get the
      // full whip (a clamped launch would also sag below the net clearance).
      const cap = (KICK_SPEED_CAP[clip] ?? KICK_SPEED_CAP_DEFAULT) * BALL_PACE;
      const flight = Math.max(((0.5 + dist * 0.055) * loft) / (kickPower * BALL_PACE), dist / cap);
      // What the HUD flashes: how well the ball was met, tempered by how far
      // off the intended line it ended up. Both halves of a good shot, in the
      // one short word the existing flash already shows — no new dial, no
      // timing bar, nothing to read mid-rally.
      if (side === "player" && !this.versus) {
        const online = Math.max(0, 1 - Vector3.Distance(wanted, aim.target) / SPREAD.max);
        this.ui.meterResult?.(Math.min(quality, 0.5 * quality + 0.5 * online));
      }
      const v = solveLaunchClearingNet(this.ball.state.pos, target, flight, clearance);
      this.struckPace[side] = Math.hypot(v.x, v.z);
      this.ball.launch(v, 0.7 + relH); // smashes visibly spin faster
      this.audio.playKick();
      this.emitLaunch(side, "strike", clip, 0.7 + relH);
      this.emit({ type: "touch-committed", side, action: "strike", afterSetup: popped });
    };

    const played = this.playSideAction(side, clip, {
      startFrac: plan.startFrac,
      speed: STRIKE_SPEED,
      callbacks: [{ frac: contactFraction(clip), fn: launch }],
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
  tryControlTouch(side: Side, aimX = 0, aimZ = 0, reach = PLAYER_REACH, timingSlip = 0): boolean {
    if (!this.canTouch(side, reach)) {
      return false;
    }
    if (this.touchCount >= MAX_TOUCHES - 1) {
      // Out of touches: the set-up becomes the finish, aimed where this side's
      // aim already points and struck at a middling pace.
      return this.tryStrike(side, { target: this.aimSpot[side].clone(), power: 0.55 }, timingSlip);
    }
    const c = this.chars[side];

    // Ball still climbing (or way overhead): queue the touch until it drops.
    const wait = this.touchWait(c);
    if (wait > 0) {
      this.pendingTouch = { side, kind: "pop", aimX, aimZ, wait, asked: wait + timingSlip };
      return true;
    }

    // What the other side's strike left at: the first touch of the possession
    // is judged against it, so a hard hit comes off the body harder to play
    // next (see `PACE` in `touch.ts`). Read before `touchCount` moves, because
    // it only applies to the reception itself.
    const incomingPace = this.touchCount === 0 ? this.struckPace[other(side)] : 0;

    this.touchCount++;
    this.pointTouches++;
    if (side === "player") {
      this.ui.hint(null);
      // Committing to a set-up spends any destination the player had stored:
      // a tap made while chasing the ball meant "be there for this ball", and
      // once the ball has been played it is stale.
      this.moveTarget = null;
    }

    // Clip choice and timing use the ball's sampled natural flight; the
    // character lunges to meet it (see tryStrike). The part that played the
    // last touch is barred, so a possession is a sequence of different limbs
    // whether the player planned it or not — and a player who did plan it can
    // pick which one comes next by where they stand and how far they let the
    // ball drop.
    const flight = sampleFlight(this.ball.state, CONTACT_WINDOW.max + 0.05);
    // The limb from the ball this seat saw, the plan from the live flight —
    // the same split `tryStrike` makes, and for the same reason.
    const probe = flightAt(this.seenFlight(side, CONTACT_WINDOW.max + 0.05), POP_LEAD);
    const lateral = (probe.z - c.position.z) * (side === "player" ? -1 : 1);
    // While the run to the ball owns the feet, the player never chose where to
    // stand relative to it, so the side it is taken on is not theirs to lose
    // either: whichever limb is nearer plays it, strong foot or not.
    const clip = pickReceptionClip(probe.y - GROUND_Y, lateral, c.height, c.def.strongFoot, {
      avoid: this.lastPart[side],
      forceNearest: this.runLocked(side),
    });
    const plan = this.planContact(c, clip, POP_SPEED, flight, timingSlip);
    const part = bodyPartOf(clip) ?? "foot";
    // What this limb does with this contact: the part decides the character of
    // the ball, the grade decides how much of what was asked for survives —
    // and a ball arriving fast costs some of the grade before the limb ever
    // meets it.
    const quality = plan.quality * receptionPaceFactor(incomingPace);
    const shape = setupShape(part, quality, plan.sense);
    this.lastPart[side] = part;

    // Pop the ball at the planned contact moment so it rises and comes down
    // at the aimed spot (clamped to this side's half of the court). Fired by
    // the countdown in update(); the animation callback is only a fallback.
    let fired = false;
    const pop = () => {
      if (fired) return;
      fired = true;
      this.contactSync = null;
      if (this.state !== "rally") return;
      // Align ball to control touch limb's actual world position at contact
      const boneName = CLIP_CONTACT_BONE[clip];
      const limbNode = boneName ? c.findNode(boneName) : null;
      if (limbNode) {
        const contactPos = limbNode.getAbsolutePosition().clone();
        if (clip.includes("Head")) {
          contactPos.addInPlace(c.forward.scale(HEAD_CONTACT_PUSH));
        } else if (clip.includes("Chest")) {
          contactPos.addInPlace(c.forward.scale(BALL_RADIUS * 0.6));
        } else {
          contactPos.addInPlace(c.forward.scale(BALL_RADIUS * 0.4));
        }
        if (Vector3.Distance(this.ball.state.pos, contactPos) < 0.45) {
          this.ball.state.pos.copyFrom(contactPos);
        }
      }

      const pos = this.ball.state.pos;
      const len = Math.hypot(aimX, aimZ);
      let target: Vector3;
      if (len > 0.2) {
        // How far the ball is actually placed: what was asked for, scaled by
        // what this limb can carry and by how cleanly it was met. A chest can
        // barely move the ball but puts it exactly there; a foot moves it a
        // long way and, met badly, moves it somewhere else.
        const carry = Math.min(1, len) * POP_CARRY * shape.carry * shape.accuracy;
        const ux = aimX / len;
        const uz = aimZ / len;
        // A mishit squirts: on past the spot when the ball was met early,
        // short of it when it was met late, and always across the line it was
        // meant to travel. Signed by the contact, so it is a consequence and
        // not a coin toss.
        const drift = carry * shape.drift;
        target = c.position.add(
          new Vector3(ux * carry + uz * drift, 0, uz * carry - ux * drift)
        );
      } else {
        target = c.position.add(c.forward.scale(0.5 * TABLE_SCALE * shape.carry));
      }
      // Further to travel, longer in the air: a set-up played across the court
      // has to hang long enough for its own player to arrive under it. How high
      // it actually sits up is the limb's doing — a headed ball buys a second,
      // a footed one has to be chased.
      const rise = Math.min(
        (1.0 + 0.55 * Math.min(1, len)) * shape.rise * TABLE_SCALE,
        // The same ceiling as every strike: twice the player's height, measured
        // from the contact rather than the ground, and never so small a pop
        // that there is no time to play the next touch.
        Math.max(0.3, GROUND_Y + 2 * c.height - pos.y)
      );
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
      this.struckPace[side] = Math.hypot(v.x, v.z);
      this.ball.launch(v, 0.45); // a set-up pop floats with little spin
      this.audio.playKick();
      this.emitLaunch(side, "pop", clip, 0.45);
      // The feet are owned by the run to the drop until the arrival. Where the
      // drop is comes from the ball's live flight (`computeAnchor`), not from
      // where this touch meant to put it, so a set-up that came off the body
      // badly is chased to where it actually went.
      // Only the sides a human steers keep an anchor: it exists to hold a
      // player's own run together, and the CPU does its own reading of the
      // ball (`pickIntercept` in `src/ai.ts`).
      if (side === "player" || this.versus) {
        this.autoSetupRun[side] = true;
        this.autoRunArrived[side] = false;
            this.anchor[side] = this.computeAnchor(side);
      }
      if (side === "player" && !this.versus) this.ui.meterResult?.(quality);
      this.emit({ type: "touch-committed", side, action: "pop" });
    };
    const played = this.playSideAction(side, clip, {
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
          this.resetAimSpot(e.side);
          // Nothing has been played this possession, so every part is legal
          // again — the no-repeats rule is about consecutive touches on one
          // ball, not about the whole point.
          this.lastPart[e.side] = null;
          this.autoSetupRun[e.side] = false;
          this.autoRunArrived[e.side] = false;
          this.leashSlack[e.side] = Infinity;
          this.kickAim[e.side] = { taps: 0, held: 0 };
          this.receptionAim = { player: null, ai: null };
          this.emit({ type: "possession-start", side: e.side });
          if ((e.side === "player" || this.versus) && this.possessionHints < 2) {
            this.possessionHints++;
            this.ui.hint(
              portraitTouch()
                ? "Swipe up to lift it · down to drive it · fast for pace"
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
    // The serve clock ends a point that never became a rally, so that state
    // counts too. Nothing else awards from anywhere but a rally.
    if (this.state !== "rally" && this.state !== "serve_ready") return;
    this.serveClockLeft = null;
    this.ui.hint(null);
    this.state = "point";
    this.pointWinner = winner;
    this.timer = 0;
    this.strikeableSide = null;
    this.autoSetupRun = { player: false, ai: false };
    this.autoRunArrived = { player: false, ai: false };
    this.lockedState = { player: false, ai: false };
    this.struckPace = { player: 0, ai: 0 };
    this.leashSlack = { player: Infinity, ai: Infinity };
    this.lastPart = { player: null, ai: null };
    this.contactSync = null;
    this.pendingTouch = null;
    this.anchor = { player: null, ai: null };
    this.bufferedPress = null;
    this.bufferedPress2 = null;
    this.landingSpot = null;
    // Intent does not survive the point it was formed in. A destination tapped
    // during the rally must not walk the player off their spot as the next
    // serve is being set up.
    this.moveTarget = null;
    this.receptionAim = { player: null, ai: null };
    this.resetAimSpot();
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
    const who = winner === "player" ? "Your point" : "Opponent point";
    this.ui.banner(`${who} — ${this.score.player} : ${this.score.ai}`, reason);
  }

  /** Scheduled point celebration (a short beat after the rally ends). */
  private celebration: { side: Side; delay: number } | null = null;

  /**
   * Play a random clip from the point celebration pool (Celebration* animations).
   * With `fitSec`, prefers clips that fit the window naturally and speeds one up as a last resort.
   */
  private playPointCelebration(side: Side, fitSec = 0, onEnd?: () => void): void {
    const c = this.chars[side];
    const avail = [...c.groups.keys()].filter((n) => /^Celebration\d*$/i.test(n));
    const list = avail.length > 0 ? avail : POINT_CELEBRATIONS.filter((n) => c.groups.has(n));
    if (list.length === 0) return;
    const durOf = (n: string): number => {
      const g = c.groups.get(n)!;
      return (g.to - g.from) / 60;
    };
    const fitting = fitSec > 0 ? list.filter((n) => durOf(n) <= fitSec * 1.4) : list;
    const pool = fitting.length > 0 ? fitting : list;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    const speed = fitSec > 0 ? Math.max(1, durOf(clip) / fitSec) : 1;
    this.playSideAction(side, clip, { speed, onEnd });
  }

  /**
   * Play a random clip from the match victory pool (EndOfGameVictory, Backflip, Stunt1, Stunt3).
   */
  private playMatchWinCelebration(side: Side, onEnd?: () => void): void {
    const c = this.chars[side];
    const avail = MATCH_WIN_CELEBRATIONS.filter((n) => c.groups.has(n));
    if (avail.length === 0) {
      this.playPointCelebration(side, 0, onEnd);
      return;
    }
    const clip = avail[Math.floor(Math.random() * avail.length)];
    this.playSideAction(side, clip, { speed: 1, onEnd });
  }

  /**
   * Drain and restore both players' legs.
   *
   * Running costs, standing recovers, and the gap between points recovers
   * faster still — which is why a long rally is felt in the *next* one rather
   * than only in itself. Stamina scales how slowly the reserve empties, so the
   * fit player is the one still accelerating in the third set.
   *
   * What it takes away is deliberately only acceleration (see `Character.move`
   * and `MIN_EFFORT`): a tired player is slow to start and slow to turn, never
   * unable to reach a ball. Attacking now means running to the middle line and
   * getting back, and a model that took away reach would make one brave point
   * cost the game.
   */
  private stepEffort(dt: number): void {
    const venueDrain = VENUE_MODIFIERS[this.venueId]?.staminaDrain ?? 1.0;
    for (const side of ["player", "ai"] as Side[]) {
      const c = this.chars[side];
      const effortLevel = Math.hypot(c.velocity.x, c.velocity.z) / Math.max(0.1, c.def.speed);
      // What this instant cost, softened by how fit the character is and adjusted
      // by the venue surface (e.g. hard asphalt in The Cage vs grass in The Park).
      const drain =
        (effortLevel * EFFORT.drain * dt * venueDrain) / Math.max(0.2, c.def.stamina);
      // Recovery is only for a player who is actually standing still, and
      // between points it is a breather rather than a restart.
      const still = effortLevel < STILL_ENOUGH;
      const gain = still ? (this.state === "rally" ? EFFORT.rest : EFFORT.restBetweenPoints) * dt : 0;
      // The ceiling falls with the work done and never rises again. This is
      // what stops a match being a sawtooth and makes the third set the third
      // set.
      c.reserve = Math.max(MIN_RESERVE, c.reserve - drain * EFFORT.reserveLoss);
      c.effort = Math.max(MIN_EFFORT, Math.min(c.reserve, c.effort - drain + gain));
    }
    // Shown rather than only felt. A player who is losing because their legs
    // have gone deserves to be able to see it happening, and it is the whole
    // justification for anything sold to fix it.
    this.ui.stamina?.(
      this.chars.player.effort,
      this.chars.ai.effort,
      this.chars.player.reserve,
      this.chars.ai.reserve
    );
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
        this.chars.player.minCourtX = COURT.minX;
        this.chars.ai.minCourtX = COURT.minX;
        this.state = "over";
        this.matchWinner = setWinner;
        this.celebration = null;
        const loser = other(setWinner);
        const winChar = this.chars[setWinner];
        this.playMatchWinCelebration(setWinner, () => winChar.playAction("Idle", { loop: true }));
        this.playSideAction(loser, "Defeat", {
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
    // A new match starts both players fresh, whatever the last one cost them.
    // The reserve as well as the level: a new match is a fresh pair of legs,
    // and it is the one thing that puts the ceiling back.
    for (const c of [this.chars.player, this.chars.ai]) {
      c.effort = 1;
      c.reserve = 1;
    }
    this.stopSideAction("player");
    this.stopSideAction("ai");
    this.clipStarts.length = 0;
    this.fxQueue.length = 0;
    this.guestFx.length = 0;
    // A rematch over a socket is a fresh match on the same rigs: the follower's
    // view of the previous one — poses, clips, the final phase — must not
    // carry across, or a stale "Defeat" keeps playing into the first serve.
    this.playback.reset();
    // Two seconds of 30 Hz frames: longer than any trip, short enough that a
    // rematch the other end never started still comes back to life.
    this.followerAwaitingRestart = this.netFollower ? 60 : 0;
    this.followerSelfPose = null;
    this.followerSelfAnchor = null;
    this.followerRenderTick = null;
    this.versusViewTick = null;
    this.ballHistory = [];
    this.guestFx = [];
    this.followerClipWin = { player: null, ai: null };
    this.followerClipKey = { player: null, ai: null };
    this.followerBlend = { player: 0, ai: 0 };
    this.selfPredicting = false;
    this.followerPhase = "";
    this.followerSelfLocked = false;
    this.followerMarkerIn = 0;
    this.meterEcho = null;
    this.landingSpot = null;
    this.bufferedPress = null;
    this.bufferedPress2 = null;
    this.moveTarget = null;
    this.followerTap = null;
    this.versusInput.strikePressed = false;
    this.versusInput.strikeHeld = false;
    this.versusInput.strikePower = 0;
    this.versusInput.popPressed = false;
    this.versusInput.confirmPressed = false;
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
    this.stepEffort(dt);

    // Committed rally touch: release the ball on the planned-contact countdown
    // (frame-exact). The ball follows its natural trajectory to the interaction
    // volume — no magnetic steering or snapping.
    const cs = this.contactSync;
    if (cs?.fire && cs.timeLeft !== undefined) {
      cs.timeLeft -= dt;
      if (cs.timeLeft <= 0) {
        cs.fire();
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
      // The guest hears/sees contacts on its playback clock; kick events ride
      // the launch instead, which is the moment worth the message.
      if (e.type === "table") this.pushFx("table", e.pos);
      else if (e.type === "ground") this.pushFx("ground", e.pos);
      else if (e.type === "side") this.pushFx("side", e.pos);
      else if (e.type === "net") this.pushFx("net");
      else if (e.type === "body") this.pushFx("body");
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
              portraitTouch()
                ? "Swipe where you want to serve"
                : "Aim with the stick · tap STRIKE for pace, hold to float it"
            );
          this.emit({ type: "serve-ready", side: this.serveOwner });
        }
        break;
      }
      case "serve_ready": {
        const server = this.chars[this.serveOwner];
        // Once the serve is ready a human receiver may set themselves. The
        // axes are free to say so: aiming a serve belongs to whoever is
        // serving, and that is the other side of the table.
        this.walkReceiverHome(dt, this.receiverInput(input));
        this.updatePlayerServeAim(input, true);
        this.updateVersusServeAim(true);
        this.ball.place(this.serveHandPos(server));
        this.timer += dt;
        if (this.serveOwner === "player") {
          if (input.strikePressed) {
            this.serveShot = this.serveShotFor(input, "player");
            this.startServe();
          }
        } else if (this.versus ? this.versusInput.strikePressed : this.timer > 1.1) {
          if (this.versus) this.serveShot = this.serveShotFor(this.versusInput, "ai");
          this.startServe();
        }
        // A serve nobody plays is a match nobody can finish. Only against
        // another person: the CPU serves on its own beat and has never needed
        // hurrying, and a solo player pausing to think is not stalling anyone.
        if (this.versus && this.state === "serve_ready") {
          this.serveClockLeft = Math.max(0, SERVE_CLOCK_SECONDS - this.timer);
          if (this.serveClockLeft <= 0) {
            this.awardPoint(other(this.serveOwner), "too slow to serve");
          } else {
            this.showServeClock(this.serveClockLeft);
          }
        }
        break;
      }
      case "serve_anim": {
        this.walkReceiverHome(dt, this.receiverInput(input));
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
            const early = p.asked;
            this.pendingTouch = null;
            // The wait it sat through is carried into the grade. The touch
            // still happens — a buffered press is never swallowed — but a
            // player who asked for it a second before the ball was there did
            // not time it, and the ball they get says so.
            if (p.kind === "strike") this.tryStrike(p.side, p.aim, early);
            else this.tryControlTouch(p.side, p.aimX, p.aimZ, this.touchCount === 0 ? AUTO_RECEPTION_REACH : PLAYER_REACH, early);
          }
        }
        // Track where the incoming ball can be intercepted, for the reach assist.
        this.repredictIn -= dt;
        if (this.repredictIn <= 0) {
          this.repredictIn = 0.15;
          this.anchor.player = this.computeAnchor("player");
          this.anchor.ai = this.versus ? this.computeAnchor("ai") : null;
          this.landingSpot = this.ball.held ? null : this.computeLandingSpot();
        }
        // Two different things own the feet, at two different moments. The
        // settle is the last stretch of an approach the player made; the run
        // is a ball they put up themselves. Neither is the old takeover that
        // played the whole approach for them.
        const settling = this.receptionSettling("player");
        const setupRun = this.runLocked("player");
        const locked = settling || setupRun;
        this.lockedState.player = locked;
        // Holding the kick control hands the stick to the aim marker and
        // charges the shot; the player stands still while they line it up. The
        // run to their own set-up hands it over too, and that one costs
        // nothing — see `updateAiming`.
        const aiming = this.updateAiming("player", input, dt, setupRun);
        // The run owns the feet while it lasts, so anywhere the player had
        // asked to stand is spent, not stored: left queued, it would take over
        // the moment the run finished and walk them away from the ball.
        if (locked) this.moveTarget = null;
        // Busy means an action clip owns the root (it may be lunging): the
        // locomotion velocity has to be gone, not merely decaying.
        if (player.busy) player.velocity.setAll(0);
        else if (aiming && !locked) player.move(0, 0, 0, dt);
        else if (locked) player.moveToward(this.anchor.player!.pos, player.def.speed, dt);
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
          this.autoReceive("player", input);
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
            this.playPointCelebration(this.celebration.side, 2.3 - CELEBRATE_DELAY - 0.1);
            this.celebration = null;
          }
        }
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
    this.updateServeMarker();
    this.updateMeter();
    player.update(dt);
    ai.update(dt);
    this.spendVersusPresses();
  }

  /**
   * A second seat's press is offered to exactly one simulation step, exactly
   * as player one's is by `consumeInput`.
   *
   * It used to be cleared only inside `updateVersusRally`, which runs only
   * during a rally — so a press made after the ball had landed sat latched
   * through the celebration, the walk back and the serve, and then fired a
   * touch into the first step of the next point, where the animation played
   * against nothing. The same latch served the next serve the instant it
   * became available, using an aim from the point before.
   *
   * Safe against a frame that arrives between steps: the session re-latches
   * one in `pendingGuest` until a step has actually had it.
   */
  private spendVersusPresses(): void {
    const v = this.versusInput;
    v.strikePressed = false;
    v.popPressed = false;
    v.confirmPressed = false;
    // A level describing this frame's axes, not a press — but one that must
    // not outlive the frame either, or a gap in the feed would leave the
    // second seat standing on a placement it made a second ago.
    v.tapAim = false;
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
      const onTable = Math.abs(spot.pos.x) <= TABLE.halfLen && Math.abs(spot.pos.z) <= TABLE.halfWid;
      const y = onTable ? tableSurfaceY(spot.pos.x) : GROUND_Y;
      m.position.set(spot.pos.x, y + 0.025, spot.pos.z);
    }
  }

  /**
   * Drive the power bar from the kick being charged.
   *
   * The marked band is where the spread is still tight enough to trust a line:
   * past it the ball goes harder and lands less reliably, which is the whole
   * trade the bar exists to show. Portrait has no tap sequence, so there the
   * bar briefly echoes the power a swipe kick committed at.
   */
  private updateMeter(): void {
    const { taps } = this.kickAim.player;
    if (taps > 0 && !this.versus) {
      this.meterEcho = null;
      // Plain power now that the tiers are the scale, so the marked band is
      // just SAFE_POWER — which is tier two exactly. The bar therefore reads
      // "one and two are safe, three is the gamble", which is the whole choice.
      this.ui.meter?.(kickPower(taps), 0, SAFE_POWER);
      return;
    }
    if (this.meterEcho && !this.versus) {
      this.ui.meter?.(this.meterEcho.power, 0, SAFE_POWER);
      this.meterEcho.frames -= 1;
      if (this.meterEcho.frames <= 0) this.meterEcho = null;
      return;
    }
    this.ui.meter?.(null, 0, 0);
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
    if (side && this.portraitFor(side)) side = null;
    marker.setEnabled(side !== null);
    if (!side) return;
    if (inServe) {
      // The serve still aims by held direction, onto the opponent's half —
      // through the same function the launch uses, so the ring cannot promise
      // a spot the ball will not reach.
      const inp = side === "player" ? input : this.versusInput;
      const fwd = side === "player" ? inp.moveX : -inp.moveX;
      const spot = serveTarget(sign(other(side)), fwd, inp.moveZ);
      marker.position.set(spot.x, tableSurfaceY(spot.x) + 0.03, spot.z);
    } else {
      const spot = this.aimSpot[side];
      const onTable = Math.abs(spot.x) <= TABLE.halfLen && Math.abs(spot.z) <= TABLE.halfWid;
      const y = onTable ? tableSurfaceY(spot.x) : GROUND_Y;
      marker.position.set(spot.x, y + 0.03, spot.z);
    }
    // The marker swells with the arc a held press is asking for, so the thing
    // a hold actually changes is visible where the player is already looking.
    // It showed the charge before, which was the same number as the bar.
    const loft = kickLoft(this.kickAim[side].held);
    const arc = (loft - 1) / (KICK_INPUT.loftMax - 1);
    marker.scaling.setAll(1 + 0.35 * arc + 0.08 * Math.sin(performance.now() / 180));
  }

  /** Versus mode: drive the "ai" character from the second human's input. */
  private updateVersusRally(dt: number): void {
    const v = this.versusInput;
    const c = this.chars.ai;
    // Same locked run to the drop spot as player 1: the stick is not listened
    // to until the arrival, on the incoming ball and on P2's own set-up pop.
    const setupRun = this.runLocked("ai");
    const locked = this.receptionSettling("ai") || setupRun;
    this.lockedState.ai = locked;
    const aiming = this.updateAiming("ai", v, dt, setupRun);
    // A tapped placement is not somewhere to walk. Told apart by the frame's
    // own flag rather than guessed from the numbers: a tapped carry and a walk
    // direction are the same shape, and reading one as the other walked the
    // guest away from the ball it had just asked to play. With no press beside
    // it the tap is shaping the automatic first touch, which is where
    // `autoReceive` reads it from.
    const placing = v.tapAim === true;
    if (placing && !v.popPressed && !v.strikePressed && this.touchCount === 0) {
      this.receptionAim.ai = { x: v.moveX, z: v.moveZ };
    }
    if (c.busy) c.velocity.setAll(0);
    else if (aiming && !locked) c.velocity.setAll(0);
    else if (locked) c.moveToward(this.anchor.ai!.pos, c.def.speed, dt);
    else if (placing) c.move(0, 0, 0, dt);
    else {
      // Same reach assist as player 1, toward this side's intercept.
      const [bx, bz] = this.bendAssist("ai", c.position, this.anchor.ai, v.moveX, v.moveZ, c.def.speed);
      const [mx, mz] = this.holdNearAnchor("ai", c.position, this.anchor.ai, bx, bz, c.def.speed);
      c.move(mx, mz, c.def.speed, dt);
    }
    // The second seat aims and charges exactly as the first does; its axes
    // arrive already expressed in court space, so the marker moves in world
    // coordinates for both. Presses buffer like player 1's.
    if (v.strikePressed) {
      this.bufferedPress2 = { kind: "strike", aim: this.aimFor("ai", v), ttl: Math.max(PRESS_BUFFER, 0.45) };
      v.strikePressed = false;
    } else if (v.popPressed) {
      this.bufferedPress2 = { kind: "pop", aimX: v.moveX, aimZ: v.moveZ, ttl: Math.max(PRESS_BUFFER, 0.45) };
      v.popPressed = false;
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
      this.autoReceive("ai", this.versusInput);
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
  private cameraX = -SPAWN.x - CAMERA.back;
  private cameraY = CAMERA.height;
  private cameraDt = 1 / 60;
  private cameraLast = 0;
  /** Who won the game, while the end-of-match shot is being held on them. */
  matchWinner: Side | null = null;
  /**
   * Where the victory shot has eased to so far.
   *
   * Kept as state rather than recomputed because the move in starts from
   * wherever the match camera happened to be, so there is nothing to derive it
   * from once the first frame has passed.
   */
  private victoryPos: Vector3 | null = null;
  private victoryTarget: Vector3 | null = null;

  private updateCameraForSide(camera: TargetCamera, side: Side, mode: CameraMode): void {
    if (this.updateVictoryCamera(camera)) return;
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
        const c = this.chars.player;
        const isRally = this.state === "rally";

        let wantZ = 0;
        let wantX = baseX;
        let wantY = shot.height;

        if (portrait && !this.versus) {
          const portShot = portraitCameraShot(c.position.x, c.position.z, baseX);
          wantZ = isRally
            ? Math.max(-CAMERA.portrait.pan, Math.min(CAMERA.portrait.pan, portShot.z + c.position.z * 0.4))
            : portShot.z;
          wantX = isRally ? baseX + Math.max(0, (c.position.x - (-SPAWN.x)) * 0.25) : baseX;
          wantY = shot.height + (isRally ? Math.abs(c.position.z) * 0.2 : 0);
        } else if (!this.versus) {
          // Landscape: during rallies, sway laterally with the player to create
          // a pronounced dynamic angle on the player while keeping the table in the middle of the frame.
          const maxSway = 3.0;
          wantZ = isRally ? Math.max(-maxSway, Math.min(maxSway, c.position.z * 0.68)) : 0;
          wantX = isRally ? baseX + Math.max(0, (c.position.x - (-SPAWN.x)) * 0.25) : baseX;
          // Elevation during wide rallies gives extra overview when covering deep corners.
          wantY = shot.height + (isRally ? Math.abs(c.position.z) * 0.3 + Math.max(0, (c.position.x - (-SPAWN.x)) * 0.2) : 0);
        } else {
          wantZ = 0;
          wantX = baseX;
          wantY = shot.height;
        }

        const tau = portrait ? CAMERA.portrait.tau : 0.24;
        const k = Math.min(1, this.cameraDt / tau);
        this.cameraZ += (wantZ - this.cameraZ) * k;
        this.cameraX += (wantX - this.cameraX) * k;
        this.cameraY += (wantY - this.cameraY) * k;

        // Look down towards the table and near court, framing both players and the table.
        const target = new Vector3(shot.lookX ?? -0.6, GROUND_Y + shot.lookY, 0);
        camera.position.set(this.cameraX, GROUND_Y + this.cameraY, this.cameraZ);
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
      camera.minZ = this.indoorVenue ? CAMERA.side.indoorMinZ : CAMERA.side.minZ;
      const target = new Vector3(0, GROUND_Y + CAMERA.side.lookY, 0);
      camera.position.set(0, GROUND_Y + CAMERA.side.height, mirror * CAMERA.side.distance);
      camera.setTarget(target);
      return;
    }

  }

  /**
   * Push in on whoever won, once the game is over. Returns whether it took the
   * camera, so the ordinary shots can be skipped while it has it.
   *
   * Presentation only: it reads positions and writes to the camera, and never
   * touches the simulation. The eased position is held rather than recomputed
   * so the move starts wherever the match camera was, whichever shot that was.
   */
  private updateVictoryCamera(camera: TargetCamera): boolean {
    const winner = this.matchWinner;
    if (winner === null || this.state !== "over") return false;
    const char = this.chars[winner];
    const shot = CAMERA.victory;
    // In front of them along the way they face, and off to one side: a
    // dead-centre front-on shot of a rig reads as a character picker.
    const facing = char.faceDir === -1 ? 1 : -1;
    const want = new Vector3(
      char.position.x + facing * shot.distance,
      GROUND_Y + shot.height,
      char.position.z + shot.offset
    );
    const look = new Vector3(char.position.x, GROUND_Y + shot.lookY, char.position.z);
    if (!this.victoryPos || !this.victoryTarget) {
      this.victoryPos = camera.position.clone();
      this.victoryTarget = camera.getTarget().clone();
    }
    const k = Math.min(1, this.cameraDt / shot.tau);
    this.victoryPos = Vector3.Lerp(this.victoryPos, want, k);
    this.victoryTarget = Vector3.Lerp(this.victoryTarget, look, k);
    camera.fov = shot.fov;
    camera.minZ = 0.1;
    camera.position.copyFrom(this.victoryPos);
    camera.setTarget(this.victoryTarget);
    return true;
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
