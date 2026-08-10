/**
 * Render a {@link ReportDoc} to a PDF via cairo (PDFSurface) + Pango (text
 * layout) under GJS.
 *
 * ## How it lays out
 *
 * Blocks are flattened into **groups**, and a group into **pieces**. A piece is
 * the smallest thing that must not be cut in half — a table row, a variant card,
 * one bar. The flow engine packs pieces onto the page until the next one no
 * longer fits, draws the card background *around the packed chunk*, breaks, and
 * carries on. That is what lets a long table split across pages and still look
 * like a card on both, and it is why a table header can be re-drawn on the
 * continuation (`Group.repeat`).
 *
 * ## Why two passes
 *
 * A PDF page is finished when `showPage()` is called, so "Seite 3 von 7" cannot
 * be back-patched. The document is therefore rendered twice: once to a scratch
 * file purely to count the pages, then for real. Identical code path both times,
 * so the pagination cannot disagree with the count.
 *
 * The GJS runtime is reached through a cast rather than a static `gi://` import
 * (as `@buchhaltung/invoice-pdf` does), so this file still type-checks in a Node
 * build where the package's `exports` map selects the stub instead.
 */

export * from './model.ts';
export * from './theme.ts';
export * from './format.ts';
export * from './sanierungsplan.ts';
export * from './grundriss.ts';

import type { Block, Cell, Column, PlanPage, RenderResult, ReportDoc, VariantCard } from './model.ts';
import {
  COLOR,
  CONTENT_W,
  FONT_FAMILY,
  PAGE,
  RADIUS,
  TONE_COLOR,
  TONE_TINT,
  TYPE,
  type Tone,
} from './theme.ts';

// ── Structural typings for the GJS cairo + Pango runtime we use ──────────────
interface CairoContext {
  setSourceRGB(r: number, g: number, b: number): void;
  setSourceRGBA(r: number, g: number, b: number, a: number): void;
  setLineWidth(w: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  newPath(): void;
  arc(xc: number, yc: number, radius: number, angle1: number, angle2: number): void;
  rectangle(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fill(): void;
  fillPreserve(): void;
  clip(): void;
  save(): void;
  restore(): void;
  showPage(): void;
}
interface CairoSurface {
  flush(): void;
  finish(): void;
}
interface PangoLayout {
  set_text(text: string, len: number): void;
  set_markup(markup: string, len: number): void;
  set_width(w: number): void;
  set_alignment(a: number): void;
  set_ellipsize(mode: number): void;
  set_font_description(desc: unknown): void;
  get_pixel_size(): [number, number];
}
interface GjsRuntime {
  imports?: {
    cairo: {
      PDFSurface: new (filename: string, width: number, height: number) => CairoSurface;
      Context: new (surface: CairoSurface) => CairoContext;
    };
    gi: {
      GLib: {
        build_filenamev(parts: string[]): string;
        get_tmp_dir(): string;
        unlink(path: string): number;
      };
      Pango: {
        SCALE: number;
        Alignment: { LEFT: number; RIGHT: number; CENTER: number };
        EllipsizeMode: { NONE: number; END: number };
        FontDescription: { from_string(s: string): unknown };
      };
      PangoCairo: {
        create_layout(ctx: CairoContext): PangoLayout;
        show_layout(ctx: CairoContext, layout: PangoLayout): void;
      };
    };
  };
}

type Gi = NonNullable<GjsRuntime['imports']>['gi'];
type Cairo = NonNullable<GjsRuntime['imports']>['cairo'];

function runtime(): NonNullable<GjsRuntime['imports']> {
  const imports = (globalThis as unknown as GjsRuntime).imports;
  if (!pdfExportAvailable() || !imports) {
    throw new Error(
      'PDF-Export benötigt cairo und PangoCairo in der GJS-Laufzeit — ' +
        'entweder läuft das hier nicht unter GJS, oder die PangoCairo-Typelib fehlt im System.',
    );
  }
  return imports;
}

/**
 * Whether {@link renderReportPdf} can run here.
 *
 * The try/catch is load-bearing, not defensive noise: reading
 * `imports.gi.PangoCairo` **throws** when the typelib is absent (a bare `gjs`
 * without pango's introspection data — a minimal container, for instance)
 * rather than evaluating to undefined. A probe that crashes on exactly the
 * system it exists to detect is no probe at all.
 */
export function pdfExportAvailable(): boolean {
  try {
    const imports = (globalThis as unknown as GjsRuntime).imports;
    return !!imports?.cairo && !!imports.gi?.PangoCairo;
  } catch {
    return false;
  }
}

/** `#rrggbb` → cairo's 0..1 triple. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: string;
  /** Wrap (and, with `align`, justify) inside this width. */
  width?: number;
  align?: 'left' | 'right' | 'center';
  /** Cut with an ellipsis instead of wrapping — needs `width`. */
  ellipsize?: boolean;
  /** Tabular figures, so a column of numbers lines up. */
  tabular?: boolean;
}

/** Drawing primitives in the app's visual language. */
class Painter {
  constructor(
    readonly ctx: CairoContext,
    private readonly gi: Gi,
  ) {}

  private layout(str: string, o: TextOpts): PangoLayout {
    const { Pango, PangoCairo } = this.gi;
    const l = PangoCairo.create_layout(this.ctx);
    l.set_font_description(
      Pango.FontDescription.from_string(`${FONT_FAMILY} ${o.bold ? 'Bold ' : ''}${o.size ?? TYPE.body}`),
    );
    if (o.width != null) l.set_width(Math.max(1, o.width) * Pango.SCALE);
    l.set_alignment(
      o.align === 'right' ? Pango.Alignment.RIGHT : o.align === 'center' ? Pango.Alignment.CENTER : Pango.Alignment.LEFT,
    );
    if (o.ellipsize) l.set_ellipsize(Pango.EllipsizeMode.END);
    // Tabular figures are a font feature, and a font feature can only be asked
    // for through markup — hence the escape.
    if (o.tabular) l.set_markup(`<span font_features="tnum=1">${escapeMarkup(str)}</span>`, -1);
    else l.set_text(str, -1);
    return l;
  }

  setColor(hex: string, alpha = 1): void {
    const [r, g, b] = rgb(hex);
    if (alpha >= 1) this.ctx.setSourceRGB(r, g, b);
    else this.ctx.setSourceRGBA(r, g, b, alpha);
  }

