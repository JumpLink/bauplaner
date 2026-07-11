/**
 * three.js renderer for a {@link SceneModel} (Phase 5a: walls as oriented boxes,
 * room floors as slabs, a ground grid, orbit camera). Platform-agnostic — the
 * Adwaita view feeds it the `WebGLBridge` canvas; the same code would run in a
 * browser. Renders on demand (static scene) rather than a continuous rAF loop.
 *
 * three.js types expect a DOM `HTMLCanvasElement`; the GJS canvas from
 * `WebGLBridge.onReady` is structurally compatible but has no DOM lib in our
 * tsconfig, so it is cast at the boundary (same pattern as gjsify's three
 * showcases).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

import type { FurniturePart, ModelCatalog, SceneModel, TgaScene3D, TgaTrade, WallSolid } from '@bauplaner/core';

export interface BuildingView {
  /** Re-render the current frame. */
  render(): void;
  /** Resize the renderer + camera to the given drawable size. */
  resize(width: number, height: number): void;
  /**
   * Re-tint the walls in place (no geometry rebuild) — `colors` maps wall id →
   * 0xRRGGBB; ids absent from the map fall back to the default wall colour.
   */
  setWallColors(colors: Record<string, number>): void;
  /**
   * Show only the given level's walls/floors/furniture (null = show all).
   * Retrofit works (earthworks) are level-agnostic and stay visible.
   */
  setVisibleLevel(levelId: string | null): void;
  /** Release GL resources. */
  dispose(): void;
}

const COLOR_BG = 0x1b1b1b;
const COLOR_WALL = 0xd9c7a3; // warm clay tone (natural-materials theme)
const COLOR_FLOOR = 0x8a8f98;

/** Row-major 3×3 (Sweet Home 3D `modelRotation`) → a THREE rotation Matrix4. */
function rotationMatrix(m?: number[]): THREE.Matrix4 | null {
  if (!m || m.length !== 9) return null;
  // prettier-ignore
  return new THREE.Matrix4().set(
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
    0, 0, 0, 1,
  );
}

/**
 * Place a furniture OBJ like Sweet Home 3D: apply the model's base rotation,
 * normalise its bounding box to the piece's width/height/depth (mirroring along
 * width if asked), then position + yaw it in the world. Geometry is shared with
 * the template (cheap clone) — only object transforms differ per instance.
 */
function placeFurniture(template: THREE.Object3D, part: FurniturePart, material: THREE.Material): THREE.Object3D {
  const model = template.clone();
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material;
  });

  // Bake the model's base orientation, then measure the rotated bounds.
  const rot = rotationMatrix(part.modelRotation);
  const oriented = new THREE.Group();
  oriented.add(model);
  if (rot) oriented.quaternion.setFromRotationMatrix(rot);
  oriented.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(oriented);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  oriented.position.set(-center.x, -center.y, -center.z); // centre the rotated model at origin

  const piece = new THREE.Group();
  piece.add(oriented);
  const sx = size.x > 1e-6 ? part.width / size.x : 1;
  const sy = size.y > 1e-6 ? part.height / size.y : 1;
  const sz = size.z > 1e-6 ? part.depth / size.z : 1;
  piece.scale.set(part.mirrored ? -sx : sx, sy, sz);
  piece.position.set(part.center.x, part.center.y, part.center.z);
  piece.rotation.y = -part.angleRad;
  return piece;
}

/**
 * Build a vertical prism from a plan footprint (X–Z corners) extruded between
 * `yBottom` and `yTop`. The footprint winding is normalised to clockwise (seen
 * from above) so the generated side/cap faces get outward normals regardless of
 * the wall's direction. Hand-built rather than ExtrudeGeometry to keep the axis
 * mapping explicit (footprint is already in world X–Z, extrusion is +Y). Height
 * ranges let a wall be split into pillars / lintels / sills around openings.
 */
