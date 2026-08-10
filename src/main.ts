import "./style.css";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
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
} from "./input";
import { UI, type SettingRow } from "./ui";
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
  type PeerIdentity,
  type PeerRole,
} from "./net/protocol";
import { ModelViewer } from "./viewer";
import { PRACTICE_DIFFICULTY, PracticeCoach } from "./practice";
import { readPreferences, storePreferences, type Preferences } from "./settings";
import {
  MAX_LEVEL,
  UNLOCK_AT,
  XP_PER_LEVEL,
  buyUpgrade,
  claimChallenge,
  isUnlocked,
  levelOf,
  readCareer,
  settleMatch,
  storeCareer,
  upgradeCost,
  withCareer,
  type Career,
} from "./progress";
import { nextTier, tierFor, tierProgress } from "./league";
import {
  ApiError,
  changeName,
  fetchLeaderboard,
  fetchMe,
  looksLikeCode,
  nameProblem,
  newRecoveryCode,
  readIdentity,
  reportMatch,
  restore,
  signUp,
  storeIdentity,
  tidyCode,
  tidyName,
  type Identity,
  type Issued,
  type Profile,
} from "./account";
import { RATING_KEYS, rating, totalPower } from "./ratings";
import { dailyChallenges, isComplete, secondsUntilRollover } from "./challenges";
import { LANGUAGES, detectLanguage, isLanguage, setLanguage, t as tr, tf } from "./i18n";
import {
  BALLS,
  CHARACTERS,
  COURT,
  GROUND_Y,
  SETS_TO_WIN,
  SIM_DT,
  type CameraMode,
  type CharacterDef,
} from "./config";

/** Longest real frame the simulation will honour; beyond this, time is dropped. */
const MAX_FRAME_DT = 1 / 20;

/** How one match should be set up and what to do when it ends. */
interface MatchOpts {
  opponent: CharacterDef;
  difficulty: DifficultyLevel;
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
  // The browser harnesses in scripts/ drive screens that are otherwise only
  // reachable by playing a match out — which, on a software renderer at a
  // frame a second, they cannot do. Same reason __teq exposes the match.
  (window as unknown as Record<string, unknown>).__teqUi = ui;
  (window as unknown as Record<string, unknown>).__teqCharacters = CHARACTERS;

