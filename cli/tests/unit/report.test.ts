import { describe, it, expect } from '@gjsify/unit';

import { deriveEnvelope, parseSh3dBytes, type HomeData } from '@bauplaner/core';
import {
  PRESET_ASSEMBLIES,
  computeRoadmap,
  presetByKey,
  vergleicheVarianten,
  type VergleichErgebnis,
  type WandVariante,
} from '@bauplaner/materials';
import {
  buildSanierungsplan,
  fmtEur0,
  pdfExportAvailable,
  renderReportPdf,
  type Block,
  type GebaeudeTeil,
} from '@bauplaner/report';
import { zipSync, strToU8 } from 'fflate';

import { buildEnergyScreenings } from '../../src/energy.ts';

const HOME_XML =
  '<home version="7000">' +
  '<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>' +
  '<wall id="w1" level="L0" xStart="0" yStart="0" xEnd="800" yEnd="0" height="250" thickness="36"/>' +
  '<wall id="w2" level="L0" xStart="800" yStart="0" xEnd="800" yEnd="600" height="250" thickness="36"/>' +
  '<wall id="w3" level="L0" xStart="800" yStart="600" xEnd="0" yEnd="600" height="250" thickness="36"/>' +
  '<wall id="w4" level="L0" xStart="0" yStart="600" xEnd="0" yEnd="0" height="250" thickness="36"/>' +
  '<room id="r1" name="Raum" level="L0">' +
  '<point x="0" y="0"/><point x="800" y="0"/><point x="800" y="600"/><point x="0" y="600"/>' +
  '</room>' +
  '</home>';

const home = (): HomeData => parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) }));

/** The whole-building part, as both adapters assemble it. */
const gebaeude = (h: HomeData): GebaeudeTeil => {
  const e = buildEnergyScreenings(h, () => undefined);
  return { envelope: e.envelope, start: e.start, heute: e.heute, ziel: e.ziel, isfpBonus: true };
};

const preset = (key: string): WandVariante => {
  const p = presetByKey(key);
  if (!p) throw new Error(`Preset ${key} fehlt`);
  return p;
};

const wandVergleich = (areaM2 = 200): VergleichErgebnis =>
  vergleicheVarianten({
    referenz: preset('bestand-vollziegel-365'),
    varianten: PRESET_ASSEMBLIES.filter((p) => p.key !== 'bestand-vollziegel-365'),
    areaM2,
    isfpBonus: true,
  });

const kinds = (blocks: Block[]): string => blocks.map((b) => b.kind).join(',');

/** All text in a block, flattened — enough to assert what a page says. */
function textOf(block: Block): string {
  return [headingOf(block), bodyOf(block)].join(' ');
}

/** Section title + description, which most blocks carry. */
function headingOf(block: Block): string {
  const b = block as { title?: string; description?: string };
  return `${b.title ?? ''} ${b.description ?? ''}`;
}

function bodyOf(block: Block): string {
  switch (block.kind) {
    case 'kpis':
      return block.items.map((k) => `${k.caption}|${k.value}|${k.sub ?? ''}`).join(' ');
    case 'rows':
      return block.rows.map((r) => `${r.label}|${r.value ?? ''}`).join(' ');
    case 'table':
      return [
        ...block.columns.map((c) => c.label),
        ...block.rows.flat().map((c) => c.text),
        ...(block.total ?? []).map((c) => c.text),
      ].join(' ');
    case 'variants':
      return block.items
        .map((v) => `${v.rank}|${v.name}|${v.chips.map((c) => c.text).join('/')}|${v.metrics.map((m) => m.value).join('/')}`)
        .join(' ');
    case 'prose':
      return block.paragraphs.join(' ');
    case 'callout':
      return `${block.title} ${block.text}`;
    case 'bars':
      return block.items.map((b) => `${b.label}|${b.value}`).join(' ');
    case 'scale':
      return block.markers.map((m) => m.label).join(' ');
    case 'pagebreak':
      return '';
  }
}

const allText = (blocks: Block[]): string => blocks.map(textOf).join(' ');

