import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import {
  PROJECT_SCHEMA_VERSION,
  computeSh3dHash,
  createProjectForSh3d,
  deriveGross,
  loadDocumentFile,
  parseProject,
  saveProjectFile,
  serializeProject,
  summarizeCosts,
  type CostItem,
} from '@bauplaner/core';

function sh3dBytes(homeXml: string): Uint8Array {
  return zipSync({ 'Home.xml': strToU8(homeXml) });
}
const WALL1 = '<home><wall id="w1" xStart="0" yStart="0" xEnd="100" yEnd="0" height="250" thickness="24"/></home>';
const WALL2 =
  '<home><wall id="w1" xStart="0" yStart="0" xEnd="200" yEnd="0" height="250" thickness="24"/>' +
  '<wall id="w2" xStart="0" yStart="0" xEnd="100" yEnd="100" height="250" thickness="24"/></home>';

export default async () => {
  await describe('project — pure', async () => {
    await it('computeSh3dHash matches a known sha256', async () => {
      expect(computeSh3dHash(strToU8('abc'))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    await it('createProjectForSh3d references the file by basename', async () => {
      const p = createProjectForSh3d('/some/dir/beispielhaus.sh3d', { sha256: 'deadbeef' });
      expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
      expect(p.sh3d.path).toBe('beispielhaus.sh3d');
      expect(p.sh3d.sha256).toBe('deadbeef');
      expect(p.meta?.name).toBe('beispielhaus');
    });

    await it('serialize → parse round-trips', async () => {
      const p = createProjectForSh3d('/d/plan.sh3d', { sha256: 'abc123' });
      const back = parseProject(serializeProject(p));
      expect(back.schemaVersion).toBe(p.schemaVersion);
      expect(back.sh3d.path).toBe('plan.sh3d');
      expect(back.sh3d.sha256).toBe('abc123');
    });

    await it('preserves wall annotations (assembly + feuchte) through a round-trip', async () => {
      const p = createProjectForSh3d('/d/plan.sh3d');
      p.annotations = {
        walls: {
          w1: {
            assemblyLayers: [{ materialKey: 'holzfaser', thicknessM: 0.12 }],
            feuchte: {
              observations: { belowGrade: true, weatherCorrelated: true },
              topCause: 'aufstauend_seitlich',
              confidence: 1,
            },
          },
        },
      };
      const back = parseProject(serializeProject(p));
      expect(back.annotations?.walls?.w1?.feuchte?.topCause).toBe('aufstauend_seitlich');
      expect(back.annotations?.walls?.w1?.assemblyLayers?.[0].materialKey).toBe('holzfaser');
    });

    await it('createProjectForSh3d starts with an empty cost register (v2)', async () => {
      const p = createProjectForSh3d('/d/plan.sh3d');
      expect(p.schemaVersion).toBe(2);
      expect(Array.isArray(p.costs)).toBe(true);
      expect(p.costs?.length).toBe(0);
    });

    await it('loads a v1 file (no costs) unchanged', async () => {
      const back = parseProject('{"schemaVersion":1,"sh3d":{"path":"x.sh3d"}}');
      expect(back.schemaVersion).toBe(1);
      expect(back.costs).toBe(undefined);
    });

    await it('cost items round-trip through serialize → parse', async () => {
      const p = createProjectForSh3d('/d/plan.sh3d');
      p.costs = [
        { id: 'c1', label: 'DERNOTON Lieferung', category: 'material', status: 'angeboten', net: 4157.3, vatRate: 0.19, note: 'Angebot S73540' },
      ];
      const back = parseProject(serializeProject(p));
      expect(back.costs?.[0].label).toBe('DERNOTON Lieferung');
      expect(back.costs?.[0].net).toBe(4157.3);
      expect(back.costs?.[0].note).toBe('Angebot S73540');
    });

    await it('summarizeCosts totals net/VAT/gross and groups by category/status', async () => {
      const costs: CostItem[] = [
        { id: 'a', label: 'Material', category: 'material', status: 'angeboten', net: 1000, vatRate: 0.19 },
        { id: 'b', label: 'Lieferung', category: 'lieferung', status: 'angeboten', net: 500, vatRate: 0.19 },
        { id: 'c', label: 'Drainage', category: 'drainage', status: 'geplant', net: 300 }, // default 19 %
      ];
      const s = summarizeCosts(costs);
      expect(s.count).toBe(3);
      expect(s.net).toBe(1800);
      expect(s.gross).toBe(2142); // 1800 × 1.19
      expect(s.vat).toBe(342);
      expect(s.byStatus.angeboten).toBe(1500);
      expect(s.byCategory.material).toBe(1000);
    });

    await it('deriveGross applies the VAT rate', async () => {
      expect(deriveGross(100)).toBe(119);
      expect(deriveGross(100, 0)).toBe(100);
    });

    await it('summarizeCosts of an empty register is all zeros', async () => {
      const s = summarizeCosts([]);
      expect(s.count).toBe(0);
      expect(s.net).toBe(0);
      expect(s.gross).toBe(0);
    });

    await it('parseProject rejects malformed / unsupported files', async () => {
      const throws = (fn: () => unknown) => {
        try {
          fn();
          return false;
        } catch {
          return true;
        }
      };
      expect(throws(() => parseProject('not json'))).toBe(true);
      expect(throws(() => parseProject('{}'))).toBe(true); // no schemaVersion
      expect(throws(() => parseProject('{"schemaVersion":1}'))).toBe(true); // no sh3d.path
      expect(throws(() => parseProject('{"schemaVersion":999,"sh3d":{"path":"x.sh3d"}}'))).toBe(true);
    });
  });

  await describe('project — load/save round-trip', async () => {
    await it('opens a bare .sh3d, saves a sidecar, reloads it, detects drift', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ecoproj-'));
      const sh3dPath = join(dir, 'plan.sh3d');
      writeFileSync(sh3dPath, sh3dBytes(WALL1));

      // bare .sh3d → wrapped project, no sidecar yet
      const doc = loadDocumentFile(sh3dPath);
      expect(doc.home.walls.length).toBe(1);
      expect(doc.projectPath).toBe(null);
      expect(doc.sh3dChanged).toBe(false);

      // save the sidecar next to the .sh3d
      const saved = saveProjectFile(doc.project, doc.sh3dPath);
      expect(saved.endsWith('plan.ecoretrofit.json')).toBe(true);

      // reopen via the sidecar
      const doc2 = loadDocumentFile(saved);
      expect(doc2.home.walls.length).toBe(1);
      expect(doc2.projectPath?.endsWith('plan.ecoretrofit.json')).toBe(true);
      expect(doc2.sh3dChanged).toBe(false);

      // edit the .sh3d under the project → drift detected
      writeFileSync(sh3dPath, sh3dBytes(WALL2));
      const doc3 = loadDocumentFile(saved);
      expect(doc3.sh3dChanged).toBe(true);
      expect(doc3.home.walls.length).toBe(2);
    });
  });
};
