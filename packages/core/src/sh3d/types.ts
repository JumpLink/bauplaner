/**
 * Domain types for a parsed Sweet Home 3D (`.sh3d`) home.
 *
 * A `.sh3d` file is a ZIP archive whose `Home.xml` entry holds the model.
 * Sweet Home 3D stores coordinates and lengths in **centimeters**; the parser
 * converts areas/lengths to meters where noted.
 */

/** A single storey/level of the building (Keller, Sockel, EG, OG, Umgebung …). */
export interface Level {
  id: string;
  name: string;
  /** Elevation of the level's floor, in cm (as stored). */
  elevation: number;
  /** Wall height on this level, in cm. */
  height: number;
  /** Floor slab thickness, in cm. */
  floorThickness: number;
  visible: boolean;
}

/** A room polygon on a given level. */
export interface Room {
  /** Room id (empty string if the model has none). */
  id: string;
  name: string;
  /** Floor area in m² (from the shoelace formula over the vertices). */
  area: number;
  /** Polygon vertices as [x, y] pairs, in cm. */
  vertices: [number, number][];
  /** Owning level id (empty string if the model has no explicit levels). */
  level: string;
  areaVisible?: boolean;
  ceilingVisible?: boolean;
  ceilingFlat?: boolean;
}

/** A straight wall segment. All coordinates/lengths in cm. */
export interface Wall {
  id: string;
  /** Owning level id (empty string if the model has no explicit levels). */
  level: string;
  xStart: number;
  yStart: number;
  xEnd: number;
  yEnd: number;
  height: number;
  thickness: number;
  wallAtStart?: string;
  wallAtEnd?: string;
}

/** A piece of furniture / door / window placed in the home. Lengths in cm. */
export interface Furniture {
  id: string;
  /** Source element: 'furniture' | 'doorOrWindow' | 'pieceOfFurniture'. */
  kind: string;
  /** Owning level id (empty if none). */
  level: string;
  name: string;
  x: number;
  y: number;
  /** Elevation above the level floor (cm). */
  elevation: number;
  /** Rotation about the vertical axis (radians). */
  angle: number;
  width: number;
  depth: number;
  height: number;
  /** Model reference — a ZIP entry name in the `.sh3d` (a single OBJ or a model ZIP). */
  model: string;
  /**
   * The model's base orientation as a row-major 3×3 matrix (9 numbers), or
   * undefined for identity. Applied to the raw model before it is normalised to
   * the piece's width/height/depth.
   */
  modelRotation?: number[];
  /** Mirror the model along its width axis (`modelMirrored` in the `.sh3d`). */
  mirrored?: boolean;
}

/** A dimension line. Coordinates in cm; `length` is converted to meters. */
export interface Dimension {
  id: string;
  xStart: number;
  yStart: number;
  xEnd: number;
  yEnd: number;
  offset: number;
  /** Line length in meters. */
  length: number;
}

/** The fully parsed home model. */
export interface HomeData {
  levels: Level[];
  rooms: Room[];
  walls: Wall[];
  furniture: Furniture[];
  dimensions: Dimension[];
  /**
   * Compass north direction in radians (Sweet Home 3D `compass northDirection`):
   * the angle of north, clockwise from the top of the plan. 0 = north points up
   * (towards decreasing plan Y). Defaults to 0 when the model has no compass.
   */
  northAngle: number;
}
