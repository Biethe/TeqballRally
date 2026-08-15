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

/** What the printed marks are made of. */
export const KIT_COLOURS = [
  { id: "white", label: "WHITE", css: "#f5f7fa" },
  { id: "black", label: "BLACK", css: "#12161c" },
  { id: "gold", label: "GOLD", css: "#ffc233" },
  { id: "red", label: "RED", css: "#e23b2e" },
  { id: "blue", label: "BLUE", css: "#2f7ad6" },
  { id: "green", label: "GREEN", css: "#39b56a" },
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
}

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
  /** Name band: across the upper back, clear of the collar. */
  name: { y: 0.13, height: 0.11, width: 0.84 },
  /** The big number: low on the back, and the largest thing on the shirt. */
  number: { y: 0.72, height: 0.46 },
  /** The front number: lower than the chest, and smaller than the back's. */
  frontNumber: { y: 0.72, height: 0.28 },
  /** Crest: top left of the jersey. */
  crest: { x: 0.24, y: 0.24, size: 0.2 },
  /** Shorts: number on the left leg, crest under it. */
  shortsNumber: { x: 0.5, y: 0.62, height: 0.22 },
  shortsCrest: { x: 0.5, y: 0.86, size: 0.14 },
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

/**
 * Near-black for a light print, near-white for a dark one.
 *
 * The halo behind the print has to be the opposite of it, because the player
 * chooses the print colour and the kit colour is whatever the character wears:
 * white on a white shirt and black on a navy one are both invisible, and a
 * single fixed outline colour can only ever fix one of them.
 */
function contrastOf(css: string): string {
  const [r, g, b] = channels(css);
  // Rec. 601 luma: close enough for deciding light from dark, and cheap.
  const luma = (r * 299 + g * 587 + b * 114) / 255000;
  return luma > 0.55 ? "rgba(14, 18, 26, 0.95)" : "rgba(246, 249, 255, 0.95)";
}

