# AGENTS.md — Bauplaner

Operating rules for AI coding agents in **Bauplaner** — a native GNOME/Adwaita
planner for the ecological, diffusion-open retrofit of old buildings, built on
[gjsify](https://github.com/gjsify/gjsify) / GJS. Follows the
[agents.md](https://agents.md/) convention; human overview in
[README.md](README.md).

## Architecture — kernel-first

All domain logic lives in a runtime-agnostic TypeScript **core**; the CLI and the
native app are thin adapters that reuse it in-process (never a second copy).

- `packages/core` (`@bauplaner/core`) — building model, `.sh3d` import, project format
- `packages/materials` (`@bauplaner/materials`) — material stock, U-value/Glaser, DERNOTON/clay quantities, cost model
- `packages/diagnose` (`@bauplaner/diagnose`) — damp-wall diagnosis
- `cli` (`@bauplaner/cli`) — yargs CLI **and** the Adwaita app (`cli/src/app`)

Build a feature in the core, then expose it through the CLI **and** the app — no
per-surface duplication.

## Toolchain — gjsify, not npm

The whole loop is `gjsify` end-to-end. From the repo root:

```bash
gjsify install        # deps — NEVER `npm install` (it prunes the gjsify deps)
gjsify run dev:app    # build + launch the native app
gjsify run build      # CLI bundle
gjsify run check      # type-check (gjsify tsc)
gjsify run test       # test suite under gjs
```

Root scripts delegate into the `cli` workspace; `cd cli && gjsify run <script>`
works too. (`gjsify run -w cli <script>` does **not** chdir into the workspace
yet — a gjsify-core gap; the `cd cli` delegation sidesteps it.)

## Verify UI work with SCREENSHOTS — do not just build-check

**A GJS/Adwaita view is not verified until it has been screenshotted.** `gjsify
tsc` + a green build only prove it compiles — they do not show broken markup,
blank labels, bad layout, or wrong data. Every UI change ships a screenshot.

```bash
cli/dev/screenshot.sh <view> /tmp/out.png
#   view ∈ uebersicht|modell|fahrplan|bauteile|feuchte|kosten|material|raumklima|dokumentation
#   optional 3rd arg: a model/project to load (default: the bundled demo)
```

How it works (and why the pieces exist):

- **Self-contained capture** — `@gjsify/devtools`' `Screenshot` renders the window
  in-process via the GSK renderer (`captureWidgetPng`), no compositor portal,
  headless-capable. Same mechanism the PixelRPG map-editor uses; **nothing to fix
  in the gjsify core.**
- **Bundled demo model** (`cli/demo/beispielhaus.*`) — a generic sample house so
  the views have content to render. Ships on purpose (the app is otherwise
  data-less after open-sourcing).
- **Second instance** — GNOME apps are single-instance per app-id, so the script
  launches under `BP_APP_ID=eu.jumplink.BauplanerShot`; it never hijacks a
  Bauplaner you have open. `GJSIFY_DEVTOOLS=1` exports the control plane;
  `cli/dev/dbus-shot.js` unpacks the D-Bus `ay` PNG bytes (gdbus can't save them).
- **Sandbox note** — a long-running *foreground* GJS process is killed by the
  sandbox governor (Exit 144 / SIGSTKFLT). Launch via **run_in_background** and
  drive it over the devtools D-Bus rail; `pkill` may itself hit the governor but
  the instance still dies.

Dev hooks that make a view screenshot-ready: `BP_APP_FILE` (load a model),
`BP_APP_VIEW` (initial view), `BP_APP_TAB`/`BP_APP_COLORMODE`/`BP_APP_PICKWALL`/
`BP_APP_LEVEL`/`BP_APP_EDITWALL`. Full list: [`cli/src/app/README.md`](cli/src/app/README.md).

## Adwaita gotchas (learned from screenshots)

- **`Adw.ActionRow`/row titles are Pango markup** — a bare `&` (as in "Kosten &
  Kostenplan") aborts parsing and renders a **blank** label. Escape it
  (`&` → `&amp;`) or avoid markup chars in dynamic titles.
- `.card` has no internal padding — pad the inner box via child margins.
- Reuse the Adwaita named styles (`.card`, `.title-1..4`, `.dim-label`,
  `.numeric`) before writing custom CSS; the base theme already matches the
  Bauplaner v2 design.

## Design — implement the entwurf

The tracked design + concept live in [`docs/entwurf_v3/`](docs/entwurf_v3/)
(`Bauplaner v3.dc.html` + `docs/technisches-konzept-v3.md` + `docs/app-ui/*.png`).
**Before building a feature, check whether the entwurf covers it** and align to
it; the overarching goal is to **implement the entwurf fully** (2D/3D model,
Gewerke/TGA, Sanierungsdaten, `.bauplan`). Not yet done → keep the draft tracked.

Visual language is stock libadwaita (free); the work is per-view layout, nav and
the data behind it. **Iterative** — one coherent, screenshot-verified view per PR;
features needing a new core (Fahrplan, Förderung, Raumklima sensors) are staged
separately. (Note: `_ds/` of the export is gitignored — it leaks account data +
bloats the repo; the `.dc.html` + concept + screenshots are the tracked source.)

## Working rules

- **Conventional commits** (`feat`/`fix`/`docs`/`refactor`/`chore`/…), imperative,
  ≤50-char subject. Match the existing log style (`git log --oneline`).
- **PRs, merge when green.** Open a PR per increment; CI (`gjsify install --immutable`
  + tsc + build + gjs test bundle) gates it; merge (squash) once green **and** the
  screenshot looks right.
- **Tests** for core/logic changes (`@gjsify/unit`, `cli/tests/unit/*.spec.ts`);
  run `gjsify run test`. Fix all type/lint errors before committing.
- Bundled binaries (`cli/demo/*.sh3d`) are generic sample data only — never commit
  real object data (models, addresses, figures) into this public repo.
