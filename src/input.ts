import type { CameraMode } from "./config";

/**
 * Unified input: keyboard (WASD/arrows + space), touch (visible move / aim
 * stick plus action buttons) and gamepad (left stick + cross/A via the
 * Gamepad API, which also covers the PS5 browser / DualSense).
 */
export interface InputState {
  /** Movement in court space: x toward the net, z lateral. Range [-1, 1]. */
  moveX: number;
  moveZ: number;
  /** True only on the frame the strike control was pressed. */
  strikePressed: boolean;
  /** True only on the frame the reception (control-touch) control was pressed. */
  popPressed: boolean;
  /** True only on the frame any "confirm" control was pressed (strike, enter, tap). */
  confirmPressed: boolean;
}

/** Edge-triggered controls available only while a highlight replay is visible. */
export interface ReplayControls {
  /** Toggle the presentation between playing and paused. */
  toggle: boolean;
  /** Leave the replay and return to the normal between-points flow. */
  skip: boolean;
  /** Move the replay timeline backward/forward one discrete step. */
  back: boolean;
  forward: boolean;
  /** Move the replay camera one zoom step closer/farther. */
  zoomIn: boolean;
  zoomOut: boolean;
}

/** Global pause edge plus whether it originated from Escape. */
export interface PauseControls {
  /** Escape/Pause on keyboard or Start/Options on any connected controller. */
  toggle: boolean;
  /** Escape remains a replay-skip shortcut instead of pausing a replay. */
  escape: boolean;
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
  /** Replay-only keyboard actions; physical gamepad edges are sampled below. */
  private replayToggleQueued = false;
  private replaySkipQueued = false;
  private replayBackQueued = false;
  private replayForwardQueued = false;
  private replayZoomInQueued = false;
  private replayZoomOutQueued = false;
  private prevReplayControls = { toggle: false, skip: false, back: false, forward: false, zoomIn: false, zoomOut: false };
  /** Live-match pause is independent of replay transport's Start edge. */
  private pauseQueued = false;
  private escapeQueued = false;
  private prevPauseGamepad = false;
  private prevGamepadStrike = false;
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
  private prevPad2Strike = false;
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

  constructor(uiRoot: HTMLElement) {
    this.isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "Escape") {
        this.menuBackQueued = true;
        this.pauseQueued = true;
        this.escapeQueued = true;
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
      // SPACE deliberately keeps its regular STRIKE binding as well. The app
      // consumes the replay edge first when a highlight is active, while a
      // normal rally still sees the exact same strike press.
      if (e.code === "Space" || e.code === "KeyP") {
        this.replayToggleQueued = true;
        if (e.code === "KeyP") {
          e.preventDefault();
          return;
        }
      }
      if (e.code === "KeyX") {
        this.replaySkipQueued = true;
        e.preventDefault();
        return;
      }
      // Keep arrow keys / J playable in a live rally. During a replay their
      // separate edge is consumed as a timeline seek before match input.
      if (e.code === "ArrowLeft" || e.code === "KeyJ") this.replayBackQueued = true;
      if (e.code === "ArrowRight" || e.code === "KeyL") this.replayForwardQueued = true;
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        this.replayZoomInQueued = true;
        e.preventDefault();
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        this.replayZoomOutQueued = true;
        e.preventDefault();
        return;
      }
      const a = this.versusAssign;
      if (!a) {
        // Single human: every strike/reception key belongs to them.
        if (e.code === "Space" || e.code === "Enter" || e.code === "KeyJ") {
          this.strikeQueued = true;
          this.confirmQueued = true;
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
        this.strikeQueued = true;
        this.confirmQueued = true;
        e.preventDefault();
      }
      if (kbOwns(a.p1, e.code, "pop")) {
        this.popQueued = true;
        e.preventDefault();
      }
      if (kbOwns(a.p2, e.code, "strike")) {
        this.p2StrikeQueued = true;
        e.preventDefault();
      }
      if (kbOwns(a.p2, e.code, "pop")) {
        this.p2PopQueued = true;
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.resetTouchState();
    });

    window.addEventListener("gamepadconnected", (e) => {
      this.padSeen = true;
      console.log("[gamepad] connected:", (e as GamepadEvent).gamepad.id);
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      this.hatIdleByPad.delete((e as GamepadEvent).gamepad.index);
      console.log("[gamepad] disconnected:", (e as GamepadEvent).gamepad.id);
    });

    if (this.isTouch) this.buildTouchControls(uiRoot);
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

