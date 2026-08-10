/**
 * The report as data — a small block vocabulary that mirrors the app's visual
 * language, one block per thing the app already knows how to show.
 *
 * Nothing here draws, computes or knows about cairo. That separation is what
 * makes the layout testable (a `ReportDoc` can be asserted on without a GJS
 * runtime) and what lets the same document be rendered by something other than
 * a PDF renderer later.
 */

import type { Tone } from './theme.ts';

/** A `label: value` pair in the cover's metadata block. */
export interface MetaItem {
  label: string;
  value: string;
}

/** A dashboard tile: caption, big number, unit, optional class badge, sub-line. */
export interface Kpi {
  caption: string;
  value: string;
  unit?: string;
  /** Coloured pill on the right of the value (the Energieausweis class). */
  badge?: { text: string; color: string };
  sub?: string;
  /** Colours the value itself. */
  tone?: Tone;
}

/** One row of a label/value card — an `Adw.ActionRow` in print. */
export interface ValueRow {
  label: string;
  value?: string;
  /** Second, dimmer line under the label. */
  sub?: string;
  tone?: Tone;
  /** Bold both sides — for a total. */
  strong?: boolean;
  indent?: boolean;
}

/** A labelled proportional bar (the heat-loss breakdown). */
export interface BarItem {
  label: string;
  value: string;
  /** 0..1 of the bar's width. */
  fraction: number;
  color: string;
}

/** One coloured segment of the energy-class scale. */
export interface ScaleBand {
  label: string;
  color: string;
}

/** A triangle marker on the class scale. */
export interface ScaleMarker {
  label: string;
  /** 0..1 across the whole scale. */
  position: number;
  color: string;
  /** Below the bar (the default) or above it. */
  below: boolean;
}

export interface Column {
  label: string;
  /** Relative share of the table width; shares are normalised. */
  flex: number;
  align?: 'left' | 'right';
}

export interface Cell {
  text: string;
  tone?: Tone;
  strong?: boolean;
}

/** One layer of a build-up, drawn as a proportional segment innen → außen. */
export interface LayerSegment {
  name: string;
  /** Thickness in cm — drives the segment width. */
  cm: number;
  color: string;
  /** Existing fabric: drawn hatched, and it costs and emits nothing. */
  bestand: boolean;
}

/** A ranked build-up: the decision, argued on one card. */
export interface VariantCard {
  /** Rank badge text — the position, or an em dash for the unranked reference. */
  rank: string;
  name: string;
  /** The one-line verdict under the name. */
  headline: string;
  /** Right-hand badge, usually the U-value. */
  badge?: { text: string; tone: Tone };
  /** Highlight the winner. */
  best?: boolean;
  chips: { text: string; tone: Tone }[];
  metrics: { label: string; value: string; tone?: Tone }[];
  layers: LayerSegment[];
  notes: string[];
}

/** A room polygon on a plan page. Coordinates in cm (model space). */
export interface PlanPoly {
  pts: [number, number][];
  /** Inside the heated envelope — drives the fill colour. */
  heated: boolean;
  /** Centred label lines (name, area), possibly empty. */
  label: string[];
}

/** A wall segment on a plan page; `t` is the thickness in cm. */
export interface PlanWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  t: number;
}

/** A door or window, as its oriented footprint rectangle. */
export interface PlanOpening {
  pts: [number, number][];
  door: boolean;
}

/** A dimension chain: the measured line, its perpendicular offset, a label. */
export interface PlanDim {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  offset: number;
  label: string;
}

/** One storey of the floor plan, ready to be scaled into a page. */
export interface PlanPage {
  title: string;
  /** Content bounds in cm — the renderer fits these into the page. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  polys: PlanPoly[];
  walls: PlanWall[];
  openings: PlanOpening[];
  dims: PlanDim[];
  /** Compass north, clockwise from plan-up, in radians. */
  northAngle: number;
  /** Small print under the drawing (level elevations, wall heights, caveats). */
  notes: string[];
  /** Title block (Plankopf) fields, when the caller provides them. */
  object?: string;
  datum?: string;
  author?: string;
}

export type Block =
  | { kind: 'kpis'; title?: string; description?: string; items: Kpi[] }
  | { kind: 'scale'; title: string; description?: string; bands: ScaleBand[]; markers: ScaleMarker[] }
  | { kind: 'bars'; title: string; description?: string; items: BarItem[] }
  | { kind: 'rows'; title?: string; description?: string; rows: ValueRow[] }
  | {
      kind: 'table';
      title?: string;
      description?: string;
      columns: Column[];
      rows: Cell[][];
      /** Bold summary row, separated by a heavier rule. */
      total?: Cell[];
    }
  | { kind: 'variants'; title?: string; description?: string; items: VariantCard[] }
  | { kind: 'callout'; tone: Tone; title: string; text: string }
  | { kind: 'prose'; title?: string; description?: string; paragraphs: string[] }
  | { kind: 'plan'; page: PlanPage }
  | { kind: 'pagebreak' };

/** What a render produced. */
export interface RenderResult {
  path: string;
  /** Pages written — the number the "Seite n von m" footers were built from. */
  pages: number;
}

export interface ReportDoc {
  /** Cover title, set in the accent band. */
  title: string;
  subtitle: string;
  /** Sentence under the title explaining what the reader is holding. */
  lead?: string;
  /** Object / date / author, shown as a row of small captioned values. */
  meta: MetaItem[];
  blocks: Block[];
  /** Repeated at the foot of every page, left of the page number. */
  footer: string;
}
