/**
 * Venues: a backdrop model paired with a procedural court that suits it.
 *
 * The court the game is *played* on is always procedural — the floor, the
 * three lines and the perimeter boards are built in `buildCourt`. A venue only
 * decides what that court looks like and what stands around it, so adding a
 * venue is a palette plus a GLB, never a change to how the game plays.
 *
 * Nothing here touches gameplay. The bounds players move inside (`COURT.minX`,
 * `maxX`, `maxZ` in `config.ts`) and `GROUND_Y` are the same in every venue,
 * which is what lets two peers on different venues share one simulation: the
 * host and the guest can be looking at a basketball hall and a football
 * stadium and still agree on every position.
 */

export type VenueId = "gym" | "basketball" | "football" | "tennis";

export const VENUE_IDS: VenueId[] = ["gym", "basketball", "football", "tennis"];

/** An RGB triple in 0..1, kept plain so this module stays free of Babylon. */
export type Rgb = readonly [number, number, number];

export interface ArenaModel {
  /** File under `assets/models/Arena/`. */
  file: string;
  /** The model's longest horizontal side is scaled to this many metres. */
  span: number;
  /** Shift along the table axis (+x = toward the far side). */
  offsetX: number;
  /** Raise/lower the whole model; 0 puts its lowest point on the ground. */
  offsetY: number;
  /** Shift laterally (+z = to the controlled player's left). */
  offsetZ: number;
  /** Radians about the vertical axis, to line the model's court up with ours. */
  rotationY: number;
  /**
   * Scenery to drop, named by the material it uses. For things that sit in the
   * way rather than around: the tennis court's own net stands at x = 0,
   * exactly the plane the ball crosses, and reading the ball through it is
   * worse than not having it.
   *
   * By material rather than by mesh because the compression pass merges the
   * model down to one mesh per material — mesh names do not survive that,
   * material names do (`gltfpack -km`).
   */
  hideMaterials?: string[];
}

export interface CourtStyle {
  /**
   * Where the players stand.
   *
   * "own" paints a floor slab in `floor`. "venue" leaves the backdrop's own
   * surface — blacktop, grass, hard court — showing through and draws only the
   * lines on it, which is what makes three venues look like three places
   * rather than one court with three wallpapers. A "venue" court still falls
   * back to painting `floor` when the backdrop is not loaded, so the LOW tier
   * is never left standing on nothing.
   */
  surface: "own" | "venue";
  /** "oval" fits a gymnasium's rounded side band; "rect" is the classic court. */
  shape: "oval" | "rect";
  /** Low perimeter boards. Off where the venue already borders the play space. */
  boards: boolean;
  /** Floor half-extent along the table axis, in metres. */
  halfLen: number;
  /** Floor half-extent across, in metres. */
  halfWid: number;
  floor: Rgb;
  line: Rgb;
  board: Rgb;
}

export interface Venue {
  id: VenueId;
  label: string;
  sub: string;
  /** null renders the court alone — also what every tier without `arena` gets. */
  arena: ArenaModel | null;
  court: CourtStyle;
  /**
   * What fills the frame behind everything. The outdoor models have no sky of
   * their own, and against the indoor near-black they read as a court floating
   * in space; a clear colour is the whole fix and costs nothing.
   */
  sky: Rgb;
}

/**
 * The three outdoor models are one export family sharing a scene template, and
 * they are authored in metres: a 28.8 x 20.3 m site with a 20.8 x 12.2 m
 * playing surface whose top sits 0.6 m above the model's lowest point. So they
 * take the same three numbers — `span` at the model's own extent to keep 1:1
 * scale, and `offsetY` of -0.6 to land that surface exactly on `GROUND_Y`
 * instead of the site's foundation. Only the palette and the boards differ.
 *
 * The indoor gym has no such structure and keeps its hand-tuned numbers.
 */
