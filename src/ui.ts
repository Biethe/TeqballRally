import type { Side } from "./ball";
import type { CameraMode, CharacterDef } from "./config";
import type { ViewerKind } from "./viewer";

export type ReplayControl =
  | "toggle"
  | "skip"
  | "back"
  | "forward"
  | "zoom-in"
  | "zoom-out"
  | "reset-camera";

export interface SelectItem {
  id: string;
  label: string;
}

export interface SelectOptions {
  /** Character definitions carry the live abilities shown in the selector. */
  characters: CharacterDef[];
  balls: SelectItem[];
  /** Heading shown above the tabs (defaults to "CHOOSE YOUR SETUP"). */
  title?: string;
  /** Called whenever the browsed item changes; resolve when the model is visible. */
  onBrowse: (kind: ViewerKind, id: string) => Promise<unknown> | void;
  onConfirm: (characterId: string, ballId: string) => void;
  /** Return to the screen that led into the picker. */
  onBack?: () => void;
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
}

/** DOM-based menus and HUD (crisper than canvas UI and trivially responsive). */
export class UI {
  private root: HTMLElement;
  private loadingEl: HTMLDivElement;
  private loadingText: HTMLDivElement;
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
  /** First press on the development-server action only arms the confirmation. */
  private shutdownArmed = false;
  private menuEl: HTMLDivElement;
  private standingsEl: HTMLDivElement;
  private bannerTimer: number | null = null;
  private meterEl: HTMLDivElement;
  private meterFlashEl: HTMLDivElement;
  private meterFlashTimer: number | null = null;
  private practiceEl: HTMLDivElement;
  private trainingPauseEl: HTMLDivElement;
  private cameraBtn: HTMLButtonElement;
  private replayEl: HTMLDivElement;
  private replayControlsEl: HTMLDivElement;
  private replayToggleBtn: HTMLButtonElement;
  private replayTimelineLabel: HTMLSpanElement;
  private replayProgressEl: HTMLSpanElement;
  private replayBackBtn: HTMLButtonElement;
  private replayForwardBtn: HTMLButtonElement;
  private replayZoomLabel: HTMLSpanElement;
  private replayZoomOutBtn: HTMLButtonElement;
  private replayZoomInBtn: HTMLButtonElement;
  private replayResetCameraBtn: HTMLButtonElement;
  /** Score-line names, set per match ("YOU"/"CPU", "P1"/"P2", country labels…). */
  private labels: [string, string] = ["YOU", "CPU"];
  /** Set by the app; called when the HUD pause button is tapped. */
  onPauseRequest: (() => void) | null = null;
  /** Set by the app; called when the HUD camera button is tapped. */
  onCameraRequest: (() => void) | null = null;
  /** Set by the app; every replay button calls through this small command API. */
  onReplayControl: ((control: ReplayControl) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;

    this.loadingEl = this.screen("loading-screen");
    this.loadingEl.innerHTML = `<div class="logo">TeqOpen</div>`;
    this.loadingText = document.createElement("div");
    this.loadingText.className = "loading-text";
    this.loadingText.textContent = "Loading…";
    this.loadingEl.appendChild(this.loadingText);

    this.titleEl = this.screen("title-screen");
    this.titleEl.innerHTML = `
      <main class="title-content">
        <div class="brand-lockup">
          <span class="brand-orb" aria-hidden="true"></span>
          <div>
            <div class="brand-kicker">TABLE FOOTBALL</div>
            <div class="logo">TeqOpen</div>
          </div>
        </div>
        <p class="title-tagline">Fast rallies on the curved table.</p>
        <button class="big-btn" id="btn-play" data-menu-primary="true">PLAY</button>
      </main>`;

    // Select screen is a transparent overlay: the 3D model viewer renders behind it.
    this.selectEl = this.screen("select-screen");
    this.selectEl.classList.add("viewer-select");
    this.selectEl.innerHTML = `
      <div class="select-top">
        <div class="select-bar">
          <button class="select-back" id="btn-select-back" type="button" data-menu-back>← BACK</button>
          <div class="select-brand">TeqOpen</div>
        </div>
        <div class="select-title">CHOOSE YOUR SETUP</div>
        <div class="tabs">
          <button class="tab-btn active" data-tab="character">PLAYER</button>
          <button class="tab-btn" data-tab="ball">BALL</button>
        </div>
      </div>
      <div class="select-stage">
        <aside class="player-profile hidden" id="player-profile" aria-live="polite">
          <div class="profile-kicker">PLAYER ABILITIES · /100</div>
          <div class="profile-stats"></div>
          <div class="profile-traits"></div>
        </aside>
      </div>
      <div class="select-bottom">
        <div class="browse">
          <button class="arrow-btn" id="btn-prev">◀</button>
          <div class="item-label">
            <div id="item-name">…</div>
            <div id="item-status" class="hidden">Loading…</div>
          </div>
          <button class="arrow-btn" id="btn-next">▶</button>
        </div>
        <div class="viewer-hint">drag to rotate · scroll to zoom</div>
        <button class="big-btn" id="btn-start">PLAY</button>
      </div>`;

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
    this.replayEl = document.createElement("div");
    this.replayEl.id = "replay-indicator";
    this.replayEl.classList.add("hidden");
    this.replayEl.setAttribute("role", "status");
    this.replayEl.setAttribute("aria-live", "polite");
    this.replayControlsEl = document.createElement("div");
    this.replayControlsEl.id = "replay-controls";
    this.replayControlsEl.classList.add("hidden");
    this.replayControlsEl.setAttribute("role", "group");
    this.replayControlsEl.setAttribute("aria-label", "Replay controls");
    const replayAction = (id: string, text: string, control: ReplayControl, label: string) => {
      const b = document.createElement("button");
      b.id = id;
      b.type = "button";
      b.textContent = text;
      b.setAttribute("aria-label", label);
      b.title = label;
      b.onclick = () => this.onReplayControl?.(control);
      return b;
    };
    this.replayToggleBtn = replayAction(
      "replay-toggle-btn",
      "❚❚ PAUSE",
      "toggle",
      "Pause replay — Space, P, or controller Start / Options"
    );
    const skip = replayAction(
      "replay-skip-btn",
      "SKIP",
      "skip",
      "Skip replay — X, controller B / Circle, or Share / View"
    );
    this.replayBackBtn = replayAction(
      "replay-back-btn",
      "↶ 0.75S",
      "back",
      "Scrub replay backward 0.75 seconds — Left Arrow, J, or controller D-pad Left"
    );
    this.replayForwardBtn = replayAction(
      "replay-forward-btn",
      "0.75S ↷",
      "forward",
      "Scrub replay forward 0.75 seconds — Right Arrow, L, or controller D-pad Right"
    );
    this.replayZoomOutBtn = replayAction(
      "replay-zoom-out-btn",
      "−",
      "zoom-out",
      "Zoom replay camera out — Minus or controller LB / L1"
    );
    this.replayZoomInBtn = replayAction(
      "replay-zoom-in-btn",
      "+",
      "zoom-in",
      "Zoom replay camera in — Plus or controller RB / R1"
    );
    this.replayResetCameraBtn = replayAction(
      "replay-reset-camera-btn",
      "RESET VIEW",
      "reset-camera",
      "Reset replay camera angle — C or controller Y / Triangle"
    );
    this.replayZoomLabel = document.createElement("span");
    this.replayZoomLabel.className = "replay-zoom-label";
    this.replayTimelineLabel = document.createElement("span");
    this.replayTimelineLabel.className = "replay-timeline-label";
    const replayTimeline = document.createElement("div");
    replayTimeline.className = "replay-timeline";
    replayTimeline.setAttribute("role", "progressbar");
    replayTimeline.setAttribute("aria-label", "Replay timeline");
    this.replayProgressEl = document.createElement("span");
    replayTimeline.appendChild(this.replayProgressEl);
    const replayHint = document.createElement("div");
    replayHint.className = "replay-control-hint";
    replayHint.textContent =
      "DRAG · WASD / LEFT STICK ORBIT   C · Y/△ RESET VIEW   SPACE/P · START PLAY/PAUSE   ←/→ · D-PAD SEEK   +/− · LB/RB ZOOM   X · B/○ SKIP";
    const replayScrub = document.createElement("div");
    replayScrub.className = "replay-scrub-controls";
    replayScrub.append(this.replayBackBtn, this.replayTimelineLabel, this.replayForwardBtn);
    const replayZoom = document.createElement("div");
    replayZoom.className = "replay-zoom-controls";
    replayZoom.append(this.replayZoomOutBtn, this.replayZoomLabel, this.replayZoomInBtn);
    this.replayControlsEl.append(
      this.replayToggleBtn,
      skip,
      replayScrub,
      replayZoom,
      this.replayResetCameraBtn,
      replayTimeline,
      replayHint
    );
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
      this.bannerEl,
      this.hintEl,
      this.introEl,
      this.replayEl,
      this.replayControlsEl,
      this.meterEl,
      this.meterFlashEl,
      this.practiceEl,
      cameraBtn,
      pauseBtn
    );

