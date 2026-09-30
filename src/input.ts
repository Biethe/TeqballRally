import type { CameraMode } from "./config";
import { GestureScheme } from "./gestures";
import {
  kickDown,
  kickHeldFor,
  kickTick,
  kickUp,
  type KickCommit,
  type KickSequence,
} from "./kickinput";

/**
 * Unified input: keyboard (WASD/arrows + space), touch and gamepad (left stick
 * + cross/A via the Gamepad API, which also covers the PS5 browser /
 * DualSense).
 *
 * Touch has two layouts, chosen by which way the phone is held. Landscape
 * keeps the visible move/aim stick and its action buttons. Portrait has no
 * room for either, so the whole screen becomes the controller instead: tap to
 * place the player or aim a reception, swipe to kick. Both feed this same
 * InputState — the match never learns which one is in use.
 */
export interface InputState {
  /** Movement in court space: x toward the net, z lateral. Range [-1, 1]. */
  moveX: number;
  moveZ: number;
  /**
   * True only on the frame a kick was *committed*.
   *
   * Not simply the release edge any more: in landscape a kick is a sequence of
   * taps whose count picks the speed, so the commit is the release of a held
   * press, the release of the third tap, or the moment the tap window closes
   * on a shorter sequence. See `kickinput.ts`.
   */
  strikePressed: boolean;
  /** True while the strike control is down: the player is aiming. */
  strikeHeld: boolean;
  /**
   * Power the input scheme decided for itself, 0..1, valid on the frame of a
   * press. Portrait reads it from the speed of the swipe, landscape from how
   * many times the button was tapped.
   */
  strikePower: number;
  /**
   * Taps the committed kick was made of, 1..3. Absent when the press did not
   * come from the tap scheme at all — a gesture, or a synthesised press.
   */
  strikeTaps?: number;
  /**
   * Arc the committed kick asked for; 1 is neutral and leaves the shape to the
   * power and the contact. Absent means the same as 1.
   */
  strikeLoft?: number;
  /**
   * Taps banked in the sequence still in progress, 0 when none is.
   *
   * A level rather than an edge, and separate from `strikeTaps` because the
   * HUD has to show the tier being built *before* it commits — a bar that only
   * appeared after the kick would be telling the player what they already saw.
   */
  strikeTapsSoFar?: number;
  /** How long the press currently down has lasted, for showing the arc live. */
  strikeHoldSoFar?: number;
  /** True only on the frame the reception (control-touch) control was pressed. */
  popPressed: boolean;
  /** True only on the frame any "confirm" control was pressed (strike, enter, tap). */
  confirmPressed: boolean;
  /**
   * The axes on this frame are a tap's carry vector rather than a stick.
   *
   * Never produced by the input layer — a local match reads a tap through
   * `MatchController.tapAt`, which has the court in front of it. This exists
   * for the online guest, whose taps have to cross a wire that only carries
   * axes: `resolveFollowerInput` sets it so the host knows what it is reading.
   */
  tapAim?: boolean;
}

/**
 * An InputState whose edge flags persist until a simulation step reads them.
 *
 * The display and the simulation run at different rates: a frame above the
 * simulation rate may step the match zero times, and one below it may step
 * several. Sampling `poll()` straight into a step would drop presses in the
 * first case and replay one press twice in the second, so presses are latched
 * here and consumed exactly once.
 */
export interface LatchedInput {
  moveX: number;
  moveZ: number;
  strikePressed: boolean;
  strikeHeld: boolean;
  strikePower: number;
  strikeTaps?: number;
  strikeLoft?: number;
  strikeTapsSoFar?: number;
  strikeHoldSoFar?: number;
  popPressed: boolean;
  confirmPressed: boolean;
}

export function newLatch(): LatchedInput {
  return {
    moveX: 0,
    moveZ: 0,
    strikePressed: false,
    strikeHeld: false,
    strikePower: 0,
    strikeTaps: undefined,
    strikeLoft: undefined,
    strikeTapsSoFar: 0,
    strikeHoldSoFar: 0,
    popPressed: false,
    confirmPressed: false,
  };
}

/**
 * Fold a freshly polled frame into the latch. Axes track the newest sample —
 * a stick's current position is what matters — while presses accumulate.
 */
