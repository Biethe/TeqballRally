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

export const CRESTS = ["none", "shield", "disc", "star"] as const;
export type CrestId = (typeof CRESTS)[number];

export interface Kit {
  /** Across the shoulders. Empty leaves the shirt as the artist made it. */
  name: string;
  /** Under the name. Empty means no number. */
  number: string;
  crest: CrestId;
}

export const BLANK_KIT: Kit = { name: "", number: "", crest: "none" };

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
  name: { y: 0.16, height: 0.1, width: 0.82 },
  /** Number: the big one, under the name. */
  number: { y: 0.46, height: 0.34 },
  /** Crest: small, on the wearer's left chest — the viewer's right. */
  crest: { x: 0.68, y: 0.2, size: 0.2 },
};

/** Fit text to a width by shrinking the font until it does. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startPx: number
): number {
  let px = startPx;
  ctx.font = `900 ${px}px "Arial Black", Impact, sans-serif`;
  while (px > 6 && ctx.measureText(text).width > maxWidth) {
    px -= 2;
    ctx.font = `900 ${px}px "Arial Black", Impact, sans-serif`;
  }
  return px;
}

function drawCrest(
  ctx: CanvasRenderingContext2D,
  crest: CrestId,
  cx: number,
  cy: number,
  size: number
): void {
  if (crest === "none") return;
  const r = size / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineWidth = Math.max(2, size * 0.07);
  ctx.strokeStyle = "rgba(10, 20, 36, 0.85)";
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
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

/**
 * Paint a kit onto a context already holding the shirt's own artwork.
 *
 * Exported separately from the texture plumbing so the layout can be tested,
 * and so the same code can draw a preview into a plain canvas.
 */
export function paintKit(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  kit: Kit
): void {
  const back = {
    x: BACK_PANEL.u0 * width,
    y: BACK_PANEL.v0 * height,
    w: (BACK_PANEL.u1 - BACK_PANEL.u0) * width,
    h: (BACK_PANEL.v1 - BACK_PANEL.v0) * height,
  };
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(10, 20, 36, 0.9)";
  ctx.lineJoin = "round";

  const name = kit.name.trim().toUpperCase();
  if (name) {
    const px = fitText(ctx, name, back.w * LAYOUT.name.width, back.h * LAYOUT.name.height);
    ctx.lineWidth = Math.max(2, px * 0.12);
    const x = back.x + back.w / 2;
    const y = back.y + back.h * LAYOUT.name.y;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
  }

  const number = kit.number.trim();
  if (number) {
    const px = fitText(ctx, number, back.w * 0.7, back.h * LAYOUT.number.height);
    ctx.lineWidth = Math.max(3, px * 0.1);
    const x = back.x + back.w / 2;
    const y = back.y + back.h * LAYOUT.number.y;
    ctx.strokeText(number, x, y);
    ctx.fillText(number, x, y);
  }
  ctx.restore();

  const front = {
    x: FRONT_PANEL.u0 * width,
    y: FRONT_PANEL.v0 * height,
    w: (FRONT_PANEL.u1 - FRONT_PANEL.u0) * width,
    h: (FRONT_PANEL.v1 - FRONT_PANEL.v0) * height,
  };
  drawCrest(
    ctx,
    kit.crest,
    front.x + front.w * LAYOUT.crest.x,
    front.y + front.h * LAYOUT.crest.y,
    Math.min(front.w, front.h) * LAYOUT.crest.size
  );
}

/** Storage-safe read of whatever was saved, with every field defaulted. */
export function readKit(stored: unknown): Kit {
  if (typeof stored !== "object" || stored === null) return { ...BLANK_KIT };
  const k = stored as Partial<Record<keyof Kit, unknown>>;
  const crest = CRESTS.find((c) => c === k.crest) ?? "none";
  return {
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
  type Mat = { name?: string; albedoTexture?: AlbedoTexture | null };
  interface AlbedoTexture {
    getSize(): { width: number; height: number };
    readPixels(): Promise<ArrayBufferView> | null;
    invertY: boolean;
  }
  const shirt = meshes.find((m) => (m.material as Mat | null)?.name === "shirt");
  const mat = shirt?.material as Mat | undefined;
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

  const src = new Uint8ClampedArray(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength
  );
  const flipped = new Uint8ClampedArray(src.length);
  const stride = width * 4;
  for (let row = 0; row < height; row++) {
    flipped.set(src.subarray(row * stride, row * stride + stride), (height - 1 - row) * stride);
  }
  ctx.putImageData(new ImageData(flipped, width, height), 0, 0);

  paintKit(ctx, width, height, kit);
  mat.albedoTexture = makeTexture(canvas.toDataURL(), tex.invertY) as never;
  return true;
}
