# Bauplaner v3 — Technisches Konzept

Konzept für die Umsetzung des v3-Entwurfs (2D/3D-Modell, Gewerke-Ebenen, Sanierungsdaten) als
Open-Source-App mit **GJS + GTK4 + libadwaita** ([gjsify](https://github.com/gjsify/gjsify)),
aufbauend auf [JumpLink/bauplaner](https://github.com/JumpLink/bauplaner).
Orientierung: [Sweet Home 3D](https://www.sweethome3d.com) — neu gedacht für Desktop **und** Mobile.

---

## 1. Leitprinzipien

1. **Ein Geometrie-Kern, viele Sichten.** Wände, Räume, Öffnungen und Geschosse existieren genau
   einmal. Grundriss (2D), Isometrie/3D, Bauteil-Listen, Mengenermittlung und Analyse-Ebenen sind
   nur Projektionen desselben Modells — nie eigene Datenbestände.
2. **Alles referenziert Geometrie über stabile IDs.** Feuchte-Diagnosen, Dämm-Aufbauten,
   Leitungsnetze, Fotos, Messwerte und Fahrplan-Maßnahmen hängen per `wallId` / `roomId` /
   `edgeId` am Modell. Löschen/Ändern der Geometrie invalidiert Referenzen kontrolliert
   (Warnung, nie stiller Datenverlust).
3. **Bearbeiten in 2D, prüfen und annotieren in 3D.** Wie Sweet Home 3D: Geometrie wird im
   Grundriss gezeichnet (präzise, touch-tauglich). Die 3D-Ansicht dient Kontrolle, Analyse-Ebenen
   (U-Wert, Feuchte, Dämmung) und dem Verankern von Baudaten am Bauteil.
4. **Framework-unabhängiger Kern, dünne GJS-Schale.** Der Kern ist reines TypeScript/ESM ohne
   DOM- oder GTK-Abhängigkeit — headless testbar, im Browser-Prototyp und in GJS identisch.
5. **Offene Formate, Sweet-Home-3D-kompatibel.** Import/Export von `.sh3d`, eigene Daten als
   ergänzendes Nebenformat statt Fork des Originalformats.

## 2. Dateiformat: `.bauplan`

Ein `.bauplan`-Projekt ist ein **Zip-Container** (wie `.sh3d`, `.odt`):

```
beispielhaus.bauplan
├── manifest.json        Formatversion, App-Version, Checksummen
├── geometry.json        Geschosse, Wände, Räume, Öffnungen, Möbel   ← SH3D-Spiegel
├── tga.json             Gewerke-Netze: Heizung, Wasser, Strom, FBH
├── physics.json         Bauteil-Aufbauten, Schichten, Materialstamm
├── roadmap.json         Sanierungsfahrplan (Pakete, Maßnahmen, Kosten, opt. Förderung)
├── diagnostics.json     Feuchte-Diagnosen, Sensor-Bindungen (Home Assistant)
├── docs/                Fotos, PDFs, Messprotokolle
│   └── anchors.json     Anker: Dokument ↔ Bauteil/Raum/Leitung
└── sh3d/                optional: eingebettetes Original-.sh3d für Roundtrip
```

**Warum Nebenformat statt eigenem 3D-Format:** `geometry.json` ist ein 1:1-Spiegel des
SH3D-`Home.xml`-Datenmodells (Wände als Streckenzüge mit Dicke/Höhe, Räume als Polygone,
Öffnungen als Wand-Kinder). Import = XML → JSON-Mapping; Export zurück nach `Home.xml` verliert
nichts, was SH3D kennt. Alle Bauplaner-Erweiterungen leben in den **anderen** Dateien und
referenzieren nur IDs — ein `.bauplan` bleibt damit dauerhaft SH3D-interoperabel, und SH3D-Nutzer
können ihre Bestandsmodelle verlustfrei übernehmen.

### Kern-Entitäten (vereinfacht)

```ts
Wall     { id, levelId, start, end, thickness, height, assemblyId?, }
Room     { id, levelId, polygon: Point[], name, area }
Opening  { id, wallId, type: "door"|"window", offset, width, uw? }
Assembly { id, name, layers: [{ materialId, thickness }], computed: { u, glaser } }
TgaNode  { id, levelId, pos, z?, kind: "radiator"|"valve"|"socket"|"tap"|"manifold"|… }
TgaEdge  { id, trade: "heating"|"water"|"electric"|"fbh"|"vent",
           from: nodeId, to: nodeId, path: Point[], status: "existing"|"planned",
           dimension?, medium?, packageId? }
Measure  { id, packageId, title, cost, effect, diy: boolean,
           subsidy?: { program, rate, amount },   // optional — Fahrplan funktioniert ohne
           refs: [wallId|roomId|edgeId|assemblyId] }
DocEntry { id, kind: "photo"|"reading"|"note", file?, value?, date,
           anchor: { targetId, targetType } }
```

**Gewerke als Graph, nicht als Striche:** Leitungen sind Kanten zwischen typisierten Knoten.
Daraus folgen automatisch: Leitungslängen → Einkaufsliste, Kreisläufe → hydraulischer Abgleich,
Steigstränge → geschossübergreifende 3D-Darstellung, Kollisionprüfung gegen Wände/Dämmebenen.

### Abgeleitete Werte — nie gespeichert, immer gerechnet

Flächen, U-Werte, Glaser-Screening, Mengen (+ Verschnitt), Leitungslängen, Energiebedarf,
Kosten-Summen und Amortisation sind **Ableitungen** aus Geometrie + Aufbauten + TGA + Fahrplan.
Sie werden beim Laden/Ändern neu berechnet (memoisiert). So kann kein Zustand auseinanderlaufen —
ändert sich eine Wandlänge, folgen Einkaufsliste, Fahrplan-Kosten und 3D-Färbung von selbst.

## 3. Architektur

```
┌────────────────────────────────────────────────────────┐
│  UI (GJS + GTK4 + libadwaita)                          │
│  AdwNavigationSplitView · Breakpoints (Mobile/Desktop) │
│  2D: GtkDrawingArea/Snapshot   3D: GtkGLArea (gthree)  │
├────────────────────────────────────────────────────────┤
│  core/ (reines TypeScript, kein GTK, kein DOM)         │
│  model/      Entitäten + Validierung (JSON-Schema)     │
│  commands/   Undo/Redo (Command-Pattern) + Events      │
│  derive/     U-Wert, Glaser, Mengen, Kosten, Energie   │
│  io/         .bauplan-Zip, SH3D-Import/Export          │
│  scene/      Szenengraph 2D+3D aus dem Modell          │
└────────────────────────────────────────────────────────┘
```

- **Ein Store, Command-Pattern:** Jede Bearbeitung (Wand ziehen, Rohr verlegen, Status ändern)
  ist ein serialisierbares Command → Undo/Redo gratis, später kollaborationsfähig, und die
  GNOME-HIG-Regel „Undo statt Rückfrage“ ist technisch fundiert.
- **Events statt Polling:** Der Kern emittiert `model-changed(entityIds)`; 2D-Canvas, 3D-Szene
  und Listen-Views subscriben und aktualisieren nur Betroffenes.
- **3D-Rendering:** [gthree](https://github.com/alexlarsson/gthree) (three.js-Port als GObject)
  in `GtkGLArea`; Fallback für schwache Geräte: die Isometrie-Projektion aus dem v3-Entwurf via
  `GtkSnapshot` (rein 2D-gezeichnet, identischer Szenengraph). Analyse-Ebenen = Material-Swap
  pro Mesh (U-Wert-Farbe, Feuchte, Dämmung), Gewerke = Linien-Geometrie über den Geschossböden —
  exakt wie im Entwurf.
- **Mobile:** gleiche Widgets; unter dem Breakpoint wird die Werkzeugleiste zur horizontalen
  Leiste, der Inspektor zum Bottom-Sheet (`AdwBottomSheet`), Navigation zur Bottom-Bar — der
  v3-Entwurf zeigt alle drei Zustände.
- **Sensorik:** Home-Assistant-Anbindung bleibt ein Adapter außerhalb des Kerns; Messwerte werden
  als `DocEntry(kind: "reading")` mit Anker gespeichert.

## 4. Zusammenspiel der Daten (Beispielflüsse)

1. **Rohr zeichnen →** `AddTgaEdge`-Command → Länge fließt in Einkaufsliste (Material je Gewerk)
   und in die Kosten des verknüpften Pakets → 2D/3D zeigen die Kante sofort (gestrichelt =
   geplant).
2. **Dämm-Aufbau einer Wand zuweisen →** `assemblyId` an der Wand → `derive/` rechnet U-Wert +
   Glaser neu → Modell-Färbung, Bauteil-Liste, Energie-Skala und Fahrplan-Effekt aktualisieren
   sich aus derselben Quelle.
3. **Foto aufnehmen (Mobile) →** `DocEntry` mit Anker `wallId` → erscheint in der Doku-Liste
   und im Inspektor der Wand („+ Daten“ im Entwurf).
4. **Förderung deaktivieren →** reine View-Einstellung; `subsidy` bleibt optional am `Measure`.
   Der Fahrplan bleibt vollständig nutzbar (Orientierung für Selbstsanierer), Kosten/Amortisation
   rechnen ohne Zuschüsse. `diy: true` markiert Eigenleistungs-Maßnahmen, die für BEG/§35c
   ohnehin nicht nachweisfähig sind.

## 5. Migrationspfad ab JumpLink/bauplaner

1. `core/` als eigenes, buildbares Paket anlegen (esbuild → ein ESM-Bundle, das GJS lädt).
2. Datenmodell + `.bauplan`-IO mit JSON-Schema und Golden-File-Tests (headless, ohne GTK).
3. SH3D-Import (`Home.xml` lesen) vor dem Export implementieren — Import bringt sofort Nutzen.
4. 2D-Editor auf den Command-Store umstellen; danach 3D (gthree) als zweite Sicht auf den
   bestehenden Szenengraph.
5. TGA-Gewerke als erstes „Nur-bei-uns“-Feature — sie berühren SH3D-Kompatibilität nicht.