export function latchInput(latched: LatchedInput, sampled: InputState): void {
  latched.moveX = sampled.moveX;
  latched.moveZ = sampled.moveZ;
  // Held is a level, like the axes: what matters is whether it is down now.
  latched.strikeHeld = sampled.strikeHeld;
  // The sequence in progress is a level too — it is what the HUD is currently
  // showing, not something a press spends.
  latched.strikeTapsSoFar = sampled.strikeTapsSoFar;
  latched.strikeHoldSoFar = sampled.strikeHoldSoFar;
  // A power belongs to the press it arrived with, so it is kept only when
  // there is a press waiting to carry it.
  if (sampled.strikePressed) {
    latched.strikePower = sampled.strikePower;
    latched.strikeTaps = sampled.strikeTaps;
    latched.strikeLoft = sampled.strikeLoft;
  }
  latched.strikePressed ||= sampled.strikePressed;
  latched.popPressed ||= sampled.popPressed;
  latched.confirmPressed ||= sampled.confirmPressed;
}

/** Take the latched state for one simulation step, clearing the edges it consumes. */
export function consumeInput(latched: LatchedInput): InputState {
  const state: InputState = { ...latched };
  latched.strikePressed = false;
  latched.strikePower = 0;
  latched.strikeTaps = undefined;
  latched.strikeLoft = undefined;
  latched.popPressed = false;
  latched.confirmPressed = false;
  return state;
}

/**
 * Turn a screen-space stick into a world-space direction, for the view in use.
 *
 * Screen directions mean different world directions in different views, and
 * treating them as fixed is what made the side view feel like the world had
 * been rotated ninety degrees under the controls.
 *
 * COURT: the lens is behind the player at -x looking toward +x, so screen up
 * is +x (toward the net) and screen right is -z.
 *
 * SIDE: the lens is off the sideline looking across, so screen up is +z (away
 * from the camera) and screen right is +x (toward the net). The same tilt of a
 * thumb then means what it looks like it means in both.
 *
 * Pure and exported so the mapping can be held to in a test: it is four signs,
 * and getting one of them wrong is a control scheme nobody can play.
 */
export function moveForView(
  sx: number,
  sy: number,
  cameraMode: CameraMode
): { moveX: number; moveZ: number } {
  if (cameraMode === "side") return { moveX: sx, moveZ: -sy };
  return { moveX: -sy, moveZ: -sx };
}

/**
 * Whether this machine should get the on-screen stick and buttons.
 *
 * Chrome puts `ontouchstart` on `window` even on a desktop with no
 * touchscreen, which is how the hosted web build drew the Android overlay
 * over a keyboard and a USB pad. `maxTouchPoints` alone is not enough either:
 * a laptop with a touch panel but a mouse as the primary pointer is still a
 * keyboard/pad machine. Coarse pointer plus at least one touch point is a
 * phone or tablet.
 */
export function looksLikeTouchDevice(hints: {
  maxTouchPoints: number;
  coarsePointer: boolean;
}): boolean {
  return hints.maxTouchPoints > 0 && hints.coarsePointer;
}

export class Input {
  private keys = new Set<string>();
  private strikeQueued = false;
  private popQueued = false;
  private confirmQueued = false;
  /** Global view-cycle action: C on keyboard, Y / Triangle on a gamepad. */
  private cameraQueued = false;
  private prevCameraCycle = false;
  private pauseQueued = false;
  private prevPauseGamepad = false;
  /**
   * Whether each seat's strike control is down (0 = P1, 1 = P2).
   *
   * A kick is committed on release rather than on press: how long the control
   * was held is what decides how hard the ball is struck, and that is not
   * known until it comes back up.
   */
  private strikeDown = false;
  /** The landscape press sequence in progress; see `kickinput.ts`. */
  private kickSeq: KickSequence | null = null;
  /** What the last committed sequence asked for, consumed by the next poll. */
  private kickTaps: number | undefined;
  private kickLoftValue: number | undefined;
  /** Pad level, so a pad release is only reported once. */
  private padStrikeWasDown = false;
  private prevGamepadPop = false;
  /** Neutral axis-9 values for non-standard HID hat switches, by pad index. */
  private hatIdleByPad = new Map<number, number>();
  /** Keyboard cancel is queued because a quick Escape tap can occur between render frames. */
  private menuBackQueued = false;
  /** Set once a gamepadconnected event fires (some browsers hide pads until then). */
  private padSeen = false;
  private prevNav = { up: false, down: false, left: false, right: false, confirm: false };

  // Touch joystick state
  private joyActive = false;
  private joyId = -1;
  private joyOrigin = { x: 0, y: 0 };
  private joyVec = { x: 0, y: 0 };

