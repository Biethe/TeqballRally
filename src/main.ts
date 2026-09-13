import "./style.css";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";
import { createGameScene, loadBall, type GameScene } from "./scene";
import {
  QUALITY_TIERS,
  TIER_LABELS,
  readSignals,
  resolveTier,
  settingsFor,
  storeTier,
} from "./quality";
import {
  VENUE_IDS,
  isPremiumVenue,
  permittedVenue,
  resolveVenue,
  storeVenue,
  venueFor,
  venueFromSearch,
} from "./venue";
import { cheerCrowd, stopCrowdCheer } from "./crowdrig";
import { CRESTS, applyKit, type Kit, type PersonalKit } from "./kit";
import { Tour } from "./tour";
import { characterFor, rivalFor } from "./rivals";
import { PresenceLink } from "./net/presence";
import {
  SUPPLIES,
  buy as buySupply,
  consumeArmed,
  staminaMultiplier,
  withSupplies,
} from "./supplies";
import {
  initPurchases,
  ownsArena,
  arenaStatus,
  purchasesAvailable,
  restorePurchases,
  subscribeToArena,
  coinPackages,
  purchaseCoins,
  bindUserToPurchases,
  formattedPriceFor,
  purchaseAsset,
} from "./purchases";
import { INTRO_SECONDS, introPose } from "./intro";
import { Ball, type Side } from "./ball";
import { Character } from "./character";
import { MatchController } from "./match";
import { AIController, DIFFICULTIES, type DifficultyLevel, type AIDifficulty } from "./ai";
import {
  Input,
  consumeInput,
  latchInput,
  newLatch,
  type InputState,
} from "./input";
import { UI, type SettingRow } from "./ui";
import { AudioManager } from "./audio";
import { assetUrl, prefetchAsset } from "./protected";
import { NetConnection } from "./net/connection";
import { OnlineSession } from "./net/session";
import { looksReachable, relayUrl } from "./net/endpoint";
import { Capacitor } from "@capacitor/core";
import {
  makeRoomCode,
  normalizeRoomCode,
  isValidRoomCode,
  isValidSetup,
  readKit,
  type PeerIdentity,
  type PeerRole,
} from "./net/protocol";
import { ModelViewer } from "./viewer";
import { PRACTICE_DIFFICULTY, PracticeCoach } from "./practice";
import { readPreferences, storePreferences, type Preferences } from "./settings";
import {
  COINS_PER_TROPHY,
  MAX_LEVEL,
  UNLOCK_AT,
  XP_PER_LEVEL,
  buyUpgrade,
  claimChallenge,
  isUnlocked,
  levelOf,
  openCareer,
  settleMatch,
  storeCareer,
  tradeTrophies,
  upgradeCost,
  withCareer,
  type Career,
  type MatchOutcome,
  awardCompetition,
} from "./progress";
import { type CompetitionKind } from "./league";
import {
  clearCompetition,
  describeCompetition,
  readCompetition,
  storeCompetition,
  type CompetitionFormat,
  type SavedCompetition,
} from "./competition";
import type { SeasonEnd } from "./season";
import { nextTier, tierFor, tierProgress } from "./league";
import {
  ApiError,
  addFriend,
  changeName,
  clubNameProblem,
  createClub,
  fetchClub,
  fetchFriends,
  fetchLeaderboard,
  fetchMe,
  joinClub,
  lastSeenLabel,
  leaveClub,
  looksLikeCode,
  looksLikeInvite,
  looksLikePlayerCode,
  nameProblem,
  newInviteCode,
  newRecoveryCode,
  readIdentity,
  removeFriend,
  removeMember,
  renameClub,
  reportMatch,
  reportOnlineMatch,
  claimOnServer,
  restore,
  signUp,
  storeIdentity,
  tidyCode,
  tidyName,
  type Club,
  type Identity,
  type Issued,
  type Profile,
} from "./account";
import { RATING_KEYS, rating, totalPower } from "./ratings";
import { dailyChallenges, isComplete, secondsUntilRollover } from "./challenges";
import { LANGUAGES, detectLanguage, isLanguage, setLanguage, t as tr, tf } from "./i18n";
import {
  BALLS,
  ballFor,
  withBall,
  hasBallAffinity,
  hasVenueAffinity,
  withBallAndVenue,
  CHARACTERS,
  BALL_RADIUS,
  COURT,
  clearTable,
  GROUND_Y,
  SETS_TO_WIN,
  SIM_DT,
  kitForCharacter,
  KIT_NAME_MAX,
  KIT_NUMBER_MAX,
  type CameraMode,
  type CharacterDef,
} from "./config";

/** Longest real frame the simulation will honour; beyond this, time is dropped. */
/**
 * Ball speeds, in m/s, between which the streak behind the ball fades in.
 *
 * Speed rather than a kick event, so it reads as physics instead of as an
 * effect: a smash streaks, a set-up touch shows nothing, and no rule has to
 * remember to switch it on.
 */
const TRAIL_FROM = 6;
const TRAIL_FULL = 15;
const TRAIL_ALPHA = 0.78;

/**
 * How long the streak stays away after a ball is launched, in seconds.
 *
 * The ball is moved onto the striking foot for the contact frame, so the first
 * few centimetres of every kick are a snap rather than a flight. Drawing a
 * streak through that is what made the adaptation obvious — the trail pointed
 * straight at the cheat. Waiting a hundredth of a second and starting from
 * where the ball actually leaves hides it completely, and reads as the streak
 * being *thrown* by the strike rather than dragged into it.
 */
const TRAIL_DELAY = 0.09;

const MAX_FRAME_DT = 1 / 20;

/**
 * How long to wait before asking again for a result that is still pending, and
 * how many times.
 *
 * Both players report at the same instant, so the wait is normally one round
 * trip and the first ask is enough. The rest of the budget is for the opponent
 * whose phone is a moment slower to get the request away — about twelve
 * seconds of patience, after which the match really was reported by one person
 * alone and nobody is paid for it.
 */
const SETTLE_RETRY_MS = 1500;
const SETTLE_RETRIES = 8;

/**
 * How often the guided tour re-reads whether its step is done.
 *
 * Often enough that finishing a step feels like the tour noticed, slow enough
 * to be free. The facts it reads are a string, a boolean and an orientation.
 */
const TOUR_POLL_MS = 350;

/**
 * How long QUICK MATCH looks for a real opponent before offering a rival.
 *
 * Long enough that two people tapping it within a few seconds of each other
 * still meet, short enough that somebody alone is playing rather than reading
 * a spinner.
 */
const QUEUE_WAIT_MS = 9000;

/**
 * How long the app waits for a purchase to reach the server, and how often.
 *
 * RevenueCat gets there a beat after the store answers this device, so the
 * first ask usually has it. The rest is headroom; giving up costs nothing
 * worse than coins that appear on the next launch.
 */
const PURCHASE_POLL_MS = 1200;
const PURCHASE_POLL_TRIES = 6;

/** How one match should be set up and what to do when it ends. */
interface MatchOpts {
  opponent: CharacterDef;
  /**
   * How the far side plays: one of the named ladder rungs, or a style of its
   * own. A rival brings its own, because what makes an opponent read as a
   * person is that they play the same way every time — see `rivals.ts`.
   */
  difficulty: DifficultyLevel | AIDifficulty;
  /** Online: the opponent is a remote human on the far end of this connection. */
  online?: { conn: NetConnection; role: PeerRole; private: boolean };
  labels: [string, string];
  /** The opponent's own kit marks, when there is a person behind them. */
  opponentKit?: PersonalKit;
  practice?: boolean;
  onEnd: (winner: Side, sets: [number, number]) => void;
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const uiRoot = document.getElementById("ui-root") as HTMLElement;

  const ui = new UI(uiRoot);
  const audio = new AudioManager();
  const input = new Input(uiRoot);
  // Not awaited: the store is never allowed to hold up the game starting, and
  // every gate reads the entitlement through subscribeToArena, which fires again
  // when the real answer lands. Off-device this settles immediately on "no
  // store", so the browser and the harnesses are unaffected.
  void initPurchases();
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

  /**
   * Pull the player models and the ball into the browser cache while navigating
   * menus.
   *
   * The character models are the heaviest thing the game loads — around 4 MB each —
   * and fetching them in background means the picker opens on a model that is already
   * local instead of showing "Loading…" over an empty stage.
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
      // `assetUrl` rather than `fetch`: in a protected build these paths do
      // not exist — the files are `.teq` — so every one of these fetches 404ed
      // and the progress bar counted failures to 100%. The picker then opened
      // on a model it still had to download, which is the exact wait the clip
      // exists to hide. It also caches the decrypted blob, so the real load
      // that follows costs nothing rather than merely being warm in the HTTP
      // cache.
      assetUrl(url)
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
  viewer.setKit(prefs.kit);
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

  // The remembered venue is honoured first and checked second, on purpose. The
  // store answers over the network, and holding the first frame for it would
  // make a paying player wait to see what they paid for. Showing a lapsed one
  // the sports hall for a moment on the title screen costs nothing; showing a
  // member a downgrade while their entitlement loads is the version that reads
  // as the game taking something away. A `?venue=` override is left alone —
  // it is a harness hook, not a way to buy anything.
  subscribeToArena((status) => {
    if (!status.ready || venueFromSearch(location.search)) return;
    const allowed = permittedVenue(venueId, status.owned);
    if (allowed === venueId) return;
    venueId = allowed;
    storeVenue(allowed);
    void gs.setVenue(venueFor(allowed));
  });

  const ball = new Ball();
  let ballMesh: AbstractMesh | null = null;
  let ballMeshId: string | null = null;
  /**
   * The streak behind a struck ball.
   *
   * Tied to speed rather than to a kick event, which is what makes it read as
   * physics instead of as an effect: it appears when the ball is genuinely
   * quick, thickens with a smash and is simply absent during a gentle set-up
   * touch. That also means it needs no wiring into the rules — nothing has to
   * remember to turn it on.
   */
  let ballTrail: TrailMesh | null = null;
  let trailMat: StandardMaterial | null = null;
  /** Seconds left of the blackout after a launch; 0 means the streak may draw. */
  let trailHold = 0;

  let match: MatchController | null = null;
  let aiCtl: AIController | null = null;
  let practiceCoach: PracticeCoach | null = null;
  let chars: Character[] = [];
  /** Live online match, if any: owns the wire, the opponent and the forfeit clock. */
  let session: OnlineSession | null = null;
  /** Held separately from the session so the lobby can own it before a match exists. */
  let netConn: NetConnection | null = null;

  // Dev knob / preference: speeds up game time.
  let timeScale = Number(new URLSearchParams(location.search).get("ts") ?? prefs.gameSpeed) || 1.25;
  gs.scene.animationTimeScale = timeScale;

