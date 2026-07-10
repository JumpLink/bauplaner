# DERNOTON — sealing clay reference

Reference data for **DERNOTON®-Fertigmischung BA**, the mineral (clay) building
seal Bauplaner models in [`@bauplaner/materials`](../../packages/materials). It
is a diffusion-**closed** water barrier — an ecological alternative to bitumen or
plastic seals for earth-contact walls, used vertically and horizontally, inside
and outside. All figures below are the manufacturer's published product data
(see *Source*); confirm the specifics with DERNOTON for a real project.

## Key data (Technisches Datenblatt)

| Property | Value | Note |
|----------|-------|------|
| Installed density | **≈ 2.0 t/m³** | compacted, billed *nach Wiegekarte* (€/t) |
| Proctordichte ρPr | 1.705 t/m³ @ 97 % (dry) | DIN 18127 |
| Korndichte ρs | 2.68 t/m³ | DIN 18124 |
| Permeability kf | ≈ 1·10⁻¹⁰ m/s | DIN EN ISO 17892‑11 |
| Frost | **F1 — nicht frostempfindlich** | ZTV E‑StB |
| Waste/eco class | **LAGA Z0** (M20) — unrestricted | usable even in drinking-water zone I |
| Compactability | V1 (Bodenklasse SU) | very good |
| Einbauwassergehalt | **10–18 %** | wide band → nearly weather-independent install |
| λ (Wärmeleitfähigkeit) | 2.8 ± 0.3 W/(m·K) | dense mineral seal — **not** insulation |
| cp (Wärmekapazität) | 800 ± 40 J/(kg·K) | thermal mass |
| Durability | wurzelfest 15 yr, kein Schrumpfen/Reißen | self-heals small damage (Quelldruck 13.2 kN/m²) |
| Packaging | **Big Bag 1200 kg** or lose Schüttung | ~0.6 m³ per bag (loose) |

## Install method (vertical wall seal)

1. Excavate the working space; compact the subgrade to 97 % Proctordichte.
2. Set a **Trennstreifen** (wood/metal/plastic) **0.20–0.25 m from the wall** to
   keep the seal and the backfill from mixing.
3. Place DERNOTON in a **~0.20 m layer** between strip and wall (**0.20–0.25 m**
   on fissured walls / at ledges), backfill the rest with excavated soil.
4. Remove the strip; compact seal **and** backfill together, layer-wise, to
   **≥ 97 % Proctordichte** (~0.20 m lifts compact well).
5. Repeat in lifts up to grade; hand-pack pipe penetrations (add ~one **25 kg
   DERNOTON-Pulver** sack per penetration, mixed 1:1–1:2).
6. Add an **Oberflächenschutz** (~0.30 m of gravel / topsoil / slabs; add a
   geotextile fleece under gravel) so the seal is not eroded or damaged.

Coverage cross-check (Kalkulationshilfe): 1 t of installed DERNOTON seals
**~2.5 m² at 0.20 m** (smooth wall) or **~2.0 m² at 0.25 m** (fissured wall).

## Cost basis

The manufacturer's Kalkulationshilfe splits the cost the same way Bauplaner does:

- **Material + delivery** = one position. Billed per tonne (Wiegekarte) or per
  Big Bag; delivery (Sattelzug + Mitnahmestapler) is a flat surcharge.
- **Processing** = one position, done *together with* the backfill in the same
  lifts — so it adds only **~10–20 % on the backfill labour**, no separate
  significant cost. Transport / intermediate storage are site-specific extras.

## How Bauplaner uses this

- `materials.ts` — the `dernoton` stock entry (density 2.0 t/m³, λ, Big-Bag
  packaging, the classification notes above).
- `lehmgraben.ts` — `computeTrenchSeal()` turns trench geometry + load case into
  a tonnage; `DERNOTON_COVERAGE` holds the manufacturer coverage Richtwerte.
- `kosten.ts` — `computeOrderCost()` rounds the tonnage up to whole Big Bags,
  prices material + delivery, and adds VAT. Bring your own quote figures.
- CLI — `bauplaner lehmgraben --length … --seal-height … --price-per-bag …
  --delivery … [--price-per-t …] [--labour 0.15]` prints the quantity **and** a
  cost estimate.

## Source

DERNOTON® *"Bauwerksabdichtung mit DERNOTON-Fertigmischung BA — Informationen"*
(Heinrich Dernbach), <https://www.dernoton.de/> — Technisches Datenblatt,
Einbauhinweise and Kalkulationshilfe. Figures are manufacturer data / Gutachten
Richtwerte, not a substitute for a project-specific product sheet.
