# Projektziel & Vision — Natürlicher Bauplaner

> **Dokument-Version:** 1.0 · **Stand:** 2026-07-07 · **Sprache:** Deutsch
> **Status:** Vision festgelegt, Umsetzung Phase 0 (CLI-Grundgerüst auf gjsify/GJS)

## Zusammenfassung

`bauplaner` wird von einer reinen Dokumentensammlung zu einem
**eigenen, nativen GNOME-Werkzeug** ausgebaut: einem **Bauplaner für die
ökologische Altbau-Sanierung**. Das Ziel ist eine 3D-/2D-Architektur- und
Bauplanungs-Software mit ähnlichem Funktionsumfang wie
[Sweet Home 3D](https://www.sweethome3d.com/), aber **modern, dem
[GNOME HIG](https://developer.gnome.org/hig/) folgend** und mit einem klaren
inhaltlichen Fokus: **natürliche Baustoffe und diffusionsoffene Bauweise**.

Anders als generische CAD-Programme soll dieses Werkzeug nicht nur Räume und
Möbel zeichnen, sondern das **reale Sanierungsvorhaben abbilden und
durchrechnen** — inklusive Erdarbeiten wie dem Lehmgraben mit neuem
Abwasserrohr, Materialmengen (z. B. wie viel DERNOTON für die Grabenabdichtung
bestellt werden muss) und der **Diagnose feuchter Wände**.

Wie bei der Buchhaltung-CLI/-App entsteht die Anwendung **kern-zuerst**: die
gesamte Fachlogik lebt in einem plattformunabhängigen TypeScript-Kern, CLI und
native Adwaita-GUI sind dünne Adapter. Technisch bauen wir auf **gjsify + GJS**
(wie unsere anderen GNOME-Apps) statt auf dem bisherigen Deno-Skript.

## Motivation

- **Sweet Home 3D** ist ein hervorragendes Open-Source-Programm, aber in Java
  geschrieben, die Oberfläche wirkt veraltet und fügt sich nicht in den
  GNOME-Desktop ein. Der Funktionsumfang ist die Messlatte, nicht das Design.
- Bestehende Werkzeuge kennen **keine ökologischen Baustoffe** und keine
  **diffusionsoffene Bauphysik** — genau das ist hier der Kern.
- Planung, Materialrecherche, Mengenberechnung und Feuchte-Analyse liegen heute
  verstreut in Markdown-Dokumenten, PDFs, Tabellen und Chatverläufen. Ein
  Werkzeug soll das **an einem Modell** zusammenführen: zeichnen → berechnen →
  dokumentieren.
- Konkreter Auslöser: die Planung des **Lehmgrabens an der Hauswand** (Abdichtung
  mit DERNOTON, neues Abwasserrohr zur Wettern, Entwässerungspunkt). Solche
  Vorgänge sollen künftig **maßstäblich eingetragen und automatisch bemessen**
  werden.

## Leitprinzipien

1. **Natürliche Baustoffe zuerst** — Lehm, Kalk, Stroh, Holzfaser,
   Schaumglasschotter, Ton (DERNOTON) sind erste Klasse, nicht Sonderfall.
2. **Diffusionsoffen denken** — Bauphysik (µ/s_d-Werte, Tauwasser nach
   Glaser/DIN 4108-3) ist im Materialmodell und in den Berechnungen verankert;
   dampfdichte Aufbauten werden explizit als solche markiert und gewarnt.
3. **Kern-zuerst, dünne Adapter** — Fachlogik im gemeinsamen Kern; CLI, native
   GUI und ggf. Web sind austauschbare Oberflächen (Vorbild: unsere
   Buchhaltung-App, [Design-Core](https://github.com/dubstar-04/Design-Core)).
4. **GNOME-nativ** — GTK 4 / libadwaita, HIG-konform, wie unsere übrigen
   gjsify-Projekte.
5. **Nachvollziehbar & prüfbar** — jede Kennzahl nennt Quelle/Annahme; Rechnungen
   sind reproduzierbar (kein „Blackbox"-Ergebnis), Normbezug wo möglich
   (DIN 18533 Lastfälle, DIN 4095 Dränage, DIN 4108 Wärmeschutz, GEG).
6. **Open Source** — Werkzeug und Methode sind offen (Code MIT, Doku
   CC BY-SA 4.0), die **konkreten privaten Objektdaten bleiben privat**
   (siehe Datenschutz).

## Was die Anwendung können soll

Die Feature-Bereiche, priorisiert. Nicht alles auf einmal — siehe Roadmap.

### 1. Gebäudemodell (Bestand + Planung)
- 2D-Grundriss und 3D-Ansicht, **Ebenen/Layer** (Keller, Sockel, EG, OG,
  Umgebung/Außenanlage).
- **Bestand importieren** aus `.sh3d` (Sweet Home 3D) — ein beliebiges
  Sweet-Home-3D-Modell ist der Startpunkt (die konkreten Objektdaten bleiben privat).
- Wände, Räume, Öffnungen (Fenster/Türen), Bemaßung, Möblierung.
- Später: eigenes offenes Projektformat (versionierbar, git-freundlich).

### 2. Bauteil- & Schichtaufbauten
- Wand-, Boden-, Dachaufbauten als **Schichtpakete** (innen → außen), jede
  Schicht mit Material + Dicke.
- Kennwerte je Aufbau: **U-Wert**, Diffusionswiderstand, Tauwasserbilanz
  (Glaser), Wärmespeicherung.
- Warnung bei diffusionsdichten Sperren an der falschen Stelle (Feuchtefalle).

### 3. Erdarbeiten & Außenanlagen
- Graben, Rohrleitungen (Abwasser/Regen), Dränage, Sickergrube/Entwässerung,
  Vorfluter (Wettern), Gefälle, Rückstausicherung.
- **Lehmgraben-Abdichtung** als eigenes Bauteil: Länge × Höhe × Dichtungsdicke,
  Lastfall, Rohrdurchführung.
- Höhen-/Gefälleprofil entlang einer Leitung (der Garten fällt ab → Rohr zur
  Sickergrube).

### 4. Materialdatenbank (natürliche Baustoffe)
- Stammdaten je Material: Rohdichte, Wärmeleitfähigkeit λ,
  Dampfdiffusionswiderstand µ, kapillare Eigenschaften, Richtpreis, Bezugsquelle,
  Ökobilanz-Hinweis.
- Erststamm: **Lehm/Grubenlehm, DERNOTON, Kalk(putz), Kies, Sand, Stroh,
  Holzfaser, Schaumglasschotter**.

### 5. Berechnungen (der eigentliche Mehrwert)
- **Mengen/Volumen** für Produkte: DERNOTON-Grabenabdichtung, Kies-Verfüllung,
  Sandbettung, Dämmstoffvolumen, Putzmengen — inkl. Verschnitt- und
  Verdichtungszuschlag. *(Erstes umgesetztes Feature — siehe unten.)*
- **Bauphysik:** U-Wert je Aufbau, Tauwasser/Glaser (diffusionsoffen!),
  grobe Heizlast, Flächenheizungs-Auslegung.
- **Kosten** je Bauteil/Vorgang aus Material × Menge × Richtpreis.

### 6. Feuchte-Diagnose
- Geführte Ursachenanalyse einer feuchten Wand: aufsteigende Feuchte
  (Horizontalsperre) vs. seitlich eindringendes/aufstauendes Wasser
  (Vertikalabdichtung, Lastfall nach DIN 18533) vs. Kondensat (Bauphysik) vs.
  defekte Leitung.
- Checkliste + Verortung am Modell (welche Wand, welche Höhe, welcher Lastfall),
  Ableitung geeigneter **diffusionsoffener** Maßnahmen.

### 7. Dokumentation & Verknüpfung
- Vorgänge/„Fälle", Fotos, Messwerte am Modell verankert.
- Referenzen auf Paperless-ngx (Belege/Datenblätter) statt Rohdokumente im Repo.
- Anschluss an vorhandene Doku (iSFP, Bauplan-Notizen, Förderprogramme).

## Architektur

Kern-zuerst, plattformunabhängig — Oberflächen sind Adapter:

```
packages/core       @bauplaner/core       Geometrie, .sh3d-Import, Projektmodell
packages/materials  @bauplaner/materials  Materialstamm + Berechnungen (Mengen, U-Wert, Feuchte)
cli                 @bauplaner/cli         Adapter 1: Kommandozeile (yargs) — zuerst
  → später: native GNOME/Adwaita-App (GTK4, Cairo/GSK-Rendering) als Adapter 2
  → optional: Web-Ansicht (Canvas) als Adapter 3
```

- **Laufzeit:** gjsify + GJS (wie Buchhaltung-App und übrige gjsify-Projekte).
  Der TypeScript-Kern wird per `gjsify build` zu einem GJS-Bundle; dieselbe
  Logik läuft auch unter Node.
- **Rendering (später):** 2D über Cairo / GTK-Snapshot, 3D perspektivisch —
  Vorbild [Design-Core](https://github.com/dubstar-04/Design-Core), das genau
  diese Trennung (ein Kern, Cairo *und* Canvas als Backends) vormacht.
- **Datenmodell:** `.sh3d` als Import (ZIP + `Home.xml`, geparst mit
  `fflate` + `fast-xml-parser`), perspektivisch ein eigenes offenes Format.

## Referenzprojekte

- **[Sweet Home 3D](https://www.sweethome3d.com/)** — Funktions-Messlatte
  (Grundriss, 3D, Möblierung, Bemaßung, Plugins). Java, veraltete UI → wir
  wollen den Umfang, nicht das Design.
- **[dubstar-04/Design](https://github.com/dubstar-04/Design)** — native
  GNOME-CAD-App in GJS/GTK4, HIG-Vorbild.
- **[dubstar-04/Design-Core](https://github.com/dubstar-04/Design-Core)** —
  abhängigkeitsfreier 2D-CAD-Kern (Cairo + Canvas), DXF; Architektur-Vorbild für
  die Kern/Adapter-Trennung.
- **Unsere Buchhaltung-App** — Referenz für gjsify/GJS-Aufbau, Adwaita-Views und
  das Kern-zuerst-Prinzip.

## Roadmap (phasenweise)

- [x] **Phase 0 — Fundament:** Deno-Skript auf **gjsify/GJS** umgestellt;
  Monorepo (core + materials + cli); `.sh3d`-Parser portiert; **erstes
  Berechnungs-Feature: Lehmgraben-/DERNOTON-Mengen** (`lehmgraben`).
- [x] **Phase 1 — Materialstamm & Berechnungen:** Materialstamm mit λ/µ
  (natürliche, diffusionsoffene Baustoffe); **U-Wert + Glaser/Tauwasser-Screening**
  (DIN 4108-3) und **Kosten** als `bauteil`-Kommando; Tests via `@gjsify/unit`.
- [~] **Phase 2 — Native GUI-Grundgerüst:** Adwaita-Fenster mit ViewStack,
  `.sh3d` laden + Modell-Übersicht (Ebenen/Räume/Wände/Grundriss), Materiallisten
  (read-only). **Grundgerüst steht** (`cli/src/app`, `build:app`/`start:app`);
  weitere Views (Lehmgraben/Bauteil/Feuchte-Formulare) folgen.
- [ ] **Phase 3 — 2D-Editor:** Grundriss zeichnen/bearbeiten (Cairo), Wände,
  Räume, Bemaßung; Erdarbeiten (Graben/Leitungen).
- [~] **Phase 4 — Bauphysik am Modell:** **weitgehend da** — App-Views „Bauteile"
  (Wandaufbau je Preset, U-Wert/Tauwasser/GEG live, 3D-Farbcodierung nach U-Wert),
  „Vorhaben" (Lehmgraben/Rohre als eigene Geometrie in 3D) und „Feuchte"
  (Diagnose je Wand, als Annotation gespeichert, feuchte Wände in 3D markiert).
  Offen: per-Wand-Aufbau (statt bulk), echte Wand-Extrusion.
- [~] **Phase 5 — 3D-Ansicht & eigenes Projektformat.** 3D-Ansicht **begonnen**:
  three.js über gjsifys WebGL→`Gtk.GLArea`-Bridge, Szene (Wände als Boxen, Böden)
  aus einem Kern-Szenengenerator (`buildScene`). Offen: Öffnungen, eingebettete
  OBJ-Möbel, U-Wert/Feuchte-Farbcodierung am Modell, eigenes Projektformat.

## Offene Entscheidungen

- **Produkt-/App-Name: entschieden** — „Bauplaner" (App-ID `eu.jumplink.Bauplaner`,
  npm-Scope `@bauplaner/*`).
- **Projektformat: entschieden** — Sidecar-JSON (`*.ecoretrofit.json`), das die
  `.sh3d` daneben referenziert (v1 im Kern: `packages/core/project.ts`). Erst
  Sidecar, später ggf. Bundle oder eingebettete Geometrie (kein Lock-in, Schema
  bleibt).
- Umfang der **3D-Darstellung** (echte 3D-Engine vs. vereinfachte Perspektive).
- **Code-Lizenz: entschieden** — MIT (Code); die Doku bleibt CC BY-SA 4.0.

## Datenschutz

Werkzeug und Methodik sind offen; **konkrete Objektdaten sind privat**. Adresse,
Standort und personenbezogene Details des Hauses gehören nicht in öffentliche
Commits/Issues; Belege/Datenblätter werden über Paperless-ngx referenziert, nicht
als Rohdokumente eingecheckt.
```