  /** Draw `str` at (x, y); returns the height of the laid-out block. */
  text(x: number, y: number, str: string, o: TextOpts = {}): number {
    const l = this.layout(str, o);
    this.setColor(o.color ?? COLOR.text);
    this.ctx.moveTo(x, y);
    this.gi.PangoCairo.show_layout(this.ctx, l);
    return l.get_pixel_size()[1];
  }

  /** Height `str` would occupy, without drawing it. */
  height(str: string, o: TextOpts = {}): number {
    return this.layout(str, o).get_pixel_size()[1];
  }

  /** Natural width of `str` on one line. */
  width(str: string, o: TextOpts = {}): number {
    return this.layout(str, { ...o, width: undefined }).get_pixel_size()[0];
  }

  fillRect(x: number, y: number, w: number, h: number, hex: string, alpha = 1): void {
    this.setColor(hex, alpha);
    this.ctx.rectangle(x, y, w, h);
    this.ctx.fill();
  }

  /** Trace a rounded rectangle; the caller fills or strokes it. */
  roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    const { ctx } = this;
    ctx.newPath();
    ctx.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI);
    ctx.arc(x + w - rr, y + rr, rr, 1.5 * Math.PI, 2 * Math.PI);
    ctx.arc(x + w - rr, y + h - rr, rr, 0, 0.5 * Math.PI);
    ctx.arc(x + rr, y + h - rr, rr, 0.5 * Math.PI, Math.PI);
    ctx.closePath();
  }

  /** An Adwaita `.card`: rounded, filled, hairline border, optional accent edge. */
  card(x: number, y: number, w: number, h: number, o: { fill?: string; border?: string; accent?: string } = {}): void {
    this.roundRectPath(x, y, w, h, RADIUS.card);
    this.setColor(o.fill ?? COLOR.cardBg);
    this.ctx.fillPreserve();
    this.setColor(o.border ?? COLOR.cardLine);
    this.ctx.setLineWidth(0.7);
    this.ctx.stroke();
    if (o.accent) {
      // A 3 pt stripe down the left edge, clipped to the card's rounded corner.
      this.ctx.save();
      this.roundRectPath(x, y, w, h, RADIUS.card);
      this.ctx.clip();
      this.fillRect(x, y, 3, h, o.accent);
      this.ctx.restore();
    }
  }

  hline(x0: number, x1: number, y: number, hex: string = COLOR.line, width = 0.6): void {
    this.setColor(hex);
    this.ctx.setLineWidth(width);
    this.ctx.newPath();
    this.ctx.moveTo(x0, y);
    this.ctx.lineTo(x1, y);
    this.ctx.stroke();
  }

  /** A tinted pill with a tone-coloured label. Returns the width it took. */
  chip(x: number, y: number, label: string, tone: Tone): number {
    const tw = this.width(label, { size: TYPE.caption });
    const w = tw + 12;
    const h = 13.5;
    this.roundRectPath(x, y, w, h, RADIUS.chip);
    this.setColor(TONE_TINT[tone]);
    this.ctx.fill();
    this.text(x + 6, y + 2.2, label, { size: TYPE.caption, color: TONE_COLOR[tone] });
    return w;
  }

  /** A solid rounded badge — the energy class, the U-value. */
  badge(xRight: number, y: number, label: string, bg: string, fg: string = COLOR.white): number {
    const w = this.width(label, { size: TYPE.caption, bold: true }) + 14;
    const h = 14.5;
    this.roundRectPath(xRight - w, y, w, h, RADIUS.badge);
    this.setColor(bg);
    this.ctx.fill();
    this.text(xRight - w + 7, y + 2.6, label, { size: TYPE.caption, bold: true, color: fg });
    return w;
  }
}

// ── Flow model ───────────────────────────────────────────────────────────────

/** The smallest unit that must not be split across a page break. */
interface Piece {
  h: number;
  /** `first` is true when this piece opens a chunk — used to skip a separator. */
  draw(p: Painter, x: number, y: number, w: number, first: boolean): void;
}

interface Group {
  title?: string;
  description?: string;
  /** Wrap the pieces in a card. */
  card: boolean;
  accent?: string;
  padX: number;
  padY: number;
  gap: number;
  pieces: Piece[];
  /** Re-drawn at the top of every continuation chunk (a table header). */
  repeat?: Piece;
  breakBefore?: boolean;
  /**
   * Move the whole group to the next page rather than splitting it — but only
   * when it would actually fit there. That proviso is what makes it the safe
   * default (see {@link GROUP_DEFAULTS}): a five-bar breakdown or a six-row
   * table relocates in one piece, while a table longer than a page fails the
   * "would fit" test and splits exactly as it did before.
   */
  keepTogether?: boolean;
  spaceAfter: number;
}

const GROUP_DEFAULTS = { card: true, padX: 14, padY: 11, gap: 0, spaceAfter: 18, keepTogether: true };

/** Height of a group's card if every piece were placed in one chunk. */
function groupBodyHeight(g: Group): number {
  const gaps = g.gap * Math.max(0, g.pieces.length - 1);
  return g.padY * 2 + g.pieces.reduce((s, piece) => s + piece.h, 0) + gaps;
}

// ── Block → group conversion ─────────────────────────────────────────────────

function toneOf(c: { tone?: Tone }): string {
  return TONE_COLOR[c.tone ?? 'neutral'];
}

/**
 * A grid of KPI tiles, drawn as ONE piece: they are a single reading, and a
 * dashboard row split across a page break stops being one. Wraps at four
 * columns, and every tile in the grid shares one value size — a row where each
 * number is set differently looks like an accident.
 */
