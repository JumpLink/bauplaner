# Native GNOME app (GTK4 + libadwaita)

A desktop sibling to the CLI. Both reuse the same kernel (`@bauplaner/core`,
`@bauplaner/materials`, `@bauplaner/diagnose`) **in-process** — the app is
a thin Adwaita front-end, no HTTP.

See [`docs/app-ui/`](../../../docs/app-ui/README.md) for an annotated screenshot
tour of every view.

Status: **read-only**. Three views:

- **Übersicht** — open a Sweet Home 3D `.sh3d` file and show a summary (levels,
  rooms, wall stats, footprint) via the core parser + geometry.
- **3D** — render the building in 3D (three.js on the WebGL→`Gtk.GLArea` bridge)
  from a core scene generator (`buildScene`): walls as extruded footprints
  mitered at connected ends **with door/window openings cut out** (pillars +
  lintel + sill, matched from the model's doors/windows), room floors,
  doors/windows/furniture as their
  **embedded OBJ meshes** (extracted from the `.sh3d`, scaled/placed like Sweet
  Home 3D; a box is the fallback when a model can't be resolved), retrofit works,
  orbit camera. A floating segmented control switches the wall **colouring
  mode** — *Neutral* (plain), *U-Wert* (green good → red bad, with a legend +
  the GEG limit), *Feuchte* (damp walls teal); switching re-tints in place.
  **Click a wall** to open an inspector card with its geometry, U-value / GEG /
  Tauwasser, and any moisture diagnosis (raycast pick; drag still orbits); the
  card's buttons jump to **Bauteile** / **Feuchte** with that wall focused. A
  *Geschoss* dropdown isolates a single storey (multi-storey models). A red
  ground arrow marks **north** (from the model's compass) and the sun lights the
  south façades (orientation for passive-solar work). Needs a GL-capable desktop. (Materials/textures from the models' `.mtl` are a
  next step — meshes currently use a flat material by kind.)
- **Bauteile** — assign a wall build-up (preset) to all walls; live
  U-value / Tauwasser / GEG; the 3D view colours walls by U-value.
- **Vorhaben** — our own earthworks (Lehmgraben, pipes) as project *works*,
  rendered in 3D; add/remove.
- **Feuchte** — rule-based damp-wall diagnosis per wall, stored as an annotation;
  damp walls are flagged (teal) in 3D.
- **Materialien** — the material stock (density, λ, µ).

Open either an bauplaner **project** (`*.ecoretrofit.json`, a sidecar that
references a `.sh3d` next to it) or a bare `.sh3d` (auto-wrapped in a project).
"Projekt speichern" writes the sidecar next to the `.sh3d` — Sweet Home 3D stays
the geometry editor; our project file adds the retrofit layer on top. A single
shared document backs all views (open once).

## Build & run

```bash
npm run build:app --workspace cli    # → cli/dist/bauplaner-app.gjs.mjs
npm run start:app --workspace cli    # needs a desktop / display
# or in one step:
npm run dev:app --workspace cli
```

Requires the gjsify toolchain (Node 24) and a working GTK4/libadwaita on the
system (GJS uses the real libraries via GObject-Introspection).

## Dev hook

- `BP_APP_FILE=/path/to/plan.sh3d` — auto-load that file on startup (into the
  shared document, so every view shows it; skips the file dialog).
- `BP_APP_VIEW=<uebersicht|ansicht3d|bauteile|vorhaben|kosten|feuchte|materialien>` —
  select the initial sidebar view.
- `BP_APP_ID=<app-id>` — override the application id. GNOME apps are
  single-instance per id, so a distinct id lets a *second* instance run beside
  one you already have open (used for devtools screenshots — see below).
- `BP_APP_COLORMODE=<neutral|uwert|feuchte>` — the 3D view's initial wall
  colouring mode (default `uwert`).
- `BP_APP_PICKWALL=<wall-id>` — open the 3D click-inspector for that wall on
  startup (the same card a click produces).
- `BP_APP_LEVEL=<level name>` — isolate that storey in the 3D view on startup
  (as if picked in the *Geschoss* dropdown).
- `BP_APP_EDITWALL=<bauteile|feuchte>:<wall-id>` — fire the inspector's edit-jump
  on startup (switch to that view with the wall focused).
- `GJSIFY_DEVTOOLS=1` — expose the `org.gjsify.Devtools` D-Bus control plane
  (inspect / screenshot / drive the app). Its `Screenshot` renders the window
  in-process via the GSK renderer (`@gjsify/devtools`, the same `captureWidgetPng`
  the PixelRPG map-editor uses) — no compositor portal, works headless.

## Screenshots (self-verify)

Capture any view without a human in the loop:

```bash
cli/dev/screenshot.sh uebersicht /tmp/uebersicht.png
# view ∈ uebersicht|ansicht3d|bauteile|vorhaben|kosten|feuchte|materialien
```

It launches a **second** instance under `BP_APP_ID=eu.jumplink.BauplanerShot`
(so it never hijacks a Bauplaner you have open), `GJSIFY_DEVTOOLS=1`, with the
bundled demo model `cli/demo/beispielhaus.sh3d` loaded — a sample house is
shipped precisely so the views have something to render — then pulls the PNG
over D-Bus via `cli/dev/dbus-shot.js` (gdbus alone can't save the `ay` bytes).
`gjsify debug` gives the same control plane an MCP bridge.

## Structure

- `main.ts` — entry (Adw.Application.run)
- `application.ts` — Adw.Application subclass (quit/about actions)
- `window.ts` — MainWindow: ViewStack + header ViewSwitcher
- `views/` — programmatic Adwaita views (no Blueprint yet)
- `constants.ts` — app id / name / version

The app id is `eu.jumplink.Bauplaner`; the product name is **Bauplaner**.
