import type { CameraMode } from "./config";
import { GestureScheme } from "./gestures";

/**
 * Unified input: keyboard (WASD/arrows + space), touch and gamepad (left stick
 * + cross/A via the Gamepad API, which also covers the PS5 browser /
 * DualSense).
 *
 * Touch has two layouts, chosen by which way the phone is held. Landscape
 * keeps the visible move/aim stick and its action buttons. Portrait has no
 * room for either, so the whole screen becomes the controller instead: tap to
 * place the player, double tap to receive, swipe to kick. Both feed this same
 * InputState — the match never learns which one is in use.
 */
export interface InputState {
  /** Movement in court space: x toward the net, z lateral. Range [-1, 1]. */
  moveX: number;
  moveZ: number;
  /**
   * True only on the frame the strike control was *released*. A kick is
   * committed by letting go, because how long it was held is what decides how
   * hard it is struck.
   */
  strikePressed: boolean;
  /** True while the strike control is down: the kick is being charged. */
  strikeHeld: boolean;
  /**
   * Power the input scheme decided for itself, 0..1, valid on the frame of a
   * press. Portrait sets it from the speed of the swipe; landscape leaves it
   * at 0 and the match charges the kick from how long the button was held.
   */
  strikePower: number;
  /** True only on the frame the reception (control-touch) control was pressed. */
  popPressed: boolean;
  /** True only on the frame any "confirm" control was pressed (strike, enter, tap). */
  confirmPressed: boolean;
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
  // A power belongs to the press it arrived with, so it is kept only when
  // there is a press waiting to carry it.
  if (sampled.strikePressed) latched.strikePower = sampled.strikePower;
  latched.strikePressed ||= sampled.strikePressed;
  latched.popPressed ||= sampled.popPressed;
  latched.confirmPressed ||= sampled.confirmPressed;
}

/** Take the latched state for one simulation step, clearing the edges it consumes. */
export function consumeInput(latched: LatchedInput): InputState {
  const state: InputState = { ...latched };
  latched.strikePressed = false;
  latched.strikePower = 0;
  latched.popPressed = false;
  latched.confirmPressed = false;
  return state;
}

/**
 * A device a versus player can be assigned to:
 * - "kb": the whole keyboard (WASD + arrows, Space/Enter/J strike, K reception) + touch
 * - "kbWASD": WASD half (Space/J strike, K reception) + touch
 * - "kbArrows": arrows half (Enter strike, right Shift reception)
 * - "pad1"/"pad2": first/second connected gamepad
 */
export type DeviceId = "kb" | "kbWASD" | "kbArrows" | "pad1" | "pad2";

export interface VersusAssign {
  p1: DeviceId;
  p2: DeviceId;
}

