// Test entry: aggregates the *.test.ts suites (each a default-exported async fn)
// and runs them under @gjsify/unit. Built with `gjsify build tests/test.mts` for
// Node and GJS. Keep this list in sync when adding a test file.
import { run } from '@gjsify/unit';

import bauphysik from './unit/bauphysik.test.ts';
import lehmgraben from './unit/lehmgraben.test.ts';
import kosten from './unit/kosten.test.ts';
import sh3d from './unit/sh3d.test.ts';
import models from './unit/models.test.ts';
import feuchte from './unit/feuchte.test.ts';
import geometry from './unit/geometry.test.ts';
import geg from './unit/geg.test.ts';
import scene from './unit/scene.test.ts';
import wallColoring from './unit/wall-coloring.test.ts';
import wallInspector from './unit/wall-inspector.test.ts';
import documentStore from './unit/document-store.test.ts';
import project from './unit/project.test.ts';
import assemblies from './unit/assemblies.test.ts';
import energie from './unit/energie.test.ts';
import foerderung from './unit/foerderung.test.ts';
import works from './unit/works.test.ts';

run({
  bauphysik,
  lehmgraben,
  kosten,
  sh3d,
  models,
  feuchte,
  geometry,
  geg,
  scene,
  wallColoring,
  wallInspector,
  documentStore,
  project,
  assemblies,
  energie,
  foerderung,
  works,
});
