/**
 * Presentation metadata for the TGA (building-services) trades — the colour and
 * German label each Gewerk is drawn and chipped with. Kept at the app layer (the
 * core `@bauplaner/core` tga module stays free of any rendering concern), shared
 * by the Grundriss overlay and its trade chips so both always agree.
 */

import type { TgaNodeKind, TgaTrade } from '@bauplaner/core';

export interface TradeMeta {
  label: string;
  /** 0xRRGGBB line/marker colour for this trade. */
  color: number;
}

/** Trade → label + colour (heat red, water blue, electric amber, …). */
export const TRADE_META: Record<TgaTrade, TradeMeta> = {
  heizung: { label: 'Heizung', color: 0xe01b24 },
  fbh: { label: 'Fußbodenheizung', color: 0xff7800 },
  wasser: { label: 'Wasser', color: 0x3584e4 },
  strom: { label: 'Strom', color: 0xf5c211 },
  lueftung: { label: 'Lüftung', color: 0x33d17a },
};

/** German label for each node kind, for the placement palette. */
export const KIND_LABELS: Record<TgaNodeKind, string> = {
  erzeuger: 'Erzeuger / Quelle',
  verteiler: 'Verteiler',
  heizkoerper: 'Heizkörper',
  ventil: 'Ventil',
  zapfstelle: 'Zapfstelle',
  steckdose: 'Steckdose',
  leuchte: 'Leuchte',
  auslass: 'Auslass',
};

/** The node kinds a given trade offers in the palette (first = default). */
export const KINDS_BY_TRADE: Record<TgaTrade, TgaNodeKind[]> = {
  heizung: ['heizkoerper', 'verteiler', 'ventil', 'erzeuger'],
  fbh: ['verteiler', 'ventil', 'auslass'],
  wasser: ['zapfstelle', 'ventil', 'erzeuger'],
  strom: ['steckdose', 'leuchte', 'verteiler'],
  lueftung: ['auslass', 'ventil', 'erzeuger'],
};
