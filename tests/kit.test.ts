import { describe, expect, it } from "vitest";
import {
  BACK_PANEL,
  BLANK_KIT,
  CRESTS,
  FRONT_PANEL,
  SHORTS_LEFT_LEG,
  kitColour,
  kitIsBlank,
  paintKit,
  paintShorts,
  readKit,
  type Kit,
} from "../src/kit";

/**
 * The shirt printer.
 *
 * The panel coordinates were measured off a calibration render — an 8x8
 * labelled grid painted onto the shirt and photographed from both sides —
 * so what is worth holding here is that nothing drifts outside the panel it
 * was measured into. Text that escapes the back panel lands on a sleeve, or on
 * the front, and nobody notices until it is on a phone.
 */

/** A canvas context stub that records where it was asked to draw. */
/** The px size out of a CSS font shorthand like `900 48px "Arial Black"`. */
function fontPx(font: string): number {
  return Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
}

function recorder(clothLuma = 0.5) {
  const strokes: { text: string; x: number; y: number }[] = [];
  const fills: { text: string; x: number; y: number }[] = [];
  const translations: { x: number; y: number }[] = [];
  /** Font size at each fill, so "smaller on the front" can be checked. */
  const sizes: number[] = [];
  /** Every fill colour used, so the colour choice can be checked. */
  const colours: string[] = [];
  /** Every stroke colour used, so the contrast keyline can be checked. */
  const strokeColours: string[] = [];
  /** The cloth the printer measures under a mark, as one flat grey. */
  const grey = Math.round(clothLuma * 255);
  const ctx = {
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = grey;
        data[i + 1] = grey;
        data[i + 2] = grey;
        data[i + 3] = 255;
      }
      return { data };
    },
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    textAlign: "",
    textBaseline: "",
    save: () => {},
    restore: () => {},
    translate: (x: number, y: number) => translations.push({ x, y }),
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    quadraticCurveTo: () => {},
    fill: () => {},
    stroke: () => {},
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    miterLimit: 0,
    // The fill is a gradient now, so the chosen colour arrives as a stop
    // rather than as fillStyle.
    createLinearGradient: () => ({
      addColorStop: (_at: number, colour: string) => colours.push(colour),
    }),
    // Width scales with the font size the code just set, so the fitter shrinks.
    // The size is read out of the shorthand rather than off the front of it:
    // the font string starts with the weight, so parseInt would return 900.
    measureText: (t: string) => ({ width: t.length * fontPx(ctx.font) * 0.6 }),
    strokeText: (text: string, x: number, y: number) => {
      strokes.push({ text, x, y });
      strokeColours.push(String(ctx.strokeStyle));
    },
    fillText: (text: string, x: number, y: number) => {
      fills.push({ text, x, y });
      sizes.push(fontPx(ctx.font));
      colours.push(String(ctx.fillStyle));
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, fills, translations, sizes, colours, strokeColours };
}

const SIZE = 1024;
const kit = (over: Partial<Kit> = {}): Kit => ({ ...BLANK_KIT, ...over });

describe("what counts as a kit", () => {
  it("treats an untouched kit as nothing to print", () => {
    expect(kitIsBlank(BLANK_KIT)).toBe(true);
    expect(kitIsBlank(kit({ name: "  " }))).toBe(true);
  });

  it("notices any one mark", () => {
    expect(kitIsBlank(kit({ name: "ADA" }))).toBe(false);
    expect(kitIsBlank(kit({ number: "9" }))).toBe(false);
    expect(kitIsBlank(kit({ crest: "star" }))).toBe(false);
  });
});

describe("reading a stored kit", () => {
  it("survives anything that is not a kit", () => {
    expect(readKit(null)).toEqual(BLANK_KIT);
    expect(readKit("nonsense")).toEqual(BLANK_KIT);
    expect(readKit({ name: 7, number: [], crest: "octagon" })).toEqual(BLANK_KIT);
  });

  it("caps what a shirt can physically carry", () => {
    // Storage outlives whatever the entry screen was validating that week.
    const long = readKit({ name: "A".repeat(50), number: "12345" });

    expect(long.name).toHaveLength(12);
    expect(long.number).toBe("12");
  });

  it("keeps a crest it recognises", () => {
    for (const crest of CRESTS) expect(readKit({ crest }).crest).toBe(crest);
  });

  it("drops anything that is not a digit from the number", () => {
    expect(readKit({ number: "n9x" }).number).toBe("9");
  });
});