  readonly isTouch: boolean;
  /**
   * Last value from `setTouchControlsEnabled`. The overlay only shows when
   * this is true *and* no physical pad is live — a Bluetooth pad on a phone
   * is the real controller, not the Android stick drawn on top of it.
   */
  private touchHudWanted = false;
  private joyBase: HTMLDivElement | null = null;
  private joyKnob: HTMLDivElement | null = null;
  private touchLayer: HTMLDivElement | null = null;
  private strikeBtn: HTMLButtonElement | null = null;
  private popBtn: HTMLButtonElement | null = null;
  private touchActionPointers = new Map<HTMLButtonElement, Set<number>>();
  private readonly joyRadius = 54;

  // Portrait touch play.
  private portrait = false;
  private readonly gestures = new GestureScheme();
  /**
   * Aim a gesture left behind, in screen space, and when it goes stale.
   *
   * A swipe is one instant, but the press it fires may not be simulated on the
   * same frame — and once it is, the match retries it for as long as its press
   * buffer allows. The direction has to outlive the finger for both to aim
   * where the player pointed.
   */
  private gestureAim: { sx: number; sy: number; until: number } | null = null;
  private tapQueued: { x: number; y: number } | null = null;
  /** Power a swipe asked for, waiting to travel with its queued press. */
  private gesturePower = 0;
  /** Seconds a gesture keeps aiming after the finger has gone. */
  private static readonly AIM_HOLD = 0.5;

