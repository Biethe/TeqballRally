import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { predict, sampleFlight, type Prediction } from "./ball";
import type { MatchController, MatchEvent } from "./match";
import { tableTarget, type StrikeAim } from "./aim";
import {
  AI_REACH,
  COURT,
  GROUND_Y,
  MAX_TOUCHES,
  SPAWN,
  TABLE,
  clearTable,
  onTableFootprint,
} from "./config";

/** The kinds of ball the CPU can decide to play. See `AIController.intent`. */
export type ShotIntent = "wide" | "deep" | "short" | "flat" | "loop";

export interface AIDifficulty {
  /** Fraction of the AI character's own court speed it actually uses. */
  speed: number;
  aimError: number;
  reactionTime: number;
  /**
   * How badly it reads a SLOW ball, in metres of error on the drop point.
   *
   * The base of its fallibility, grown by the incoming ball's pace (see
   * `READ`): a float is read near this, a missile near this times
   * `READ.maxMul`. It is deliberately the only knob that produces a missed
   * ball. A weak opponent stands in the wrong place and arrives late; it
   * never declines to play. See the note on the class for why that
   * distinction is the difference between an opponent and a bug.
   */
  misjudge: number;
  /** Chance per possession the AI starts a control-touch sequence. */
  popChance: number;
  /** Number of control touches to attempt when that sequence starts. */
  maxPopTouches: number;
  /**
   * How often the return is *chosen* rather than merely played, 0..1.
   *
   * Below it the CPU sends the ball somewhere legal and unremarkable; above it
   * it picks the shot that asks the player the hardest question available from
   * where they are standing — the drop when they have been pushed deep, the
   * ball across them when they have gone wide. It is the knob that decides
   * whether an opponent has a plan, and it is separate from `aimError`, which
   * only decides how well the plan is executed.
   */
  tactics: number;
}

// Difficulty presets. Friendly games let the player pick; competitions use
// "normal" and step up to "hard" for finals / the last league round.
//
// The reaction time is spent twice, on purpose: once before the AI starts its
// run (see `runDelay` on the controller) and once before it plays the touch.
// The run delay is what makes these numbers matter — an opponent that begins
// walking the instant the ball is struck arrives at everything however wrong
// its read was, which is exactly the opponent every playtest called unbeatable.
export const DIFFICULTIES = {
  easy: {
    speed: 0.5,
    aimError: 0.7,
    reactionTime: 0.5,
    // The full metre the sanity test allows: with the squared distribution
    // most reads are still nearly right, and the occasional badly wrong one is
    // what an easy opponent is for.
    misjudge: 1.0,
    popChance: 0.25,
    maxPopTouches: 1,
    tactics: 0.15,
  },
  normal: {
    speed: 0.7,
    aimError: 0.45,
    reactionTime: 0.3,
    misjudge: 0.62,
    popChance: 0.5,
    maxPopTouches: 1,
    tactics: 0.5,
  },
  hard: {
    speed: 0.9,
    aimError: 0.22,
    reactionTime: 0.14,
    misjudge: 0.24,
    popChance: 0.9,
    maxPopTouches: 2,
    tactics: 0.92,
  },
} satisfies Record<string, AIDifficulty>;
export type DifficultyLevel = keyof typeof DIFFICULTIES;

export const DIFFICULTY: AIDifficulty = DIFFICULTIES.normal;

/**
 * How incoming pace strains the read of a drop point.
 *
 * Mirrors `PACE.receive` in touch.ts — the same physical fact seen from the
 * reader's side: a ball that arrives fast gives less time to judge, so the read
 * of a missile is worse than the read of a float, by a factor that grows
 * between these paces.
 */
export const READ = {
  from: 9,
  full: 16,
  /** How many times worse a fully fast ball is read than a slow one. */
  maxMul: 1.9,
};

/** How much of the pace ramp a given incoming pace has grown, 0..1. */
export function paceStrain(incomingPace: number): number {
  const t = (incomingPace - READ.from) / (READ.full - READ.from);
  return Math.max(0, Math.min(1, t));
}

