import type { Side } from "./ball";
import type { CameraMode, CharacterDef } from "./config";
import type { ViewerKind } from "./viewer";

/**
 * A page of the picker.
 *
 * Venues are here rather than in the model viewer because the *real* scene is
 * already standing behind this screen with the venue built in it. Loading a
 * second copy into the viewer's studio would cost a 4.8 MB arena to show a
 * worse version of something the player can simply be shown directly.
 */
export type SelectTab = ViewerKind | "venue";
import { t, tf } from "./i18n";
import { randomTip } from "./tips";
import { RATING_KEYS, rating, totalPower, type RatingKey } from "./ratings";
import { MAX_CLUB_MEMBERS, tidyCode } from "./account";
import { assetUrl } from "./protected";

/** The opening cinematic, and the blurred still that sits behind its bars. */
const INTRO_CLIP = "/video/intro.mp4";
const BACKDROP = "/video/intro-backdrop.webp";

/** One line of plain English per trait, for the tooltip on the picker. */
const RATING_DETAIL: Record<RatingKey, string> = {
  reactivity: "Response and court movement",
  power: "Kick and serve power",
  control: "Aim precision and placement",
  agility: "Acceleration and how far they stretch",
  volley: "Taking the ball early, before it drops",
  serve: "Pace and placement of the opening ball",
  stamina: "How long the legs last in a long rally",
};

export interface SelectItem {
  id: string;
  label: string;
  /**
   * Shown, but behind a purchase. Marked rather than hidden or disabled: a
   * venue nobody can see is not one anybody will buy, and the lock is the
   * thing that says what the game has beyond what was given away.
   */
  locked?: boolean;
}

export interface SelectOptions {
  /** Character definitions carry the live abilities shown in the selector. */
  characters: CharacterDef[];
  balls: SelectItem[];
  /** Venues to choose between, right before the match rather than in settings. */
  venues?: SelectItem[];
  /** Which venue is currently built. */
  venue?: string;
  /**
   * Items that cannot be played yet, keyed by id, mapped to what it takes.
   *
   * Locked entries stay in the carousel rather than being filtered out of it.
   * A roster of one says the game has one player in it; the same roster with
   * three locked names says there are four, and what each of them costs — the
   * difference between an empty menu and a reason to keep playing.
   */
  locked?: Record<string, string>;
  /** Formatted real store prices for items ($0.99, $2.99, etc.). */
  prices?: Record<string, string>;
  /**
   * The chosen player with and without the browsed ball.
   *
   * Returns both so the card can show the difference rather than a second set
   * of numbers: "+6 POWER" is a reason to own a ball, and "104 POWER" is not.
   */
  withBall?: (characterId: string, ballId: string) => { base: CharacterDef; withBall: CharacterDef };
  /** True if this character has favorite ball synergy. */
  hasBallAffinity?: (characterId: string, ballId: string) => boolean;
  /** True if this character has home court synergy. */
  hasVenueAffinity?: (characterId: string, venueId: string) => boolean;
  /**
   * Called when a different venue is picked; the scene swaps behind the picker.
   *
   * Answers whether the pick was allowed to stand, because a locked venue sends
   * the player through the paywall and they are free to back out of it. The
   * strip waits for that answer rather than lighting the chip up first.
   */
  onVenue?: (id: string) => boolean | Promise<boolean>;
  /** Called when the player wants to unlock a character, ball, or venue directly with $. */
  onUnlockAsset?: (id: string, kind: SelectTab) => Promise<boolean>;
  /** Heading shown above the tabs (defaults to "CHOOSE YOUR SETUP"). */
  title?: string;
  /** Subtitle / mode indicator shown in the top bar (e.g. "FRIENDLY · NORMAL"). */
  modeLabel?: string;
  subtitle?: string;
  /** Called whenever the browsed item changes; resolve when the model is visible. */
  onBrowse: (kind: SelectTab, id: string) => Promise<unknown> | void;
  onConfirm: (characterId: string, ballId: string) => void;
  /** Return to the screen that led into the picker. */
  onBack?: () => void;
}

/** One row in the settings window: a label, a hint, and a control. */
export type SettingControl =
  | { kind: "choice"; options: { id: string; label: string }[]; value: string }
  | { kind: "toggle"; value: boolean }
  /**
   * A row that does something when pressed rather than holding a value —
   * restoring a purchase, or opening the store's own management screen. Those
   * belong in settings and cannot be expressed as a preference.
   */
  | { kind: "action"; label: string; disabled?: boolean };

export interface SettingRow {
  id: string;
  label: string;
  hint?: string;
  /** Shown under the row in warning colours, e.g. what changing it costs. */
  warning?: string;
  /** Omitted for a row that only states something — a status, not a choice. */
  control?: SettingControl;
}

export interface MenuOption {
  id: string;
  label: string;
  sub?: string;
  /** Accepted for compatibility; the simplified menu no longer renders tags. */
  tag?: string;
  /** Gives an option the visual emphasis of the recommended route. */
  primary?: boolean;
}

export interface PracticePanelState {
  title: string;
  goal: string;
  /** The input this step needs, e.g. "HOLD STRIKE" — shown under the goal. */
  control?: string;
  skip?: string;
  onSkip?: () => void;
}

/** One roster card on the CHAMPIONS screen. */
export interface ChampionRow {
  id: string;
  label: string;
  level: number;
  maxLevel: number;
  unlocked: boolean;
  /** Trophies that unlock this character, shown while it is still locked. */
  unlockAt: number;
  /** Coins the next level costs, or null once there is no next level. */
  cost: number | null;
  affordable: boolean;
  /** Matches still to play before the level goes up on its own, null at the cap. */
  nextIn: number | null;
  /** The three traits, already scored, in the order they are shown. */
  stats: { label: string; value: number }[];
  /** The three added together: one number to hold two players up against. */
  power: number;
}

export interface ChampionsView {
  rows: ChampionRow[];
  onUpgrade: (id: string) => void;
  onBack: () => void;
}

/** One daily challenge, with where the player has got to on it. */
export interface ChallengeRow {
  id: string;
  text: string;
  progress: number;
  goal: number;
  reward: number;
  claimed: boolean;
}

export interface ChallengesView {
  rows: ChallengeRow[];
  /** Time until the set rolls over, already formatted. */
  resetsIn: string;
  onClaim: (id: string) => void;
  onBack: () => void;
}

/** What a finished match did to the career, for the screen that reports it. */
export interface ResultView {
  won: boolean;
  /** Trophies gained or lost, and the total afterwards. */
  trophies: number;
  total: number;
  coins: number;
  tier: string;
  /** The rung above and how far off it is, or null at the top of the ladder. */
  nextTier: string | null;
  toNext: number;
  progress: number;
  rank: "promoted" | "relegated" | null;
  /** Level-ups and finished challenges, already worded. */
  notes: string[];
  onContinue: () => void;
  onRematch: (() => void) | null;
}

/** The card that reports a season that ended while the player was away. */
export interface SeasonView {
  /** The season that ended, as `YYYY-MM`. */
  season: string;
  /** The tier reached in it — the thing being congratulated. */
  tier: string;
  /** The highest trophy count held during it. */
  best: number;
  coins: number;
  /** Trophies before and after the halving. */
  from: number;
  to: number;
  onDone: () => void;
}

/** The account screen, in whichever of its two states applies. */
export interface ProfileView {
  /** Null while the player has no account yet. */
  profile: {
    id: string;
    name: string;
    trophies: number;
    tier: string;
    matches: number;
    rank: number | null;
  } | null;
  /** Shown under the form: a validation message, or what the server said. */
  message: string | null;
  /**
   * Said before signing up, when there is offline progress that will not come
   * with them. Signing up adopts the server's career, and a player who finds
   * that out afterwards has every right to be annoyed about it.
   */
  freshStart: string | null;
  /** Seasons already finished, oldest first. Empty until one has been. */
  titles: { season: string; tier: string; best: number }[];
  busy: boolean;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  /** Somebody who already has a profile, on a phone that does not. */
  onRestore: () => void;
  /** Replace the recovery code, for a player who lost the slip of paper. */
  onNewCode: () => void;
  onFriends: () => void;
  onClub: () => void;
  onLeaderboard: () => void;
  onBack: () => void;
}

export interface BoardRow {
  rank: number;
  id: string;
  name: string;
  trophies: number;
  tier: string;
  isMe: boolean;
}

export interface LeaderboardViewModel {
  rows: BoardRow[];
  total: number;
  /** The caller's row when they are outside the visible top. */
  me: BoardRow | null;
  message: string | null;
  onBack: () => void;
}

/** The one-time showing of a recovery code. */
export interface RecoveryView {
  code: string;
  /** Extra line under the code, e.g. that it replaced an older one. */
  note: string | null;
  onDone: () => void;
}

/** Taking an account over onto this device. */
/**
 * Rewrite a recovery-code field as it is typed: upper case, look-alikes
 * folded, hyphens appearing as each group of four fills.
 *
 * The code is written down in one shape and should be typed back in that
 * shape. Leaving the player to reproduce the punctuation from memory, and
 * telling them afterwards that they got it wrong, is a bad way to greet
 * somebody who has just lost their phone.
 *
 * The caret is put back after the same number of code characters it was after
 * before, hyphens not counted — otherwise correcting a character in the middle
 * throws it to the end.
 */
export function formatCodeField(el: HTMLInputElement): void {
  const caret = el.selectionStart ?? el.value.length;
  const typedBefore = tidyCode(el.value.slice(0, caret)).replace(/-/g, "").length;
  const tidied = tidyCode(el.value);
  if (tidied === el.value && caret === el.selectionEnd) return;
  el.value = tidied;
  let seen = 0;
  let at = 0;
  while (at < tidied.length && seen < typedBefore) {
    if (tidied[at] !== "-") seen++;
    at++;
  }
  // Sitting just before a hyphen means the next character typed would land on
  // the wrong side of it; step over.
  if (tidied[at] === "-") at++;
  el.setSelectionRange(at, at);
}

/** One step of the guided tour, as something to draw. */
export interface TourCueView {
  /** CSS selector for the thing being pointed at; empty for a step with none. */
  target: string;
  /** The one sentence saying what to do. */
  says: string;
  step: number;
  of: number;
  onSkip: () => void;
}

export interface RestoreView {
  message: string | null;
  busy: boolean;
  /** The recovery code alone; it is unique to one account. */
  onRestore: (code: string) => void;
  onBack: () => void;
}

/** One person on the friends list. */
export interface FriendRow {
  id: string;
  name: string;
  trophies: number;
  tier: string;
  online: boolean;
  /** Already worded — "Seen today", or empty for somebody online. */
  seen: string;
}

export interface FriendsView {
  rows: FriendRow[];
  /** The caller's own code, so it can be read out to whoever is adding them. */
  myCode: string;
  message: string | null;
  busy: boolean;
  onAdd: (code: string) => void;
  onRemove: (id: string) => void;
  onBack: () => void;
}

export interface ClubMemberRow {
  id: string;
  name: string;
  trophies: number;
  tier: string;
  online: boolean;
  seen: string;
  owner: boolean;
  isMe: boolean;
}

/**
 * The club screen, in whichever of its two states applies.
 *
 * `club` null is the state before joining one: a name field to start a club
 * and a code field to join one, side by side, because the player arriving here
 * has been told to do exactly one of those two things.
 */
export interface ClubView {
  club: {
    name: string;
    /** The board, ordered by trophies. */
    members: ClubMemberRow[];
    trophies: number;
    online: number;
    full: boolean;
    /** Shown only to the owner; null means "you are not the one who decides". */
    invite: string | null;
    isOwner: boolean;
  } | null;
  message: string | null;
  busy: boolean;
  onCreate: (name: string) => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
  onRename: (name: string) => void;
  onNewInvite: () => void;
  onRemove: (id: string) => void;
  onBack: () => void;
}

/** The focused, mid-rally coaching card used by the guided practice flow. */
export interface TrainingPauseState {
  /** Short progress label, for example "2 / 5". */
  progress: string;
  /** Short drill/skill name, for example "MOVE". */
  title: string;
  /** The one concrete thing the player should do next. */
  action: string;
  /** One device-specific input hint, such as "SPACE". */
  control: string;
  /** Optional continuation cue; defaults to "CONTINUE". */
  resume?: string;
  skip?: string;
  onSkip?: () => void;
}

/** DOM-based menus and HUD (crisper than canvas UI and trivially responsive). */
/**
 * Paper for a winner.
 *
 * DOM and CSS rather than a particle system, because the project has no
 * particle system and this does not justify introducing one — the title
 * screen's drifting motes are built exactly this way, and a competition
 * finishes about once every twenty minutes.
 *
 * Deterministic-ish by construction: the pieces are spread evenly across the
 * width and only their fall time and tilt vary, so it reads as a shower rather
 * than as a random clump. Everything else lives in `@keyframes confetti-fall`.
 */
function confettiLayer(): HTMLDivElement {
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  const colours = ["var(--teq)", "var(--gold)", "var(--arena-light)", "#ffffff", "var(--mint)"];
  const pieces = 34;
  for (let i = 0; i < pieces; i++) {
    const piece = document.createElement("i");
    // Even across the width, nudged so the columns do not read as a comb.
    const x = ((i + 0.5) / pieces) * 100 + (i % 3) - 1;
    piece.style.setProperty("--x", `${x.toFixed(2)}%`);
    piece.style.setProperty("--delay", `${((i % 7) * 0.13).toFixed(2)}s`);
    piece.style.setProperty("--dur", `${(2.4 + (i % 5) * 0.35).toFixed(2)}s`);
    piece.style.setProperty("--rot", `${(i % 2 ? 1 : -1) * (180 + (i % 4) * 140)}deg`);
    piece.style.setProperty("--tint", colours[i % colours.length]);
    layer.appendChild(piece);
  }
  return layer;
}

export class UI {
  private root: HTMLElement;
  /** The guided tour's overlay, built on first use and removed when it ends. */
  private tourEl: HTMLDivElement | null = null;
  private tourFrame: number | null = null;
  private loadingEl: HTMLDivElement;
  private loadingText: HTMLDivElement;
  private loadingTip: HTMLDivElement;
  private introClipEl: HTMLDivElement;
  private introClipVideo: HTMLVideoElement;
  /** Resolves the pending `playIntroClip()`; null when no clip is running. */
  private introClipDone: (() => void) | null = null;
  private introProgressEl: HTMLDivElement;
  private introProgressFill: HTMLSpanElement;
  private introProgressLabel: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private selectEl: HTMLDivElement;
  private hudEl: HTMLDivElement;
  private scoreEl: HTMLDivElement;
  private bannerEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private introEl: HTMLDivElement;
  private endEl: HTMLDivElement;
  private endTitle: HTMLDivElement;
  private pauseEl: HTMLDivElement;
  private dialogEl: HTMLDivElement;
  private menuEl: HTMLDivElement;
  private settingsEl: HTMLDivElement;
  private standingsEl: HTMLDivElement;
  private championsEl: HTMLDivElement;
  private challengesEl: HTMLDivElement;
  private resultEl: HTMLDivElement;
  private profileEl: HTMLDivElement;
  private boardEl: HTMLDivElement;
  private recoveryEl: HTMLDivElement;
  private restoreEl: HTMLDivElement;
  private friendsEl: HTMLDivElement;
  private seasonEl: HTMLDivElement;
  private clubEl: HTMLDivElement;
  /** The coins/trophies strip drawn over the title screen. */
  private walletEl: HTMLDivElement;
  private backdropEl: HTMLDivElement;
  private bannerTimer: number | null = null;
  private meterEl: HTMLDivElement;
  private staminaEl: HTMLDivElement;
  private meterFlashEl: HTMLDivElement;
  private meterFlashTimer: number | null = null;
  private practiceEl: HTMLDivElement;
  private trainingPauseEl: HTMLDivElement;
  private uiTutorialEl: HTMLDivElement;
  private cameraBtn: HTMLButtonElement;
  /** Score-line names, set per match ("YOU"/"OPPONENT", "P1"/"P2", country labels…). */
  private labels: [string, string] = ["YOU", "OPPONENT"];
  /** Set by the app; called when the HUD pause button is tapped. */
  onPauseRequest: (() => void) | null = null;
  /** Set by the app; called when the HUD camera button is tapped. */
  onCameraRequest: (() => void) | null = null;
  /** Set by the app; called when the coin counter in the top bar or header is clicked. */
  onCoinsClicked: (() => void) | null = null;

  private lastOrigin: { x: number; y: number } = { x: 50, y: 68 };
  private menuWaveTimer: ReturnType<typeof setTimeout> | null = null;
  private championsScrollTimer: ReturnType<typeof setTimeout> | null = null;

  public setOrigin(origin: { x: number; y: number }): void {
    this.lastOrigin = origin;
  }

