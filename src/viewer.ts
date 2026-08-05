import { Scene } from "@babylonjs/core/scene";
import type { Engine } from "@babylonjs/core/Engines/engine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { GLTFLoaderAnimationStartMode } from "@babylonjs/loaders/glTF/glTFFileLoader";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { importBall, fixMetallicMaterials } from "./scene";
import { maskJerseyPlaceholder, trimIdleTail } from "./character";
import { CHARACTER_SCALE, CHARACTERS } from "./config";

export type ViewerKind = "character" | "ball";

interface Entry {
  kind: ViewerKind;
  root: TransformNode;
  /** Looping clip shown in the menu (a randomly chosen MenuPose, or Idle). */
  anim: AnimationGroup | null;
}

const MENU_POSE_RE = /^MenuPose\d*$/;

const BALL_VIEW_DIAMETER = 0.7;
const BALL_VIEW_Y = 0.9;

// Keep the studio in a calm blue-grey family rather than a near-black void.
// The ice-blue accent is deliberately narrow and cool: it gives the plinth a
// contemporary technical finish without competing with a player's kit.
const STUDIO_SLATE = new Color3(0.1, 0.13, 0.185);
const STUDIO_FLOOR = new Color3(0.062, 0.086, 0.128);
const STUDIO_ICE = new Color3(0.055, 0.13, 0.23);
const STUDIO_ICE_GLOW = new Color3(0.001, 0.006, 0.02);

function studioMaterial(
  scene: Scene,
  name: string,
  diffuse: Color3,
  emissive: Color3 = Color3.Black(),
  specular = 0.08
): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = diffuse;
  material.emissiveColor = emissive;
  material.specularColor = new Color3(specular, specular, specular);
  return material;
}

/**
 * Showroom scene for the main menu: renders one character or ball at a time
 * on a pedestal, with an orbit camera the user can drag. Loaded models are
 * cached so browsing back and forth is instant.
 */
export class ModelViewer {
  readonly scene: Scene;
  active = false;

  private camera: ArcRotateCamera;
  private shadows: ShadowGenerator;
  private ballDisplay: TransformNode;
  private cache = new Map<string, Entry>();
  private current: Entry | null = null;
  private currentKey = "";

  constructor(engine: Engine, private canvas: HTMLCanvasElement) {
    this.scene = new Scene(engine);
    this.scene.clearColor = new Color4(STUDIO_SLATE.r, STUDIO_SLATE.g, STUDIO_SLATE.b, 1);
    // A modest lift lets the model lighting read clearly without turning the
    // empty part of the viewport into a dramatic, distracting backdrop.
    this.scene.imageProcessingConfiguration.contrast = 1.07;
    this.scene.imageProcessingConfiguration.exposure = 1.1;

    this.camera = new ArcRotateCamera("viewer-cam", Math.PI / 2, 1.25, 3.2, new Vector3(0, 0.95, 0), this.scene);
    this.camera.lowerRadiusLimit = 1.2;
    this.camera.upperRadiusLimit = 6.5;
    this.camera.lowerBetaLimit = 0.3;
    this.camera.upperBetaLimit = Math.PI / 2 + 0.2;
    this.camera.wheelDeltaPercentage = 0.01;
    this.camera.panningSensibility = 0; // orbit only
    this.camera.fov = 0.82;

    const hemi = new HemisphericLight("viewer-hemi", new Vector3(0.1, 1, -0.2), this.scene);
    hemi.intensity = 0.78;
    hemi.diffuse = new Color3(0.74, 0.83, 1);
    hemi.groundColor = new Color3(0.07, 0.085, 0.13);

    // Neutral key and restrained ice rim keep kits true to colour while
    // preserving the selected model as the brightest thing on screen.
    const key = new DirectionalLight("viewer-key", new Vector3(-0.42, -1, 0.38), this.scene);
    key.position = new Vector3(3.5, 7, -4);
    key.intensity = 1.58;
    key.diffuse = new Color3(0.96, 0.98, 1);
    const rim = new DirectionalLight("viewer-rim", new Vector3(0.5, -0.45, -0.8), this.scene);
    rim.position = new Vector3(-4, 4, 5);
    rim.intensity = 0.72;
    rim.diffuse = new Color3(0.3, 0.72, 1);

    this.shadows = new ShadowGenerator(1024, key);
    this.shadows.useExponentialShadowMap = true;
    this.shadows.darkness = 0.3;
    key.autoCalcShadowZBounds = true;

    const glow = new GlowLayer("viewer-glow", this.scene, { mainTextureRatio: 0.5 });
    glow.intensity = 0.22;
    glow.blurKernelSize = 40;

    this.ballDisplay = new TransformNode("viewer-ball-display", this.scene);
    this.buildStudio();
    this.ballDisplay.setEnabled(false);
  }

