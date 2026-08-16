import type { AIDifficulty } from "./ai";
import type { InputState } from "./input";
import type { MatchController, MatchEvent } from "./match";
import type { PracticePanelState, TrainingPauseState } from "./ui";
import { canSmashFrom } from "./aim";
import { t, type StringKey } from "./i18n";

/**
 * Practice.
 *
 * Not a match with the scoring switched off — a lesson. There is no score, no
 * set, no serve rotation and no result screen, because every one of those
 * turns "am I learning this" into "am I winning", and a player who is losing a
 * tutorial stops listening to it.
 *
 * The shape is two chapters, in the order they matter:
 *
 *   DEFENDING   read where the ball is going, and be there before it is.
 *   ATTACKING   take the pace away from them — hit it from close, or hit it
 *               early, so they have less time than you did.
 *
 * The opponent is the coach. Everything said in a lesson is said by the player
 * on the other side of the table, which is both cheaper than inventing a
 * narrator and truer to how anybody actually learns this game.
 *
 * The world freezes while the coach talks. That is the whole reason the
 * lessons can be short: nothing is moving, so nothing is missed, and the
 * instruction can be one sentence instead of a paragraph racing a live ball.
 */

/**
 * The coach.
 *
 * Deliberately not weak. A partner that misses the ball teaches nothing and
 * makes the lesson wait, so this one reads the ball perfectly (`misjudge: 0`)
 * and simply plays gently.
 */
export const PRACTICE_DIFFICULTY: AIDifficulty = {
  speed: 0.5,
  aimError: 0.28,
  reactionTime: 0.12,
  misjudge: 0,
  popChance: 0.18,
  maxPopTouches: 1,
};

interface PracticeUI {
  practicePanel(state: PracticePanelState | null): void;
  showTrainingPause(state: TrainingPauseState, onResume: () => void): void;
  hideTrainingPause(): void;
}

/**
 * The lesson, in order.
 *
 * `watch` and `chase` are the defending half — anticipation, then covering the
 * ground. `stepIn`, `strike` and `early` are the attacking half, and they are
 * deliberately the three things that actually win a point in this game: get
 * close enough to hit it flat, hit it hard, take it before it drops.
 */
const STEPS = [
  "serve",
  "watch",
  "chase",
  "stepIn",
  "strike",
  "early",
  "free",
] as const;
export type DrillStep = (typeof STEPS)[number];

/** Which chapter a step belongs to, for the heading above it. */
const CHAPTER: Record<DrillStep, "defend" | "attack" | null> = {
  serve: null,
  watch: "defend",
  chase: "defend",
  stepIn: "attack",
  strike: "attack",
  early: "attack",
  free: null,
};

/** Steps that stop the world and say something. `free` never does. */
const COACHED: readonly DrillStep[] = STEPS.filter((s) => s !== "free");

export class PracticeCoach {
  private step: DrillStep = "serve";
  private paused = false;
  private resumeGuardFrames = 0;
  private moveTime = 0;
  private struckFromClose = false;
  /**
   * Steps whose card has already been shown.
   *
   * Each step stops the world exactly once — the moment it becomes relevant —
   * and never again. The first version paused on *every* possession until the
   * step was passed, which turned a missed strike into the same card three
   * rallies running: the lesson kept interrupting the practising. After the
   * introduction the instruction lives on in the corner panel, where it can be
   * read without the world stopping for it.
   */
  private introduced = new Set<DrillStep>();
  private unsubscribe: () => void;