  // Prefetching the next picker item lets it download while the player reads
  // the menu. Do not spend a metered/very-slow connection's bandwidth on a
  // speculative 20–60 MB model; on-demand loading remains the fallback in that
  // case.
  const prefetched = new Set<string>();
  const scheduleAssetPrefetch = (url: string, delayMs = 1200): void => {
    if (typeof document === "undefined" || typeof navigator === "undefined") return;
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") {
      return;
    }
    if (prefetched.has(url)) return;
    prefetched.add(url);
    // Was a `<link rel=prefetch>` at the `.glb` path. In a protected build
    // nothing lives there, so every prefetch in every release was a 404 —
    // invisible, because a prefetch that fails is meant to be. Going through
    // `prefetchAsset` warms the same cache `importModel` will read, and warms
    // it with the *decrypted* bytes, so the model is ready rather than merely
    // downloaded.
    window.setTimeout(() => prefetchAsset(url), delayMs);
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
    if (e.code === "F3") void openVolumeInspector();
    if (e.key === "Shift" && freecam) freecam.speed = 1.2;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && freecam) freecam.speed = 0.35;
  });

  // Interaction-volume inspector (F3): play/scrub contact clips and validate
  // their measured volumes against the real rig. Dev tool, freecam mould —
  // it reads the match's characters but never writes to the simulation.
  //
  // Loaded on demand and only in development. It is a thousand lines of editor
  // that no player can reach, and a phone should not be made to download it.
  let volumeInspector: { toggle: () => void; update: () => void } | null = null;
  const openVolumeInspector = async (): Promise<void> => {
    if (!import.meta.env.DEV) return;
    if (!volumeInspector) {
      const { ContactVolumeInspector } = await import("./debugvolumes");
      const made = new ContactVolumeInspector(gs.scene, () =>
        match ? [match.chars.player, match.chars.ai] : []
      );
      (window as unknown as Record<string, unknown>).__volumesLog = () => made.logReport();
      volumeInspector = made;
    }
    volumeInspector.toggle();
  };

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
    // The player's half now reaches the middle line, with the table as a hole
    // in it: a tap on the table sends them to the nearest spot beside it.
    const clear = clearTable(
      Math.min(-COURT.minX, Math.max(-COURT.maxX, hit.x)),
      Math.max(-COURT.maxZ, Math.min(COURT.maxZ, hit.z))
    );
    return new Vector3(clear.x, GROUND_Y, clear.z);
  };

  // Fixed-step simulation state. The accumulator only ever grows on frames
  // that actually simulate, so pausing cannot bank time and burst on resume.
  let simAccumulator = 0;
  const latchedP1 = newLatch();
  // The frame delta is already clamped to MAX_FRAME_DT before the time scale is
  // applied, so this bound is simply that clamp expressed in simulation steps.
  const getMaxSimSteps = () => Math.ceil((MAX_FRAME_DT * Math.max(timeScale, 2.0)) / SIM_DT) + 4;

  // ---- pause ----
  let paused = false;
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
      }
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
    const modes: CameraMode[] = ["court", "side"];
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
  // Looked up once. These are static elements and this runs before every early
  // return in the render loop, so during a match it was six document lookups a
  // frame to discover that no menu was open.
  let navScreens: HTMLElement[] | null = null;
  const menuNav = () => {
    const nav = input.pollMenuNav(); // poll every frame so edge states stay fresh
    navScreens ??= NAV_SCREENS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null
    );
    let target: HTMLElement | null = null;
    for (const el of navScreens) {
      if (!el.classList.contains("hidden")) target = el;
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
        const spot = courtPointAt(placement.x, placement.y);
        match.tapAt(spot);
        // Acknowledged wherever it landed, whichever of the two it turned out
        // to mean. A press that shows nothing reads as a press that was
        // missed, and gets made again.
        if (spot) gs.pingTap(spot.x, spot.z);
      }
      latchInput(latchedP1, inp);
      // Step the match in fixed SIM_DT slices, consuming whatever real time
      // this frame delivered. A slow frame runs several steps, a fast one may
      // run none — which is why the presses are latched rather than sampled.
      simAccumulator += dt;
      let steps = 0;
      const maxSteps = getMaxSimSteps();
      while (simAccumulator >= SIM_DT && steps < maxSteps) {
        const stepInput = consumeInput(latchedP1);
        // A guest's controls belong to the host's match, so they go to the
        // wire before the local update — which, as a follower, ignores them.
        // Resolved first: portrait taps become the stick direction the wire
        // can actually carry (see resolveFollowerInput).
        session?.setLocalInput(match.resolveFollowerInput(stepInput));
        // A negotiated pause freezes the match on both peers, but not the
        // session: traffic has to keep flowing or a pause would look exactly
        // like a disconnect and forfeit the game it was meant to interrupt.
        if (!session?.isPaused) {
          match.update(SIM_DT, freecam ? idleInput : stepInput, (d) => aiCtl?.update(d));
          // The lesson is finished the moment the last coached step is done.
          // Remembered immediately rather than when they leave the screen, so
          // a player who closes the app mid-knockabout is not made to sit
          // through it again.
          if (practiceCoach?.isFinished && !prefs.coached) {
            prefs.coached = true;
            storePreferences(prefs);
          }
        }
        // Stepped with the simulation, not the frame, so the tick stamped on
        // outgoing messages is the same clock the receiver counts against.
        session?.step(SIM_DT);
        simAccumulator -= SIM_DT;
        steps++;
      }
      // A frame long enough to exhaust the step budget (tab restore, a GC
      // pause) drops the remainder instead of trying to catch up forever.
      if (steps >= maxSteps) simAccumulator = 0;
      if (!freecam) match.updateCamera(gs.camera, cameraMode);
    }
    // Presentation, on wall-clock time and outside the fixed step: neither may
    // consume a simulation slice, and neither may differ between two peers
    // running the same match at different frame rates.
    gs.stepTapMarker(dt);
    if (ballTrail && trailMat) {
      if (trailHold > 0) {
        // Held: hidden, and not accumulating either. A trail left running
        // through the blackout would come back holding the very frames it was
        // meant to hide.
        trailHold -= dt;
        trailMat.alpha = 0;
        ballTrail.setEnabled(false);
        if (trailHold <= 0) {
          // Collapse every segment onto where the ball is *now*, so the streak
          // begins at the ball rather than being dragged out of the foot it
          // just left.
          ballTrail.reset();
          ballTrail.start();
        }
      } else {
        // Visible in proportion to how fast the ball is actually travelling, so
        // a smash streaks and a set-up touch shows nothing. No rule has to
        // remember to switch it on.
        const speed = ball.state.vel.length();
        const want = Math.min(1, Math.max(0, (speed - TRAIL_FROM) / (TRAIL_FULL - TRAIL_FROM)));
        trailMat.alpha += (want * TRAIL_ALPHA - trailMat.alpha) * Math.min(1, dt * 12);
        ballTrail.setEnabled(trailMat.alpha > 0.01);
      }
    }
    // Scenery runs on wall-clock time and outside the simulation: it must not
    // consume simulation steps, and it keeps moving through a menu sitting
    // over the court.
    volumeInspector?.update();
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
  const opened = openCareer();
  let career: Career = opened.career;
  /**
   * A season that ended between the last session and this one, waiting to be
   * reported. Read once at boot: `openCareer` has already applied and written
   * the rollover, so this is the only chance to say so.
   */
  const endedSeason: SeasonEnd | null = opened.ended;

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
        syncPresence();
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
    ui.onCoinsClicked = () => {
      showCoinShop(showTitle);
    };
    ui.showTitle({
      onPlay: async () => {
        // Prefetch the decorative gym only after the first screen is visible.
        void gs.ensureArena();

        const skipIntro = new URLSearchParams(location.search).get("intro") === "0";
        if (!skipIntro) {
          const clip = ui.playIntroClip();
          await clip;
          if (preloaded < preloadUrls.length) {
            ui.showIntroProgress(preloaded / preloadUrls.length, "Loading players…");
            await Promise.race([preload, new Promise((r) => setTimeout(r, 2500))]);
          }
          ui.hideIntroClip();
        }

        audio.startMusic();
        showModes();
      },
      onChampions: () => {
        audio.startMusic();
        showChampions();
      },
      onChallenges: () => {
        audio.startMusic();
        showChallenges();
      },
      onSupplies: () => {
        audio.startMusic();
        showSupplies(showTitle);
      },
      onProfile: () => {
        audio.startMusic();
        showProfile();
      },
      profileLabel: identity?.name ?? null,
      onSettings: () => {
        audio.startMusic();
        showSettings(showTitle);
      },
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

  /** The same, for a club name, which is allowed to be longer. */
  const clubNameMessage = (raw: string): string | null => {
    const problem = clubNameProblem(raw);
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
      titles: career.titles,
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
      onFriends: () => showFriends(),
      onClub: () => showClub(),
      onLeaderboard: showLeaderboard,
      onBack: showTitle,
    });
  };

  /**
   * The club.
   *
   * Fetched fresh on every visit, for the same reason the friends list is:
   * the board is other people, and other people move while you are not
   * looking. The screen holds no state of its own — every action answers with
   * the whole club, so there is nothing to reconcile.
   */
  const showClub = (message: string | null = null, busy = false, club?: Club | null): void => {
    if (!identity) return showProfile(tr("club.needAccount"));
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    const token = identity.token;
    const me = identity.id;
    const paint = (current: Club | null, note: string | null, working: boolean): void =>
      ui.showClub({
        club: current && {
          name: current.name,
          members: current.members.map((m) => ({
            id: m.id,
            name: m.name,
            trophies: m.trophies,
            tier: m.tier,
            online: m.online,
            seen: m.online ? "" : tr(`friends.seen.${lastSeenLabel(m.lastSeen)}`),
            owner: m.owner,
            isMe: m.id === me,
          })),
          trophies: current.trophies,
          online: current.online,
          full: current.full,
          invite: current.invite,
          isOwner: current.ownerId === me,
        },
        message: note,
        busy: working,
        onCreate: (name) => {
          const problem = clubNameMessage(name);
          if (problem) return showClub(problem, false, current);
          paint(current, null, true);
          void createClub(token, tidyName(name)).then(
            (made) => showClub(null, false, made),
            (err: unknown) => showClub(errorMessage(err), false, current)
          );
        },
        onJoin: (code) => {
          if (!looksLikeInvite(code)) return showClub(tr("club.badCode"), false, current);
          paint(current, null, true);
          void joinClub(token, code).then(
            (joined) => showClub(null, false, joined),
            (err: unknown) => showClub(errorMessage(err), false, current)
          );
        },
        onLeave: () => {
          paint(current, null, true);
          void leaveClub(token).then(
            () => showClub(null, false, null),
            (err: unknown) => showClub(errorMessage(err), false, current)
          );
        },
        onRename: (name) => {
          const problem = clubNameMessage(name);
          if (problem) return showClub(problem, false, current);
          paint(current, null, true);
          void renameClub(token, tidyName(name)).then(
            (next) => showClub(null, false, next),
            (err: unknown) => showClub(errorMessage(err), false, current)
          );
        },
        onNewInvite: () => {
          paint(current, null, true);
          void newInviteCode(token).then(
            (next) => showClub(tr("club.newCodeDone"), false, next),
            (err: unknown) => showClub(errorMessage(err), false, current)
          );
        },
        onRemove: (id) => {
          paint(current, null, true);
          void removeMember(token, id).then(
            (next) => showClub(null, false, next),
            (err: unknown) => showClub(errorMessage(err), false, current)
          );
        },
        onBack: () => showProfile(),
      });

    // `undefined` means nothing is known yet and the server has to be asked;
    // `null` is the answer "no club", which is a state to draw, not to fetch.
    if (club !== undefined) return paint(club, message, busy);
    paint(null, message, true);
    void fetchClub(token).then(
      (found) => paint(found, message, false),
      (err: unknown) => paint(null, errorMessage(err), false)
    );
  };

  /**
   * The friends list.
   *
   * The list is fetched fresh every time rather than cached: presence is the
   * whole point of the screen, and a cached list is a list that says somebody
   * is online after they have gone.
   */
  /**
   * The connection held while the app is open, so a friend can reach this
   * player at all. Null without an account, because an invite needs somebody
   * to be addressed to.
   */
  let presence: PresenceLink | null = null;
  /** The friend this player has just asked, while they are being asked. */
  let asking: { id: string; name: string } | null = null;

  /**
   * Ask a friend for a game.
   *
   * A room is minted and this player takes the host seat in it *before* the
   * invite goes anywhere, so accepting is an ordinary join by code down the
   * path that already works. The cost of an invite nobody answers is one empty
   * room, which the relay sweeps like any other.
   */
  const inviteFriend = (id: string, name: string) => {
    if (!presence?.connected) return;
    asking = { id, name };
    const code = makeRoomCode();
    presence.invite(id, code);
    // Waiting in the room, which is also what makes accepting instant: by the
    // time they answer, this side is already seated.
    hostInviteRoom(code, name);
  };

  /**
   * Open the link, or close it, to match whether there is an account.
   *
   * An invite is addressed to a player, so without one there is nobody to
   * address and nothing to listen for. Called again after a sign-in or a
   * recovery, because both hand over a different token.
   */
  const syncPresence = () => {
    presence?.close();
    presence = null;
    if (!identity || !onlineAvailable) return;
    presence = new PresenceLink(identity.token, {
      onInvited: (from, room) => {
        // Never on top of a match. Being pulled out of a rally by a dialog is
        // worse than missing the invite, and the asker is told either way.
        if (match) return;
        ui.showOnlinePause(tf("invite.from.title", { name: from.name }), "", [
          [tr("invite.accept"), () => { ui.hideOnlinePause(); acceptInvite(room, from.name); }],
          [tr("invite.decline"), () => { ui.hideOnlinePause(); presence?.decline(from.id); }],
        ]);
      },
      onReply: (answer, who) => {
        const name = who ?? asking?.name ?? "";
        asking = null;
        ui.banner(tr(answer === "declined" ? "invite.declined" : "invite.gone").replace("{name}", name));
      },
    });
    presence.start();
  };

  /**
   * Wait for the server to hear about a purchase, then take its career.
   *
   * Nothing is credited here any more. The device used to add the coins and
   * the unlock itself and tell the server afterwards, which is not a purchase
   * record but a request — and one anybody could make without buying
   * anything. RevenueCat tells the server instead, having watched Play take
   * the money, and this waits for that to land.
   *
   * Polled because a webhook is a second conversation: the purchase returns to
   * this device the moment the store is happy, and RevenueCat reaches the
   * server a beat later. A few seconds of asking covers the ordinary case, and
   * the career is re-read on every launch anyway, so the worst outcome of
   * giving up is coins that appear when the app is next opened.
   */
  const collectPurchase = async (): Promise<void> => {
    if (!identity) return;
    const before = JSON.stringify(career);
    for (let attempt = 0; attempt < PURCHASE_POLL_TRIES; attempt++) {
      await new Promise((r) => setTimeout(r, PURCHASE_POLL_MS));
      try {
        const me = await fetchMe(identity.token);
        adoptServerCareer(me.career);
        if (JSON.stringify(me.career) !== before) return;
      } catch {
        // Offline, or a server having a bad minute. The next launch reads it.
        return;
      }
    }
  };

  const showFriends = (message: string | null = null, busy = false, rows?: Profile[]) => {
    if (!identity) return showProfile();
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    const token = identity.token;
    const myCode = identity.id;
    const paint = (friends: Profile[], note: string | null, working: boolean) =>
      ui.showFriends({
        rows: friends.map((f) => ({
          id: f.id,
          name: f.name,
          trophies: f.trophies,
          tier: f.tier,
          online: f.online,
          seen: f.online ? "" : tr(`friends.seen.${lastSeenLabel(f.lastSeen)}`),
        })),
        myCode,
        message: note,
        busy: working,
        onAdd: (code) => {
          const typed = code.trim().toUpperCase();
          if (typed === myCode) return showFriends(tr("friends.self"), false, friends);
          if (!looksLikePlayerCode(typed)) {
            return showFriends(tr("friends.badCode"), false, friends);
          }
          paint(friends, null, true);
          void addFriend(token, typed).then(
            (next) => showFriends(null, false, next),
            (err: unknown) => showFriends(errorMessage(err), false, friends)
          );
        },
        onRemove: (id) => {
          paint(friends, null, true);
          void removeFriend(token, id).then(
            (next) => showFriends(null, false, next),
            (err: unknown) => showFriends(errorMessage(err), false, friends)
          );
        },
        // Only offered when there is something to send it down. The button is
        // already hidden for a friend who is not online; this hides it for a
        // player who is not connected themselves.
        onInvite: presence?.connected ? (id, name) => inviteFriend(id, name) : undefined,
        onBack: () => showProfile(),
      });

    if (rows) return paint(rows, message, busy);
    paint([], message, true);
    void fetchFriends(token).then(
      (friends) => paint(friends, message, false),
      (err: unknown) => paint([], errorMessage(err), false)
    );
  };

  /**
   * Take on an account the server just issued or handed back, then make the
   * player look at the recovery code before anything else happens.
   */
  const adopt = (issued: Issued, note: string | null) => {
    identity = issued.identity;
    // A different token, so a different connection. Signing in is also the
    // moment a player first becomes reachable at all.
    syncPresence();
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
      onRestore: (code) => {
        // Checked here so an obvious typo does not cost a round trip; the
        // server is the one that decides.
        if (!looksLikeCode(code)) return showRestore(tr("recovery.badCode"));
        showRestore(null, true);
        void restore(tidyCode(code)).then(
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

  /**
   * Report an online result and show what it was worth.
   *
   * Both sides report; the server pays out when the two agree, or when the
   * relay itself saw somebody leave. Until then it answers "pending", which is
   * not a failure — the match happened, it is simply not counted yet — so the
   * screen says nothing about a rank rather than something wrong about one.
   */
  const settleOnline = (won: boolean, championId: string) => {
    const leave = () => leaveMatch();
    const again = () => session?.requestRematch();
    // The id this result is reported against. A rematch mints a fresh one; if
    // this report's answer is still in the air when that happens, it must not
    // throw the old match's card over the new one.
    const reportedId = onlineMatchId;
    const stillCurrent = () => onlineMatchId === reportedId;
    if (!identity || !reportedId) {
      // Playing without an account, or a match the relay never named. Nothing
      // to settle; the result screen would have nothing true to put on it.
      ui.showEnd(won ? "player" : "ai", again, leave);
      return;
    }
    const tally = matchTally();
    input.setTouchControlsEnabled(false);
    const report = {
      matchId: reportedId,
      championId,
      won,
      ...tally,
      opponentSets: match?.sets.ai ?? 0,
    };
    /**
     * Ask, and come back for the answer.
     *
     * A result settles when *both* sides have reported it, and both report the
     * moment the match ends — so whichever request arrives first is told to
     * wait, and it is a coin toss which player that is. Showing them a bare
     * result screen and never asking again is why one player watched the other
     * get paid and got nothing: the coins were credited a second later, on a
     * request that had already been answered.
     *
     * The server keeps each side's outcome once it settles, so asking again is
     * how it is collected rather than a second attempt to claim it.
     */
    const collect = (tries: number) => {
      void reportOnlineMatch(identity!.token, report).then(
        (result) => {
          if ("pending" in result) {
            if (tries > 0) {
              window.setTimeout(() => collect(tries - 1), SETTLE_RETRY_MS);
              return;
            }
            // The other side never reported. Nobody is paid for a match only
            // one person can vouch for, and saying nothing about a reward is
            // better than inventing one.
            if (stillCurrent()) ui.showEnd(won ? "player" : "ai", again, leave);
            return;
          }
          // The career is real whatever the screen does with it.
          adoptServerCareer(result.career);
          if (profile) profile = { ...profile, trophies: result.career.trophies, rank: result.rank };
          if (stillCurrent()) showOutcome(won, result.outcome, leave, again);
        },
        // Offline at the final whistle. The match was still played, and saying
        // so is better than a screen that pretends it was not.
        () => {
          if (stillCurrent()) ui.showEnd(won ? "player" : "ai", again, leave);
        }
      );
    };
    collect(SETTLE_RETRIES);
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
        // Claimed on the server, not just here. The career is re-read from the
        // server on every launch, so a reward only this device knows about is
        // a reward that disappears when the app is next opened — which is
        // exactly what was happening to every claimed challenge.
        //
        // Shown immediately all the same: the arithmetic is the same on both
        // ends, so the local answer is what the server is about to say, and
        // making a player wait a round trip to see coins they have earned is
        // the wrong way round. The server's answer replaces it when it lands.
        saveCareer(claimChallenge(career, id));
        showChallenges();
        if (!identity) return;
        void claimOnServer(identity.token, id).then(
          (next) => {
            adoptServerCareer(next);
            showChallenges();
          },
          // Offline. The local claim stands for now and the next launch reads
          // the server's copy, which is the honest outcome: a reward that was
          // never recorded is a reward that was not earned as far as anyone
          // else is concerned.
          () => undefined
        );
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
    const { outcome } = settleCareer(won, championId, difficulty);
    showOutcome(won, outcome, onContinue, onRematch);
  };

  /** The card that reports a finished season, then carries on to wherever. */
  const showSeasonEnd = (ended: SeasonEnd, then: () => void) => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    refreshWallet();
    ui.showSeason({
      season: ended.title.season,
      tier: ended.title.tier,
      best: ended.title.best,
      coins: ended.coins,
      from: ended.from,
      to: ended.to,
      onDone: then,
    });
  };

  /** The card that says what a settled match was worth. */
  const showOutcome = (
    won: boolean,
    outcome: MatchOutcome,
    onContinue: () => void,
    onRematch: (() => void) | null
  ) => {
    // A month can turn with the app still open, so a match can be the thing
    // that rolls the season over. Rare, and it still has to be said — after
    // the result rather than before it, since the result is what they were
    // waiting for.
    const after = outcome.season
      ? () => showSeasonEnd(outcome.season!, onContinue)
      : onContinue;
    const next = career;
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
      onContinue: after,
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
  /**
   * The guided tour of the app, and what makes each step finish.
   *
   * Nothing here advances the tour. It only reports what is true — is there a
   * profile, is there a name on the shirt, has a setting been touched, which
   * way up is the phone — and `Tour` decides from that whether the step the
   * player is on is done. Which means there is no way for a step to be marked
   * complete except by the player having actually done the thing.
   *
   * Polled rather than pushed, because every one of those facts changes in a
   * different place: a profile is created three screens away, the phone is
   * turned by a hand. Watching four events from four modules would be four
   * ways for the tour to get stuck; asking is one.
   */
  let tour: Tour | null = null;
  let tourTimer: number | null = null;
  /** Set when a gameplay setting is changed, which is that step's whole goal. */
  let tourSawSetting = false;

  const endTour = () => {
    tour = null;
    if (tourTimer !== null) window.clearInterval(tourTimer);
    tourTimer = null;
    ui.hideTourCue();
    if (!prefs.toured) {
      prefs.toured = true;
      storePreferences(prefs);
    }
  };

  const refreshTour = () => {
    if (!tour) return;
    const step = tour.current({
      kitName: prefs.kit.name,
      hasProfile: identity !== null,
      changedSetting: tourSawSetting,
      portrait: input.isPortrait,
    });
    if (!step) {
      endTour();
      ui.notice(tr("tour.done.title"), tr("tour.done.body"), tr("nav.done"));
      return;
    }
    const { step: n, of } = tour.progress();
    ui.showTourCue({
      target: step.target,
      says: tr(step.says),
      step: n,
      of,
      onSkip: endTour,
    });
  };

  /**
   * Start the tour on the settings screen, where three of its four steps live.
   *
   * Sent there rather than left to find it: a first sentence that says "open
   * settings, then open profile" is two instructions, and the tour's whole
   * rule is one at a time.
   */
  const startTour = () => {
    if (tour) return;
    tourSawSetting = false;
    tour = new Tour(input.isPortrait);
    showSettings();
    refreshTour();
    if (tourTimer !== null) window.clearInterval(tourTimer);
    tourTimer = window.setInterval(refreshTour, TOUR_POLL_MS);
  };

  const showSettings = (back: () => void = showTitle) => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    ui.showMenu(
      tr("settings.title"),
      [
        { id: "btn-set-display", label: tr("settings.display"), sub: tr("settings.display.sub"), primary: true },
        { id: "btn-set-gameplay", label: tr("settings.gameplay"), sub: tr("settings.gameplay.sub") },
        { id: "btn-set-audio", label: tr("settings.audio"), sub: tr("settings.audio.sub") },
        { id: "btn-set-kit", label: tr("settings.kit"), sub: tr("settings.kit.sub") },
        { id: "btn-set-profile", label: tr("profile.title"), sub: identity ? identity.name : tr("recovery.restore") },
        // Replayable, and only offered once it has been seen: a tour is worth
        // going back to, and worth nothing as a row above the tour itself.
        ...(prefs.toured && !tour
          ? [{ id: "btn-set-tour", label: tr("tour.replay"), sub: tr("tour.replay.sub") }]
          : []),
      ],
      (id) => {
        if (id === "btn-set-display") showSettingsGroup("display", back);
        else if (id === "btn-set-gameplay") showSettingsGroup("gameplay", back);
        else if (id === "btn-set-kit") showSettingsGroup("kit", back);
        else if (id === "btn-set-profile") showProfile();
        else if (id === "btn-set-tour") startTour();
        else showSettingsGroup("audio", back);
      },
      undefined,
      back
    );
  };

  /**
   * Ensure the player has created a profile before completing a purchase,
   * binding the account user ID to RevenueCat.
   */
  const ensureProfileForPurchase = (): Promise<Identity | null> => {
    if (identity) return Promise.resolve(identity);
    return new Promise<Identity | null>((resolve) => {
      ui.promptProfile({
        title: "PLAYER PROFILE REQUIRED",
        detail:
          "Create your Player Profile to protect, bind, and sync all your purchases across devices.",
        confirmLabel: "CREATE PROFILE & CONTINUE",
        cancelLabel: "CANCEL",
        onConfirm: async (rawName) => {
          const problem = nameMessage(rawName);
          if (problem) throw new Error(problem);
          try {
            const created = await signUp(tidyName(rawName));
            adopt(created, null);
            await bindUserToPurchases(created.identity.id, created.identity.name);
            resolve(created.identity);
            return true;
          } catch (err) {
            throw new Error(errorMessage(err));
          }
        },
        onRestore: () => {
          showRestore();
          resolve(null);
        },
        onCancel: () => {
          resolve(null);
        },
      });
    });
  };

  /**
   * Handle purchasing / unlocking any asset (character, ball, or venue).
   */
  const handleUnlockAsset = async (assetId: string): Promise<boolean> => {
    const user = await ensureProfileForPurchase();
    if (!user) return false;
    const outcome = await purchaseAsset(assetId);
    if (outcome.ok) {
      ui.notice(tr("pro.restored.title"), "Asset unlocked successfully!", tr("pro.ok"));
      await collectPurchase();
      return true;
    }
    if (!outcome.cancelled) {
      ui.notice(tr("pro.failed.title"), outcome.message, tr("pro.ok"));
    }
    return false;
  };

  /**
   * Buy the Coliseum, which is an unlock like any other.
   *
   * It used to be the one thing sold through a RevenueCat paywall — a screen
   * designed in their dashboard rather than in the app. That bought
   * editable copy at the price of a second purchase system to keep alive, a
   * second look for the player to make sense of, and a failure nobody could
   * see: with no paywall configured the button did nothing at all and said
   * nothing about why.
   *
   * The "there is no store here" case still belongs here rather than in the
   * shared handler, because a browser needs telling plainly instead of a
   * button that appears to do nothing.
   */
  const unlockArena = async (): Promise<boolean> => {
    if (!purchasesAvailable()) {
      ui.notice(tr("pro.unavailable.title"), tr("pro.unavailable.body"), tr("pro.ok"));
      return false;
    }
    return handleUnlockAsset("gym");
  };

  /**
   * The supplies shelf.
   *
   * Built out of the settings rows rather than a screen of its own: a shop item
   * is a name, a line about what it does, and one button — which is exactly
   * what a settings row already is. A second layout that looked almost the same
   * would be two things to keep looking alike.
   */
  /**
   * Offer the coin packs, priced by the store in the player's own currency.
   *
   * A chooser rather than a paywall: these are three of the same thing in
   * different sizes, and RevenueCat's paywall is built for picking between
   * tiers of a subscription. Off-device it says so instead of doing nothing.
   */
  /**
   * How many trophies the exchange offers to take in one go.
   *
   * A fixed lot rather than a slider: the decision worth making is "do I cash
   * in", not "how many exactly", and a slider turns a two-second choice into
   * arithmetic. Capped at what the player actually holds so the row can never
   * offer a trade that will be refused.
   */
  const tradeLot = (): number => Math.min(50, career.trophies);

  const showCoinShop = (back: () => void): void => {
    void coinPackages().then((packages) => {
      const rows: [string, () => void][] = [];
      const lot = tradeLot();
      if (lot > 0) {
        rows.push([
          tf("supplies.coins.trade", { trophies: lot, coins: lot * COINS_PER_TROPHY }),
          () => {
            ui.hideOnlinePause();
            saveCareer(tradeTrophies(career, lot));
            refreshWallet();
            back();
          },
        ]);
      }

      for (const pkg of packages) {
        rows.push([
          `${pkg.coins.toLocaleString()} COINS · ${pkg.priceString}`,
          async () => {
            const user = await ensureProfileForPurchase();
            if (!user) return;
            ui.hideOnlinePause();
            const outcome = await purchaseCoins(pkg);
            if (outcome.ok && outcome.coins) {
              ui.notice(tr("pro.restored.title"), `+${outcome.coins.toLocaleString()} coins credited!`, tr("pro.ok"), back);
              await collectPurchase();
            } else if (!outcome.ok && !outcome.cancelled) {
              ui.notice(tr("pro.failed.title"), outcome.message, tr("pro.ok"), back);
            } else {
              back();
            }
          },
        ]);
      }

      if (rows.length === 0) {
        ui.notice(tr("supplies.coins.none.title"), tr("supplies.coins.none.body"), tr("pro.ok"), back);
        return;
      }
      ui.showOnlinePause(tr("supplies.coins.title"), tr("supplies.coins.body"), [
        ...rows,
        [tr("settings.restart.cancel"), () => { ui.hideOnlinePause(); back(); }],
      ]);
    });
  };

  const showSupplies = (back: () => void) => {
    viewer.deactivate();
    input.setTouchControlsEnabled(false);
    const render = (): void => {
      const legs = Math.round(staminaMultiplier(career.taken, career.armed) * 100);
      const rows: SettingRow[] = [
        {
          id: "supplies-wallet",
          label: tf("supplies.cost", { coins: career.coins }),
          hint: tf("supplies.legs", { percent: legs }),
          control: { kind: "action", label: tr("supplies.more") },
        },
        ...SUPPLIES.map((supply): SettingRow => {
          const owned = career.drinks[supply.id] ?? 0;
          const taken = career.taken.includes(supply.id);
          const armed = career.armed === supply.id;
          // Three states, and the button says which one it is in: take a
          // supplement once, arm a drink already owned, or buy either.
          const action = taken
            ? { label: tr("supplies.taken"), disabled: true }
            : supply.kind === "drink" && owned > 0
              ? { label: armed ? tr("supplies.armed") : tr("supplies.arm"), disabled: armed }
              : {
                  label: supply.kind === "supplement" ? tr("supplies.take") : tr("supplies.buy"),
                  disabled: career.coins < supply.coins,
                };
          const hint = taken
            ? supply.blurb
            : supply.kind === "drink" && owned > 0
              ? `${supply.blurb} · ${tf("supplies.owned", { n: owned })}`
              : `${supply.blurb} · ${tf("supplies.cost", { coins: supply.coins })}`;
          return {
            id: `supply-${supply.id}`,
            label: supply.label,
            hint,
            warning: !taken && career.coins < supply.coins && owned === 0 ? tr("supplies.short") : undefined,
            control: { kind: "action", ...action },
          };
        }),
      ];
      ui.showSettings(tr("supplies.title"), rows, (id) => {
        if (id === "supplies-wallet") {
          showCoinShop(() => render());
          return;
        }
        const supply = SUPPLIES.find((s) => `supply-${s.id}` === id);
        if (!supply) return;
        const owned = career.drinks[supply.id] ?? 0;
        // Arming costs nothing and is reversible; buying is the one that
        // spends, so it only happens when there is nothing to arm.
        if (supply.kind === "drink" && owned > 0) {
          career.armed = career.armed === supply.id ? null : supply.id;
        } else {
          const after = buySupply(
            { coins: career.coins, drinks: career.drinks, taken: career.taken },
            supply.id
          );
          career.coins = after.coins;
          career.drinks = after.drinks;
          career.taken = after.taken;
        }
        storeCareer(career);
        ui.setWallet(career.coins, career.trophies, tierFor(career.trophies).label);
        render();
      }, () => back());
    };
    render();
  };

  /** One focused screen of settings, and the rows that belong on it. */
  const showSettingsGroup = (
    group: "display" | "gameplay" | "audio" | "pro" | "kit",
    back: () => void
  ) => {
    const rows = (): SettingRow[] => {
      if (group === "kit") {
        return [
          {
            id: "kit-name",
            label: tr("settings.kit.name"),
            hint: prefs.kit.name || tr("settings.kit.name.hint"),
            control: { kind: "action", label: tr("settings.kit.edit") },
          },
          {
            id: "kit-number",
            label: tr("settings.kit.number"),
            hint: prefs.kit.number || tr("settings.kit.number.hint"),
            control: { kind: "action", label: tr("settings.kit.edit") },
          },
          {
            id: "kit-crest",
            label: tr("settings.kit.crest"),
            hint: tr("settings.kit.crest.hint"),
            control: {
              kind: "choice",
              value: prefs.kit.crest,
              options: CRESTS.map((c) => ({ id: c, label: tr(`settings.kit.crest.${c}`) })),
            },
          },
        ];
      }
      if (group === "pro") {
        const status = arenaStatus();
        // One thing to say and at most one thing to do. Nothing here renews,
        // lapses or needs managing, so there is no term to explain and no
        // subscription screen to hand anybody off to.
        return [
          {
            id: "pro-status",
            label: status.owned ? tr("pro.status.active") : tr("pro.status.inactive"),
            hint: status.owned ? tr("pro.status.hint.active") : tr("pro.status.hint.inactive"),
          },
          // Somebody who already owns it is not sold to again.
          ...(status.owned
            ? []
            : [
                {
                  id: "pro-unlock",
                  label: tr("pro.unlock"),
                  hint: tr("pro.unlock.hint"),
                  control: { kind: "action" as const, label: tr("pro.unlock.action") },
                },
              ]),
          // Reachable without buying anything first, and without already
          // owning it: somebody who reinstalled has no other way back in, and
          // both stores require the path to exist.
          {
            id: "pro-restore",
            label: tr("pro.restore"),
            hint: tr("pro.restore.hint"),
            control: { kind: "action", label: tr("pro.restore.action") },
          },
        ];
      }
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
            id: "gameSpeed",
            label: tr("settings.gameSpeed"),
            hint: tr("settings.gameSpeed.hint"),
            control: {
              kind: "choice",
              value: String(prefs.gameSpeed),
              options: [
                { id: "1.25", label: tr("settings.gameSpeed.normal") },
                { id: "1.45", label: tr("settings.gameSpeed.fast") },
              ],
            },
          },
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
          if (id === "kit-name" || id === "kit-number") {
            const isName = id === "kit-name";
            ui.showTextEntry({
              title: tr(isName ? "settings.kit.name" : "settings.kit.number"),
              placeholder: tr(isName ? "settings.kit.name.hint" : "settings.kit.number.hint"),
              value: isName ? prefs.kit.name : prefs.kit.number,
              maxLength: isName ? KIT_NAME_MAX : KIT_NUMBER_MAX,
              // A shirt name is upper case because that is how a shirt is
              // printed; a number is digits or it is not a number.
              clean: (raw) =>
                isName ? raw.toUpperCase().replace(/[^A-Z ]/g, "") : raw.replace(/\D/g, ""),
              submitLabel: tr("nav.done"),
              onSubmit: (entered) => {
                if (isName) prefs.kit.name = entered;
                else prefs.kit.number = entered;
                storePreferences(prefs);
                viewer.setKit(prefs.kit);
                render();
              },
              onBack: () => render(),
            });
            return;
          }
          if (id === "kit-crest" && typeof value === "string") {
            const picked = CRESTS.find((c) => c === value);
            if (picked) {
              prefs.kit.crest = picked;
              storePreferences(prefs);
              viewer.setKit(prefs.kit);
            }
            render();
            return;
          }
          if (id === "pro-unlock") {
            void unlockArena().then(render);
            return;
          }
          if (id === "pro-restore") {
            if (!purchasesAvailable()) {
              ui.notice(tr("pro.unavailable.title"), tr("pro.unavailable.body"), tr("pro.ok"));
              return;
            }
            void restorePurchases().then((outcome) => {
              render();
              if (outcome.ok && outcome.owned) {
                ui.notice(tr("pro.restored.title"), tr("pro.restored.body"), tr("pro.ok"));
              } else if (outcome.ok) {
                // A restore that finds nothing is not an error, and saying so
                // is the difference between an answer and a button that did
                // nothing visible.
                ui.notice(tr("pro.restoredNone.title"), tr("pro.restoredNone.body"), tr("pro.ok"));
              } else if (!outcome.cancelled) {
                ui.notice(tr("pro.failed.title"), outcome.message, tr("pro.ok"));
              }
            });
            return;
          }
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
            const picked = (["court", "side"] as CameraMode[]).find((mode) => mode === value);
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
          // Either of the two gameplay settings finishes that step of the
          // tour. Which one they touched does not matter; that they found the
          // screen and changed something on it is the whole lesson.
          if (id === "gameSpeed" || id === "autoReception") tourSawSetting = true;
          if (id === "gameSpeed" && typeof value === "string") {
            const num = Number(value) || 1.25;
            prefs.gameSpeed = num;
            timeScale = num;
            gs.scene.animationTimeScale = timeScale;
            storePreferences(prefs);
            render();
            return;
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
    type Seat = { character: string; ball: string; kit?: PersonalKit };
    let mine: Seat | null = null;
    let theirs: Seat | null = null;
    let launched = false;

    const launch = () => {
      if (launched || !mine || !theirs) return;
      launched = true;
      const base = CHARACTERS.find((c) => c.id === mine!.character) ?? CHARACTERS[0];
      // The character the career built, here as everywhere else: an upgrade
      // that only works against the CPU is not an upgrade.
      const me = withCareer(base, levelOf(career, base.id));
      const them = CHARACTERS.find((c) => c.id === theirs!.character) ?? CHARACTERS[0];
      const ballId = role === "host" ? mine.ball : theirs.ball;
      void startMatch(me, ballId, {
        opponent: them,
        difficulty: "normal",
        online: { conn, role, private: isPrivate },
        // Their shirt, painted on this screen too. A kit nobody else can see is
        // a kit worth nothing, and online is the only place there is anybody
        // else to see it.
        opponentKit: theirs.kit,
        // The name off the shirt where there is one, which is the name the
        // player chose for themselves. Otherwise the one the relay verified,
        // which is at least a name somebody owns.
        labels: [
          prefs.kit.name.trim() || tr("hud.you"),
          theirs.kit?.name.trim() || opponent?.name || "RIVAL",
        ],
        onEnd: (winner) => settleOnline(winner === "player", me.id),
      });
    };

    conn.setHandlers({
      onMessage: (msg) => {
        if (!isValidSetup(msg)) return;
        theirs = { character: msg.character, ball: msg.ball, kit: readKit(msg.kit) };
        launch();
      },
      // A phone drops its socket for a few seconds all the time. Say what is
      // happening rather than freezing silently, and say when it is over —
      // an unexplained pause in a live match reads as the game hanging.
      onReconnecting: (attempt, of) =>
        ui.banner(tr("net.reconnecting"), tf("net.reconnecting.sub", { n: attempt, of })),
      onReconnected: () => ui.banner(tr("net.reconnected")),
    });

    showSelect(
      tr("select.title"),
      (charId, ballId) => {
        const kit = {
          name: prefs.kit.name,
          number: prefs.kit.number,
          crest: prefs.kit.crest,
        };
        mine = { character: charId, ball: ballId, kit };
        conn.send({ t: "setup", character: charId, ball: ballId, kit });
        ui.showLobbyStatus("READY", "Waiting for your opponent to choose…", null, abandonLobby);
        launch();
      },
      showOnline,
      "ONLINE"
    );
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
  /** The relay's name for the match, which both sides report against. */
  let onlineMatchId: string | null = null;

  /**
   * Whether this device has a network at all.
   *
   * `navigator.onLine` is a weak signal — it says the radio is on, not that
   * anything is reachable — but it is decisive in the one direction that
   * matters here. False means there is certainly no connection, and online
   * play is then refused outright rather than quietly turned into something
   * else: a player with no signal knows they are offline, so an opponent
   * found in that state would be transparently invented.
   */
  const hasNetwork = (): boolean => navigator.onLine !== false;

  const quickMatch = () => {
    if (!onlineAvailable) return;
    if (!hasNetwork()) {
      ui.showLobbyStatus(tr("net.offline.title"), tr("net.offline.body"), null, showOnline);
      return;
    }
    const conn = new NetConnection(
      relayUrl(),
      {
        onQueued: (ahead) =>
          ui.setLobbyDetail(
            ahead === 0 ? "Waiting for an opponent…" : `Waiting — ${ahead} ahead of you`
          ),
        onPeer: (present, who, id) => {
          if (!present) return;
          opponent = who ?? null;
          onlineMatchId = id ?? null;
        },
      },
      identity?.token
    );
    netConn = conn;
    ui.showLobbyStatus("QUICK MATCH", tr("net.searching"), null, abandonLobby);

    /**
     * How long a real opponent is waited for before a rival is offered.
     *
     * Long enough that two people tapping QUICK MATCH within a few seconds of
     * each other still find one another, which is the whole point of a queue
     * — and short enough that somebody alone is playing rather than reading a
     * spinner. The queue is always searched first; a rival never takes a match
     * a person was waiting for.
     */
    const searchFor = setTimeout(() => {
      if (netConn !== conn) return;
      conn.cancelQueue();
      conn.close();
      netConn = null;
      startRivalMatch();
    }, QUEUE_WAIT_MS);

    conn
      .quickMatch()
      .then(({ role }) => {
        clearTimeout(searchFor);
        startOnlineMatch(conn, role, false);
      })
      .catch((e: unknown) => {
        clearTimeout(searchFor);
        if (netConn !== conn) return; // the player already cancelled, or the timer fired
        ui.showLobbyStatus(
          "NO GAME FOUND",
          e instanceof Error ? e.message : "Could not find an opponent",
          null,
          abandonLobby
        );
      });
  };

  /**
   * Play the nearest rival, when the queue had nobody in it.
   *
   * An ordinary local match underneath — the AI runs the far side, there is no
   * session and no socket — dressed as the online one the player asked for:
   * their name on the scoreboard, their shirt on the far player, and a
   * character from the roster they always play.
   */
  const startRivalMatch = () => {
    const rival = rivalFor(career.trophies);
    const them = characterFor(rival);
    // The same picker an online match uses, in the same order: found first,
    // then chosen. Skipping it here is the sort of difference a player notices
    // without being able to say what changed.
    showSelect(
      tr("select.title"),
      (charId, ballId) => {
        const base = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
        const me = withCareer(base, levelOf(career, base.id));
        void startMatch(me, ballId, {
          opponent: withCareer(them, levelOf(career, them.id)),
          // Their own way of playing, not a difficulty setting. See `rivals.ts`
          // for why a consistent opponent is what reads as a person.
          difficulty: rival.style,
          opponentKit: rival.kit,
          labels: [prefs.kit.name.trim() || tr("hud.you"), rival.name],
          onEnd: (winner) => settleCareer(winner === "player", me.id, "normal"),
        });
      },
      showOnline,
      "ONLINE"
    );
  };

  /**
   * Sit in a room waiting for the friend who has just been asked.
   *
   * `hostPrivateGame` with the code decided by the caller and the screen
   * saying who is coming rather than which code to read out. There is nobody
   * to read a code to here: the invite carried it.
   */
  const hostInviteRoom = (code: string, friendName: string) => {
    if (!onlineAvailable) return;
    const conn = new NetConnection(
      relayUrl(),
      {
        onPeer: (present, who, id) => {
          opponent = present ? (who ?? null) : null;
          if (!present) return;
          onlineMatchId = id ?? null;
          asking = null;
          ui.setLobbyDetail(`${who?.name ?? friendName} joined — starting…`);
        },
      },
      identity?.token
    );
    netConn = conn;
    ui.showLobbyStatus(
      tf("invite.asking.title", { name: friendName }),
      tr("invite.asking.body"),
      null,
      abandonLobby
    );
    conn
      .join(code)
      .then(({ ready }) => {
        if (ready) return { role: "host" as PeerRole };
        return new Promise<{ role: PeerRole }>((resolve) => {
          conn.setHandlers({
            onPeer: (present, who, id) => {
              if (!present) return;
              opponent = who ?? null;
              onlineMatchId = id ?? null;
              resolve({ role: "host" });
            },
          });
        });
      })
      .then((seat) => seat && startOnlineMatch(conn, seat.role, true))
      .catch((e: unknown) => {
        if (netConn !== conn) return;
        ui.showLobbyStatus(
          tr("net.reconnecting"),
          e instanceof Error ? e.message : "",
          null,
          abandonLobby
        );
      });
  };

  /** Accept one: join the room the invite named, as the guest. */
  const acceptInvite = (room: string, friendName: string) => {
    if (!onlineAvailable) return;
    const conn = new NetConnection(
      relayUrl(),
      {
        onPeer: (present, who, id) => {
          opponent = present ? (who ?? null) : null;
          if (present) onlineMatchId = id ?? null;
        },
      },
      identity?.token
    );
    netConn = conn;
    ui.showLobbyStatus(tf("invite.from.title", { name: friendName }), "", null, abandonLobby);
    conn
      .join(room)
      .then(({ role }) => startOnlineMatch(conn, role, true))
      .catch((e: unknown) => {
        if (netConn !== conn) return;
        ui.showLobbyStatus(
          tr("net.reconnecting"),
          e instanceof Error ? e.message : "",
          null,
          showOnline
        );
      });
  };

  const hostPrivateGame = () => {
    if (!onlineAvailable) return;
    const code = makeRoomCode();
    const conn = new NetConnection(
      relayUrl(),
      {
        onPeer: (present, who, id) => {
          opponent = present ? (who ?? null) : null;
          if (!present) return;
          onlineMatchId = id ?? null;
          ui.setLobbyDetail(`${who?.name ?? "Opponent"} joined — starting…`);
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
            onPeer: (present, who, id) => {
              if (!present) return;
              opponent = who ?? null;
              onlineMatchId = id ?? null;
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
          {
            onPeer: (present, who, id) => {
              opponent = present ? (who ?? null) : null;
              if (present) onlineMatchId = id ?? null;
            },
          },
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
                onPeer: (p, who, id) => {
                  if (!p) return;
                  opponent = who ?? null;
                  onlineMatchId = id ?? null;
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

  /**
   * The coached lesson, entered through the picker like every other mode.
   *
   * It used to have a `forced` first-launch path that skipped the picker
   * entirely. First launch opens the title screen and runs the UI tour now, so
   * nothing has passed it in a long time and the branch went with it.
   */
  const showPractice = () => {
    // The trainer is fixed, so it is a safe useful prefetch while the user is
    // choosing their own player.
    scheduleAssetPrefetch("/models/characters/SpanishPlayer.glb", 700);
    const begin = (charId: string, ballId: string) => {
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
        labels: [tr("hud.you"), tr("practice.coach")],
        practice: true,
        onEnd: () => match?.reset(),
      });
    };
    showSelect(tr("select.title"), begin, showModes, "PRACTICE");
  };

  /**
   * An opponent worth playing, given who the player brought.
   *
   * The roster is a ladder now, so a random draw is not a fair fight: a
   * beginner on BRAZIL could be handed SPAIN, who is better at everything, and
   * the difficulty setting they chose would mean nothing. Nor is the reverse
   * any better — a fully trained player wants the game to keep up.
   *
   * So the draw is weighted toward the nearest rung rather than pinned to it.
   * Nearest-only would mean facing one character forever, which is the other
   * way to make a roster boring; this keeps the field open and simply makes a
   * mismatch rare. The scale is TOTAL POWER, the same number the card in front
   * of the player shows, so the match they get agrees with the comparison they
   * were just looking at.
   */
  /**
   * The opponent, trained to about where the player is.
   *
   * Picking a *character* to match the player stopped being enough once a
   * career could take one to the top of every bar: the strongest thing on the
   * roster starts at 486 total power and a maxed player is 693, so every
   * opponent in the game was two hundred points light and the reward for a
   * long career was that the game stopped resisting.
   *
   * The level is chosen the same way the character is — by closing on the
   * player's own total — so an untrained player still meets untrained
   * opponents and nothing about the early game moves.
   */
  const trainedToMatch = (def: CharacterDef, target: number): CharacterDef => {
    let best = def;
    let bestGap = Math.abs(totalPower(def) - target);
    for (let level = 2; level <= MAX_LEVEL; level++) {
      const at = withCareer(def, level);
      const gap = Math.abs(totalPower(at) - target);
      if (gap >= bestGap) continue;
      best = at;
      bestGap = gap;
    }
    return best;
  };

  const matchedOpponent = (playerDef: CharacterDef, ownId: string): CharacterDef => {
    const others = CHARACTERS.filter((c) => c.id !== ownId);
    const mine = totalPower(playerDef);
    // A gap of one rung is roughly 40 points of total power, so this leaves
    // the neighbour clearly likeliest and the far end of the roster possible.
    const weights = others.map((c) => 1 / (1 + Math.abs(totalPower(c) - mine) / 25));
    let roll = Math.random() * weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < others.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return trainedToMatch(others[i], mine);
    }
    return trainedToMatch(others[others.length - 1], mine);
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
        showSelect(
          tr("select.title"),
          (charId, ballId) => {
            const base = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
            // The level the career has this character at is applied here, at the
            // one place a match is built, so an upgrade is felt in the next game
            // rather than being a number on a card.
            const playerDef = withCareer(base, levelOf(career, base.id));
            const opponent = matchedOpponent(playerDef, charId);
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
          },
          showDifficulty,
          `FRIENDLY · ${diff.toUpperCase()}`
        );
      },
      tr("difficulty.sub"),
      showModes
    );
  };

  const showFormats = () => {
    // A run left half-played is offered back before anything else on the
    // screen. It goes here rather than on the title screen deliberately: PLAY
    // is the only thing the first screen says, and a competition the player
    // may have forgotten about is not worth breaking that for.
    const saved = readCompetition();
    const resumeBtn = saved
      ? [
          {
            id: "btn-format-resume",
            label: tr("comp.resume"),
            sub: describeCompetition(saved, (cid) => CHARACTERS.find((c) => c.id === cid)?.label ?? cid),
            primary: true,
          },
        ]
      : [];
    ui.showMenu(
      tr("comp.title"),
      [
        ...resumeBtn,
        { id: "btn-format-cup", label: tr("comp.cup"), sub: tr("comp.cup.sub"), primary: !saved },
        { id: "btn-format-league", label: tr("comp.league"), sub: tr("comp.league.sub") },
      ],
      (id) => {
        if (id === "btn-format-resume" && saved) {
          resumeCompetition(saved);
          return;
        }
        const format = id === "btn-format-cup" ? ("cup" as const) : ("league" as const);
        // Picking a format when a run is saved is the decision to abandon it:
        // `startCompetition` overwrites the save, and it happens after the
        // character and ball have been chosen, so backing out of that screen
        // still leaves the old run intact.
        showSelect(
          tr("select.title"),
          (charId, ballId) => {
            startCompetition(format, charId, ballId);
          },
          showFormats,
          `COMPETITION · ${format.toUpperCase()}`
        );
      },
      tr("comp.sub"),
      showModes
    );
  };

  const showSelect = (
    title: string,
    onConfirm: (charId: string, ballId: string) => void,
    onBack: () => void,
    modeLabel?: string
  ) => {
    viewer.activate();
    // The shirt may have been edited since the last visit to this screen.
    // Kit colors are now fixed per character (official kit colors).
    input.setTouchControlsEnabled(false);
    // The first ball is what the picker opens on, so it is the one most likely
    // to be played. Begin it at idle priority while the selected character
    // preview is being readied.
    scheduleAssetPrefetch(`/models/Ball_and_Table/${BALLS[0].id}.glb`, 900);
    const isVenueUnlocked = (id: string): boolean => {
      if (!isPremiumVenue(id)) return true;
      if (id === "gym" && (ownsArena() || career.unlockedAssets?.includes("gym"))) return true;
      if (id === "basketball" && (career.unlockedAssets?.includes("basketball") || career.best >= 450)) return true;
      return false;
    };

    ui.showSelect({
      modeLabel,
      characters: CHARACTERS,
      balls: BALLS,
      locked: Object.fromEntries<string>([
        ...CHARACTERS.filter((c) => !isUnlocked(career, c.id)).map(
          (c): [string, string] => [c.id, tf("select.unlockAt", { trophies: UNLOCK_AT[c.id] ?? 0 })]
        ),
        // Balls unlock on the same currency as players, so one screen answers
        // "what is there to play for" for everything on it.
        ...BALLS.filter((b) => !career.unlockedAssets?.includes(b.id) && career.best < b.unlockAt).map(
          (b): [string, string] => [b.id, tf("select.unlockAt", { trophies: b.unlockAt })]
        ),
        // Premium venues locked by entitlement or trophies/purchase
        ...VENUE_IDS.filter((id) => !isVenueUnlocked(id)).map(
          (id): [string, string] => [
            id,
            id === "basketball"
              ? tf("select.unlockAt", { trophies: 450 })
              : tr("select.venuePro"),
          ]
        ),
      ]),
      prices: Object.fromEntries(
        [...CHARACTERS.map((c) => c.id), ...BALLS.map((b) => b.id), ...VENUE_IDS].map((id) => [
          id,
          formattedPriceFor(id),
        ])
      ),
      onUnlockAsset: async (id) => {
        return handleUnlockAsset(id);
      },
      hasBallAffinity: (charId, ballId) => hasBallAffinity(charId, ballId),
      hasVenueAffinity: (charId, venueId) => hasVenueAffinity(charId, venueId),
      // What this ball does for *this* player, so affinity is visible at the
      // moment it matters rather than buried in a table somewhere.
      withBall: (characterId, ballId) => {
        const base = CHARACTERS.find((c) => c.id === characterId) ?? CHARACTERS[0];
        const trained = withCareer(base, levelOf(career, base.id));
        return { base: trained, withBall: withBall(trained, ballFor(ballId)) };
      },
      venues: VENUE_IDS.map((id) => ({
        id,
        label: venueFor(id).label,
        locked: !isVenueUnlocked(id),
      })),
      venue: venueId,
      // Called when PLAY is pressed, to commit whatever the venue tab is
      // showing — and to sell it first if it is not owned. Browsing only
      // previews; nothing is bought by scrolling past it.
      onVenue: async (id) => {
        const picked = VENUE_IDS.find((v) => v === id);
        if (!picked) return false;
        // Already the chosen venue: nothing to do, and emphatically not a
        // refusal.
        if (picked === venueId) return true;
        if (isPremiumVenue(picked) && !isVenueUnlocked(picked)) {
          const unlocked = await handleUnlockAsset(picked);
          if (!unlocked) return false;
        }
        storeVenue(picked);
        venueId = picked;
        if (match) {
          match.venueId = picked;
          match.indoorVenue = picked === "gym";
        }
        void gs.setVenue(venueFor(picked));
        return true;
      },
      title,
      onBrowse: async (kind, id) => {
        if (kind === "venue") {
          // Nothing to load: the tab shows a still, and the venue itself is
          // only built when PLAY commits the choice. Browsing used to swap the
          // live scene, which meant downloading an arena to look at a name.
          viewer.deactivate();
          return true;
        }
        viewer.activate();
        // Blurred before the load is awaited, so a locked model is never
        // legible for the frame between arriving and being obscured.
        viewer.setBlurred(kind === "character" && !isUnlocked(career, id));
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
        // Settled, but not *reported* here: a competition already has a screen
        // that says what the match did, and a full result card between every
        // round would turn a cup run into a series of receipts. What the round
        // paid is carried to that screen as one line instead.
        const { outcome } = settleCareer(winner === "player", human.id, difficulty);
        compEarned.coins += outcome.coins;
        compEarned.trophies += outcome.trophies;
        // Stop the court before the standings go up over it. A competition is
        // the one flow that leaves a finished match standing while it waits for
        // a press, and nothing else was stopping it — the ball stayed live, the
        // CPU kept playing and the crowd kept reacting behind an opaque screen,
        // for as long as the player left it open. The next round builds its own
        // controller, so nothing has to thaw this one.
        match?.setTutorialFrozen(true);
        onEnd(winner === "player", sets);
      },
    });
  };

  /** A character at its current career level, by id. */
  const compChar = (id: string): CharacterDef => {
    const base = CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
    return withCareer(base, levelOf(career, base.id));
  };

  /**
   * What the run has paid so far.
   *
   * A competition is the one flow where the player plays several matches
   * without a result card between them, so without this they would finish a
   * cup with no idea what any of it earned. Reset when a run starts, and
   * deliberately not restored on resume: the coins from a session two days ago
   * are already in the wallet, and re-announcing them would read as paying
   * twice.
   */
  let compEarned = { coins: 0, trophies: 0 };

  /**
   * Close a run out: pay the prize for where the player finished, tell them
   * what the whole thing was worth, and let the arena react if they won it.
   *
   * The prize is paid here rather than inside `settleCareer` because it is not
   * a match result — it is for the run, and it is the thing that makes a cup
   * worth choosing over the two friendlies it is otherwise identical to.
   */
  const finishCompetition = (kind: CompetitionKind, place: number): string[] => {
    const { career: paid, prize } = awardCompetition(career, kind, place);
    career = paid;
    saveCareer(career);
    compEarned.coins += prize.coins;
    compEarned.trophies += prize.trophies;
    clearCompetition();
    refreshWallet();
    if (place === 1) {
      // Both already exist and were wired only to individual points, which is
      // the one moment of a match that does not need them most.
      cheerCrowd();
      audio.playApplause();
    }
    return prize.coins > 0 ? [`${tr("comp.prize")} — ${earnedRow()}`] : [earnedRow()];
  };

  /** The earnings line the standings screens carry. */
  const earnedRow = (): string =>
    `<b>+${compEarned.trophies}</b> ${tr("result.trophies")} · <b>+${compEarned.coins}</b> ${tr("result.coins")}`;

  const startCompetition = (format: CompetitionFormat, charId: string, ballId: string) => {
    const human = compChar(charId);
    const others = CHARACTERS.filter((c) => c.id !== human.id).sort(() => Math.random() - 0.5);
    // Starting a competition replaces whatever was saved. The draw is made
    // once and written down with it: reshuffling on resume would hand the
    // player a different tournament from the one they were halfway through.
    const run: SavedCompetition = {
      format,
      players: [human.id, ...others.slice(0, 3).map((c) => c.id)],
      ballId,
      round: 0,
      ...(format === "league" ? { table: [0, 0, 0, 0].map(() => ({ pts: 0, diff: 0 })) } : {}),
    };
    storeCompetition(run);
    compEarned = { coins: 0, trophies: 0 };
    resumeCompetition(run);
  };

  /** Play a saved run from the round it stopped at. */
  const resumeCompetition = (run: SavedCompetition) => {
    compEarned = { coins: 0, trophies: 0 };
    const players = run.players.map(compChar);
    const [human, ...others] = players;
    if (run.format === "cup") runCup(human, others, run.ballId, run);
    else runLeague(human, others, run.ballId, run);
  };

  const runCup = (
    human: CharacterDef,
    others: CharacterDef[],
    ballId: string,
    run: SavedCompetition
  ) => {
    // Draw: SF1 = human vs others[0], SF2 = others[1] vs others[2].
    const [sf1Opp, sf2a, sf2b] = others;

    /**
     * The half of the cup that follows the semi-finals.
     *
     * Reached twice: once by playing the semi, and once by resuming a run that
     * already had. Both arrive with the same four facts, so the tournament a
     * player comes back to is the one they left.
     */
    const toFinal = (won: boolean, sets: [number, number], sf2: { winA: boolean; sets: [number, number] }) => {
        const sf2Winner = sf2.winA ? sf2a : sf2b;
        const sf2Loser = sf2.winA ? sf2b : sf2a;
        const finalOpp = won ? sf2Winner : sf2Loser;
        const finalName = won ? "WINNER FINAL" : "LOSER FINAL (3rd place)";
        storeCompetition({
          ...run,
          round: 1,
          cup: { wonSemi: won, semiSets: sets, sf2Sets: sf2.sets, sf2WinA: sf2.winA },
        });
        ui.showStandings(
          "CUP — SEMI-FINALS",
          [
            scoreline(human, sf1Opp, sets),
            scoreline(sf2a, sf2b, sf2.sets),
            earnedRow(),
            `next: ${finalName} — ${human.label} vs ${finalOpp.label}`,
          ],
          "PLAY FINAL",
          () => {
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
              // Where the player actually finished, which the standings order
              // already encodes: champion, runner-up, third or fourth.
              const place = won ? (wonFinal ? 1 : 2) : wonFinal ? 3 : 4;
              const paid = finishCompetition("cup", place);
              ui.showStandings(
                "CUP — FINAL RESULT",
                [`your final: ${scoreline(human, finalOpp, finalSets)}`, ...standings, "—", ...paid],
                "BACK TO MENU",
                () => leaveMatch(),
                place === 1,
                () => leaveMatch()
              );
            });
          },
          false,
          () => leaveMatch()
        );
    };

    // Resumed after the semi-finals: replay none of them, just go to the tie
    // they were about to play.
    if (run.round > 0 && run.cup) {
      toFinal(run.cup.wonSemi, run.cup.semiSets, { winA: run.cup.sf2WinA, sets: run.cup.sf2Sets });
      return;
    }

    ui.showStandings(
      "CUP — THE DRAW",
      [
        `SEMI-FINAL 1 — ${human.label} vs ${sf1Opp.label}`,
        `SEMI-FINAL 2 — ${sf2a.label} vs ${sf2b.label}`,
        `then the losers meet for 3rd place and the winners for the trophy`,
      ],
      "PLAY SEMI-FINAL",
      () => {
        playCompMatch(human, sf1Opp, ballId, "normal", (won, sets) => {
          toFinal(won, sets, simulateMatch(sf2a, sf2b));
        });
      },
      false,
      () => {
        clearCompetition();
        showFormats();
      }
    );
  };

  const runLeague = (
    human: CharacterDef,
    others: CharacterDef[],
    ballId: string,
    run: SavedCompetition
  ) => {
    const players = [human, ...others]; // human = index 0
    // Standard 4-player round robin; the human plays one match per round.
    const rounds: [number, number][][] = [
      [[0, 1], [2, 3]],
      [[0, 2], [1, 3]],
      [[0, 3], [1, 2]],
    ];
    // Carried from the save, so a resumed league keeps every result it had.
    const table = run.table ?? players.map(() => ({ pts: 0, diff: 0 }));
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
          // Written before the standings go up, so the run survives a player
          // who reads the table and then closes the app.
          storeCompetition({ ...run, round: round + 1, table });
          ui.showStandings(
            `LEAGUE — ROUND ${round + 1}`,
            [...rows, earnedRow()],
            "PLAY NEXT ROUND",
            () => playRound(round + 1),
            false,
            () => leaveMatch()
          );
        } else {
          // The table is already sorted, so the player's place is where they
          // appear in it.
          const order = players
            .map((p, i) => ({ p, ...table[i] }))
            .sort((x, y) => y.pts - x.pts || y.diff - x.diff);
          const place = order.findIndex((r) => r.p.id === human.id) + 1;
          const paid = finishCompetition("league", place);
          const champion = tableRows()[0];
          ui.showStandings(
            "LEAGUE — FINAL TABLE",
            [...rows, "—", `🏆 ${champion}`, ...paid],
            "BACK TO MENU",
            () => leaveMatch(),
            place === 1,
            () => leaveMatch()
          );
        }
      });
    };
    // A resumed league goes straight back to its next round: the player has
    // already read the schedule, and showing it again would look like the run
    // had restarted from the top.
    if (run.round > 0) {
      playRound(run.round);
      return;
    }
    ui.showStandings(
      "LEAGUE — SCHEDULE",
      [
        `round 1: ${human.label} vs ${players[1].label} · ${players[2].label} vs ${players[3].label}`,
        `round 2: ${human.label} vs ${players[2].label} · ${players[1].label} vs ${players[3].label}`,
        `round 3: ${human.label} vs ${players[3].label} · ${players[1].label} vs ${players[2].label}`,
      ],
      "PLAY ROUND 1",
      () => playRound(0),
      false,
      () => {
        clearCompetition();
        showFormats();
      }
    );
  };

  // ------------------------------------------------------------ match setup

  const startMatch = async (player: CharacterDef, ballId: string, opts: MatchOpts) => {
    // The ball is applied here, at the one place a match is built, for the same
    // reason the career level is: four call sites reach this one, and a trait
    // that only counts in three of them is worse than one that counts in none.
    // Only the human's ball is theirs — the opponent plays their own game.
    // Legs first, then the ball. The armed drink is taken out of the bag here,
    // at the start of the match rather than the end: a player who quits after
    // drinking it has still drunk it, and refunding it would make a free retry
    // out of every hard game.
    const { wallet, drank } = consumeArmed(
      { coins: career.coins, drinks: career.drinks, taken: career.taken },
      career.armed
    );
    if (drank) {
      career.coins = wallet.coins;
      career.drinks = wallet.drinks;
      career.taken = wallet.taken;
      // Nothing left to arm once it is drunk.
      if ((career.drinks[drank] ?? 0) === 0) career.armed = null;
      storeCareer(career);
      ui.setWallet(career.coins, career.trophies, tierFor(career.trophies).label);
    }
    // What the shelf bought, then what the ball does — legs and sharpness
    // first, because a supply is something the player brought with them and a
    // ball is what they picked up on the way out.
    const supplied = withSupplies(player, career.taken, drank);
    const playerDef = withBallAndVenue(supplied, ballFor(ballId), venueId);
    const opponentDef = withBallAndVenue(opts.opponent, ballFor(ballId), venueId);
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
      Character.load(gs.scene, opponentDef),
    ]);
    // The human's shirt only. The opponent is somebody else and wears their own
    // kit — printing the player's name on both is the version of this feature
    // that reads as a bug. Awaited so the first frame already shows it, and
    // never allowed to throw: a name on a shirt must not cost anyone a match.
    // The human's shirt, and online the other human's too. A kit nobody else
    // can see is a kit worth nothing, and the opponent's own marks are the only
    // thing that makes the far end of the table a person rather than a model.
    // Never allowed to throw: a name on a shirt must not cost anyone a match.
    const paint = async (char: Character, kit: Kit) => {
      try {
        await applyKit(char.meshes, kit, (url, invertY) => {
          const painted = new Texture(url, gs.scene, undefined, invertY);
          painted.name = "shirt (kit)";
          return painted;
        });
      } catch (error) {
        console.warn("[kit] could not paint the shirt:", error);
      }
    };
    await paint(playerChar, kitForCharacter(playerDef, prefs.kit));
    // The far side wears its own marks when there is somebody behind it: the
    // other human online, or the rival a quick match found when the queue was
    // empty. A plain CPU opponent wears the kit the artist made.
    if (opts.opponentKit) await paint(aiChar, kitForCharacter(opponentDef, opts.opponentKit));
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
      ballTrail?.dispose();
      trailMat?.dispose();
      trailMat = new StandardMaterial("ball-trail", gs.scene);
      trailMat.emissiveColor = new Color3(1, 0.72, 0.32);
      trailMat.disableLighting = true;
      trailMat.alpha = 0;
      // Wider than the ball's own radius and round rather than square: at four
      // section points the tube is a flat ribbon that disappears edge-on, which
      // is exactly when a smash is worth seeing. Eight costs 288 vertices.
      ballTrail = new TrailMesh("ball-trail", ballMesh, gs.scene, {
        diameter: BALL_RADIUS * 1.5,
        length: 32,
        sections: 8,
        autoStart: true,
      });
      ballTrail.material = trailMat;
      ballTrail.isPickable = false;
    }
    for (const c of [playerChar, aiChar]) {
      for (const m of c.meshes) {
        if (m.getTotalVertices() > 0) gs.shadows?.addShadowCaster(m, false);
      }
    }
    // The pair this replaces, before the reference to them is dropped.
    //
    // `leaveMatch` used to be the only thing that disposed a character, which
    // was fine for every flow that goes back to a menu between matches — a
    // rematch reuses the same rigs through `match.reset()`, and online always
    // leaves first. A competition does not: it runs its rounds back to back
    // through here, so each new round left the last round's two players
    // standing on court, idle, and a league was four spare bodies deep by its
    // third round.
    //
    // Here rather than at the top of the function on purpose. The new rigs are
    // already loaded by this point, so the swap is instant and the loading
    // screen covers it either way; and there is no `await` between this and
    // `match = controller`, so the render loop cannot tick in the gap and find
    // a controller pointing at disposed rigs.
    for (const c of chars) c.dispose();
    chars = [playerChar, aiChar];

    audio.stopMusic();
    ui.setLabels(opts.labels[0], opts.labels[1]);
    const controller = new MatchController(ball, playerChar, aiChar, {
      setScore: (p, a, s, sp, sa) => ui.setScore(p, a, s, sp, sa),
      banner: (t, sub) => ui.banner(t, sub),
      hint: (t) => ui.hint(t),
      meter: (f, s0, s1) => ui.meter(f, s0, s1),
      meterResult: (q) => ui.meterResult(q),
      stamina: (p, a, pMax, aMax) => ui.stamina(p, a, pMax, aMax),
      onMatchEnd: (winner) => {
        const sets: [number, number] = [controller.sets.player, controller.sets.ai];
        window.setTimeout(() => opts.onEnd(winner, sets), 1800);
      },
    }, audio);
    // The crowd is still between points; a point is what brings it up. A match
    // starts from stillness, so a cheer still running when the last one ended
    // does not carry into the first serve of this one.
    stopCrowdCheer();
    controller.subscribe((event) => {
      if (event.type === "point-awarded") cheerCrowd();
      // Every serve, strike and pop comes through here, which is the one place
      // that knows a ball has just been given a new velocity — and so the only
      // honest place to start the streak from.
      if (event.type === "ball-launched") {
        trailHold = TRAIL_DELAY;
        ballTrail?.stop();
      }
    });
    controller.aimMarker = gs.aimMarker;
    controller.landingMarker = gs.landingMarker;
    controller.serveMarker = gs.serveMarker;
    controller.practice = opts.practice === true;
    controller.venueId = venueId;
    controller.indoorVenue = venueId === "gym";
    // Practice gives no assistance. The automatic first reception is the
    // biggest thing the game does for a player, and a lesson taught with it on
    // teaches a game they will never play again the moment they leave.
    controller.autoFirstReception = opts.practice ? false : prefs.autoReception;
    // An empty hall, and no scoreboard. A lesson happening in front of a full
    // stand with a score above it is a match, and a player who is losing a
    // tutorial stops listening to it.
    gs.setCrowdVisible(!opts.practice);
    ui.setScoreVisible(!opts.practice);
    match = controller;
    // Online play is a two-human match whose second seat is a socket, so it
    // needs no AI and no split screen: each player has their own device.
    // Online is a two-human match whose second seat is a socket, so it needs
    // no AI; the session turns `versus` on for itself.
    aiCtl = opts.online
      ? null
      : new AIController(
          controller,
          opts.practice
            ? PRACTICE_DIFFICULTY
            : typeof opts.difficulty === "string"
              ? DIFFICULTIES[opts.difficulty]
              : opts.difficulty
        );
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
          // Reported like any other win. The server decides whether it counts:
          // it asks the relay whether that socket really went, and how far the
          // match had got — a forfeit inside the first set is void for both.
          settleOnline(true, playerDef.id);
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
        onRematchState: (state, detail) => {
          switch (state) {
            case "asking":
              ui.showOnlinePause("REMATCH?", "Asking your opponent…", [
                ["LEAVE MATCH", () => leaveMatch()],
              ]);
              return;
            case "asked":
              ui.showOnlinePause("REMATCH?", "Your opponent wants a rematch", [
                ["ACCEPT", () => session?.respondToRematch(true)],
                ["DECLINE", () => session?.respondToRematch(false)],
              ]);
              return;
            case "none":
              ui.hideOnlinePause();
              if (detail) ui.banner("REMATCH", detail);
              return;
          }
        },
        // Both peers land here on the same agreed transition. The host's reset
        // is the authoritative one — it owns the rules and the serve order —
        // and the guest's is presentation; the snapshots that follow re-drive
        // everything it shows.
        onMatchId: (id) => {
          onlineMatchId = id;
        },
        onRematch: () => {
          input.setTouchControlsEnabled(true);
          ui.showHUD();
          match?.reset();
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
          () => input.isTouch && input.isPortrait,
          () => {
            if (!prefs.coached) {
              prefs.coached = true;
              storePreferences(prefs);
            }
            leaveMatch();
          }
        )
      : null;
    practiceCoach?.start();
    (window as unknown as Record<string, unknown>).__teq = {
      match,
      ball,
      engine: gs.engine,
      camera: gs.camera,
      /**
       * World point to pixels, for the layout harness.
       *
       * Exposed because "is the player on screen" is a question only the real
       * projection can answer, and the alternative — re-deriving the camera
       * maths in the test — checks a copy of the code rather than the code.
       */
      project: (x: number, y: number, z: number) => {
        const p = Vector3.Project(
          new Vector3(x, y, z),
          Matrix.Identity(),
          gs.scene.getTransformMatrix(),
          gs.camera.viewport.toGlobal(gs.engine.getRenderWidth(), gs.engine.getRenderHeight())
        );
        return { x: p.x, y: p.y };
      },
    };
  };

  ui.hideLoading();

  // On first launch, walk them through the app rather than describing it.
  //
  // This used to be a stack of cards read and dismissed, which teaches nothing
  // that survives the dismissing. The tour points at one thing at a time and
  // each step ends when the player has actually done it, so what they are left
  // with is a profile, their name on a shirt, and the memory of having made
  // them. `prefs.toured` is its own flag: `coached` means the lesson on the
  // court has been played, which is a different thing to have learnt.
  if (!prefs.toured) {
    showTitle();
    startTour();
  } else if (endedSeason) {
    showSeasonEnd(endedSeason, showTitle);
  } else {
    showTitle();
  }
  // Reachable from here on, if there is an account to be reached at.
  syncPresence();
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