describe("where the marks land", () => {
  const back = {
    x0: BACK_PANEL.u0 * SIZE,
    x1: BACK_PANEL.u1 * SIZE,
    y0: BACK_PANEL.v0 * SIZE,
    y1: BACK_PANEL.v1 * SIZE,
  };

  const front = {
    x0: FRONT_PANEL.u0 * SIZE,
    x1: FRONT_PANEL.u1 * SIZE,
  };

  it("puts the name and the big number inside the back panel", () => {
    const { ctx, fills } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ name: "BIERHOFF", number: "10" }));

    // Name and number on the back, and the number again on the front.
    const onBack = fills.filter((m) => m.x > back.x0 && m.x < back.x1);
    expect(onBack).toHaveLength(2);
    for (const mark of onBack) {
      expect(mark.y, `${mark.text} vertically`).toBeGreaterThan(back.y0);
      expect(mark.y, `${mark.text} vertically`).toBeLessThan(back.y1);
    }
  });

  it("prints the number on the front as well, and smaller", () => {
    const { ctx, fills, sizes } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ number: "10" }));

    const onBack = fills.findIndex((m) => m.x > back.x0 && m.x < back.x1);
    const onFront = fills.findIndex((m) => m.x > front.x0 && m.x < front.x1);
    expect(onBack, "a number on the back").toBeGreaterThanOrEqual(0);
    expect(onFront, "a number on the front").toBeGreaterThanOrEqual(0);
    expect(sizes[onFront]).toBeLessThan(sizes[onBack]);
  });

  it("puts a slightly larger front number higher on the torso", () => {
    const { ctx, fills, sizes } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ number: "7" }));

    const onFront = fills.findIndex((m) => m.x > front.x0 && m.x < front.x1);
    const frontTop = FRONT_PANEL.v0 * SIZE;
    const frontHeight = (FRONT_PANEL.v1 - FRONT_PANEL.v0) * SIZE;
    expect(fills[onFront].y).toBeLessThan(frontTop + frontHeight * 0.7);
    expect(sizes[onFront]).toBeGreaterThan(frontHeight * 0.45);
  });

  it("prints the number low on the back rather than between the shoulders", () => {
    const { ctx, fills } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ name: "ADA", number: "7" }));
    const [name, number] = fills;

    // Below the halfway line of the panel — the complaint was that it sat high.
    expect(number.y).toBeGreaterThan(back.y0 + (back.y1 - back.y0) * 0.5);
    expect(number.y).toBeGreaterThan(name.y);
  });

  it("puts a number and a crest on the shorts", () => {
    const { ctx, fills } = recorder();
    paintShorts(ctx, SIZE, SIZE, kit({ number: "7", crest: "shield" }));

    expect(fills).toHaveLength(1);
    const leg = { x0: SHORTS_LEFT_LEG.u0 * SIZE, x1: SHORTS_LEFT_LEG.u1 * SIZE };
    expect(fills[0].x).toBeGreaterThan(leg.x0);
    expect(fills[0].x).toBeLessThan(leg.x1);
  });

  it("keeps the shorts badge close to the number without overlapping it", () => {
    const { ctx, fills, translations } = recorder();
    paintShorts(ctx, SIZE, SIZE, kit({ number: "7", crest: "shield" }));

    const legTop = SHORTS_LEFT_LEG.v0 * SIZE;
    const legHeight = (SHORTS_LEFT_LEG.v1 - SHORTS_LEFT_LEG.v0) * SIZE;
    expect(fills[0].y - translations[0].y).toBeCloseTo(legHeight * 0.22, 6);
    expect(translations[0].y - legTop).toBeCloseTo(legHeight * 0.43, 6);
  });

  it("prints in the colour that was chosen", () => {
    const { ctx, colours } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ number: "7", colour: "gold" }));

    expect(colours).toContain(kitColour("gold"));
  });

  it("prints flat ink when the colour reads against the cloth", () => {
    // The reference kits print one flat colour and nothing else, and the
    // sticker look this replaced came from dressing every mark up regardless.
    const { ctx, strokes, fills } = recorder(0.15); // dark cloth
    paintKit(ctx, SIZE, SIZE, kit({ number: "7", colour: "white" }));

    expect(fills.length).toBeGreaterThan(0);
    expect(strokes.filter((s) => s.text === "7")).toHaveLength(0);
  });

  it("keylines only the print that would sink into the cloth", () => {
    // The player picks the colour, so white on a white shirt has to survive —
    // and it is the measured cloth, not the colour name, that decides.
    const light = recorder(0.92); // white cloth, white ink
    paintKit(light.ctx, SIZE, SIZE, kit({ number: "7", colour: "white" }));
    const dark = recorder(0.08); // dark cloth, black ink
    paintKit(dark.ctx, SIZE, SIZE, kit({ number: "7", colour: "black" }));

    // Light cloth + white ink -> dark keyline (rgba(10, 20, 28, 0.95))
    // Dark cloth + black ink -> light keyline (rgba(255, 255, 255, 0.95))
    expect(light.strokeColours.some((c) => /10, 20, 28/.test(c))).toBe(true);
    expect(dark.strokeColours.some((c) => /255, 255, 255/.test(c))).toBe(true);
  });

  it("puts the number below the name", () => {
    // A shirt with the number above the name is not a shirt anyone has seen.
    const { ctx, fills } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ name: "ADA", number: "7" }));
    const [name, number] = fills;

    expect(number.y).toBeGreaterThan(name.y);
  });

  it("centres both on the same vertical line", () => {
    const { ctx, fills } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ name: "ADA", number: "7" }));

    expect(fills[0].x).toBeCloseTo(fills[1].x, 6);
  });

  it("keeps a long name inside the panel by shrinking it", () => {
    // The fitter is the only thing standing between a twelve-letter name and
    // the sleeves, and every character is allowed twelve.
    const { ctx, fills } = recorder();
    paintKit(ctx, SIZE, SIZE, kit({ name: "M".repeat(12) }));

    const px = fontPx(String(ctx.font));
    // Updated from 0.82 to 0.92 to match increased name width in LAYOUT
    expect(px * 0.6 * 12).toBeLessThanOrEqual((back.x1 - back.x0) * 0.92 + 1);
    expect(fills[0].x).toBeGreaterThan(back.x0);
  });

  it("draws nothing at all for a blank kit", () => {
    const { ctx, fills, strokes } = recorder();
    paintKit(ctx, SIZE, SIZE, BLANK_KIT);

    expect(fills).toHaveLength(0);
    expect(strokes).toHaveLength(0);
  });

  it("keeps the panels apart", () => {
    // Back and front are two strips of one texture; if they ever overlap, a
    // name prints through onto the chest.
    expect(BACK_PANEL.u1).toBeLessThan(FRONT_PANEL.u0);
  });
});