/**
 * One possession's misread of where the ball will drop, in metres.
 *
 * Deterministic, and earned by the shot: the magnitude is the difficulty's
 * `misjudge` grown by the incoming pace (`READ`), the across-error is signed
 * by the direction the ball is travelling — a ball cut across the court is
 * over-read across the court — and the along-error is short and grows with
 * the pace, because fast balls are under-read and drop behind the stand.
 *
 * The point of the determinism is the exploit: the same shot misreads the
 * same way twice, so wide diagonals and deep-then-drop become patterns a
 * player can *learn*, not a lottery they can only fund.
 */
export function readError(
  misjudge: number,
  incomingPace: number,
  /** Sign of the incoming ball's lateral travel; 0 for a straight ball. */
  placementSign: number
): { dz: number; dx: number } {
  const strain = paceStrain(incomingPace);
  const mag = misjudge * (1 + (READ.maxMul - 1) * strain);
  // `|| 0` collapses negative zero: these feed a position both peers of an
  // online match compute, and -0 does not survive the trip the way 0 does.
  const dz = (Math.sign(placementSign) * mag) || 0;
  const dx = (-mag * strain) || 0;
  return { dz, dx };
}

/**
 * The AI's serve placement as a function of the point index.
 *
 * The side alternates and the depth cycles, so the serve is a tell a
 * receiver can learn — and because the clip follows the aim, the tell is
 * visible in the body before the ball leaves.
 */
export function aiServePattern(pointIndex: number): { lat: number; fwd: number } {
  const lat = pointIndex % 2 === 0 ? 1 : -1;
  const fwd = [-0.3, 0.2, 0.5][pointIndex % 3];
  return { lat, fwd };
}

/**
 * AI opponent: predicts the ball's path with the same physics step, runs to an
 * interception point after the bounce on its half, and strikes with some aim
 * error.
 *
 * **It always tries to play the ball.** Every mistake it makes is a mistake of
 * position or timing — it read the bounce wrong, it started late, it could not
 * cover the ground. It never decides not to go.
 *
 * That rule is here because the opposite was, and it was the single worst
 * thing about the opponent. Difficulty used to include a "whiff": a fixed
 * 1.15 m sidestep, always in the same direction, combined with a rule
 * forbidding the AI to touch the ball at all that possession. On easy it fired
 * on nearly a quarter of incoming balls, which on a serve meant a quarter of
 * points opened with the opponent walking away from the ball and watching it
 * land. No player does that, so it read as a bug rather than as a weak
 * opponent — and it could not be tuned out, because the problem was not the
 * amount, it was the kind.
 *
 * A miss now has to be earned by the shot: put the ball somewhere it has to
 * hurry to, and its misread of the drop point plus its reaction delay decide
 * whether it gets there. That also means a ball played straight at a weak
 * opponent comes back, which is correct — beating them should require aiming.
 */
