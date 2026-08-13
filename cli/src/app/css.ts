/**
 * The app's own stylesheet: every class name a view sets that libadwaita does
 * not already define.
 *
 * Installed ONCE, by the shell — `runAdwaitaApp({ css })` builds a single
 * `Gtk.CssProvider` at `STYLE_PROVIDER_PRIORITY_APPLICATION` on the default
 * display. That is exactly what four `installXCss()` helpers used to do by
 * hand, each behind its own module-level "already installed" flag and its own
 * `realize` handler, because a provider has to be added to a *display* and a
 * view only learns its display when it is realized. The shell has the display
 * at `startup`, so none of that bookkeeping is needed here.
 *
 * Colours that exist somewhere else are DERIVED, never retyped: the dashboard
 * badge, the legend under the model and the wall the legend describes all
 * describe one building, and a hex literal copied into a stylesheet is how they
 * stop agreeing.
 */

import { ENERGIEKLASSEN, KLASSE_FARBE, U_VALUE_SCALE, uValueColor } from '@bauplaner/materials';

import { FEUCHTE_WALL_COLOR } from './wall-coloring.ts';

/** `0xRRGGBB` → a CSS `#rrggbb` string. */
export function cssHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Shared shape of the small coloured pills (energy class, climate status). */
const PILL = 'color: #fff; font-weight: bold; padding: 1px 9px; border-radius: 7px;';

/** One background rule per energy class, in the kernel's own palette. */
const ENERGY_CLASS_RULES = ENERGIEKLASSEN.map(
  (k, i) => `.eff-${i} { background-color: ${KLASSE_FARBE[k]}; }`,
).join('\n');

/** The legend's U-value ramp, sampled from the same function that colours walls. */
const U_VALUE_GRADIENT = (() => {
  const mid = (U_VALUE_SCALE.min + U_VALUE_SCALE.max) / 2;
  return (
    '.er-uvalue-gradient { min-width: 180px; min-height: 12px; border-radius: 4px;' +
    ` background: linear-gradient(to right, ${cssHex(uValueColor(U_VALUE_SCALE.min))} 0%,` +
    ` ${cssHex(uValueColor(mid))} 50%, ${cssHex(uValueColor(U_VALUE_SCALE.max))} 100%); }`
  );
})();

export const APP_CSS = [
  // Nav-row count pills — the accent at low opacity, so they follow the theme.
  '.nav-badge { min-width: 1.1em; padding: 0 6px; border-radius: 9px;' +
    ' background-color: alpha(@accent_bg_color, 0.85); color: @accent_fg_color;' +
    ' font-size: 0.8em; font-weight: bold; }',

  // Energy-class badge on the dashboard.
  `.eff-badge { ${PILL} }`,
  ENERGY_CLASS_RULES,

  // Raumklima status pills. Their own palette, not the report's: that one is
  // mixed for a white PDF page, and its `warn` is a darker orange than reads
  // well on a pill.
  `.climate-badge { ${PILL} }`,
  '.climate-good { background-color: #26a269; }',
  '.climate-warn { background-color: #e5a50a; }',
  '.climate-bad { background-color: #c01c28; }',

  // Model-overlay legend.
  U_VALUE_GRADIENT,
  `.er-swatch-feuchte { min-width: 18px; min-height: 14px; border-radius: 4px;` +
    ` background-color: ${cssHex(FEUCHTE_WALL_COLOR)}; }`,
].join('\n');