    this.pauseEl = this.screen("pause-screen");
    this.pauseEl.innerHTML = `
      <section class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <h1 id="pause-title">PAUSED</h1>
        <div class="pause-actions">
          <button class="pause-action pause-resume" id="btn-resume" data-menu-primary="true">
            <strong>RESUME</strong><kbd>ESC / START</kbd>
          </button>
          <button class="pause-action" id="btn-restart"><strong>RESTART MATCH</strong></button>
          <button class="pause-action" id="btn-change-player"><strong>EXIT TO MODES</strong></button>
          <button class="pause-action" id="btn-shutdown-server" hidden>
            <strong>SHUT DOWN LOCAL SERVER</strong>
          </button>
        </div>
      </section>`;

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
        <button class="training-resume" id="btn-training-resume" type="button"></button>
      </div>`;

    this.endEl = this.screen("end-screen");
    this.endTitle = document.createElement("div");
    this.endTitle.className = "logo small";
    const btns = document.createElement("div");
    btns.className = "end-btns";
    btns.innerHTML = `
      <button class="big-btn" id="btn-rematch">REMATCH</button>
      <button class="big-btn alt" id="btn-change">GAME MODES</button>`;
    this.endEl.append(this.endTitle, btns);

    // Generic list menu (game mode, difficulty, competition format).
    this.menuEl = this.screen("menu-screen");

    // Competition standings (cup bracket / league table) between matches.
    this.standingsEl = this.screen("standings-screen");

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
    for (const el of [
      this.loadingEl,
      this.titleEl,
      this.selectEl,
      this.hudEl,
      this.endEl,
      this.pauseEl,
      this.trainingPauseEl,
      this.menuEl,
      this.standingsEl,
    ]) {
      el.classList.add("hidden");
    }
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
    const isModeMenu = title === "GAME MODE";
    this.menuEl.classList.toggle("menu-mode-grid", isModeMenu);
    this.menuEl.innerHTML = `
      <main class="menu-shell">
        <header class="menu-header">
          <div class="menu-brand"><span class="menu-brand-orb"></span>TeqOpen</div>
          ${onBack ? '<button class="menu-back" id="btn-menu-back" type="button" data-menu-back>← BACK</button>' : ""}
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
      b.className = `menu-option${primary ? " is-primary" : ""}`;
      b.id = opt.id;
      b.setAttribute("role", "listitem");
      if (primary) b.dataset.menuPrimary = "true";
      const label = document.createElement("strong");
      label.textContent = opt.label;
      b.appendChild(label);
      if (opt.sub) {
        const sub = document.createElement("small");
        sub.textContent = opt.sub;
        b.appendChild(sub);
      }
      b.onclick = () => onPick(opt.id);
      box.appendChild(b);
    });
    const back = this.menuEl.querySelector<HTMLButtonElement>("#btn-menu-back");
    if (back) back.onclick = () => onBack?.();
    this.menuEl.classList.remove("hidden");
  }

  /** Competition interstitial: a titled block of result/table rows and one continue button. */
  showStandings(title: string, rows: string[], buttonLabel: string, onContinue: () => void): void {
    this.hideAll();
    this.standingsEl.innerHTML = `
      <div class="logo small">${title}</div>
      <div class="standings-rows">${rows.map((r) => `<div class="standings-row">${r}</div>`).join("")}</div>
      <button class="big-btn" id="btn-standings-continue">${buttonLabel}</button>`;
    this.standingsEl.querySelector<HTMLButtonElement>("#btn-standings-continue")!.onclick = () => onContinue();
    this.standingsEl.classList.remove("hidden");
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
   * Online pause overlay. Serves the whole negotiation — asking, being asked,
   * and paused — because they differ only in what they say and which buttons
   * make sense. `actions` is a list of [label, handler] pairs.
   */
  showOnlinePause(title: string, detail: string, actions: [string, () => void][]): void {
    this.pauseEl.innerHTML = `
      <div class="pause-card">
        <div class="logo small">${title}</div>
        <div class="standings-rows"><div class="standings-row" id="net-pause-detail"></div></div>
        <div class="pause-actions"></div>
      </div>`;
    this.pauseEl.querySelector<HTMLDivElement>("#net-pause-detail")!.textContent = detail;
    const box = this.pauseEl.querySelector<HTMLDivElement>(".pause-actions")!;
    actions.forEach(([label, fn], i) => {
      const b = document.createElement("button");
      b.className = `big-btn${i > 0 ? " alt" : ""}`;
      b.textContent = label;
      b.onclick = () => fn();
      box.appendChild(b);
    });
    this.pauseEl.classList.remove("hidden");
  }

  hideOnlinePause(): void {
    this.pauseEl.classList.add("hidden");
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
  showCodeEntry(
    title: string,
    placeholder: string,
    onSubmit: (code: string) => void,
    onBack: () => void
  ): void {
    this.hideAll();
    this.standingsEl.innerHTML = `
      <div class="logo small">${title}</div>
      <div class="standings-rows">
        <input class="code-input" id="lobby-code-input" inputmode="latin"
               autocapitalize="characters" autocomplete="off" spellcheck="false"
               maxlength="5" placeholder="${placeholder}" aria-label="Room code" />
      </div>
      <button class="big-btn" id="btn-code-go">JOIN</button>
      <button class="big-btn alt" id="btn-code-back" data-menu-back>BACK</button>`;

    const input = this.standingsEl.querySelector<HTMLInputElement>("#lobby-code-input")!;
    const go = this.standingsEl.querySelector<HTMLButtonElement>("#btn-code-go")!;
    const submit = () => {
      const code = input.value.trim();
      if (code.length > 0) onSubmit(code);
    };
    input.oninput = () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      go.disabled = input.value.length < 5;
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
    go.disabled = true;
    go.onclick = submit;
    this.standingsEl.querySelector<HTMLButtonElement>("#btn-code-back")!.onclick = () => onBack();
    this.standingsEl.classList.remove("hidden");
    // Phones only raise the keyboard for a focus inside the tap that caused it.
    setTimeout(() => input.focus(), 50);
  }

  /** Names shown in the score line and end screen ("YOU"/"CPU", "P1"/"P2", …). */
  setLabels(left: string, right: string): void {
    this.labels = [left, right];
  }

  /** Update the compact HUD label and its accessible camera shortcut hint. */
  setCameraMode(mode: CameraMode): void {
    const label = mode === "court" ? "COURT" : mode === "side" ? "SIDE" : "TOP";
    this.cameraBtn.textContent = `CAM · ${label}`;
    this.cameraBtn.dataset.short = label;
    this.cameraBtn.setAttribute("aria-label", `Camera view: ${label}. Switch with C or Y / Triangle.`);
    this.cameraBtn.title = `Camera: ${label} — press C or Y / Triangle to switch`;
  }

  /** Replay status plus touch-accessible transport and camera controls. */
  setReplay(
    active: boolean,
    label = "REPLAY",
    paused = false,
    zoom = 0,
    position = 0,
    duration = 0,
    segment = ""
  ): void {
    this.replayEl.textContent = paused ? `${label} · PAUSED` : label;
    this.replayEl.classList.toggle("hidden", !active);
    this.replayControlsEl.classList.toggle("hidden", !active);
    this.replayToggleBtn.textContent = paused ? "▶ PLAY" : "❚❚ PAUSE";
    this.replayToggleBtn.setAttribute(
      "aria-label",
      paused
        ? "Play replay — Space, P, or controller Start / Options"
        : "Pause replay — Space, P, or controller Start / Options"
    );
    this.replayToggleBtn.title = this.replayToggleBtn.getAttribute("aria-label") ?? "Toggle replay";
    const total = Math.max(0.01, duration);
    const clamped = Math.max(0, Math.min(total, position));
    const percent = (clamped / total) * 100;
    const stamp = `${clamped.toFixed(1)} / ${total.toFixed(1)}s`;
    this.replayTimelineLabel.textContent = segment ? `${segment} · ${stamp}` : stamp;
    this.replayProgressEl.style.width = `${percent.toFixed(1)}%`;
    const timeline = this.replayProgressEl.parentElement!;
    timeline.setAttribute("aria-valuemin", "0");
    timeline.setAttribute("aria-valuemax", total.toFixed(2));
    timeline.setAttribute("aria-valuenow", clamped.toFixed(2));
    timeline.setAttribute("aria-valuetext", segment ? `${segment}, ${stamp}` : stamp);
    this.replayBackBtn.disabled = clamped <= 0.01;
    this.replayForwardBtn.disabled = clamped >= total - 0.01;
    this.replayZoomLabel.textContent = `CAM ${(1 + zoom * 0.1).toFixed(1)}×`;
    this.replayZoomOutBtn.disabled = zoom <= -2;
    this.replayZoomInBtn.disabled = zoom >= 3;
  }

  /** Pause overlay on top of the HUD (which stays visible behind it). */
  showPause(
    onResume: () => void,
    onRestart: () => void,
    onChangePlayer: () => void,
    onShutdownServer?: () => void
  ): void {
    this.pauseEl.querySelector<HTMLButtonElement>("#btn-resume")!.onclick = () => onResume();
    this.pauseEl.querySelector<HTMLButtonElement>("#btn-restart")!.onclick = () => onRestart();
    this.pauseEl.querySelector<HTMLButtonElement>("#btn-change-player")!.onclick = () => onChangePlayer();
    const shutdown = this.pauseEl.querySelector<HTMLButtonElement>("#btn-shutdown-server")!;
    this.shutdownArmed = false;
    shutdown.hidden = !onShutdownServer;
    shutdown.disabled = false;
    shutdown.innerHTML = "<strong>SHUT DOWN LOCAL SERVER</strong>";
    shutdown.title = onShutdownServer
      ? "Stop this local development server — press once to confirm"
      : "Server shutdown is available only from the local development build";
    shutdown.onclick = () => {
      if (!onShutdownServer) return;
      if (!this.shutdownArmed) {
        this.shutdownArmed = true;
        shutdown.innerHTML = "<strong>PRESS AGAIN TO CONFIRM</strong>";
        shutdown.title = "Press again to stop the local development server";
        return;
      }
      shutdown.disabled = true;
      shutdown.innerHTML = "<strong>STOPPING SERVER…</strong>";
      onShutdownServer();
    };
    this.pauseEl.classList.remove("hidden");
  }

  hidePause(): void {
    this.shutdownArmed = false;
    this.pauseEl.classList.add("hidden");
  }

  /** Put a single coaching instruction over a frozen rally. */
  showTrainingPause(state: TrainingPauseState, onResume: () => void): void {
    this.trainingPauseEl.querySelector<HTMLDivElement>(".training-progress")!.textContent = state.progress;
    this.trainingPauseEl.querySelector<HTMLDivElement>(".training-title")!.textContent = state.title;
    this.trainingPauseEl.querySelector<HTMLDivElement>(".training-action-text")!.textContent = state.action;
    this.trainingPauseEl.querySelector<HTMLSpanElement>(".training-control-text")!.textContent = state.control;
    const resume = this.trainingPauseEl.querySelector<HTMLButtonElement>("#btn-training-resume")!;
    resume.textContent = state.resume ?? "CONTINUE";
    resume.disabled = false;
    resume.onclick = () => onResume();
    this.trainingPauseEl.classList.remove("hidden");
  }

  hideTrainingPause(): void {
    this.trainingPauseEl.classList.add("hidden");
  }

  showLoading(text = "Loading…"): void {
    this.hideAll();
    this.loadingText.textContent = text;
    this.loadingEl.classList.remove("hidden");
  }

  setLoadingText(text: string): void {
    this.loadingText.textContent = text;
  }

  showTitle(onPlay: () => void): void {
    this.hideAll();
    this.titleEl.classList.remove("hidden");
    const btn = this.titleEl.querySelector<HTMLButtonElement>("#btn-play")!;
    btn.onclick = () => onPlay();
  }

  private selTab: ViewerKind = "character";
  private selIdx: Record<ViewerKind, number> = { character: 0, ball: 0 };
  private browseSeq = 0;

  showSelect(opts: SelectOptions): void {
    this.hideAll();
    this.selectEl.classList.remove("hidden");
    this.selectEl.querySelector<HTMLDivElement>(".select-title")!.textContent =
      opts.title ?? "CHOOSE YOUR SETUP";

    const nameEl = this.selectEl.querySelector<HTMLDivElement>("#item-name")!;
    const statusEl = this.selectEl.querySelector<HTMLDivElement>("#item-status")!;
    const tabs = this.selectEl.querySelectorAll<HTMLButtonElement>(".tab-btn");
    const profileEl = this.selectEl.querySelector<HTMLElement>("#player-profile")!;
    const profileStatsEl = profileEl.querySelector<HTMLDivElement>(".profile-stats")!;
    const profileTraitsEl = profileEl.querySelector<HTMLDivElement>(".profile-traits")!;
    const back = this.selectEl.querySelector<HTMLButtonElement>("#btn-select-back")!;
    back.hidden = !opts.onBack;
    back.onclick = opts.onBack ? () => opts.onBack?.() : null;
    this.selTab = "character";
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === this.selTab));
    const items = (): SelectItem[] => (this.selTab === "character" ? opts.characters : opts.balls);

    const abilityScore = (value: number, get: (player: CharacterDef) => number): number => {
      const values = opts.characters.map(get);
      const min = Math.min(...values);
      const max = Math.max(...values);
      // Ratings deliberately use the full, familiar 100-point scale while
      // still tracking the live balance values in config.ts.
      return max === min ? 100 : Math.round(60 + ((value - min) / (max - min)) * 40);
    };
    const footLabel = (foot: CharacterDef["strongFoot"]): string =>
      foot === "both" ? "TWO-FOOTED" : foot.toUpperCase();
    const renderProfile = (player: CharacterDef | null): void => {
      if (!player) {
        profileEl.classList.add("hidden");
        return;
      }
      profileEl.classList.remove("hidden");
      profileStatsEl.replaceChildren();
      const stats: Array<{ label: string; value: string; fill: number; detail: string }> = [
        {
          label: "REACTIVITY",
          value: String(abilityScore(player.speed, (p) => p.speed)),
          fill: abilityScore(player.speed, (p) => p.speed) / 100,
          detail: "Response and court movement",
        },
        {
          label: "POWER",
          value: String(abilityScore(player.power, (p) => p.power)),
          fill: abilityScore(player.power, (p) => p.power) / 100,
          detail: "Kick and serve power",
        },
        {
          label: "CONTROL",
          value: String(abilityScore(player.precision, (p) => p.precision)),
          fill: abilityScore(player.precision, (p) => p.precision) / 100,
          detail: "Aim precision and placement",
        },
      ];
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
        profileStatsEl.appendChild(row);
      }
      profileTraitsEl.replaceChildren();
      const traits = [
        ["STRONG FOOT", footLabel(player.strongFoot)],
        ["HEIGHT", `${player.height.toFixed(2)} m`],
      ];
      for (const [labelText, valueText] of traits) {
        const trait = document.createElement("span");
        const label = document.createElement("b");
        label.textContent = labelText;
        trait.append(label, document.createTextNode(` · ${valueText}`));
        profileTraitsEl.appendChild(trait);
      }
    };

    const browse = () => {
      const item = items()[this.selIdx[this.selTab]];
      nameEl.textContent = item.label;
      renderProfile(this.selTab === "character" ? opts.characters[this.selIdx.character] : null);
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
    this.selectEl.querySelector<HTMLButtonElement>("#btn-start")!.onclick = () => {
      opts.onConfirm(opts.characters[this.selIdx.character].id, opts.balls[this.selIdx.ball].id);
    };
    browse();
  }

  showHUD(): void {
    this.hideAll();
    this.hudEl.classList.remove("hidden");
  }

  practicePanel(state: PracticePanelState | null): void {
    if (!state) {
      this.practiceEl.classList.add("hidden");
      return;
    }

    this.practiceEl.innerHTML = `
      <div class="practice-title">${state.title}</div>
      <div class="practice-goal">${state.goal}</div>`;
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
  showIntro(venue: string, home: string, away: string): void {
    this.introEl.innerHTML = `
      <div class="intro-venue"></div>
      <div class="intro-vs"><span></span><em>VS</em><span></span></div>
      <div class="intro-skip">TAP TO SKIP</div>`;
    const [venueEl] = this.introEl.getElementsByClassName("intro-venue");
    venueEl.textContent = venue;
    const names = this.introEl.querySelectorAll(".intro-vs span");
    names[0].textContent = home;
    names[1].textContent = away;
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
   * Precision bar: fill fraction in [0, 1] (null hides the bar) and the sweet
   * zone bounds as fractions of the bar width.
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
    this.endEl.querySelector<HTMLButtonElement>("#btn-rematch")!.onclick = () => {
      this.endEl.classList.add("hidden");
      onRematch();
    };
    this.endEl.querySelector<HTMLButtonElement>("#btn-change")!.onclick = () => {
      this.endEl.classList.add("hidden");
      onChange();
    };
  }
}
