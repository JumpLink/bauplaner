/** CLI formatting helpers. */

// German number formatting lives in the kernel (`@bauplaner/report`), so the
// CLI tables, the Adwaita views and the exported PDF all round and separate the
// same way. Re-exported here because every adapter file already imports it from
// this module.
export { fmtEur, fmtEur0, fmtJahre, fmtNum, fmtProzent } from '@bauplaner/report';

/**
 * Escape text for a Pango-markup context. Adwaita row titles/subtitles are
 * markup, so dynamic text (a cost label like "Drainage & Erdarbeiten") must be
 * escaped or a bare "&"/"<" aborts parsing and renders a blank label.
 */
export function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