/** Move a colour toward white (positive) or black (negative). */
function lighten(css: string, amount: number): string {
  const mix = (c: number) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  const [r, g, b] = channels(css).map(mix);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Fit text to a width by shrinking the font until it does. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startPx: number
): number {
  // Condensed, heavy, and wide-tracked: a squad number is set to be read from
  // the back of a stand, and the stack falls back through the faces most
  // likely to exist on a phone before it lands on plain sans.
  const face = '"Arial Narrow", "Haettenschweiler", Impact, "Arial Black", sans-serif';
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
  ctx.lineWidth = Math.max(2, size * 0.07);
  ctx.strokeStyle = "rgba(10, 20, 36, 0.85)";
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
 * Print one piece of text, the way a shirt is actually printed.
 *
 * Four passes, and each earns its place. A drop shadow lifts the print off the
 * cloth. A dark keyline holds the shape against a light kit, and a second,
 * wider halo in the *contrast* colour holds it against a dark one — without
 * that pair, white on white and black on navy are both invisible, and the
 * player picks the colour. The fill is a vertical gradient rather than a flat
 * colour: real flock and heat-press both catch the light along the top edge,
 * and it is the single cheapest thing that stops the print looking like a
 * screenshot of a text box.
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

  // The halo: the opposite of the print, so it reads on a kit of either
  // brightness without the player having to think about it.
  ctx.lineWidth = px * 0.26;
  ctx.strokeStyle = contrastOf(colour);
  ctx.strokeText(text, x, y);

  // Shadow, thrown down and slightly right, under the keyline so the keyline
  // stays crisp.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = px * 0.14;
  ctx.shadowOffsetX = px * 0.05;
  ctx.shadowOffsetY = px * 0.07;
  ctx.lineWidth = px * 0.13;
  ctx.strokeStyle = "rgba(12, 16, 22, 0.92)";
  ctx.strokeText(text, x, y);
  ctx.restore();

  // The fill, brighter along the top edge.
  const gradient = ctx.createLinearGradient(0, y - px * 0.6, 0, y + px * 0.6);
  gradient.addColorStop(0, lighten(colour, 0.28));
  gradient.addColorStop(0.55, colour);
  gradient.addColorStop(1, lighten(colour, -0.18));
  ctx.fillStyle = gradient;
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
  if (name) stamp(ctx, name, back, LAYOUT.name, LAYOUT.name.width, colour);

  const number = kit.number.trim();
  if (number) {
    stamp(ctx, number, back, LAYOUT.number, 0.7, colour);
    // The front carries the same number at the same height up the body, and
    // smaller — which is how a real shirt is printed.
    stamp(ctx, number, front, LAYOUT.frontNumber, 0.4, colour);
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
  const colour = kitColour(kit.colour);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(10, 20, 36, 0.9)";
  ctx.lineJoin = "round";
  const number = kit.number.trim();
  if (number) stamp(ctx, number, leg, LAYOUT.shortsNumber, 0.42, colour);
  ctx.restore();

  drawCrest(
    ctx,
    kit.crest,
    leg.x + leg.w * LAYOUT.shortsCrest.x,
    leg.y + leg.h * LAYOUT.shortsCrest.y,
    Math.min(leg.w, leg.h) * LAYOUT.shortsCrest.size,
    colour
  );
}

/** Storage-safe read of whatever was saved, with every field defaulted. */
export function readKit(stored: unknown): Kit {
  if (typeof stored !== "object" || stored === null) return { ...BLANK_KIT };
  const k = stored as Partial<Record<keyof Kit, unknown>>;
  const crest = CRESTS.find((c) => c === k.crest) ?? "none";
  const colour = KIT_COLOURS.find((c) => c.id === k.colour)?.id ?? BLANK_KIT.colour;
  return {
    colour,
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
  let painted = false;
  // The shirt and the shorts are separate materials with separate textures.
  for (const [material, paint] of [
    ["shirt", paintKit],
    ["Pants", paintShorts],
  ] as const) {
    if (await repaint(meshes, material, kit, paint, makeTexture)) painted = true;
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
type Mat = { name?: string; albedoTexture?: AlbedoTexture | null };

/** Composite one garment's marks into its own albedo and hand it back. */
async function repaint(
  meshes: { name: string; material: unknown }[],
  materialName: string,
  kit: Kit,
  paint: Painter,
  makeTexture: (dataUrl: string, invertY: boolean) => unknown
): Promise<boolean> {
  const owner = meshes.find((m) => (m.material as Mat | null)?.name === materialName);
  const mat = owner?.material as Mat | undefined;
  const tex = mat?.albedoTexture;
  if (!mat || !tex) return false;

  const { width, height } = tex.getSize();
  const pixels = await tex.readPixels();
  if (!pixels) return false;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  const src = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const out = new Uint8ClampedArray(src.length);
  const stride = width * 4;
  for (let row = 0; row < height; row++) {
    const from = row * stride;
    // Not flipped. `readPixels` is documented as bottom-up and that is what
    // the first version assumed, but these textures were uploaded with
    // invertY false, so what comes back is already in image order. Flipping it
    // landed the texture's black UV gutter over the body panels — which is the
    // dark band that appeared across the shoulders and down the shorts, while
    // the printed marks stayed correctly placed because they are drawn in
    // canvas space afterwards.
    const to = row * stride;
    for (let i = 0; i < stride; i += 4) {
      out[to + i] = src[from + i];
      out[to + i + 1] = src[from + i + 1];
      out[to + i + 2] = src[from + i + 2];
      // Forced opaque. The kit textures carry an alpha channel that the
      // original material ignores, and a canvas PNG hands that alpha back to
      // Babylon — which then blends the shirt against the scene wherever the
      // artist happened to leave it low. That is what put a dark band across
      // the shoulders and black panels down the shorts.
      out[to + i + 3] = 255;
    }
  }
  ctx.putImageData(new ImageData(out, width, height), 0, 0);

  paint(ctx, width, height, kit);
  const painted = makeTexture(canvas.toDataURL(), tex.invertY) as Record<string, unknown>;
  // A replacement texture starts with Babylon's defaults, not the ones the
  // glTF gave this one. Anything left behind here shows up as the garment
  // being tiled, offset, or lit differently from the rest of the model.
  // Deliberately not `gammaSpace`: a canvas is always sRGB, so the replacement
  // must be read as sRGB whatever the original was. Inheriting a linear flag
  // told Babylon not to decode it and washed the garment out.
  for (const key of ["coordinatesIndex", "wrapU", "wrapV", "uScale", "vScale", "uOffset", "vOffset", "level"] as const) {
    const value = (tex as unknown as Record<string, unknown>)[key];
    if (value !== undefined) painted[key] = value;
  }
  painted.hasAlpha = false;
  mat.albedoTexture = painted as never;
  return true;
}