  activate(): void {
    this.active = true;
    this.camera.attachControl(this.canvas, true);
  }

  deactivate(): void {
    this.active = false;
    this.camera.detachControl();
    this.setCurrent(null);
  }

  /** Called from the render loop while active: slow turntable spin for balls. */
  update(dtSec: number): void {
    if (this.current?.kind === "ball") {
      this.current.root.rotation.y += dtSec * 0.6;
    }
  }

  /**
   * Show a model, loading and caching it on first view. Returns false if the
   * request was superseded by a newer show() before the load finished.
   */
  async show(kind: ViewerKind, id: string): Promise<boolean> {
    const cacheKey = `${kind}:${id}`;
    this.currentKey = cacheKey;
    let entry = this.cache.get(cacheKey);
    if (!entry) {
      entry = await this.load(kind, id);
      this.cache.set(cacheKey, entry);
    }
    if (this.currentKey !== cacheKey) {
      entry.root.setEnabled(false);
      return false;
    }
    this.setCurrent(entry);
    this.frameFor(kind);
    return true;
  }

  private setCurrent(entry: Entry | null): void {
    if (this.current && this.current !== entry) {
      this.current.root.setEnabled(false);
      this.current.anim?.pause();
    }
    this.current = entry;
    this.ballDisplay.setEnabled(entry?.kind === "ball");
    if (entry) {
      entry.root.setEnabled(true);
      if (entry.anim && !entry.anim.isPlaying) entry.anim.start(true, 1.0);
      else entry.anim?.restart();
    }
  }

  private frameFor(kind: ViewerKind): void {
    if (kind === "character") {
      this.camera.setTarget(new Vector3(0, 0.95, 0));
      this.camera.radius = 3.2;
      this.camera.beta = 1.25;
    } else {
      this.camera.setTarget(new Vector3(0, BALL_VIEW_Y, 0));
      this.camera.radius = 1.7;
      this.camera.beta = 1.35;
    }
    this.camera.alpha = Math.PI / 2; // face the model front
  }

  private async load(kind: ViewerKind, id: string): Promise<Entry> {
    if (kind === "ball") {
      const wrapper = await importBall(this.scene, id);
      const { min, max } = wrapper.getHierarchyBoundingVectors(true);
      const d = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
      const s = d > 0.001 ? BALL_VIEW_DIAMETER / d : 1;
      wrapper.scaling.setAll(s);
      // Re-centre the ball on the root origin so the turntable spin is in place.
      const c = max.add(min).scale(0.5);
      for (const n of wrapper.getChildren()) {
        if (n instanceof TransformNode) n.position.subtractInPlace(c);
      }
      wrapper.position.set(0, BALL_VIEW_Y, 0);
      this.addShadowCasters(wrapper);
      return { kind, root: wrapper, anim: null };
    }

    // Every source character lists jogBackward as its first glTF clip. The
    // glTF loader otherwise begins that first clip before this async method
    // returns, causing a visible jog flash behind the selector's loading state.
    // Do not supply a custom root here: doing so bypasses Babylon's automatic
    // glTF right-handed-to-scene conversion, which mirrors the kit and flips
    // its normals. The default importer root retains that conversion.
    const res = await ImportMeshAsync(`${id}.glb`, this.scene, {
      rootUrl: "/models/characters/",
      pluginOptions: {
        gltf: {
          animationStartMode: GLTFLoaderAnimationStartMode.NONE,
        },
      },
    });

    // The importer root stays disabled until its promise resolves. Reparent it
    // synchronously under our own disabled wrapper before awaiting texture
    // processing, so the ungrounded model can never render behind the loading
    // state. This preserves the importer's coordinate conversion above.
    const root = new TransformNode(`viewer-${kind}-${id}`, this.scene);
    root.setEnabled(false);
    for (const mesh of res.meshes) if (!mesh.parent) mesh.parent = root;
    // Same exporter quirk as the match loader: defaulted metallic renders the
    // skin textures nearly black without an environment map.
    fixMetallicMaterials(res.meshes);
    await maskJerseyPlaceholder(res.meshes, id);

    // Menu display clip: one of the MenuPose* clips picked at random each
    // launch (models load once per session), falling back to Idle.
    let idle: AnimationGroup | null = null;
    const poses: AnimationGroup[] = [];
    for (const g of res.animationGroups) {
      g.stop();
      const name = g.name.trim();
      if (MENU_POSE_RE.test(name)) poses.push(g);
      else if (name === "Idle") {
        idle = g;
        trimIdleTail(g);
      }
    }
    const anim = poses.length > 0 ? poses[Math.floor(Math.random() * poses.length)] : idle;

    const { min, max } = root.getHierarchyBoundingVectors(true);
    const height = (CHARACTERS.find((c) => c.id === id)?.height ?? 1.8) * CHARACTER_SCALE;
    const rawH = max.y - min.y;
    const s = rawH > 0.01 ? height / rawH : 1;
    root.scaling.setAll(s);
    root.position.y = -min.y * s;
    this.addShadowCasters(root);
    return { kind, root, anim };
  }

