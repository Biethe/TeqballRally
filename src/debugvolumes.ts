import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { AxesViewer } from "@babylonjs/core/Debug/axesViewer";
import "@babylonjs/core/Rendering/edgesRenderer";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { GizmoManager } from "@babylonjs/core/Gizmos/gizmoManager";
import type { Scene } from "@babylonjs/core/scene";
import {
  BALL_RADIUS,
  COURT,
  GROUND_Y,
  INTERACTION_VOLUME_DEFAULTS,
  INTERACTION_VOLUME_OVERRIDES,
  contactFraction,
  type BodyPart,
  type InteractionDims,
} from "./config";
import { stepBall, solveLaunch, type BallState } from "./ball";
import { solveBounceArrival, volumeAxes, type InteractionVolumeDef, type WorldVolume } from "./interaction";
import { CLIP_CONTACT_BONE, type Character } from "./character";

/**
 * F3 dev inspector for animation-derived interaction volumes.
 *
 * The visual proof stage of the interaction system: pick a character and a
 * contact clip, play / pause / scrub it, jump to the exact contact frame, and
 * see the measured volume sit on the actual mocap limb — next to the legacy
 * contact point, the mathematical ball sphere, local axes and a synthetic
 * incoming trajectory aimed through the volume.
 *
 * Deliberately a dev tool in the freecam mould: self-contained DOM, inline
 * styles, no gameplay reads beyond `Character`'s public geometry accessors,
 * everything disposed on toggle-off.
 */

const PART_COLOR: Record<string, number> = {
  foot: 0x39d353,
  knee: 0xff9f2e,
  chest: 0x3fa7ff,
  head: 0xff4fd8,
};

/** Tiny DOM builder so the whole panel stays readable as data, not calls. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  parent?: HTMLElement
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  parent?.appendChild(node);
  return node;
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const row = el("label", { display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" });
  const box = el("input", { margin: "0" }, row);
  box.type = "checkbox";
  box.checked = checked;
  box.onchange = () => onChange(box.checked);
  row.appendChild(document.createTextNode(label));
  return row;
}

/** Human-readable dimensions for a volume def, for the console report. */
function shapeSummary(def: { shape: string; dims: { hx?: number; hy?: number; hz?: number; r?: number; length?: number } }): string {
  const d = def.dims;
  if (def.shape === "box") return `hx ${d.hx?.toFixed(3)} hy ${d.hy?.toFixed(3)} hz ${d.hz?.toFixed(3)}`;
  if (def.shape === "capsule") return `r ${d.r?.toFixed(3)} len ${d.length?.toFixed(3)}`;
  return `r ${d.r?.toFixed(3)}`;
}

export class ContactVolumeInspector {
  private scene: Scene;
  private getChars: () => Character[];
  private enabled = false;

  private panel: HTMLDivElement | null = null;
  private info: HTMLPreElement | null = null;
  private status: HTMLSpanElement | null = null;
  private charSel: HTMLSelectElement | null = null;
  private clipSel: HTMLSelectElement | null = null;
  private frameSlider: HTMLInputElement | null = null;
  private frameLabel: HTMLSpanElement | null = null;
  private playBtn: HTMLButtonElement | null = null;

  private charIdx = 0;
  private clip = "";
  private playing = false;
  private speed = 1;

  /** Overlays for the selected clip. */
  private matFill: StandardMaterial | null = null;
  private matsByPart = new Map<string, StandardMaterial>();
  private volumeMesh: Mesh | null = null;
  private marker: Mesh | null = null;
  private legacyMarker: Mesh | null = null;
  private ballMesh: Mesh | null = null;
  private axes: AxesViewer | null = null;
  private traj: LinesMesh | null = null;

  /** "Show all" mode: one pooled mesh per clip on the selected character. */
  private showAll = false;
  private allMeshes = new Map<string, Mesh>();

  private opts = { volume: true, contact: true, legacy: true, axes: true, ball: true, traj: false };
  private trajBuiltAt = new Vector3(1e9, 1e9, 1e9);
  private trajFor = "";

  /** Diagnostics from the last trajectory build, for `logReport`. */
  private lastTraj: {
    raised: number;
    launch: Vector3;
    vel: Vector3;
    plannedBounceT: number | null;
    bounce: { t: number; pos: Vector3; side: string } | null;
    netHit: boolean;
    closest: number;
    closestT: number;
    endGap: number;
  } | null = null;

  // --- interactive editing (drag gizmos + numeric fields) -------------------
  private gizmos: GizmoManager | null = null;
  /** True while a position gizmo is under the pointer: the mesh leads, the def follows. */
  private draggingPos = false;
  /** The dims the current overlay mesh was built with, for scale write-back. */
  private meshBase: InteractionDims = {};
  /** Clips whose volume has been tuned this session, for the export buttons. */
  private edited = new Set<string>();
  private editedBadge: HTMLSpanElement | null = null;
  private editorFields: { input: HTMLInputElement; kind: "c" | "d"; axis: number; key: string }[] = [];
  private sizeRow: HTMLDivElement | null = null;
  private shapeSel: HTMLSelectElement | null = null;

  constructor(scene: Scene, getChars: () => Character[]) {
    this.scene = scene;
    this.getChars = getChars;
  }

  toggle(): void {
    if (this.enabled) this.disable();
    else this.enable();
  }

  // ------------------------------------------------------------------ setup

