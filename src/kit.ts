/**
 * The player's own name, number and crest, painted onto the shirt.
 *
 * Not a decal. Babylon builds a decal as static geometry from the mesh's
 * *current* pose, and these characters are skinned — a decal number would sit
 * in mid-air the moment the player ran. The only thing that follows a skinned
 * mesh is its texture, so the marks are composited into the shirt's own albedo
 * and uploaded as a replacement.
 *
 * Where they go was measured rather than guessed. Painting a labelled 8x8 grid
 * onto the shirt and photographing the model from both sides showed the back
 * panel occupying cells B2-C4 and the front F2-G4 — so the shirt's two panels
 * are two vertical strips of the same texture, and everything below is
 * expressed as fractions of it.
 */
import { Color3 } from "@babylonjs/core/Maths/math.color";

/** The back panel, in texture coordinates (u right, v down: invertY is false). */
export const BACK_PANEL = { u0: 0.125, u1: 0.375, v0: 0.125, v1: 0.5 };
/** The front panel, same convention. */
export const FRONT_PANEL = { u0: 0.625, u1: 0.875, v0: 0.125, v1: 0.5 };

/**
 * The shorts, which are their own material and their own texture.
 *
 * Calibrated the same way as the shirt, with a labelled grid: seen from the
 * front, the wearer's left leg occupies columns B-C and their right F-G, both
 * over rows 2-4.
 */
export const SHORTS_LEFT_LEG = { u0: 0.125, u1: 0.375, v0: 0.125, v1: 0.5 };

/** Colours used by kit fabric and printed marks. */
export const KIT_COLOURS = [
  { id: "white", label: "WHITE", css: "#f5f7fa" },
  { id: "black", label: "BLACK", css: "#12161c" },
  { id: "gold", label: "GOLD", css: "#ffc233" },
  { id: "red", label: "RED", css: "#e23b2e" },
  { id: "blue", label: "BLUE", css: "#1a4fa3" },
  { id: "green", label: "GREEN", css: "#1e8a49" },
  { id: "royal", label: "ROYAL", css: "#0033a0" },
  { id: "navy", label: "NAVY", css: "#001f5b" },
] as const;

export type KitColourId = (typeof KIT_COLOURS)[number]["id"];

/** The CSS colour for an id, falling back to white for anything unknown. */
export function kitColour(id: KitColourId): string {
  return KIT_COLOURS.find((c) => c.id === id)?.css ?? KIT_COLOURS[0].css;
}

export const CRESTS = ["none", "shield", "disc", "star"] as const;
export type CrestId = (typeof CRESTS)[number];

export interface Kit {
  /** Across the shoulders. Empty leaves the shirt as the artist made it. */
  name: string;
  /** Under the name, on the front, and on the left leg. Empty means none. */
  number: string;
  crest: CrestId;
  /** What the marks are printed in. */
  colour: KitColourId;
  /** Optional shirt fabric tint, preserving the source texture's seams and folds. */
  shirtFabricColor?: KitColourId;
  /** Optional shorts fabric tint; also supplies a base for textureless shorts. */
  shortsFabricColor?: KitColourId;
  /** Optional override for the shorts mark colour (number). */
  shortsColor?: KitColourId;
  /** Optional override for the shorts crest colour (e.g., France has white kit but royal blue shorts badge). */
  shortsCrestColor?: KitColourId;
}

/**
 * The part of a kit that belongs to the player rather than to the character.
 *
 * `kitForCharacter` takes exactly these three and supplies the colours from the
 * roster, so this is also the whole of what has to cross the wire for an
 * opponent's shirt — and the whole of what a peer is trusted with.
 */
export type PersonalKit = Pick<Kit, "name" | "number" | "crest">;

export const BLANK_KIT: Kit = { name: "", number: "", crest: "none", colour: "white" };