  constructor(
    private match: MatchController,
    private ui: PracticeUI,
    private hasGamepad: () => boolean,
    private isTouch: () => boolean,
    /** Portrait play is gestures, not buttons, so its prompts differ again. */
    private isPortrait: () => boolean = () => false
  ) {
    this.unsubscribe = this.match.subscribe((event) => this.onMatchEvent(event));
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** True once the lesson is over and the player is just knocking up. */
  get isFinished(): boolean {
    return this.step === "free";
  }

  start(): void {
    this.refreshPanel();
  }

  reset(): void {
    this.match.setTutorialFrozen(false);
    this.paused = false;
    this.resumeGuardFrames = 0;
    this.step = "serve";
    this.moveTime = 0;
    this.struckFromClose = false;
    this.introduced.clear();
    this.ui.hideTrainingPause();
    this.refreshPanel();
  }

  dispose(): void {
    this.unsubscribe();
    this.match.setTutorialFrozen(false);
    this.ui.hideTrainingPause();
    this.ui.practicePanel(null);
  }

  /** Consume the continue press so it never becomes an accidental kick. */
  updatePaused(input: InputState): void {
    if (!this.paused) return;
    if (this.resumeGuardFrames > 0) {
      this.resumeGuardFrames--;
      return;
    }
    if (input.confirmPressed || input.strikePressed || input.popPressed) this.resume();
  }

  update(dt: number, input: InputState): void {
    if (this.paused) return;

    // Defending: once they have actually covered some ground, the lesson has
    // been done rather than merely described.
    if (this.step === "chase" && this.match.state === "rally") {
      if (Math.hypot(input.moveX, input.moveZ) > 0.25) this.moveTime += dt;
      if (this.moveTime >= 0.35) this.advance();
    }

    // Attacking: stepping into smash range is the lesson, so it completes the
    // moment they are standing there rather than when they hit something.
    if (this.step === "stepIn" && canSmashFrom(this.match.chars.player.position.x)) {
      this.advance();
    }

    this.refreshPanel();
  }

  private onMatchEvent(event: MatchEvent): void {
    switch (event.type) {
      case "serve-ready":
        if (event.side === "player" && this.step === "serve") this.pause();
        break;

      case "serve-committed":
        if (event.side === "player" && this.step === "serve") this.advance();
        break;

      case "possession-start":
        if (event.side !== "player") break;
        this.moveTime = 0;
        // Every coached step announces itself the moment the ball becomes
        // this player's problem, which is when the advice is worth having.
        if (this.step !== "free" && this.step !== "serve") this.pause();
        break;

      case "touch-committed": {
        if (event.side !== "player") break;
        // Reading the ball is done the moment they play one. Any touch counts,
        // including a pop: a step about anticipation must not also quietly
        // demand a clean strike, and this one had no way out at all until it
        // did — the lesson sat on DEFENDING 2/6 forever.
        if (this.step === "watch") {
          this.advance();
          break;
        }
        if (event.action !== "strike") break;
        const close = canSmashFrom(this.match.chars.player.position.x);
        if (this.step === "strike" && close) {
          this.struckFromClose = true;
          this.advance();
        } else if (this.step === "early") {
          this.advance();
        }
        break;
      }
    }

    this.refreshPanel();
  }

  private advance(): void {
    const at = STEPS.indexOf(this.step);
    this.step = STEPS[Math.min(STEPS.length - 1, at + 1)];
    this.moveTime = 0;
  }

  private pause(): void {
    if (this.paused || this.step === "free") return;
    // Once per step. A card the player has already read is not worth stopping
    // a live ball for; the corner panel keeps saying it.
    if (this.introduced.has(this.step)) return;
    this.introduced.add(this.step);
    this.paused = true;
    this.resumeGuardFrames = 2;
    this.match.setTutorialFrozen(true);
    this.ui.practicePanel(null);
    this.ui.showTrainingPause(this.prompt(), () => this.resume());
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeGuardFrames = 0;
    this.match.setTutorialFrozen(false);
    this.refreshPanel();
    this.ui.hideTrainingPause();
  }

  private prompt(): TrainingPauseState {
    const step = this.step;
    const chapter = CHAPTER[step];
    const done = COACHED.indexOf(step) + 1;
    return {
      progress: chapter
        ? `${t(`practice.chapter.${chapter}` as StringKey)} · ${done} / ${COACHED.length}`
        : `${done} / ${COACHED.length}`,
      title: t(`practice.${step}.title` as StringKey),
      action: t(`practice.${step}.action` as StringKey),
      control: this.controlFor(step),
      resume: this.continueLabel(),
    };
  }

  /**
   * The one input this step needs, in the words of the device in their hands.
   *
   * Practice gives no assistance — the automatic first reception is off for
   * the whole lesson — so these are the real controls, not a simplified set
   * that stops working the moment the tutorial ends.
   */
  private controlFor(step: DrillStep): string {
    switch (step) {
      case "serve":
        return this.control("WASD + SPACE", "LEFT STICK + A", "JOYSTICK + STRIKE", "SWIPE TO SERVE");
      case "watch":
      case "chase":
      case "stepIn":
        return this.control("WASD", "LEFT STICK", "JOYSTICK", "TAP THE COURT");
      default:
        return this.control("HOLD SPACE", "HOLD A", "HOLD STRIKE", "SWIPE FAST");
    }
  }

  private control(keyboard: string, gamepad: string, touch: string, portrait = touch): string {
    if (this.hasGamepad()) return gamepad;
    if (this.isPortrait()) return portrait;
    if (this.isTouch()) return touch;
    return keyboard;
  }

  private continueLabel(): string {
    if (this.hasGamepad()) return t("practice.continue.pad");
    if (this.isTouch()) return t("practice.continue.touch");
    return t("practice.continue.key");
  }

  private refreshPanel(): void {
    if (this.paused) {
      this.ui.practicePanel(null);
      return;
    }
    const step = this.step;
    if (step === "free") {
      this.ui.practicePanel({ title: t("practice.free.title"), goal: t("practice.free.action") });
      return;
    }
    const chapter = CHAPTER[step];
    const done = COACHED.indexOf(step) + 1;
    this.ui.practicePanel({
      title: chapter
        ? `${t(`practice.chapter.${chapter}` as StringKey)} · ${done} / ${COACHED.length}`
        : `${t("practice.title")} · ${done} / ${COACHED.length}`,
      goal: t(`practice.${step}.action` as StringKey),
      // The card only shows once, so the input it named has to survive here —
      // the panel is now the only place a stuck player can re-read it.
      control: this.controlFor(step),
    });
  }

  /** Whether the player ever managed the thing the attacking half is for. */
  get struckFromMiddle(): boolean {
    return this.struckFromClose;
  }
}
