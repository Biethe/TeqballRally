import "./style.css";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { createGameScene, loadBall, type GameScene } from "./scene";
import {
  QUALITY_TIERS,
  TIER_LABELS,
  readSignals,
  resolveTier,
  settingsFor,
  storeTier,
} from "./quality";
import { VENUE_IDS, resolveVenue, storeVenue, venueFor } from "./venue";
import { INTRO_SECONDS, introPose } from "./intro";
import { Ball, type Side } from "./ball";
import { Character } from "./character";
import { MatchController } from "./match";
import { AIController, DIFFICULTIES, type DifficultyLevel } from "./ai";
import {
  Input,
  consumeInput,
  latchInput,
  newLatch,
  type InputState,
  type VersusAssign,
} from "./input";
import { UI } from "./ui";
import { AudioManager } from "./audio";
import { NetConnection } from "./net/connection";
import { OnlineSession } from "./net/session";
import { looksReachable, relayUrl } from "./net/endpoint";
import { Capacitor } from "@capacitor/core";
import {
  makeRoomCode,
  normalizeRoomCode,
  isValidRoomCode,
  isValidSetup,
  type PeerRole,
} from "./net/protocol";
import { ModelViewer } from "./viewer";
import { PRACTICE_DIFFICULTY, PracticeCoach } from "./practice";
import { BALLS, CAMERA, CHARACTERS, COURT, GROUND_Y, SIM_DT, type CameraMode, type CharacterDef } from "./config";

/** Longest real frame the simulation will honour; beyond this, time is dropped. */
const MAX_FRAME_DT = 1 / 20;

/** How one match should be set up and what to do when it ends. */
interface MatchOpts {
  opponent: CharacterDef;
  difficulty: DifficultyLevel;
  /** Second human drives the opponent (split screen); device assignment for both. */
  versus: VersusAssign | null;
  /** Online: the opponent is a remote human on the far end of this connection. */
  online?: { conn: NetConnection; role: PeerRole; private: boolean };
  labels: [string, string];
  practice?: boolean;
  onEnd: (winner: Side, sets: [number, number]) => void;
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const uiRoot = document.getElementById("ui-root") as HTMLElement;

  const ui = new UI(uiRoot);
  const audio = new AudioManager();
  const input = new Input(uiRoot);

  // Browsers gate audio behind a user gesture.
  const unlock = () => {
    audio.unlock();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  ui.showLoading("Building the court…");
  // The opening clip runs over the loading screen rather than in front of it,
  // so the scene builds during it and the wait costs nothing. `?intro=0` skips
  // it, which is what the headless verification scripts use.
  const introClip =
    new URLSearchParams(location.search).get("intro") === "0"
      ? Promise.resolve()
      : ui.playIntroClip();

  /**
   * Pull the player models and the ball into the browser cache while the clip
   * plays.
   *
   * This is what the clip's four seconds are for. The character models are the
   * heaviest thing the game loads — around 4 MB each — and fetching them here
   * means the picker opens on a model that is already local instead of showing
   * "Loading…" over an empty stage.
   *
   * Failures are ignored on purpose: this only warms a cache, and every one of
   * these files is fetched again properly at the point it is used.
   */
  const preloadUrls = [
    ...CHARACTERS.map((c) => `/models/characters/${c.id}.glb`),
    `/models/Ball_and_Table/${BALLS[0].id}.glb`,
  ];
  let preloaded = 0;
  const preload = Promise.all(
    preloadUrls.map((url) =>
      fetch(url)
        .then((r) => r.arrayBuffer())
        .catch(() => undefined)
        .finally(() => {
          preloaded++;
          ui.showIntroProgress(preloaded / preloadUrls.length);
        })
    )
  );
  // The tier decides the engine's MSAA, which cannot be changed on a live
  // context, so it has to be resolved before the scene exists.
  const qualityTier = resolveTier(location.search, readSignals());
  // A packaged build with no relay configured would point the game at the
  // phone itself, so online is offered as unavailable rather than failing at
  // the end of a lobby flow.
  const onlineAvailable = looksReachable(relayUrl(), Capacitor.isNativePlatform());
  // The venue is purely cosmetic — backdrop model plus court palette — so it is
  // a local choice and never negotiated with an opponent.
  let venueId = resolveVenue(location.search);
  const gs: GameScene = await createGameScene(canvas, settingsFor(qualityTier), venueFor(venueId));
  const viewer = new ModelViewer(gs.engine, canvas);
  (window as unknown as Record<string, unknown>).__viewer = viewer;
  // Test hook, alongside the viewer's: swaps venues through the same call the
  // settings screen makes and reports what the scene holds afterwards, which
  // is how a swap that leaks meshes or textures gets caught.
  (window as unknown as Record<string, unknown>).__swap = async (id: string) => {
    venueId = VENUE_IDS.find((v) => v === id) ?? venueId;
    await gs.setVenue(venueFor(venueId));
    return {
      venue: venueId,
      meshes: gs.scene.meshes.length,
      materials: gs.scene.materials.length,
      textures: gs.scene.textures.length,
    };
  };

  const ball = new Ball();
  let ballMesh: AbstractMesh | null = null;
  let ballMeshId: string | null = null;

  let match: MatchController | null = null;
  let aiCtl: AIController | null = null;
  let practiceCoach: PracticeCoach | null = null;
  let chars: Character[] = [];
  /** Live online match, if any: owns the wire, the opponent and the forfeit clock. */
  let session: OnlineSession | null = null;
  /** Held separately from the session so the lobby can own it before a match exists. */
  let netConn: NetConnection | null = null;

  // Dev knob: ?ts=8 speeds up game time for headless testing.
  const timeScale = Number(new URLSearchParams(location.search).get("ts") ?? 1) || 1;

  // Low-priority browser prefetches let the next picker item download while
  // the player reads the menu. Do not spend a metered/very-slow connection's
  // bandwidth on a speculative 20–60 MB model; on-demand loading remains the
  // fallback in that case.
  const prefetchLinks = new Set<string>();
  const scheduleAssetPrefetch = (url: string, delayMs = 1200): void => {
    if (typeof document === "undefined" || typeof navigator === "undefined") return;
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") {
      return;
    }
    if (prefetchLinks.has(url)) return;
    prefetchLinks.add(url);
    window.setTimeout(() => {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "fetch";
      link.href = url;
      link.crossOrigin = "anonymous";
      link.dataset.teqopenPrefetch = "true";
      document.head.appendChild(link);
    }, delayMs);
  };

  // ---- split screen (versus mode) ----
  let versusCam: TargetCamera | null = null;
  let cameraMode: CameraMode = "court";
  /**
   * Seconds left of the establishing shot, or null when a match is being
   * played normally. The simulation is held while it runs: the CPU is
   * perfectly willing to serve during a camera move, and an intro that ends
   * with the score already 1-0 is worse than no intro.
   */
  let introLeft: number | null = null;
  const enableSplit = (assign: VersusAssign) => {
    input.versusAssign = assign;
    gs.camera.viewport = new Viewport(0, 0, 0.5, 1);
    versusCam = new TargetCamera(
      "cam2",
      new Vector3(CAMERA.p2Court.x, GROUND_Y + CAMERA.p2Court.height, 0),
      gs.scene
    );
    versusCam.setTarget(new Vector3(0, GROUND_Y + CAMERA.p2Court.lookY, 0));
    versusCam.minZ = 0.1;
    // Half-width viewports are tall; widen both views a touch.
    gs.camera.fov = 1.0;
    versusCam.fov = CAMERA.p2Court.fov;
    versusCam.viewport = new Viewport(0.5, 0, 0.5, 1);
    gs.scene.activeCameras = [gs.camera, versusCam];
  };
  const disableSplit = () => {
    input.versusAssign = null;
    if (!versusCam) return;
    gs.scene.activeCameras = [];
    gs.scene.activeCamera = gs.camera;
    gs.camera.viewport = new Viewport(0, 0, 1, 1);
    gs.camera.fov = gs.engine.getRenderWidth() < gs.engine.getRenderHeight() ? 1.1 : 0.85;
    versusCam.dispose();
    versusCam = null;
  };