  /** Build a calm studio floor that gives the model room to stand out. */
  private buildStudio(): void {
    const floorMat = studioMaterial(this.scene, "viewer-floor-mat", STUDIO_FLOOR, new Color3(0.003, 0.006, 0.012), 0.04);
    const plinthMat = studioMaterial(this.scene, "viewer-plinth-mat", new Color3(0.075, 0.1, 0.145), new Color3(0.004, 0.008, 0.018), 0.22);
    const insetMat = studioMaterial(this.scene, "viewer-plinth-inset-mat", new Color3(0.07, 0.1, 0.15), new Color3(0.001, 0.004, 0.012), 0.08);
    const ballPadMat = studioMaterial(this.scene, "viewer-ball-pad-mat", STUDIO_ICE, STUDIO_ICE_GLOW, 0.12);
    ballPadMat.alpha = 0.58;

    const decorate = (mesh: Mesh, parent?: TransformNode): Mesh => {
      mesh.isPickable = false;
      if (parent) mesh.parent = parent;
      return mesh;
    };

    // A single soft floor catches the animated character's shadow without
    // turning the selector into a miniature arena.
    const floor = decorate(
      MeshBuilder.CreateDisc(
        "viewer-floor",
        { radius: 9.5, tessellation: 96, sideOrientation: Mesh.DOUBLESIDE },
        this.scene
      )
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.17;
    floor.material = floorMat;
    floor.receiveShadows = true;

    // Its top remains exactly at y=0 so character feet stay grounded.
    const plinth = decorate(
      MeshBuilder.CreateCylinder("viewer-plinth", { diameter: 2.9, height: 0.1, tessellation: 72 }, this.scene)
    );
    plinth.position.y = -0.05;
    plinth.material = plinthMat;
    plinth.receiveShadows = true;

    // An inset rather than a glowing outline keeps the pedestal clean and
    // contemporary, while still giving the standing character a subtle base.
    const plinthInset = decorate(
      MeshBuilder.CreateDisc("viewer-plinth-inset", { radius: 0.78, tessellation: 72, sideOrientation: Mesh.DOUBLESIDE }, this.scene)
    );
    plinthInset.position.y = 0.006;
    plinthInset.rotation.x = -Math.PI / 2;
    plinthInset.material = insetMat;

    // The selected ball hovers above a quiet cool-glass pad instead of an
    // oversized hoop, keeping the composition uncluttered at close range.
    const ballPad = decorate(
      MeshBuilder.CreateDisc("viewer-ball-pad", { radius: 0.38, tessellation: 64, sideOrientation: Mesh.DOUBLESIDE }, this.scene),
      this.ballDisplay
    );
    ballPad.position.y = BALL_VIEW_Y - 0.4;
    ballPad.rotation.x = -Math.PI / 2;
    ballPad.material = ballPadMat;
  }

  private addShadowCasters(root: TransformNode): void {
    for (const mesh of root.getChildMeshes(false)) {
      if (mesh.getTotalVertices() > 0) this.shadows.addShadowCaster(mesh, false);
    }
  }
}