export class AIController {
  private prediction: Prediction | null = null;
  private repredictIn = 0;
  private reaction = 0;
  /**
   * Seconds before the AI starts running to a fresh inbound ball.
   *
   * A human's mistake happens before their feet move: they watch the shot for
   * a beat, and the beat is where a well-placed ball wins. Without this the AI
   * set off on the frame the ball was struck, and no realistic misread or
   * cruise speed could stop it arriving — which is what made it feel like it
   * retrieved everything.
   */
  private runDelay = 0;
  /**
   * How far off this possession's read of the drop point is, in metres.
   *
   * Computed from the shot itself (`readError`): pace strains the read and
   * the ball's own lateral travel signs the across-error. The same shot
   * misreads the same way twice — that is what makes the exploit learnable.
   */
  private misreadZ = 0;
  private misreadX = 0;
  private rolledRead = false;
  /**
   * Which possession of the match this is. The deterministic seed of every
   * patterned choice — intents cycle on it, pops are due on it, the jitter
   * alternates with it — so the variety is real but the tells are learnable.
   */
  private possessionIndex = 0;
  /** Planned control touches for the current AI possession. */
  private plannedPops = 0;
  /** Let the ball drop below waist height before returning (shows low kicks). */
  private wantLow = false;
  /** Small lateral offset at the intercept so receptions aren't always dead-centre. */
  private jitterZ = 0;
  private home = new Vector3(SPAWN.x, GROUND_Y, SPAWN.z);
  /** Last viable run target, retained briefly across a reprediction gap. */
  private chaseSpot: Vector3 | null = null;
  private chaseGrace = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private match: MatchController, private diff: AIDifficulty = DIFFICULTY) {
    // `lastHitter` deliberately survives the between-point state, so it
    // cannot by itself tell us that a new player serve began.  Reset the
    // possession choice from the authoritative launch events instead, so one
    // ball's misread does not follow the AI into every later reception.
    this.unsubscribe = this.match.subscribe((event) => this.onMatchEvent(event));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onMatchEvent(event: MatchEvent): void {
    const playerSentBall =
      (event.type === "serve-committed" && event.side === "player") ||
      (event.type === "touch-committed" && event.side === "player" && event.action === "strike");
    if (playerSentBall) this.resetInboundPlan();
  }

  notifyNewRally(): void {
    this.resetInboundPlan();
  }

  /** Clear state that belongs to one incoming player ball, never a whole match. */
  private resetInboundPlan(): void {
    this.prediction = null;
    this.repredictIn = 0;
    this.rolledRead = false;
    this.misreadZ = 0;
    this.misreadX = 0;
    this.plannedPops = 0;
    this.wantLow = false;
    this.jitterZ = 0;
    this.dropSpot = null;
    this.dropRecalcIn = 0;
    this.chaseSpot = null;
    this.chaseGrace = 0;
    this.reaction = this.diff.reactionTime;
    this.runDelay = this.diff.reactionTime;
  }

  update(dt: number): void {
    const m = this.match;
    const ai = m.chars.ai;
    if (ai.busy) {
      ai.velocity.setAll(0);
      return;
    }

    const incoming = m.lastHitter === "player" || m.strikeableSide === "ai";
    // Character-specific top speed, throttled by the difficulty fraction.
    // Receptions get a modest urgency boost: anticipation should make the
    // normal CPU reach a well-placed ball, rather than turn it into a dummy.
    const cruiseSpeed = ai.def.speed * this.diff.speed;
    const speed = Math.min(ai.def.speed, cruiseSpeed * 1.1);
    if (!incoming) {
      this.prediction = null;
      this.rolledRead = false;
      this.dropSpot = null;
      this.chaseSpot = null;
      this.chaseGrace = 0;
      ai.moveToward(this.home, cruiseSpeed * 0.8, dt);
      return;
    }

    // The beat before the feet move. The ball is watched, not chased: the
    // prediction below still runs, so the run that eventually starts heads for
    // the (mis)read drop point rather than the ball's old shadow.
    if (this.runDelay > 0) {
      this.runDelay -= dt;
      ai.moveToward(this.home, cruiseSpeed * 0.35, dt);
      return;
    }

    this.repredictIn -= dt;
    if (this.repredictIn <= 0 || !this.prediction) {
      this.prediction = predict(m.ball.state, 3);
      this.repredictIn = 0.12;
    }

    if (
      !this.rolledRead &&
      (this.prediction.tableBounce?.side === "ai" || m.strikeableSide === "ai")
    ) this.rollPossessionChoice();

    const intercept = this.pickIntercept(dt);
    if (intercept) {
      // Where it *thinks* the ball is going. The error is what a mistake is
      // made of, so it is applied to the run and not to the decision to run.
      intercept.z += this.misreadZ + this.jitterZ;
      intercept.x += this.misreadX;
      this.chaseSpot = intercept.clone();
      this.chaseGrace = 0.3;
      ai.moveToward(intercept, speed, dt);
    } else if (this.chaseSpot && this.chaseGrace > 0) {
      // A prediction can be empty for one refresh immediately around a table
      // contact.  Keep running to the last sound target instead of visibly
      // abandoning a ball that is still on its way to the AI half.
      this.chaseGrace -= dt;
      ai.moveToward(this.chaseSpot, speed, dt);
    } else {
      ai.moveToward(this.home, cruiseSpeed * 0.8, dt);
    }

    // Touch when allowed, in reach, and past the reaction delay.
    if (m.strikeableSide === "ai") {
      this.reaction -= dt;
      const chest = ai.position.add(new Vector3(0, ai.height * 0.55, 0));
      const d = Vector3.Distance(chest, m.ball.state.pos);
      // No veto here any more: if the ball is in reach, it is played. Whether
      // it got into reach is what the misread and the reaction delay decided.
      if (d <= AI_REACH && this.reaction <= 0) {
        const canBuildAttack =
          this.plannedPops > m.touchCount &&
          (m.touchCount === 0 || m.ball.state.vel.y < 0);
        if (canBuildAttack) {
          // Build the attack with as many legal control touches as this
          // difficulty selected, then finish with a return. A queued touch
          // still counts against neither side until MatchController commits
          // it, so the touchCount comparison naturally waits for the ball to
          // come back down before asking for the next one.
          // The set-up goes away from the player, the same rule the return
          // follows — a plan, not a scatter.
          const away = m.chars.player.position.z >= 0 ? -1 : 1;
          if (m.tryControlTouch("ai", -0.2, away * 0.45)) this.reaction = 0.25;
        } else if (m.touchCount === 0 || m.ball.state.vel.y < 0) {
          // After a pop, wait for the ball to come back down before kicking.
          // On "low" possessions, let a direct return drop toward the feet first.
          const relH = (m.ball.state.pos.y - GROUND_Y) / ai.height;
          // Keep the occasional low return, but only while the ball is still
          // comfortably high and close.  The older condition could wait past
          // the only playable window, which read as the hard CPU giving up.
          const holdForLow =
            this.wantLow &&
            m.touchCount === 0 &&
            relH > 0.72 &&
            m.ball.state.pos.x > TABLE.halfLen &&
            d < AI_REACH * 0.72;
          if (!holdForLow) {
            // The CPU plays a *shot*, not a coordinate: it chose what kind of
            // ball to send when the possession began, and this is where that
            // choice is executed against where the player is actually standing.
            const shot = this.aimShot();
            if (m.tryStrike("ai", shot)) {
              this.notifyNewRally();
            }
          }
        }
      }
    }
  }

  /**
   * The kind of ball the CPU intends to send back.
   *
   * Not a difficulty knob and not noise on a coordinate: each of these asks the
   * player a different question, and the answer is where they were standing
   * before the ball was struck.
   *
   *   - `wide`   — away from the player: adjust sideways, or do not reach it.
   *   - `deep`   — at the back of the half: move back, and lose the attack.
   *   - `short`  — dropped just over the net: come forward, now.
   *   - `flat`   — fast and low: very little time, and the ball stays low.
   *   - `loop`   — high and slow: all the time in the world, and a ball that
   *                has to be taken above the waist.
   *
   * A rally made only of the first four is a rally about running; adding the
   * fifth is what makes it about *reading*, because the same run is right for
   * two of them and wrong for the others.
   */
  private intent: ShotIntent = "wide";

  /**
   * Turn the possession's intent into an actual kick, aimed against the player.
   *
   * The intent decides the shape; the player's own position decides which side
   * of the court it goes to. That is the whole of the anticipation loop — a
   * player who camps in one corner is played into the other, so standing
   * somewhere sensible between shots starts to matter.
   *
   * The `aimError` left in execution is pressure-driven and deterministic:
   * the faster the ball arrived this possession the looser the return, and
   * the sign alternates with the possession count, so the looseness is real
   * but never a die roll. What it does not do any more is choose the shot,
   * which is why the opponent reads as having a plan.
   */
  private aimShot(): StrikeAim {
    const m = this.match;
    const player = m.chars.player;
    // Which half of the court the player is *not* covering. Their own frame:
    // the player attacks -x, so +z is their left.
    const away = player.position.z >= 0 ? -1 : 1;
    // Pressure on the return: a fast incoming ball is answered looser, bounded
    // by this difficulty's aimError; parity signs it, so it alternates rather
    // than wanders.
    const errMag = this.diff.aimError * (1 + (READ.maxMul - 1) * paceStrain(m.incomingPace("ai")));
    const parity = this.possessionIndex % 2 === 0 ? 1 : -1;
    const e1 = parity * errMag;
    const e2 = -parity * errMag;
    const deepness = Math.min(1, Math.max(-1, (Math.abs(player.position.x) - TABLE.halfLen) / 2.4));
    switch (this.intent) {
      case "wide":
        return { target: tableTarget(-1, 0.1 + e1 * 0.4, away * 0.85 + e2 * 0.3), power: 0.6 };
      case "deep":
        // Behind them if they have come forward, at their feet if they have not.
        return { target: tableTarget(-1, 0.85 + e1 * 0.3, e2 * 0.5), power: 0.62 };
      case "short":
        return {
          target: tableTarget(-1, -0.85 + e1 * 0.3, away * 0.4 + e2 * 0.4),
          power: 0.3,
          loft: 1.35,
        };
      case "flat":
        return {
          target: tableTarget(-1, 0.45 + e1 * 0.4, away * 0.5 + e2 * 0.4),
          power: 0.9,
          loft: 0.62,
        };
      case "loop":
        return {
          target: tableTarget(-1, 0.3 + deepness * 0.4 + e1 * 0.4, e2 * 0.6),
          power: 0.4,
          loft: 1.7,
        };
    }
  }

  /**
   * Choose this possession's intent.
   *
   * Weighted by difficulty rather than uniform: an easy opponent mostly returns
   * the ball somewhere legal, while a hard one picks the shot that makes the
   * player move — short after they have been pushed deep, wide after they have
   * been pulled to the middle. It is deliberately a small table. The tactical
   * depth this game needs is in what the *player* can do with the ball, and an
   * opponent only has to be able to ask the questions.
   *
   * Every choice here cycles on the possession count instead of rolling, so
   * the variety is real but the tells are learnable — after two flats comes
   * the loop, and a player who has watched can be ready for it.
   */
  private pickIntent(): ShotIntent {
    const player = this.match.chars.player;
    const deep = Math.abs(player.position.x) > TABLE.halfLen + 1.6;
    const wide = Math.abs(player.position.z) > 1.1;
    const idx = this.possessionIndex;
    const sharp = (idx % 10) / 10 < this.diff.tactics;
    if (!sharp) return idx % 2 === 0 ? "wide" : "deep";
    // Play into the space they have left. Standing deep invites the drop;
    // standing wide invites the ball across them; standing central is answered
    // by pace, because there is no gap to find.
    if (deep) return idx % 2 === 0 ? "short" : "wide";
    if (wide) return idx % 3 !== 0 ? "wide" : "flat";
    return (["flat", "loop", "deep"] as ShotIntent[])[idx % 3];
  }

  /**
   * Decide this possession's read and rhythm, once per inbound ball.
   *
   * Nothing here is rolled: the misread is earned by the shot (`readError`),
   * and the rhythm choices cycle on the possession count, so a player who
   * watches the opponent can learn them.
   */
  private rollPossessionChoice(): void {
    this.rolledRead = true;
    this.possessionIndex += 1;
    this.intent = this.pickIntent();
    // The read is the shot's own doing: its pace strains it and its lateral
    // travel signs it. Less error along the table than across it: judging how
    // far a ball is coming is easier than judging where it will land.
    const read = readError(
      this.diff.misjudge,
      this.match.incomingPace("ai"),
      Math.sign(this.match.ball.state.vel.z)
    );
    this.misreadZ = read.dz;
    this.misreadX = read.dx * 0.6;
    // Building is due on a rhythm set by the difficulty — and only when the
    // incoming ball is soft enough to set up at all: pace denies the build,
    // which is what makes a fast ball worth hitting.
    const maxPops = Math.max(0, Math.min(MAX_TOUCHES - 1, Math.floor(this.diff.maxPopTouches)));
    const period = Math.max(1, Math.round(1 / Math.max(0.01, this.diff.popChance)));
    const buildDue = this.possessionIndex % period === 0;
    const softEnough = this.match.incomingPace("ai") < 12;
    this.plannedPops = buildDue && softEnough ? maxPops : 0;
    this.wantLow = this.possessionIndex % 7 === 4;
    // Enough texture to keep the AI from parking on a perfect rail, but not
    // enough to lose it a reception it should make. Alternating rather than
    // rolled, so it does not read as the same stand every time nor wander.
    this.jitterZ = (this.possessionIndex % 2 === 0 ? 1 : -1) * 0.14;
    this.reaction = this.diff.reactionTime;
  }

  /** Cached drop point while in possession (recomputed on a short cadence). */
  private dropSpot: Vector3 | null = null;
  private dropRecalcIn = 0;

  /** First predicted point after the bounce where the ball is at playable height off the table. */
  private pickIntercept(dt: number): Vector3 | null {
    const m = this.match;
    // Ball already in possession (it bounced on our half, or we popped it up):
    // run to where it will DROP into playing height, not to its live shadow —
    // chasing the shadow sprinted the AI at the net right after a hard bounce,
    // then back-pedalled it when the ball flew overhead (reads as aimless).
    // The post-bounce reprediction has no further table bounce, so the normal
    // intercept below would vanish and walk the AI home mid-receive.
    if (m.strikeableSide === "ai") {
      this.dropRecalcIn -= dt;
      if (this.dropRecalcIn <= 0 || !this.dropSpot) {
        this.dropRecalcIn = 0.12;
        this.dropSpot = null;
        const flight = sampleFlight(m.ball.state, 1.6);
        this.dropSpot = this.pickDescendingDrop(flight, m.ball.state.pos.y);
      }
      if (this.dropSpot) return this.dropSpot.clone();
      // No drop point (ball hovering in reach right now): stand under the ball.
      const b = m.ball.state.pos;
      return this.standAt(b.x, b.z);
    }
    const p = this.prediction;
    if (!p || !p.tableBounce || p.tableBounce.side !== "ai") return null;
    // Plan the *descending* reception before the bounce. The old code chose
    // the first low sample immediately after the bounce, often while the ball
    // was still rising; AI would sprint toward the table then reverse itself.
    const afterBounceY = p.tableBounce.pos.y;
    const planned = this.pickDescendingDrop(p.samples, afterBounceY);
    if (planned) return planned;
    // Fallback: hover just behind the predicted bounce.
    const b = p.tableBounce.pos;
    return this.standAt(b.x + 1.2, b.z);
  }

  /**
   * Select the descending, chest-height part of a flight rather than its
   * rising shadow. This is used both while the ball approaches the table and
   * after the AI owns the bounce, so the run remains continuous across it.
   */
  private pickDescendingDrop(
    samples: Array<{ pos: Vector3; grounded?: boolean }>,
    initialY: number
  ): Vector3 | null {
    const ai = this.match.chars.ai;
    const idealHeight = ai.height * 0.55;
    let prevY = initialY;
    let best: { pos: Vector3; cost: number } | null = null;
    for (const s of samples) {
      if (s.grounded) break;
      const h = s.pos.y - GROUND_Y;
      const descending = s.pos.y <= prevY + 0.002;
      prevY = s.pos.y;
      // A ball still over the table has not been received yet — it is about
      // to bounce. The reception is the part of the flight past it.
      const offTable = !onTableFootprint(s.pos.x, s.pos.z);
      if (!descending || !offTable || s.pos.x <= 0 || h < 0.28 || h > 1.22) continue;
      // Prefer a natural chest/foot reception height. A tiny forward bias
      // keeps the target from jumping to a much later, lower sample.
      const cost = Math.abs(h - idealHeight);
      if (!best || cost < best.cost) best = { pos: s.pos, cost };
    }
    if (!best) return null;
    return this.standAt(best.pos.x, best.pos.z);
  }

  /**
   * A spot the AI can actually stand on: inside its half, and not in the table.
   *
   * The half now runs all the way to the middle line, so every run target has
   * to be cleared of the table rather than simply held behind its end.
   */
  private standAt(x: number, z: number): Vector3 {
    const clear = clearTable(
      Math.max(COURT.minX, Math.min(COURT.maxX, x)),
      Math.max(-COURT.maxZ, Math.min(COURT.maxZ, z))
    );
    return new Vector3(clear.x, GROUND_Y, clear.z);
  }
}
