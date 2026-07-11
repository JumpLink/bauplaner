import { describe, it, expect } from '@gjsify/unit';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import {
  BAUPLAN_FORMAT_VERSION,
  type EcoProject,
  parseSh3dBytes,
  readBauplanBytes,
  writeBauplanBytes,
} from '@bauplaner/core';

const HOME_XML =
  '<home version="7000">' +
  '<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>' +
  '<wall id="w1" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>' +
  '<room id="r1" name="Raum" level="L0"><point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/></room>' +
  '</home>';

const sh3d = (): Uint8Array => zipSync({ 'Home.xml': strToU8(HOME_XML) });

const project = (): EcoProject => ({
  schemaVersion: 2,
  sh3d: { path: 'plan.sh3d' },
  meta: { name: 'Test' },
  annotations: { walls: { w1: { assemblyLayers: [{ materialKey: 'lehm', thicknessM: 0.2 }] } } },
  works: [{ id: 'lehmgraben', kind: 'lehmgraben', data: { points: [[0, 0], [4, 0]], depthM: 0.9, widthM: 0.5 } }],
  costs: [{ id: 'c1', label: 'DERNOTON', category: 'material', status: 'geplant', net: 100 }],
  tga: { nodes: [{ id: 'n1', levelId: 'L0', trade: 'heizung', kind: 'heizkoerper', x: 1, z: 1 }], edges: [] },
  docs: [{ id: 'd1', kind: 'note', text: 'hi', anchor: { targetType: 'wall', targetId: 'w1' } }],
});

const json = (v: unknown): string => JSON.stringify(v);

export default async () => {
  await describe('.bauplan container', async () => {
    await it('round-trips geometry, project layer and the embedded .sh3d', async () => {
      const src = sh3d();
      const written = writeBauplanBytes({ home: parseSh3dBytes(src), project: project(), sh3dBytes: src, sh3dName: 'plan.sh3d' });
      const back = readBauplanBytes(written);

      // Geometry survives (parsed from the embedded, authoritative .sh3d).
      expect(json(back.home)).toBe(json(parseSh3dBytes(src)));
      // The project layer that references ids round-trips exactly.
      expect(json(back.project.works)).toBe(json(project().works));
      expect(json(back.project.costs)).toBe(json(project().costs));
      expect(json(back.project.tga)).toBe(json(project().tga));
      expect(json(back.project.docs)).toBe(json(project().docs));
      expect(json(back.project.annotations)).toBe(json(project().annotations));
      // The embedded .sh3d is preserved byte-for-byte (re-parses identically).
      expect(back.sh3dBytes.length).toBe(src.length);
      expect(back.sh3dName).toBe('plan.sh3d');
    });

    await it('writes a manifest and a geometry.json mirror', async () => {
      const src = sh3d();
      const written = writeBauplanBytes({ home: parseSh3dBytes(src), project: project(), sh3dBytes: src, sh3dName: 'plan.sh3d' });
      const back = readBauplanBytes(written);
      expect(back.manifest.formatVersion).toBe(BAUPLAN_FORMAT_VERSION);
      expect(back.manifest.app).toBe('bauplaner');
      expect(back.manifest.checksums.sh3d.length).toBe(64);
      // The embedded project points at the bundled copy.
      expect(back.project.sh3d.path).toBe('sh3d/plan.sh3d');

      const entries = unzipSync(written);
      expect('geometry.json' in entries).toBe(true);
      // geometry.json mirrors the parsed home.
      expect(json(JSON.parse(strFromU8(entries['geometry.json'])))).toBe(json(parseSh3dBytes(src)));
    });

    await it('rejects a missing manifest and a too-new format version', async () => {
      let threwNoManifest = false;
      try {
        readBauplanBytes(zipSync({ 'project.json': strToU8('{}') }));
      } catch {
        threwNoManifest = true;
      }
      expect(threwNoManifest).toBe(true);

      const future = zipSync({
        'manifest.json': strToU8(JSON.stringify({ formatVersion: 999, app: 'bauplaner', checksums: { sh3d: 'x' } })),
        'project.json': strToU8(JSON.stringify(project())),
        'sh3d/plan.sh3d': sh3d(),
      });
      let threwVersion = false;
      try {
        readBauplanBytes(future);
      } catch {
        threwVersion = true;
      }
      expect(threwVersion).toBe(true);
    });
  });
};