function kpiGroup(p: Painter, block: Extract<Block, { kind: 'kpis' }>): Group {
  const n = Math.max(1, block.items.length);
  const gap = 10;
  const perRow = Math.min(4, n);
  const gridRows = Math.ceil(n / perRow);
  const tileW = (CONTENT_W - gap * (perRow - 1)) / perRow;
  const padX = 12;
  const innerW = tileW - 2 * padX;
  const captionH = p.height('Hg', { size: TYPE.caption });
  // One shared value size for the whole row, stepped down until the widest
  // figure fits its tile — a six-digit euro amount is wider than the tile the
  // display size assumes, and an overflowing headline number reads as a bug.
  const roomFor = (k: (typeof block.items)[number], size: number): number =>
    p.width(k.value, { size, bold: true }) +
    (k.unit ? p.width(k.unit, { size: TYPE.caption }) + 4 : 0) +
    (k.badge ? p.width(k.badge.text, { size: TYPE.caption, bold: true }) + 20 : 0);
  let valueSize = TYPE.kpi;
  while (valueSize > 10.5 && block.items.some((k) => roomFor(k, valueSize) > innerW)) valueSize -= 0.5;
  const valueH = p.height('0', { size: valueSize, bold: true });
  const subHeights = block.items.map((k) => (k.sub ? p.height(k.sub, { size: TYPE.caption, width: innerW }) : 0));
  const maxSubH = Math.max(...subHeights, 0);
  const captionY = 11;
  const valueY = captionY + captionH + 3;
  const subY = valueY + valueH + 5;
  const tileH = subY + maxSubH + 11;
  const gridH = gridRows * tileH + (gridRows - 1) * gap;

  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    card: false,
    padX: 0,
    padY: 0,
    spaceAfter: 14,
    pieces: [
      {
        h: gridH,
        draw: (pt, x, y0) => {
          block.items.forEach((k, i) => {
            const tx = x + (i % perRow) * (tileW + gap);
            const y = y0 + Math.floor(i / perRow) * (tileH + gap);
            pt.card(tx, y, tileW, tileH, { fill: COLOR.white });
            pt.text(tx + padX, y + captionY, k.caption, {
              size: TYPE.caption,
              color: COLOR.dim,
              width: innerW,
              ellipsize: true,
            });
            const vw = pt.width(k.value, { size: valueSize, bold: true });
            pt.text(tx + padX, y + valueY, k.value, {
              size: valueSize,
              bold: true,
              color: toneOf(k),
              tabular: true,
            });
            if (k.unit) {
              pt.text(tx + padX + vw + 4, y + valueY + valueH - 11, k.unit, { size: TYPE.caption, color: COLOR.dim });
            }
            if (k.badge) pt.badge(tx + tileW - padX, y + valueY + 4, k.badge.text, k.badge.color);
            if (k.sub) {
              pt.text(tx + padX, y + subY, k.sub, { size: TYPE.caption, color: COLOR.faint, width: innerW });
            }
          });
        },
      },
    ],
  };
}

/** The A+…H band with Start / Heute / Ziel markers. */
function scaleGroup(p: Painter, block: Extract<Block, { kind: 'scale' }>): Group {
  const barTop = 20;
  const barH = 22;
  const h = barTop + barH + 24;
  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    padY: 8,
    pieces: [
      {
        h,
        draw: (pt, x, y, w) => {
          const seg = w / block.bands.length;
          block.bands.forEach((band, i) => {
            pt.fillRect(x + i * seg, y + barTop, seg - 1.5, barH, band.color);
            const tw = pt.width(band.label, { size: TYPE.caption, bold: true });
            pt.text(x + i * seg + (seg - 1.5) / 2 - tw / 2, y + barTop + 4, band.label, {
              size: TYPE.caption,
              bold: true,
              color: COLOR.white,
            });
          });
          for (const m of block.markers) {
            const mx = x + Math.max(4, Math.min(w - 4, m.position * w));
            pt.setColor(m.color);
            pt.ctx.newPath();
            if (m.below) {
              pt.ctx.moveTo(mx, y + barTop + barH);
              pt.ctx.lineTo(mx - 5, y + barTop + barH + 7);
              pt.ctx.lineTo(mx + 5, y + barTop + barH + 7);
            } else {
              pt.ctx.moveTo(mx, y + barTop);
              pt.ctx.lineTo(mx - 5, y + barTop - 7);
              pt.ctx.lineTo(mx + 5, y + barTop - 7);
            }
            pt.ctx.closePath();
            pt.ctx.fill();
            const tw = pt.width(m.label, { size: TYPE.caption, bold: true });
            const tx = Math.max(x, Math.min(x + w - tw, mx - tw / 2));
            pt.text(tx, m.below ? y + barTop + barH + 9 : y + barTop - 19, m.label, {
              size: TYPE.caption,
              bold: true,
              color: m.color,
            });
          }
        },
      },
    ],
  };
}

/** Labelled proportional bars — one piece each, so a long list can break. */
function barsGroup(block: Extract<Block, { kind: 'bars' }>): Group {
  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    padY: 9,
    gap: 6,
    pieces: block.items.map((b) => ({
      h: 22,
      draw: (pt, x, y, w) => {
        pt.text(x, y, b.label, { size: TYPE.body, width: w - 46 });
        pt.text(x + w - 44, y, b.value, { size: TYPE.body, color: COLOR.dim, width: 44, align: 'right', tabular: true });
        pt.fillRect(x, y + 16, w, 6, COLOR.line);
        pt.fillRect(x, y + 16, Math.max(2, w * Math.min(1, Math.max(0, b.fraction))), 6, b.color);
      },
    })),
  };
}

/** A label/value card — the `Adw.ActionRow` list. */
function rowsGroup(p: Painter, block: Extract<Block, { kind: 'rows' }>): Group {
  const valueW = 150;
  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    pieces: block.rows.map((r) => {
      const indent = r.indent ? 14 : 0;
      const labelW = CONTENT_W - 2 * 14 - valueW - 12 - indent;
      const labelH = p.height(r.label, { size: TYPE.body, bold: r.strong, width: labelW });
      const subH = r.sub ? p.height(r.sub, { size: TYPE.caption, width: labelW }) + 1 : 0;
      return {
        h: Math.max(labelH + subH, 14) + 11,
        draw: (pt, x, y, w, first) => {
          if (!first) pt.hline(x, x + w, y - 0.5);
          const ty = y + 5;
          pt.text(x + indent, ty, r.label, { size: TYPE.body, bold: r.strong, width: labelW });
          if (r.sub) {
            pt.text(x + indent, ty + labelH + 1, r.sub, { size: TYPE.caption, color: COLOR.faint, width: labelW });
          }
          if (r.value) {
            pt.text(x + w - valueW, ty, r.value, {
              size: TYPE.body,
              bold: r.strong,
              color: r.tone ? TONE_COLOR[r.tone] : r.strong ? COLOR.text : COLOR.dim,
              width: valueW,
              align: 'right',
              tabular: true,
            });
          }
        },
      };
    }),
  };
}