function wallPrism(footprint: { x: number; z: number }[], yBottom: number, yTop: number): THREE.BufferGeometry {
  // Shoelace signed area in X–Z; reverse to clockwise-from-above if needed.
  let area = 0;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % footprint.length];
    area += a.x * b.z - b.x * a.z;
  }
  const ring = area > 0 ? [...footprint].reverse() : footprint;
  const n = ring.length;

  const positions: number[] = [];
  for (const p of ring) positions.push(p.x, yBottom, p.z); // bottom ring 0..n-1
  for (const p of ring) positions.push(p.x, yTop, p.z); // top ring n..2n-1

  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    index.push(i, j, j + n, i, j + n, i + n); // side quad → outward for a CW ring
  }
  for (let i = 1; i < n - 1; i++) index.push(n, n + i, n + i + 1); // top cap (+Y)
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i); // bottom cap (−Y)

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** Linear interpolation of two X–Z footprint points. */
function lerpPt(a: { x: number; z: number }, b: { x: number; z: number }, t: number): { x: number; z: number } {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Geometries for one wall, split around its openings into pillars (full height
 * between/around openings), lintels (above an opening) and sills (below a
 * window). The mitered footprint corners survive because the t=0 / t=1 ends keep
 * the original corner points. A wall with no openings yields one prism.
 */
function wallGeometries(w: WallSolid): THREE.BufferGeometry[] {
  const fp = w.footprint;
  const yb = w.baseY;
  const yt = w.baseY + w.height;
  if (!w.openings || w.openings.length === 0 || fp.length !== 4) return [wallPrism(fp, yb, yt)];

  // Slice the footprint along the wall: left edge fp[0]→fp[1], right edge fp[3]→fp[2].
  const sub = (ta: number, tb: number): { x: number; z: number }[] => [
    lerpPt(fp[0], fp[1], ta),
    lerpPt(fp[0], fp[1], tb),
    lerpPt(fp[3], fp[2], tb),
    lerpPt(fp[3], fp[2], ta),
  ];
  const eps = 1e-3;
  const geoms: THREE.BufferGeometry[] = [];
  let cursor = 0;
  for (const op of w.openings) {
    const t0 = Math.min(1, Math.max(cursor, op.t0));
    const t1 = Math.min(1, Math.max(t0, op.t1));
    if (t0 - cursor > eps) geoms.push(wallPrism(sub(cursor, t0), yb, yt)); // pillar before
    if (t1 - t0 > eps) {
      const opTop = yb + op.top;
      const opBottom = yb + op.bottom;
      if (yt - opTop > eps) geoms.push(wallPrism(sub(t0, t1), opTop, yt)); // lintel above
      if (opBottom - yb > eps) geoms.push(wallPrism(sub(t0, t1), yb, opBottom)); // sill below
    }
    cursor = Math.max(cursor, t1);
  }
  if (1 - cursor > eps) geoms.push(wallPrism(sub(cursor, 1), yb, yt)); // pillar after
  return geoms;
}

/**
 * Build and start a three.js view of a building scene on the given canvas.
 *
 * @param canvasLike The `WebGLBridge.onReady` canvas (DOM-canvas-shaped).
 * @param scene The neutral scene model from `@bauplaner/core`.
 */
export function startBuildingView(
  canvasLike: unknown,
  scene: SceneModel,
  models?: ModelCatalog,
  onPick?: (wallId: string | null) => void,
  tga?: { scene: TgaScene3D; colors: Partial<Record<TgaTrade, number>> },
): BuildingView {
  // oxlint-disable-next-line typescript/no-explicit-any -- GJS canvas ≠ DOM HTMLCanvasElement (no DOM lib in tsconfig)
  const canvas = canvasLike as any;
  const width: number = canvas.width || 800;
  const height: number = canvas.height || 600;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height, false);
  renderer.setClearColor(COLOR_BG, 1);

  const threeScene = new THREE.Scene();

  const { center, sizeM } = scene.bounds;
  const camera = new THREE.PerspectiveCamera(50, width / Math.max(height, 1), 0.1, sizeM * 20 + 100);
  const dist = sizeM * 1.5 + 4;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center.x, center.y, center.z);

  // North vector on the ground plane (X–Z): plan "up" (−Z) rotated by the model's
  // compass angle. South = −north; the sun comes from the south + above so the
  // south-facing façades read brighter (orientation cue for passive-solar work).
  const nx = Math.sin(scene.northAngle);
  const nz = -Math.cos(scene.northAngle);

  threeScene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(-nx, 1.6, -nz); // from the south, high up
  threeScene.add(sun);

  const gridSize = Math.ceil(sizeM * 2 + 10);
  const grid = new THREE.GridHelper(gridSize, gridSize, 0x555555, 0x333333);
  grid.position.set(center.x, 0, center.z);
  threeScene.add(grid);

  // North arrow on the ground beside the building (red = north, map convention).
  const arrowLen = Math.max(2, sizeM * 0.3);
  const northArrow = new THREE.ArrowHelper(
    new THREE.Vector3(nx, 0, nz).normalize(),
    new THREE.Vector3(scene.bounds.min.x - 1.5, 0.05, scene.bounds.max.z + 1.5),
    arrowLen,
    0xff5555,
    arrowLen * 0.32,
    arrowLen * 0.2,
  );
  threeScene.add(northArrow);

  // One material per distinct colour (walls tinted by U-value share materials).
  const wallMaterials = new Map<number, THREE.MeshLambertMaterial>();
  const wallMaterialFor = (color: number): THREE.MeshLambertMaterial => {
    let material = wallMaterials.get(color);
    if (!material) {
      material = new THREE.MeshLambertMaterial({ color });
      wallMaterials.set(color, material);
    }
    return material;
  };
  // Geometries we create (walls, furniture fallbacks, templates) and must free.
  const ownedGeometries: THREE.BufferGeometry[] = [];
  // A wall becomes one or more segment meshes (pillars/lintels/sills around
  // openings). Keep them by id to re-tint in place, flat for raycasting, and
  // track every level-bearing object so a single storey can be isolated.
  const wallMeshes = new Map<string, THREE.Mesh[]>();
  const wallPickables: THREE.Mesh[] = [];
  const leveledObjects: { object: THREE.Object3D; level: string }[] = [];
  for (const w of scene.walls) {
    const material = wallMaterialFor(w.color ?? COLOR_WALL);
    const segments: THREE.Mesh[] = [];
    for (const geom of wallGeometries(w)) {
      ownedGeometries.push(geom);
      const mesh = new THREE.Mesh(geom, material);
      mesh.userData.wallId = w.id; // for click-to-pick raycasting
      segments.push(mesh);
      wallPickables.push(mesh);
      leveledObjects.push({ object: mesh, level: w.level });
      threeScene.add(mesh);
    }
    wallMeshes.set(w.id, segments);
  }

  const floorMaterial = new THREE.MeshLambertMaterial({ color: COLOR_FLOOR, side: THREE.DoubleSide });
  for (const f of scene.floors) {
    if (f.polygon.length < 3) continue;
    const shape = new THREE.Shape(f.polygon.map((p) => new THREE.Vector2(p.x, p.z)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2); // shape is in X–Y → lay flat into the X–Z plane
    const mesh = new THREE.Mesh(geometry, floorMaterial);
    mesh.position.y = f.elevationM + 0.01;
    leveledObjects.push({ object: mesh, level: f.level });
    threeScene.add(mesh);
  }

  // Retrofit works (Lehmgraben, pipes …) — our own geometry, coloured per kind.
  for (const p of scene.works) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(p.length, p.height, p.thickness),
      wallMaterialFor(p.color),
    );
    mesh.position.set(p.center.x, p.center.y, p.center.z);
    mesh.rotation.y = -p.angleRad;
    threeScene.add(mesh);
  }

  // TGA (Gewerke) network: nodes as small spheres, runs as thin cylinders, one
  // colour per trade; planned runs translucent, risers (Steigstränge across
  // storeys) thicker so they read clearly. Within-level items follow the level
  // isolation; risers stay visible across floors.
  const tgaMaterials = new Map<string, THREE.MeshLambertMaterial>();
  const tgaMaterialFor = (color: number, planned: boolean): THREE.MeshLambertMaterial => {
    const key = `${color}-${planned ? 'p' : 'b'}`;
    let material = tgaMaterials.get(key);
    if (!material) {
      material = new THREE.MeshLambertMaterial({ color, transparent: planned, opacity: planned ? 0.5 : 1 });
      tgaMaterials.set(key, material);
    }
    return material;
  };
  if (tga) {
    const DEFAULT_TGA_COLOR = 0x9e9e9e;
    const yAxis = new THREE.Vector3(0, 1, 0);
    // One shared sphere geometry for all node markers (positioned per mesh).
    const nodeGeom = new THREE.SphereGeometry(0.13, 12, 10);
    if (tga.scene.nodes.length > 0) ownedGeometries.push(nodeGeom);
    for (const n of tga.scene.nodes) {
      const mesh = new THREE.Mesh(nodeGeom, tgaMaterialFor(tga.colors[n.trade] ?? DEFAULT_TGA_COLOR, false));
      mesh.position.set(n.pos.x, n.pos.y, n.pos.z);
      threeScene.add(mesh);
      // Riser endpoints stay visible across storeys (with the riser); others follow isolation.
      if (!n.isRiserEndpoint) leveledObjects.push({ object: mesh, level: n.level });
    }
    for (const e of tga.scene.edges) {
      const dir = new THREE.Vector3(e.to.x - e.from.x, e.to.y - e.from.y, e.to.z - e.from.z);
      const len = dir.length();
      if (len < 1e-4) continue; // coincident endpoints (a riser seen from straight above)
      // Risers read as solid vertical strands even when planned (a Steigstrang is
      // a structural element, not a faint dashed hint) and are drawn thicker.
      const radius = e.isRiser ? 0.07 : 0.03;
      const planned = e.status === 'geplant' && !e.isRiser;
      const geom = new THREE.CylinderGeometry(radius, radius, len, e.isRiser ? 12 : 8);
      ownedGeometries.push(geom);
      const mesh = new THREE.Mesh(geom, tgaMaterialFor(tga.colors[e.trade] ?? DEFAULT_TGA_COLOR, planned));
      mesh.position.set((e.from.x + e.to.x) / 2, (e.from.y + e.to.y) / 2, (e.from.z + e.to.z) / 2);
      mesh.quaternion.setFromUnitVectors(yAxis, dir.clone().normalize());
      threeScene.add(mesh);
      // Risers span storeys → always visible; flat runs follow level isolation.
      if (!e.isRiser) leveledObjects.push({ object: mesh, level: e.level });
    }
  }

  // Furniture / doors / windows: real embedded OBJ geometry when the model
  // catalog has it, otherwise a placeholder box. Each distinct model is parsed
  // once (template) and cloned per instance; a flat material by kind (no MTL /
  // textures yet). DoubleSide so mirrored pieces + open meshes still read solid.
  const objLoader = new OBJLoader();
  const templates = new Map<string, THREE.Object3D | null>();
  const furnitureMaterials = new Map<number, THREE.MeshLambertMaterial>();
  const furnitureMaterialFor = (color: number): THREE.MeshLambertMaterial => {
    let material = furnitureMaterials.get(color);
    if (!material) {
      material = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
      furnitureMaterials.set(color, material);
    }
    return material;
  };
  const templateFor = (ref: string): THREE.Object3D | null => {
    const cached = templates.get(ref);
    if (cached !== undefined) return cached;
    let group: THREE.Object3D | null = null;
    const asset = models?.get(ref);
    if (asset) {
      try {
        group = objLoader.parse(asset.obj);
        group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry) ownedGeometries.push(mesh.geometry as THREE.BufferGeometry);
        });
      } catch {
        group = null; // malformed OBJ → box fallback
      }
    }
    templates.set(ref, group);
    return group;
  };

  for (const p of scene.furniture) {
    const template = p.model ? templateFor(p.model) : null;
    let object: THREE.Object3D;
    if (template) {
      object = placeFurniture(template, p, furnitureMaterialFor(p.color));
    } else {
      const box = new THREE.BoxGeometry(p.width, p.height, p.depth);
      ownedGeometries.push(box);
      const mesh = new THREE.Mesh(box, furnitureMaterialFor(p.color));
      mesh.position.set(p.center.x, p.center.y, p.center.z);
      mesh.rotation.y = -p.angleRad;
      object = mesh;
    }
    leveledObjects.push({ object, level: p.level });
    threeScene.add(object);
  }

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(center.x, center.y, center.z);
  controls.enableDamping = false;

  // Click-to-pick: share the canvas pointer channel with OrbitControls (which
  // uses press+drag to orbit) and treat only a press+release without drag as a
  // selection. Raycast the wall meshes and report the hit wall id (or null).
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0;
  let downY = 0;
  let dragged = false;
  const onPointerDown = (e: { clientX: number; clientY: number }): void => {
    downX = e.clientX;
    downY = e.clientY;
    dragged = false;
  };
  const onPointerMove = (e: { clientX: number; clientY: number }): void => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) dragged = true;
  };
  const onPointerUp = (e: { clientX: number; clientY: number }): void => {
    if (dragged || !onPick) return;
    const rect =
      typeof canvas.getBoundingClientRect === 'function'
        ? canvas.getBoundingClientRect()
        : { left: 0, top: 0, width, height };
    const rw = rect.width || width;
    const rh = rect.height || height;
    ndc.set(((e.clientX - rect.left) / rw) * 2 - 1, -(((e.clientY - rect.top) / rh) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(wallPickables, false);
    onPick(hits.length > 0 ? ((hits[0].object.userData.wallId as string) ?? null) : null);
  };
  if (onPick) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
  }

  // WebGLBridge.installGlobals() (called by the view before onReady) wires
  // globalThis.requestAnimationFrame to the GTK frame clock. A frame is
  // *scheduled* through it — the bridge then drives queue_render() and presents
  // the drawn framebuffer. Not typed by @types/node, so read it off globalThis.
  const raf = (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number })
    .requestAnimationFrame;
  const draw = () => renderer.render(threeScene, camera);

  const view: BuildingView = {
    render() {
      raf(draw);
    },
    resize(w: number, h: number) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      raf(draw);
    },
    setWallColors(colors: Record<string, number>) {
      for (const w of scene.walls) {
        const material = wallMaterialFor(colors[w.id] ?? COLOR_WALL);
        for (const mesh of wallMeshes.get(w.id) ?? []) mesh.material = material;
      }
      raf(draw);
    },
    setVisibleLevel(levelId: string | null) {
      for (const { object, level } of leveledObjects) {
        object.visible = levelId == null || level === levelId;
      }
      raf(draw);
    },
    dispose() {
      if (onPick) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
      }
      controls.dispose();
      for (const material of wallMaterials.values()) material.dispose();
      for (const material of furnitureMaterials.values()) material.dispose();
      for (const material of tgaMaterials.values()) material.dispose();
      for (const geometry of ownedGeometries) geometry.dispose();
      floorMaterial.dispose();
      // The scene helpers own GL buffers too; the view is rebuilt on every store
      // change, so these must be freed or they accumulate on the GPU.
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      northArrow.dispose();
      renderer.dispose();
    },
  };

  controls.update();
  controls.addEventListener('change', () => view.render());
  view.render();
  return view;
}
