/** CLI formatting helpers. */

/**
 * Escape text for a Pango-markup context. Adwaita row titles/subtitles are
 * markup, so dynamic text (a cost label like "Drainage & Erdarbeiten") must be
 * escaped or a bare "&"/"<" aborts parsing and renders a blank label.
 */
export function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format a euro amount with German separators (1.234,56 €). */
export function fmtEur(n: number): string {
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${grouped},${frac} €`;
}
