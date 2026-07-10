# Native GNOME app (GTK4 + libadwaita)

A desktop sibling to the CLI. Both reuse the same kernel (`@bauplaner/core`,
`@bauplaner/materials`, `@bauplaner/diagnose`) **in-process** — the app is
a thin Adwaita front-end, no HTTP.

See [`docs/app-ui/`](../../../docs/app-ui/README.md) for an annotated screenshot
tour of every view.

Status: **read-only**. Three views:

- **Übersicht** — open a Sweet Home 3D `.sh3d` file and show a summary (levels,
  rooms, wall stats, footprint) via the core parser + geometry.
- **Modell** — the building model in two projections of the SAME core scene
  (`buildScene`), switched by a *Grundriss / 3D* segmented control. Both share
  the wall **colouring mode** (*Neutral* / *U-Wert* green→red with the GEG limit /
  *Feuchte* teal), a *Geschoss* dropdown to isolate one storey, and the **click
  inspector** (geometry + U-value / GEG / Tauwasser + moisture diagnosis, with
  buttons jumping to **Bauteile** / **Feuchte** for that wall).
  - **Grundriss** (default) — a 2D floor plan drawn top-down with Cairo: rooms
    filled with name + area, mitered wall footprints, door/window openings, a
    grid, a **north** compass and a scale bar. A floating **Gewerke** card toggles
    the TGA (building-services) overlay per trade — heating / water / electric …
    drawn as a typed-node graph (sources & manifolds as squares, fixtures as dots;
    planned runs dashed) with each trade's total run length. A **Bearbeiten**
    toggle turns on Gewerke editing: **drag** a node to move it, **tap two** nodes
    of the same trade to connect a run, **tap + delete** to remove — all undoable
    (header Undo/Redo, Ctrl+Z/Y) via the core command store. Wall/room geometry
    stays read-only until the editable-geometry model lands. The concept's rule
    "edit in 2D, inspect in 3D" — so the plan is the primary surface.
  - **3D** — render the building in 3D (three.js on the WebGL→`Gtk.GLArea` bridge):
    walls as extruded footprints mitered at connected ends **with door/window
    openings cut out**, room floors, doors/windows/furniture as their **embedded
    OBJ meshes** (from the `.sh3d`; a box is the fallback), retrofit works, orbit
    camera. North from the model's compass; the sun lights the south façades.
    Needs a GL-capable desktop.
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
- `BP_APP_VIEW=<uebersicht|modell|fahrplan|bauteile|feuchte|kosten|material|raumklima|dokumentation>` —
  select the initial sidebar view.
- `BP_APP_ID=<app-id>` — override the application id. GNOME apps are
  single-instance per id, so a distinct id lets a *second* instance run beside
  one you already have open (used for devtools screenshots — see below).
- `BP_APP_MODELTAB=<grundriss|ansicht3d|3d>` — the Modell view's initial
  projection (default `grundriss`).
- `BP_APP_EDIT=1` — start the Grundriss in Gewerke edit mode.
- `BP_APP_EDITSEL=<node-id>` — pre-select that TGA node (shows the selection ring).
- `BP_APP_COLORMODE=<neutral|uwert|feuchte>` — the Modell view's initial wall
  colouring mode (default `uwert`).
- `BP_APP_PICKWALL=<wall-id>` — open the Modell click-inspector for that wall on
  startup (the same card a click produces).
- `BP_APP_LEVEL=<level name>` — isolate that storey in the Modell view on startup
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
# view ∈ uebersicht|modell|fahrplan|bauteile|feuchte|kosten|material|raumklima|dokumentation
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