/** Which keyboard code fires a strike/reception for a given device assignment. */
function kbOwns(d: DeviceId | undefined, code: string, kind: "strike" | "pop"): boolean {
  if (!d) return false;
  if (kind === "strike") {
    if (d === "kb") return code === "Space" || code === "Enter" || code === "KeyJ";
    if (d === "kbWASD") return code === "Space" || code === "KeyJ";
    if (d === "kbArrows") return code === "Enter";
  } else {
    if (d === "kb" || d === "kbWASD") return code === "KeyK";
    if (d === "kbArrows") return code === "ShiftRight";
  }
  return false;
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
  private strikeDown: [boolean, boolean] = [false, false];
  /** Pad levels, so a pad release is only reported once. */
  private padStrikeWasDown = false;
  private pad2StrikeWasDown = false;
  private prevGamepadPop = false;
  /** Neutral axis-9 values for non-standard HID hat switches, by pad index. */
  private hatIdleByPad = new Map<number, number>();
  /**
   * Versus mode: which device each player uses (chosen in the versus menu).
   * null outside versus — then keyboard, touch and every pad all feed P1.
   */
  versusAssign: VersusAssign | null = null;
  private p2StrikeQueued = false;
  private p2PopQueued = false;
  private prevPad2Pop = false;
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
    this.isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

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
      const a = this.versusAssign;
      if (!a) {
        // Single human: every strike/reception key belongs to them.
        if (e.code === "Space" || e.code === "Enter" || e.code === "KeyJ") {
          this.setStrikeDown(0, true);
          e.preventDefault();
        }
        if (e.code === "KeyK") {
          this.popQueued = true;
          e.preventDefault();
        }
        return;
      }
      // Versus: route each key to whichever player's device owns it.
      if (kbOwns(a.p1, e.code, "strike")) {
        this.setStrikeDown(0, true);
        e.preventDefault();
      }
      if (kbOwns(a.p1, e.code, "pop")) {
        this.popQueued = true;
        e.preventDefault();
      }
      if (kbOwns(a.p2, e.code, "strike")) {
        this.setStrikeDown(1, true);
        e.preventDefault();
      }
      if (kbOwns(a.p2, e.code, "pop")) {
        this.p2PopQueued = true;
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      const a = this.versusAssign;
      if (!a) {
        if (e.code === "Space" || e.code === "Enter" || e.code === "KeyJ") this.setStrikeDown(0, false);
        return;
      }
      if (kbOwns(a.p1, e.code, "strike")) this.setStrikeDown(0, false);
      if (kbOwns(a.p2, e.code, "strike")) this.setStrikeDown(1, false);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.clearStrikeHold();
      this.resetTouchState();
    });

    window.addEventListener("gamepadconnected", (e) => {
      this.padSeen = true;
      console.log("[gamepad] connected:", e.gamepad.id);
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      this.hatIdleByPad.delete(e.gamepad.index);
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
  private setStrikeDown(seat: 0 | 1, down: boolean): void {
    if (down === this.strikeDown[seat]) return;
    this.strikeDown[seat] = down;
    if (down) {
      if (seat === 0) this.confirmQueued = true;
      return;
    }
    if (seat === 0) this.strikeQueued = true;
    else this.p2StrikeQueued = true;
  }

  /** Drop a held kick without firing it (focus loss, a hidden touch layer). */
  private clearStrikeHold(): void {
    this.strikeDown = [false, false];
  }

  /** Hide the touch layer while a screen needs direct canvas interaction (model viewer). */
  setTouchControlsEnabled(enabled: boolean): void {
    if (!this.touchLayer) return;
    if (!enabled) this.resetTouchState();
    this.touchLayer.style.display = enabled ? "" : "none";
    this.touchLayer.setAttribute("aria-hidden", String(!enabled));
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
      '<span><b>TAP</b>move</span><span><b>DOUBLE TAP</b>receive</span><span><b>SWIPE</b>kick</span>';
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
      (down) => this.setStrikeDown(0, down)
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
      if (this.joyActive) return;
      const center = joyCenter();
      if (!center || Math.hypot(e.clientX - center.x, e.clientY - center.y) > center.hitRadius) return;
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
    hold: (down: boolean) => void
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
        hold(false);
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
      hold(true);
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

  /** Movement axes for a keyboard device (touch joystick joins the WASD side). */
  private kbAxes(device: DeviceId): { sx: number; sy: number } {
    let sx = 0;
    let sy = 0;
    const wasd = device === "kb" || device === "kbWASD";
    const arrows = device === "kb" || device === "kbArrows";
    if (wasd) {
      if (this.keys.has("KeyA")) sx -= 1;
      if (this.keys.has("KeyD")) sx += 1;
      if (this.keys.has("KeyW")) sy -= 1;
      if (this.keys.has("KeyS")) sy += 1;
      sx += this.joyVec.x;
      sy += this.joyVec.y;
    }
    if (arrows) {
      if (this.keys.has("ArrowLeft")) sx -= 1;
      if (this.keys.has("ArrowRight")) sx += 1;
      if (this.keys.has("ArrowUp")) sy -= 1;
      if (this.keys.has("ArrowDown")) sy += 1;
    }
    return { sx, sy };
  }

  /** Resolve a pad device to a connected gamepad. */
  private static padOf(device: DeviceId): Gamepad | undefined {
    const pads = Input.connectedPads();
    return device === "pad2" ? pads[1] : pads[0];
  }

  /**
   * Turn whatever the gesture scheme recognised into the same queued presses
   * a button would have produced, plus the aim they carry.
   */
  private pumpGestures(): void {
    const t = performance.now() / 1000;
    this.gestures.tick(t);
    for (const g of this.gestures.take()) {
      if (g.kind === "tap") {
        // Placement is the one gesture with no analogue in the shared input
        // state: it names a point on the court, so the app resolves it.
        this.tapQueued = { x: g.x, y: g.y };
      } else if (g.kind === "swipe") {
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
      } else {
        // A reception is aimed by where on the screen it was double tapped —
        // left, right, near or far from the middle of the court in front of
        // the player, which is where the set-up ball will come down.
        this.gestureAim = {
          sx: Math.max(-1, Math.min(1, (g.x - 0.5) * 2.4)),
          sy: Math.max(-1, Math.min(1, (g.y - 0.5) * 2.4)),
          until: t + Input.AIM_HOLD,
        };
        this.popQueued = true;
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

  /** Poll and consume one frame of player 1's input. Screen-space: x right, y down. */
  poll(cameraMode: CameraMode = "court"): InputState {
    if (this.portrait) this.pumpGestures();
    const a = this.versusAssign;
    // The active view is passed into this concrete poll rather than cached on
    // Input. That keeps both players correct on the exact frame a view cycles.
    const rotateDpad = cameraMode === "side" || cameraMode === "top";
    let sx = 0;
    let sy = 0;
    let padStrike = false;
    let padPop = false;
    if (!a) {
      // Single human: whole keyboard, touch and every connected pad.
      ({ sx, sy } = this.kbAxes("kb"));
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
    } else if (a.p1.startsWith("kb")) {
      ({ sx, sy } = this.kbAxes(a.p1));
    } else {
      const p = Input.padOf(a.p1);
      if (p) {
        const r = this.readPad(p, rotateDpad);
        sx = r.x;
        sy = r.y;
        padStrike = r.strike;
        padPop = r.pop;
      }
    }
    if (padStrike || this.padStrikeWasDown) this.setStrikeDown(0, padStrike);
    this.padStrikeWasDown = padStrike;
    if (padPop && !this.prevGamepadPop) this.popQueued = true;
    this.prevGamepadPop = padPop;

    sx = Math.max(-1, Math.min(1, sx));
    sy = Math.max(-1, Math.min(1, sy));

    const state: InputState = {
      // Camera sits behind the player at -x looking toward +x, so screen up =
      // +x (toward the net) and screen right = -z.
      moveX: -sy,
      moveZ: -sx,
      strikePressed: this.strikeQueued,
      strikeHeld: this.strikeDown[0],
      strikePower: this.gesturePower,
      popPressed: this.popQueued,
      confirmPressed: this.confirmQueued,
    };
    this.strikeQueued = false;
    this.popQueued = false;
    this.confirmQueued = false;
    this.gesturePower = 0;
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

  /** Number of currently connected gamepads (for the versus device menu). */
  padCount(): number {
    return Input.connectedPads().length;
  }

  /**
   * Poll player 2's assigned device (versus mode) — a gamepad or their half
   * of the keyboard. Returned in the same screen→court mapping as poll() for
   * a -x-side camera view — the caller flips it into the second player's frame.
   */
  pollP2(cameraMode: CameraMode = "court"): InputState {
    const d = this.versusAssign?.p2 ?? "pad1";
    const rotateDpad = cameraMode === "side" || cameraMode === "top";
    let sx = 0;
    let sy = 0;
    let padStrike = false;
    let padPop = false;
    if (d.startsWith("kb")) {
      ({ sx, sy } = this.kbAxes(d));
    } else {
      const p = Input.padOf(d);
      if (p) {
        const r = this.readPad(p, rotateDpad);
        sx = r.x;
        sy = r.y;
        padStrike = r.strike;
        padPop = r.pop;
      }
    }
    if (padStrike || this.pad2StrikeWasDown) this.setStrikeDown(1, padStrike);
    this.pad2StrikeWasDown = padStrike;
    const strikePressed = this.p2StrikeQueued;
    const popPressed = (padPop && !this.prevPad2Pop) || this.p2PopQueued;
    this.prevPad2Pop = padPop;
    this.p2StrikeQueued = false;
    this.p2PopQueued = false;
    return {
      moveX: -Math.max(-1, Math.min(1, sy)),
      moveZ: -Math.max(-1, Math.min(1, sx)),
      strikePressed,
      strikeHeld: this.strikeDown[1],
      strikePower: 0,
      popPressed,
      confirmPressed: strikePressed,
    };
  }

  /**
   * Edge-triggered menu navigation from every connected pad plus the keyboard
   * arrows/Enter plus Escape/B — lets the whole menu flow be driven from the couch. Uses its
   * own edge state so it never steals gameplay presses.
   */
  pollMenuNav(): { up: boolean; down: boolean; confirm: boolean; back: boolean } {
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