  // Browsers gate audio behind a user gesture.
  const unlock = () => {
    audio.unlock();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  ui.showLoading(tr("loading.court"));
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
  // Remembered choices that are not the graphics tier. Applied as they are
  // read, so a fresh boot sounds and plays the way the last session left it.
  const prefs: Preferences = readPreferences();
  setLanguage(prefs.language ?? detectLanguage());
  audio.setMusicEnabled(prefs.music);
  audio.setSoundEnabled(prefs.sound);
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
  let cameraMode: CameraMode = prefs.camera;
  /**
   * Seconds left of the establishing shot, or null when a match is being
   * played normally. The simulation is held while it runs: the CPU is
   * perfectly willing to serve during a camera move, and an intro that ends
   * with the score already 1-0 is worse than no intro.
   */
  let introLeft: number | null = null;
  // Debug free-fly camera (F2): place the camera by hand to evaluate the scene.
  // WASD/arrows move, drag mouse to look, E/Q up/down, hold Shift for speed.
  // Toggling it off logs the position/target so values can be copied into code.
  let freecam: UniversalCamera | null = null;
  const toggleFreecam = () => {
    if (viewer.active) return;
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

  const idleInput: InputState = {
    moveX: 0,
    moveZ: 0,
    strikePressed: false,
    strikeHeld: false,
    strikePower: 0,
    popPressed: false,
    confirmPressed: false,
  };

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
  // The frame delta is already clamped to MAX_FRAME_DT before the time scale is
  // applied, so this bound is simply that clamp expressed in simulation steps.
  const maxSimSteps = Math.ceil((MAX_FRAME_DT * timeScale) / SIM_DT) + 1;

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
    if (!match || paused || freecam || viewer.active) return;
    const modes: CameraMode[] = ["court", "side", "top"];
    cameraMode = modes[(modes.indexOf(cameraMode) + 1) % modes.length];
    ui.setCameraMode(cameraMode);
    const label = cameraMode === "court" ? "COURT VIEW" : cameraMode === "side" ? "SIDE VIEW" : "TOP VIEW";
    ui.banner(label, "C or Y / △ to switch");
  };
  const requestPauseToggle = () => {
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
    // cameras). Gameplay is stepped separately, at SIM_DT.
    const dt = Math.min(gs.engine.getDeltaTime() / 1000, MAX_FRAME_DT) * timeScale;
    menuNav();
    // Poll even off-court so a held C / Y can never leak into the next match.
    const cameraCycle = input.pollCameraCycle();
    const pauseRequested = input.pollPauseEdge();
    if (viewer.active) {
      viewer.update(dt);
      viewer.scene.render();
      return;
    }
    if (pauseRequested && match && !practiceCoach?.isPaused && !hasBlockingScreen()) {
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
    if (cameraCycle && match) cycleCameraMode();
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
      // Portrait has no stick and no aim marker: the player is placed by
      // tapping the court and the kick is aimed by the swipe that fires it, so
      // the axes are free to carry that aim instead of steering. Only on a
      // touch screen — a narrow desktop window has a keyboard, and taking its
      // movement away would leave the player rooted to the spot.
      match.tapSteering = input.isTouch && input.isPortrait;
      match.portraitControls = match.tapSteering;
      const placement = input.pollTapPlacement();
      if (placement && !freecam) {
        // The match decides what the tap meant: somewhere to stand, or which
        // way to set up a reception that is already due.
        match.tapAt(courtPointAt(placement.x, placement.y));
      }
      latchInput(latchedP1, inp);
      // Step the match in fixed SIM_DT slices, consuming whatever real time
      // this frame delivered. A slow frame runs several steps, a fast one may
      // run none — which is why the presses are latched rather than sampled.
      simAccumulator += dt;
      let steps = 0;
      while (simAccumulator >= SIM_DT && steps < maxSimSteps) {
        const stepInput = consumeInput(latchedP1);
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
      if (!freecam) match.updateCamera(gs.camera, cameraMode);
    }
    // Scenery runs on wall-clock time and outside the simulation: it must not
    // consume simulation steps, and it keeps moving through a menu sitting
    // over the court.
    gs.scene.render();
  });

  // ----------------------------------------------------------- the career

  /**
   * Everything the player keeps between matches, held in one place and written
   * back the moment it changes.
   *
   * It is read once at boot rather than per screen: a career read fresh from
   * storage on every navigation would quietly discard an upgrade bought a
   * moment earlier if the write ever failed, and would hide that it had.
   */
  let career: Career = readCareer();

  /**
   * The account, if this device has one.
   *
   * Everything about it is optional. The career already works offline, and an
   * account makes it the server's copy instead of the device's — which is what
   * a leaderboard needs to mean anything. Nothing here may ever stand between
   * a player and a match: every call is allowed to fail, and failing leaves
   * the local career exactly as it was.
   */
  let identity: Identity | null = readIdentity();
  let profile: Profile | null = null;

  const saveCareer = (next: Career) => {
    career = next;
    storeCareer(career);
    refreshWallet();
  };

  /**
   * Adopt the career the server holds.
   *
   * The server scored the same match from the same rules, so the two normally
   * agree; when they do not, the server is right by definition and this is
   * where that is settled.
   */
  const adoptServerCareer = (next: Career) => {
    saveCareer(next);
  };

  /** Catch up with the server in the background, if there is an account. */
  const refreshProfile = async (): Promise<void> => {
    if (!identity) return;
    try {
      const me = await fetchMe(identity.token);
      profile = me;
      if (me.name !== identity.name) {
        identity = { ...identity, name: me.name };
        storeIdentity(identity);
      }
      adoptServerCareer(me.career);
    } catch (err) {
      // Offline, or a server having a bad minute. The game does not care.
      if (err instanceof ApiError && err.status === 401) {
        // The account is gone from the server's side; stop pretending it is not.
        identity = null;
        profile = null;
        storeIdentity(null);
      }
    }
  };

  const refreshWallet = () => {
    ui.setWallet(career.coins, career.trophies, tierFor(career.trophies).label);
  };

  /** True while a finished challenge is waiting to be collected. */
  const rewardWaiting = () =>
    dailyChallenges(career.day).some(
      (c) => isComplete(c, career.progress[c.id] ?? 0) && !career.claimed.includes(c.id)
    );

  const showTitle = () => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    ui.showTitle({
      onPlay: () => {
        audio.startMusic();
        // Prefetch the decorative gym only after the first screen is visible.
        // The model viewer and selection menus give it time to arrive without
        // making the initial page appear stuck on “Building the court…”.
        void gs.ensureArena();
        showModes();
      },
      onChampions: showChampions,
      onChallenges: showChallenges,
      onProfile: () => showProfile(),
      profileLabel: identity?.name ?? null,
      onSettings: () => showSettings(showTitle),
      challengeReady: rewardWaiting(),
    });
  };