/** Resolve flex shares into point widths inside the card. */
function columnWidths(columns: Column[], innerW: number): number[] {
  const sum = columns.reduce((s, c) => s + c.flex, 0) || 1;
  return columns.map((c) => (c.flex / sum) * innerW);
}

function tableGroup(p: Painter, block: Extract<Block, { kind: 'table' }>): Group {
  const padX = 14;
  const innerW = CONTENT_W - 2 * padX;
  const colGap = 6;
  const widths = columnWidths(block.columns, innerW - colGap * (block.columns.length - 1));
  const xs: number[] = [];
  let acc = 0;
  for (const w of widths) {
    xs.push(acc);
    acc += w + colGap;
  }

  const drawCells = (pt: Painter, x: number, y: number, cells: Cell[], strong: boolean): void => {
    block.columns.forEach((c, i) => {
      const cell = cells[i];
      if (!cell) return;
      pt.text(x + xs[i], y, cell.text, {
        size: TYPE.body,
        bold: strong || cell.strong,
        color: cell.tone ? TONE_COLOR[cell.tone] : strong ? COLOR.text : COLOR.text,
        width: widths[i],
        align: c.align,
        tabular: c.align === 'right',
      });
    });
  };
  const rowHeight = (cells: Cell[], strong: boolean): number =>
    Math.max(
      ...block.columns.map((_c, i) =>
        cells[i] ? p.height(cells[i].text, { size: TYPE.body, bold: strong, width: widths[i] }) : 0,
      ),
      12,
    ) + 9;

  const header: Piece = {
    h: 19,
    draw: (pt, x, y) => {
      block.columns.forEach((c, i) => {
        if (!c.label) return;
        pt.text(x + xs[i], y, c.label, {
          size: TYPE.caption,
          bold: true,
          color: COLOR.dim,
          width: widths[i],
          align: c.align,
        });
      });
      pt.hline(x, x + innerW, y + 15);
    },
  };

  const pieces: Piece[] = [header];
  for (const cells of block.rows) {
    const h = rowHeight(cells, false);
    pieces.push({ h, draw: (pt, x, y) => drawCells(pt, x, y + 4, cells, false) });
  }
  if (block.total) {
    const total = block.total;
    const h = rowHeight(total, true) + 6;
    pieces.push({
      h,
      draw: (pt, x, y) => {
        pt.hline(x, x + innerW, y + 2, COLOR.faint, 0.8);
        drawCells(pt, x, y + 8, total, true);
      },
    });
  }

  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    padX,
    pieces,
    repeat: header,
  };
}

/** The build-up strip: proportional, category-coloured, innen → außen. */
function drawLayerStrip(pt: Painter, x: number, y: number, w: number, card: VariantCard): void {
  const barH = 24;
  const total = card.layers.reduce((s, l) => s + l.cm, 0) || 1;
  const gap = 1.5;
  const usable = w - gap * Math.max(0, card.layers.length - 1);
  let cx = x;
  for (const l of card.layers) {
    const lw = (l.cm / total) * usable;
    pt.fillRect(cx, y, lw, barH, l.color);
    if (l.bestand) {
      // Hatch the existing fabric: it is what we build onto, and it costs and
      // emits nothing in every figure on this card.
      pt.ctx.save();
      pt.ctx.rectangle(cx, y, lw, barH);
      pt.ctx.clip();
      pt.setColor(COLOR.white, 0.45);
      pt.ctx.setLineWidth(1);
      for (let d = -barH; d < lw + barH; d += 5) {
        pt.ctx.newPath();
        pt.ctx.moveTo(cx + d, y + barH);
        pt.ctx.lineTo(cx + d + barH, y);
        pt.ctx.stroke();
      }
      pt.ctx.restore();
    }
    const label = `${Math.round(l.cm)}`;
    const tw = pt.width(label, { size: TYPE.micro, bold: true });
    if (lw > tw + 6) {
      pt.text(cx + lw / 2 - tw / 2, y + barH / 2 - 5, label, { size: TYPE.micro, bold: true, color: COLOR.text });
    }
    cx += lw + gap;
  }
  pt.text(x, y + barH + 2, 'innen', { size: TYPE.micro, color: COLOR.faint });
  pt.text(x + w - 60, y + barH + 2, 'außen', { size: TYPE.micro, color: COLOR.faint, width: 60, align: 'right' });
}

const STRIP_H = 24 + 2 + 9;