  // Debug free-fly camera (F2): place the camera by hand to evaluate the scene.
  // WASD/arrows move, drag mouse to look, E/Q up/down, hold Shift for speed.
  // Toggling it off logs the position/target so values can be copied into code.
  let freecam: UniversalCamera | null = null;
  const toggleFreecam = () => {
    if (viewer.active || match?.isReplayActive) return; // replay owns the game camera
    if (freecam) {
      const p = freecam.position;
      const t = freecam.getTarget();
      console.log(
        `[freecam] position (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})` +
          ` target (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)})`
      );
      freecam.detachControl();
      freecam.dispose();
      freecam = null;
      gs.scene.activeCamera = gs.camera;
    } else {
      freecam = new UniversalCamera("freecam", gs.camera.position.clone(), gs.scene);
      freecam.setTarget(gs.camera.getTarget().clone());
      freecam.minZ = 0.1;
      freecam.speed = 0.35;
      freecam.keysUp.push(87); // W
      freecam.keysDown.push(83); // S
      freecam.keysLeft.push(65); // A
      freecam.keysRight.push(68); // D
      freecam.keysUpward.push(69); // E
      freecam.keysDownward.push(81); // Q
      freecam.attachControl(canvas, true);
      gs.scene.activeCamera = freecam;
      (window as unknown as Record<string, unknown>).__freecam = freecam;
      console.log("[freecam] ON — WASD move, drag to look, E/Q up/down, Shift = fast, F2 to exit");
    }
  };
  window.addEventListener("keydown", (e) => {
    if (e.code === "F2") toggleFreecam();
    if (e.key === "Shift" && freecam) freecam.speed = 1.2;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && freecam) freecam.speed = 0.35;
  });

  const idleInput: InputState = { moveX: 0, moveZ: 0, strikePressed: false, popPressed: false, confirmPressed: false };

  /**
   * Where on the court a tap landed, or null if it missed the floor entirely.
   *
   * Portrait play places the player by tapping, and a tap is a point on the
   * screen: only the live camera can say which spot on the ground that is.
   * The result is clamped into the player's own half, so a tap anywhere —
   * including the opponent's side or the crowd — still reads as the nearest
   * legal place to stand rather than being thrown away.
   */
  const courtPointAt = (nx: number, ny: number): Vector3 | null => {
    // Unprojected by hand rather than through scene.createPickingRay: picking
    // is a side-effect import and a chunk of machinery for casting against
    // meshes, and this only ever needs the ground plane.
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const view = gs.camera.getViewMatrix();
    const projection = gs.camera.getProjectionMatrix();
    const at = (depth: number) =>
      Vector3.Unproject(new Vector3(nx * w, ny * h, depth), w, h, Matrix.Identity(), view, projection);
    const origin = at(0);
    const direction = at(1).subtract(origin).normalize();
    if (direction.y > -1e-4) return null; // level with or above the horizon
    const t = (GROUND_Y - origin.y) / direction.y;
    if (t <= 0) return null;
    const hit = origin.add(direction.scale(t));
    return new Vector3(
      Math.min(-COURT.minX, Math.max(-COURT.maxX, hit.x)),
      GROUND_Y,
      Math.max(-COURT.maxZ, Math.min(COURT.maxZ, hit.z))
    );
  };

  // Fixed-step simulation state. The accumulator only ever grows on frames
  // that actually simulate, so pausing cannot bank time and burst on resume.
  let simAccumulator = 0;
  const latchedP1 = newLatch();
  const latchedP2 = newLatch();
  // The frame delta is already clamped to MAX_FRAME_DT before the time scale is
  // applied, so this bound is simply that clamp expressed in simulation steps.
  const maxSimSteps = Math.ceil((MAX_FRAME_DT * timeScale) / SIM_DT) + 1;

  // ---- replay camera orbit ----
  // Match cameras are authored and reset every frame. During a replay only,
  // rotate that freshly authored view around the action; when the replay ends
  // the next normal camera update restores the exact regular match framing.
  const replayOrbit = {
    yaw: 0,
    pitch: 0,
    session: false,
    drag: null as { pointerId: number; x: number; y: number } | null,
  };
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const resetReplayOrbit = () => {
    replayOrbit.yaw = 0;
    replayOrbit.pitch = 0;
    const drag = replayOrbit.drag;
    if (drag && canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    replayOrbit.drag = null;
  };
  const nudgeReplayOrbit = (yaw: number, pitch: number) => {
    if (!match?.isReplayActive) return;
    replayOrbit.yaw = clamp(replayOrbit.yaw + yaw, -Math.PI, Math.PI);
    // Keep the eye inside the gym and above the court while still allowing a
    // low or elevated inspection of a backflip/reception.
    replayOrbit.pitch = clamp(replayOrbit.pitch + pitch, -0.62, 0.62);
  };
  const replayFocus = (): Vector3 | null => {
    if (!match?.isReplayActive || chars.length === 0) return null;
    // Prefer the action owner; late in a flight, choose the closest player so
    // the focal point stays with the readable action rather than a fixed end.
    const actionActor = chars.find((c) => c.busy);
    let actor = actionActor ?? chars[0];
    if (!actionActor) {
      for (const c of chars) {
        if (Vector3.DistanceSquared(c.position, ball.state.pos) < Vector3.DistanceSquared(actor.position, ball.state.pos)) {
          actor = c;
        }
      }
    }
    const focus = Vector3.Lerp(actor.position, ball.state.pos, 0.46);
    focus.y = clamp(focus.y + actor.height * 0.3, GROUND_Y + 0.7, GROUND_Y + 3.3);
    return focus;
  };
  const applyReplayOrbit = (camera: TargetCamera) => {
    if (Math.abs(replayOrbit.yaw) < 1e-4 && Math.abs(replayOrbit.pitch) < 1e-4) return;
    const focus = replayFocus();
    if (!focus) return;

    // `updateCamera()` has just restored the safe authored replay shot,
    // including +/- zoom. Rotate its vector instead of swapping camera types,
    // so lens settings and controls cannot leak into the live match. Bounds
    // protect P2's asymmetric interior camera from the outer gym shell.
    const offset = camera.position.subtract(focus);
    const radius = clamp(offset.length(), 4.5, 13);
    const baseElevation = Math.atan2(offset.y, Math.max(0.001, Math.hypot(offset.x, offset.z)));
    const elevation = clamp(baseElevation + replayOrbit.pitch, -0.08, 1.2);
    const azimuth = Math.atan2(offset.z, offset.x) + replayOrbit.yaw;
    const horizontal = radius * Math.cos(elevation);
    camera.position.set(
      clamp(focus.x + horizontal * Math.cos(azimuth), -12.0, 9.4),
      clamp(focus.y + radius * Math.sin(elevation), GROUND_Y + 1.1, GROUND_Y + 10),
      clamp(focus.z + horizontal * Math.sin(azimuth), -7.6, 7.6)
    );
    camera.setTarget(focus);
  };
  const beginReplayDrag = (e: PointerEvent) => {
    if (!match?.isReplayActive || (e.pointerType === "mouse" && e.button !== 0)) return;
    replayOrbit.drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const moveReplayDrag = (e: PointerEvent) => {
    const drag = replayOrbit.drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    nudgeReplayOrbit(dx * 0.007, -dy * 0.0055);
    e.preventDefault();
  };
  const endReplayDrag = (e: PointerEvent) => {
    if (replayOrbit.drag?.pointerId !== e.pointerId) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    replayOrbit.drag = null;
  };
  canvas.addEventListener("pointerdown", beginReplayDrag);
  canvas.addEventListener("pointermove", moveReplayDrag);
  canvas.addEventListener("pointerup", endReplayDrag);
  canvas.addEventListener("pointercancel", endReplayDrag);

  // ---- pause ----
  let paused = false;
  let shutdownInProgress = false;
  const canShutdownLocalServer = import.meta.env.DEV;
  const leaveMatch = () => {
    session?.dispose();
    session = null;
    netConn?.close();
    netConn = null;
    practiceCoach?.dispose();
    practiceCoach = null;
    for (const c of chars) c.dispose();
    chars = [];
    match = null;
    aiCtl = null;
    disableSplit();
    audio.startMusic();
    showModes();
  };
  /**
   * The browser is never allowed to stop a production host. In a Vite dev
   * session this reaches the explicitly scoped same-origin endpoint supplied
   * by vite.config.ts, then stops the local game loop after Vite acknowledges
   * the request.
   */
  const shutdownLocalServer = async () => {
    if (!canShutdownLocalServer || shutdownInProgress) return;
    shutdownInProgress = true;
    audio.stopMusic();
    try {
      const response = await fetch("/__teqopen/dev/shutdown", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`shutdown endpoint returned ${response.status}`);
      ui.hidePause();
      ui.showLoading("Local server stopped. You can close this tab.");
      gs.engine.stopRenderLoop();
    } catch (error) {
      // Keep the match frozen and return the player to a usable pause menu if
      // the dev process disappeared before it could acknowledge the request.
      console.warn("[shutdown] local server did not acknowledge request:", error);
      shutdownInProgress = false;
      showPauseMenu();
    }
  };
  const showPauseMenu = () => {
    ui.showPause(
      () => setPaused(false),
      () => {
        match?.reset();
        practiceCoach?.reset();
        practiceCoach?.start();
        setPaused(false);
      },
      () => {
        paused = false;
        ui.hidePause();
        leaveMatch();
      },
      // Fire-and-forget: shutdownLocalServer reports its own failures.
      canShutdownLocalServer ? () => void shutdownLocalServer() : undefined
    );
  };
  const setPaused = (v: boolean) => {
    // A guided lesson owns its own short-lived pause card. Do not stack the
    // full pause menu on top of it or let Escape skip the lesson by accident.
    if (practiceCoach?.isPaused) return;
    if (!match || paused === v) return;
    paused = v;
    if (v) {
      showPauseMenu();
    } else {
      ui.hidePause();
    }
  };
  const cycleCameraMode = () => {
    if (!match || match.isReplayActive || paused || freecam || viewer.active) return;
    const modes: CameraMode[] = ["court", "side", "top"];
    cameraMode = modes[(modes.indexOf(cameraMode) + 1) % modes.length];
    ui.setCameraMode(cameraMode);
    const label = cameraMode === "court" ? "COURT VIEW" : cameraMode === "side" ? "SIDE VIEW" : "TOP VIEW";
    ui.banner(label, "C or Y / △ to switch");
  };
  const requestPauseToggle = () => {
    // The replay transport owns pause while a highlight is on screen; never
    // put the match pause overlay over its touch controls.
    if (match?.isReplayActive) {
      match.controlReplay("toggle");
      return;
    }
    // Online: a pause belongs to both players, so it is asked for rather than
    // taken. Outside a private game there is no request to make.
    if (session) {
      if (session.pauseAllowed) session.requestPause();
      else ui.banner("PAUSE UNAVAILABLE", "Only in games with a friend");
      return;
    }
    if (!practiceCoach?.isPaused) setPaused(!paused);
  };
  ui.onPauseRequest = requestPauseToggle;
  ui.onCameraRequest = cycleCameraMode;
  ui.onReplayControl = (control) => {
    if (control === "reset-camera") {
      resetReplayOrbit();
      return;
    }
    match?.controlReplay(control);
  };
  const hasBlockingScreen = () =>
    ["title-screen", "menu-screen", "standings-screen", "select-screen", "end-screen"].some(
      (id) => !document.getElementById(id)?.classList.contains("hidden")
    );

  // ---- pad/keyboard menu navigation ----
  // Overlays (end, pause) come last so they win over the screens they cover.
  const NAV_SCREENS = ["title-screen", "menu-screen", "standings-screen", "select-screen", "end-screen", "pause-screen"];
  let navFocus: HTMLButtonElement | null = null;
  const menuNav = () => {
    const nav = input.pollMenuNav(); // poll every frame so edge states stay fresh
    let target: HTMLElement | null = null;
    for (const id of NAV_SCREENS) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("hidden")) target = el;
    }
    if (!target) {
      navFocus?.classList.remove("pad-focus");
      navFocus = null;
      return;
    }
    if (nav.back) {
      const back = target.querySelector<HTMLButtonElement>("button[data-menu-back]");
      if (back && back.offsetParent !== null) {
        back.click();
        return;
      }
    }
    const btns = [...target.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.offsetParent !== null
    );
    if (btns.length === 0) return;
    if (!navFocus || !btns.includes(navFocus)) {
      navFocus?.classList.remove("pad-focus");
      navFocus = btns.find((b) => b.dataset.menuPrimary === "true") ?? btns[0];
      navFocus.classList.add("pad-focus");
    }
    const idx = btns.indexOf(navFocus);
    const next = nav.down ? (idx + 1) % btns.length : nav.up ? (idx - 1 + btns.length) % btns.length : idx;
    if (next !== idx) {
      navFocus.classList.remove("pad-focus");
      navFocus = btns[next];
      navFocus.classList.add("pad-focus");
    }
    if (nav.confirm) navFocus.click();
  };

  gs.engine.runRenderLoop(() => {
    // Frame time drives everything presentational (the model viewer, the
    // replay orbit). Gameplay is stepped separately, at SIM_DT.
    const dt = Math.min(gs.engine.getDeltaTime() / 1000, MAX_FRAME_DT) * timeScale;
    menuNav();
    // Poll even off-court so a held C / Y can never leak into the next match.
    const cameraCycle = input.pollCameraCycle();
    const replayControls = input.pollReplayControls();
    const pauseControls = input.pollPauseControls();
    if (viewer.active) {
      viewer.update(dt);
      viewer.scene.render();
      return;
    }
    // A replay owns Start/Options: it toggles replay playback rather than the
    // match pause menu. Escape retains its established role of skipping it.
    if (match?.hasReplayPresentation) {
      if (pauseControls.escape) match.controlReplay("skip");
    } else if (
      pauseControls.toggle &&
      match &&
      !practiceCoach?.isPaused &&
      !hasBlockingScreen()
    ) {
      requestPauseToggle();
    }
    if (paused) {
      input.poll(cameraMode); // discard queued presses so nothing fires on resume
      return; // no update, no render: the frame freezes under the overlay
    }
    if (practiceCoach?.isPaused) {
      // The card uses the same action buttons as the game, but this frame is
      // consumed as CONTINUE so it can never leak into a serve or return.
      practiceCoach.updatePaused(input.poll(cameraMode));
      gs.scene.render();
      return;
    }
    // Replay commands and view cycling settle before either local player's
    // gameplay poll, so P1 and P2 use the same mapping on the cycle frame.
    if (match?.hasReplayPresentation) {
      if (replayControls.skip) match.controlReplay("skip");
      else {
        if (replayControls.back) match.controlReplay("back");
        if (replayControls.forward) match.controlReplay("forward");
        if (replayControls.zoomOut) match.controlReplay("zoom-out");
        if (replayControls.zoomIn) match.controlReplay("zoom-in");
        if (replayControls.toggle) match.controlReplay("toggle");
      }
    }
    if (cameraCycle && match) {
      if (match.isReplayActive) resetReplayOrbit();
      else cycleCameraMode();
    }
    const inp = input.poll(cameraMode);
    if (introLeft !== null) {
      // Any deliberate press skips the shot. The press is spent doing that
      // rather than falling through to a serve, which is why this returns.
      const skip = inp.confirmPressed || inp.strikePressed || inp.popPressed || cameraCycle;
      // Wall-clock, not `dt`: `dt` is capped at MAX_FRAME_DT so a stalled
      // frame cannot inject a huge simulation step, and the intro plays right
      // after a load, which is exactly when frames stall. Counting it in
      // capped steps would stretch a 3.6 s shot to whatever the framerate
      // felt like.
      introLeft = skip ? 0 : introLeft - Math.min(0.25, gs.engine.getDeltaTime() / 1000);
      if (introLeft <= 0) {
        introLeft = null;
        ui.hideIntro();
      } else if (match) {
        // The play camera first, so the shot has a live pose to arrive at.
        match.updateCamera(gs.camera, cameraMode);
        const end = {
          x: gs.camera.position.x,
          y: gs.camera.position.y,
          z: gs.camera.position.z,
          tx: gs.camera.getTarget().x,
          ty: gs.camera.getTarget().y,
          tz: gs.camera.getTarget().z,
        };
        const shot = introPose(1 - introLeft / INTRO_SECONDS, end, venueFor(venueId).sweep);
        gs.camera.position.set(shot.x, shot.y, shot.z);
        gs.camera.setTarget(new Vector3(shot.tx, shot.ty, shot.tz));
        gs.scene.render();
        return;
      }
    }
    if (match) {
      // Portrait has no stick: the player is placed by tapping the court, so
      // the axes are free to carry a gesture's aim instead of steering. Only
      // on a touch screen — a narrow desktop window has a keyboard, and taking
      // its movement away would leave the player rooted to the spot.
      match.tapSteering = input.isTouch && input.isPortrait;
      const placement = input.pollTapPlacement();
      if (placement && !freecam && !match.isReplayActive) {
        match.setMoveTarget(courtPointAt(placement.x, placement.y));
      }
      latchInput(latchedP1, inp);
      if (versusCam) {
        // Player 2's device, flipped into their court frame (they attack -x).
        const p2 = input.pollP2(cameraMode);
        latchInput(latchedP2, { ...p2, moveX: -p2.moveX, moveZ: -p2.moveZ });
      }
      // Step the match in fixed SIM_DT slices, consuming whatever real time
      // this frame delivered. A slow frame runs several steps, a fast one may
      // run none — which is why the presses are latched rather than sampled.
      simAccumulator += dt;
      let steps = 0;
      while (simAccumulator >= SIM_DT && steps < maxSimSteps) {
        const stepInput = consumeInput(latchedP1);
        if (versusCam) match.versusInput = consumeInput(latchedP2);
        // A guest's controls belong to the host's match, so they go to the
        // wire before the local update — which, as a follower, ignores them.
        session?.setLocalInput(stepInput);
        // A negotiated pause freezes the match on both peers, but not the
        // session: traffic has to keep flowing or a pause would look exactly
        // like a disconnect and forfeit the game it was meant to interrupt.
        if (!session?.isPaused) {
          match.update(SIM_DT, freecam ? idleInput : stepInput, (d) => aiCtl?.update(d));
          practiceCoach?.update(SIM_DT, stepInput);
        }
        // Stepped with the simulation, not the frame, so the tick stamped on
        // outgoing messages is the same clock the receiver counts against.
        session?.step(SIM_DT);
        simAccumulator -= SIM_DT;
        steps++;
      }
      // A frame long enough to exhaust the step budget (tab restore, a GC
      // pause) drops the remainder instead of trying to catch up forever.
      if (steps >= maxSimSteps) simAccumulator = 0;
      // While a replay is active, a dedicated WASD/analogue-only poll drives
      // the free-angle orbit. D-pad/arrows stay assigned to the replay
      // timeline transport above, so a seek never rotates view.
      if (match.isReplayActive) {
        if (!replayOrbit.session) {
          resetReplayOrbit();
          replayOrbit.session = true;
        }
        const orbit = input.pollReplayOrbit();
        nudgeReplayOrbit(orbit.x * dt * 1.55, -orbit.y * dt * 1.1);
      } else if (replayOrbit.session) {
        resetReplayOrbit();
        replayOrbit.session = false;
      }
      if (!freecam) {
        match.updateCamera(gs.camera, cameraMode);
        if (versusCam) match.updateCamera2(versusCam, cameraMode);
        if (match.isReplayActive) {
          applyReplayOrbit(gs.camera);
          if (versusCam) applyReplayOrbit(versusCam);
        }
      }
    }
    // The crowd runs on wall-clock time and outside the simulation: it is
    // scenery, it must not consume simulation steps, and it keeps moving
    // through a replay or a menu sitting over the court.
    gs.scene.render();
  });

  const showTitle = () => {
    ui.showTitle(() => {
      audio.startMusic();
      // Prefetch the decorative gym only after the first screen is visible.
      // The model viewer and selection menus give it time to arrive without
      // making the initial page appear stuck on “Building the court…”.
      void gs.ensureArena();
      showModes();
    });
  };

  // ------------------------------------------------------------- mode flow

  const showModes = () => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    ui.showMenu(
      "GAME MODE",
      [
        { id: "btn-mode-practice", label: "PRACTICE", sub: "Learn one skill at a time", tag: "LEARN" },
        {
          id: "btn-mode-friendly",
          label: "FRIENDLY",
          sub: "Start a quick match against the CPU",
          tag: "QUICK PLAY",
          primary: true,
        },
        { id: "btn-mode-competition", label: "COMPETITION", sub: "Play a cup or league campaign", tag: "TOURNAMENT" },
        { id: "btn-mode-online", label: "PLAY ONLINE", sub: "Take on another player over the net", tag: "ONLINE" },
        { id: "btn-mode-versus", label: "2 PLAYERS", sub: "Share the court in split screen", tag: "LOCAL" },
        {
          id: "btn-mode-settings",
          label: "SETTINGS",
          sub: `Graphics ${TIER_LABELS[qualityTier].label} · venue ${venueFor(venueId).label}`,
          tag: "OPTIONS",
        },
      ],
      (id) => {
        if (id === "btn-mode-practice") showPractice();
        else if (id === "btn-mode-friendly") showDifficulty();
        else if (id === "btn-mode-competition") showFormats();
        else if (id === "btn-mode-online") showOnline();
        else if (id === "btn-mode-settings") showSettings();
        else showVersusSelect();
      },
      "Pick a route and get on the table.",
      showTitle
    );
  };

  const showSettings = () => {
    ui.showMenu(
      "SETTINGS",
      [
        {
          id: "btn-settings-graphics",
          label: "GRAPHICS",
          sub: `Framerate against detail · currently ${TIER_LABELS[qualityTier].label}`,
          tag: TIER_LABELS[qualityTier].label,
          primary: true,
        },
        {
          id: "btn-settings-venue",
          label: "VENUE",
          sub: `Where the court is set up · currently ${venueFor(venueId).label}`,
          tag: "LOOK",
        },
      ],
      (id) => {
        if (id === "btn-settings-graphics") showGraphics();
        else showVenues();
      },
      "Change how the game looks and how hard it works your phone.",
      showModes
    );
  };

  /**
   * Venue picker. Swaps in place — reloading the page for a cosmetic choice
   * threw away the player's whole session.
   */
  const showVenues = () => {
    ui.showMenu(
      "VENUE",
      VENUE_IDS.map((id) => {
        const v = venueFor(id);
        return {
          id: `btn-venue-${id}`,
          label: v.label,
          sub: id === venueId ? `${v.sub} · IN USE` : v.sub,
          tag: id === venueId ? "CURRENT" : undefined,
          primary: id === venueId,
        };
      }),
      (id) => {
        const picked = VENUE_IDS.find((v) => id === `btn-venue-${v}`);
        if (!picked) return;
        if (picked === venueId) {
          showSettings();
          return;
        }
        storeVenue(picked);
        venueId = picked;
        ui.showLoading("Setting up the new court…");
        void gs.setVenue(venueFor(picked)).then(showSettings);
      },
      "The venue is yours alone — an opponent online keeps their own.",
      showSettings
    );
  };

  /**
   * Graphics quality picker. Applying a tier reloads the page rather than
   * reconfiguring a live scene: the engine's MSAA is fixed at context
   * creation, and rebuilding the shadow generator and its caster list mid-match
   * is a lot of moving parts for a setting players change once. A reload from
   * the packaged app is cheap because every asset is already local.
   */
  const showGraphics = () => {
    ui.showMenu(
      "GRAPHICS",
      QUALITY_TIERS.map((tier) => ({
        id: `btn-quality-${tier}`,
        label: TIER_LABELS[tier].label,
        sub: tier === qualityTier ? `${TIER_LABELS[tier].sub} · IN USE` : TIER_LABELS[tier].sub,
        tag: tier === qualityTier ? "CURRENT" : undefined,
        primary: tier === qualityTier,
      })),
      (id) => {
        const picked = QUALITY_TIERS.find((tier) => id === `btn-quality-${tier}`);
        if (!picked) return;
        if (picked === qualityTier) {
          showSettings();
          return;
        }
        storeTier(picked);
        ui.showLoading("Applying graphics settings…");
        location.reload();
      },
      "Lower settings mean a smoother game on older phones.",
      showSettings
    );
  };

  // ------------------------------------------------------------ online play

  /**
   * Start an online match once a seat is secured.
   *
   * Both peers pick their own character, then exchange the choice before
   * anything loads: neither can pick the other's model for it, and the models
   * have to be known before the scene is built. The listener is installed
   * before the picker opens, because an opponent who chooses first would
   * otherwise have their message arrive with nobody listening.
   *
   * The ball has to be one ball, so the host's choice settles it.
   */
  const startOnlineMatch = (conn: NetConnection, role: PeerRole, isPrivate: boolean) => {
    let mine: { character: string; ball: string } | null = null;
    let theirs: { character: string; ball: string } | null = null;
    let launched = false;

    const launch = () => {
      if (launched || !mine || !theirs) return;
      launched = true;
      const me = CHARACTERS.find((c) => c.id === mine!.character) ?? CHARACTERS[0];
      const them = CHARACTERS.find((c) => c.id === theirs!.character) ?? CHARACTERS[0];
      const ballId = role === "host" ? mine.ball : theirs.ball;
      void startMatch(me, ballId, {
        opponent: them,
        difficulty: "normal",
        versus: null,
        online: { conn, role, private: isPrivate },
        labels: ["YOU", "RIVAL"],
        onEnd: (winner) => {
          ui.showEnd(winner, () => leaveMatch(), () => leaveMatch());
        },
      });
    };

    conn.setHandlers({
      onMessage: (msg) => {
        if (!isValidSetup(msg)) return;
        theirs = { character: msg.character, ball: msg.ball };
        launch();
      },
    });

    showSelect("CHOOSE YOUR PLAYER", (charId, ballId) => {
      mine = { character: charId, ball: ballId };
      conn.send({ t: "setup", character: charId, ball: ballId });
      ui.showLobbyStatus("READY", "Waiting for your opponent to choose…", null, abandonLobby);
      launch();
    }, showOnline);
  };

  /** Abandon whatever the lobby was doing and return to the mode menu. */
  const abandonLobby = () => {
    netConn?.close();
    netConn = null;
    showModes();
  };

  const quickMatch = () => {
    if (!onlineAvailable) return;
    const conn = new NetConnection(relayUrl(), {
      onQueued: (ahead) =>
        ui.setLobbyDetail(
          ahead === 0 ? "Waiting for an opponent…" : `Waiting — ${ahead} ahead of you`
        ),
    });
    netConn = conn;
    ui.showLobbyStatus("QUICK MATCH", "Connecting…", null, abandonLobby);
    conn
      .quickMatch()
      .then(({ role }) => startOnlineMatch(conn, role, false))
      .catch((e: unknown) => {
        if (netConn !== conn) return; // the player already cancelled
        ui.showLobbyStatus(
          "NO GAME FOUND",
          e instanceof Error ? e.message : "Could not find an opponent",
          null,
          abandonLobby
        );
      });
  };

  const hostPrivateGame = () => {
    if (!onlineAvailable) return;
    const code = makeRoomCode();
    const conn = new NetConnection(relayUrl(), {
      onPeer: (present) => {
        if (present) ui.setLobbyDetail("Opponent joined — starting…");
      },
    });
    netConn = conn;
    ui.showLobbyStatus("PLAY A FRIEND", "Connecting…", code, abandonLobby);
    conn
      .join(code)
      .then(({ ready }) => {
        if (ready) return { role: "host" as PeerRole };
        ui.setLobbyDetail("Give this code to your friend");
        // join resolves on being seated; wait for the opponent to fill the
        // second seat before there is a match to start.
        return new Promise<{ role: PeerRole }>((resolve) => {
          conn.setHandlers({
            onPeer: (present) => {
              if (present) resolve({ role: "host" });
            },
          });
        });
      })
      .then(({ role }) => startOnlineMatch(conn, role, true))
      .catch((e: unknown) => {
        if (netConn !== conn) return;
        ui.showLobbyStatus(
          "COULD NOT HOST",
          e instanceof Error ? e.message : "Something went wrong",
          null,
          abandonLobby
        );
      });
  };

  const joinPrivateGame = () => {
    if (!onlineAvailable) return;
    ui.showCodeEntry(
      "ENTER THE CODE",
      "ABC12",
      (typed) => {
        const code = normalizeRoomCode(typed);
        if (!isValidRoomCode(code)) {
          ui.showLobbyStatus("BAD CODE", "That is not a valid room code", null, showOnline);
          return;
        }
        const conn = new NetConnection(relayUrl());
        netConn = conn;
        ui.showLobbyStatus("JOINING", "Connecting…", code, abandonLobby);
        conn
          .join(code)
          .then(({ role, ready }) => {
            if (!ready) {
              // Seated, but alone: the host left between hosting and joining.
              ui.setLobbyDetail("Waiting for the host…");
              conn.setHandlers({ onPeer: (p) => p && startOnlineMatch(conn, role, true) });
              return;
            }
            startOnlineMatch(conn, role, true);
          })
          .catch((e: unknown) => {
            if (netConn !== conn) return;
            ui.showLobbyStatus(
              "COULD NOT JOIN",
              e instanceof Error ? e.message : "That game is not available",
              null,
              showOnline
            );
          });
      },
      showOnline
    );
  };

  const showOnline = () => {
    if (!onlineAvailable) {
      ui.showLobbyStatus(
        "ONLINE UNAVAILABLE",
        "This build has no match server configured",
        null,
        showModes
      );
      return;
    }
    ui.showMenu(
      "PLAY ONLINE",
      [
        {
          id: "btn-online-quick",
          label: "QUICK MATCH",
          sub: "Get paired with another player",
          tag: "FASTEST",
          primary: true,
        },
        { id: "btn-online-host", label: "PLAY A FRIEND", sub: "Create a game and share the code", tag: "PRIVATE" },
        { id: "btn-online-join", label: "ENTER A CODE", sub: "Join a friend's game", tag: "PRIVATE" },
      ],
      (id) => {
        if (id === "btn-online-quick") quickMatch();
        else if (id === "btn-online-host") hostPrivateGame();
        else joinPrivateGame();
      },
      "Play someone else, wherever they are.",
      showModes
    );
  };

  const showPractice = () => {
    // The trainer is fixed, so it is a safe useful prefetch while the user is
    // choosing their own player.
    scheduleAssetPrefetch("/models/characters/SpanishPlayer.glb", 700);
    showSelect("PRACTICE SETUP", (charId, ballId) => {
      const playerDef = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
      const trainer =
        CHARACTERS.find((c) => c.id !== playerDef.id && c.id === "SpanishPlayer") ??
        CHARACTERS.find((c) => c.id !== playerDef.id) ??
        CHARACTERS[0];
      void startMatch(playerDef, ballId, {
        opponent: trainer,
        difficulty: "easy",
        versus: null,
        labels: ["YOU", "TRAINER"],
        practice: true,
        onEnd: () => match?.reset(),
      });
    }, showModes);
  };

  const showDifficulty = () => {
    ui.showMenu(
      "DIFFICULTY",
      [
        { id: "btn-diff-easy", label: "EASY", sub: "Relaxed rallies and extra room", tag: "RELAXED" },
        { id: "btn-diff-normal", label: "NORMAL", sub: "A balanced match", tag: "RECOMMENDED", primary: true },
        { id: "btn-diff-hard", label: "HARD", sub: "Tournament pace and sharper returns", tag: "CHALLENGE" },
      ],
      (id) => {
        const diff = id.replace("btn-diff-", "") as DifficultyLevel;
        showSelect("CHOOSE YOUR SETUP", (charId, ballId) => {
          const playerDef = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
          const others = CHARACTERS.filter((c) => c.id !== charId);
          const opponent = others[Math.floor(Math.random() * others.length)];
          void startMatch(playerDef, ballId, {
            opponent,
            difficulty: diff,
            versus: null,
            labels: ["YOU", opponent.label],
            onEnd: (winner) => {
              ui.showEnd(winner, () => match?.reset(), () => leaveMatch());
            },
          });
        }, showDifficulty);
      },
      "Friendly match",
      showModes
    );
  };

  const showFormats = () => {
    ui.showMenu(
      "COMPETITION",
      [
        { id: "btn-format-cup", label: "CUP", sub: "A knockout run to the final", tag: "ELIMINATION", primary: true },
        { id: "btn-format-league", label: "LEAGUE", sub: "Three rounds. Every result counts.", tag: "ROUND ROBIN" },
      ],
      (id) => {
        const format = id === "btn-format-cup" ? ("cup" as const) : ("league" as const);
        showSelect("CHOOSE YOUR SETUP", (charId, ballId) => {
          startCompetition(format, charId, ballId);
        }, showFormats);
      },
      "Build your run",
      showModes
    );
  };

  const showVersusSelect = () => {
    if (!input.hasGamepad()) {
      ui.showMenu(
        "2 PLAYERS",
        [
          { id: "btn-versus-retry", label: "CHECK CONTROLLER", sub: "Press a controller button, then try again", tag: "RETRY", primary: true },
          {
            id: "btn-versus-kb",
            label: "SHARED KEYBOARD",
            sub: "P1: WASD + SPACE/K · P2: ARROWS + ENTER/R-SHIFT",
            tag: "LOCAL",
          },
        ],
        (id) => {
          if (id === "btn-versus-retry") showVersusSelect();
          else versusSelectFlow({ p1: "kbWASD", p2: "kbArrows" });
        },
        "Connect a controller, or share one keyboard.",
        showModes
      );
      return;
    }
    console.log("[versus] pads:", input.padCount(), input.padName());
    showVersusDevices();
  };

  /** Let the players decide who uses which device (controller order included). */
  const showVersusDevices = () => {
    const pads = input.padCount();
    const options =
      pads >= 2
        ? [
            { id: "btn-assign-a", label: "P1 CONTROLLER 1 · P2 CONTROLLER 2", assign: { p1: "pad1", p2: "pad2" } as VersusAssign },
            { id: "btn-assign-b", label: "P1 CONTROLLER 2 · P2 CONTROLLER 1", assign: { p1: "pad2", p2: "pad1" } as VersusAssign },
            { id: "btn-assign-c", label: "P1 KEYBOARD · P2 CONTROLLER 1", assign: { p1: "kb", p2: "pad1" } as VersusAssign },
            { id: "btn-assign-d", label: "SHARED KEYBOARD", sub: "P1 WASD + SPACE/K · P2 ARROWS + ENTER/R-SHIFT", assign: { p1: "kbWASD", p2: "kbArrows" } as VersusAssign },
          ]
        : [
            { id: "btn-assign-a", label: "P1 KEYBOARD · P2 CONTROLLER", assign: { p1: "kb", p2: "pad1" } as VersusAssign },
            { id: "btn-assign-b", label: "P1 CONTROLLER · P2 KEYBOARD", assign: { p1: "pad1", p2: "kb" } as VersusAssign },
            { id: "btn-assign-c", label: "SHARED KEYBOARD", sub: "P1 WASD + SPACE/K · P2 ARROWS + ENTER/R-SHIFT", assign: { p1: "kbWASD", p2: "kbArrows" } as VersusAssign },
          ];
    ui.showMenu(
      "WHO PLAYS WITH WHAT?",
      options.map(({ id, label, sub }) => ({ id, label, sub })),
      (picked) => {
        const opt = options.find((o) => o.id === picked)!;
        versusSelectFlow(opt.assign);
      },
      pads >= 2 ? "Two controllers detected" : "One controller detected",
      showModes
    );
  };

  const versusSelectFlow = (assign: VersusAssign) => {
    const showPlayerOne = () => {
      showSelect("PLAYER 1 — CHOOSE", (p1Id) => {
        // Both players get the same picker; the ball is shared, last choice wins.
        showSelect("PLAYER 2 — CHOOSE", (p2Id, ballId) => {
          const p1 = CHARACTERS.find((c) => c.id === p1Id) ?? CHARACTERS[0];
          const p2 = CHARACTERS.find((c) => c.id === p2Id) ?? CHARACTERS[1];
          void startMatch(p1, ballId, {
            opponent: p2,
            difficulty: "normal",
            versus: assign,
            labels: ["P1", "P2"],
            onEnd: (winner) => {
              ui.showEnd(winner, () => match?.reset(), () => leaveMatch());
            },
          });
        }, showPlayerOne);
      }, showVersusDevices);
    };
    showPlayerOne();
  };

  const showSelect = (
    title: string,
    onConfirm: (charId: string, ballId: string) => void,
    onBack: () => void
  ) => {
    viewer.activate();
    input.setTouchControlsEnabled(false);
    // WHITE is the default picker item and the most common choice. Begin it
    // at idle priority while the selected character preview is being readied.
    scheduleAssetPrefetch(`/models/Ball_and_Table/${BALLS[0].id}.glb`, 900);
    ui.showSelect({
      characters: CHARACTERS,
      balls: BALLS,
      title,
      onBrowse: async (kind, id) => {
        const shown = await viewer.show(kind, id);
        // If the player is browsing, make the next arrow press instant on a
        // normal connection. Only one adjacent item is scheduled at a time;
        // slow/data-saver connections skip this entirely above.
        const list = kind === "character" ? CHARACTERS : BALLS;
        const index = list.findIndex((item) => item.id === id);
        if (index >= 0 && list.length > 1) {
          const next = list[(index + 1) % list.length];
          scheduleAssetPrefetch(
            kind === "character"
              ? `/models/characters/${next.id}.glb`
              : `/models/Ball_and_Table/${next.id}.glb`,
            1600
          );
        }
        return shown;
      },
      onConfirm: (charId, ballId) => {
        viewer.deactivate();
        onConfirm(charId, ballId);
      },
      onBack: () => {
        viewer.deactivate();
        onBack();
      },
    });
  };

  // ---------------------------------------------------------- competitions

  /** Trait-weighted coin flip for CPU-vs-CPU matches (winner takes 2 sets). */
  const simulateMatch = (a: CharacterDef, b: CharacterDef): { winA: boolean; sets: [number, number] } => {
    const rate = (d: CharacterDef) => d.power * 1.5 + d.precision + d.speed / 4.5;
    const ra = rate(a) ** 2;
    const rb = rate(b) ** 2;
    const winA = Math.random() < ra / (ra + rb);
    const loserSets = Math.random() < 0.45 ? 1 : 0;
    return { winA, sets: winA ? [2, loserSets] : [loserSets, 2] };
  };

  const scoreline = (a: CharacterDef, b: CharacterDef, sets: [number, number]) =>
    `${a.label} <b>${sets[0]} : ${sets[1]}</b> ${b.label}`;

  const playCompMatch = (
    human: CharacterDef,
    opponent: CharacterDef,
    ballId: string,
    difficulty: DifficultyLevel,
    onEnd: (won: boolean, sets: [number, number]) => void
  ) => {
    void startMatch(human, ballId, {
      opponent,
      difficulty,
      versus: null,
      labels: ["YOU", opponent.label],
      onEnd: (winner, sets) => onEnd(winner === "player", sets),
    });
  };

  const startCompetition = (format: "cup" | "league", charId: string, ballId: string) => {
    const human = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
    const others = CHARACTERS.filter((c) => c.id !== human.id).sort(() => Math.random() - 0.5);
    if (format === "cup") runCup(human, others, ballId);
    else runLeague(human, others, ballId);
  };

  const runCup = (human: CharacterDef, others: CharacterDef[], ballId: string) => {
    // Draw: SF1 = human vs others[0], SF2 = others[1] vs others[2].
    const [sf1Opp, sf2a, sf2b] = others;
    ui.showStandings("CUP — THE DRAW", [
      `SEMI-FINAL 1 — ${human.label} vs ${sf1Opp.label}`,
      `SEMI-FINAL 2 — ${sf2a.label} vs ${sf2b.label}`,
      `then the losers meet for 3rd place and the winners for the trophy`,
    ], "PLAY SEMI-FINAL", () => {
      playCompMatch(human, sf1Opp, ballId, "normal", (won, sets) => {
        const sf2 = simulateMatch(sf2a, sf2b);
        const sf2Winner = sf2.winA ? sf2a : sf2b;
        const sf2Loser = sf2.winA ? sf2b : sf2a;
        const finalOpp = won ? sf2Winner : sf2Loser;
        const finalName = won ? "WINNER FINAL" : "LOSER FINAL (3rd place)";
        ui.showStandings("CUP — SEMI-FINALS", [
          scoreline(human, sf1Opp, sets),
          scoreline(sf2a, sf2b, sf2.sets),
          `next: ${finalName} — ${human.label} vs ${finalOpp.label}`,
        ], "PLAY FINAL", () => {
          playCompMatch(human, finalOpp, ballId, "hard", (wonFinal, finalSets) => {
            // The final the human didn't play, simulated between the two others:
            // the 3rd-place match if the human reached the winner final, or the
            // winner final if the human dropped to the 3rd-place match.
            const pair: [CharacterDef, CharacterDef] = won ? [sf1Opp, sf2Loser] : [sf1Opp, sf2Winner];
            const sim = simulateMatch(pair[0], pair[1]);
            const simWinner = sim.winA ? pair[0] : pair[1];
            const simLoser = sim.winA ? pair[1] : pair[0];
            const standings: string[] = won
              ? wonFinal
                ? [`🏆 CHAMPION — ${human.label}`, `2nd — ${finalOpp.label}`,
                   `3rd — ${simWinner.label}`, `4th — ${simLoser.label}`]
                : [`🏆 CHAMPION — ${finalOpp.label}`, `2nd — ${human.label}`,
                   `3rd — ${simWinner.label}`, `4th — ${simLoser.label}`]
              : wonFinal
                ? [`🏆 CHAMPION — ${simWinner.label}`, `2nd — ${simLoser.label}`,
                   `3rd — ${human.label}`, `4th — ${finalOpp.label}`]
                : [`🏆 CHAMPION — ${simWinner.label}`, `2nd — ${simLoser.label}`,
                   `3rd — ${finalOpp.label}`, `4th — ${human.label}`];
            ui.showStandings("CUP — FINAL RESULT", [
              `your final: ${scoreline(human, finalOpp, finalSets)}`,
              ...standings,
            ], "BACK TO MENU", () => leaveMatch());
          });
        });
      });
    });
  };

  const runLeague = (human: CharacterDef, others: CharacterDef[], ballId: string) => {
    const players = [human, ...others]; // human = index 0
    // Standard 4-player round robin; the human plays one match per round.
    const rounds: [number, number][][] = [
      [[0, 1], [2, 3]],
      [[0, 2], [1, 3]],
      [[0, 3], [1, 2]],
    ];
    const table = players.map(() => ({ pts: 0, diff: 0 }));
    const record = (a: number, b: number, sets: [number, number]) => {
      table[a].pts += sets[0] > sets[1] ? 3 : 0;
      table[b].pts += sets[1] > sets[0] ? 3 : 0;
      table[a].diff += sets[0] - sets[1];
      table[b].diff += sets[1] - sets[0];
    };
    const tableRows = () =>
      players
        .map((p, i) => ({ p, ...table[i] }))
        .sort((x, y) => y.pts - x.pts || y.diff - x.diff)
        .map((r, i) => `${i + 1}. ${r.p.label} — ${r.pts} pts (sets ${r.diff >= 0 ? "+" : ""}${r.diff})`);

    const playRound = (round: number) => {
      const [humanPair, cpuPair] = rounds[round];
      const opponent = players[humanPair[1]];
      const difficulty: DifficultyLevel = round === rounds.length - 1 ? "hard" : "normal";
      playCompMatch(human, opponent, ballId, difficulty, (_won, sets) => {
        record(humanPair[0], humanPair[1], sets);
        const sim = simulateMatch(players[cpuPair[0]], players[cpuPair[1]]);
        record(cpuPair[0], cpuPair[1], sim.sets);
        const rows = [
          scoreline(human, opponent, sets),
          scoreline(players[cpuPair[0]], players[cpuPair[1]], sim.sets),
          "—",
          ...tableRows(),
        ];
        if (round < rounds.length - 1) {
          ui.showStandings(`LEAGUE — ROUND ${round + 1}`, rows, "PLAY NEXT ROUND", () => playRound(round + 1));
        } else {
          const champion = tableRows()[0];
          ui.showStandings("LEAGUE — FINAL TABLE", [...rows, "—", `🏆 ${champion}`], "BACK TO MENU", () =>
            leaveMatch()
          );
        }
      });
    };
    ui.showStandings("LEAGUE — SCHEDULE", [
      `round 1: ${human.label} vs ${players[1].label} · ${players[2].label} vs ${players[3].label}`,
      `round 2: ${human.label} vs ${players[2].label} · ${players[1].label} vs ${players[3].label}`,
      `round 3: ${human.label} vs ${players[3].label} · ${players[1].label} vs ${players[2].label}`,
    ], "PLAY ROUND 1", () => playRound(0));
  };

  // ------------------------------------------------------------ match setup

  const startMatch = async (playerDef: CharacterDef, ballId: string, opts: MatchOpts) => {
    ui.showLoading("Loading the court…");
    input.setTouchControlsEnabled(true);
    practiceCoach?.dispose();
    practiceCoach = null;

    // If the user selected a match before the background prefetch finished,
    // keep the loading state honest and wait for the same memoized request.
    await gs.ensureArena();
    // The viewer has already warmed the selected character's HTTP cache while
    // the user browsed. Start the ball and both character imports together so
    // startup time is governed by the slowest asset rather than their sum.
    const needsNewBall = ballMeshId !== ballId;
    ui.setLoadingText(needsNewBall ? "Loading players and ball…" : "Loading players…");
    const ballTask = needsNewBall ? loadBall(gs.scene, ballId) : Promise.resolve(ballMesh);
    const [loadedBall, playerChar, aiChar] = await Promise.all([
      ballTask,
      Character.load(gs.scene, playerDef),
      Character.load(gs.scene, opts.opponent),
    ]);
    if (needsNewBall && loadedBall) {
      if (ballMesh) {
        gs.shadows?.removeShadowCaster(ballMesh, true);
        ballMesh.dispose(false, true);
      }
      ballMesh = loadedBall;
      ballMeshId = ballId;
      gs.shadows?.addShadowCaster(ballMesh, true);
      ball.mesh = ballMesh;
      ball.place(ball.state.pos);
    }
    for (const c of [playerChar, aiChar]) {
      for (const m of c.meshes) {
        if (m.getTotalVertices() > 0) gs.shadows?.addShadowCaster(m, false);
      }
    }
    chars = [playerChar, aiChar];

    audio.stopMusic();
    ui.setLabels(opts.labels[0], opts.labels[1]);
    const controller = new MatchController(ball, playerChar, aiChar, {
      setScore: (p, a, s, sp, sa) => ui.setScore(p, a, s, sp, sa),
      banner: (t, sub) => ui.banner(t, sub),
      hint: (t) => ui.hint(t),
      meter: (f, s0, s1) => ui.meter(f, s0, s1),
      meterResult: (q) => ui.meterResult(q),
      setReplay: (active, label, replayPaused, zoom, replayPosition, replayDuration, replaySegment) => {
        ui.setReplay(active, label, replayPaused, zoom, replayPosition, replayDuration, replaySegment);
        // Keep the normal STRIKE/RECEPTION touch buttons out of a cinematic
        // replay, leaving only the explicit transport controls above them.
        input.setTouchControlsEnabled(!active);
      },
      onMatchEnd: (winner) => {
        const sets: [number, number] = [controller.sets.player, controller.sets.ai];
        window.setTimeout(() => opts.onEnd(winner, sets), 1800);
      },
    }, audio);
    controller.aimMarker = gs.aimMarker;
    controller.landingMarker = gs.landingMarker;
    controller.versus = opts.versus !== null;
    controller.practice = opts.practice === true;
    match = controller;
    // Online play is a two-human match whose second seat is a socket, so it
    // needs no AI and no split screen: each player has their own device.
    aiCtl =
      opts.versus || opts.online
        ? null
        : new AIController(controller, opts.practice ? PRACTICE_DIFFICULTY : DIFFICULTIES[opts.difficulty]);
    if (opts.online) {
      // The guest shows a match the host runs. Without this both peers would
      // run their own rule engine, disagree from the first serve, and end up
      // playing two unrelated games over one socket.
      controller.netFollower = opts.online.role === "guest";
      session = new OnlineSession(opts.online.conn, controller, opts.online.role, {
        onOpponentAbsent: (left) =>
          ui.banner("OPPONENT DISCONNECTED", `Awarding the match in ${Math.ceil(left)}s`),
        onOpponentReturned: () => ui.banner("OPPONENT RECONNECTED"),
        onOpponentForfeit: () => {
          ui.banner("OPPONENT LEFT", "Match awarded to you");
          ui.showEnd("player", () => leaveMatch(), () => leaveMatch());
        },
        onPauseState: (state, detail) => {
          switch (state) {
            case "asking":
              ui.showOnlinePause("PAUSE?", "Asking your opponent…", [
                ["LEAVE MATCH", () => leaveMatch()],
              ]);
              return;
            case "asked":
              ui.showOnlinePause("PAUSE REQUEST", "Your opponent would like to pause", [
                ["ALLOW", () => session?.respondToPause(true)],
                ["DECLINE", () => session?.respondToPause(false)],
              ]);
              return;
            case "paused":
              ui.showOnlinePause("PAUSED", "Either player can resume", [
                ["RESUME", () => session?.resume()],
                ["LEAVE MATCH", () => leaveMatch()],
              ]);
              return;
            case "none":
              ui.hideOnlinePause();
              if (detail) ui.banner("PAUSE", detail);
              return;
          }
        },
      });
      session.pauseAllowed = opts.online.private;
    }
    cameraMode = "court";
    ui.setCameraMode(cameraMode);
    if (opts.versus) enableSplit(opts.versus);
    else disableSplit();
    match.reset();
    ui.showHUD();
    // No establishing shot online: it holds the local simulation, and the
    // other peer has no idea that is happening. Three seconds of one side
    // admiring the venue while the other plays is a forfeited point.
    if (opts.online) {
      introLeft = null;
      ui.hideIntro();
    } else {
      introLeft = INTRO_SECONDS;
      simAccumulator = 0;
      ui.showIntro(venueFor(venueId).label, opts.labels[0], opts.labels[1]);
    }
    practiceCoach = opts.practice
      ? new PracticeCoach(
          controller,
          ui,
          () => input.hasGamepad(),
          () => input.isTouch,
          () => input.isTouch && input.isPortrait
        )
      : null;
    practiceCoach?.start();
    (window as unknown as Record<string, unknown>).__teq = { match, ball, engine: gs.engine };
  };

  // Everything above is ready; what is still owed is the clip's running time
  // and whatever is left of the asset download. The clip holds on its last
  // frame while the bar finishes, rather than cutting to a spinner.
  await introClip;
  ui.showIntroProgress(preloaded / preloadUrls.length, "Loading players…");
  // Not a hard gate: a slow connection should reach the title screen and let
  // the player read the menu while the rest arrives.
  await Promise.race([preload, new Promise((r) => setTimeout(r, 4000))]);
  ui.hideIntroClip();

  showTitle();
}

void boot();
