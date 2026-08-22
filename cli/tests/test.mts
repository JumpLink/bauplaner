// Test entry: aggregates the *.test.ts suites (each a default-exported async fn)
// and runs them under @gjsify/unit. Built with `gjsify build tests/test.mts` for
// Node and GJS. Keep this list in sync when adding a test file.
import { run } from '@gjsify/unit';

import assemblySelection from './unit/assembly-selection.test.ts';
import roadmapPlan from './unit/roadmap-plan.test.ts';
import foerderungProfil from './unit/foerderung-profil.test.ts';
import haConfig from './unit/ha-config.test.ts';
import bauphysik from './unit/bauphysik.test.ts';
import lehmgraben from './unit/lehmgraben.test.ts';
import kosten from './unit/kosten.test.ts';
import sh3d from './unit/sh3d.test.ts';
import sh3dSerializer from './unit/sh3d-serializer.test.ts';
import openingPlacement from './unit/opening-placement.test.ts';
import geometryEdit from './unit/geometry-edit.test.ts';
import bauplan from './unit/bauplan.test.ts';
import nativeDocument from './unit/native-document.test.ts';
import demoLookup from './unit/demo-lookup.test.ts';
import projectCommands from './unit/project-commands.test.ts';
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
import heizung from './unit/heizung.test.ts';
import fahrplan from './unit/fahrplan.test.ts';
import tga from './unit/tga.test.ts';
import commands from './unit/commands.test.ts';
import numberInput from './unit/number-input.test.ts';
import doc from './unit/doc.test.ts';
import raumklima from './unit/raumklima.test.ts';
import works from './unit/works.test.ts';
import oekobilanz from './unit/oekobilanz.test.ts';
import varianten from './unit/varianten.test.ts';
import report from './unit/report.test.ts';
import grundriss from './unit/grundriss.test.ts';
import aufmass from './unit/aufmass.test.ts';
import budget from './unit/budget.test.ts';
import floorarea from './unit/floorarea.test.ts';
import roofs from './unit/roofs.test.ts';
import wohnflaeche from './unit/wohnflaeche.test.ts';

run({
  bauphysik,
  lehmgraben,
  kosten,
  sh3d,
  sh3dSerializer,
  geometryEdit,
  openingPlacement,
  bauplan,
  nativeDocument,
  demoLookup,
  projectCommands,
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
  heizung,
  fahrplan,
  tga,
  commands,
  numberInput,
  doc,
  raumklima,
  works,
  oekobilanz,
  varianten,
  report,
  grundriss,
  aufmass,
  budget,
  floorarea,
  roofs,
  wohnflaeche,
  assemblySelection,
  roadmapPlan,
  foerderungProfil,
  haConfig,
});