/** One ranked build-up as a self-contained card. */
function variantPiece(p: Painter, card: VariantCard): Piece {
  const padX = 14;
  const padY = 12;
  const innerW = CONTENT_W - 2 * padX;
  const rankW = 26;
  const textW = innerW - rankW - 60;

  const nameH = p.height(card.name, { size: TYPE.heading, bold: true, width: textW });
  const headH = p.height(card.headline, { size: TYPE.caption, width: textW });

  // Chips wrap into lines of `innerW`.
  const chipRows: { text: string; tone: Tone; w: number }[][] = [];
  let row: { text: string; tone: Tone; w: number }[] = [];
  let used = 0;
  for (const c of card.chips) {
    const w = p.width(c.text, { size: TYPE.caption }) + 12;
    if (used + w > innerW && row.length > 0) {
      chipRows.push(row);
      row = [];
      used = 0;
    }
    row.push({ ...c, w });
    used += w + 5;
  }
  if (row.length > 0) chipRows.push(row);
  const chipsH = chipRows.length > 0 ? chipRows.length * 18 + 2 : 0;

  // Metrics in a 3-column grid; each cell is a caption over a value.
  const cols = 3;
  const metricGap = 10;
  const cellW = (innerW - metricGap * (cols - 1)) / cols;
  const metricRows = Math.ceil(card.metrics.length / cols);
  const cellHeights = card.metrics.map(
    (m) =>
      p.height(m.label, { size: TYPE.micro, width: cellW }) +
      1 +
      p.height(m.value, { size: TYPE.body, bold: true, width: cellW }),
  );
  const rowHeights: number[] = [];
  for (let r = 0; r < metricRows; r++) {
    rowHeights.push(Math.max(...cellHeights.slice(r * cols, r * cols + cols), 18) + 8);
  }
  const metricsH = rowHeights.reduce((s, h) => s + h, 0);

  const noteHeights = card.notes.map((n) => p.height(`· ${n}`, { size: TYPE.caption, width: innerW - 4 }) + 3);
  const notesH = noteHeights.reduce((s, h) => s + h, 0) + (card.notes.length > 0 ? 6 : 0);

  const headerH = Math.max(nameH + headH + 2, 26);
  const h = padY + headerH + 10 + STRIP_H + 10 + chipsH + metricsH + notesH + padY;

  return {
    h,
    draw: (pt, x, y, w) => {
      pt.card(x, y, w, h, {
        fill: card.best ? '#f4faf6' : COLOR.cardBg,
        border: card.best ? '#bfe3cd' : COLOR.cardLine,
        accent: card.best ? COLOR.ok : undefined,
      });
      const ix = x + padX;
      let cy = y + padY;

      // Rank badge, name, headline, U-value badge.
      pt.roundRectPath(ix, cy + 1, 19, 17, RADIUS.badge);
      pt.setColor(card.best ? COLOR.ok : card.rank === '0' ? COLOR.faint : COLOR.accent);
      pt.ctx.fill();
      const rw = pt.width(card.rank, { size: TYPE.caption, bold: true });
      pt.text(ix + 9.5 - rw / 2, cy + 3.5, card.rank, { size: TYPE.caption, bold: true, color: COLOR.white });

      pt.text(ix + rankW, cy, card.name, { size: TYPE.heading, bold: true, width: textW });
      pt.text(ix + rankW, cy + nameH + 2, card.headline, { size: TYPE.caption, color: COLOR.dim, width: textW });
      if (card.badge) {
        pt.badge(x + w - padX, cy + 1, card.badge.text, TONE_COLOR[card.badge.tone]);
      }
      cy += headerH + 10;

      drawLayerStrip(pt, ix, cy, innerW, card);
      cy += STRIP_H + 10;

      for (const cr of chipRows) {
        let cx = ix;
        for (const c of cr) {
          pt.chip(cx, cy, c.text, c.tone);
          cx += c.w + 5;
        }
        cy += 18;
      }
      if (chipRows.length > 0) cy += 2;

      card.metrics.forEach((m, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const mx = ix + c * (cellW + metricGap);
        const my = cy + rowHeights.slice(0, r).reduce((s, hh) => s + hh, 0);
        pt.text(mx, my, m.label, { size: TYPE.micro, color: COLOR.faint, width: cellW });
        pt.text(mx, my + p.height(m.label, { size: TYPE.micro, width: cellW }) + 1, m.value, {
          size: TYPE.body,
          bold: true,
          color: m.tone ? TONE_COLOR[m.tone] : COLOR.text,
          width: cellW,
          tabular: true,
        });
      });
      cy += metricsH;

      if (card.notes.length > 0) {
        cy += 6;
        card.notes.forEach((n, i) => {
          pt.text(ix, cy, `· ${n}`, { size: TYPE.caption, color: COLOR.dim, width: innerW - 4 });
          cy += noteHeights[i];
        });
      }
    },
  };
}

function variantsGroup(p: Painter, block: Extract<Block, { kind: 'variants' }>): Group {
  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    card: false,
    padX: 0,
    padY: 0,
    gap: 9,
    pieces: block.items.map((v) => variantPiece(p, v)),
  };
}

function calloutGroup(p: Painter, block: Extract<Block, { kind: 'callout' }>): Group {
  const padX = 14;
  const padY = 10;
  const innerW = CONTENT_W - 2 * padX - 6;
  const titleH = p.height(block.title, { size: TYPE.heading, bold: true, width: innerW });
  const textH = p.height(block.text, { size: TYPE.caption, width: innerW });
  const h = padY + titleH + 3 + textH + padY;
  return {
    ...GROUP_DEFAULTS,
    card: false,
    padX: 0,
    padY: 0,
    spaceAfter: 16,
    pieces: [
      {
        h,
        draw: (pt, x, y, w) => {
          pt.card(x, y, w, h, {
            fill: TONE_TINT[block.tone],
            border: TONE_TINT[block.tone],
            accent: TONE_COLOR[block.tone],
          });
          pt.text(x + padX + 6, y + padY, block.title, {
            size: TYPE.heading,
            bold: true,
            color: TONE_COLOR[block.tone],
            width: innerW,
          });
          pt.text(x + padX + 6, y + padY + titleH + 3, block.text, {
            size: TYPE.caption,
            color: COLOR.text,
            width: innerW,
          });
        },
      },
    ],
  };
}

function proseGroup(p: Painter, block: Extract<Block, { kind: 'prose' }>): Group {
  return {
    ...GROUP_DEFAULTS,
    title: block.title,
    description: block.description,
    card: false,
    padX: 0,
    padY: 0,
    gap: 9,
    pieces: block.paragraphs.map((text) => ({
      h: p.height(text, { size: TYPE.body, width: CONTENT_W }),
      draw: (pt, x, y, w) => {
        pt.text(x, y, text, { size: TYPE.body, color: COLOR.dim, width: w });
      },
    })),
  };
}


// ── The floor-plan page ──────────────────────────────────────────────────────

const PLAN = {
  heated: '#d6e8f8',
  unheated: '#e4e4e4',
  roomLine: '#96a9be',
  wall: '#2d2d2d',
  door: '#be781e',
  window: '#1e6ebe',
  dim: '#b42828',
  grid: '#f2f2f2',
  label: '#3c3c78',
} as const;