const OUTDOOR = { span: 28.8, offsetX: 0, offsetY: -0.6, offsetZ: 0, rotationY: 0 };

/**
 * A 16 x 10.4 m court fits inside the outdoor playing surface with room to
 * spare on all four sides, and comfortably clears the movement bounds
 * (`COURT.maxX` 6.8, `maxZ` 4.6) that every venue shares.
 */
const OUTDOOR_COURT = { shape: "rect", halfLen: 8, halfWid: 5.2 } as const;

export const VENUES: Record<VenueId, Venue> = {
  gym: {
    id: "gym",
    label: "SPORTS HALL",
    sub: "Indoor court under the roof lights",
    arena: {
      file: "indoor_arena_inside_out_improved_version.glb",
      span: 55,
      offsetX: -0.45,
      offsetY: -0.05,
      offsetZ: -1.2,
      rotationY: 0,
    },
    court: {
      surface: "own",
      shape: "oval",
      boards: true,
      halfLen: 9,
      halfWid: 6.7,
      floor: [0.13, 0.22, 0.38],
      line: [0.92, 0.93, 0.95],
      board: [0.93, 0.42, 0.08],
    },
    sky: [0.045, 0.05, 0.09],
  },
  basketball: {
    id: "basketball",
    label: "STREETBALL",
    sub: "Outdoor blacktop under the hoops",
    arena: { file: "Basketball.glb", ...OUTDOOR },
    court: {
      surface: "venue",
      ...OUTDOOR_COURT,
      boards: true,
      floor: [0.38, 0.2, 0.14], // the court's own varnished boards, if it is skipped
      line: [0.96, 0.95, 0.92],
      board: [0.24, 0.27, 0.33],
    },
    sky: [0.42, 0.55, 0.72],
  },
  football: {
    id: "football",
    label: "TOUCHLINE",
    sub: "Out on the pitch with the goals behind",
    arena: { file: "Soccer.glb", ...OUTDOOR },
    // No boards: a pitch has touchlines, not barriers, and the goals already
    // frame the ends.
    court: {
      surface: "venue",
      ...OUTDOOR_COURT,
      boards: false,
      floor: [0.16, 0.34, 0.16],
      line: [0.95, 0.97, 0.95],
      board: [0.9, 0.9, 0.92],
    },
    sky: [0.5, 0.62, 0.78],
  },
  tennis: {
    id: "tennis",
    label: "CENTRE COURT",
    sub: "Hard court under the floodlights",
    // Mat.3 and Mat.4 are the tennis net's cord and tape, used by nothing else
    // in the model. It stands across the middle of the court, at exactly the
    // height and plane the ball is played through.
    arena: { file: "Tennis.glb", ...OUTDOOR, hideMaterials: ["Mat.3", "Mat.4"] },
    court: {
      surface: "venue",
      ...OUTDOOR_COURT,
      boards: true,
      floor: [0.24, 0.45, 0.62],
      line: [0.97, 0.97, 0.97],
      board: [0.1, 0.3, 0.22],
    },
    sky: [0.46, 0.58, 0.75],
  },
};

const STORAGE_KEY = "teqopen.venue";

function isVenueId(v: unknown): v is VenueId {
  return typeof v === "string" && (VENUE_IDS as string[]).includes(v);
}

/** A `?venue=` override, or null when the URL asks for nothing. */
export function venueFromSearch(search: string): VenueId | null {
  const v = new URLSearchParams(search).get("venue");
  return isVenueId(v) ? v : null;
}

export function storedVenue(): VenueId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isVenueId(v) ? v : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function storeVenue(id: VenueId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not remembering the choice is not worth failing a match over.
  }
}

/** URL override, then the remembered choice, then the original sports hall. */
export function resolveVenue(search: string): VenueId {
  return venueFromSearch(search) ?? storedVenue() ?? "gym";
}

export function venueFor(id: VenueId): Venue {
  return VENUES[id];
}
