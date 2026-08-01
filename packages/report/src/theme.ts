/**
 * The look of the exported PDF — the app's Adwaita visual language translated
 * into print.
 *
 * The point is that the document reads as the *same product* as the window it
 * came from: the same greens and reds mean the same things, cards carry the
 * same rounded hairline border, section headings sit above their card like an
 * `Adw.PreferencesGroup` title, and numbers are set in the same typeface. A
 * plan that looks like a spreadsheet dump invites the reader to check the
 * arithmetic; one that looks composed invites them to read the argument.
 *
 * Everything here is data — sizes in PostScript points (1/72 inch), colours as
 * `#rrggbb`. The renderer is the only thing that knows about cairo.
 */

/** A4 portrait, in points, plus the printable margins. */
export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 46,
  /** Top of the content area on a normal page (the cover band overrides it). */
  marginTop: 58,
  marginBottom: 46,
  /** Full-bleed accent band across the top of page 1. */
  coverBandHeight: 132,
} as const;

/** Width available to content between the side margins. */
export const CONTENT_W = PAGE.width - 2 * PAGE.marginX;

/**
 * Cantarell is the GNOME UI font, so the document matches the app on any GNOME
 * box; Pango falls back to the generic sans elsewhere, and cairo embeds
 * whichever it used, so the recipient sees what we saw.
 */
export const FONT_FAMILY = 'Cantarell,Sans';

/** Type scale in points. Named after the Adwaita style classes they mirror. */
export const TYPE = {
  /** Cover title. */
  display: 25,
  /** Cover subtitle / lead. */
  lead: 10.5,
  /** Section heading above a card (`.title-2`). */
  title: 12.5,
  /** Section description under the heading (`.dim-label .caption`). */
  description: 8.2,
  /** Card / row heading (`.heading`). */
  heading: 9.6,
  /** Running text and row values. */
  body: 8.8,
  /** Sub-lines, table headers, chips (`.caption`). */
  caption: 7.4,
  /** Page furniture. */
  micro: 6.6,
  /** The big number on a KPI tile (`.title-2 .numeric`). */
  kpi: 17.5,
} as const;

/** Corner radius of cards and chips. */
export const RADIUS = { card: 7, chip: 4, badge: 5 } as const;

/**
 * Palette. Greys are Adwaita's light-theme neutrals; the accents are the
 * standard GNOME colours the app already uses for the same meanings, so a red
 * bar in the PDF is the red bar in the window.
 */
export const COLOR = {
  text: '#241f31',
  dim: '#5e5c64',
  faint: '#8b8a8f',
  /** Hairlines between rows. */
  line: '#e3e1de',
  /** Card fill and border. */
  cardBg: '#fbfbfa',
  cardLine: '#e0dedb',
  white: '#ffffff',
  accent: '#3584e4',
  /** Deep accent for the cover band — accent blue is too loud over a full page. */
  band: '#1b3b5f',
  ok: '#26a269',
  warn: '#c26100',
  bad: '#c01c28',
  purple: '#813d9c',
} as const;

/** Semantic colouring shared by chips, row values, metrics and callouts. */
export type Tone = 'neutral' | 'dim' | 'accent' | 'ok' | 'warn' | 'bad';

export const TONE_COLOR: Record<Tone, string> = {
  neutral: COLOR.text,
  dim: COLOR.dim,
  accent: COLOR.accent,
  ok: COLOR.ok,
  warn: COLOR.warn,
  bad: COLOR.bad,
};

/**
 * Chip/callout background for a tone — the accent at low opacity, pre-mixed
 * against white so the renderer never needs alpha compositing.
 */
export const TONE_TINT: Record<Tone, string> = {
  neutral: '#f0efee',
  dim: '#f0efee',
  accent: '#e4eefc',
  ok: '#e2f2e9',
  warn: '#fbeddd',
  bad: '#fae4e6',
};

/** Heat-loss bar colour per envelope element — matches the Übersicht dashboard. */
export const VERLUST_FARBE: Record<string, string> = {
  wall: '#c01c28',
  roof: '#e66100',
  window: '#e5a50a',
  ventilation: '#813d9c',
  floor: '#26a269',
};
