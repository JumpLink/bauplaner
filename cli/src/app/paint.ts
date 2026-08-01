/**
 * Tiny Cairo painting helpers shared by the views.
 *
 * Exists so the palette can live in the kernel as `#rrggbb` strings — the same
 * form the PDF renderer consumes — without every `set_draw_func` re-deriving the
 * conversion.
 */

/** Minimal shape of the Cairo context GTK hands a draw function. */
export interface DrawContext {
  setSourceRGB(r: number, g: number, b: number): void;
}

/**
 * Set the source colour from a `#rrggbb` string.
 *
 * @param cr The Cairo context from `set_draw_func`.
 * @param hex Colour as `#rrggbb`.
 */
export function setHex(cr: DrawContext, hex: string): void {
  const n = Number.parseInt(hex.slice(1), 16);
  cr.setSourceRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