  /**
   * The roster, and the two ways it grows: playing with a character levels it
   * slowly and for free, and coins level it now.
   */
  const showChampions = () => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    ui.showChampions({
      rows: CHARACTERS.map((def) => {
        const unlocked = isUnlocked(career, def.id);
        const level = levelOf(career, def.id);
        const capped = level >= MAX_LEVEL;
        const cost = capped ? null : upgradeCost(level);
        // The character as this career has actually made it, so the bars show
        // what a level bought rather than what the roster shipped with.
        const trained = withCareer(def, level);
        return {
          id: def.id,
          label: def.label,
          level,
          maxLevel: MAX_LEVEL,
          unlocked,
          unlockAt: UNLOCK_AT[def.id] ?? 0,
          cost,
          affordable: cost !== null && career.coins >= cost,
          nextIn: capped ? null : XP_PER_LEVEL - (career.champions[def.id]?.xp ?? 0),
          stats: RATING_KEYS.map((key) => ({
            label: tr(`select.abilities.${key}`),
            value: rating(trained, key),
          })),
          power: totalPower(trained),
        };
      }),
      onUpgrade: (id) => {
        saveCareer(buyUpgrade(career, id));
        showChampions();
      },
      onBack: showTitle,
    });
  };

  /** The one place a name-validation problem becomes a sentence. */
  const nameMessage = (raw: string): string | null => {
    const problem = nameProblem(raw);
    return problem === null ? null : tr(`name.${problem}`);
  };

  const showProfile = (message: string | null = null, busy = false) => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    ui.showProfile({
      profile,
      message,
      // Adopting the server's career is what keeps the leaderboard honest, and
      // it costs a player whatever they built offline. That is worth saying
      // before they press the button, not after.
      freshStart:
        profile === null && career.trophies > 0
          ? tf("profile.fresh", { n: career.trophies })
          : null,
      busy,
      onCreate: (raw) => {
        const problem = nameMessage(raw);
        if (problem) return showProfile(problem);
        showProfile(null, true);
        void signUp(tidyName(raw)).then(
          // A brand-new account starts from the server's empty career rather
          // than adopting whatever this device had been playing offline: the
          // alternative is a leaderboard whose top row is whoever played the
          // longest before signing up.
          (created) => adopt(created, null),
          (err: unknown) => showProfile(errorMessage(err))
        );
      },
      onRename: (raw) => {
        if (!identity) return;
        const problem = nameMessage(raw);
        if (problem) return showProfile(problem);
        const token = identity.token;
        showProfile(null, true);
        void changeName(token, tidyName(raw)).then(
          (updated) => {
            profile = updated;
            identity = { id: updated.id, name: updated.name, token };
            storeIdentity(identity);
            adoptServerCareer(updated.career);
            showProfile();
          },
          (err: unknown) => showProfile(errorMessage(err))
        );
      },
      onRestore: () => showRestore(),
      onNewCode: () => {
        if (!identity) return;
        showProfile(null, true);
        void newRecoveryCode(identity.token).then(
          (code) => ui.showRecoveryCode({
            code,
            note: tr("recovery.replaced"),
            onDone: () => showProfile(),
          }),
          (err: unknown) => showProfile(errorMessage(err))
        );
      },
      onLeaderboard: showLeaderboard,
      onBack: showTitle,
    });
  };

  /**
   * Take on an account the server just issued or handed back, then make the
   * player look at the recovery code before anything else happens.
   */
  const adopt = (issued: Issued, note: string | null) => {
    identity = issued.identity;
    profile = issued.profile;
    adoptServerCareer(issued.career);
    ui.showRecoveryCode({ code: issued.recoveryCode, note, onDone: () => showProfile() });
  };

  const showRestore = (message: string | null = null, busy = false) => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    ui.showRestore({
      message,
      busy,
      onRestore: (id, code) => {
        // Checked here so an obvious typo does not cost a round trip; the
        // server is the one that decides.
        if (id.trim().length !== 8) return showRestore(tr("recovery.badPlayer"));
        if (!looksLikeCode(code)) return showRestore(tr("recovery.badCode"));
        showRestore(null, true);
        void restore(id, tidyCode(code)).then(
          (back) => adopt(back, tr("recovery.replaced")),
          (err: unknown) => showRestore(errorMessage(err))
        );
      },
      onBack: () => showProfile(),
    });
  };

  /** A failed request, as something a screen can show. */
  const errorMessage = (err: unknown): string =>
    err instanceof ApiError && err.status !== 0 ? err.message : tr("profile.offline");

  const showLeaderboard = () => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    const mine = identity?.id ?? null;
    ui.showLeaderboard({ rows: [], total: 0, me: null, message: null, onBack: showProfile });
    void fetchLeaderboard(identity?.token).then(
      (board) => {
        const row = (r: { rank: number; id: string; name: string; trophies: number; tier: string }) => ({
          ...r,
          isMe: r.id === mine,
        });
        ui.showLeaderboard({
          rows: board.rows.map(row),
          total: board.total,
          me: board.me && board.me.rank !== null ? row({ ...board.me, rank: board.me.rank }) : null,
          message: null,
          onBack: showProfile,
        });
      },
      (err: unknown) =>
        ui.showLeaderboard({
          rows: [],
          total: 0,
          me: null,
          message: errorMessage(err),
          onBack: showProfile,
        })
    );
  };

  /** What the match just played contributes to the daily challenges. */
  const matchTally = () => ({
    points: match?.tally.points.player ?? 0,
    sets: match?.sets.player ?? 0,
    rallies: match?.tally.longRallies ?? 0,
  });

  /** How long is left of today, worded the way a countdown is read aloud. */
  const untilMidnight = () => {
    const secs = secondsUntilRollover(new Date());
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const showChallenges = () => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    ui.showChallenges({
      rows: dailyChallenges(career.day).map((c) => ({
        id: c.id,
        // "Win 1 matches" is the kind of thing a player notices immediately
        // and never stops noticing, and it does not survive translation
        // either — every language wants its own singular.
        text: c.goal === 1 ? tr(`challenge.${c.kind}.one`) : tf(`challenge.${c.kind}`, { n: c.goal }),
        progress: career.progress[c.id] ?? 0,
        goal: c.goal,
        reward: c.reward,
        claimed: career.claimed.includes(c.id),
      })),
      resetsIn: untilMidnight(),
      onClaim: (id) => {
        saveCareer(claimChallenge(career, id));
        showChallenges();
      },
      onBack: showTitle,
    });
  };

  /**
   * Settle a finished match and report what it was worth.
   *
   * Only friendly and competition matches come through here. Practice pays
   * nothing because it cannot be lost, and online pays nothing because the
   * result is only as trustworthy as the other end of the connection — a
   * ladder that can be climbed by disconnecting is not a ladder.
   */
  const settleCareer = (won: boolean, championId: string, difficulty: DifficultyLevel) => {
    const tally = matchTally();
    const { career: next, outcome } = settleMatch(career, championId, difficulty, { won, ...tally });
    saveCareer(next);
    // Tell the server, and take its answer over ours. It scored the same match
    // from the same rules, so the two normally agree — but a leaderboard built
    // from totals a client posts is a ranking of whoever edited their save
    // file best, and this is the difference.
    if (identity) {
      void reportMatch(identity.token, { championId, difficulty, won, ...tally }).then(
        (server) => {
          adoptServerCareer(server.career);
          if (profile) profile = { ...profile, trophies: server.career.trophies, rank: server.rank };
        },
        () => {
          // Offline: the local career already has the result, and the next
          // successful call brings the server's copy back into line.
        }
      );
    }
    return { next, outcome };
  };

  const settleAndShow = (
    won: boolean,
    championId: string,
    difficulty: DifficultyLevel,
    onContinue: () => void,
    onRematch: (() => void) | null
  ) => {
    const { next, outcome } = settleCareer(won, championId, difficulty);
    const notes = [
      ...outcome.levelled.map((id) => {
        const def = CHARACTERS.find((c) => c.id === id);
        return `${tr("result.levelUp")} — ${def?.label ?? id} ${tr("career.level")} ${levelOf(next, id)}`;
      }),
      ...outcome.completed.map((id) => {
        const c = dailyChallenges(next.day).find((x) => x.id === id);
        if (!c) return tr("result.challengeDone");
        const what =
          c.goal === 1 ? tr(`challenge.${c.kind}.one`) : tf(`challenge.${c.kind}`, { n: c.goal });
        return `${tr("result.challengeDone")} — ${what}`;
      }),
    ];
    // The match controls come off the screen while the card is up: the touch
    // layer covers the whole viewport during play, and leaving it armed under
    // a dialog is how a tap lands on the court instead of on CONTINUE.
    input.setTouchControlsEnabled(false);
    const up = nextTier(next.trophies);
    ui.showResult({
      won,
      trophies: outcome.trophies,
      total: next.trophies,
      coins: outcome.coins,
      tier: tierFor(next.trophies).label,
      nextTier: up?.label ?? null,
      toNext: up ? up.floor - next.trophies : 0,
      progress: tierProgress(next.trophies),
      rank: outcome.rank,
      notes,
      onContinue,
      onRematch,
    });
  };

  // ------------------------------------------------------------- mode flow

  /**
   * One question: how do you want to play? Four routes and nothing else —
   * settings live on the title screen, where they are not in the way of a
   * player who came here to start a match.
   */
  const showModes = () => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    ui.showMenu(
      tr("play.title"),
      [
        {
          id: "btn-mode-friendly",
          label: tr("play.friendly"),
          sub: tr("play.friendly.sub"),
          primary: true,
        },
        { id: "btn-mode-practice", label: tr("play.practice"), sub: tr("play.practice.sub") },
        { id: "btn-mode-competition", label: tr("play.competition"), sub: tr("play.competition.sub") },
        { id: "btn-mode-online", label: tr("play.online"), sub: tr("play.online.sub") },
      ],
      (id) => {
        if (id === "btn-mode-practice") showPractice();
        else if (id === "btn-mode-friendly") showDifficulty();
        else if (id === "btn-mode-competition") showFormats();
        else showOnline();
      },
      undefined,
      showTitle
    );
  };

  /**
   * Settings, in three doors rather than one long list.
   *
   * Five rows on one screen made a player read all five to change one. The
   * categories answer "which kind of thing am I changing?" first, and each
   * opens a screen with two or three rows on it — still Home → Category →
   * Choice, never deeper.
   *
   * The graphics tier is the only setting that cannot simply be applied: the
   * engine's MSAA is fixed when the WebGL context is created, so changing it
   * restarts the game. The row says so before it is touched, and a
   * confirmation says it again before anything happens.
   */
  const showSettings = (back: () => void = showTitle) => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    ui.showMenu(
      tr("settings.title"),
      [
        { id: "btn-set-display", label: tr("settings.display"), sub: tr("settings.display.sub"), primary: true },
        { id: "btn-set-gameplay", label: tr("settings.gameplay"), sub: tr("settings.gameplay.sub") },
        { id: "btn-set-audio", label: tr("settings.audio"), sub: tr("settings.audio.sub") },
      ],
      (id) => {
        if (id === "btn-set-display") showSettingsGroup("display", back);
        else if (id === "btn-set-gameplay") showSettingsGroup("gameplay", back);
        else showSettingsGroup("audio", back);
      },
      undefined,
      back
    );
  };

  /** One focused screen of settings, and the rows that belong on it. */
  const showSettingsGroup = (group: "display" | "gameplay" | "audio", back: () => void) => {
    const rows = (): SettingRow[] => {
      if (group === "display") {
        return [
          {
            id: "graphics",
            label: tr("settings.graphics"),
            hint: tr("settings.graphics.hint"),
            warning: tr("settings.graphics.warning"),
            control: {
              kind: "choice",
              value: qualityTier,
              options: QUALITY_TIERS.map((tier) => ({ id: tier, label: TIER_LABELS[tier].label })),
            },
          },
          {
            id: "camera",
            label: tr("settings.camera"),
            hint: tr("settings.camera.hint"),
            control: {
              kind: "choice",
              value: prefs.camera,
              options: [
                { id: "court", label: tr("settings.camera.court") },
                { id: "side", label: tr("settings.camera.side") },
                { id: "top", label: tr("settings.camera.top") },
              ],
            },
          },
          {
            id: "language",
            label: tr("settings.language"),
            hint: tr("settings.language.hint"),
            control: {
              kind: "choice",
              value: prefs.language ?? "en",
              options: LANGUAGES.map((l) => ({ id: l.id, label: l.label })),
            },
          },
        ];
      }
      if (group === "gameplay") {
        return [
          {
            id: "autoReception",
            label: tr("settings.autoReception"),
            hint: tr("settings.autoReception.hint"),
            control: { kind: "toggle", value: prefs.autoReception },
          },
        ];
      }
      return [
        {
          id: "music",
          label: tr("settings.music"),
          hint: tr("settings.music.hint"),
          control: { kind: "toggle", value: prefs.music },
        },
        {
          id: "sound",
          label: tr("settings.sound"),
          hint: tr("settings.sound.hint"),
          control: { kind: "toggle", value: prefs.sound },
        },
      ];
    };
    const render = () =>
      ui.showSettings(
        tr(`settings.${group}`),
        rows(),
        (id, value) => {
          if (id === "graphics") {
            const picked = QUALITY_TIERS.find((tier) => tier === value);
            if (!picked || picked === qualityTier) return;
            ui.confirm(
              tr("settings.restart.title"),
              tr("settings.restart.body"),
              tr("settings.restart.confirm"),
              tr("settings.restart.cancel"),
              () => {
                storeTier(picked);
                ui.showLoading(tr("loading.court"));
                location.reload();
              }
            );
            return;
          }
          if (id === "camera" && typeof value === "string") {
            const picked = (["court", "side", "top"] as CameraMode[]).find((mode) => mode === value);
            if (picked) {
              prefs.camera = picked;
              cameraMode = picked;
              ui.setCameraMode(picked);
            }
          }
          if (id === "language" && isLanguage(value)) {
            prefs.language = value;
            setLanguage(value);
          }
          if (id === "autoReception" && typeof value === "boolean") {
            prefs.autoReception = value;
            if (match) match.autoFirstReception = value;
          }
          if (id === "music" && typeof value === "boolean") {
            prefs.music = value;
            audio.setMusicEnabled(value);
            if (value) audio.startMusic();
          }
          if (id === "sound" && typeof value === "boolean") {
            prefs.sound = value;
            audio.setSoundEnabled(value);
          }
          storePreferences(prefs);
          render();
        },
        () => showSettings(back)
      );
    render();
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
        online: { conn, role, private: isPrivate },
        // The name the relay verified, not one the peer announced for itself.
        labels: [tr("hud.you"), opponent?.name ?? "RIVAL"],
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

    showSelect(tr("select.title"), (charId, ballId) => {
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

  /**
   * Who is on the other side, once the relay has said.
   *
   * Held here rather than passed along the lobby chain because the answer
   * arrives on a socket event and is needed several screens later, when the
   * match is finally built.
   */
  let opponent: PeerIdentity | null = null;

  const quickMatch = () => {
    if (!onlineAvailable) return;
    const conn = new NetConnection(
      relayUrl(),
      {
        onQueued: (ahead) =>
          ui.setLobbyDetail(
            ahead === 0 ? "Waiting for an opponent…" : `Waiting — ${ahead} ahead of you`
          ),
        onPeer: (present, who) => {
          if (present) opponent = who ?? null;
        },
      },
      identity?.token
    );
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
    const conn = new NetConnection(
      relayUrl(),
      {
        onPeer: (present, who) => {
          opponent = present ? (who ?? null) : null;
          if (present) ui.setLobbyDetail(`${who?.name ?? "Opponent"} joined — starting…`);
        },
      },
      identity?.token
    );
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
            onPeer: (present, who) => {
              if (!present) return;
              opponent = who ?? null;
              resolve({ role: "host" });
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
        const conn = new NetConnection(
          relayUrl(),
          { onPeer: (present, who) => (opponent = present ? (who ?? null) : null) },
          identity?.token
        );
        netConn = conn;
        ui.showLobbyStatus("JOINING", "Connecting…", code, abandonLobby);
        conn
          .join(code)
          .then(({ role, ready }) => {
            if (!ready) {
              // Seated, but alone: the host left between hosting and joining.
              ui.setLobbyDetail("Waiting for the host…");
              conn.setHandlers({
                onPeer: (p, who) => {
                  if (!p) return;
                  opponent = who ?? null;
                  startOnlineMatch(conn, role, true);
                },
              });
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
      ui.showLobbyStatus(tr("online.title"), tr("online.unavailable"), null, showModes);
      return;
    }
    ui.showMenu(
      tr("online.title"),
      [
        { id: "btn-online-quick", label: tr("online.quick"), sub: tr("online.quick.sub"), primary: true },
        { id: "btn-online-host", label: tr("online.friend"), sub: tr("online.friend.sub") },
        { id: "btn-online-join", label: tr("online.code"), sub: tr("online.code.sub") },
      ],
      (id) => {
        if (id === "btn-online-quick") quickMatch();
        else if (id === "btn-online-host") hostPrivateGame();
        else joinPrivateGame();
      },
      tr("online.sub"),
      showModes
    );
  };

  const showPractice = () => {
    // The trainer is fixed, so it is a safe useful prefetch while the user is
    // choosing their own player.
    scheduleAssetPrefetch("/models/characters/SpanishPlayer.glb", 700);
    showSelect(tr("select.title"), (charId, ballId) => {
      const base = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
      // Practice pays nothing — it cannot be lost — but the character is still
      // the one the career has built, or the drill would be teaching a player
      // the feel of somebody else.
      const playerDef = withCareer(base, levelOf(career, base.id));
      const trainer =
        CHARACTERS.find((c) => c.id !== playerDef.id && c.id === "SpanishPlayer") ??
        CHARACTERS.find((c) => c.id !== playerDef.id) ??
        CHARACTERS[0];
      void startMatch(playerDef, ballId, {
        opponent: trainer,
        difficulty: "easy",
        labels: [tr("hud.you"), "TRAINER"],
        practice: true,
        onEnd: () => match?.reset(),
      });
    }, showModes);
  };

  const showDifficulty = () => {
    ui.showMenu(
      tr("difficulty.title"),
      [
        { id: "btn-diff-easy", label: tr("difficulty.easy"), sub: tr("difficulty.easy.sub") },
        { id: "btn-diff-normal", label: tr("difficulty.normal"), sub: tr("difficulty.normal.sub"), primary: true },
        { id: "btn-diff-hard", label: tr("difficulty.hard"), sub: tr("difficulty.hard.sub") },
      ],
      (id) => {
        const diff = id.replace("btn-diff-", "") as DifficultyLevel;
        showSelect(tr("select.title"), (charId, ballId) => {
          const base = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
          // The level the career has this character at is applied here, at the
          // one place a match is built, so an upgrade is felt in the next game
          // rather than being a number on a card.
          const playerDef = withCareer(base, levelOf(career, base.id));
          const others = CHARACTERS.filter((c) => c.id !== charId);
          const opponent = others[Math.floor(Math.random() * others.length)];
          void startMatch(playerDef, ballId, {
            opponent,
            difficulty: diff,
            labels: [tr("hud.you"), opponent.label],
            onEnd: (winner) => {
              settleAndShow(
                winner === "player",
                base.id,
                diff,
                () => leaveMatch(),
                () => {
                  input.setTouchControlsEnabled(true);
                  ui.showHUD();
                  match?.reset();
                }
              );
            },
          });
        }, showDifficulty);
      },
      tr("difficulty.sub"),
      showModes
    );
  };

  const showFormats = () => {
    ui.showMenu(
      tr("comp.title"),
      [
        { id: "btn-format-cup", label: tr("comp.cup"), sub: tr("comp.cup.sub"), primary: true },
        { id: "btn-format-league", label: tr("comp.league"), sub: tr("comp.league.sub") },
      ],
      (id) => {
        const format = id === "btn-format-cup" ? ("cup" as const) : ("league" as const);
        showSelect(tr("select.title"), (charId, ballId) => {
          startCompetition(format, charId, ballId);
        }, showFormats);
      },
      tr("comp.sub"),
      showModes
    );
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
      // Only what the career has unlocked. The locked ones are not hidden from
      // the player — they are on the CHAMPIONS screen with the price on them,
      // which is a reason to keep playing rather than a gap in a menu.
      characters: CHARACTERS.filter((c) => isUnlocked(career, c.id)),
      balls: BALLS,
      venues: VENUE_IDS.map((id) => ({ id, label: venueFor(id).label })),
      venue: venueId,
      onVenue: (id) => {
        const picked = VENUE_IDS.find((v) => v === id);
        if (!picked || picked === venueId) return;
        storeVenue(picked);
        venueId = picked;
        void gs.setVenue(venueFor(picked));
      },
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
    const loserSets = Math.random() < 0.45 ? SETS_TO_WIN - 1 : 0;
    return {
      winA,
      sets: winA ? [SETS_TO_WIN, loserSets] : [loserSets, SETS_TO_WIN],
    };
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
      labels: [tr("hud.you"), opponent.label],
      onEnd: (winner, sets) => {
        // Settled, but not reported here: a competition already has a screen
        // that says what the match did, and a second one between every round
        // would turn a cup run into a series of receipts.
        settleCareer(winner === "player", human.id, difficulty);
        onEnd(winner === "player", sets);
      },
    });
  };

  const startCompetition = (format: "cup" | "league", charId: string, ballId: string) => {
    const base = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
    const human = withCareer(base, levelOf(career, base.id));
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
      onMatchEnd: (winner) => {
        const sets: [number, number] = [controller.sets.player, controller.sets.ai];
        window.setTimeout(() => opts.onEnd(winner, sets), 1800);
      },
    }, audio);
    controller.aimMarker = gs.aimMarker;
    controller.landingMarker = gs.landingMarker;
    controller.practice = opts.practice === true;
    controller.autoFirstReception = prefs.autoReception;
    match = controller;
    // Online play is a two-human match whose second seat is a socket, so it
    // needs no AI and no split screen: each player has their own device.
    // Online is a two-human match whose second seat is a socket, so it needs
    // no AI; the session turns `versus` on for itself.
    aiCtl = opts.online
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
      ui.showIntro(venueFor(venueId).label, opts.labels[0], opts.labels[1], [
        playerDef,
        opts.opponent,
      ]);
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
  // Catch up with the server behind the title screen. It never blocks the
  // first screen, and if it fails nothing about the game changes.
  void refreshProfile().then(() => {
    // Only if the player is still looking at it. A profile that resolves while
    // they are three screens into picking a match must not drag them back.
    const title = document.getElementById("title-screen");
    if (identity && title && !title.classList.contains("hidden")) showTitle();
  });
}

void boot();
