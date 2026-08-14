# ADR 0001 — `.bauplan` becomes the authoritative format; Sweet Home 3D becomes import/export

- **Status:** accepted (2026-08-14, Pascal)
- **Deciders:** Pascal Garber
- **Context leading up to this:** the roof feature (#53) and the double-drawn-floor
  detection that came with it

## Context

Bauplaner started as a layer *on top of* Sweet Home 3D: the `.sh3d` is the
authoritative geometry, our sidecar (`.ecoretrofit.json`) / container
(`.bauplan`) adds what SH3D cannot hold. That boundary has been moving for a
while — TGA networks, cost register, documentation, wall annotations, Raumklima
and now the **roof declarations** all live in our layer. SH3D still owns walls,
rooms, levels, furniture placement, dimension lines and the compass.

What forced this decision into writing is the *cost* of SH3D's weak building
semantics. Half of the recent kernel code exists only to reverse-engineer
meaning out of the format:

- `clusterStoreys` exists because SH3D has **no storey concept** — one physical
  storey spans up to five "levels" in our models.
- `computeFloorAreas`' double-draw detection exists because floors are
  free-floating room polygons per level; the same floor *can* be drawn twice
  (our real model had the garage floor twice, ~28 m² of phantom house). In a
  native model a slab belongs to a storey and the defect class disappears **by
  construction**.
- `deriveRoofs` guesses eaves from bbox bands and wall-length filters because
  roofs do not exist in the format at all.
- Openings are snapped onto walls geometrically because SH3D windows carry **no
  wall reference**.

Each heuristic is good screening code — and each one is a tax we pay per
feature for keeping SH3D authoritative. At the same time, SH3D interop has
concrete, proven value: the energy consultant received our model *because* he
can open it in Sweet Home 3D, and the free furniture ecosystem (eTeks catalog +
contributions) is worth keeping.

The product vision (Pascal): SH3D-class modelling tools — draw walls, define
floors, define roofs — but with a contemporary, **mobile-adapted Adwaita UI**
following modern direct-manipulation editing patterns, not SH3D's dated
desktop interaction model.

## Decision

1. **`.bauplan` is the own format and the end state.** No new format is
   invented — the container (manifest + `geometry.json` + `project.json` +
   embedded `.sh3d`) already anticipated this: only the *authority* flips.
2. **Authority flips progressively, per document, never globally.**
   - Documents **imported** from `.sh3d` keep the embedded `.sh3d`
     authoritative (today's behaviour: lossless round-trip, diff-based
     geometry writeback).
   - Documents **created natively** need no embedded `.sh3d` at all —
     `geometry.json` is authoritative from the start.
   - An imported document flips ("upgrade") the moment it first uses a
     native-only entity that `.sh3d` cannot represent. The upgrade is
     **explicit and one-way**, announced in the UI — never a silent side
     effect of an edit. From then on `.sh3d` is an *export* of that document.
3. **Geometry schema v2 introduces real entities:** `Storey` (not level
   layers), `Wall`, `Slab` (floor), `Roof` (first-class, editable), `Opening`
   (parented to its wall), `FurnitureInstance` (model ref). Each entity
   retires a heuristic from the kernel for native documents; the heuristics
   move into the importer, where they translate SH3D's model — once, at the
   border — instead of running on every derivation.
4. **`.sh3d` import *and* export stay first-class forever.** Interop is a
   feature, not a transition state. Export from a native document is allowed
   to be lossy (a Roof flattens away, storeys re-split into levels) and says
   so.
5. **Furniture support is decoupled from the document format.** SH3D furniture
   arrives through a **catalog importer** (SH3D furniture libraries → our
   model catalog with OBJ + metadata; the 3D view already renders embedded
   OBJs). Licensing is checked per catalog before any redistribution — the
   SH3D ecosystem is largely CC-BY / Free Art License, which allows it with
   attribution, but that is verified, not assumed. Importing into a user's own
   project is always fine; *shipping* catalogs is what needs the check.

## Trigger

The flip is **not** justified by the roof feature alone — the sidecar absorbed
roofs without touching the format. Stage 2 (schema v2) starts with the first
*editing tool* whose result `.sh3d` cannot represent. Realistically that is
**roof editing** (polygon roofs, mixed pitches, dormers): the declarative
level-bbox roof config cannot carry it, and `Home.xml` has no place for it.

## Staged plan

- **Stage A (cheap, now):** allow native `.bauplan` documents without an
  embedded `.sh3d`; `geometry.json` authoritative for them. Imported documents
  unchanged.
- **Stage B:** geometry schema v2 (entities above) + importer that maps
  `.sh3d` → v2 using today's heuristics; exporter v2 → `.sh3d`.
- **Stage C:** editing tools on the native model, with mobile-first
  interaction patterns (direct manipulation, bottom sheets instead of dialogs,
  tap-to-place) on adaptive Adwaita — building on the existing
  CommandStore/undo, handle and gesture foundation.
- **Stage D:** SH3D catalog importer + per-catalog license audit.

## Consequences

- Positive: heuristics become border code; defect classes (double floors,
  orphan openings) die by construction; roofs/storeys become editable; the
  editor gets simpler because the model means what it says.
- Negative / accepted: two geometry code paths during the transition (imported
  vs. native documents); lossy export needs honest UI; the diff-serializer
  stays maintained as long as imported documents exist.
- The `sh3dChanged` drift detection and the lossless serializer remain load-
  bearing for imported documents — they are not legacy, they are the importer's
  contract.
