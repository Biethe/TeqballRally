import type { AIDifficulty } from "./ai";
import type { InputState } from "./input";
import type { MatchController, MatchEvent } from "./match";
import type { PracticePanelState, TrainingPauseState } from "./ui";

/** A forgiving partner that keeps the lesson moving without handing out rallies. */
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

type DrillStep = "serve" | "position" | "return" | "pop" | "finish" | "free";

interface DrillInfo {
  progress: string;
  title: string;
  action: string;
}

const STEPS: Record<DrillStep, DrillInfo> = {
  serve: { progress: "1 / 5", title: "SERVE", action: "Aim, then STRIKE." },
  position: { progress: "2 / 5", title: "MOVE", action: "Move to the X." },
  return: { progress: "3 / 5", title: "RETURN", action: "Wait for it, then kick." },
  pop: { progress: "4 / 5", title: "MAKE A RECEPTION", action: "Make a reception, then get ready." },
  finish: { progress: "5 / 5", title: "FINISH", action: "Aim, then kick it in." },
  free: { progress: "FREE", title: "FREE PLAY", action: "Play your way." },
};

/**
 * A deliberately sparse, event-driven coach. It stops only when there is one
 * clear next action, then gets out of the player's way again.
 */
export class PracticeCoach {
  private step: DrillStep = "serve";
  private paused = false;
  private resumeGuardFrames = 0;
  private moveTime = 0;
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

  start(): void {
    this.refreshPanel();
  }

  reset(): void {
    this.match.setTutorialFrozen(false);
    this.paused = false;
    this.resumeGuardFrames = 0;
    this.step = "serve";
    this.moveTime = 0;
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

    // After the player has actually moved, stop once more and make the return
    // action explicit before the same rally continues.
    if (
      this.step === "position" &&
      this.match.state === "rally" &&
      this.match.strikeableSide === "player"
    ) {
      if (Math.hypot(input.moveX, input.moveZ) > 0.25) this.moveTime += dt;
      if (this.moveTime >= 0.18) {
        this.step = "return";
        this.pause(this.returnPrompt());
      }
    }

    this.refreshPanel();
  }

  private onMatchEvent(event: MatchEvent): void {
    switch (event.type) {
      case "serve-ready":
        if (event.side === "player" && this.step === "serve") this.pause(this.servePrompt());
        break;

      case "serve-committed":
        if (event.side === "player" && this.step === "serve") this.step = "position";
        break;

      case "possession-start":
        if (event.side !== "player") break;
        this.moveTime = 0;
        if (this.step === "position") this.pause(this.positionPrompt());
        else if (this.step === "return") this.pause(this.returnPrompt());
        else if (this.step === "pop") this.pause(this.popPrompt());
        break;

      case "touch-committed":
        if (event.side !== "player") break;
        if (event.action === "pop") {
          if (this.step === "pop") {
            this.step = "finish";
            this.pause(this.finishPrompt());
          }
          break;
        }

        if (this.step === "position" || this.step === "return") {
          this.step = "pop";
        } else if (this.step === "finish" && event.afterSetup) {
          this.step = "free";
        }
        break;

      case "point-awarded":
        // A finish only makes sense after a setup. If the setup rally ends,
        // simply offer a reception again on the next player-side ball.
        if (this.step === "finish") this.step = "pop";
        break;
    }

    this.refreshPanel();
  }

  private pause(prompt: TrainingPauseState): void {
    if (this.paused) return;
    this.paused = true;
    this.resumeGuardFrames = 2;
    this.match.setTutorialFrozen(true);
    this.ui.practicePanel(null);
    this.ui.showTrainingPause(prompt, () => this.resume());
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeGuardFrames = 0;
    this.match.setTutorialFrozen(false);
    this.ui.hideTrainingPause();
    this.refreshPanel();
  }

  private servePrompt(): TrainingPauseState {
    return this.prompt(
      "serve",
      this.control("WASD + SPACE", "LEFT STICK + A", "JOYSTICK + STRIKE", "SWIPE TO SERVE")
    );
  }

  private positionPrompt(): TrainingPauseState {
    return this.prompt("position", this.control("WASD", "LEFT STICK", "JOYSTICK", "TAP THE COURT"));
  }

  private returnPrompt(): TrainingPauseState {
    return this.prompt("return", this.control("HOLD SPACE", "HOLD A", "HOLD STRIKE", "SWIPE"));
  }

  private popPrompt(): TrainingPauseState {
    return this.prompt("pop", this.control("K", "B", "RECEPTION", "TAP WHERE TO PLAY IT"));
  }

  private finishPrompt(): TrainingPauseState {
    return this.prompt("finish", this.control("HOLD SPACE", "HOLD A", "HOLD STRIKE", "SWIPE"));
  }

  private prompt(step: Exclude<DrillStep, "free">, control: string): TrainingPauseState {
    const info = STEPS[step];
    return {
      progress: info.progress,
      title: info.title,
      action: info.action,
      control,
      resume: this.continueLabel(),
    };
  }

  private control(keyboard: string, gamepad: string, touch: string, portrait = touch): string {
    if (this.hasGamepad()) return gamepad;
    if (this.isPortrait()) return portrait;
    if (this.isTouch()) return touch;
    return keyboard;
  }

  private continueLabel(): string {
    if (this.hasGamepad()) return "A TO CONTINUE";
    if (this.isTouch()) return "TAP TO CONTINUE";
    return "SPACE TO CONTINUE";
  }

  private refreshPanel(): void {
    if (this.paused) {
      this.ui.practicePanel(null);
      return;
    }
    const info = STEPS[this.step];
    this.ui.practicePanel({
      title: `PRACTICE · ${info.progress}`,
      goal: info.action,
    });
  }
}