  private enable(): void {
    this.enabled = true;
    this.buildPanel();
    this.buildOverlays();
    this.syncCharacterOptions();
    this.selectDefaultClip();
    console.log("[volumes] inspector ON — F3 to close, F2 for a free camera");
  }

  private disable(): void {
    this.enabled = false;
    // Hand any hijacked character back to its locomotion blend quietly — no
    // frame callbacks, so a paused strike never launches a ball on close.
    for (const char of this.getChars()) char.cancelActionToLoco();
    this.disposeOverlays();
    this.panel?.remove();
    this.panel = null;
    console.log("[volumes] inspector OFF");
  }

  private buildPanel(): void {
    const panel = el("div", {
      position: "fixed",
      top: "12px",
      left: "12px",
      zIndex: "10000",
      width: "270px",
      maxHeight: "86vh",
      overflowY: "auto",
      background: "rgba(8, 12, 18, 0.93)",
      color: "#cfe3ff",
      font: "12px ui-monospace, Menlo, monospace",
      border: "1px solid rgba(120,180,255,.35)",
      borderRadius: "8px",
      padding: "10px",
      userSelect: "none",
    });
    document.body.appendChild(panel);
    this.panel = panel;
    const head = el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }, panel);
    head.appendChild(document.createTextNode("Interaction volumes"));
    const close = el("button", { cursor: "pointer" }, head);
    close.textContent = "✕";
    close.onclick = () => this.toggle();

    const row = (gap = "6px") =>
      el("div", { display: "flex", gap: gap, alignItems: "center", marginTop: "6px", flexWrap: "wrap" }, panel);

    const charRow = row();
    charRow.appendChild(document.createTextNode("who"));
    const sel = el("select", { flex: "1", minWidth: "0" }, charRow);
    this.charSel = sel;
    sel.onchange = () => {
      this.charIdx = Number(sel.value);
      this.allMeshes.forEach((m) => m.dispose());
      this.allMeshes.clear();
      this.trajFor = "";
      this.selectDefaultClip();
    };

    const clipRow = row();
    clipRow.appendChild(document.createTextNode("clip"));
    const clipPick = el("select", { flex: "1", minWidth: "0" }, clipRow);
    this.clipSel = clipPick;
    clipPick.onchange = () => {
      this.clip = clipPick.value;
      this.onSelectionChanged();
    };

    const btn = (label: string): HTMLButtonElement => {
      const b = el("button", { cursor: "pointer", padding: "2px 8px" });
      b.textContent = label;
      return b;
    };
    const transport = row();
    this.playBtn = btn("▶ play");
    this.playBtn.onclick = () => (this.playing ? this.pause() : this.play());
    transport.appendChild(this.playBtn);
    const restart = btn("⟲");
    restart.title = "Restart from the first frame";
    restart.onclick = () => {
      const char = this.currentChar();
      const g = char?.groups.get(this.clip);
      if (!char || !g) return;
      this.playing = false;
      char.playAction(this.clip, { speed: this.speed });
      this.pause();
      this.setFrames(char, g.from);
    };
    transport.appendChild(restart);
    const toContact = btn("⤓ contact");
    toContact.title = "Jump to the exact contact frame";
    toContact.onclick = () => this.jumpToContact();
    transport.appendChild(toContact);
    const logBtn = btn("⎘ log");
    logBtn.title = "Dump the current selection's geometry and flight diagnostics to the console";
    logBtn.onclick = () => this.logReport();
    transport.appendChild(logBtn);

    const speedRow = row();
    speedRow.appendChild(document.createTextNode("speed"));
    this.speed = 1;
    for (const s of [0.25, 0.5, 1, 1.5]) {
      const b = btn(`${s}×`);
      b.onclick = () => {
        this.speed = s;
        const char = this.currentChar();
        if (!char) return;
        const g = char.groups.get(this.clip);
        const cur = g && g.animatables.length > 0 ? g.animatables[0].masterFrame : g?.from ?? 0;
        char.playAction(this.clip, { speed: s });
        this.playing = false;
        this.pause();
        if (g) this.setFrames(char, cur);
      };
      speedRow.appendChild(b);
    }

    const scrubRow = row();
    this.frameSlider = el("input", { flex: "1", minWidth: "0" }, scrubRow);
    const scrub = this.frameSlider;
    scrub.type = "range";
    scrub.step = "1";
    scrub.oninput = () => {
      const char = this.currentChar();
      if (!char) return;
      this.playing = false;
      this.pause();
      this.ensureAnimatables(char);
      this.setFrames(char, Number(scrub.value));
    };
    this.frameLabel = el("span", { minWidth: "64px", textAlign: "right" }, scrubRow);

    const toggles = row();
    toggles.appendChild(checkbox("volume", this.opts.volume, (v) => (this.opts.volume = v)));
    toggles.appendChild(checkbox("contact", this.opts.contact, (v) => (this.opts.contact = v)));
    toggles.appendChild(checkbox("legacy pt", this.opts.legacy, (v) => (this.opts.legacy = v)));
    toggles.appendChild(checkbox("axes", this.opts.axes, (v) => (this.opts.axes = v)));
    toggles.appendChild(checkbox("ball", this.opts.ball, (v) => (this.opts.ball = v)));
    toggles.appendChild(checkbox("trajectory", this.opts.traj, (v) => (this.opts.traj = v)));
    toggles.appendChild(
      checkbox("all volumes", this.showAll, (v) => {
        this.showAll = v;
        if (!v) {
          this.allMeshes.forEach((m) => m.dispose());
          this.allMeshes.clear();
        }
      })
    );

    this.info = el("pre", { margin: "8px 0 0", whiteSpace: "pre-wrap", color: "#9db8d8", fontSize: "11px" }, panel);

    // --- volume editor: drag the gizmos in-scene, or type exact numbers here.
    const editHead = row();
    editHead.appendChild(document.createTextNode("edit volume"));
    this.editedBadge = el("span", { color: "#ffd166", marginLeft: "auto", fontSize: "10px" }, editHead);

    const numField = (parent: HTMLElement, kind: "c" | "d", axis: number, key: string, step: string): void => {
      const input = el("input", { width: "62px", padding: "1px 3px" }, parent);
      input.type = "number";
      input.step = step;
      input.title = kind === "c" ? `centre ${key} (m, clip-local)` : `${key} (m)`;
      input.oninput = () => {
        const char = this.currentChar();
        const def = char?.interactionVolumes.get(this.clip);
        const value = parseFloat(input.value);
        if (!def || !Number.isFinite(value)) return;
        if (kind === "c") def.center[axis] = value;
        else def.dims = { ...def.dims, [key]: value };
        this.markEdited();
        if (kind === "d") this.refreshVolumeMesh();
        this.trajFor = "";
      };
      this.editorFields.push({ input, kind, axis, key });
    };

    const centreRow = row();
    centreRow.appendChild(document.createTextNode("centre"));
    numField(centreRow, "c", 0, "x", "0.005");
    numField(centreRow, "c", 1, "y", "0.005");
    numField(centreRow, "c", 2, "z", "0.005");

    const sizeRow = row();
    sizeRow.appendChild(document.createTextNode("size"));
    this.sizeRow = sizeRow;
    const shapePick = el("select", {}, sizeRow);
    this.shapeSel = shapePick;
    for (const s of ["sphere", "box", "capsule"]) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      shapePick.appendChild(opt);
    }
    shapePick.onchange = () => {
      const char = this.currentChar();
      const def = char?.interactionVolumes.get(this.clip);
      if (!def) return;
      def.shape = shapePick.value as InteractionVolumeDef["shape"];
      def.dims = { ...def.dims, shape: def.shape };
      this.markEdited();
      this.rebuildSizeFields();
      this.refreshVolumeMesh();
      this.trajFor = "";
    };

    const editBtns = row();
    const ebtn = (label: string, title: string, fn: () => void): void => {
      const b = el("button", { cursor: "pointer", padding: "2px 6px" }, editBtns);
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
    };
    ebtn("reset", "Restore this clip's measured pose centre and configured dims", () => this.resetClip());
    ebtn("snap→legacy", "Move the volume centre onto the legacy contact point", () => this.snapToLegacy());
    ebtn("⎘ override", "Print this clip's tuned values as a config.ts override snippet", () => this.exportOverride(true));
    ebtn("⎘ all edited", "Print override snippets for every clip tuned this session", () => this.exportOverride(false));

    this.status = el("span", { color: "#7f96b3", fontSize: "10px" }, panel);
    this.status.textContent = "F2 free camera to orbit · drag arrows = move, squares = resize";
  }

  private buildOverlays(): void {
    const mkMat = (color: number, alpha: number): StandardMaterial => {
      const m = new StandardMaterial(`volmat-${color}`, this.scene);
      m.emissiveColor = Color3.FromHexString(`#${color.toString(16).padStart(6, "0")}`);
      m.diffuseColor = Color3.Black();
      m.alpha = alpha;
      m.backFaceCulling = false;
      return m;
    };
    this.matFill = mkMat(0x35e0ff, 0.2);
    for (const [part, color] of Object.entries(PART_COLOR)) {
      this.matsByPart.set(part, mkMat(color, 0.14));
    }
    this.volumeMesh = MeshBuilder.CreateBox("vol-box", { size: 1 }, this.scene);
    this.volumeMesh.material = this.matFill;
    this.volumeMesh.isPickable = false;
    this.volumeMesh.rotationQuaternion = Quaternion.Identity();
    this.volumeMesh.enableEdgesRendering();
    this.volumeMesh.edgesWidth = 3;
    this.volumeMesh.edgesColor = Color3.FromHexString("#bfefff").toColor4(1);

    this.marker = MeshBuilder.CreateSphere("vol-marker", { diameter: 0.055, segments: 8 }, this.scene);
    this.marker.material = mkMat(0xff3355, 0.95);
    this.marker.isPickable = false;

    this.legacyMarker = MeshBuilder.CreateSphere("vol-legacy", { diameter: 0.055, segments: 8 }, this.scene);
    this.legacyMarker.material = mkMat(0xffdd33, 0.9);
    this.legacyMarker.isPickable = false;

    this.ballMesh = MeshBuilder.CreateSphere("vol-ballsphere", { diameter: BALL_RADIUS * 2, segments: 12 }, this.scene);
    this.ballMesh.material = mkMat(0xffffff, 0.85);
    this.ballMesh.isPickable = false;

    this.axes = new AxesViewer(this.scene, 0.4);

    // Drag editing: arrows move the volume, corner handles resize it. Attached
    // to whichever overlay mesh the current clip's shape builds; write-back
    // happens per frame for position and on release for scale.
    this.gizmos = new GizmoManager(this.scene);
    this.gizmos.usePointerToAttachGizmos = false;
    this.gizmos.positionGizmoEnabled = true;
    this.gizmos.scaleGizmoEnabled = true;
    this.gizmos.gizmos.positionGizmo?.onDragStartObservable.add(() => {
      this.draggingPos = true;
    });
    this.gizmos.gizmos.positionGizmo?.onDragEndObservable.add(() => {
      this.draggingPos = false;
      this.writeBackCenter();
    });
    this.gizmos.gizmos.scaleGizmo?.onDragStartObservable.add(() => {
      this.draggingPos = true; // same rule: mesh leads until release
    });
    this.gizmos.gizmos.scaleGizmo?.onDragEndObservable.add(() => {
      this.draggingPos = false;
      this.writeBackScale();
    });
  }

  private disposeOverlays(): void {
    this.gizmos?.attachToMesh(null);
    this.gizmos?.dispose();
    this.gizmos = null;
    this.volumeMesh?.dispose();
    this.marker?.dispose();
    this.legacyMarker?.dispose();
    this.ballMesh?.dispose();
    this.traj?.dispose();
    this.axes?.dispose();
    this.allMeshes.forEach((m) => m.dispose());
    this.allMeshes.clear();
    this.matFill?.dispose();
    this.matsByPart.forEach((m) => m.dispose());
    this.matsByPart.clear();
    this.volumeMesh = this.marker = this.legacyMarker = this.ballMesh = this.traj = null;
    this.axes = null;
    this.matFill = null;
    this.trajFor = "";
  }

  // ------------------------------------------------------------- selection

  private currentChar(): Character | null {
    const chars = this.getChars();
    if (chars.length === 0) return null;
    return chars[Math.min(this.charIdx, chars.length - 1)] ?? chars[0];
  }

  private syncCharacterOptions(): void {
    const sel = this.charSel;
    if (!sel || !this.panel) return;
    const chars = this.getChars();
    sel.innerHTML = "";
    chars.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = c.def.id;
      sel.appendChild(opt);
    });
    if (chars.length === 0) {
      this.status!.textContent = "no character loaded — enter a match or practice first";
    } else {
      this.status!.textContent = "F2 free camera to orbit · best with the rally idle";
    }
    if (this.charIdx >= chars.length) this.charIdx = 0;
    sel.value = String(this.charIdx);
  }

  private selectDefaultClip(): void {
    const char = this.currentChar();
    const names = char ? [...char.interactionVolumes.keys()].sort() : [];
    if (!this.clipSel) return;
    this.clipSel.innerHTML = "";
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      this.clipSel.appendChild(opt);
    }
    this.clip = names.includes(this.clip) ? this.clip : (names[0] ?? "");
    if (this.clip) this.clipSel.value = this.clip;
    this.onSelectionChanged();
  }

  private onSelectionChanged(): void {
    const char = this.currentChar();
    if (!char || !this.clip) return;
    this.playing = false;
    // Drop the pooled shape mesh so a switch between box/sphere/capsule clips
    // rebuilds the right primitive instead of rescaling the wrong one.
    this.volumeMesh?.dispose();
    this.volumeMesh = null;
    this.jumpToContact();
    this.refreshInfo(char);
    this.rebuildSizeFields();
    this.trajFor = "";
  }

  private refreshInfo(char: Character): void {
    const def = char.interactionVolumes.get(this.clip);
    if (!def || !this.info) return;
    const dims = def.dims;
    const size =
      def.shape === "box"
        ? `hx ${dims.hx?.toFixed(3)} hy ${dims.hy?.toFixed(3)} hz ${dims.hz?.toFixed(3)}`
        : def.shape === "sphere"
          ? `r ${dims.r?.toFixed(3)}`
          : `r ${dims.r?.toFixed(3)} len ${dims.length?.toFixed(3)}`;
    const c = def.center;
    this.info.textContent =
      `part ${def.part} · bone ${CLIP_CONTACT_BONE[this.clip] ?? "?"}\n` +
      `shape ${def.shape}: ${size}\n` +
      `centre [${c.map((v) => v.toFixed(3)).join(", ")}]\n` +
      `Δ from measured [${c.map((v, i) => (v - def.measuredCenter[i]).toFixed(3)).join(", ")}]\n` +
      `red = volume centre · yellow = legacy contact point`;
  }

  // ------------------------------------------------------------- transport

  private ensureAnimatables(char: Character): AnimationGroup | null {
    const g = char.groups.get(this.clip);
    if (!g) return null;
    if (g.animatables.length === 0) {
      char.playAction(this.clip, { speed: this.speed });
      g.pause();
    }
    return g;
  }

  private setFrames(char: Character, frame: number): void {
    const g = char.groups.get(this.clip);
    if (!g) return;
    const f = Math.max(g.from, Math.min(g.to, frame));
    g.goToFrame(f);
    if (this.frameSlider) {
      this.frameSlider.min = String(g.from);
      this.frameSlider.max = String(g.to);
      this.frameSlider.value = String(f);
    }
    if (this.frameLabel) this.frameLabel.textContent = `f ${f.toFixed(0)}/${g.to}`;
  }

  private play(): void {
    const char = this.currentChar();
    if (!char) return;
    const g = this.ensureAnimatables(char);
    if (!g) return;
    const atEnd = g.animatables.length > 0 && g.animatables[0].masterFrame >= g.to - 0.01;
    if (atEnd) char.playAction(this.clip, { speed: this.speed });
    g.play();
    this.playing = true;
    if (this.playBtn) this.playBtn.textContent = "⏸ pause";
  }

  private pause(): void {
    const char = this.currentChar();
    if (!char) return;
    char.groups.get(this.clip)?.pause();
    this.playing = false;
    if (this.playBtn) this.playBtn.textContent = "▶ play";
  }

  private jumpToContact(): void {
    const char = this.currentChar();
    if (!char) return;
    const g = this.ensureAnimatables(char);
    if (!g) return;
    g.pause();
    this.playing = false;
    if (this.playBtn) this.playBtn.textContent = "▶ play";
    const cf = contactFraction(this.clip);
    this.setFrames(char, g.from + cf * (g.to - g.from));
  }

  // ------------------------------------------------------------ per-frame

  /**
   * The overlay mesh for the selected clip's shape, rebuilt on demand.
   *
   * A unit cube scaled per frame cannot become a sphere or a capsule, so the
   * three shapes each get a real primitive, created lazily and swapped when
   * the selection moves between shape families.
   */
  private shapeMesh(char: Character): Mesh | null {
    const def = char.interactionVolumes.get(this.clip);
    if (!def) return null;
    const want = def.shape;
    const have = this.volumeMesh?.name.replace("vol-", "") ?? "";
    if (have === want) return this.volumeMesh;
    this.volumeMesh?.dispose();
    this.meshBase = { ...def.dims };
    let mesh: Mesh;
    if (want === "sphere") {
      mesh = MeshBuilder.CreateSphere("vol-sphere", { diameter: (def.dims.r ?? 0.1) * 2, segments: 16 }, this.scene);
    } else if (want === "capsule") {
      const r = def.dims.r ?? 0.05;
      mesh = MeshBuilder.CreateCapsule("vol-capsule", { radius: r, height: (def.dims.length ?? 0.1) + r * 2 }, this.scene);
    } else {
      mesh = MeshBuilder.CreateBox("vol-box", { width: (def.dims.hx ?? 0.1) * 2, height: (def.dims.hy ?? 0.1) * 2, depth: (def.dims.hz ?? 0.1) * 2 }, this.scene);
    }
    mesh.material = this.matFill;
    // Pickable so the gizmos can be attached to it; the gizmo layer handles
    // its own picking and the scene's ray casts never read this mesh.
    mesh.isPickable = true;
    mesh.rotationQuaternion = Quaternion.Identity();
    mesh.enableEdgesRendering();
    mesh.edgesWidth = 3;
    mesh.edgesColor = Color3.FromHexString("#bfefff").toColor4(1);
    this.volumeMesh = mesh;
    this.gizmos?.attachToMesh(mesh);
    return mesh;
  }

  private rebuildTrajectory(char: Character, vol: WorldVolume): void {
    const key = `${char.def.id}|${this.clip}|${char.faceDir}`;
    const moved = Vector3.DistanceSquared(char.position, this.trajBuiltAt) > 0.001;
    if (this.traj && key === this.trajFor && !moved) return;
    this.trajFor = key;
    this.trajBuiltAt.copyFrom(char.position);
    this.traj?.dispose();
    this.traj = null;

    const V = vol.center;
    const dirX = V.x >= 0 ? -1 : 1;
    const from = new Vector3(dirX * (COURT.maxX - 0.4), GROUND_Y + 1.0, 0);

    // A real incoming ball bounces once on the receiver's table half before it
    // can be played; the preview solves exactly that flight (see
    // `solveBounceArrival`) so the line drawn is a flight a real strike
    // could take, not an idealised direct arc.
    const strike = solveBounceArrival(from, V);
    let state: BallState;
    let maxT: number;
    if (strike) {
      state = { pos: strike.pos.clone(), vel: strike.vel };
      maxT = strike.maxT;
    } else {
      // Degenerate geometry (volume at the net line, say): a direct arc at
      // least still shows the volume relative to a flight.
      const flightT = Math.min(1.5, Math.max(0.55, Vector3.Distance(from, V) / 11));
      state = { pos: from.clone(), vel: solveLaunch(from, V, flightT) };
      maxT = flightT + 0.2;
    }
    // Simulated with events rather than through sampleFlight: the report wants
    // to know where the table bounce actually happened, not just where the
    // samples go.
    const s = { pos: state.pos.clone(), vel: state.vel.clone() };
    const samples: { t: number; pos: Vector3 }[] = [];
    let bounce: { t: number; pos: Vector3; side: string } | null = null;
    let netHit = false;
    let t = 0;
    while (t < maxT) {
      stepBall(s, 1 / 120, (e) => {
        if (e.type === "table" && !bounce) bounce = { t, pos: e.pos.clone(), side: e.side };
        if (e.type === "net") netHit = true;
      });
      t += 1 / 120;
      samples.push({ t, pos: s.pos.clone() });
    }
    // The line is the simulated flight and nothing else — no connector onto
    // the volume at the end. Where the samples stop short of the centre is the
    // solver's real residual, and hiding it would draw a snap the physics
    // never did.
    const pts = samples.map((s2) => s2.pos.clone());
    this.traj = MeshBuilder.CreateLineSystem(
      "vol-traj",
      { lines: [pts.length > 1 ? pts : [from, from]] },
      this.scene
    );
    this.traj.color = Color3.FromHexString("#ffd166");
    this.traj.alpha = 0.85;
    this.traj.isPickable = false;
    // The mathematical ball rides the leg that matters: the sample nearest the
    // volume, bounce included, so its radius reads against the real approach.
    let bestSample = samples[0];
    let bestD = Infinity;
    for (const s2 of samples) {
      const d = Vector3.DistanceSquared(s2.pos, V);
      if (d < bestD) {
        bestD = d;
        bestSample = s2;
      }
    }
    if (bestSample) this.ballMesh?.position.copyFrom(bestSample.pos);
    const b = bounce as { t: number; pos: Vector3; side: string } | null;
    this.lastTraj = {
      raised: strike ? strike.pos.y - from.y : 0,
      launch: state.pos.clone(),
      vel: state.vel.clone(),
      plannedBounceT: strike?.arrivalT ?? null,
      bounce: b ? { t: b.t, pos: b.pos, side: b.side } : null,
      netHit,
      closest: Math.sqrt(bestD),
      closestT: bestSample?.t ?? 0,
      endGap: bestSample ? Vector3.Distance(bestSample.pos, V) : NaN,
    };
  }

  /**
   * Everything the current selection can say about itself, to the console.
   *
   * The three gaps this tool can show each have their own line in the report:
   * volume-centre vs the legacy contact point (deliberate for head clips),
   * flight-end vs volume centre (the solver's residual), and the volume's
   * measured local centre itself (the number the checkpoint validates).
   */
  logReport(): void {
    const char = this.currentChar();
    if (!char || !this.clip) {
      console.log("[volumes] nothing selected — enter a match and pick a clip first");
      return;
    }
    const def = char.interactionVolumes.get(this.clip);
    if (!def) {
      console.log(`[volumes] ${this.clip}: no interaction volume measured`);
      return;
    }
    const vol = char.contactVolumeTransform(this.clip);
    const legacy = char.clipContactPoint(this.clip);
    const c = def.center;
    const q = def.quat;
    const fmt = (v: Vector3 | undefined, n = 3) =>
      v ? `(${v.x.toFixed(n)}, ${v.y.toFixed(n)}, ${v.z.toFixed(n)})` : "—";
    const lines: string[] = [];
    lines.push(
      `[volumes] ${this.clip} · ${def.part} · bone ${CLIP_CONTACT_BONE[this.clip] ?? "?"} · ` +
        `char ${char.def.id} faceDir ${char.faceDir} @ (${char.position.x.toFixed(2)}, ${char.position.z.toFixed(2)})`
    );
    lines.push(
      `  volume : ${def.shape} ${shapeSummary(def)} · local centre [${c.map((v) => v.toFixed(3)).join(", ")}] · ` +
        `quat (${q.map((v) => v.toFixed(3)).join(", ")})`
    );
    lines.push(`  world  : centre ${fmt(vol?.center)} · legacy point ${fmt(legacy ?? undefined)}`);
    if (vol && legacy) {
      lines.push(
        `  gap A  : centre↔legacy ${Vector3.Distance(vol.center, legacy).toFixed(3)} m` +
          ` (head clips: +${0.15} forehead push is deliberate)`
      );
    }
    const tj = this.lastTraj;
    if (!tj) {
      lines.push("  flight : not built yet — tick 'trajectory' once, then log again");
    } else {
      lines.push(
        `  strike : launch ${fmt(tj.launch)}${tj.raised > 0.01 ? ` (+${tj.raised.toFixed(2)} net raise)` : ""}` +
          ` · vel ${fmt(tj.vel, 2)}${tj.netHit ? " · ⚠ NET HIT" : ""}`
      );
      lines.push(
        `  bounce : ` +
          (tj.bounce
            ? `${tj.bounce.side} half @ ${fmt(tj.bounce.pos)} t=${tj.bounce.t.toFixed(3)}s` +
              (tj.plannedBounceT ? ` (planned ${tj.plannedBounceT.toFixed(3)}s)` : "")
            : "none before landing ⚠")
      );
      lines.push(
        `  gap B  : flight↔centre ${tj.endGap.toFixed(3)} m · closest ${tj.closest.toFixed(3)} m @ t=${tj.closestT.toFixed(3)}s`
      );
    }
    console.log(lines.join("\n"));
  }

  // -------------------------------------------------------- volume editing

  private markEdited(): void {
    this.edited.add(this.clip);
    if (this.editedBadge) {
      this.editedBadge.textContent = this.edited.size
        ? `${this.edited.size} clip${this.edited.size > 1 ? "s" : ""} edited`
        : "";
    }
  }

  /** Adopt the dragged mesh position as the clip's local volume centre. */
  private writeBackCenter(): void {
    const char = this.currentChar();
    const mesh = this.volumeMesh;
    const def = char?.interactionVolumes.get(this.clip);
    if (!char || !mesh || !def) return;
    const local = char.worldToClipLocal(this.clip, mesh.position);
    if (!local) return;
    def.center = [+local.x.toFixed(4), +local.y.toFixed(4), +local.z.toFixed(4)];
    this.markEdited();
    this.trajFor = "";
    this.refreshEditorFields();
    this.refreshInfo(char);
  }

  /** Adopt the dragged scale as new volume dimensions, then rebuild cleanly. */
  private writeBackScale(): void {
    const char = this.currentChar();
    const mesh = this.volumeMesh;
    const def = char?.interactionVolumes.get(this.clip);
    if (!char || !mesh || !def) return;
    const sc = mesh.scaling;
    const base = this.meshBase;
    const fix = (v: number) => +v.toFixed(4);
    if (def.shape === "box") {
      def.dims = {
        ...def.dims,
        hx: fix((base.hx ?? 0.1) * sc.x),
        hy: fix((base.hy ?? 0.1) * sc.y),
        hz: fix((base.hz ?? 0.1) * sc.z),
      };
    } else if (def.shape === "sphere") {
      def.dims = { ...def.dims, r: fix((base.r ?? 0.1) * ((sc.x + sc.y + sc.z) / 3)) };
    } else {
      def.dims = {
        ...def.dims,
        r: fix((base.r ?? 0.05) * ((sc.x + sc.z) / 2)),
        length: fix((base.length ?? 0.1) * sc.y),
      };
    }
    this.markEdited();
    this.refreshVolumeMesh();
    this.refreshEditorFields();
    this.refreshInfo(char);
  }

  /** Drop the overlay mesh so the next frame rebuilds it from the def. */
  private refreshVolumeMesh(): void {
    this.volumeMesh?.dispose();
    this.volumeMesh = null;
  }

  /** Size fields for the current shape, plus the shape picker itself. */
  private rebuildSizeFields(): void {
    const char = this.currentChar();
    const def = char?.interactionVolumes.get(this.clip);
    if (!def || !this.sizeRow || !this.shapeSel) return;
    this.shapeSel.value = def.shape;
    this.editorFields = this.editorFields.filter((f) => f.kind === "c");
    while (this.sizeRow.childNodes.length > 1) {
      this.sizeRow.removeChild(this.sizeRow.lastChild!);
    }
    this.sizeRow.appendChild(this.shapeSel);
    const add = (key: string, step: string): void => {
      const input = el("input", { width: "56px", padding: "1px 3px" }, this.sizeRow!);
      input.type = "number";
      input.step = step;
      input.title = `${key} (m)`;
      input.oninput = () => {
        const ch = this.currentChar();
        const d = ch?.interactionVolumes.get(this.clip);
        const value = parseFloat(input.value);
        if (!d || !Number.isFinite(value)) return;
        d.dims = { ...d.dims, [key]: value };
        this.markEdited();
        this.refreshVolumeMesh();
        this.trajFor = "";
      };
      this.editorFields.push({ input, kind: "d", axis: -1, key });
    };
    if (def.shape === "sphere") add("r", "0.005");
    else if (def.shape === "capsule") {
      add("r", "0.005");
      add("length", "0.01");
    } else {
      add("hx", "0.005");
      add("hy", "0.005");
      add("hz", "0.005");
    }
    this.refreshEditorFields();
  }

  /** Push current def values into the number fields (never over a focused one). */
  private refreshEditorFields(): void {
    const char = this.currentChar();
    const def = char?.interactionVolumes.get(this.clip);
    if (!def) return;
    const active = document.activeElement;
    for (const f of this.editorFields) {
      if (f.input === active) continue;
      const v = f.kind === "c" ? def.center[f.axis] : (def.dims as Record<string, number | undefined>)[f.key];
      if (v !== undefined) f.input.value = String(+(+v).toFixed(4));
    }
  }

  private resetClip(): void {
    const char = this.currentChar();
    const def = char?.interactionVolumes.get(this.clip);
    if (!char || !def) return;
    const override = INTERACTION_VOLUME_OVERRIDES[this.clip];
    const dims: InteractionDims = {
      ...INTERACTION_VOLUME_DEFAULTS[def.part as BodyPart],
      ...(override?.dims ?? {}),
    };
    const d = override?.d ?? [0, 0, 0];
    def.center = [
      def.measuredCenter[0] + d[0],
      def.measuredCenter[1] + d[1],
      def.measuredCenter[2] + d[2],
    ];
    def.dims = dims;
    def.shape = dims.shape ?? "sphere";
    this.edited.delete(this.clip);
    this.markEdited(); // refreshes the badge count
    this.edited.delete(this.clip);
    this.rebuildSizeFields();
    this.refreshVolumeMesh();
    this.trajFor = "";
    this.refreshInfo(char);
  }

  private snapToLegacy(): void {
    const char = this.currentChar();
    const def = char?.interactionVolumes.get(this.clip);
    if (!char || !def) return;
    const legacy = char.clipContactPoint(this.clip);
    if (!legacy) return;
    const local = char.worldToClipLocal(this.clip, legacy);
    if (!local) return;
    def.center = [+local.x.toFixed(4), +local.y.toFixed(4), +local.z.toFixed(4)];
    this.markEdited();
    this.refreshEditorFields();
    this.refreshInfo(char);
    this.trajFor = "";
  }

  /**
   * Print tuned values as ready-to-paste `INTERACTION_VOLUME_OVERRIDES`
   * entries. The centre is exported as a delta from the measured pose, so the
   * same snippet stays correct on every character's rig.
   */
  private exportOverride(one: boolean): void {
    const char = this.currentChar();
    if (!char) return;
    const clips = (one ? [this.clip] : [...this.edited].sort()).filter((c) =>
      char.interactionVolumes.has(c)
    );
    if (clips.length === 0) {
      console.log("[volumes] nothing tuned yet — drag a volume or type new numbers first");
      return;
    }
    const lines = clips.map((clip) => {
      const def = char.interactionVolumes.get(clip)!;
      const d = def.center.map((v, i) => +(v - def.measuredCenter[i]).toFixed(4));
      const base: InteractionDims = {
        ...INTERACTION_VOLUME_DEFAULTS[def.part as BodyPart],
        ...(INTERACTION_VOLUME_OVERRIDES[clip]?.dims ?? {}),
      };
      const keys = ["shape", "hx", "hy", "hz", "r", "length"] as const;
      const dimsDiff = keys
        .map((k) => {
          const v = def.dims[k];
          return v !== undefined && v !== base[k]
            ? `${k}: ${typeof v === "string" ? `"${v}"` : v}`
            : null;
        })
        .filter((s): s is string => s !== null);
      const parts: string[] = [];
      if (d.some((v) => Math.abs(v) > 0.0005)) parts.push(`d: [${d.join(", ")}]`);
      if (dimsDiff.length) parts.push(`dims: { ${dimsDiff.join(", ")} }`);
      return parts.length
        ? `  ${clip}: { ${parts.join(", ")} },`
        : `  ${clip}: // unchanged from config`;
    });
    console.log(
      `[volumes] paste into INTERACTION_VOLUME_OVERRIDES (src/config.ts):\n${lines.join("\n")}`
    );
  }

  /** Called once per rendered frame from the main loop. */
  update(): void {
    if (!this.enabled || !this.panel) return;
    const chars = this.getChars();
    const countChanged = this.charSel && this.charSel.options.length !== chars.length;
    if (countChanged) {
      this.syncCharacterOptions();
      if (chars.length > 0) this.selectDefaultClip();
    }
    const char = this.currentChar();
    if (!char || !this.clip) return;

    const g = char.groups.get(this.clip);
    if (g && this.playing && g.animatables.length > 0) {
      const f = g.animatables[0].masterFrame;
      if (this.frameSlider) this.frameSlider.value = String(f);
      if (this.frameLabel) this.frameLabel.textContent = `f ${f.toFixed(0)}/${g.to}`;
      if (f >= g.to - 0.01) this.pause();
    }

    const vol = char.contactVolumeTransform(this.clip);
    if (!vol) return;
    const mesh = this.shapeMesh(char);
    if (mesh && this.draggingPos) {
      // The gizmo owns the mesh while dragged; adopt its position into the
      // def so the typed fields and the markers track the drag live.
      this.writeBackCenter();
    } else if (mesh) {
      mesh.position.copyFrom(vol.center);
      mesh.rotationQuaternion!.copyFrom(vol.rotation);
    }
    const volNow = this.draggingPos ? char.contactVolumeTransform(this.clip) ?? vol : vol;
    this.marker!.position.copyFrom(volNow.center);
    this.marker!.setEnabled(this.opts.contact);
    const legacy = char.clipContactPoint(this.clip);
    this.legacyMarker!.position.copyFrom(legacy ?? volNow.center);
    this.legacyMarker!.setEnabled(this.opts.legacy);
    this.axes!.xAxis.setEnabled(this.opts.axes);
    this.axes!.yAxis.setEnabled(this.opts.axes);
    this.axes!.zAxis.setEnabled(this.opts.axes);
    if (this.opts.axes) {
      const [ax, ay, az] = volumeAxes(volNow);
      this.axes!.update(volNow.center, ax, ay, az);
    }

    if (this.opts.traj) {
      this.rebuildTrajectory(char, volNow);
      this.traj?.setEnabled(true);
    } else {
      this.traj?.setEnabled(false);
    }
    if (!this.opts.traj && this.opts.ball) {
      // Park the ball sphere just above the centre so scale is still judgeable.
      this.ballMesh!.position.copyFrom(volNow.center.add(new Vector3(0, BALL_RADIUS + 0.06, 0)));
    }
    this.ballMesh!.setEnabled(this.opts.ball);
    this.refreshEditorFields();

    if (this.showAll) this.updateAllVolumes(char);
  }

  private updateAllVolumes(char: Character): void {
    for (const [clip, def] of char.interactionVolumes) {
      let mesh = this.allMeshes.get(clip);
      const vol = char.contactVolumeTransform(clip);
      if (!vol) continue;
      if (!mesh) {
        if (def.shape === "sphere") {
          mesh = MeshBuilder.CreateSphere(`all-${clip}`, { diameter: (def.dims.r ?? 0.1) * 2, segments: 10 }, this.scene);
        } else if (def.shape === "capsule") {
          const r = def.dims.r ?? 0.05;
          mesh = MeshBuilder.CreateCapsule(`all-${clip}`, { radius: r, height: (def.dims.length ?? 0.1) + r * 2 }, this.scene);
        } else {
          mesh = MeshBuilder.CreateBox(
            `all-${clip}`,
            {
              width: (def.dims.hx ?? 0.1) * 2,
              height: (def.dims.hy ?? 0.1) * 2,
              depth: (def.dims.hz ?? 0.1) * 2,
            },
            this.scene
          );
        }
        mesh.material = this.matsByPart.get(def.part) ?? this.matFill!;
        mesh.isPickable = false;
        mesh.rotationQuaternion = Quaternion.Identity();
        this.allMeshes.set(clip, mesh);
      }
      mesh.position.copyFrom(vol.center);
      mesh.rotationQuaternion!.copyFrom(vol.rotation);
    }
  }
}