  constructor(uiRoot: HTMLElement) {
    this.isTouch = looksLikeTouchDevice({
      maxTouchPoints: navigator.maxTouchPoints,
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    });

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "Escape") {
        this.menuBackQueued = true;
        this.pauseQueued = true;
        return;
      }
      if (e.code === "Backspace") {
        this.menuBackQueued = true;
        return;
      }
      if (e.code === "Pause") {
        this.pauseQueued = true;
        e.preventDefault();
        return;
      }
      if (e.code === "KeyC") {
        this.cameraQueued = true;
        e.preventDefault();
        return;
      }
      // Every strike/reception key belongs to the one player.
      if (e.code === "Space" || e.code === "Enter" || e.code === "KeyJ") {
        // Repeat events keep firing while a key is held; `setStrikeDown` ignores
        // a state it is already in, so the sequence sees one press.
        this.setStrikeDown(true, e.timeStamp / 1000);
        e.preventDefault();
      }
      if (e.code === "KeyK") {
        this.popQueued = true;
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "Space" || e.code === "Enter" || e.code === "KeyJ")
        this.setStrikeDown(false, e.timeStamp / 1000);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.clearStrikeHold();
      this.resetTouchState();
    });

    window.addEventListener("gamepadconnected", (e) => {
      this.padSeen = true;
      this.syncTouchLayer();
      console.log("[gamepad] connected:", e.gamepad.id);
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      this.hatIdleByPad.delete(e.gamepad.index);
      this.syncTouchLayer();
      console.log("[gamepad] disconnected:", e.gamepad.id);
    });

    if (this.isTouch) this.buildTouchControls(uiRoot);
    this.refreshLayout();
    window.addEventListener("resize", () => this.refreshLayout());
    window.addEventListener("orientationchange", () => this.refreshLayout());
  }

  /** True while the touch controls are in their portrait, gesture-only layout. */
  get isPortrait(): boolean {
    return this.portrait;
  }

  /**
   * Re-read the screen shape and switch touch layouts if it changed. Safe to
   * call at any time; turning the phone mid-rally swaps the scheme without
   * interrupting the point.
   */
  refreshLayout(): void {
    const portrait = window.innerHeight > window.innerWidth;
    this.gestures.setViewport(window.innerWidth, window.innerHeight);
    if (portrait === this.portrait) return;
    this.portrait = portrait;
    this.gestures.clear();
    this.gestureAim = null;
    this.tapQueued = null;
    this.clearJoystick();
    this.touchLayer?.classList.toggle("portrait", portrait);
  }

  /**
   * Track a strike control's level for one seat, queueing the kick when it is
   * let go. Confirm still fires on the way down, so menus and the serve toss
   * answer a press immediately.
   */
  private setStrikeDown(down: boolean, t: number = performance.now() / 1000): void {
    if (down === this.strikeDown) return;
    this.strikeDown = down;
    if (down) {
      this.kickSeq = kickDown(this.kickSeq, t);
      // Still the down edge, so a menu or the intro answers a press at once and
      // never waits on a tap window meant for kicks.
      this.confirmQueued = true;
      return;
    }
    const { seq, commit } = kickUp(this.kickSeq, t);
    this.kickSeq = seq;
    if (commit) this.commitKick(commit);
  }

  /** Publish a finished sequence for the next poll to hand to the match. */
  private commitKick(commit: KickCommit): void {
    this.strikeQueued = true;
    this.gesturePower = commit.power;
    this.kickTaps = commit.taps;
    this.kickLoftValue = commit.loft;
  }

  /** Drop a held kick without firing it (focus loss, a hidden touch layer). */
  private clearStrikeHold(): void {
    this.strikeDown = false;
    // Deliberately dropped rather than committed: a sequence interrupted by the
    // window going away was never finished, and firing it would be a kick the
    // player did not ask for.
    this.kickSeq = null;
  }

  /** Hide the touch layer while a screen needs direct canvas interaction (model viewer). */
  setTouchControlsEnabled(enabled: boolean): void {
    this.touchHudWanted = enabled;
    this.syncTouchLayer();
  }

  /**
   * Show the on-screen stick only on a real touch device, only while the HUD
   * asked for it, and only while no physical pad is plugged in. Chrome hides
   * pads until a button is pressed, so this is also called from `poll` — the
   * connect event is not the only way a pad appears.
   */
  private syncTouchLayer(): void {
    if (!this.touchLayer) return;
    const show = this.isTouch && this.touchHudWanted && Input.connectedPads().length === 0;
    const showing = this.touchLayer.style.display !== "none";
    if (show === showing) return;
    if (!show) this.resetTouchState();
    this.touchLayer.style.display = show ? "" : "none";
    this.touchLayer.setAttribute("aria-hidden", String(!show));
  }

  private buildTouchControls(uiRoot: HTMLElement): void {
    const zone = document.createElement("div");
    zone.id = "touch-layer";
    zone.setAttribute("aria-hidden", "true");
    zone.style.display = "none";
    this.touchLayer = zone;

    // Portrait has no room for a stick and two buttons, so it plays by
    // gesture instead. This legend is the only thing on screen that says so —
    // it never takes pointer events, since every one of them is a control.
    const portraitHints = document.createElement("div");
    portraitHints.id = "touch-portrait-hints";
    portraitHints.setAttribute("role", "status");
    portraitHints.innerHTML =
      '<span><b>TAP</b>move · place</span><span><b>SWIPE</b>kick · up lofts, down drives</span>';
    zone.appendChild(portraitHints);

    this.joyBase = document.createElement("div");
    this.joyBase.className = "joy-base";
    const joyLabel = document.createElement("span");
    joyLabel.className = "joy-label";
    joyLabel.innerHTML = "MOVE<small>AIM</small>";
    this.joyKnob = document.createElement("div");
    this.joyKnob.className = "joy-knob";
    this.joyBase.append(joyLabel, this.joyKnob);
    zone.appendChild(this.joyBase);

    this.strikeBtn = this.makeTouchAction(
      "strike-btn",
      "STRIKE",
      "HOLD TO AIM",
      "Hold to aim and charge the kick, release to strike",
      (down, t) => this.setStrikeDown(down, t)
    );
    this.popBtn = this.makeTouchAction(
      "pop-btn",
      "RECEPTION",
      "SET UP",
      "Make a reception or set up the ball",
      (down) => {
        if (down) this.popQueued = true;
      }
    );
    zone.append(this.strikeBtn, this.popBtn);

    const joyCenter = (): { x: number; y: number; hitRadius: number } | null => {
      const rect = this.joyBase?.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        // The visible ring is the anchor; its generous edge keeps it easy to
        // acquire without turning ordinary left-side taps into movement.
        hitRadius: Math.max(rect.width * 0.78, 78),
      };
    };

    const moveJoy = (e: PointerEvent) => {
      if (!this.joyActive || e.pointerId !== this.joyId) return;
      const dx = e.clientX - this.joyOrigin.x;
      const dy = e.clientY - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      const clamped = len > this.joyRadius ? this.joyRadius / len : 1;
      this.joyVec = {
        x: (dx * clamped) / this.joyRadius,
        y: (dy * clamped) / this.joyRadius,
      };
      if (this.joyKnob) {
        this.joyKnob.style.transform = `translate(${dx * clamped}px, ${dy * clamped}px)`;
      }
    };

    const endJoy = (e: PointerEvent) => {
      if (e.pointerId !== this.joyId) return;
      this.clearJoystick();
    };

    /**
     * When the browser saw the event, in seconds — not when this handler ran.
     *
     * They are the same clock, but not the same instant: a long frame delays
     * the handler, and on a struggling phone two taps 140 ms apart can reach
     * their listener half a second apart. Timing a gesture by the second
     * number makes the scheme unreliable exactly when the device is.
     */
    const at = (e: PointerEvent) => e.timeStamp / 1000;

    zone.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (this.portrait) {
        e.preventDefault();
        this.gestures.begin(e.pointerId, e.clientX, e.clientY, at(e));
        try {
          zone.setPointerCapture(e.pointerId);
        } catch {
          // Without capture the zone still sees moves while the finger is on
          // screen, which is where every one of these gestures happens.
        }
        return;
      }
      const center = joyCenter();
      if (!center || Math.hypot(e.clientX - center.x, e.clientY - center.y) > center.hitRadius) return;
      // A fresh finger on the stick always takes it, even if the last one was
      // never seen to lift. Refusing here is what turns a single missed
      // pointerup into a stick nobody can retrieve: the old id still owns it,
      // every new press is ignored, and the player is left holding a control
      // that does nothing while their character walks away.
      if (this.joyActive && e.pointerId !== this.joyId) this.clearJoystick();
      e.preventDefault();
      this.joyActive = true;
      this.joyId = e.pointerId;
      this.joyOrigin = { x: center.x, y: center.y };
      this.joyVec = { x: 0, y: 0 };
      this.joyBase?.classList.add("active");
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is unavailable on a few older mobile browsers; the
        // zone still receives moves while the finger remains over the screen.
      }
      moveJoy(e);
    });
    zone.addEventListener("pointermove", (e) => {
      if (this.portrait) this.gestures.move(e.pointerId, e.clientX, e.clientY, at(e));
      else moveJoy(e);
    });
    zone.addEventListener("pointerup", (e) => {
      if (this.portrait) this.gestures.end(e.pointerId, at(e));
      else endJoy(e);
    });
    zone.addEventListener("pointercancel", (e) => {
      if (this.portrait) this.gestures.cancel(e.pointerId);
      else endJoy(e);
    });
    zone.addEventListener("lostpointercapture", (e) => {
      // A lost capture is not a lift: the finger may still be down. Ending the
      // track here keeps a swipe that outran its capture from being stranded.
      if (this.portrait) this.gestures.end(e.pointerId, at(e));
      else endJoy(e);
    });

    /**
     * The same ends, watched on the window.
     *
     * A stick is held by *not* sending events — a finger resting still on it
     * produces nothing at all — so there is no timeout that can tell a held
     * stick from an abandoned one. That makes the lift the only thing that
     * stops it, and a lift the zone never hears is a stick that stays pushed
     * for the rest of the match: the character walks off in the last direction
     * it was given and no input takes it back. It is the exact shape of
     * "the controlled player keeps moving by itself, mostly diagonally".
     *
     * The zone misses lifts more often than it looks. A finger that leaves the
     * viewport, a pointer the browser cancels while the layer is being hidden
     * between screens, a second touch that steals capture — each ends the
     * gesture somewhere the zone is not listening. The window hears all of
     * them, and both handlers are id-matched, so this never ends a stick that
     * is genuinely still down.
     */
    const endEverywhere = (e: PointerEvent) => {
      if (this.portrait) this.gestures.end(e.pointerId, at(e));
      else endJoy(e);
    };
    window.addEventListener("pointerup", endEverywhere);
    window.addEventListener("pointercancel", endEverywhere);
    // A phone that locks, a call, a notification pulled down: the finger is
    // gone and no pointer event says so.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.resetTouchState();
    });

    uiRoot.appendChild(zone);
  }

  /**
   * Build an action button that safely survives a finger leaving its bounds.
   *
   * `hold` is called with the button's level rather than once per press, which
   * is what lets STRIKE charge: the kick is committed when the finger lifts.
   */
  private makeTouchAction(
    id: "strike-btn" | "pop-btn",
    label: string,
    detail: string,
    ariaLabel: string,
    /**
     * `t` is the *event's* timestamp, not the handler's. Tap counting lives or
     * dies on it: on a struggling phone two presses 140 ms apart can reach
     * their listeners half a second apart, which would read as two kicks
     * instead of one double-tap.
     */
    hold: (down: boolean, t: number) => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.id = id;
    button.className = "touch-action";
    button.setAttribute("aria-label", ariaLabel);
    button.innerHTML = `<span class="touch-action-label">${label}</span><span class="touch-action-detail">${detail}</span>`;
    const activePointers = new Set<number>();
    this.touchActionPointers.set(button, activePointers);
    const release = (e: PointerEvent) => {
      if (!activePointers.delete(e.pointerId)) return;
      if (activePointers.size === 0) {
        button.classList.remove("pressed");
        hold(false, e.timeStamp / 1000);
      }
    };
    button.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      activePointers.add(e.pointerId);
      button.classList.add("pressed");
      try {
        button.setPointerCapture(e.pointerId);
      } catch {
        // A press still registers on browsers without Pointer Events capture.
      }
      hold(true, e.timeStamp / 1000);
    });
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("contextmenu", (e) => e.preventDefault());
    return button;
  }

  private clearJoystick(): void {
    const pointerId = this.joyId;
    this.joyActive = false;
    this.joyId = -1;
    this.joyVec = { x: 0, y: 0 };
    this.joyBase?.classList.remove("active");
    if (this.joyKnob) this.joyKnob.style.transform = "";
    if (pointerId >= 0 && this.touchLayer?.hasPointerCapture(pointerId)) {
      try {
        this.touchLayer.releasePointerCapture(pointerId);
      } catch {
        // A disconnected pointer can be reported as captured by a browser for
        // one final event; the neutral input state above is already enough.
      }
    }
  }

  /** Never let a hidden overlay retain movement or a pressed visual state. */
  private resetTouchState(): void {
    this.clearJoystick();
    this.clearStrikeHold();
    this.gestures.clear();
    this.gestureAim = null;
    this.tapQueued = null;
    for (const [button, pointers] of this.touchActionPointers) {
      for (const pointerId of pointers) {
        if (button.hasPointerCapture(pointerId)) {
          try {
            button.releasePointerCapture(pointerId);
          } catch {
            // The browser may have already released it during a blur/cancel.
          }
        }
      }
      pointers.clear();
      button.classList.remove("pressed");
    }
  }

  /** Movement axes from the keyboard, with the touch joystick folded in. */
  private kbAxes(): { sx: number; sy: number } {
    let sx = 0;
    let sy = 0;
    if (this.keys.has("KeyA")) sx -= 1;
    if (this.keys.has("KeyD")) sx += 1;
    if (this.keys.has("KeyW")) sy -= 1;
    if (this.keys.has("KeyS")) sy += 1;
    if (this.keys.has("ArrowLeft")) sx -= 1;
    if (this.keys.has("ArrowRight")) sx += 1;
    if (this.keys.has("ArrowUp")) sy -= 1;
    if (this.keys.has("ArrowDown")) sy += 1;
    sx += this.joyVec.x;
    sy += this.joyVec.y;
    return { sx, sy };
  }

  /**
   * Turn whatever the gesture scheme recognised into the same queued presses
   * a button would have produced, plus the aim they carry.
   */
  private pumpGestures(): void {
    const t = performance.now() / 1000;
    for (const g of this.gestures.take()) {
      if (g.kind === "tap") {
        // A tap is the one gesture with no analogue in the shared input state:
        // it names a point on the court, so the app resolves what it meant.
        this.tapQueued = { x: g.x, y: g.y };
      } else {
        // Direction aims the kick; pace decides how hard it is struck. Length
        // only weights the aim, so a short sharp flick is still a hard shot.
        this.gestureAim = {
          sx: g.dx * g.strength,
          sy: g.dy * g.strength,
          until: t + Input.AIM_HOLD,
        };
        this.gesturePower = g.speed;
        this.strikeQueued = true;
        this.confirmQueued = true;
      }
    }
  }

  /** The aim a recent gesture left behind, in screen space, or zero. */
  private aimVector(): { sx: number; sy: number } {
    const aim = this.gestureAim;
    if (!aim) return { sx: 0, sy: 0 };
    if (performance.now() / 1000 > aim.until) {
      this.gestureAim = null;
      return { sx: 0, sy: 0 };
    }
    return { sx: aim.sx, sy: aim.sy };
  }

  /**
   * Consume the latest tap-to-place point, normalised to 0..1 of the viewport.
   * The app turns it into a court spot — only it knows where the camera is.
   */
  pollTapPlacement(): { x: number; y: number } | null {
    const tap = this.tapQueued;
    this.tapQueued = null;
    return tap;
  }

  /** Poll and consume one frame of the player's input. Screen-space: x right, y down. */
  poll(cameraMode: CameraMode = "court"): InputState {
    // A pad Chrome had been hiding becomes visible on the first button press,
    // which may not have gone through `gamepadconnected` yet this frame.
    this.syncTouchLayer();
    if (this.portrait) this.pumpGestures();
    // A tap sequence whose window closed between frames commits here, rather
    // than waiting for a press that may never come.
    const now = performance.now() / 1000;
    const tick = kickTick(this.kickSeq, now);
    this.kickSeq = tick.seq;
    if (tick.commit) this.commitKick(tick.commit);
    // The active view is passed into this concrete poll rather than cached on
    // Input, so a view that cycles this frame is already reflected here.
    const rotateDpad = cameraMode === "side";
    let padStrike = false;
    let padPop = false;
    // Keyboard, touch and every connected pad, all feeding the one player.
    let { sx, sy } = this.kbAxes();
    const aim = this.aimVector();
    sx += aim.sx;
    sy += aim.sy;
    for (const p of Input.connectedPads()) {
      const r = this.readPad(p, rotateDpad);
      sx += r.x;
      sy += r.y;
      padStrike ||= r.strike;
      padPop ||= r.pop;
    }
    if (padStrike || this.padStrikeWasDown) this.setStrikeDown(padStrike);
    this.padStrikeWasDown = padStrike;
    if (padPop && !this.prevGamepadPop) this.popQueued = true;
    this.prevGamepadPop = padPop;

    sx = Math.max(-1, Math.min(1, sx));
    sy = Math.max(-1, Math.min(1, sy));

    const move = moveForView(sx, sy, cameraMode);
    const state: InputState = {
      moveX: move.moveX,
      moveZ: move.moveZ,
      strikePressed: this.strikeQueued,
      strikeHeld: this.strikeDown,
      strikePower: this.gesturePower,
      strikeTaps: this.kickTaps,
      strikeLoft: this.kickLoftValue,
      strikeTapsSoFar: this.kickSeq?.taps ?? 0,
      strikeHoldSoFar: kickHeldFor(this.kickSeq, now),
      popPressed: this.popQueued,
      confirmPressed: this.confirmQueued,
    };
    this.strikeQueued = false;
    this.popQueued = false;
    this.confirmQueued = false;
    this.gesturePower = 0;
    this.kickTaps = undefined;
    this.kickLoftValue = undefined;
    return state;
  }

  private static connectedPads(): Gamepad[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out: Gamepad[] = [];
    for (const p of pads) if (p && p.connected) out.push(p);
    return out;
  }

  /**
   * Consume the global camera-view action. It deliberately watches every pad
   * so either local player can change the shared split-screen presentation.
   */
  pollCameraCycle(): boolean {
    let pressed = this.cameraQueued;
    for (const p of Input.connectedPads()) pressed ||= !!p.buttons[3]?.pressed; // Y / Triangle
    const out = pressed && !this.prevCameraCycle;
    this.prevCameraCycle = pressed;
    this.cameraQueued = false;
    return out;
  }


  /**
   * Consume the universal pause edge: Escape or Pause on a keyboard,
   * Start/Options on any pad. Sampled every frame, including while the game is
   * already paused, so the same button also resumes the match.
   */
  pollPauseEdge(): boolean {
    let gamepadPause = false;
    for (const p of Input.connectedPads()) {
      const b = p.buttons[9]; // Start / Options in the standard gamepad map.
      gamepadPause ||= !!b && (b.pressed || b.value > 0.5);
    }
    const out = this.pauseQueued || (gamepadPause && !this.prevPauseGamepad);
    this.prevPauseGamepad = gamepadPause;
    this.pauseQueued = false;
    return out;
  }

  /**
   * Direction + buttons from one gamepad, tolerant of non-"standard" mappings:
   * left stick (axes 0/1, falling back to 2/3 when idle), d-pad buttons
   * (12-15) and a HID hat switch on axis 9. Screen space: x right, y down.
   */
  private readPad(
    p: Gamepad,
    rotateDpad = false
  ): { x: number; y: number; strike: boolean; pop: boolean } {
    const ax = (i: number) => p.axes[i] ?? 0;
    const btn = (i: number) => {
      const b = p.buttons[i];
      return !!b && (b.pressed || b.value > 0.5);
    };
    let x = Math.abs(ax(0)) > 0.18 ? ax(0) : 0;
    let y = Math.abs(ax(1)) > 0.18 ? ax(1) : 0;
    // Some DirectInput pads put their only stick on axes 2/3.
    if (x === 0 && Math.abs(ax(2)) > 0.18) x = ax(2);
    if (y === 0 && Math.abs(ax(3)) > 0.18) y = ax(3);
    // Keep D-pad separate from the analogue stick so alternate camera modes
    // can rotate exactly the D-pad without changing stick semantics.
    let dpadX = 0;
    let dpadY = 0;
    // D-pad as buttons (standard mapping 12-15: up, down, left, right).
    if (btn(12)) dpadY -= 1;
    if (btn(13)) dpadY += 1;
    if (btn(14)) dpadX -= 1;
    if (btn(15)) dpadX += 1;
    // Some non-standard controllers expose the D-pad on axes 6/7 instead of
    // the standard buttons. Treat those axes as D-pad only on non-standard
    // mappings so analogue-stick movement is never rotated by this fallback.
    const dpadButtonsHeld = btn(12) || btn(13) || btn(14) || btn(15);
    const axisDpadX = !dpadButtonsHeld && p.mapping !== "standard" && Math.abs(ax(6)) > 0.5 ? Math.sign(ax(6)) : 0;
    const axisDpadY = !dpadButtonsHeld && p.mapping !== "standard" && Math.abs(ax(7)) > 0.5 ? Math.sign(ax(7)) : 0;
    dpadX += axisDpadX;
    dpadY += axisDpadY;
    // D-pad as a hat switch (axis 9 on many HID pads). Idle values differ by
    // driver (and may be 0), so capture the pad's neutral value first instead
    // of treating an arbitrary axis-9 zero as a held direction.
    const hat = p.axes.length > 9 ? p.axes[9] : NaN;
    const canReadHat =
      !dpadButtonsHeld &&
      axisDpadX === 0 &&
      axisDpadY === 0 &&
      p.mapping !== "standard" &&
      Number.isFinite(hat);
    let hatActive = false;
    if (canReadHat) {
      const idle = this.hatIdleByPad.get(p.index);
      if (idle === undefined) this.hatIdleByPad.set(p.index, hat);
      else hatActive = Math.abs(hat - idle) > 0.08;
    }
    if (hatActive && hat >= -1 && hat <= 1.001) {
      const idx = Math.round(((hat + 1) / 2) * 7) % 8; // 0..7 = N NE E SE S SW W NW
      const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
      dpadX += dirs[idx][0];
      dpadY += dirs[idx][1];
    }
    if (rotateDpad) {
      // (x, y) -> (y, -x): up→left, down→right, right→up, left→down.
      const rawX = dpadX;
      dpadX = dpadY;
      dpadY = -rawX;
    }
    x += dpadX;
    y += dpadY;
    return {
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
      strike: btn(0) || btn(7) || btn(5),
      pop: btn(1) || btn(2) || btn(6) || btn(4),
    };
  }

  /** True if at least one gamepad is connected (for enabling the versus mode). */
  hasGamepad(): boolean {
    return this.padSeen || Input.connectedPads().length > 0;
  }

  /** The first connected pad's reported name, for diagnostics in the UI. */
  padName(): string | null {
    return Input.connectedPads()[0]?.id ?? null;
  }


  /**
   * Edge-triggered menu navigation from every connected pad plus the keyboard
   * arrows/Enter plus Escape/B — lets the whole menu flow be driven from the couch. Uses its
   * own edge state so it never steals gameplay presses.
   */
  pollMenuNav(): { up: boolean; down: boolean; confirm: boolean; back: boolean } {
    this.syncTouchLayer();
    let up = false;
    let down = false;
    let confirm = false;
    let back = false;
    for (const p of Input.connectedPads()) {
      const r = this.readPad(p);
      if (r.y < -0.55) up = true;
      if (r.y > 0.55) down = true;
      if (r.strike) confirm = true;
      // B / Circle is also the reception control during play; on a menu it is
      // the familiar cancel/back action and never enters the match input path.
      if (r.pop) back = true;
    }
    if (this.keys.has("ArrowUp")) up = true;
    if (this.keys.has("ArrowDown")) down = true;
    if (this.keys.has("Enter") || this.keys.has("Space")) confirm = true;
    if (this.menuBackQueued) back = true;
    const out = {
      up: up && !this.prevNav.up,
      down: down && !this.prevNav.down,
      confirm: confirm && !this.prevNav.confirm,
      back: back && !this.prevNav.left,
    };
    this.prevNav = { up, down, left: back, right: false, confirm };
    this.menuBackQueued = false;
    return out;
  }
}