/** Whether this kit would draw anything at all. */
export function kitIsBlank(kit: Kit): boolean {
  return kit.name.trim() === "" && kit.number.trim() === "" && kit.crest === "none";
}

/**
 * Where a mark sits inside a panel, as fractions of that panel.
 *
 * Kept as data so the layout can be read and adjusted without touching drawing
 * code, and so a different shirt only needs new numbers.
 */
const LAYOUT = {
  /** Name band: across the upper back, slightly higher, closer to the number. */
  name: { y: 0.35, height: 0.15, width: 0.92 },
  /** The big number: lower on the back, bigger and longer. */
  number: { y: 0.78, height: 0.6, width: 0.7 },
  /** The front number: high on the torso, clear of the waist, and smaller than the back's. */
  frontNumber: { y: 0.64, height: 0.48, width: 0.45 },
  /** Crest: top left of the jersey. */
  crest: { x: 0.24, y: 0.24, size: 0.2 },
  /** Shorts: crest on upper thigh, number on mid-thigh. */
  shortsNumber: { x: 0.5, y: 0.65, height: 0.24, width: 0.6 },
  shortsCrest: { x: 0.5, y: 0.43, size: 0.16 },
};

/** A `#rrggbb` colour as three 0-255 channels. */
function channels(css: string): [number, number, number] {
  const hex = css.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Rec. 601 luma of a `#rrggbb` colour, 0..1. Cheap, and enough to rank tones. */
function lumaOf(css: string): number {
  const [r, g, b] = channels(css);
  return (r * 299 + g * 587 + b * 114) / 255000;
}

/**
 * Average luma of the artwork inside a rectangle, 0..1.
 *
 * Sampled from the canvas the shirt has already been copied onto, so it is the
 * real cloth under the mark — panel colour, trim, whatever the artist painted
 * — rather than a guess about it.
 */
function lumaUnder(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number
): number {
  const x = Math.max(0, Math.round(cx - w / 2));
  const y = Math.max(0, Math.round(cy - h / 2));
  const data = ctx.getImageData(x, y, Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114;
  }
  return data.length === 0 ? 0.5 : sum / ((data.length / 4) * 255000);
}

/** Fit text to a width by shrinking the font until it does. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startPx: number
): number {
  // The game's own Exo 2, which is always bundled — the reference kits set
  // their names and numbers in one heavy, normal-width sans, and the previous
  // condensed stack (Arial Narrow, Impact) is what made the print look pasted
  // on from a different sport.
  const face = '"Exo 2", "Arial Black", Arial, sans-serif';
  let px = startPx;
  ctx.font = `900 ${px}px ${face}`;
  while (px > 6 && ctx.measureText(text).width > maxWidth) {
    px -= 2;
    ctx.font = `900 ${px}px ${face}`;
  }
  return px;
}

function drawCrest(
  ctx: CanvasRenderingContext2D,
  crest: CrestId,
  cx: number,
  cy: number,
  size: number,
  colour: string
): void {
  if (crest === "none") return;
  const r = size / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineWidth = Math.max(3, size * 0.08);
  ctx.strokeStyle = "rgba(10, 20, 36, 0.95)";
  ctx.fillStyle = colour;
  ctx.beginPath();
  if (crest === "disc") {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  } else if (crest === "shield") {
    ctx.moveTo(-r, -r);
    ctx.lineTo(r, -r);
    ctx.lineTo(r, r * 0.25);
    ctx.quadraticCurveTo(r * 0.5, r, 0, r);
    ctx.quadraticCurveTo(-r * 0.5, r, -r, r * 0.25);
    ctx.closePath();
  } else {
    // A five-point star, drawn from its own maths so it needs no font.
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? r : r * 0.45;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const x = Math.cos(a) * radius;
      const y = Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A rectangle of texture, in pixels. */
interface Panel {
  x: number;
  y: number;
  w: number;
  h: number;
}

const panelOf = (
  p: { u0: number; u1: number; v0: number; v1: number },
  width: number,
  height: number
): Panel => ({
  x: p.u0 * width,
  y: p.v0 * height,
  w: (p.u1 - p.u0) * width,
  h: (p.v1 - p.v0) * height,
});

/**
 * Print one piece of text the way the reference kits print theirs: one flat,
 * fully opaque colour and nothing else.
 *
 * The previous version dressed every mark in a contrast halo, a drop shadow
 * and a vertical gradient, and that costume is exactly what made the print
 * read as a sticker laid over the shirt — the supplied national kits
 * (Brazil.glb and friends) set a plain green NAME and 7 straight onto the
 * yellow, and they read as printed cloth precisely because nothing lifts them
 * off it.
 *
 * The one thing flat ink cannot do is survive being the same tone as the
 * shirt — the player picks the colour, so white on a white kit has to remain
 * legible. The cloth under the mark is *measured* (not assumed), and only
 * when the two tones genuinely sink together does a thin keyline in the
 * opposite tone appear. On any sane pairing the mark is ink and nothing more.
 */
function stamp(
  ctx: CanvasRenderingContext2D,
  text: string,
  panel: Panel,
  at: { x?: number; y: number; height: number },
  maxWidthFraction: number,
  colour: string
): void {
  const px = fitText(ctx, text, panel.w * maxWidthFraction, panel.h * at.height);
  const x = panel.x + panel.w * (at.x ?? 0.5);
  const y = panel.y + panel.h * at.y;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const width = ctx.measureText(text).width;
  const cloth = lumaUnder(ctx, x, y, Math.max(width, px), px);
  const ink = lumaOf(colour);
  // Increased threshold from 0.22 to 0.30 for more aggressive contrast correction
  if (Math.abs(cloth - ink) < 0.30) {
    ctx.lineWidth = px * 0.08;
    // Force dark stroke on light kits, white stroke on dark kits
    ctx.strokeStyle = ink > 0.55 ? "rgba(10, 20, 28, 0.95)" : "rgba(255, 255, 255, 0.95)";
    ctx.strokeText(text, x, y);
  }

  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Paint the shirt: the name and the big number on the back, a smaller number
 * on the front at the same height, and the crest at the top left.
 */
export function paintKit(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  kit: Kit
): void {
  const back = panelOf(BACK_PANEL, width, height);
  const front = panelOf(FRONT_PANEL, width, height);
  const colour = kitColour(kit.colour);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(10, 20, 36, 0.9)";
  ctx.lineJoin = "round";

  const name = kit.name.trim().toUpperCase();
  if (name) {
    // Tracked out the way the reference kits set theirs. `letterSpacing` is
    // missing from older WebViews; without it the name is simply set solid.
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    const supported = "letterSpacing" in spaced;
    if (supported) spaced.letterSpacing = `${Math.round(back.h * LAYOUT.name.height * 0.14)}px`;
    stamp(ctx, name, back, LAYOUT.name, LAYOUT.name.width, colour);
    if (supported) spaced.letterSpacing = "0px";
  }

  const number = kit.number.trim();
  if (number) {
    stamp(ctx, number, back, LAYOUT.number, 0.7, colour);
    // The front carries the same number at the same height up the body, and
    // smaller — which is how a real shirt is printed.
    stamp(ctx, number, front, LAYOUT.frontNumber, LAYOUT.frontNumber.width, colour);
  }
  ctx.restore();

  drawCrest(
    ctx,
    kit.crest,
    front.x + front.w * LAYOUT.crest.x,
    front.y + front.h * LAYOUT.crest.y,
    Math.min(front.w, front.h) * LAYOUT.crest.size,
    colour
  );
}

/**
 * Paint the shorts: the number low on the wearer's left leg, crest under it.
 *
 * A separate texture from the shirt, so a separate pass — the two materials
 * have nothing to do with each other beyond both being this player's kit.
 */
export function paintShorts(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  kit: Kit
): void {
  const leg = panelOf(SHORTS_LEFT_LEG, width, height);
  const shortsColour = kitColour(kit.shortsColor ?? kit.colour);
  const shortsCrestColour = kitColour(kit.shortsCrestColor ?? kit.colour);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(10, 20, 36, 0.9)";
  ctx.lineJoin = "round";
  const number = kit.number.trim();
  if (number) stamp(ctx, number, leg, LAYOUT.shortsNumber, 0.42, shortsColour);
  ctx.restore();

  drawCrest(
    ctx,
    kit.crest,
    leg.x + leg.w * LAYOUT.shortsCrest.x,
    leg.y + leg.h * LAYOUT.shortsCrest.y,
    Math.min(leg.w, leg.h) * LAYOUT.shortsCrest.size,
    shortsCrestColour
  );
}

/** Storage-safe read of whatever was saved, with every field defaulted. */
export function readKit(stored: unknown): Kit {
  if (typeof stored !== "object" || stored === null) return { ...BLANK_KIT };
  const k = stored as Partial<Record<keyof Kit, unknown>>;
  const crest = CRESTS.find((c) => c === k.crest) ?? "none";
  const colour = KIT_COLOURS.find((c) => c.id === k.colour)?.id ?? BLANK_KIT.colour;
  const shortsColor = KIT_COLOURS.find((c) => c.id === k.shortsColor)?.id;
  const shortsCrestColor = KIT_COLOURS.find((c) => c.id === k.shortsCrestColor)?.id;
  return {
    colour,
    shortsColor,
    shortsCrestColor,
    // Capped here rather than only at the input, because storage outlives any
    // validation the screen that wrote it happened to be doing that week.
    name: typeof k.name === "string" ? k.name.slice(0, 12) : "",
    number: typeof k.number === "string" ? k.number.replace(/\D/g, "").slice(0, 2) : "",
    crest,
  };
}

/**
 * Repaint a character's shirt with this kit.
 *
 * The shirt's own artwork has to come back off the GPU first: the glTF loader
 * keeps its images inside the .glb, so `texture.url` is
 * `data:/models/…glb#image3` — a name, not something that can be fetched. That
 * leaves `readPixels`, which hands back rows bottom-up the way WebGL always
 * has, so they are flipped on the way into the canvas.
 *
 * Does nothing, quietly, if the model has no shirt or the kit is blank. A
 * cosmetic that cannot be applied must never stop a match starting.
 */
export async function applyKit(
  meshes: { name: string; material: unknown }[],
  kit: Kit,
  makeTexture: (dataUrl: string, invertY: boolean) => unknown
): Promise<boolean> {
  if (kitIsBlank(kit)) return false;
  // The print is set in the game's own bundled face, and a canvas silently
  // substitutes the fallback for a font that has not finished loading — which
  // on a cold start is exactly when a match is being built.
  try {
    if (typeof document !== "undefined" && "fonts" in document) {
      await document.fonts.load('900 64px "Exo 2"');
    }
  } catch {
    // No FontFaceSet: the fallback stack prints instead, which still works.
  }
  let painted = false;
  // The shirt and the shorts are separate materials with separate textures.
  // A glTF is allowed to omit the latter (England does), so a requested fabric
  // colour becomes its own canvas base rather than silently losing the print.
  for (const [material, paint, fabric] of [
    ["shirt", paintKit, kit.shirtFabricColor],
    ["pants", paintShorts, kit.shortsFabricColor],
  ] as const) {
    if (fabric) tintFabric(meshes, material, fabric);
    if (await repaint(meshes, material, kit, paint, makeTexture, fabric)) painted = true;
  }
  return painted;
}

type Painter = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  kit: Kit
) => void;

interface AlbedoTexture {
  getSize(): { width: number; height: number };
  readPixels(): Promise<ArrayBufferView> | null;
  invertY: boolean;
}
type Mat = {
  name?: string;
  albedoTexture?: AlbedoTexture | null;
  emissiveTexture?: unknown;
  albedoColor?: Color3;
  emissiveColor?: Color3;
};

/** The material's colour multiplier tints an artwork texture without erasing its folds. */
function tintFabric(meshes: { name: string; material: unknown }[], materialName: string, fabric: KitColourId): void {
  const mat = garmentMaterial(meshes, materialName);
  if (!mat?.albedoColor) return;
  const colour = Color3.FromHexString(kitColour(fabric));
  mat.albedoColor = colour;
  // `brightenKit` installs the original cloth as a dim emissive texture. Give
  // that lift the same hue so it cannot bleach a dark-blue kit back to white.
  mat.emissiveColor = colour.scale(0.16);
}

function garmentMaterial(meshes: { name: string; material: unknown }[], materialName: string): Mat | undefined {
  const owner = meshes.find((m) => {
    const matName = (m.material as Mat | null)?.name?.toLowerCase() || "";
    return matName.includes(materialName.toLowerCase());
  });
  return owner?.material as Mat | undefined;
}

/** Composite one garment's marks into its own albedo and hand it back. */
async function repaint(
  meshes: { name: string; material: unknown }[],
  materialName: string,
  kit: Kit,
  paint: Painter,
  makeTexture: (dataUrl: string, invertY: boolean) => unknown,
  fallbackFabric?: KitColourId
): Promise<boolean> {
  const mat = garmentMaterial(meshes, materialName);
  const tex = mat?.albedoTexture;
  if (!mat) return false;
  if (!tex && !fallbackFabric) return false;

  const { width, height } = tex?.getSize() ?? { width: 1024, height: 1024 };

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  if (tex) {
    const pixels = await tex.readPixels();
    if (!pixels) return false;
    const src = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const out = new Uint8ClampedArray(src.length);
    const stride = width * 4;
    for (let row = 0; row < height; row++) {
      const from = row * stride;
      // Not flipped. `readPixels` is documented as bottom-up and that is what
      // the first version assumed, but these textures were uploaded with
      // invertY false, so what comes back is already in image order.
      const to = row * stride;
      for (let i = 0; i < stride; i += 4) {
        out[to + i] = src[from + i];
        out[to + i + 1] = src[from + i + 1];
        out[to + i + 2] = src[from + i + 2];
        // Forced opaque. The kit textures carry an alpha channel that the
        // original material ignores, and a canvas PNG hands that alpha back.
        out[to + i + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(out, width, height), 0, 0);
  } else {
    // England's shorts are colour-only in the source GLB. Give their UVs a
    // solid cloth first, then paint the same marks every textured kit gets.
    ctx.fillStyle = kitColour(fallbackFabric!);
    ctx.fillRect(0, 0, width, height);
  }

  paint(ctx, width, height, kit);
  const painted = makeTexture(canvas.toDataURL(), tex?.invertY ?? false) as Record<string, unknown>;
  // A replacement texture starts with Babylon's defaults, not the ones the
  // glTF gave this one. Anything left behind here shows up as the garment
  // being tiled, offset, or lit differently from the rest of the model.
  // Deliberately not `gammaSpace`: a canvas is always sRGB, so the replacement
  // must be read as sRGB whatever the original was. Inheriting a linear flag
  // told Babylon not to decode it and washed the garment out.
  for (const key of ["coordinatesIndex", "wrapU", "wrapV", "uScale", "vScale", "uOffset", "vOffset", "level"] as const) {
    const value = (tex as unknown as Record<string, unknown> | undefined)?.[key];
    if (value !== undefined) painted[key] = value;
  }
  painted.hasAlpha = false;
  mat.albedoTexture = painted as never;
  if (!tex) {
    // The navy pixels are now the base colour; multiplying them by the
    // material's navy tint a second time would turn the shorts near-black.
    mat.albedoColor = Color3.White();
    mat.emissiveTexture = painted;
  }
  return true;
}
