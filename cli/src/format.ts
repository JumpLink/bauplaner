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
  return `${fmtNum(n, 2)} €`;
}

/**
 * Format a number German-style: comma as the decimal mark, dot as the thousands
 * separator. `toFixed` alone produces `0.191`, which reads as a different number
 * to a German eye — and this tool prints U-values next to euro amounts.
 */
export function fmtNum(n: number, digits = 2): string {
  const [int, frac] = Math.abs(n).toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `,${frac}` : ''}`;
}