export default async () => {
  await describe('buildSanierungsplan — the cover', async () => {
    await it('carries the object, the date and the author', async () => {
      const doc = buildSanierungsplan({
        name: 'Beispielhaus',
        datum: '1. August 2026',
        ort: 'Cuxhaven',
        verfasser: 'Planer',
        wand: wandVergleich(),
      });
      expect(doc.title).toBe('Sanierungsplan');
      expect(doc.subtitle).toBe('Beispielhaus');
      expect(doc.meta.map((m) => `${m.label}=${m.value}`).join(';')).toBe(
        'Objekt=Beispielhaus, Cuxhaven;Stand=1. August 2026;Erstellt von=Planer',
      );
      // The footer repeats on every page, so it has to carry the caveat.
      expect(doc.footer.includes('Screening, kein Nachweis')).toBe(true);
    });

    await it('omits the author line when nobody is named', async () => {
      const doc = buildSanierungsplan({ name: 'Haus', datum: 'heute', wand: wandVergleich() });
      expect(doc.meta.map((m) => m.label).join(',')).toBe('Objekt,Stand');
    });
  });

  await describe('buildSanierungsplan — which parts appear', async () => {
    await it('builds a component-only plan when there is no model', async () => {
      const doc = buildSanierungsplan({ name: 'Haus', datum: 'heute', wand: wandVergleich() });
      // Ranking table + cards + the assumptions page. No Kennzahlen, no Fahrplan.
      expect(kinds(doc.blocks)).toBe('table,variants,pagebreak,prose');
    });

    await it('builds the full plan from a model', async () => {
      const doc = buildSanierungsplan({
        name: 'Haus',
        datum: 'heute',
        gebaeude: gebaeude(home()),
        wand: wandVergleich(),
      });
      expect(kinds(doc.blocks)).toBe(
        'kpis,scale,bars,pagebreak,table,rows,callout,pagebreak,table,variants,pagebreak,prose',
      );
    });

    await it('always ends on the assumptions, whatever went before', async () => {
      for (const doc of [
        buildSanierungsplan({ name: 'H', datum: 'd', wand: wandVergleich() }),
        buildSanierungsplan({ name: 'H', datum: 'd', gebaeude: gebaeude(home()) }),
      ]) {
        const last = doc.blocks[doc.blocks.length - 1];
        expect(last.kind).toBe('prose');
        expect(textOf(last).includes('ersetzt weder einen individuellen Sanierungsfahrplan')).toBe(true);
      }
    });

    await it('appends caller notes to the assumptions', async () => {
      const doc = buildSanierungsplan({
        name: 'H',
        datum: 'd',
        wand: wandVergleich(),
        hinweise: ['Dachüberstand ist bauseits zu klären.'],
      });
      expect(allText(doc.blocks).includes('Dachüberstand ist bauseits zu klären.')).toBe(true);
    });
  });

  await describe('buildSanierungsplan — the money has to match the kernel', async () => {
    await it('reports the roadmap totals the Fahrplan itself computes', async () => {
      const h = home();
      const g = gebaeude(h);
      const roadmap = computeRoadmap(deriveEnvelope(h), { foerderung: true, isfpBonus: true });
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', gebaeude: g });

      const fahrplan = doc.blocks.find((b) => b.kind === 'table');
      if (!fahrplan || fahrplan.kind !== 'table' || !fahrplan.total) throw new Error('Fahrplan-Tabelle fehlt');
      // Columns are: Nr · Paket · Bezug · Kosten · Förderung · Eigenanteil.
      const totals = fahrplan.total.map((c) => c.text);
      expect(totals[3]).toBe(fmtEur0(roadmap.totalKostenEur));
      expect(totals[4]).toBe(fmtEur0(roadmap.totalFoerderungEur));
      expect(totals[5]).toBe(fmtEur0(roadmap.totalEigenanteilEur));

      // …and the Eigenanteil tile shows the same figure as that totals row.
      const kpis = doc.blocks.find((b) => b.kind === 'kpis');
      if (!kpis || kpis.kind !== 'kpis') throw new Error('Kennzahlen fehlen');
      const eigen = kpis.items.find((k) => k.caption === 'Eigenanteil');
      expect(eigen?.value).toBe(totals[5]);
    });

    await it('shows one Kennzahlen grid of eight tiles, not two rows of four', async () => {
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', gebaeude: gebaeude(home()) });
      const kpiBlocks = doc.blocks.filter((b) => b.kind === 'kpis');
      expect(kpiBlocks.length).toBe(1);
      if (kpiBlocks[0].kind !== 'kpis') throw new Error('unreachable');
      expect(kpiBlocks[0].items.length).toBe(8);
    });

    await it('prints cost categories and statuses as words, not storage keys', async () => {
      const g = gebaeude(home());
      g.kosten = [{ label: 'Holzfaser', net: 2400, category: 'daemmung', status: 'angeboten' }];
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', gebaeude: g });
      const text = allText(doc.blocks);
      expect(text.includes('Dämmung')).toBe(true);
      expect(text.includes('Angeboten')).toBe(true);
      expect(text.includes('daemmung')).toBe(false);
    });

    await it('leaves the quotes section out when nothing is recorded', async () => {
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', gebaeude: gebaeude(home()) });
      expect(allText(doc.blocks).includes('Erfasste Angebote')).toBe(false);
    });
  });

  await describe('buildSanierungsplan — the wall decision', async () => {
    await it('ranks the reference first and unranked, then the candidates', async () => {
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', wand: wandVergleich() });
      const cards = doc.blocks.find((b) => b.kind === 'variants');
      if (!cards || cards.kind !== 'variants') throw new Error('Variantenkarten fehlen');
      expect(cards.items[0].rank).toBe('0');
      expect(cards.items[0].name.startsWith('Ausgangslage')).toBe(true);
      expect(cards.items.slice(1).map((v) => v.rank).join(',')).toBe('1,2,3,4,5,6,7');
      expect(cards.items[1].best).toBe(true);
    });

    await it('says plainly when a build-up forfeits the whole subsidy', async () => {
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', wand: wandVergleich() });
      const cards = doc.blocks.find((b) => b.kind === 'variants');
      if (!cards || cards.kind !== 'variants') throw new Error('Variantenkarten fehlen');
      // 16 cm wood fibre lands at U 0,211 and misses BEG's 0,20 — the near-miss
      // the comparison exists to price in.
      const knapp = cards.items.find((v) => v.name.includes('16 cm Holzfaser'));
      if (!knapp) throw new Error('16-cm-Variante fehlt');
      expect(knapp.chips.some((c) => c.text.includes('keine Förderung') && c.tone === 'bad')).toBe(true);
      expect(knapp.metrics.some((m) => m.label.startsWith('− Förderung') && m.value.startsWith('0'))).toBe(true);
    });

    await it('scales the comparison to the area it was given', async () => {
      const klein = buildSanierungsplan({ name: 'H', datum: 'd', wand: wandVergleich(100) });
      const gross = buildSanierungsplan({ name: 'H', datum: 'd', wand: wandVergleich(400) });
      expect(allText(klein.blocks).includes('100 m² Außenwandfläche')).toBe(true);
      expect(allText(gross.blocks).includes('400 m² Außenwandfläche')).toBe(true);
    });

    await it('draws every layer of a build-up, existing fabric marked as such', async () => {
      const doc = buildSanierungsplan({ name: 'H', datum: 'd', wand: wandVergleich() });
      const cards = doc.blocks.find((b) => b.kind === 'variants');
      if (!cards || cards.kind !== 'variants') throw new Error('Variantenkarten fehlen');
      const aussen = cards.items.find((v) => v.name.includes('18 cm Holzfaser') && !v.name.includes('Kombination'));
      if (!aussen) throw new Error('18-cm-Variante fehlt');
      // Bestand-Ziegel 36,5 + 18 cm Dämmung + 2 cm Putz.
      expect(aussen.layers.map((l) => Math.round(l.cm)).join(',')).toBe('37,18,2');
      expect(aussen.layers.map((l) => (l.bestand ? 'B' : '-')).join(',')).toBe('B,-,-');
      // Every segment needs a colour or the strip renders invisible bars.
      expect(aussen.layers.every((l) => /^#[0-9a-f]{6}$/i.test(l.color))).toBe(true);
    });
  });

  await describe('renderReportPdf', async () => {
    await it('writes a real PDF whose page count matches its own footer', async () => {
      if (!pdfExportAvailable()) {
        // Node has no cairo; the model tests above still cover the document.
        expect(true).toBe(true);
        return;
      }
      const { readFileSync, unlinkSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const out = join(tmpdir(), 'bauplaner-report-test.pdf');

      const doc = buildSanierungsplan({
        name: 'Testhaus',
        datum: '1. August 2026',
        gebaeude: gebaeude(home()),
        wand: wandVergleich(),
      });
      const result = renderReportPdf(doc, out);

      const bytes = readFileSync(out);
      const text = new TextDecoder('latin1').decode(new Uint8Array(bytes.subarray(0, 16)));
      expect(text.startsWith('%PDF-')).toBe(true);
      expect(bytes.length > 10000).toBe(true);

      // The reported page count is the one the "Seite n von m" footers were
      // numbered against — a plan of this size is several pages, and a count of
      // 1 would mean the flow engine never broke a page at all.
      expect(result.path).toBe(out);
      expect(result.pages > 3).toBe(true);
      unlinkSync(out);
    });
  });
};