    // The court camera and both action clusters are designed for landscape.
    // The layer itself is disabled outside play, so this notice can never
    // obscure a menu or the character viewer.
    const rotateNotice = document.createElement("div");
    rotateNotice.id = "touch-rotate-notice";
    rotateNotice.setAttribute("role", "status");
    rotateNotice.innerHTML =
      '<span class="rotate-device-icon" aria-hidden="true"></span><strong>Rotate for play</strong><span>TeqOpen is best in landscape.</span>';
    // In portrait the notice covers this layer. Consume its pointer events so
    // a replay orbit or free camera cannot move invisibly behind the prompt.
    const consumeRotateNotice = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    rotateNotice.addEventListener("pointerdown", consumeRotateNotice);
    rotateNotice.addEventListener("pointermove", consumeRotateNotice);
    rotateNotice.addEventListener("pointerup", consumeRotateNotice);
    rotateNotice.addEventListener("pointercancel", consumeRotateNotice);
    zone.appendChild(rotateNotice);

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
      "SERVE · KICK",
      "Strike, serve, or kick the ball",
      () => {
        this.strikeQueued = true;
        this.confirmQueued = true;
      }
    );
    this.popBtn = this.makeTouchAction(
      "pop-btn",
      "RECEPTION",
      "SET UP",
      "Make a reception or set up the ball",
      () => {
        this.popQueued = true;
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

    zone.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.joyActive) return;
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
    zone.addEventListener("pointermove", moveJoy);
    zone.addEventListener("pointerup", endJoy);
    zone.addEventListener("pointercancel", endJoy);
    zone.addEventListener("lostpointercapture", endJoy);

    uiRoot.appendChild(zone);
  }

  /** Build an action button that safely survives a finger leaving its bounds. */
  private makeTouchAction(
    id: "strike-btn" | "pop-btn",
    label: string,
    detail: string,
    ariaLabel: string,
    fire: () => void
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
      if (activePointers.size === 0) button.classList.remove("pressed");
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
      fire();
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

  /** Poll and consume one frame of player 1's input. Screen-space: x right, y down. */
  poll(cameraMode: CameraMode = "court"): InputState {
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
    if (padStrike && !this.prevGamepadStrike) {
      this.strikeQueued = true;
      this.confirmQueued = true;
    }
    this.prevGamepadStrike = padStrike;
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
      popPressed: this.popQueued,
      confirmPressed: this.confirmQueued,
    };
    this.strikeQueued = false;
    this.popQueued = false;
    this.confirmQueued = false;
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
   * Consume the universal pause edge. Start/Options is intentionally sampled
   * every frame, including while the game is paused, so the same button also
   * resumes the match. Replay handling remains separate in main.ts.
   */
  pollPauseControls(): PauseControls {
    let gamepadPause = false;
    for (const p of Input.connectedPads()) {
      const b = p.buttons[9]; // Start / Options in the standard gamepad map.
      gamepadPause ||= !!b && (b.pressed || b.value > 0.5);
    }
    const out = {
      toggle: this.pauseQueued || (gamepadPause && !this.prevPauseGamepad),
      escape: this.escapeQueued,
    };
    this.prevPauseGamepad = gamepadPause;
    this.pauseQueued = false;
    this.escapeQueued = false;
    return out;
  }

  /**
   * Consume global replay controls from any local device. These are polled
   * every frame (including menus) so a held controller button cannot fire in
   * a later replay. Keyboard: SPACE/P play-pause, X skip, arrows/J/L seek,
   * +/- zoom. Gamepad: Start/Options play-pause, B/Circle or Share/View skip,
   * D-pad left/right seek, LB/RB zoom.
   */
  pollReplayControls(): ReplayControls {
    let toggle = this.replayToggleQueued;
    let skip = this.replaySkipQueued;
    let back = this.replayBackQueued;
    let forward = this.replayForwardQueued;
    let zoomIn = this.replayZoomInQueued;
    let zoomOut = this.replayZoomOutQueued;
    for (const p of Input.connectedPads()) {
      const btn = (i: number) => !!p.buttons[i]?.pressed;
      toggle ||= btn(9); // Start / Options
      skip ||= btn(1) || btn(8); // B / Circle, Back / Share / View
      back ||= btn(14); // D-pad left
      forward ||= btn(15); // D-pad right
      zoomOut ||= btn(4); // LB / L1
      zoomIn ||= btn(5); // RB / R1
    }
    const out = {
      toggle: toggle && !this.prevReplayControls.toggle,
      skip: skip && !this.prevReplayControls.skip,
      back: back && !this.prevReplayControls.back,
      forward: forward && !this.prevReplayControls.forward,
      zoomIn: zoomIn && !this.prevReplayControls.zoomIn,
      zoomOut: zoomOut && !this.prevReplayControls.zoomOut,
    };
    this.prevReplayControls = { toggle, skip, back, forward, zoomIn, zoomOut };
    this.replayToggleQueued = false;
    this.replaySkipQueued = false;
    this.replayBackQueued = false;
    this.replayForwardQueued = false;
    this.replayZoomInQueued = false;
    this.replayZoomOutQueued = false;
    return out;
  }

  /**
   * Continuous replay-camera orbit axes. Deliberately read only WASD and
   * analogue stick axes: replay arrows and the physical D-pad are reserved
   * for timeline seek, even when a side/top view rotates gameplay D-pad input.
   * Every connected pad participates so either local player can inspect a
   * split-screen highlight.
   */
  pollReplayOrbit(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has("KeyA")) x -= 1;
    if (this.keys.has("KeyD")) x += 1;
    if (this.keys.has("KeyW")) y -= 1;
    if (this.keys.has("KeyS")) y += 1;
    for (const p of Input.connectedPads()) {
      const axis = (i: number) => p.axes[i] ?? 0;
      // Standard pads expose their left stick on 0/1. A few DirectInput pads
      // expose their only analogue stick on 2/3; use that only when 0/1 are
      // centred so the D-pad/hat never becomes an orbit source.
      let px = Math.abs(axis(0)) > 0.18 ? axis(0) : 0;
      let py = Math.abs(axis(1)) > 0.18 ? axis(1) : 0;
      if (p.mapping !== "standard" && px === 0 && Math.abs(axis(2)) > 0.18) px = axis(2);
      if (p.mapping !== "standard" && py === 0 && Math.abs(axis(3)) > 0.18) py = axis(3);
      x += px;
      y += py;
    }
    return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
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
    const strikePressed = (padStrike && !this.prevPad2Strike) || this.p2StrikeQueued;
    const popPressed = (padPop && !this.prevPad2Pop) || this.p2PopQueued;
    this.prevPad2Strike = padStrike;
    this.prevPad2Pop = padPop;
    this.p2StrikeQueued = false;
    this.p2PopQueued = false;
    return {
      moveX: -Math.max(-1, Math.min(1, sy)),
      moveZ: -Math.max(-1, Math.min(1, sx)),
      strikePressed,
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