/** One storey drawn to fill the whole content area of its page. */
function drawPlan(p: Painter, x: number, y: number, w: number, h: number, page: PlanPage): void {
  const { ctx } = p;
  p.text(x, y, page.title, { size: TYPE.lead, bold: true });

  // legend, right-aligned on the title line (north arrow goes above the plan)
  let lx = x + w - 8;
  const legend: [string, string, boolean][] = [
    ['Tür', PLAN.door, false],
    ['Fenster', PLAN.window, false],
    ['unbeheizt', PLAN.unheated, true],
    ['beheizte Zone', PLAN.heated, true],
  ];
  for (const [label, colr, filled] of legend) {
    lx -= p.width(label, { size: TYPE.caption }) + 4;
    p.text(lx, y + 3, label, { size: TYPE.caption, color: COLOR.dim });
    lx -= 14;
    if (filled) {
      p.fillRect(lx, y + 4, 10, 8, colr);
      p.setColor(PLAN.roomLine);
    } else {
      p.setColor(colr);
    }
    ctx.setLineWidth(0.8);
    ctx.rectangle(lx, y + 4, 10, 8);
    ctx.stroke();
    lx -= 14;
  }

  // bottom strip: notes on the left, title block on the right
  const noteH = 9 * page.notes.length;
  const titleBlockH = 62;
  const stripH = Math.max(noteH + 24, titleBlockH) + 8;
  const top = y + 24;
  const drawH = h - 24 - stripH;

  // snap to the next standard architectural scale (1 cm real = 28.346 pt at 1:1)
  const PT_PER_CM = 28.346;
  const STANDARD_SCALES = [50, 75, 100, 125, 150, 200, 250, 300, 400, 500];
  const fit = Math.min(w / (page.maxX - page.minX), drawH / (page.maxY - page.minY));
  const ratio = STANDARD_SCALES.find((r) => PT_PER_CM / r <= fit) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1]!;
  const scale = PT_PER_CM / ratio;
  const padX = (w - (page.maxX - page.minX) * scale) / 2;
  const padY = (drawH - (page.maxY - page.minY) * scale) / 2;
  const tx = (mx: number): number => x + padX + (mx - page.minX) * scale;
  const ty = (my: number): number => top + padY + (my - page.minY) * scale;

  // 1 m grid
  p.setColor(PLAN.grid);
  ctx.setLineWidth(0.4);
  for (let g = Math.ceil(page.minX / 100) * 100; g <= page.maxX; g += 100) {
    ctx.newPath();
    ctx.moveTo(tx(g), ty(page.minY));
    ctx.lineTo(tx(g), ty(page.maxY));
    ctx.stroke();
  }
  for (let g = Math.ceil(page.minY / 100) * 100; g <= page.maxY; g += 100) {
    ctx.newPath();
    ctx.moveTo(tx(page.minX), ty(g));
    ctx.lineTo(tx(page.maxX), ty(g));
    ctx.stroke();
  }

  const path = (pts: [number, number][]): void => {
    ctx.newPath();
    pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(tx(px), ty(py)) : ctx.lineTo(tx(px), ty(py))));
    ctx.closePath();
  };

  for (const poly of page.polys) {
    path(poly.pts);
    p.setColor(poly.heated ? PLAN.heated : PLAN.unheated);
    ctx.fillPreserve();
    p.setColor(PLAN.roomLine);
    ctx.setLineWidth(0.6);
    ctx.stroke();
  }
  for (const wall of page.walls) {
    p.setColor(PLAN.wall);
    ctx.setLineWidth(Math.max(1, wall.t * scale));
    ctx.newPath();
    ctx.moveTo(tx(wall.x1), ty(wall.y1));
    ctx.lineTo(tx(wall.x2), ty(wall.y2));
    ctx.stroke();
  }
  for (const o of page.openings) {
    path(o.pts);
    p.setColor(COLOR.white);
    ctx.fillPreserve();
    p.setColor(o.door ? PLAN.door : PLAN.window);
    ctx.setLineWidth(0.9);
    ctx.stroke();
  }
  for (const poly of page.polys) {
    if (poly.label.length === 0) continue;
    const cx = poly.pts.reduce((s, [px]) => s + px, 0) / poly.pts.length;
    const cy = poly.pts.reduce((s, [, py]) => s + py, 0) / poly.pts.length;
    poly.label.forEach((line, i) => {
      const lw = p.width(line, { size: TYPE.micro });
      p.text(tx(cx) - lw / 2, ty(cy) - 8 + i * 8, line, { size: TYPE.micro, color: PLAN.label });
    });
  }
  for (const d of page.dims) {
    const vx = d.x2 - d.x1;
    const vy = d.y2 - d.y1;
    const len = Math.hypot(vx, vy);
    if (len === 0) continue;
    const ux = vx / len;
    const uy = vy / len;
    const nx = uy;
    const ny = -ux;
    const a: [number, number] = [d.x1 + nx * d.offset, d.y1 + ny * d.offset];
    const b: [number, number] = [d.x2 + nx * d.offset, d.y2 + ny * d.offset];
    p.setColor(PLAN.dim);
    ctx.setLineWidth(0.8);
    ctx.newPath();
    ctx.moveTo(tx(a[0]), ty(a[1]));
    ctx.lineTo(tx(b[0]), ty(b[1]));
    ctx.stroke();
    // 45-deg ticks plus SHORT extension stubs towards the measured points -
    // a hand-placed chain far from its wall must not smear a line across the plan
    const tick = 6 / scale;
    const stub = Math.min(Math.abs(d.offset), 14 / scale);
    const back = d.offset >= 0 ? -1 : 1;
    for (const [ex, ey] of [a, b]) {
      ctx.newPath();
      ctx.moveTo(tx(ex - ux * tick + nx * tick), ty(ey - uy * tick + ny * tick));
      ctx.lineTo(tx(ex + ux * tick - nx * tick), ty(ey + uy * tick - ny * tick));
      ctx.stroke();
      ctx.newPath();
      ctx.moveTo(tx(ex), ty(ey));
      ctx.lineTo(tx(ex + nx * back * stub), ty(ey + ny * back * stub));
      ctx.stroke();
    }
    const label = d.label;
    const lw = p.width(label, { size: TYPE.micro });
    const side = d.offset >= 0 ? 1 : -1;
    const mx = tx((a[0] + b[0]) / 2 + nx * side * (14 / scale));
    const my = ty((a[1] + b[1]) / 2 + ny * side * (14 / scale));
    p.fillRect(mx - lw / 2 - 2, my - 5, lw + 4, 10, COLOR.white);
    p.text(mx - lw / 2, my - 4, label, { size: TYPE.micro, color: PLAN.dim });
  }

  // north arrow — compass angle is clockwise from plan-up
  const nx0 = x + w - 22;
  const ny0 = top + 30;
  const dirX = Math.sin(page.northAngle);
  const dirY = -Math.cos(page.northAngle);
  p.setColor(PLAN.dim);
  ctx.setLineWidth(1.4);
  ctx.newPath();
  ctx.moveTo(nx0 - dirX * 14, ny0 - dirY * 14);
  ctx.lineTo(nx0 + dirX * 14, ny0 + dirY * 14);
  ctx.stroke();
  ctx.newPath();
  ctx.moveTo(nx0 + dirX * 20, ny0 + dirY * 20);
  ctx.lineTo(nx0 + dirX * 10 - dirY * 5, ny0 + dirY * 10 + dirX * 5);
  ctx.lineTo(nx0 + dirX * 10 + dirY * 5, ny0 + dirY * 10 - dirX * 5);
  ctx.closePath();
  ctx.fill();
  p.text(nx0 + dirX * 20 + 4, ny0 + dirY * 20 - 4, 'N', { size: TYPE.caption, bold: true, color: PLAN.dim });

  const stripTop = top + drawH + 8;

  // scale bar: alternating 1 m segments, 5 m total (2 m at very large scales)
  const barMeters = 100 * scale > 56 ? 2 : 5;
  const seg = 100 * scale;
  p.setColor(COLOR.text);
  ctx.setLineWidth(0.8);
  for (let i = 0; i < barMeters; i++) {
    if (i % 2 === 0) p.fillRect(x + i * seg, stripTop, seg, 4, COLOR.text);
    ctx.rectangle(x + i * seg, stripTop, seg, 4);
    ctx.stroke();
  }
  p.text(x, stripTop + 6, '0', { size: TYPE.micro, color: COLOR.faint });
  p.text(x + barMeters * seg - 4, stripTop + 6, `${barMeters} m`, { size: TYPE.micro, color: COLOR.faint });

  const tbW = 190;
  let noteY = stripTop + 18;
  for (const note of page.notes) {
    // stay clear of the title block on the right
    p.text(x, noteY, note, { size: TYPE.micro, color: COLOR.faint, width: w - tbW - 16, ellipsize: true });
    noteY += 9;
  }

  // title block (Plankopf), bottom right
  const tbX = x + w - tbW;
  const tbY = stripTop;
  p.setColor(COLOR.line);
  ctx.setLineWidth(0.8);
  ctx.rectangle(tbX, tbY, tbW, titleBlockH);
  ctx.stroke();
  const rows: [string, string][] = [
    ['Objekt', page.object ?? '—'],
    ['Geschoss', page.title],
    ['Maßstab', `1:${ratio}`],
    ['Datum', page.datum ?? '—'],
    ['Verfasser', page.author ?? '—'],
  ];
  rows.forEach(([label, value], i) => {
    const ry = tbY + 4 + i * 11;
    p.text(tbX + 6, ry, label.toUpperCase(), { size: TYPE.micro, color: COLOR.faint });
    p.text(tbX + 58, ry, value, { size: TYPE.micro, width: tbW - 64, ellipsize: true });
  });
}