  public setOriginFromElement(el: HTMLElement | null): void {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = window.innerWidth || document.documentElement.clientWidth || 1;
    const h = window.innerHeight || document.documentElement.clientHeight || 1;
    this.lastOrigin = {
      x: ((r.left + r.width / 2) / w) * 100,
      y: ((r.top + r.height / 2) / h) * 100,
    };
  }

  public revealScreen(el: HTMLElement, origin?: { x: number; y: number }): void {
    const o = origin ?? this.lastOrigin;
    el.style.setProperty("--ox", `${o.x.toFixed(2)}%`);
    el.style.setProperty("--oy", `${o.y.toFixed(2)}%`);
    el.classList.remove("hidden", "screen-collapse");
    el.classList.add("screen-reveal");
  }

  public collapseScreen(el: HTMLElement, backBtn: HTMLElement | null, onDone: () => void): void {
    if (backBtn) {
      this.setOriginFromElement(backBtn);
    }
    const o = this.lastOrigin;
    el.style.setProperty("--ox", `${o.x.toFixed(2)}%`);
    el.style.setProperty("--oy", `${o.y.toFixed(2)}%`);
    el.classList.remove("screen-reveal");
    el.classList.add("screen-collapse");
    setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("screen-collapse");
      onDone();
    }, 360);
  }

  constructor(root: HTMLElement) {
    this.root = root;

    window.addEventListener(
      "pointerdown",
      (e) => {
        const w = window.innerWidth || document.documentElement.clientWidth || 1;
        const h = window.innerHeight || document.documentElement.clientHeight || 1;
        this.lastOrigin = {
          x: (e.clientX / w) * 100,
          y: (e.clientY / h) * 100,
        };
      },
      { capture: true, passive: true }
    );

    this.loadingEl = this.screen("loading-screen");
    this.loadingEl.innerHTML = `
      <div class="logo">TeqRallly</div>
      <div class="teq-loader" aria-hidden="true">
        <span class="teq-loader-ball"></span>
        <span class="teq-loader-line"></span>
      </div>`;
    this.loadingText = document.createElement("div");
    this.loadingText.className = "loading-text";
    this.loadingText.textContent = "Loading…";
    this.loadingTip = document.createElement("div");
    this.loadingTip.className = "loading-tip";
    this.loadingEl.append(this.loadingText, this.loadingTip);

    // Sits over the loading screen rather than replacing it, so a device that
    // cannot decode the clip is left looking at the loading screen instead of
    // at black.
    this.introClipEl = this.screen("intro-clip");
    this.introClipEl.classList.add("hidden");
    this.introClipEl.innerHTML = `
      <video id="intro-clip-video" playsinline preload="auto" disablepictureinpicture></video>
      <button class="intro-clip-skip" id="intro-clip-skip" type="button">Skip</button>
      <div class="intro-progress" id="intro-progress">
        <div class="intro-progress-label" id="intro-progress-label">Loading players…</div>
        <div class="intro-progress-track"><span id="intro-progress-fill"></span></div>
      </div>`;
    this.introClipVideo = this.introClipEl.querySelector<HTMLVideoElement>("#intro-clip-video")!;
    this.introProgressEl = this.introClipEl.querySelector<HTMLDivElement>("#intro-progress")!;
    this.introProgressFill = this.introClipEl.querySelector<HTMLSpanElement>("#intro-progress-fill")!;
    this.introProgressLabel = this.introClipEl.querySelector<HTMLDivElement>("#intro-progress-label")!;
    const skipBtn = this.introClipEl.querySelector<HTMLButtonElement>("#intro-clip-skip");
    skipBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.introClipDone?.();
    });
    this.introClipEl.addEventListener("click", () => {
      this.introClipDone?.();
    });

    this.titleEl = this.screen("title-screen");
    this.titleEl.innerHTML = `
      <!-- Arena Environment -->
      <div class="arena-environment" aria-hidden="true">
        <div class="arena-light" style="--dur: 12s; --delay: 0s; top: -10%; left: 50%; transform: translateX(-50%); width: 140%; height: 80%; background: radial-gradient(ellipse at 50% 20%, rgba(25,90,220,0.24) 0%, transparent 62%)"></div>
        <div class="arena-light" style="--dur: 9s; --delay: 1.2s; top: -20%; left: -30%; width: 75%; height: 80%; background: radial-gradient(ellipse at 40% 5%, rgba(40,100,230,0.14) 0%, transparent 55%)"></div>
        <div class="arena-light" style="--dur: 11s; --delay: 0.5s; top: -20%; right: -30%; width: 75%; height: 80%; background: radial-gradient(ellipse at 60% 5%, rgba(40,100,230,0.14) 0%, transparent 55%)"></div>
        <svg class="horizon-arc" style="top: 58%; left: 0; width: 100%; height: 44px; overflow: visible" viewBox="0 0 1000 22" preserveAspectRatio="none">
          <path class="horizon-arc-line" d="M -40 22 Q 500 -4 1040 22" fill="none" stroke="rgba(60,130,255,0.18)" stroke-width="0.7" />
          <path class="horizon-arc-bloom" d="M -40 22 Q 500 -4 1040 22" fill="none" stroke="rgba(80,150,255,0.06)" stroke-width="8" />
        </svg>
        <div class="teq-table" style="bottom: 0; left: 50%; transform: translateX(-50%); width: 130%; height: 28%">
          <div style="position: absolute; inset: 0; clip-path: polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%); background: linear-gradient(180deg, #122040 0%, #0c1830 100%)"></div>
          <div style="position: absolute; top: 0; left: 20%; right: 20%; height: 2px; background: linear-gradient(90deg, transparent, rgba(80,140,255,0.4) 30%, rgba(140,190,255,0.5) 50%, rgba(80,140,255,0.4) 70%, transparent)"></div>
          <div class="center-line" style="position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); width: 2px; background: linear-gradient(180deg, #e07520 0%, rgba(224,117,32,0.25) 100%)"></div>
        </div>
        <div class="vignette" style="inset: 0; background: radial-gradient(ellipse at 50% 42%, transparent 38%, rgba(6,18,36,0.72) 100%)"></div>
        <div class="vignette-left" style="top: 0; left: 0; bottom: 0; width: 10%; background: linear-gradient(90deg, rgba(6,18,36,0.58) 0%, transparent 100%)"></div>
        <div class="vignette-right" style="top: 0; right: 0; bottom: 0; width: 10%; background: linear-gradient(270deg, rgba(6,18,36,0.58) 0%, transparent 100%)"></div>
        <!-- Particles -->
        <div class="particle" style="left: 7%; --size: 2px; --dur: 11.2s; --delay: 0s"></div>
        <div class="particle" style="left: 14%; --size: 3px; --dur: 14.5s; --delay: 2.4s"></div>
        <div class="particle" style="left: 22%; --size: 2px; --dur: 9.8s; --delay: 1.1s"></div>
        <div class="particle" style="left: 31%; --size: 2px; --dur: 13.1s; --delay: 4.6s"></div>
        <div class="particle" style="left: 40%; --size: 3px; --dur: 10.6s; --delay: 0.7s"></div>
        <div class="particle" style="left: 49%; --size: 2px; --dur: 12.3s; --delay: 3.3s"></div>
        <div class="particle" style="left: 58%; --size: 2px; --dur: 9.2s; --delay: 5.2s"></div>
        <div class="particle" style="left: 66%; --size: 3px; --dur: 11.7s; --delay: 1.8s"></div>
        <div class="particle" style="left: 75%; --size: 2px; --dur: 13.8s; --delay: 3.0s"></div>
        <div class="particle" style="left: 83%; --size: 2px; --dur: 10.2s; --delay: 0.5s"></div>
      </div>
      <!-- UI Layer -->
      <main class="title-content">
        <!-- Stats Bar -->
        <div class="stats-bar" style="width: 100%; margin-top: 68px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px">
          <div class="stat-pill" id="stat-coins"><svg class="coin-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" fill="#f5c518" stroke="#c8a000" stroke-width="0.5"/><text x="7" y="10.5" text-anchor="middle" font-size="7" font-weight="bold" fill="#7a5000">$</text></svg><span id="stat-coins-value">0</span></div>
          <div class="stat-pill" id="stat-trophies"><svg class="trophy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5c518" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg><span id="stat-trophies-value">0</span></div>
          <div class="stat-pill rank" id="stat-rank"><span id="stat-rank-value">ROOKIE I</span></div>
        </div>

        <!-- Upper spacer -->
        <div style="flex: 1"></div>

        <!-- Brand Identity -->
        <div class="logo-lockup logo-entrance" style="display: flex; flex-direction: column; align-items: center; gap: 8px">
          <img class="logo-icon" src="/figma/icon.png" alt="TeqRallly" style="width: clamp(78px, 11vh, 98px); height: clamp(78px, 11vh, 98px); border-radius: 22%; object-fit: cover; box-shadow: 0 14px 44px rgba(0,0,0,0.65), 0 0 0 2px rgba(255,255,255,0.14), 0 0 0 5px rgba(255,255,255,0.05)">
          <p class="logo-tagline logo-tagline-entrance" style="font-family: 'Exo 2', sans-serif; font-weight: 300; font-size: clamp(0.55rem, 1.8vw, 0.62rem); letter-spacing: 0.16em; color: rgba(255,255,255,0.42); margin: 0; font-style: italic; text-align: center">Fast rallies on the curved table.</p>
        </div>

        <!-- Gap -->
        <div class="title-gap-lg" style="height: 22px"></div>

        <!-- Primary CTA -->
        <button class="big-btn" id="btn-play" data-menu-primary="true">
          <span aria-hidden="true" class="btn-shine-top"></span>
          <span aria-hidden="true" class="btn-shine-radial"></span>
          <span class="btn-text">PLAY</span>
        </button>

        <!-- Gap -->
        <div class="title-gap-sm" style="height: 14px"></div>

        <!-- Secondary Nav -->
        <div class="nav-pills" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; width: 100%">
          <button class="nav-pill" id="btn-title-champions" type="button"></button>
          <button class="nav-pill" id="btn-title-challenges" type="button"></button>
          <button class="nav-pill" id="btn-title-supplies" type="button"></button>
          <button class="nav-pill" id="btn-title-profile" type="button"></button>
          <button class="nav-pill" id="btn-title-settings" type="button">SETTINGS</button>
        </div>

        <!-- Lower spacer -->
        <div style="flex: 1"></div>
      </main>`;

    // Select screen is a transparent overlay: the 3D model viewer renders behind it.
    this.selectEl = this.screen("select-screen");
    this.selectEl.classList.add("viewer-select");
    this.selectEl.innerHTML = `
      <div class="select-shell">
        <div class="select-top">
          <div class="select-bar">
            <button class="select-back" id="btn-select-back" type="button" data-menu-back>← ${t("nav.back")}</button>
            <div class="select-brand">
              <span class="select-mode-label" id="select-mode-label"></span>
              <img src="/figma/icon.png" alt="" class="menu-brand-icon" />
            </div>
          </div>
          <h1 class="select-title">CHOOSE YOUR SETUP</h1>
          <div class="tabs">
            <button class="tab-btn active" data-tab="character"></button>
            <button class="tab-btn" data-tab="ball"></button>
            <button class="tab-btn" data-tab="venue"></button>
          </div>
        </div>
        <div class="select-stage">
          <img class="venue-card hidden" id="venue-card" alt="" />
        </div>
        <aside class="player-profile hidden" id="player-profile" aria-live="polite">
          <div class="profile-synergies" id="profile-synergies"></div>
          <div class="profile-stats"></div>
          <div class="profile-traits"></div>
        </aside>
        <div class="select-bottom">
          <div class="browse">
            <button class="arrow-btn" id="btn-prev" type="button">‹</button>
            <div class="item-label">
              <div id="item-name">…</div>
              <div id="item-status" class="hidden">Loading…</div>
              <div id="item-lock" class="hidden"></div>
              <button class="unlock-btn hidden" id="btn-unlock-item" type="button"></button>
            </div>
            <button class="arrow-btn" id="btn-next" type="button">›</button>
          </div>
          <div class="venue-strip hidden" id="venue-strip" aria-label="Venue"></div>
          <button class="big-btn" id="btn-start" type="button">PLAY</button>
        </div>
      </div>`;

    this.settingsEl = this.screen("settings-screen");

    this.hudEl = this.screen("hud");
    this.hudEl.classList.add("transparent");
    this.scoreEl = document.createElement("div");
    this.scoreEl.id = "score";
    this.bannerEl = document.createElement("div");
    this.bannerEl.id = "banner";
    this.bannerEl.classList.add("hidden");
    this.hintEl = document.createElement("div");
    this.hintEl.id = "hint";
    this.hintEl.classList.add("hidden");
    // Broadcast-style card over the establishing shot: which venue, who is
    // playing. It sits in the HUD rather than being its own screen so the
    // camera move is never covered by a full-screen panel.
    this.introEl = document.createElement("div");
    this.introEl.id = "intro-card";
    this.introEl.classList.add("hidden");
    const cameraBtn = document.createElement("button");
    cameraBtn.id = "camera-btn";
    cameraBtn.type = "button";
    cameraBtn.onclick = () => this.onCameraRequest?.();
    this.cameraBtn = cameraBtn;
    this.setCameraMode("court");
    const pauseBtn = document.createElement("button");
    pauseBtn.id = "pause-btn";
    pauseBtn.textContent = "❚❚";
    pauseBtn.setAttribute("aria-label", "Pause game — Escape or controller Start / Options");
    pauseBtn.title = "Pause — Escape or controller Start / Options";
    pauseBtn.onclick = () => this.onPauseRequest?.();
    // Two bars under the score, one per player, in the same order the score
    // reads. Legs are a resource here, and one that can be bought back — a
    // player has to be able to watch it go.
    this.staminaEl = document.createElement("div");
    this.staminaEl.id = "stamina";
    this.staminaEl.innerHTML = `
      <div class="stamina-row" id="stamina-row-you"><span>YOU</span><i><b id="stamina-you"></b><u id="stamina-you-spent"></u></i></div>
      <div class="stamina-row" id="stamina-row-cpu"><span>OPPONENT</span><i><b id="stamina-cpu"></b><u id="stamina-cpu-spent"></u></i></div>`;

    this.meterEl = document.createElement("div");
    this.meterEl.id = "meter";
    this.meterEl.classList.add("hidden");
    this.meterEl.innerHTML = `
      <div id="meter-sweet"></div>
      <div id="meter-fill"></div>`;
    this.meterFlashEl = document.createElement("div");
    this.meterFlashEl.id = "meter-flash";
    this.meterFlashEl.classList.add("hidden");
    this.practiceEl = document.createElement("div");
    this.practiceEl.id = "practice-panel";
    this.practiceEl.classList.add("hidden");
    this.hudEl.append(
      this.scoreEl,
      this.staminaEl,
      this.bannerEl,
      this.hintEl,
      this.introEl,
      this.meterEl,
      this.meterFlashEl,
      this.practiceEl,
      cameraBtn,
      pauseBtn
    );

    this.pauseEl = this.screen("pause-screen");
    this.pauseEl.innerHTML = `
      <section class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <h1 id="pause-title"></h1>
        <div class="pause-actions">
          <button class="pause-action pause-resume" id="btn-resume" data-menu-primary="true">
            <strong id="pause-resume-label"></strong><kbd>ESC / START</kbd>
          </button>
          <button class="pause-action" id="btn-restart"><strong>RESTART MATCH</strong></button>
          <button class="pause-action" id="btn-change-player"><strong>EXIT TO MODES</strong></button>
        </div>
      </section>`;

    this.dialogEl = this.screen("dialog-screen");
    this.dialogEl.classList.add("hidden");

    const titleCoins = this.titleEl.querySelector<HTMLDivElement>("#stat-coins");
    if (titleCoins) {
      titleCoins.style.cursor = "pointer";
      titleCoins.onclick = (e) => {
        e.stopPropagation();
        this.onCoinsClicked?.();
      };
    }

    // This is intentionally separate from the ordinary pause menu: guided
    // drills freeze at a teachable moment, then return straight to the rally.
    this.trainingPauseEl = this.screen("training-pause");
    this.trainingPauseEl.innerHTML = `
      <div class="training-card" role="dialog" aria-modal="true" aria-live="polite">
        <div class="training-progress"></div>
        <div class="training-title"></div>
        <div class="training-action-text"></div>
        <div class="training-control">
          <span class="training-control-text"></span>
        </div>
        <div class="training-actions">
          <button class="training-resume" id="btn-training-resume" type="button"></button>
          <button class="training-skip" id="btn-training-skip" type="button">SKIP PRACTICE</button>
        </div>
      </div>`;

    this.endEl = this.screen("end-screen");
    this.endTitle = document.createElement("div");
    this.endTitle.className = "logo small";
    const btns = document.createElement("div");
    btns.className = "end-btns";
    btns.innerHTML = `
      <button class="big-btn" id="btn-rematch"></button>
      <button class="big-btn alt" id="btn-change"></button>`;
    this.endEl.append(this.endTitle, btns);

    // Generic list menu (game mode, difficulty, competition format).
    this.menuEl = this.screen("menu-screen");

    // Competition standings (cup bracket / league table) between matches.
    this.standingsEl = this.screen("standings-screen");

    // The career: the roster, today's challenges, and what a match did to both.
    this.championsEl = this.screen("champions-screen");
    this.challengesEl = this.screen("challenges-screen");
    this.resultEl = this.screen("result-screen");
    this.profileEl = this.screen("profile-screen");
    this.boardEl = this.screen("board-screen");
    this.recoveryEl = this.screen("recovery-screen");
    this.restoreEl = this.screen("restore-screen");
    this.friendsEl = this.screen("friends-screen");
    this.seasonEl = this.screen("season-screen");
    this.clubEl = this.screen("club-screen");

    this.uiTutorialEl = this.screen("ui-tutorial-screen");
    this.uiTutorialEl.innerHTML = `
      <div class="tutorial-card" role="dialog" aria-modal="true">
        <div class="tutorial-top-bar">
          <div class="tutorial-progress-dots"></div>
          <button class="tutorial-skip-btn" id="btn-tutorial-skip" type="button"></button>
        </div>
        <div class="tutorial-body">
          <div class="tutorial-badge" id="tutorial-badge">✦</div>
          <h2 class="tutorial-title" id="tutorial-title"></h2>
          <p class="tutorial-text" id="tutorial-text"></p>
        </div>
        <div class="tutorial-footer">
          <button class="big-btn tutorial-next-btn" id="btn-tutorial-next" type="button" data-menu-primary="true">
            <span class="btn-text"></span>
          </button>
        </div>
      </div>`;

    // What the menus stand on.
    //
    // The screen transition irises open and shut with `clip-path`, and outside
    // that circle nothing in the DOM paints at all — so for the length of the
    // animation the only thing on those pixels is the game canvas, which is
    // drawing the live arena every frame whether a match is on or not. The
    // effect is worth keeping; opening it onto the court is not.
    //
    // Painted with the same arena gradient the screens use, so the iris opens
    // onto more of the menu rather than onto anything.
    this.backdropEl = document.createElement("div");
    this.backdropEl.id = "menu-backdrop";
    this.root.appendChild(this.backdropEl);

    // The wallet rides above the title screen rather than inside it: it is the
    // one thing that has to look the same on every screen that shows it.
    this.walletEl = document.createElement("div");
    this.walletEl.id = "wallet";
    this.walletEl.className = "wallet hidden";
    this.root.appendChild(this.walletEl);

    this.hideAll();
  }

  private screen(id: string): HTMLDivElement {
    const el = document.createElement("div");
    el.id = id;
    el.className = "screen";
    this.root.appendChild(el);
    return el;
  }

  private hideAll(): void {
    this.stopAttractMode();
    this.hideIntroClip();
    if (this.menuWaveTimer) {
      clearTimeout(this.menuWaveTimer);
      this.menuWaveTimer = null;
    }
    if (this.championsScrollTimer) {
      clearTimeout(this.championsScrollTimer);
      this.championsScrollTimer = null;
    }
    for (const el of [
      this.loadingEl,
      this.titleEl,
      this.selectEl,
      this.hudEl,
      this.endEl,
      this.pauseEl,
      this.trainingPauseEl,
      this.uiTutorialEl,
      this.menuEl,
      this.standingsEl,
      this.settingsEl,
      this.championsEl,
      this.challengesEl,
      this.resultEl,
      this.profileEl,
      this.boardEl,
      this.recoveryEl,
      this.restoreEl,
      this.friendsEl,
      this.seasonEl,
      this.clubEl,
    ]) {
      el.classList.add("hidden");
    }
    this.walletEl.classList.add("hidden");
    this.backdropEl.classList.remove("hidden");
  }

  /**
   * Let the 3D scene through for the screens that are meant to sit over it.
   *
   * Called by the few screens that want the court or the model viewer behind
   * them. Everything else gets the backdrop by default, because `hideAll` puts
   * it back before every screen change — a new menu has to opt out of covering
   * the arena rather than remember to opt in.
   *
   * The overlays that never call `hideAll` — pause, the end card, the training
   * card — inherit whatever the screen underneath chose, which is what they
   * want: they are drawn over a live match and blur it rather than hide it.
   */
  private showSceneBehind(): void {
    this.backdropEl.classList.add("hidden");
  }

  /** Full-screen menu; each option's `id` becomes the button's DOM id. */
  showMenu(
    title: string,
    options: MenuOption[],
    onPick: (id: string) => void,
    subtitle?: string,
    onBack?: () => void
  ): void {
    this.hideAll();
    this.revealScreen(this.menuEl);
    const isModeMenu = title === "GAME MODE";
    this.menuEl.classList.toggle("menu-mode-grid", isModeMenu);
    this.menuEl.innerHTML = `
      <main class="menu-shell">
        <header class="menu-header">
          <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
          ${onBack ? `<button class="menu-back" id="btn-menu-back" type="button" data-menu-back>← ${t("nav.back")}</button>` : ""}
        </header>
        <section class="menu-heading">
          <h1>${title}</h1>
          ${subtitle ? `<p>${subtitle}</p>` : ""}
        </section>
        <div class="menu-options" role="list"></div>
      </main>`;
    const box = this.menuEl.querySelector<HTMLDivElement>(".menu-options")!;
    options.forEach((opt, index) => {
      const primary = opt.primary || (!options.some((item) => item.primary) && index === 0);
      const b = document.createElement("button");
      b.className = `menu-option mode-card${primary ? " is-primary" : ""}`;
      b.id = opt.id;
      b.setAttribute("role", "listitem");
      if (primary) b.dataset.menuPrimary = "true";
      const content = document.createElement("div");
      content.className = "mode-card-content";
      const label = document.createElement("strong");
      label.textContent = opt.label;
      content.appendChild(label);
      if (opt.sub) {
        const sub = document.createElement("small");
        sub.textContent = opt.sub;
        content.appendChild(sub);
      }
      b.appendChild(content);
      b.onclick = () => {
        this.setOriginFromElement(b);
        onPick(opt.id);
      };
      box.appendChild(b);
    });

    // Cascading downward wave glow: one card at a time
    const cards = box.querySelectorAll<HTMLElement>(".mode-card");
    if (cards.length > 0) {
      let step = 0;
      const triggerWave = () => {
        if (!this.menuEl || this.menuEl.classList.contains("hidden")) return;
        const currentCard = cards[step];
        if (currentCard) {
          const oldSweep = currentCard.querySelector(".card-sweep");
          if (oldSweep) oldSweep.remove();
          const sweep = document.createElement("span");
          sweep.className = "card-sweep";
          currentCard.appendChild(sweep);
        }
        step++;
        if (step < cards.length) {
          this.menuWaveTimer = setTimeout(triggerWave, 280);
        } else {
          step = 0;
          this.menuWaveTimer = setTimeout(triggerWave, 3000);
        }
      };
      this.menuWaveTimer = setTimeout(triggerWave, 300);
    }

    const back = this.menuEl.querySelector<HTMLButtonElement>("#btn-menu-back");
    if (back) {
      back.onclick = () => {
        this.collapseScreen(this.menuEl, back, () => onBack?.());
      };
    }
  }

  /** Competition interstitial: a titled block of result/table rows and one continue button. */
  /**
   * The screen between a competition's rounds, and at the end of one.
   *
   * `won` is the player's own result, not row one's: the table is the same
   * shape whoever is on top of it, and until this existed the screen could not
   * tell a champion from a fourth place. It is what the confetti hangs off.
   */
  showStandings(
    title: string,
    rows: string[],
    buttonLabel: string,
    onContinue: () => void,
    won = false,
    onBack?: () => void
  ): void {
    this.hideAll();
    this.revealScreen(this.standingsEl);
    this.standingsEl.innerHTML = `
      <main class="menu-shell standings-shell">
        <header class="menu-header">
          <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
          ${onBack ? `<button class="menu-back" id="btn-standings-back" type="button" data-menu-back>← ${t("nav.back")}</button>` : ""}
        </header>
        <section class="menu-heading">
          <h1>${title}</h1>
        </section>
        <div class="standings-rows">${rows.map((r) => `<div class="standings-row">${r}</div>`).join("")}</div>
        <button class="big-btn" id="btn-standings-continue">${buttonLabel}</button>
      </main>`;
    this.standingsEl.querySelector<HTMLButtonElement>("#btn-standings-continue")!.onclick = () => onContinue();
    const back = this.standingsEl.querySelector<HTMLButtonElement>("#btn-standings-back");
    if (back && onBack) {
      back.onclick = () => {
        this.collapseScreen(this.standingsEl, back, () => onBack());
      };
    }
    this.standingsEl.classList.toggle("celebrating", won);
    if (won) this.standingsEl.prepend(confettiLayer());
  }

  /**
   * Online waiting room: a status line, an optional room code to read out, and
   * a way back. Used for every waiting state — searching for an opponent,
   * holding a private room open, and connecting — because they differ only in
   * what they say.
   */
  showLobbyStatus(title: string, detail: string, code: string | null, onCancel: () => void): void {
    this.hideAll();
    this.standingsEl.innerHTML = `
      <div class="logo small">${title}</div>
      ${code ? `<div class="lobby-code" aria-label="Room code">${code}</div>` : ""}
      <div class="standings-rows"><div class="standings-row" id="lobby-detail"></div></div>
      <button class="big-btn" id="btn-lobby-cancel" data-menu-back>CANCEL</button>`;
    // textContent, not innerHTML: this carries countdowns and server messages.
    this.standingsEl.querySelector<HTMLDivElement>("#lobby-detail")!.textContent = detail;
    this.standingsEl.querySelector<HTMLButtonElement>("#btn-lobby-cancel")!.onclick = () => onCancel();
    this.standingsEl.classList.remove("hidden");
  }

  /**
   * Online pause overlay & modal dialogs. Serves the whole negotiation — asking, being asked,
   * paused, notice, and prompts — rendered into this.dialogEl so the match pause screen is never disturbed.
   */
  showOnlinePause(title: string, detail: string, actions: [string, () => void][]): void {
    this.dialogEl.innerHTML = `
      <div class="pause-card">
        <div class="logo small">${title}</div>
        <div class="standings-rows"><div class="standings-row" id="net-pause-detail"></div></div>
        <div class="pause-actions"></div>
      </div>`;
    this.dialogEl.querySelector<HTMLDivElement>("#net-pause-detail")!.textContent = detail;
    const box = this.dialogEl.querySelector<HTMLDivElement>(".pause-actions")!;
    actions.forEach(([label, fn], i) => {
      const b = document.createElement("button");
      b.className = `big-btn${i > 0 ? " alt" : ""}`;
      b.textContent = label;
      b.onclick = () => fn();
      box.appendChild(b);
    });
    this.dialogEl.classList.remove("hidden");
  }

  hideOnlinePause(): void {
    this.dialogEl.classList.add("hidden");
  }

  /**
   * Prompt the player to enter a name to create their profile before purchasing.
   */
  promptProfile(opts: {
    title?: string;
    detail?: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: (name: string) => Promise<boolean> | boolean;
    onRestore?: () => void;
    onCancel: () => void;
  }): void {
    const title = opts.title ?? "CREATE PLAYER PROFILE";
    const detail =
      opts.detail ??
      "Create your Player Profile to protect and sync your purchases across devices.";
    const confirmLabel = opts.confirmLabel ?? "CONTINUE TO STORE";
    const cancelLabel = opts.cancelLabel ?? "CANCEL";

    this.dialogEl.innerHTML = `
      <div class="pause-card profile-prompt-card">
        <div class="logo small">${title}</div>
        <div class="standings-rows"><div class="standings-row" id="profile-prompt-detail"></div></div>
        <div class="profile-input-wrap">
          <input type="text" id="profile-prompt-input" class="profile-input" maxlength="16" placeholder="${opts.placeholder ?? "Player Name"}" />
          <div id="profile-prompt-error" class="profile-prompt-error hidden"></div>
        </div>
        <div class="pause-actions">
          <button class="big-btn" id="btn-profile-prompt-confirm" type="button">${confirmLabel}</button>
          ${opts.onRestore ? `<button class="big-btn alt" id="btn-profile-prompt-restore" type="button">${t("recovery.restore")}</button>` : ""}
          <button class="big-btn alt" id="btn-profile-prompt-cancel" type="button">${cancelLabel}</button>
        </div>
      </div>`;

    this.dialogEl.querySelector<HTMLDivElement>("#profile-prompt-detail")!.textContent = detail;
    const inputEl = this.dialogEl.querySelector<HTMLInputElement>("#profile-prompt-input")!;
    const errEl = this.dialogEl.querySelector<HTMLDivElement>("#profile-prompt-error")!;
    const confirmBtn = this.dialogEl.querySelector<HTMLButtonElement>("#btn-profile-prompt-confirm")!;
    const cancelBtn = this.dialogEl.querySelector<HTMLButtonElement>("#btn-profile-prompt-cancel")!;
    const restoreBtn = this.dialogEl.querySelector<HTMLButtonElement>("#btn-profile-prompt-restore");

    if (restoreBtn && opts.onRestore) {
      restoreBtn.onclick = () => {
        this.hideOnlinePause();
        opts.onRestore?.();
      };
    }

    cancelBtn.onclick = () => {
      this.hideOnlinePause();
      opts.onCancel();
    };

    const submit = async () => {
      const name = inputEl.value.trim();
      if (!name) {
        errEl.textContent = "Please enter a name.";
        errEl.classList.remove("hidden");
        return;
      }
      confirmBtn.disabled = true;
      try {
        const ok = await opts.onConfirm(name);
        if (ok) {
          this.hideOnlinePause();
        } else {
          confirmBtn.disabled = false;
        }
      } catch (e) {
        confirmBtn.disabled = false;
        errEl.textContent = e instanceof Error ? e.message : String(e);
        errEl.classList.remove("hidden");
      }
    };

    confirmBtn.onclick = () => void submit();
    inputEl.onkeydown = (e) => {
      if (e.key === "Enter") void submit();
    };
    this.dialogEl.classList.remove("hidden");
    inputEl.focus();
  }

  /** Update the waiting room's status line without rebuilding the screen. */
  setLobbyDetail(detail: string): void {
    const el = this.standingsEl.querySelector<HTMLDivElement>("#lobby-detail");
    if (el) el.textContent = detail;
  }

  /**
   * Room-code entry. The input is upper-cased and filtered as it is typed, so
   * a player reading a code off a friend's screen cannot enter something the
   * server will reject.
   */
  /**
   * One line of text, on its own screen.
   *
   * Generalised out of the room-code entry so a shirt name and a room code can
   * share a keyboard-friendly screen without the name inheriting a five-letter
   * limit and a JOIN button.
   */
  showTextEntry(opts: {
    title: string;
    placeholder: string;
    value?: string;
    maxLength: number;
    minLength?: number;
    /** Applied on every keystroke; what the field is allowed to contain. */
    clean: (raw: string) => string;
    submitLabel: string;
    onSubmit: (value: string) => void;
    onBack: () => void;
  }): void {
    this.hideAll();
    this.standingsEl.innerHTML = `
      <div class="logo small">${opts.title}</div>
      <div class="standings-rows">
        <input class="code-input" id="lobby-code-input" inputmode="latin"
               autocapitalize="characters" autocomplete="off" spellcheck="false"
               maxlength="${opts.maxLength}" placeholder="${opts.placeholder}" />
      </div>
      <button class="big-btn" id="btn-code-go">${opts.submitLabel}</button>
      <button class="big-btn alt" id="btn-code-back" data-menu-back>${t("nav.back")}</button>`;

    const input = this.standingsEl.querySelector<HTMLInputElement>("#lobby-code-input")!;
    const go = this.standingsEl.querySelector<HTMLButtonElement>("#btn-code-go")!;
    input.setAttribute("aria-label", opts.title);
    input.value = opts.clean(opts.value ?? "");
    const min = opts.minLength ?? 0;
    const sync = () => {
      go.disabled = input.value.length < min;
    };
    const submit = () => {
      if (go.disabled) return;
      opts.onSubmit(input.value.trim());
    };
    input.oninput = () => {
      input.value = opts.clean(input.value);
      sync();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
    sync();
    go.onclick = submit;
    this.standingsEl.querySelector<HTMLButtonElement>("#btn-code-back")!.onclick = () => opts.onBack();
    this.standingsEl.classList.remove("hidden");
    // Phones only raise the keyboard for a focus inside the tap that caused it.
    setTimeout(() => input.focus(), 50);
  }

  /**
   * Room-code entry. The input is upper-cased and filtered as it is typed, so
   * a player reading a code off a friend's screen cannot enter something the
   * server will reject.
   */
  showCodeEntry(
    title: string,
    placeholder: string,
    onSubmit: (code: string) => void,
    onBack: () => void
  ): void {
    this.showTextEntry({
      title,
      placeholder,
      maxLength: 5,
      minLength: 5,
      clean: (raw) => raw.toUpperCase().replace(/[^A-Z0-9]/g, ""),
      submitLabel: "JOIN",
      onSubmit,
      onBack,
    });
  }


  /** Names shown in the score line and end screen ("YOU"/"OPPONENT", "P1"/"P2", …). */
  setLabels(left: string, right: string): void {
    this.labels = [left, right];
    const you = this.staminaEl?.querySelector<HTMLElement>("#stamina-row-you span");
    if (you) you.textContent = left;
    const cpu = this.staminaEl?.querySelector<HTMLElement>("#stamina-row-cpu span");
    if (cpu) cpu.textContent = right;
  }

  /**
   * Draw both players' remaining legs.
   *
   * Widths only — no reflow, no text — because this is called every simulation
   * step and the HUD sits over a running match.
   */
  stamina(player: number, ai: number, playerMax = 1, aiMax = 1): void {
    const pct = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
    const paint = (id: string, level: number, ceiling: number) => {
      const bar = this.staminaEl.querySelector<HTMLElement>(`#stamina-${id}`);
      if (bar) {
        bar.style.width = pct(level);
        // Colour is the warning: a bar that only shrinks is easy to miss on a
        // phone while you are watching the ball.
        bar.dataset.low = String(level < 0.45);
      }
      // The part of the bar this match has taken for good. Drawn from the
      // right, so what is left to recover into is the gap between them —
      // otherwise a player waits for a bar that is never coming back.
      const spent = this.staminaEl.querySelector<HTMLElement>(`#stamina-${id}-spent`);
      if (spent) spent.style.width = pct(1 - ceiling);
    };
    paint("you", player, playerMax);
    paint("cpu", ai, aiMax);
  }

  /** Update the compact HUD label and its accessible camera shortcut hint. */
  setCameraMode(mode: CameraMode): void {
    const label = mode === "court" ? "COURT" : "SIDE";
    this.cameraBtn.textContent = `CAM · ${label}`;
    this.cameraBtn.dataset.short = label;
    this.cameraBtn.setAttribute("aria-label", `Camera view: ${label}. Switch with C or Y / Triangle.`);
    this.cameraBtn.title = `Camera: ${label} — press C or Y / Triangle to switch`;
  }

  /**
   * The settings window: every remembered choice on one screen, each with the
   * control that fits it, rather than a menu that walks into a submenu per
   * setting. A row can carry its own warning — the graphics tier does, because
   * changing it restarts the game.
   */
  showSettings(
    title: string,
    rows: SettingRow[],
    onChange: (id: string, value: string | boolean) => void,
    onBack: () => void
  ): void {
    this.hideAll();
    this.revealScreen(this.settingsEl);
    this.settingsEl.innerHTML = `
      <main class="menu-shell settings-shell">
        <header class="menu-header">
          <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
          <button class="menu-back" id="btn-settings-back" type="button" data-menu-back>← ${t("nav.back")}</button>
        </header>
        <section class="menu-heading"><h1></h1></section>
        <div class="settings-rows"></div>
      </main>`;
    this.settingsEl.querySelector<HTMLHeadingElement>("h1")!.textContent = title;
    const list = this.settingsEl.querySelector<HTMLDivElement>(".settings-rows")!;
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "setting-row";
      const text = document.createElement("div");
      text.className = "setting-text";
      const label = document.createElement("div");
      label.className = "setting-label";
      label.textContent = row.label;
      text.appendChild(label);
      if (row.hint) {
        const hint = document.createElement("div");
        hint.className = "setting-hint";
        hint.textContent = row.hint;
        text.appendChild(hint);
      }
      if (row.warning) {
        const warn = document.createElement("div");
        warn.className = "setting-warning";
        warn.textContent = row.warning;
        text.appendChild(warn);
      }
      el.appendChild(text);

      if (!row.control) {
        list.appendChild(el);
        continue;
      }
      const control = document.createElement("div");
      control.className = "setting-control";
      if (row.control.kind === "choice") {
        control.classList.add("seg");
        // Four options do not fit beside a label on a phone. Past three, the
        // row stacks and the control takes the full width rather than
        // squeezing the words it belongs to.
        if (row.control.options.length > 3) el.classList.add("stacked");
        for (const option of row.control.options) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "seg-btn";
          b.textContent = option.label;
          b.classList.toggle("on", option.id === row.control.value);
          b.onclick = () => onChange(row.id, option.id);
          control.appendChild(b);
        }
      } else if (row.control.kind === "action") {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ghost-btn setting-action";
        b.textContent = row.control.label;
        b.disabled = row.control.disabled === true;
        b.onclick = () => onChange(row.id, true);
        control.appendChild(b);
      } else {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "switch";
        b.setAttribute("role", "switch");
        b.setAttribute("aria-checked", String(row.control.value));
        b.classList.toggle("on", row.control.value);
        b.innerHTML = '<i></i><span></span>';
        const on = row.control.kind === "toggle" && row.control.value;
        b.onclick = () => onChange(row.id, !on);
        control.appendChild(b);
      }
      el.appendChild(control);
      list.appendChild(el);
    }
    const back = this.settingsEl.querySelector<HTMLButtonElement>("#btn-settings-back")!;
    back.onclick = () => {
      this.collapseScreen(this.settingsEl, back, () => onBack());
    };
  }

  /**
   * A yes/no question over whatever is on screen. Used where a choice cannot
   * simply be undone — restarting the game to change the graphics tier.
   */
  confirm(
    title: string,
    detail: string,
    confirmLabel: string,
    cancelLabel: string,
    onConfirm: () => void
  ): void {
    this.showOnlinePause(title, detail, [
      [confirmLabel, () => {
        this.hideOnlinePause();
        onConfirm();
      }],
      [cancelLabel, () => this.hideOnlinePause()],
    ]);
  }

  /**
   * Something the player needs told and nothing to decide — what a restore
   * found, or why the store cannot be reached. One button, and it closes.
   */
  notice(title: string, detail: string, dismissLabel: string, onDismiss?: () => void): void {
    this.showOnlinePause(title, detail, [
      [dismissLabel, () => {
        this.hideOnlinePause();
        onDismiss?.();
      }],
    ]);
  }

  private ensurePauseDom(): void {
    if (!this.pauseEl.querySelector("#pause-title") || !this.pauseEl.querySelector("#btn-resume")) {
      this.pauseEl.innerHTML = `
        <section class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <h1 id="pause-title"></h1>
          <div class="pause-actions">
            <button class="pause-action pause-resume" id="btn-resume" data-menu-primary="true">
              <strong id="pause-resume-label"></strong><kbd>ESC / START</kbd>
            </button>
            <button class="pause-action" id="btn-restart"><strong>RESTART MATCH</strong></button>
            <button class="pause-action" id="btn-change-player"><strong>EXIT TO MODES</strong></button>
          </div>
        </section>`;
    }
  }

  /** Pause overlay on top of the HUD (which stays visible behind it). */
  showPause(onResume: () => void, onRestart: () => void, onChangePlayer: () => void): void {
    this.ensurePauseDom();
    const title = this.pauseEl.querySelector<HTMLHeadingElement>("#pause-title");
    if (title) title.textContent = t("pause.title");
    const resumeLabel = this.pauseEl.querySelector<HTMLElement>("#pause-resume-label");
    if (resumeLabel) resumeLabel.textContent = t("pause.resume");
    const resumeBtn = this.pauseEl.querySelector<HTMLButtonElement>("#btn-resume");
    if (resumeBtn) resumeBtn.onclick = () => onResume();
    const restartBtn = this.pauseEl.querySelector<HTMLButtonElement>("#btn-restart");
    if (restartBtn) restartBtn.onclick = () => onRestart();
    const changeBtn = this.pauseEl.querySelector<HTMLButtonElement>("#btn-change-player");
    if (changeBtn) changeBtn.onclick = () => onChangePlayer();
    this.pauseEl.classList.remove("hidden");
  }

  hidePause(): void {
    this.pauseEl.classList.add("hidden");
  }

  /** Put a single coaching instruction over a frozen rally. */
  showTrainingPause(state: TrainingPauseState, onResume: () => void, onSkip?: () => void): void {
    this.trainingPauseEl.querySelector<HTMLDivElement>(".training-progress")!.textContent = state.progress;
    this.trainingPauseEl.querySelector<HTMLDivElement>(".training-title")!.textContent = state.title;
    this.trainingPauseEl.querySelector<HTMLDivElement>(".training-action-text")!.textContent = state.action;
    this.trainingPauseEl.querySelector<HTMLSpanElement>(".training-control-text")!.textContent = state.control;
    const resume = this.trainingPauseEl.querySelector<HTMLButtonElement>("#btn-training-resume")!;
    resume.textContent = state.resume ?? "CONTINUE";
    resume.disabled = false;
    resume.onclick = () => onResume();
    const skipBtn = this.trainingPauseEl.querySelector<HTMLButtonElement>("#btn-training-skip");
    if (skipBtn) {
      skipBtn.textContent = state.skip ?? "SKIP PRACTICE";
      const skipFn = state.onSkip ?? onSkip;
      if (skipFn) {
        skipBtn.classList.remove("hidden");
        skipBtn.onclick = () => skipFn();
      } else {
        skipBtn.classList.add("hidden");
      }
    }
    this.trainingPauseEl.classList.remove("hidden");
  }

  hideTrainingPause(): void {
    this.trainingPauseEl.classList.add("hidden");
  }

  showLoading(text = "Loading…"): void {
    this.hideAll();
    this.loadingText.textContent = text;
    // The one moment a player is looking at the game with nothing to do, and
    // the cheapest place there is to teach them something. A fresh tip per
    // load, not per frame: a line that changes while it is being read is worse
    // than no line.
    this.loadingTip.textContent = randomTip();
    this.loadingEl.classList.remove("hidden");
  }

  setLoadingText(text: string): void {
    this.loadingText.textContent = text;
  }

  hideLoading(): void {
    this.loadingEl.classList.add("hidden");
  }

  /**
   * Plays the opening clip over the loading screen, resolving when it ends or
   * turns out to be unplayable.
   *
   * Deliberately unskippable: the clip's four seconds are what the player
   * models and the ball are downloading in, so cutting it short would only
   * move the wait to a loading screen with nothing to look at.
   *
   * The overlay is only revealed once frames are arriving, so a device that
   * cannot decode the file shows nothing at all and boots straight through.
   */
  playIntroClip(src = INTRO_CLIP): Promise<void> {
    this.hideIntroClip();
    // An opening cinematic is exactly what this preference is about.
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return Promise.resolve();
    }

    const video = this.introClipVideo;

    return new Promise<void>((resolve) => {
      let settled = false;
      // A decoder that stalls without ever erroring would otherwise hold the
      // player here indefinitely.
      const watchdog = window.setTimeout(() => finish(), 15000);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        video.onplaying = null;
        video.onended = null;
        video.onerror = null;
        this.introClipDone = null;
        resolve();
      };

      this.introClipDone = finish;
      video.onplaying = () => this.introClipEl.classList.remove("hidden");
      // Hold on the last frame rather than clearing: the loading bar sits over
      // it while whatever is left of the download finishes.
      video.onended = () => finish();
      video.onerror = () => finish();

      // The blurred still behind the letterbox bars. Decorative, and the rule
      // in `style.css` keeps a flat colour under it, so this is applied
      // whenever it arrives and never waited for or reported.
      void assetUrl(BACKDROP)
        .then((url) => {
          this.introClipEl.style.backgroundImage = `url("${url}")`;
        })
        .catch(() => undefined);

      // A protected build cannot hand the element a path — the file there is
      // `.teq` noise — so the clip is fetched and decrypted first. That costs
      // the whole 600 KB before the first frame instead of streaming it, which
      // is why `finish()` on failure matters more here than it did: a build
      // whose clip will not decrypt has to boot through, not sit on a
      // watchdog.
      void assetUrl(src)
        .then((url) => {
          if (settled) return;
          video.src = url;
          // Try it with its own sound first: a native WebView is allowed to
          // start unmuted, a browser tab is not, and muted playback always
          // starts.
          video.muted = false;
          void video.play().catch(() => {
            video.muted = true;
            void video.play().catch(() => finish());
          });
        })
        .catch(() => finish());
    });
  }

  /**
   * Show how far the asset download has got, over the clip's last frame.
   *
   * Only worth showing once the clip is done — during it there is something to
   * watch, and a bar over moving footage is just clutter.
   */
  showIntroProgress(fraction: number, label?: string): void {
    this.introProgressEl.classList.add("visible");
    this.introProgressFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    if (label !== undefined) this.introProgressLabel.textContent = label;
  }

  /** Clears the opening clip and releases its decoder. */
  hideIntroClip(): void {
    this.introClipEl.classList.add("hidden");
    this.introProgressEl.classList.remove("visible");
    const video = this.introClipVideo;
    video.pause();
    if (video.getAttribute("src")) {
      video.removeAttribute("src");
      video.load();
    }
    this.introClipDone?.();
  }

  /**
   * The first screen: one obvious action, and a quiet way to the settings.
   *
   * Everything else — practice, competition, online — is one press further in.
   * A title screen that lists every mode is a dashboard, and a player opening a
   * game for the first time should only have to recognise PLAY.
   */
  showTitle(actions: {
    /**
     * Starting a match loads assets, so this one is allowed to be async. The
     * button does not wait on it — the screen it opens reports its own
     * progress — so the promise is deliberately dropped at the call below.
     */
    onPlay: () => void | Promise<void>;
    onChampions: () => void;
    onChallenges: () => void;
    onSupplies: () => void;
    onProfile: () => void;
    onSettings: () => void;
    /** The player's name, when this device has an account. */
    profileLabel?: string | null;
    /** True while a daily challenge is finished and its reward uncollected. */
    challengeReady?: boolean;
  }): void {
    this.hideAll();
    this.showWallet();
    this.titleEl.querySelector<HTMLParagraphElement>(".logo-tagline")!.textContent = t("title.tagline");
    const btn = this.titleEl.querySelector<HTMLButtonElement>("#btn-play")!;
    const btnText = btn.querySelector<HTMLSpanElement>(".btn-text") ?? btn.querySelector("span")!;
    btnText.textContent = t("title.play");
    btn.onclick = () => {
      this.setOriginFromElement(btn);
      void actions.onPlay();
    };
    const wire = (id: string, label: string, fn: () => void) => {
      const el = this.titleEl.querySelector<HTMLButtonElement>(id)!;
      el.textContent = label;
      el.onclick = () => {
        this.setOriginFromElement(el);
        fn();
      };
      return el;
    };
    wire("#btn-title-champions", t("career.champions"), actions.onChampions);
    // A reward waiting is the one thing on this screen allowed to compete with
    // PLAY for attention, and only as a dot.
    wire("#btn-title-challenges", t("career.challenges"), actions.onChallenges).classList.toggle(
      "has-dot",
      actions.challengeReady === true
    );
    wire("#btn-title-supplies", t("career.supplies"), actions.onSupplies);
    // The profile chip wears the player's own name once they have one: it is
    // the shortest way to say the account is real and it is theirs.
    wire("#btn-title-profile", actions.profileLabel ?? t("profile.title"), actions.onProfile);
    wire("#btn-title-settings", t("title.settings"), actions.onSettings);

    // Attract mode: pulse the PLAY button after 7s of inactivity
    this.startAttractMode(btn);

    this.revealScreen(this.titleEl);
  }

  /**
   * Guided UI tour shown on first launch to orient the player around the dashboard.
   */
  showUiTutorial(onDone: () => void): void {
    // Same test the loading tips use, for the same reason: a card telling a
    // desktop player how to hold their phone is a card that wastes the one
    // moment they are actually reading.
    const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    const steps = [
      {
        badge: "🏓",
        title: t("tutorial.step1.title"),
        text: t("tutorial.step1.text"),
        highlight: null,
      },
      // Second, because it decides how they hold the thing before they press
      // anything. Both schemes are complete and the game swaps between them
      // live, and until now nothing on any screen said so.
      ...(touch
        ? [
            {
              badge: "📱",
              title: t("tutorial.orientation.title"),
              text: t("tutorial.orientation.text"),
              highlight: null,
            },
          ]
        : []),
      {
        badge: "⚡",
        title: t("tutorial.step2.title"),
        text: t("tutorial.step2.text"),
        highlight: "#btn-play",
      },
      {
        badge: "👕",
        title: t("tutorial.step3.title"),
        text: t("tutorial.step3.text"),
        highlight: "#btn-title-champions, #btn-title-supplies",
      },
      {
        badge: "🏆",
        title: t("tutorial.step4.title"),
        text: t("tutorial.step4.text"),
        highlight: "#btn-title-challenges, #btn-title-settings",
      },
    ];

    let currentStep = 0;

    // Built from the steps rather than written out in the markup: the tour is
    // four cards on a desktop and five on a phone, and a fixed row of dots
    // would quietly lie about how much is left.
    const dotRow = this.uiTutorialEl.querySelector<HTMLDivElement>(".tutorial-progress-dots")!;
    dotRow.innerHTML = steps.map((_, i) => `<span class="dot${i === 0 ? " active" : ""}"></span>`).join("");

    const clearHighlights = () => {
      document.querySelectorAll(".ui-tutorial-spotlight").forEach((el) => {
        el.classList.remove("ui-tutorial-spotlight");
      });
    };

    const updateStep = (index: number) => {
      clearHighlights();
      currentStep = index;
      const step = steps[currentStep];

      const dots = this.uiTutorialEl.querySelectorAll<HTMLSpanElement>(".tutorial-progress-dots .dot");
      dots.forEach((dot, i) => dot.classList.toggle("active", i === currentStep));

      this.uiTutorialEl.querySelector<HTMLDivElement>("#tutorial-badge")!.textContent = step.badge;
      this.uiTutorialEl.querySelector<HTMLHeadingElement>("#tutorial-title")!.textContent = step.title;
      this.uiTutorialEl.querySelector<HTMLParagraphElement>("#tutorial-text")!.textContent = step.text;

      const isLast = currentStep === steps.length - 1;
      const nextBtn = this.uiTutorialEl.querySelector<HTMLButtonElement>("#btn-tutorial-next")!;
      const btnText = nextBtn.querySelector<HTMLSpanElement>(".btn-text") ?? nextBtn;
      btnText.textContent = isLast ? t("tutorial.done") : t("tutorial.next");

      const skipBtn = this.uiTutorialEl.querySelector<HTMLButtonElement>("#btn-tutorial-skip")!;
      skipBtn.textContent = t("tutorial.skip");

      if (step.highlight) {
        document.querySelectorAll(step.highlight).forEach((el) => {
          el.classList.add("ui-tutorial-spotlight");
        });
      }
    };

    const closeTutorial = () => {
      clearHighlights();
      this.uiTutorialEl.classList.add("hidden");
      onDone();
    };

    const skipBtn = this.uiTutorialEl.querySelector<HTMLButtonElement>("#btn-tutorial-skip")!;
    skipBtn.onclick = () => closeTutorial();

    const nextBtn = this.uiTutorialEl.querySelector<HTMLButtonElement>("#btn-tutorial-next")!;
    nextBtn.onclick = () => {
      if (currentStep < steps.length - 1) {
        updateStep(currentStep + 1);
      } else {
        closeTutorial();
      }
    };

    updateStep(0);
    this.uiTutorialEl.classList.remove("hidden");
  }

  private attractModeTimer: ReturnType<typeof setTimeout> | null = null;
  private attractModeActive = false;
  private attractModeHandler: (() => void) | null = null;
  private attractModePlayBtn: HTMLButtonElement | null = null;

  private startAttractMode(playBtn: HTMLButtonElement): void {
    this.attractModePlayBtn = playBtn;
    const reset = () => {
      if (this.attractModeActive) {
        this.attractModeActive = false;
        playBtn.classList.remove("play-attract");
      }
      if (this.attractModeTimer) clearTimeout(this.attractModeTimer);
      this.attractModeTimer = setTimeout(() => {
        this.attractModeActive = true;
        playBtn.classList.add("play-attract");
      }, 7000);
    };
    reset();
    this.attractModeHandler = () => reset();
    window.addEventListener("pointerdown", this.attractModeHandler, { once: true });
    window.addEventListener("keydown", this.attractModeHandler, { once: true });
  }

  private stopAttractMode(): void {
    if (this.attractModeHandler) {
      window.removeEventListener("pointerdown", this.attractModeHandler);
      window.removeEventListener("keydown", this.attractModeHandler);
      this.attractModeHandler = null;
    }
    if (this.attractModeTimer) {
      clearTimeout(this.attractModeTimer);
      this.attractModeTimer = null;
    }
    if (this.attractModeActive && this.attractModePlayBtn) {
      this.attractModePlayBtn.classList.remove("play-attract");
    }
    this.attractModeActive = false;
    this.attractModePlayBtn = null;
  }

  /**
   * The coins-and-trophies strip.
   *
   * Shown on the screens where those numbers are the reason the player is
   * looking — the title, the roster, the challenges — and nowhere near a live
   * match, where a currency counter over the court is just something else
   * moving while a ball is in the air.
   */
  setWallet(coins: number, trophies: number, tier: string): void {
    // Update title screen stats bar if visible
    const coinsEl = this.titleEl.querySelector<HTMLSpanElement>("#stat-coins-value");
    const trophiesEl = this.titleEl.querySelector<HTMLSpanElement>("#stat-trophies-value");
    const rankEl = this.titleEl.querySelector<HTMLSpanElement>("#stat-rank-value");
    if (coinsEl) coinsEl.textContent = coins.toLocaleString();
    if (trophiesEl) trophiesEl.textContent = trophies.toLocaleString();
    if (rankEl) rankEl.textContent = tier;

    // Also update the wallet element for other screens
    this.walletEl.innerHTML = `
      <div class="stat-pill" id="header-wallet-coins" style="cursor: pointer"><svg class="coin-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" fill="#f5c518" stroke="#c8a000" stroke-width="0.5"/><text x="7" y="10.5" text-anchor="middle" font-size="7" font-weight="bold" fill="#7a5000">$</text></svg><b>${coins.toLocaleString()}</b></div>
      <div class="stat-pill"><svg class="trophy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5c518" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg><b>${trophies.toLocaleString()}</b></div>
      <div class="stat-pill rank"><b>${tier}</b></div>`;
    const walletCoins = this.walletEl.querySelector<HTMLDivElement>("#header-wallet-coins");
    if (walletCoins) {
      walletCoins.onclick = (e) => {
        e.stopPropagation();
        this.onCoinsClicked?.();
      };
    }
    this.walletEl.setAttribute(
      "aria-label",
      `${t("career.coins")} ${coins}, ${t("career.trophies")} ${trophies}, ${t("career.rank")} ${tier}`
    );
  }

  private showWallet(): void {
    this.walletEl.classList.remove("hidden");
  }

  /**
   * The roster.
   *
   * A locked card still shows who is behind it and what it costs to get them:
   * a grid of question marks is a list of things the player cannot have, and a
   * grid of named players two hundred trophies away is a reason to play.
   */
  showChampions(view: ChampionsView): void {
    this.hideAll();
    this.revealScreen(this.championsEl);
    this.showWallet();

    const flagMap: Record<string, string> = {
      BrazilianPlayer: "🇧🇷",
      brazil: "🇧🇷",
      EnglishPlayer: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
      england: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
      FrenchPlayer: "🇫🇷",
      france: "🇫🇷",
      SpanishPlayer: "🇪🇸",
      spain: "🇪🇸",
    };

    const maxPower = Math.max(...view.rows.map((r) => r.power), 1);

    this.championsEl.innerHTML = `
      <div class="champions-scroll" id="champions-scroll-box">
        <div class="champions-scroll-content">
          <div class="career-head">
            <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
            <button class="select-back" id="btn-champions-back" type="button" data-menu-back>← ${t("nav.back")}</button>
          </div>
          <div class="career-title-wrap">
            <h1 class="career-title">${t("career.champions")}</h1>
            <p class="career-sub">${t("career.champions.sub")}</p>
          </div>
          <div class="champion-list"></div>
        </div>
      </div>
      <div class="scroll-hint-anim hidden" id="champions-scroll-hint">
        <svg width="22" height="34" viewBox="0 0 22 34" fill="none">
          <rect x="3" y="0" width="16" height="26" rx="8" fill="rgba(255,255,255,0.78)" />
          <rect x="7" y="2" width="8" height="5" rx="2.5" fill="rgba(255,255,255,0.32)" />
        </svg>
        <div style="width: 1.5px; height: 22px; background: linear-gradient(180deg, rgba(255,255,255,0.55) 0%, transparent 100%);"></div>
      </div>`;

    const back = this.championsEl.querySelector<HTMLButtonElement>("#btn-champions-back")!;
    back.onclick = () => {
      this.collapseScreen(this.championsEl, back, () => view.onBack());
    };

    const list = this.championsEl.querySelector<HTMLDivElement>(".champion-list")!;
    for (const row of view.rows) {
      const card = document.createElement("div");
      card.className = row.unlocked ? "champion-card" : "champion-card locked";
      card.dataset.champion = row.id;
      const flag = flagMap[row.id] || "⚽";
      const fillPct = Math.round((row.power / maxPower) * 100);

      card.innerHTML = `
        <span class="champion-watermark" aria-hidden="true">${flag}</span>
        <div class="champion-top">
          <div class="champion-title-lockup">
            <span class="champion-flag">${flag}</span>
            <span class="champion-name">${row.label}</span>
          </div>
          <span class="champion-level">${row.unlocked ? `${t("career.level")} ${row.level}` : t("career.locked")}</span>
        </div>
        <div class="champion-power-block">
          <span class="champion-power-num">${row.power}</span>
          <span class="champion-power-label">${t("career.power")}</span>
        </div>
        <div class="bar champion-power-bar"><i style="width: ${fillPct}%"></i></div>
        <div class="champion-traits"></div>
        <div class="champion-foot"></div>`;

      const traits = card.querySelector<HTMLDivElement>(".champion-traits")!;
      for (const stat of row.stats) {
        const line = document.createElement("div");
        line.className = "champion-trait";
        line.innerHTML = `<span class="champion-trait-label">${stat.label}</span><div class="bar"><i style="width: ${stat.value}%"></i></div><b>${stat.value}</b>`;
        traits.appendChild(line);
      }

      const foot = card.querySelector<HTMLDivElement>(".champion-foot")!;
      if (!row.unlocked) {
        const note = document.createElement("span");
        note.className = "champion-note";
        note.textContent = tf("career.unlockAt", { n: row.unlockAt });
        foot.appendChild(note);
      } else if (row.cost === null) {
        const note = document.createElement("span");
        note.className = "champion-note done";
        note.textContent = t("career.maxLevel");
        foot.appendChild(note);
      } else {
        const note = document.createElement("span");
        note.className = "champion-note";
        note.textContent =
          row.nextIn === null ? "" : tf("career.nextLevel", { n: row.nextIn });
        const buy = document.createElement("button");
        buy.type = "button";
        buy.className = "champion-buy";
        buy.disabled = !row.affordable;
        buy.textContent = `${t("career.upgrade")} · ${row.cost}`;
        buy.onclick = (e) => {
          e.stopPropagation();
          view.onUpgrade(row.id);
        };
        foot.append(note, buy);
      }
      list.appendChild(card);
    }

    // Scroll hint: automated sine scroll and floating indicator if content overflows
    const scrollBox = this.championsEl.querySelector<HTMLDivElement>("#champions-scroll-box")!;
    const hintEl = this.championsEl.querySelector<HTMLDivElement>("#champions-scroll-hint")!;
    if (this.championsScrollTimer) clearTimeout(this.championsScrollTimer);
    this.championsScrollTimer = setTimeout(() => {
      if (!scrollBox || scrollBox.scrollHeight <= scrollBox.clientHeight) return;
      hintEl.classList.remove("hidden");
      const target = 72;
      const duration = 1900;
      const start = performance.now();
      const tick = (now: number) => {
        if (!scrollBox || this.championsEl.classList.contains("hidden")) return;
        const elapsed = now - start;
        const prog = Math.min(elapsed / duration, 1);
        scrollBox.scrollTop = target * Math.sin(prog * Math.PI);
        if (prog < 1) {
          requestAnimationFrame(tick);
        } else {
          scrollBox.scrollTop = 0;
          setTimeout(() => hintEl.classList.add("hidden"), 300);
        }
      };
      requestAnimationFrame(tick);
    }, 1100);
  }

  /** Today's three, with a countdown that says plainly what "daily" means. */
  showChallenges(view: ChallengesView): void {
    this.hideAll();
    this.revealScreen(this.challengesEl);
    this.showWallet();
    this.challengesEl.innerHTML = `
      <div class="career-head">
        <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
        <button class="select-back" id="btn-challenges-back" type="button" data-menu-back>← ${t("nav.back")}</button>
      </div>
      <div class="career-title-wrap">
        <h2 class="career-title"></h2>
        <p class="career-sub"></p>
      </div>
      <div class="career-list challenge-list"></div>`;
    const back = this.challengesEl.querySelector<HTMLButtonElement>("#btn-challenges-back")!;
    back.onclick = () => {
      this.collapseScreen(this.challengesEl, back, () => view.onBack());
    };
    this.challengesEl.querySelector<HTMLHeadingElement>(".career-title")!.textContent =
      t("career.challenges");
    this.challengesEl.querySelector<HTMLParagraphElement>(".career-sub")!.textContent =
      tf("career.resetsIn", { t: view.resetsIn });

    const list = this.challengesEl.querySelector<HTMLDivElement>(".challenge-list")!;
    for (const row of view.rows) {
      const done = row.progress >= row.goal;
      const card = document.createElement("div");
      card.className = done
        ? row.claimed
          ? "challenge-card done claimed"
          : "challenge-card done"
        : "challenge-card";
      card.dataset.challenge = row.id;
      card.innerHTML = `
        <div class="challenge-top">
          <span class="challenge-text"></span>
          <div class="challenge-reward">
            <svg class="coin-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" fill="#f5c518" stroke="#c8a000" stroke-width="0.5"/><text x="7" y="10.5" text-anchor="middle" font-size="7" font-weight="bold" fill="#7a5000">$</text></svg>
            <span class="challenge-reward-val"></span>
          </div>
        </div>
        <span class="bar"><i></i></span>
        <div class="challenge-foot"><span class="challenge-count"></span></div>`;
      card.querySelector<HTMLSpanElement>(".challenge-text")!.textContent = row.text;
      card.querySelector<HTMLSpanElement>(".challenge-reward-val")!.textContent = String(row.reward);
      card.querySelector<HTMLElement>(".bar i")!.style.width =
        `${Math.round(Math.min(1, row.progress / row.goal) * 100)}%`;
      card.querySelector<HTMLSpanElement>(".challenge-count")!.textContent =
        `${Math.min(row.progress, row.goal)} / ${row.goal}`;
      if (done) {
        const claim = document.createElement("button");
        claim.type = "button";
        claim.className = "challenge-claim";
        claim.disabled = row.claimed;
        claim.textContent = row.claimed ? t("career.claimed") : t("career.claim");
        claim.onclick = () => view.onClaim(row.id);
        card.querySelector<HTMLDivElement>(".challenge-foot")!.appendChild(claim);
      }
      list.appendChild(card);
    }
  }

  /**
   * What the match was worth.
   *
   * The deltas are the headline and the totals are the small print: a player
   * who has just finished a match wants to know what changed, and can read the
   * standing total off the strip at the top whenever they care.
   */
  showResult(view: ResultView): void {
    this.hideAll();
    this.showSceneBehind();
    this.revealScreen(this.resultEl);
    this.showWallet();
    const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    this.resultEl.innerHTML = `
      <div class="result-card">
        <div class="result-verdict"></div>
        <div class="result-rank"></div>
        <div class="result-rows">
          <div class="result-row"><span></span><b class="result-trophies"></b></div>
          <div class="result-row"><span></span><b class="result-coins"></b></div>
        </div>
        <div class="result-ladder">
          <div class="result-tier"></div>
          <span class="bar"><i></i></span>
          <div class="result-next"></div>
        </div>
        <ul class="result-notes"></ul>
        <div class="result-btns"></div>
      </div>`;
    const card = this.resultEl.querySelector<HTMLDivElement>(".result-card")!;
    card.classList.toggle("won", view.won);
    card.querySelector<HTMLDivElement>(".result-verdict")!.textContent = view.won
      ? t("result.win")
      : t("result.loss");

    const rank = card.querySelector<HTMLDivElement>(".result-rank")!;
    rank.textContent = view.rank === null ? "" : t(`career.${view.rank}`);
    rank.className = view.rank === null ? "result-rank hidden" : `result-rank ${view.rank}`;

    const labels = card.querySelectorAll(".result-row span");
    labels[0].textContent = t("result.trophies");
    labels[1].textContent = t("result.coins");
    card.querySelector<HTMLElement>(".result-trophies")!.textContent = sign(view.trophies);
    card.querySelector<HTMLElement>(".result-coins")!.textContent = sign(view.coins);

    card.querySelector<HTMLDivElement>(".result-tier")!.textContent = view.tier;
    card.querySelector<HTMLElement>(".result-ladder .bar i")!.style.width =
      `${Math.round(view.progress * 100)}%`;
    card.querySelector<HTMLDivElement>(".result-next")!.textContent = view.nextTier
      ? tf("career.nextRank", { n: view.toNext, tier: view.nextTier })
      : t("career.topRank");

    const notes = card.querySelector<HTMLUListElement>(".result-notes")!;
    for (const note of view.notes) {
      const li = document.createElement("li");
      li.textContent = note;
      notes.appendChild(li);
    }

    const btns = card.querySelector<HTMLDivElement>(".result-btns")!;
    if (view.onRematch) {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "big-btn alt";
      again.id = "btn-result-rematch";
      again.textContent = t("end.rematch");
      again.onclick = () => {
        this.setOriginFromElement(again);
        view.onRematch?.();
      };
      btns.appendChild(again);
    }
    const go = document.createElement("button");
    go.type = "button";
    go.className = "big-btn";
    go.id = "btn-result-continue";
    go.dataset.menuPrimary = "true";
    go.textContent = t("result.continue");
    go.onclick = () => {
      this.setOriginFromElement(go);
      view.onContinue();
    };
    btns.appendChild(go);
  }

  /**
   * The account screen. Two states, one screen.
   */
  showProfile(view: ProfileView): void {
    this.hideAll();
    this.revealScreen(this.profileEl);
    this.showWallet();
    const p = view.profile;
    this.profileEl.innerHTML = `
      <div class="career-head">
        <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
        <button class="select-back" id="btn-profile-back" type="button" data-menu-back>← ${t("nav.back")}</button>
      </div>
      <div class="career-title-wrap">
        <h2 class="career-title"></h2>
      </div>
      <div class="career-list">
        <div class="account-card"></div>
      </div>`;
    const back = this.profileEl.querySelector<HTMLButtonElement>("#btn-profile-back")!;
    back.onclick = () => {
      this.collapseScreen(this.profileEl, back, () => view.onBack());
    };
    this.profileEl.querySelector<HTMLHeadingElement>(".career-title")!.textContent =
      p ? p.name : t("profile.title");

    const card = this.profileEl.querySelector<HTMLDivElement>(".account-card")!;
    const message = document.createElement("p");
    message.className = "account-message";
    message.textContent = view.message ?? "";
    message.classList.toggle("hidden", !view.message);

    if (!p) {
      card.innerHTML = `
        <h3 class="account-pitch"></h3>
        <p class="account-why"></p>
        <label class="account-field"><span></span><input id="profile-name" type="text" maxlength="16" autocomplete="off" spellcheck="false"></label>
        <p class="account-warning fresh hidden"></p>
        <button class="big-btn" id="btn-profile-create" type="button" data-menu-primary="true"></button>
        <button class="ghost-btn" id="btn-profile-restore" type="button"></button>
        <p class="account-warning"></p>`;
      card.querySelector<HTMLHeadingElement>(".account-pitch")!.textContent = t("profile.signedOut");
      card.querySelector<HTMLParagraphElement>(".account-why")!.textContent = t("profile.why");
      card.querySelector<HTMLSpanElement>(".account-field span")!.textContent = t("profile.name");
      const fresh = card.querySelector<HTMLParagraphElement>(".account-warning.fresh")!;
      fresh.textContent = view.freshStart ?? "";
      fresh.classList.toggle("hidden", !view.freshStart);
      card.querySelectorAll<HTMLParagraphElement>(".account-warning")[1].textContent =
        t("profile.warning");
      const input = card.querySelector<HTMLInputElement>("#profile-name")!;
      const create = card.querySelector<HTMLButtonElement>("#btn-profile-create")!;
      create.textContent = view.busy ? t("profile.creating") : t("profile.create");
      create.disabled = view.busy;
      create.onclick = () => {
        this.setOriginFromElement(create);
        view.onCreate(input.value);
      };
      const restore = card.querySelector<HTMLButtonElement>("#btn-profile-restore")!;
      restore.textContent = t("recovery.restore");
      restore.onclick = () => {
        this.setOriginFromElement(restore);
        view.onRestore();
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          this.setOriginFromElement(create);
          view.onCreate(input.value);
        }
      };
      card.insertBefore(message, fresh);
      if (!("ontouchstart" in window)) input.focus();
      return;
    }

    card.innerHTML = `
      <div class="account-code">
        <span class="account-code-label"></span>
        <b class="account-code-value"></b>
        <span class="account-code-hint"></span>
      </div>
      <div class="account-stats">
        <div><span></span><b class="stat-rank"></b></div>
        <div><span></span><b class="stat-trophies"></b></div>
        <div><span></span><b class="stat-matches"></b></div>
      </div>
      <label class="account-field"><span></span><input id="profile-name" type="text" maxlength="16" autocomplete="off" spellcheck="false"></label>
      <button class="ghost-btn" id="btn-profile-rename" type="button"></button>
      <button class="big-btn alt" id="btn-profile-friends" type="button"></button>
      <button class="big-btn alt" id="btn-profile-club" type="button"></button>
      <button class="ghost-btn" id="btn-profile-newcode" type="button"></button>
      <button class="ghost-btn" id="btn-profile-restore" type="button"></button>
      <button class="big-btn" id="btn-profile-board" type="button" data-menu-primary="true"></button>`;
    card.querySelector<HTMLSpanElement>(".account-code-label")!.textContent = t("profile.code");
    card.querySelector<HTMLElement>(".account-code-value")!.textContent = p.id;
    card.querySelector<HTMLSpanElement>(".account-code-hint")!.textContent = t("profile.codeHint");
    const labels = card.querySelectorAll(".account-stats span");
    labels[0].textContent = t("profile.rank");
    labels[1].textContent = t("career.trophies");
    labels[2].textContent = t("profile.matches");
    card.querySelector<HTMLElement>(".stat-rank")!.textContent =
      p.rank === null ? t("profile.unranked") : `#${p.rank}`;
    card.querySelector<HTMLElement>(".stat-trophies")!.textContent = String(p.trophies);
    card.querySelector<HTMLElement>(".stat-matches")!.textContent = String(p.matches);
    card.querySelector<HTMLSpanElement>(".account-field span")!.textContent = t("profile.name");
    const input = card.querySelector<HTMLInputElement>("#profile-name")!;
    input.value = p.name;
    const renameBtn = card.querySelector<HTMLButtonElement>("#btn-profile-rename")!;
    renameBtn.textContent = t("profile.rename");
    renameBtn.disabled = view.busy;
    renameBtn.onclick = () => view.onRename(input.value);
    const friends = card.querySelector<HTMLButtonElement>("#btn-profile-friends")!;
    friends.textContent = t("friends.title");
    friends.onclick = () => {
      this.setOriginFromElement(friends);
      view.onFriends();
    };
    const club = card.querySelector<HTMLButtonElement>("#btn-profile-club")!;
    club.textContent = t("club.title");
    club.onclick = () => {
      this.setOriginFromElement(club);
      view.onClub();
    };
    const newCode = card.querySelector<HTMLButtonElement>("#btn-profile-newcode")!;
    newCode.textContent = t("recovery.new");
    newCode.disabled = view.busy;
    newCode.onclick = () => {
      this.setOriginFromElement(newCode);
      view.onNewCode();
    };
    const restoreBtn = card.querySelector<HTMLButtonElement>("#btn-profile-restore")!;
    restoreBtn.textContent = t("recovery.restore");
    restoreBtn.disabled = view.busy;
    restoreBtn.onclick = () => {
      this.setOriginFromElement(restoreBtn);
      view.onRestore();
    };
    const board = card.querySelector<HTMLButtonElement>("#btn-profile-board")!;
    board.textContent = t("profile.leaderboard");
    board.onclick = () => {
      this.setOriginFromElement(board);
      view.onLeaderboard();
    };
    card.insertBefore(message, renameBtn);

    if (view.titles.length) {
      const shelf = document.createElement("div");
      shelf.className = "season-shelf";
      const heading = document.createElement("span");
      heading.className = "season-shelf-head";
      heading.textContent = t("season.titles");
      shelf.appendChild(heading);
      for (const title of [...view.titles].reverse()) {
        const badge = document.createElement("div");
        badge.className = "season-badge";
        badge.innerHTML = `<b></b><span></span><i></i>`;
        badge.querySelector("b")!.textContent = title.tier;
        badge.querySelector("span")!.textContent = title.season;
        badge.querySelector("i")!.textContent = `${title.best}`;
        shelf.appendChild(badge);
      }
      card.insertBefore(shelf, card.querySelector(".account-field"));
    }
  }

  /** Everyone, in order. The caller's own row is pinned if it fell off the end. */
  showLeaderboard(view: LeaderboardViewModel): void {
    this.hideAll();
    this.revealScreen(this.boardEl);
    this.showWallet();
    this.boardEl.innerHTML = `
      <div class="career-head">
        <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
        <button class="select-back" id="btn-board-back" type="button" data-menu-back>← ${t("nav.back")}</button>
      </div>
      <div class="career-title-wrap">
        <h2 class="career-title"></h2>
        <p class="career-sub"></p>
      </div>
      <div class="career-list board-list"></div>
      <div class="board-pinned hidden"></div>`;
    const back = this.boardEl.querySelector<HTMLButtonElement>("#btn-board-back")!;
    back.onclick = () => {
      this.collapseScreen(this.boardEl, back, () => view.onBack());
    };
    this.boardEl.querySelector<HTMLHeadingElement>(".career-title")!.textContent = t("board.title");
    this.boardEl.querySelector<HTMLParagraphElement>(".career-sub")!.textContent = view.message
      ? view.message
      : tf("board.sub", { n: view.total });

    const list = this.boardEl.querySelector<HTMLDivElement>(".board-list")!;
    if (view.rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "board-empty";
      empty.textContent = view.message ?? t("board.empty");
      list.appendChild(empty);
    }
    const rowEl = (row: BoardRow): HTMLDivElement => {
      const el = document.createElement("div");
      el.className = row.isMe ? "board-row me" : "board-row";
      el.innerHTML = `<b class="board-rank"></b><span class="board-name"></span><span class="board-tier"></span><b class="board-trophies"></b>`;
      el.querySelector<HTMLElement>(".board-rank")!.textContent = `${row.rank}`;
      el.querySelector<HTMLSpanElement>(".board-name")!.textContent = row.name;
      el.querySelector<HTMLSpanElement>(".board-tier")!.textContent = row.tier;
      el.querySelector<HTMLElement>(".board-trophies")!.textContent = String(row.trophies);
      if (row.isMe) el.setAttribute("aria-label", `${t("board.you")}: ${row.name}`);
      return el;
    };
    for (const row of view.rows) list.appendChild(rowEl(row));

    const pinned = this.boardEl.querySelector<HTMLDivElement>(".board-pinned")!;
    if (view.me && !view.rows.some((r) => r.isMe)) {
      pinned.classList.remove("hidden");
      pinned.appendChild(rowEl(view.me));
    }
  }

  /** The recovery code, shown once. */
  showRecoveryCode(view: RecoveryView): void {
    this.hideAll();
    this.revealScreen(this.recoveryEl);
    this.recoveryEl.innerHTML = `
      <div class="account-card recovery-card">
        <h2 class="career-title"></h2>
        <p class="account-why"></p>
        <b class="recovery-code"></b>
        <p class="account-message hidden"></p>
        <button class="ghost-btn" id="btn-recovery-copy" type="button"></button>
        <button class="big-btn" id="btn-recovery-done" type="button" data-menu-primary="true"></button>
      </div>`;
    const card = this.recoveryEl.querySelector<HTMLDivElement>(".recovery-card")!;
    card.querySelector<HTMLHeadingElement>(".career-title")!.textContent = t("recovery.title");
    card.querySelector<HTMLParagraphElement>(".account-why")!.textContent = t("recovery.why");
    card.querySelector<HTMLElement>(".recovery-code")!.textContent = view.code;
    const note = card.querySelector<HTMLParagraphElement>(".account-message")!;
    note.textContent = view.note ?? "";
    note.classList.toggle("hidden", !view.note);

    const copy = card.querySelector<HTMLButtonElement>("#btn-recovery-copy")!;
    copy.textContent = t("recovery.copy");
    copy.onclick = () => {
      void navigator.clipboard?.writeText(view.code).then(
        () => (copy.textContent = t("recovery.copied")),
        () => undefined
      );
    };
    const done = card.querySelector<HTMLButtonElement>("#btn-recovery-done")!;
    done.textContent = t("recovery.saved");
    done.onclick = () => {
      this.setOriginFromElement(done);
      view.onDone();
    };
  }

  /** What a finished season was worth. */
  showSeason(view: SeasonView): void {
    this.hideAll();
    this.revealScreen(this.seasonEl);
    this.showWallet();
    this.seasonEl.innerHTML = `
      <div class="account-card season-card">
        <div class="season-when"></div>
        <h2 class="career-title"></h2>
        <div class="season-tier"></div>
        <div class="result-rows">
          <div class="result-row"><span></span><b class="season-best"></b></div>
          <div class="result-row"><span></span><b class="season-coins"></b></div>
          <div class="result-row"><span></span><b class="season-carry"></b></div>
        </div>
        <p class="account-why"></p>
        <button class="big-btn" id="btn-season-done" type="button" data-menu-primary="true"></button>
      </div>`;
    const card = this.seasonEl.querySelector<HTMLDivElement>(".season-card")!;
    card.querySelector<HTMLDivElement>(".season-when")!.textContent = view.season;
    card.querySelector<HTMLHeadingElement>(".career-title")!.textContent = t("season.title");
    card.querySelector<HTMLDivElement>(".season-tier")!.textContent = view.tier;

    const labels = card.querySelectorAll(".result-row span");
    labels[0].textContent = t("season.best");
    labels[1].textContent = t("result.coins");
    labels[2].textContent = t("season.carried");
    card.querySelector<HTMLElement>(".season-best")!.textContent = `${view.best}`;
    card.querySelector<HTMLElement>(".season-coins")!.textContent = `+${view.coins}`;
    card.querySelector<HTMLElement>(".season-carry")!.textContent = `${view.from} → ${view.to}`;
    card.querySelector<HTMLParagraphElement>(".account-why")!.textContent = t("season.why");

    const done = card.querySelector<HTMLButtonElement>("#btn-season-done")!;
    done.textContent = t("season.start");
    done.onclick = () => {
      this.setOriginFromElement(done);
      view.onDone();
    };
  }

  /** Entering a code to take an account over onto this device. */
  /**
   * Point at one thing on screen and say what to do with it.
   *
   * The guided tour's whole visual vocabulary: a ring around the thing, a
   * sentence under it, and a way out. Nothing is a dialog, because a dialog is
   * something to dismiss and every step here is finished by *using* the screen
   * behind it — so the overlay never takes the pointer except on its own skip
   * button.
   *
   * The ring is re-measured every frame rather than placed once. Screens here
   * are rebuilt from their markup whenever they are shown, so the element a
   * step points at is routinely replaced underneath it, and the phone can be
   * turned mid-step. Following the rectangle is cheaper than knowing when any
   * of that happened.
   *
   * A step whose target is not on screen shows the sentence alone. That is the
   * honest thing to draw: there is nothing to point at yet.
   */
  showTourCue(view: TourCueView): void {
    if (!this.tourEl) {
      this.tourEl = document.createElement("div");
      this.tourEl.className = "tour-layer";
      this.tourEl.innerHTML = `
        <div class="tour-ring" hidden></div>
        <div class="tour-card">
          <p class="tour-step"></p>
          <p class="tour-says"></p>
          <button class="tour-skip" type="button"></button>
        </div>`;
      this.root.appendChild(this.tourEl);
    }
    const ring = this.tourEl.querySelector<HTMLDivElement>(".tour-ring")!;
    const card = this.tourEl.querySelector<HTMLDivElement>(".tour-card")!;
    this.tourEl.querySelector<HTMLParagraphElement>(".tour-says")!.textContent = view.says;
    this.tourEl.querySelector<HTMLParagraphElement>(".tour-step")!.textContent =
      tf("tour.progress", { n: view.step, of: view.of });
    const skip = this.tourEl.querySelector<HTMLButtonElement>(".tour-skip")!;
    skip.textContent = t("tour.skip");
    skip.onclick = () => view.onSkip();

    if (this.tourFrame !== null) cancelAnimationFrame(this.tourFrame);
    const place = () => {
      const target = view.target ? document.querySelector(view.target) : null;
      const box = target?.getBoundingClientRect();
      if (box && box.width > 0 && box.height > 0) {
        const pad = 8;
        ring.hidden = false;
        ring.style.left = `${box.left - pad}px`;
        ring.style.top = `${box.top - pad}px`;
        ring.style.width = `${box.width + pad * 2}px`;
        ring.style.height = `${box.height + pad * 2}px`;
        // Below the ring, unless the ring is low enough that below is off the
        // screen — in which case above it, where there is room.
        const below = box.bottom + 16;
        card.classList.toggle("tour-card-above", below > window.innerHeight * 0.68);
        card.style.top = card.classList.contains("tour-card-above")
          ? `${Math.max(12, box.top - 16)}px`
          : `${below}px`;
      } else {
        ring.hidden = true;
        card.classList.remove("tour-card-above");
        card.style.top = "";
      }
      this.tourFrame = requestAnimationFrame(place);
    };
    place();
  }

  /** Take the tour's overlay away. */
  hideTourCue(): void {
    if (this.tourFrame !== null) cancelAnimationFrame(this.tourFrame);
    this.tourFrame = null;
    this.tourEl?.remove();
    this.tourEl = null;
  }

  showRestore(view: RestoreView): void {
    this.hideAll();
    this.revealScreen(this.restoreEl);
    this.restoreEl.innerHTML = `
      <div class="career-head">
        <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
        <button class="select-back" id="btn-restore-back" type="button" data-menu-back>← ${t("nav.back")}</button>
      </div>
      <div class="career-title-wrap">
        <h2 class="career-title"></h2>
      </div>
      <div class="career-list">
        <div class="account-card">
          <p class="account-why"></p>
          <label class="account-field"><span></span><input id="restore-code" type="text" inputmode="latin" maxlength="19" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" autocapitalize="characters"></label>
          <p class="account-message hidden"></p>
          <button class="big-btn" id="btn-restore" type="button" data-menu-primary="true"></button>
        </div>
      </div>`;
    const back = this.restoreEl.querySelector<HTMLButtonElement>("#btn-restore-back")!;
    back.onclick = () => {
      this.collapseScreen(this.restoreEl, back, () => view.onBack());
    };
    this.restoreEl.querySelector<HTMLHeadingElement>(".career-title")!.textContent =
      t("recovery.restoreTitle");
    this.restoreEl.querySelector<HTMLParagraphElement>(".account-why")!.textContent =
      t("recovery.restoreWhy");
    const labels = this.restoreEl.querySelectorAll(".account-field span");
    labels[0].textContent = t("recovery.code");
    const codeEl = this.restoreEl.querySelector<HTMLInputElement>("#restore-code")!;
    const message = this.restoreEl.querySelector<HTMLParagraphElement>(".account-message")!;
    message.textContent = view.message ?? "";
    message.classList.toggle("hidden", !view.message);
    const go = this.restoreEl.querySelector<HTMLButtonElement>("#btn-restore")!;
    go.textContent = view.busy ? t("profile.creating") : t("recovery.go");
    go.disabled = view.busy;
    const submit = () => {
      this.setOriginFromElement(go);
      view.onRestore(codeEl.value);
    };
    go.onclick = submit;
    // Upper-cased and hyphenated as it is typed. The code is written down in
    // one shape and should be typed back in that shape, rather than the player
    // having to reproduce punctuation from memory and be told they got it
    // wrong — `tidyCode` is the same normalisation the server applies, so what
    // the field shows is exactly what will be sent.
    codeEl.oninput = () => formatCodeField(codeEl);
    codeEl.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
  }

  /** The friends list. */
  showFriends(view: FriendsView): void {
    this.hideAll();
    this.revealScreen(this.friendsEl);
    this.showWallet();
    this.friendsEl.innerHTML = `
      <div class="career-head">
        <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
        <button class="select-back" id="btn-friends-back" type="button" data-menu-back>← ${t("nav.back")}</button>
      </div>
      <div class="career-title-wrap">
        <h2 class="career-title"></h2>
        <p class="career-sub"></p>
      </div>
      <div class="friend-add">
        <input id="friend-code" type="text" maxlength="8" autocomplete="off" spellcheck="false" autocapitalize="characters">
        <button class="champion-buy" id="btn-friend-add" type="button"></button>
      </div>
      <p class="account-message hidden"></p>
      <div class="career-list friend-list"></div>`;
    const back = this.friendsEl.querySelector<HTMLButtonElement>("#btn-friends-back")!;
    back.onclick = () => {
      this.collapseScreen(this.friendsEl, back, () => view.onBack());
    };
    this.friendsEl.querySelector<HTMLHeadingElement>(".career-title")!.textContent =
      t("friends.title");
    this.friendsEl.querySelector<HTMLParagraphElement>(".career-sub")!.textContent = tf(
      "friends.yourCode",
      { code: view.myCode }
    );

    const input = this.friendsEl.querySelector<HTMLInputElement>("#friend-code")!;
    input.placeholder = t("friends.addHint");
    const add = this.friendsEl.querySelector<HTMLButtonElement>("#btn-friend-add")!;
    add.textContent = t("friends.add");
    add.disabled = view.busy;
    const submit = () => view.onAdd(input.value);
    add.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };

    const message = this.friendsEl.querySelector<HTMLParagraphElement>(".account-message")!;
    message.textContent = view.message ?? "";
    message.classList.toggle("hidden", !view.message);

    const list = this.friendsEl.querySelector<HTMLDivElement>(".friend-list")!;
    if (view.rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "board-empty";
      empty.textContent = t("friends.none");
      list.appendChild(empty);
      return;
    }
    for (const row of view.rows) {
      const card = document.createElement("div");
      card.className = row.online ? "friend-row online" : "friend-row";
      card.dataset.friend = row.id;
      card.innerHTML = `
        <span class="friend-dot" aria-hidden="true"></span>
        <div class="friend-who">
          <span class="friend-name"></span>
          <span class="friend-seen"></span>
        </div>
        <b class="friend-trophies"></b>
        <button class="friend-remove" type="button" aria-label=""></button>`;
      card.querySelector<HTMLSpanElement>(".friend-name")!.textContent = row.name;
      card.querySelector<HTMLSpanElement>(".friend-seen")!.textContent = row.online
        ? t("friends.online")
        : row.seen;
      card.querySelector<HTMLElement>(".friend-trophies")!.textContent = String(row.trophies);
      const remove = card.querySelector<HTMLButtonElement>(".friend-remove")!;
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${t("friends.remove")} ${row.name}`);
      remove.disabled = view.busy;
      remove.onclick = () => view.onRemove(row.id);
      list.appendChild(card);
    }
  }

  /**
   * The club: ten people and a board.
   *
   * Two states on one screen, the same as the account screen. Before joining
   * one it is two fields — start a club, or join one with a code — because
   * those are the only two things anybody arrives here to do. After joining it
   * is the board, and the board is the point.
   */
  showClub(view: ClubView): void {
    this.hideAll();
    this.revealScreen(this.clubEl);
    this.showWallet();
    this.clubEl.innerHTML = `
      <div class="career-head">
        <div class="menu-brand"><img src="/figma/icon.png" alt="" class="menu-brand-icon" /><span>TeqRallly</span></div>
        <button class="select-back" id="btn-club-back" type="button" data-menu-back>← ${t("nav.back")}</button>
      </div>
      <div class="career-title-wrap">
        <h2 class="career-title"></h2>
        <p class="career-sub"></p>
      </div>
      <p class="account-message hidden"></p>
      <div class="career-list club-body"></div>`;
    const back = this.clubEl.querySelector<HTMLButtonElement>("#btn-club-back")!;
    back.onclick = () => {
      this.collapseScreen(this.clubEl, back, () => view.onBack());
    };

    const message = this.clubEl.querySelector<HTMLParagraphElement>(".account-message")!;
    message.textContent = view.message ?? "";
    message.classList.toggle("hidden", !view.message);

    const title = this.clubEl.querySelector<HTMLHeadingElement>(".career-title")!;
    const sub = this.clubEl.querySelector<HTMLParagraphElement>(".career-sub")!;
    const body = this.clubEl.querySelector<HTMLDivElement>(".club-body")!;

    if (!view.club) {
      title.textContent = t("club.title");
      sub.textContent = t("club.pitch");
      body.innerHTML = `
        <div class="account-card club-start">
          <h3 class="account-pitch"></h3>
          <label class="account-field"><span></span><input id="club-name" type="text" maxlength="20" autocomplete="off" spellcheck="false"></label>
          <button class="big-btn" id="btn-club-create" type="button" data-menu-primary="true"></button>
        </div>
        <div class="account-card club-join">
          <h3 class="account-pitch"></h3>
          <label class="account-field"><span></span><input id="club-code" type="text" maxlength="7" autocomplete="off" spellcheck="false" autocapitalize="characters"></label>
          <button class="big-btn alt" id="btn-club-join" type="button"></button>
        </div>`;
      const start = body.querySelector<HTMLDivElement>(".club-start")!;
      start.querySelector<HTMLHeadingElement>(".account-pitch")!.textContent = t("club.startTitle");
      start.querySelector<HTMLSpanElement>("span")!.textContent = t("club.name");
      const nameInput = start.querySelector<HTMLInputElement>("#club-name")!;
      const create = start.querySelector<HTMLButtonElement>("#btn-club-create")!;
      create.textContent = t("club.create");
      create.disabled = view.busy;
      create.onclick = () => view.onCreate(nameInput.value);
      nameInput.onkeydown = (e) => {
        if (e.key === "Enter") view.onCreate(nameInput.value);
      };

      const join = body.querySelector<HTMLDivElement>(".club-join")!;
      join.querySelector<HTMLHeadingElement>(".account-pitch")!.textContent = t("club.joinTitle");
      join.querySelector<HTMLSpanElement>("span")!.textContent = t("club.code");
      const codeInput = join.querySelector<HTMLInputElement>("#club-code")!;
      codeInput.placeholder = t("club.codeHint");
      const joinBtn = join.querySelector<HTMLButtonElement>("#btn-club-join")!;
      joinBtn.textContent = t("club.join");
      joinBtn.disabled = view.busy;
      joinBtn.onclick = () => view.onJoin(codeInput.value);
      codeInput.onkeydown = (e) => {
        if (e.key === "Enter") view.onJoin(codeInput.value);
      };
      return;
    }

    const club = view.club;
    title.textContent = club.name;
    sub.textContent = tf("club.sub", {
      n: club.members.length,
      max: MAX_CLUB_MEMBERS,
      online: club.online,
    });

    // The owner's invite code first: it is the thing they came here to read
    // out to somebody. A member sees the total instead, which is the thing
    // they came here to look at.
    const head = document.createElement("div");
    head.className = "account-card club-head";
    head.innerHTML = `
      <div class="club-total"><span></span><b></b></div>
      <div class="club-invite hidden">
        <span class="account-code-label"></span>
        <b class="account-code-value"></b>
        <span class="account-code-hint"></span>
      </div>`;
    head.querySelector<HTMLSpanElement>(".club-total span")!.textContent = t("club.total");
    head.querySelector<HTMLElement>(".club-total b")!.textContent = String(club.trophies);
    if (club.invite) {
      const invite = head.querySelector<HTMLDivElement>(".club-invite")!;
      invite.classList.remove("hidden");
      invite.querySelector<HTMLSpanElement>(".account-code-label")!.textContent = t("club.invite");
      invite.querySelector<HTMLElement>(".account-code-value")!.textContent = club.invite;
      invite.querySelector<HTMLSpanElement>(".account-code-hint")!.textContent = club.full
        ? t("club.fullHint")
        : t("club.inviteHint");
    }
    body.appendChild(head);

    const list = document.createElement("div");
    list.className = "club-list";
    for (const row of club.members) {
      const card = document.createElement("div");
      card.className = `club-row${row.online ? " online" : ""}${row.isMe ? " me" : ""}`;
      card.innerHTML = `
        <span class="friend-dot" aria-hidden="true"></span>
        <div class="friend-who">
          <span class="friend-name"></span>
          <span class="friend-seen"></span>
        </div>
        <b class="friend-trophies"></b>`;
      const name = card.querySelector<HTMLSpanElement>(".friend-name")!;
      name.textContent = row.name;
      if (row.owner) {
        const crown = document.createElement("i");
        crown.className = "club-owner";
        crown.textContent = t("club.owner");
        name.appendChild(crown);
      }
      card.querySelector<HTMLSpanElement>(".friend-seen")!.textContent = row.online
        ? t("friends.online")
        : row.seen;
      card.querySelector<HTMLElement>(".friend-trophies")!.textContent = String(row.trophies);
      // Only the owner can put somebody out, and never themselves — leaving is
      // what that is for, and it is its own button below.
      if (club.isOwner && !row.isMe) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "friend-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `${t("club.remove")} ${row.name}`);
        remove.disabled = view.busy;
        remove.onclick = () => view.onRemove(row.id);
        card.appendChild(remove);
      }
      list.appendChild(card);
    }
    body.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "account-card club-actions";
    if (club.isOwner) {
      actions.innerHTML = `
        <label class="account-field"><span></span><input id="club-rename" type="text" maxlength="20" autocomplete="off" spellcheck="false"></label>
        <button class="ghost-btn" id="btn-club-rename" type="button"></button>
        <button class="ghost-btn" id="btn-club-newcode" type="button"></button>`;
      actions.querySelector<HTMLSpanElement>("span")!.textContent = t("club.name");
      const renameInput = actions.querySelector<HTMLInputElement>("#club-rename")!;
      renameInput.value = club.name;
      const rename = actions.querySelector<HTMLButtonElement>("#btn-club-rename")!;
      rename.textContent = t("club.rename");
      rename.disabled = view.busy;
      rename.onclick = () => view.onRename(renameInput.value);
      const newCode = actions.querySelector<HTMLButtonElement>("#btn-club-newcode")!;
      newCode.textContent = t("club.newCode");
      newCode.disabled = view.busy;
      newCode.onclick = () => view.onNewInvite();
    }
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "ghost-btn danger";
    leave.id = "btn-club-leave";
    // The last member out closes the club, and is told so before they press it
    // rather than after.
    leave.textContent = club.members.length === 1 ? t("club.disband") : t("club.leave");
    leave.disabled = view.busy;
    leave.onclick = () => view.onLeave();
    actions.appendChild(leave);
    body.appendChild(actions);
  }

  private selTab: SelectTab = "character";
  private selIdx: Record<SelectTab, number> = { character: 0, ball: 0, venue: 0 };
  private browseSeq = 0;

  showSelect(opts: SelectOptions): void {
    this.hideAll();
    this.showSceneBehind();
    this.revealScreen(this.selectEl);
    this.selectEl.querySelector<HTMLHeadingElement>(".select-title")!.textContent =
      opts.title ?? t("select.title");
    const modeLabelEl = this.selectEl.querySelector<HTMLSpanElement>("#select-mode-label");
    if (modeLabelEl) {
      modeLabelEl.textContent = opts.modeLabel ?? opts.subtitle ?? "";
    }
    const tabLabels: Record<string, string> = {
      character: t("select.player"),
      ball: t("select.ball"),
      venue: t("select.venue"),
    };
    for (const tab of this.selectEl.querySelectorAll<HTMLButtonElement>(".tab-btn")) {
      tab.textContent = tabLabels[tab.dataset.tab ?? "character"] ?? "";
    }
    this.selectEl.querySelector<HTMLButtonElement>("#btn-start")!.textContent = t("select.play");
    this.selectEl.querySelector<HTMLDivElement>("#item-status")!.textContent = t("select.loading");

    const nameEl = this.selectEl.querySelector<HTMLDivElement>("#item-name")!;
    const statusEl = this.selectEl.querySelector<HTMLDivElement>("#item-status")!;
    const tabs = this.selectEl.querySelectorAll<HTMLButtonElement>(".tab-btn");
    const profileEl = this.selectEl.querySelector<HTMLElement>("#player-profile")!;
    const profileSynergiesEl = profileEl.querySelector<HTMLDivElement>("#profile-synergies")!;
    const profileStatsEl = profileEl.querySelector<HTMLDivElement>(".profile-stats")!;
    const profileTraitsEl = profileEl.querySelector<HTMLDivElement>(".profile-traits")!;
    // The chip strip is gone: venues have their own tab now, previewed at full
    // size in the real scene rather than named on a chip. The element stays in
    // the markup, empty, so nothing that references it has to be chased down.
    const venueStrip = this.selectEl.querySelector<HTMLDivElement>("#venue-strip")!;
    venueStrip.replaceChildren();
    venueStrip.classList.add("hidden");

    const back = this.selectEl.querySelector<HTMLButtonElement>("#btn-select-back")!;
    back.hidden = !opts.onBack;
    back.onclick = opts.onBack
      ? () => {
          this.collapseScreen(this.selectEl, back, () => opts.onBack?.());
        }
      : null;
    this.selTab = "character";
    // Start the venue tab on the venue actually built behind this screen. Left
    // at zero it would point at the first entry in the list — which is the
    // premium one — so PLAY would offer to sell the sports hall to every player
    // who never opened the tab, and commit them to it if they pressed it.
    const startVenue = (opts.venues ?? []).findIndex((v) => v.id === opts.venue);
    this.selIdx.venue = startVenue >= 0 ? startVenue : 0;
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === this.selTab));
    const items = (): SelectItem[] =>
      this.selTab === "character"
        ? opts.characters
        : this.selTab === "ball"
          ? opts.balls
          : (opts.venues ?? []);

    const footLabel = (foot: CharacterDef["strongFoot"]): string =>
      foot === "both" ? t("select.twoFooted") : foot === "left" ? t("select.left") : t("select.right");
    const renderProfile = (player: CharacterDef | null, base: CharacterDef | null = null): void => {
      if (!player) {
        profileEl.classList.add("hidden");
        return;
      }
      profileEl.classList.remove("hidden");
      profileSynergiesEl.replaceChildren();

      const charId = opts.characters[this.selIdx.character]?.id;
      const ballId = opts.balls[this.selIdx.ball]?.id;
      const venueId = opts.venues?.[this.selIdx.venue]?.id ?? opts.venue ?? "football";

      if (charId && ballId && opts.hasBallAffinity?.(charId, ballId)) {
        const tag = document.createElement("span");
        tag.className = "synergy-tag ball";
        tag.textContent = "★ FAVORITE BALL (+20% Synergy)";
        profileSynergiesEl.appendChild(tag);
      }
      if (charId && venueId && opts.hasVenueAffinity?.(charId, venueId)) {
        const tag = document.createElement("span");
        tag.className = "synergy-tag venue";
        tag.textContent = "🏟 HOME COURT (+20% Synergy)";
        profileSynergiesEl.appendChild(tag);
      }

      profileStatsEl.replaceChildren();
      const stats = RATING_KEYS.map((key) => {
        const score = rating(player, key);
        // The delta is against the same player without the ball, so a bar that
        // has not moved says nothing at all rather than saying zero.
        const shift = base ? score - rating(base, key) : 0;
        return {
          label: t(`select.abilities.${key}`),
          value: String(score),
          shift,
          fill: score / 100,
          detail: RATING_DETAIL[key],
        };
      });
      for (const stat of stats) {
        const row = document.createElement("div");
        row.className = "profile-stat";
        row.title = stat.detail;
        const label = document.createElement("span");
        label.className = "profile-stat-label";
        label.textContent = stat.label;
        const meter = document.createElement("span");
        meter.className = "profile-meter";
        const fill = document.createElement("i");
        fill.style.width = `${Math.round(stat.fill * 100)}%`;
        meter.appendChild(fill);
        const value = document.createElement("strong");
        value.textContent = stat.value;
        row.append(label, meter, value);
        if (stat.shift !== 0) {
          const shift = document.createElement("em");
          shift.className = `profile-shift ${stat.shift > 0 ? "up" : "down"}`;
          shift.textContent = `${stat.shift > 0 ? "+" : ""}${stat.shift}`;
          row.appendChild(shift);
        }
        profileStatsEl.appendChild(row);
      }
      profileTraitsEl.replaceChildren();
      const traits = [
        [t("select.strongFoot"), footLabel(player.strongFoot)],
        [t("select.height"), `${player.height.toFixed(2)} m`],
      ];
      for (const [labelText, valueText] of traits) {
        const trait = document.createElement("span");
        trait.textContent = `${labelText} · `;
        const val = document.createElement("b");
        val.textContent = valueText;
        trait.appendChild(val);
        profileTraitsEl.appendChild(trait);
      }
    };

    const venueCard = this.selectEl.querySelector<HTMLImageElement>("#venue-card")!;
    const lockEl = this.selectEl.querySelector<HTMLDivElement>("#item-lock")!;
    const unlockItemBtn = this.selectEl.querySelector<HTMLButtonElement>("#btn-unlock-item")!;
    const startBtn = this.selectEl.querySelector<HTMLButtonElement>("#btn-start")!;
    const lockNote = (id: string): string | undefined => opts.locked?.[id];

    const browse = () => {
      const item = items()[this.selIdx[this.selTab]];
      nameEl.textContent = item.label;
      // Venues are a photograph rather than the arena itself. Building a 4.8 MB
      // model to answer "do I fancy playing there" is a lot of download for a
      // decision made in two seconds, and the picture shows more of the place
      // than the play camera ever does.
      venueCard.classList.toggle("hidden", this.selTab !== "venue");
      if (this.selTab === "venue") {
        // Browsing is a keypress away from the next card, so a decrypt that
        // finishes after the player has moved on must not overwrite the one
        // they are looking at now. `assetUrl` caches, so coming back to a card
        // already seen resolves without a second fetch.
        const wanted = item.id;
        void assetUrl(`/venues/${wanted}.jpg`).then((url) => {
          if (this.selTab === "venue" && items()[this.selIdx[this.selTab]]?.id === wanted) {
            venueCard.src = url;
          }
        });
      }
      if (this.selTab === "ball" && opts.withBall) {
        const pair = opts.withBall(opts.characters[this.selIdx.character].id, item.id);
        renderProfile(pair.withBall, pair.base);
      } else {
        renderProfile(this.selTab === "character" ? opts.characters[this.selIdx.character] : null);
      }
      // What is browsed decides how the stage reads; what is *chosen* decides
      // whether PLAY works. They differ whenever somebody is looking at a
      // locked player on the character tab with a playable one still selected
      // on the other, and treating them as one thing disables the button under
      // a perfectly legal line-up.
      const browsedLock = lockNote(item.id);
      lockEl.textContent = browsedLock ?? "";
      lockEl.classList.toggle("hidden", browsedLock === undefined);
      this.selectEl.classList.toggle("browsing-locked", browsedLock !== undefined);

      if (browsedLock !== undefined) {
        const priceStr =
          opts.prices?.[item.id] ?? (item.id === "gym" ? "$4.99" : item.id === "basketball" ? "$2.99" : "$0.99");
        unlockItemBtn.textContent = `UNLOCK · ${priceStr}`;
        unlockItemBtn.classList.remove("hidden");
        unlockItemBtn.onclick = async () => {
          unlockItemBtn.disabled = true;
          try {
            const ok = await opts.onUnlockAsset?.(item.id, this.selTab);
            if (ok) {
              delete opts.locked?.[item.id];
              browse();
            }
          } finally {
            unlockItemBtn.disabled = false;
          }
        };
      } else {
        unlockItemBtn.classList.add("hidden");
      }

      // A locked *venue* is different from a locked player or ball: it is the
      // thing that is for sale, and it is being previewed at full size right
      // now. So PLAY turns into the offer rather than going grey — the screen
      // that shows what you cannot have is the screen that should sell it.
      const venue = opts.venues?.[this.selIdx.venue];
      const venueLock = venue ? lockNote(venue.id) : undefined;
      const chosenLock =
        lockNote(opts.characters[this.selIdx.character].id) ??
        lockNote(opts.balls[this.selIdx.ball].id);
      startBtn.disabled = chosenLock !== undefined;
      startBtn.textContent = venueLock && !chosenLock ? t("select.unlock") : t("select.play");
      startBtn.classList.toggle("selling", Boolean(venueLock) && !chosenLock);
      const seq = ++this.browseSeq;
      statusEl.classList.remove("hidden");
      void Promise.resolve(opts.onBrowse(this.selTab, item.id)).then(() => {
        if (seq === this.browseSeq) statusEl.classList.add("hidden");
      });
    };

    const step = (dir: number) => {
      const n = items().length;
      this.selIdx[this.selTab] = (this.selIdx[this.selTab] + dir + n) % n;
      browse();
    };

    this.selectEl.querySelector<HTMLButtonElement>("#btn-prev")!.onclick = () => step(-1);
    this.selectEl.querySelector<HTMLButtonElement>("#btn-next")!.onclick = () => step(1);
    tabs.forEach((tab) => {
      tab.onclick = () => {
        this.selTab = tab.dataset.tab as ViewerKind;
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        browse();
      };
    });
    startBtn.onclick = async () => {
      if (startBtn.disabled) return;
      this.setOriginFromElement(startBtn);
      const venue = opts.venues?.[this.selIdx.venue];
      if (venue) {
        // Commits the venue, and pays for it first when it needs paying for.
        // Answering false means the player backed out of the store, which is a
        // decision — the screen simply stays where it is and says nothing.
        startBtn.disabled = true;
        const kept = (await opts.onVenue?.(venue.id)) ?? true;
        startBtn.disabled = false;
        if (!kept) return;
        // "Kept" with the lock still listed means a purchase just went
        // through — unless this venue was already the one built behind the
        // screen, where there was nothing to buy and the press meant PLAY.
        // That case is real: a pro player whose entitlement has not resolved
        // yet still has their remembered premium venue on stage, and eating
        // their first press made PLAY look broken.
        if (lockNote(venue.id) && venue.id !== opts.venue) {
          // Just bought: redraw so PLAY stops offering what they now own.
          delete opts.locked?.[venue.id];
          browse();
          return;
        }
      }
      opts.onConfirm(opts.characters[this.selIdx.character].id, opts.balls[this.selIdx.ball].id);
    };
    browse();
  }

  showHUD(): void {
    this.hideAll();
    this.showSceneBehind();
    this.hudEl.classList.remove("hidden");
  }

  /**
   * Show or hide the scoreboard.
   *
   * Off for practice, which has no score to keep. It is hidden rather than
   * zeroed because a scoreboard reading 0–0 for a whole lesson invites the
   * player to wonder when it is going to start counting.
   */
  setScoreVisible(on: boolean): void {
    this.scoreEl.classList.toggle("hidden", !on);
  }

  practicePanel(state: PracticePanelState | null): void {
    if (!state) {
      this.practiceEl.classList.add("hidden");
      return;
    }

    this.practiceEl.innerHTML = `
      <div class="practice-header">
        <div class="practice-title">${state.title}</div>
        ${state.onSkip ? `<button class="practice-skip-btn" id="btn-practice-skip" type="button">${state.skip ?? "SKIP"}</button>` : ""}
      </div>
      <div class="practice-goal">${state.goal}</div>
      ${state.control ? `<div class="practice-control">${state.control}</div>` : ""}`;
    if (state.onSkip) {
      const skipBtn = this.practiceEl.querySelector<HTMLButtonElement>("#btn-practice-skip");
      if (skipBtn) skipBtn.onclick = () => state.onSkip?.();
    }
    this.practiceEl.classList.remove("hidden");
  }

  setScore(player: number, ai: number, server: Side, setsPlayer = 0, setsAi = 0): void {
    const pServe = server === "player" ? "●" : "";
    const aServe = server === "ai" ? "●" : "";
    const sets = `<span class="sets">(${setsPlayer})</span>`;
    const sets2 = `<span class="sets">(${setsAi})</span>`;
    this.scoreEl.innerHTML =
      `<span class="serve">${pServe}</span> ${this.labels[0]} ${sets} <b>${player}</b>` +
      ` : <b>${ai}</b> ${sets2} ${this.labels[1]} <span class="serve">${aServe}</span>`;
  }

  banner(text: string, sub?: string): void {
    this.bannerEl.innerHTML = `<div>${text}</div>${sub ? `<div class="banner-sub">${sub}</div>` : ""}`;
    this.bannerEl.classList.remove("hidden");
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.add("hidden"), 2000);
  }

  /** Venue and line-up card, shown over the pre-match establishing shot. */
  /**
   * The card before the whistle.
   *
   * With both characters known it is a head-to-head rather than a title: the
   * same three traits down the middle, each side's number beside it, and an
   * arrow on whoever leads. It is the one moment a player is looking at both
   * players at once, which makes it the only place the comparison is free —
   * and the place where learning that their opponent is quicker is worth
   * something, because they are about to play them.
   */
  showIntro(venue: string, home: string, away: string, matchUp?: [CharacterDef, CharacterDef]): void {
    this.introEl.innerHTML = `
      <div class="intro-venue"></div>
      <div class="intro-vs"><span></span><em>VS</em><span></span></div>
      <div class="intro-compare"></div>
      <div class="intro-skip">TAP TO SKIP</div>`;
    const [venueEl] = this.introEl.getElementsByClassName("intro-venue");
    venueEl.textContent = venue;
    const names = this.introEl.querySelectorAll(".intro-vs span");
    names[0].textContent = home;
    names[1].textContent = away;

    const compare = this.introEl.querySelector<HTMLDivElement>(".intro-compare")!;
    if (matchUp) {
      const [mine, theirs] = matchUp;
      const total = document.createElement("div");
      total.className = "compare-row total";
      total.innerHTML = `<b></b><span></span><b></b>`;
      const totals = total.querySelectorAll("b");
      totals[0].textContent = String(totalPower(mine));
      totals[1].textContent = String(totalPower(theirs));
      total.querySelector<HTMLSpanElement>("span")!.textContent = t("career.power");
      compare.appendChild(total);
      for (const key of RATING_KEYS) {
        const a = rating(mine, key);
        const b = rating(theirs, key);
        const line = document.createElement("div");
        line.className = "compare-row";
        line.innerHTML = `<b></b><i class="compare-lead left"></i><span></span><i class="compare-lead right"></i><b></b>`;
        const values = line.querySelectorAll("b");
        values[0].textContent = String(a);
        values[1].textContent = String(b);
        line.querySelector<HTMLSpanElement>("span")!.textContent = t(`select.abilities.${key}`);
        line.querySelector<HTMLElement>(".compare-lead.left")!.classList.toggle("on", a > b);
        line.querySelector<HTMLElement>(".compare-lead.right")!.classList.toggle("on", b > a);
        compare.appendChild(line);
      }
    } else {
      compare.classList.add("hidden");
    }
    this.introEl.classList.remove("hidden");
  }

  hideIntro(): void {
    this.introEl.classList.add("hidden");
  }

  hint(text: string | null): void {
    if (text) {
      this.hintEl.textContent = text;
      this.hintEl.classList.remove("hidden");
    } else {
      this.hintEl.classList.add("hidden");
    }
  }

  /**
   * Power bar: fill fraction in [0, 1] (null hides the bar) and the safe-power
   * band bounds as fractions of the bar width.
   */
  meter(frac: number | null, sweetStart: number, sweetEnd: number): void {
    if (frac === null) {
      this.meterEl.classList.add("hidden");
      return;
    }
    this.meterEl.classList.remove("hidden");
    const fill = this.meterEl.querySelector<HTMLDivElement>("#meter-fill")!;
    const sweet = this.meterEl.querySelector<HTMLDivElement>("#meter-sweet")!;
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    fill.classList.toggle("in-sweet", frac >= sweetStart && frac <= sweetEnd);
    sweet.style.left = `${(sweetStart * 100).toFixed(1)}%`;
    sweet.style.width = `${(Math.max(0, sweetEnd - sweetStart) * 100).toFixed(1)}%`;
  }

  /** Flash the graded timing of the strike press that was just committed. */
  meterResult(quality: number): void {
    const label = quality >= 0.8 ? "PERFECT!" : quality >= 0.5 ? "GOOD" : "OFF";
    this.meterFlashEl.textContent = label;
    this.meterFlashEl.className = quality >= 0.8 ? "perfect" : quality >= 0.5 ? "good" : "poor";
    if (this.meterFlashTimer !== null) window.clearTimeout(this.meterFlashTimer);
    this.meterFlashTimer = window.setTimeout(() => this.meterFlashEl.classList.add("hidden"), 700);
  }

  showEnd(winner: Side, onRematch: () => void, onChange: () => void): void {
    // HUD stays visible behind the end overlay.
    this.endTitle.textContent = winner === "player" ? `${this.labels[0]} WINS! 🏆` : `${this.labels[1]} WINS`;
    this.endEl.classList.remove("hidden");
    this.endEl.querySelector<HTMLButtonElement>("#btn-rematch")!.textContent = t("end.rematch");
    this.endEl.querySelector<HTMLButtonElement>("#btn-change")!.textContent = t("end.change");
    this.endEl.querySelector<HTMLButtonElement>("#btn-rematch")!.onclick = () => {
      // The overlay stays: a declined or unanswered request returns here, and
      // a start that happens clears everything anyway.
      onRematch();
    };
    this.endEl.querySelector<HTMLButtonElement>("#btn-change")!.onclick = () => {
      this.endEl.classList.add("hidden");
      onChange();
    };
  }
}