/** A plan page is one indivisible full-page piece on a fresh page. */
function planGroup(block: Extract<Block, { kind: 'plan' }>): Group {
  const h = BOTTOM_LIMIT - PAGE.marginTop - 4;
  return {
    ...GROUP_DEFAULTS,
    card: false,
    padX: 0,
    padY: 0,
    breakBefore: true,
    spaceAfter: 0,
    pieces: [{ h, draw: (pt, x, y, w) => drawPlan(pt, x, y, w, h, block.page) }],
  };
}

function blockToGroup(p: Painter, block: Block): Group | null {
  switch (block.kind) {
    case 'kpis':
      return kpiGroup(p, block);
    case 'scale':
      return scaleGroup(p, block);
    case 'bars':
      return barsGroup(block);
    case 'rows':
      return rowsGroup(p, block);
    case 'table':
      return tableGroup(p, block);
    case 'variants':
      return variantsGroup(p, block);
    case 'callout':
      return calloutGroup(p, block);
    case 'prose':
      return proseGroup(p, block);
    case 'plan':
      return planGroup(block);
    case 'pagebreak':
      return null;
  }
}

// ── Page flow ────────────────────────────────────────────────────────────────

const BOTTOM_LIMIT = PAGE.height - PAGE.marginBottom - 6;

/** Cover band, metadata row, running header and footer. */
class PageFurniture {
  constructor(
    private readonly p: Painter,
    private readonly doc: ReportDoc,
    private readonly totalPages: number,
  ) {}

  /** Draw the page's top furniture and return the y content starts at. */
  start(pageNo: number): number {
    const { p, doc } = this;
    if (pageNo > 1) {
      p.text(PAGE.marginX, PAGE.marginTop - 26, doc.subtitle, {
        size: TYPE.micro,
        color: COLOR.faint,
        width: CONTENT_W / 2,
        ellipsize: true,
      });
      p.text(PAGE.marginX + CONTENT_W / 2, PAGE.marginTop - 26, doc.title, {
        size: TYPE.micro,
        color: COLOR.faint,
        width: CONTENT_W / 2,
        align: 'right',
      });
      p.hline(PAGE.marginX, PAGE.marginX + CONTENT_W, PAGE.marginTop - 14);
      return PAGE.marginTop;
    }

    p.fillRect(0, 0, PAGE.width, PAGE.coverBandHeight, COLOR.band);
    p.text(PAGE.marginX, 30, doc.title, { size: TYPE.display, bold: true, color: COLOR.white });
    p.text(PAGE.marginX, 68, doc.subtitle, { size: TYPE.lead, color: '#b9cde2', width: CONTENT_W });
    if (doc.lead) {
      p.text(PAGE.marginX, 90, doc.lead, { size: TYPE.caption, color: '#9db6d0', width: CONTENT_W * 0.72 });
    }

    let y = PAGE.coverBandHeight + 16;
    const n = Math.max(1, doc.meta.length);
    const colW = CONTENT_W / n;
    doc.meta.forEach((m, i) => {
      const mx = PAGE.marginX + i * colW;
      p.text(mx, y, m.label.toUpperCase(), { size: TYPE.micro, color: COLOR.faint, width: colW - 10 });
      p.text(mx, y + 9, m.value, { size: TYPE.body, bold: true, width: colW - 10, ellipsize: true });
    });
    y += 24;
    p.hline(PAGE.marginX, PAGE.marginX + CONTENT_W, y);
    return y + 18;
  }

  /** Footer rule, note and page number — drawn before the page is closed. */
  end(pageNo: number): void {
    const { p, doc } = this;
    const y = PAGE.height - PAGE.marginBottom + 12;
    p.hline(PAGE.marginX, PAGE.marginX + CONTENT_W, y);
    p.text(PAGE.marginX, y + 5, doc.footer, {
      size: TYPE.micro,
      color: COLOR.faint,
      width: CONTENT_W - 90,
      ellipsize: true,
    });
    const label = this.totalPages > 0 ? `Seite ${pageNo} von ${this.totalPages}` : `Seite ${pageNo}`;
    p.text(PAGE.marginX + CONTENT_W - 90, y + 5, label, {
      size: TYPE.micro,
      color: COLOR.faint,
      width: 90,
      align: 'right',
    });
  }
}

/**
 * Lay the document out onto pages and draw it. Returns the number of pages.
 *
 * `totalPages` of 0 means "not known yet" — the counting pass; the footer then
 * omits the "von N".
 */
function renderPass(doc: ReportDoc, path: string, totalPages: number, cairo: Cairo, gi: Gi): number {
  const surface = new cairo.PDFSurface(path, PAGE.width, PAGE.height);
  const ctx = new cairo.Context(surface);
  const p = new Painter(ctx, gi);
  const furniture = new PageFurniture(p, doc, totalPages);

  let pageNo = 1;
  /** Where content starts on the current page — `start()` draws, so cache it. */
  let pageTop = furniture.start(pageNo);
  let y = pageTop;
  const x = PAGE.marginX;

  const newPage = (): void => {
    furniture.end(pageNo);
    ctx.showPage();
    pageNo += 1;
    pageTop = furniture.start(pageNo);
    y = pageTop;
  };
  /** True when nothing has been placed on this page yet — never break twice. */
  const atPageTop = (): boolean => y <= pageTop + 0.01;

  for (const block of doc.blocks) {
    if (block.kind === 'pagebreak') {
      if (!atPageTop()) newPage();
      continue;
    }
    const g = blockToGroup(p, block);
    if (!g || g.pieces.length === 0) continue;
    if (g.breakBefore && !atPageTop()) newPage();

    // A heading must never be the last thing on a page — and a keepTogether
    // group moves as a whole as long as a whole page can hold it.
    const headH = groupHeadingHeight(p, g);
    const needed = g.keepTogether
      ? headH + groupBodyHeight(g)
      : headH + g.padY * 2 + g.pieces[0].h;
    const fitsOnAFreshPage = pageTop + needed <= BOTTOM_LIMIT;
    if (!atPageTop() && y + needed > BOTTOM_LIMIT && (fitsOnAFreshPage || !g.keepTogether)) newPage();
    y += drawGroupHeading(p, g, x, y);

    let i = 0;
    while (i < g.pieces.length) {
      // Pack as many pieces as fit; always at least one, so an oversized piece
      // overflows visibly instead of looping forever.
      const withRepeat = i > 0 && g.repeat ? g.repeat : null;
      let content = withRepeat ? withRepeat.h + g.gap : 0;
      let n = 0;
      while (i + n < g.pieces.length) {
        const add = g.pieces[i + n].h + (n > 0 || withRepeat ? g.gap : 0);
        if (n > 0 && y + g.padY * 2 + content + add > BOTTOM_LIMIT) break;
        content += add;
        n += 1;
      }
      const chunkH = g.padY * 2 + content;
      if (g.card) p.card(x, y, CONTENT_W, chunkH, { accent: g.accent });

      let cy = y + g.padY;
      const innerX = x + g.padX;
      const innerW = CONTENT_W - 2 * g.padX;
      if (withRepeat) {
        withRepeat.draw(p, innerX, cy, innerW, true);
        cy += withRepeat.h + g.gap;
      }
      for (let k = 0; k < n; k++) {
        const piece = g.pieces[i + k];
        piece.draw(p, innerX, cy, innerW, k === 0 && !withRepeat);
        cy += piece.h + g.gap;
      }

      i += n;
      y += chunkH;
      if (i < g.pieces.length) newPage();
      else y += g.spaceAfter;
    }
  }

  furniture.end(pageNo);
  ctx.showPage();
  surface.flush();
  surface.finish();
  return pageNo;
}

function groupHeadingHeight(p: Painter, g: Group): number {
  if (!g.title && !g.description) return 0;
  let h = 0;
  if (g.title) h += p.height(g.title, { size: TYPE.title, bold: true, width: CONTENT_W }) + 2;
  if (g.description) h += p.height(g.description, { size: TYPE.description, width: CONTENT_W }) + 2;
  return h + 6;
}

/** The `Adw.PreferencesGroup` heading: title + description, above the card. */
function drawGroupHeading(p: Painter, g: Group, x: number, y: number): number {
  if (!g.title && !g.description) return 0;
  let cy = y;
  if (g.title) {
    cy += p.text(x, cy, g.title, { size: TYPE.title, bold: true, width: CONTENT_W }) + 2;
  }
  if (g.description) {
    cy += p.text(x, cy, g.description, { size: TYPE.description, color: COLOR.dim, width: CONTENT_W }) + 2;
  }
  return cy - y + 6;
}

/**
 * Render a report to a PDF file.
 *
 * @param doc The document, e.g. from `buildSanierungsplan`.
 * @param outPath Absolute path of the PDF to write.
 * @returns The path written and the number of pages. The count is the one the
 *   footers were numbered against — cairo packs its page objects into
 *   compressed object streams, so it cannot be recovered from the file without
 *   a PDF parser.
 * @throws If the GJS runtime (cairo + Pango) is unavailable.
 */
export function renderReportPdf(doc: ReportDoc, outPath: string): RenderResult {
  const { cairo, gi } = runtime();
  // Pass 1 exists only to learn the page count for "Seite n von m"; a PDF page
  // is sealed by showPage(), so it cannot be back-patched.
  const scratch = gi.GLib.build_filenamev([gi.GLib.get_tmp_dir(), `bauplaner-report-${Date.now()}.tmp.pdf`]);
  const total = renderPass(doc, scratch, 0, cairo, gi);
  gi.GLib.unlink(scratch);
  const pages = renderPass(doc, outPath, total, cairo, gi);
  return { path: outPath, pages };
}
