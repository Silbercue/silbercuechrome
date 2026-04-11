---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
inputDocuments:
  - docs/vision/operator.md
  - docs/research/run-plan-forensics.md
  - docs/research/speculative-execution-and-parallelism.md
  - docs/research/form-recognition-libraries.md
  - docs/research/llm-tool-steering.md
  - docs/research/competitor-internals-stagehand-browser-use.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome-distillate.md
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md
  - docs/friction-fixes.md
  - docs/deferred-work.md
documentCounts:
  briefs: 2
  research: 5
  changeProposals: 1
  visionDocs: 1
  projectDocs: 2
  total: 11
classification:
  projectType: developer_tool
  domain: general
  complexity: medium
  projectContext: brownfield
  contextNote: "Kategorie-Wechsel vom Werkzeugkasten-Modell (25 Tools, run_plan-USP) zum Kartentisch-Modell (virtual_desk + operator mit Seed-Bibliothek und Fallback-Primitiven)"
workflowType: 'prd'
project: SilbercueChrome
author: Julian
date: 2026-04-11
---

# Product Requirements Document - SilbercueChrome

**Author:** Julian
**Date:** 2026-04-11

## Executive Summary

SilbercueChrome ist ein MCP-Server (Model Context Protocol), der KI-Agenten steuerbaren Zugriff auf einen Chrome-Browser gibt — also ein Werkzeug, mit dem ein Sprachmodell Webseiten lesen, Formulare ausfuellen, Links klicken und Workflows automatisieren kann, ohne dass ein Mensch dazwischen klickt. Das Produkt existiert seit 17 abgeschlossenen Entwicklungs-Epics als funktionierender Werkzeugkasten-MCP mit rund 25 Tools und fuehrt das Feld der Browser-Automation-MCPs im Benchmark knapp an.

Dieses PRD beschreibt einen bewussten **Kategorie-Wechsel**: Aus dem Werkzeugkasten wird ein Kartentisch. Statt dem LLM 25 Schubladen zu reichen, liest der Server die aktuelle Seite, erkennt wiederkehrende Muster (Login-Formular, Suchfeld, Produktliste, Cookie-Banner) und legt dem LLM fertige **Handlungskarten** vor — jede mit klarem Namen, kurzer Beschreibung und Parameter-Liste. Das LLM waehlt eine Karte aus und gibt die benoetigten Werte rein, statt bei jedem Schritt zu entscheiden, welches Werkzeug es wie kombinieren muss. Wenn keine passende Karte existiert, faellt das System auf einen Modus mit fuenf bis sechs Primitiv-Werkzeugen zurueck — nicht als Ausfall, sondern als Lernmoment fuer spaetere Karten-Aufnahme.

Das Problem, das dieses Paradigma loest, sitzt nicht an der Browser-Seite, sondern im Kopf des Sprachmodells. **Vier Fuenftel der Gesamt-Laufzeit eines typischen Benchmark-Laufs entfallen auf LLM-Denkzeit** — die Zeit, in der das Modell ueberlegt, welches Tool es als naechstes anfassen soll. Diese Ampel wird mit jeder neuen Modell-Generation groesser, nicht kleiner, weil die Modelle gruendlicher denken. Jede Optimierung, die nur am Browser ansetzt, adressiert bestenfalls die verbleibenden zwanzig Prozent. Der Kartentisch verlagert das Nachdenken aus der Laufzeit in die Karten-Autoren: Eine Entscheidung zwischen fuenf bis zehn semantischen Handlungen (*"Login, Suche, Checkout"*) geht belegbar schneller und robuster als zwischen fuenfundzwanzig mechanischen Werkzeugen (*"click, type, scroll, evaluate"*). Empirische Evidenz aus einem dokumentierten Vercel-Experiment: Reduktion des Tool-Sets von 25 auf 5 brachte dreieinhalbfachen Geschwindigkeitsgewinn bei gleichzeitig hundertprozentiger Erfolgsrate.

Die Zielgruppe teilt sich in zwei Lager, die bewusst getrennt gehalten werden. **Primaer** sind bestehende Nutzer, die das Produkt mit Kontext migrieren — SilbercueChrome- und SilbercueSwift-Community, Claude-Code- und Cursor-Nutzer mit Browser-Automation-Bedarf. Fuer sie ist der Wechsel ein Upgrade, sie brauchen Migrationspfad und Release-Narrative. **Sekundaer** sind Neulinge, die zum ersten Mal Browser-Automation durch ein LLM machen und fuer die zwei Top-Level-Tools mit fertigen Handlungen einfach der Normalzustand sind — sie brauchen keinen Migrationspfad, sondern einen sauberen Einstieg. Die Doku und das Marketing laufen fuer beide Gruppen konsequent zweigleisig.

### What Makes This Special

Der eigentliche Unterschied ist **nicht der einzelne technische Trick**. Der heutige `run_plan`-Vorsprung (mehrere Schritte in einem LLM-Aufruf buendeln) ist in zwei bis drei Wochen nachbaubar und stellt einen Rasiermesser-Vorsprung von 0,8 MQS-Punkten auf das naechststaerkste Feld dar — kein stabiler Graben. Der echte Unterschied ist das **Paradigma**: Fertige Handlungen statt atomarer Primitive, und unter ihnen ein Fallback-Modus, der jede unbekannte Situation gleichzeitig in eine Lernchance verwandelt.

Der **strategische Graben**, der daraus entsteht, ist kein technischer — Technik laesst sich kopieren — sondern ein **kultureller**. In Phase 2 der Produktentwicklung wird aus der lokalen Karten-Datei eine offene, crowd-gepflegte Bibliothek: die Referenz-Bibliothek des offenen Action-Pattern-Webs. Die Analogien sind Schema.org fuer Markup, OpenStreetMap fuer Karten, Wikidata fuer Entitaeten. Wer frueh anfaengt und konsistent durchhaelt, bekommt einen Graben, der sich mit Geld nicht ueberbruecken laesst, weil Vertrauen und Teilhabe Zeit brauchen. Eine geschlossene Firma kann diese Position strukturell nicht einnehmen — niemand vertraut einem einzelnen Akteur so wie einem oeffentlichen Commons.

Der Leitsatz, aus dem sich alle weiteren Entscheidungen ableiten, heisst **"Teilhabe statt Produkt"**. Der Nutzer ist nicht Konsument einer Leistung, sondern stiller Mit-Entdecker. Jede Nutzung — auch die kostenlose — macht das System fuer alle besser. Das ist nicht Marketing, sondern eine technische Konsequenz: Jeder Fallback-Moment wird anonym zu einem strukturellen Muster-Kandidaten. Ab einer Schwelle unabhaengiger Quellen (mindestens fuenf) wird daraus eine offizielle Karte im Stapel. So lernt das System mit jeder Nutzung — nicht durch ein Training, sondern durch kollektive Beobachtung.

## Project Classification

- **Projekt-Typ:** Developer-Tool (MCP-Server fuer LLM-gesteuerte Browser-Automation ueber direktes Chrome DevTools Protocol)
- **Domain:** General — technisch fordernd, regulatorisch entspannt (keine Compliance-Pflichten wie HIPAA, FDA, ISO 26262)
- **Komplexitaet:** Medium — regulatorisch einfach, aber technisch tief: CDP-Internals, Chromium-Feldtypen, Cross-Origin-iFrames, Crowd-Konsens-Logik, Multi-Tier-Lizenzmodell, drei gekoppelte Entwicklungs-Phasen
- **Projekt-Kontext:** Brownfield mit Kategorie-Wechsel — 17 Epics als historische Basis bleiben unveraendert, der naechste Release-Zyklus (Epic 18-21) definiert das Produkt konzeptionell neu, Free/Pro-Schnitt wird neu verhandelt

## Success Criteria

### User Success

Der zentrale Aha-Moment fuer den Bestandsnutzer ist der erste Durchlauf einer Aufgabe, die frueher drei bis fuenf Tool-Aufrufe gebraucht haette und jetzt als einzige Karten-Auswahl ablaeuft — ohne dass er sich vorher durch eine Migrations-Anleitung quaelen musste. Wenn dieser Moment entsteht, haben wir das Paradigma verstaendlich gemacht. Fuer den Neuling ist der Erfolgsmoment stiller: er macht zum ersten Mal Browser-Automation durch ein LLM und merkt gar nicht, dass es frueher anders war, weil Operator einfach die einzige Art ist, die er kennt. Beide Erfahrungen sollen gleichwertig sein, nur auf unterschiedlichen Wegen erreicht.

Konkret messbar:

- **Aufgaben-Laufzeit:** Eine repraesentative Benchmark-Aufgabe (z.B. *"Login bei einem E-Commerce-Shop, zwei Produkte in den Warenkorb, zum Checkout"*) laeuft im Operator-Modus mindestens **fuenfzig Prozent schneller** als im bisherigen `run_plan`-Modus der v0.5.0-Baseline. Gemessen in Wall-Clock-Sekunden, nicht in MQS-Punkten.
- **Aha-Moment-Indikator:** In einem blinden Nutzer-Test mit fuenf SilbercueChrome-Bestandsnutzern beschreibt mindestens die Haelfte den Unterschied in eigenen Worten als *"schneller weil ich weniger Schritte planen muss"* oder sinngemaess. Qualitativ, aber mit klarer Entscheidung.
- **Migrations-Reibung:** Ein Nutzer, der von v0.5.0 auf Operator Phase 1 updated, kann seine bisherigen Haupt-Use-Cases **ohne einen einzigen Blick in die Doku** weiterfuehren — der Fallback-Modus fangt ihn auf, falls eine Karte fehlt. Das ist die Probe, ob der Paradigma-Wechsel sanft ist.

### Business Success

Das Geschaeftsmodell steht auf zwei Beinen, die nicht dieselbe Zeitachse haben. Das **kurzfristige Bein** ist der MQS-Benchmark-Score: Heute fuehren wir mit 60,3 Punkten knapp vor Google (59,5). Nach Epic 18 (Forensik-Fixes) erwarten wir einen Zwischen-Lift auf 63–65 Punkte, nach Epic 19 (Operator Phase 1) einen Kategorie-Wechsel auf 70 und aufwaerts — nicht durch bessere Tool-Latenzen, sondern durch eingesparte LLM-Denkzeit im Benchmark-Lauf. Der Rasiermesser-Vorsprung wird zum stabilen Abstand. Dieses Bein ist harte Zahl und sechs-Monats-Gate.

Das **langfristige Bein** ist der Commons-Graben: die Anzahl externer Beitraeger zum Kartenstapel, die Anzahl unabhaengiger Harvester-Quellen (Ziel Phase 2: mindestens fuenf unabhaengige Quellen pro offiziell promoteter Karte), und die Erwaehnung des Leitsatzes *"Teilhabe statt Produkt"* in Open-Source-Community-Kontexten. Dieses Bein ist weicher und 12–24-Monats-Messpunkt.

Konkret nach sechs Monaten ab Phase-1-Release:

- **MQS-Score:** mindestens 70 Punkte, mindestens fuenf Punkte Abstand zum naechststaerksten Konkurrenten
- **Pro-Subscriptions:** 30 zahlende Abos (der Free-Teil treibt Adoption, Pro-Erloese sind sekundaer)
- **GitHub Stars:** 1000 auf Basis der Commons-Positionierung
- **npm Downloads:** 2500 pro Monat
- **Eigennutzung:** Julian nutzt Operator taeglich und greift zum Fallback nur bei bewusst unbekannten Seiten zurueck, nicht aus Unsicherheit

Konkret nach 12–24 Monaten (nach Phase-2-Launch):

- **Kartenstapel-Wachstum:** mindestens 60 offiziell promotete Karten (Start: 20–30 Seed + 30 durch Crowd-Konsens)
- **Unabhaengige Harvester-Quellen:** mindestens 100 aktive Klienten, die Muster-Kandidaten einreichen
- **Community-Erwaehnungen:** Der Leitsatz *"Teilhabe statt Produkt"* ist in mindestens drei substantiellen externen Artikeln referenziert (HN-Diskussion, Dev.to, Fachblog)

### Technical Success

Die technischen Erfolgskriterien sind die belastbarsten, weil im Benchmark messbar. Sie zerfallen in zwei Bloecke, die sich ueber die Phasen gegenseitig ausbalancieren.

**Block 1 — Was der Kartentisch muss (Epic 19, Phase 1 MVP-Muss):**

- Genau **zwei Top-Level-Tools** im Standard-Modus: `virtual_desk` und `operator`. Alle bisherigen Tools sind im Fallback-Modus verfuegbar, aber nicht im Standard-Tool-Kontext des LLM.
- **20–30 validierte Seed-Karten**, die die haeufigsten Benchmark-Muster abdecken: Login, Registrierung, Suche, Cookie-Banner, Formular-Absenden, Modal schliessen, Navigation, Produktliste, Checkout, Pagination, Filter, Sortierung, Newsletter-Anmeldung, Sprachumschaltung, In-Warenkorb-Legen, Tab-Wechsel. Jede Karte gegen Benchmark-Seite **und** mindestens drei echte Produktionsseiten getestet.
- **Fallback-Modus funktional:** Aktiviert automatisch bei fehlender Karte, bietet fuenf bis sechs Primitiv-Tools (click, type, read, wait, screenshot, evaluate) an, durchlaufbar ohne Fehlermeldung.
- **Benchmark-Pass-Rate im Operator-Modus** mindestens gleich der run_plan-Baseline (Ziel: 35/35 Tests oder besser).
- **Tool-Definition-Overhead** unter 3000 Tokens (zum Vergleich: Playwright 13700, Chrome DevTools 17000). Strenger als das alte Brief-Ziel, direkte Konsequenz der Zwei-Tools-Architektur.

**Block 2 — Was die Container-Erkennung liefern muss:**

- **Erkennungs-Rate** auf dem Benchmark-Parcours: mindestens 85 Prozent der Tests erkennen mindestens ein passendes Muster (die restlichen 15 Prozent fallen sauber auf den Fallback).
- **Falscherkennungen:** unter fuenf Prozent (ein als Login-Formular erkanntes Muster muss tatsaechlich ein Passwortfeld enthalten, sonst wird es verworfen).
- **Container-Aggregations-Schicht** ist im Code explizit benannt und testbar, weil sie der eigentliche Neuland-Teil ist und in keiner Open-Source-Loesung als wiederverwendbarer Baustein existiert.

### Measurable Outcomes

Ein kompaktes Gate-System, damit wir nach jedem Epic klar wissen, ob wir weiterziehen oder nachfeilen:

- **Epic 18 Gate:** Benchmark-MQS >= 63 Punkte. Wenn nicht erreicht, weitere Forensik-Fixes, bevor Epic 19 startet.
- **Epic 19 Gate:** Benchmark-Pass-Rate >= v0.5.0-Baseline **und** Gesamt-Laufzeit mindestens 50 Prozent kuerzer. Wenn nicht erreicht, Seed-Bibliothek erweitern oder Fallback-Modus nachschaerfen.
- **Phase-1-Release Gate:** Alle funktionalen Anforderungen aus dem PRD erfuellt, Dokumentation zweigleisig (Migration-Track + Getting-Started-Track), Julian nutzt das System taeglich produktiv.
- **Sechs-Monate-Post-Release Gate:** MQS >= 70 Punkte, 30 zahlende Pro-Abos, mindestens drei oeffentliche Community-Erwaehnungen der Kartentisch-Idee.

## Product Scope

### MVP - Minimum Viable Product

Der MVP ist **Operator Phase 1**, umgesetzt in Epic 18 (Vorbereitung) und Epic 19 (Kartentisch + Seed + Fallback).

**Epic 18 — Vorbereitungsarbeiten.** Ambient-Context-Hook im `run_plan` unterdruecken (Haupt-Hebel laut Forensik: spart auf click-lastigen Plaenen **100–1350 ms pro Click-Step** — Herleitung: die `waitForAXChange`-Wait-Konstanten 350/500/1350 ms in `src/hooks/default-on-tool-result.ts` — plus etwa **2850 Chars pro Plan** durch entfallende Ambient-Context-Snapshots; der zeitliche Hebel skaliert mit der Anzahl der Click-/Type-Steps), Step-Response-Aggregation verschmaelern, Tool-Verschlankung von 25 auf ein Transition-Set von acht bis zehn Tools, Paint-Order-Filtering fuer verdeckte Elemente, Speculative Prefetch waehrend LLM-Denkzeit, laufende Friction-Fixes FR-028 aufwaerts. Ziel: MQS +3–4 Punkte als Absicherung vor dem Kategorie-Wechsel.

**Epic 19 — Kartentisch, Seed-Bibliothek, Fallback.** Die zwei Top-Level-Tools aufsetzen, das Kartenstapel-Datenmodell definieren (versionierte JSON- oder TOML-Struktur mit Erkennungs-Signalen, Parameter-Schema, Ausfuehrungs-Sequenz), die Container-Aggregations-Schicht auf Basis der Chromium-Feldtypen (118 Typen, BSD-lizenziert) und des Mozilla-Fathom-Rulesets (96,6 Prozent Login-Form-Accuracy, MIT-lizenziert) aufbauen, 20–30 Seed-Karten handgepflegt erstellen und gegen Benchmark plus echte Seiten testen, Fallback-Modus mit fuenf bis sechs Primitiv-Tools, Operator-Konversations-Loop robust gegen Zwischenschritte (Navigation, Page-Load, Tab-Wechsel), Benchmark-Validation gegen run_plan-Baseline, Dokumentation zweigleisig.

**Lokal, nicht cloud-basiert.** Der Kartenstapel ist eine versionierte Datei im Projekt, keine Netzwerk-Anbindung. Kein Harvester-Upload, kein Cloud-Sync, keine externen Abhaengigkeiten zur Laufzeit.

**Free/Pro-Neuschnitt.** Der Kartentisch-Mechanismus mitsamt Seed-Bibliothek und Fallback-Modus ist **frei und Open Source** (Commons-Ebene). Der Pro-Layer bleibt fuer parallele Plan-Ausfuehrung (existiert als `executeParallel` in Epic 7.6/16), erweiterte Observability, prioritaeren Karten-Update-Kanal (wird in Phase 2 wichtig), Enterprise-Deployment-Tools und Support/SLA. Der Schnitt ist ehrlich: bezahlt wird fuer Komfort, Geschwindigkeit und Integration — nicht fuer Exklusivitaet oder Daten.

### Growth Features (Post-MVP)

Die Wachstums-Features liegen in **Epic 20 — Operator Phase 2 (Harvester + Cloud-Sammelstelle)**. Bewusst geparkt, bis Epic 19 genug Fallback-Beobachtungen produziert, um den Harvester sinnvoll zu fuettern.

**Inhalte:** Harvester-Instrumentierung im Klienten (jede Fallback-Sequenz wird zu einem anonymen strukturellen Muster-Kandidaten — Form der Seite, nicht Inhalt), Cloud-Sammelstelle als eigenstaendiger Dienst mit oeffentlicher API und regelmaessigen Datensatz-Dumps, Crowd-Konsens-Logik mit Schwelle von fuenf unabhaengigen Quellen (einstellbar), Update-Mechanismus im Klienten, Rueckruf-Mechanismus fuer fehlerhafte Karten, oeffentliche Transparenz-Schicht mit Wartebereich und Historie.

**Gate fuer Epic-20-Start:** Kein Kalender-Datum, sondern ein inhaltliches Kriterium — Epic 19 laeuft seit mindestens zwei Wochen produktiv, und die lokalen Fallback-Beobachtungen zeigen wiederkehrende Muster, die sich zu lernen lohnen.

### Vision (Future)

Die Vollendung der Vision liegt in **Epic 21 — Commons-Community und Neu-Launch** und folgt, wenn Phase 2 stabil laeuft.

**Inhalte:** Governance-Dokumente fuer den Commons (Julian bleibt Solo-Maintainer zum Start, Governance-Strukturen entstehen spaeter bei Bedarf), Transparenz-Seite im Web, neues Marketing-Narrativ *"Teilhabe statt Produkt"* als komplettes Neuschreiben des Marketing-Plans, Namens-Entscheidung (Operator-Kollision mit OpenAI klaeren), Cross-Promotion ueber SilbercueSwift-Community und externe Launch-Kanaele, Pro-Layer-Repositionierung mit neuem Messaging.

**Explizit nicht in v1 (Phase-1-MVP):**

- Keine Cloud-Sammelstelle, kein Harvester, kein Crowd-Lernen — Epic 20
- Kein automatisches Karten-Lernen
- Kein Browser-Support ausser Chrome (kein Firefox, WebKit, Safari)
- Keine Chrome-Extension-basierte Variante
- Keine CI/CD-Integration als erstklassiges Feature
- Keine Multi-Agent-Coordination
- Keine Enterprise-Features (Team-Lizenzen, SLAs) — evtl. Epic 21 oder spaeter
- Keine AI-Framework-Integrationen (LangChain, CrewAI) — v2 oder spaeter

## User Journeys

**Vorbemerkung zum Lesen.** Karten sind strukturelle Muster-Klassen, nicht seiten-spezifische Skripte. Eine Login-Formular-Karte greift ueberall, wo die DOM-Struktur passt — Shopware, Gmail, WordPress, jedes handgebaute Admin-Panel. Die konkreten Shop-Namen in den Journeys sind nur Beispiele dafuer, *wo* Operator eine Struktur-Klasse beobachtet hat, nicht dafuer, *wofuer* eine Karte gemacht ist. Wer diesen Punkt verliert, rutscht ins alte Werkzeugkasten-Denken ab.

### Journey 1 — Marek, der Bestandsnutzer vom Werkzeugkasten

**Migrations-Happy-Path.** Marek ist Senior-Backend-Entwickler in Prag, 34, und laesst seit acht Monaten Claude Code jede Nacht seine E2E-Test-Suite gegen ein SaaS-Produkt fahren. Er kennt `run_plan` auswendig und sein Gists-File mit handgepflegten Plan-Templates ist zweihundert Zeilen lang. Jeden zweiten Montag patcht er einen Plan, weil der Shop oder das Backend seines Kunden umgebaut wurde. Das fuehlt sich normal an, bis er es nicht mehr muss.

Dezembermorgen, Suite ist still gescheitert. Kein Crash, nur ein leerer Screenshot und ein Timeout-Log. Er patcht wieder, flucht wieder, sieht beim Kaffee die Release-Notes zu v0.6.0, macht `npm update`, startet Claude Code neu, tippt die gleiche Aufgabe wie gestern: *"fahr die Login-Suite gegen shopware-backend.kunde.de, logge ein mit Test-Account A, zieh den Nightly-Report."*

Was jetzt mechanisch passiert, ist der entscheidende Kontrast. Claude ruft `operator` mit der Ziel-URL auf. Operator navigiert, laedt die Seite in den Cache, rechnet lokal die Struktur durch: Form-Element mit zwei Inputs (einer vom Typ Passwort), Submit-Button, kein zweites Sicherheits-Feld im Body. Das ist die Signatur der Struktur-Klasse *"Login-Formular"*. Operator legt die **Login-Formular-Karte** auf den virtuellen Tisch.

Wichtig: Es ist **keine Karte fuer Shopware-Backend**. Operator hat die Karte nicht fuer Mareks Kunden gebaut, Marek hat auch nichts fuer seinen Kunden angepasst. Dieselbe Karte sitzt seit dem v0.6.0-Release unveraendert in der Seed-Bibliothek und wirkt auf Gmail, WordPress, Jira, Stripe-Dashboard, Notion-Login, jedem handgebauten Admin-Panel — ueberall, wo Operator diese strukturelle Signatur sieht. Die Struktur hat gematcht, die Karte hat gegriffen. Wie ein Generalschluessel, der in alle Schloesser mit demselben Mechanismus passt.

Die Karte kommt mit Parameter-Slots `username` und `password` an Claude zurueck. Claude fuellt sie mit Mareks Test-Account-Daten und waehlt die Karte. Operator fuehrt mechanisch aus: tippen, tippen, Submit. Der Klick bedeutet Seitenwechsel, aber das ist Teil der Karten-Ausfuehrung — Operator laedt die Dashboard-Seite im selben Rutsch, scannt, erkennt die naechste Struktur-Klasse (Dashboard-Uebersicht mit Seitennavigation), legt die dazugehoerigen Karten auf den Tisch. Zwischen Login-Auswahl und Dashboard-Lieferung: keine LLM-Zwischenrunde.

Claude waehlt eine Navigations-Karte — die genauso strukturell und seiten-unabhaengig ist wie die Login-Karte, sie greift bei jeder Seiten-Struktur mit einer erkennbaren Hauptnavigation — fuellt den Zielpfad. Operator fuehrt aus, scannt die neue Seite, legt eine Tabellen-Export-Karte auf den Tisch. Claude waehlt, Parameter *"Format: JSON"*. Report landet in Mareks Ordner.

Der Aha-Moment ist nicht einfach die Geschwindigkeit. Der Aha-Moment ist, dass Mareks Gists-File ein Symptom des Werkzeugkasten-Zwangs war. Er hatte seiten-spezifische Skripte gebaut, weil das alte Paradigma ihn gezwungen hat, die mechanische Planung selbst zu leisten. Jedes Skript war eine handgestrickte Kombination aus `click`- und `type`-Calls fuer genau ein Formular auf genau einer Kundenseite. Mit Operator gibt es keine seiten-spezifischen Skripte mehr, weil die Muster seiten-unabhaengig sind. Das Gists-File ist nicht nur ueberfluessig — es war nie das Richtige. Es war die Notloesung in einem Paradigma, das jetzt nicht mehr gilt.

### Journey 2 — Annika, die Einsteigerin ohne Alt-Last

**First-Contact-Happy-Path.** Annika ist UX-Designerin in Hamburg, 28, freiberuflich. Sie hat am Freitagabend von einer Kollegin gehoert, dass Claude jetzt Browser bedienen kann, und am Sonntagabend sitzt sie mit zwei Broetchen und einem Terminal vor dem Laptop. Montag soll sie den Landing-Page- und Preistabellen-Vergleich von drei Wettbewerbern auf dem Tisch haben. Frueher ein langer Nachmittag mit einem Praktikanten. Drei Zeilen Config kopieren, Claude Code neu starten, und Annika tippt: *"geh auf diese drei URLs, mach mir je drei Screenshots — Landing, Produktseite, Pricing — und leg sie in einen Ordner 'wettbewerbs-sweep'."*

Claude ruft `operator` mit URL 1 auf. Operator navigiert, scannt, erkennt die Struktur-Klasse *"Webseitenlayout mit Hero-Bereich, Sektions-Folge und Footer"*. Legt die **Ganzseiten-Screenshot-Karte** auf den Tisch. Claude waehlt, Operator fuehrt aus, Screenshot landet im Ordner. Operator navigiert gleich zur Produktseiten-URL, scannt, erkennt wieder die gleiche Struktur-Klasse — und **die gleiche Karte** kommt auf den Tisch. Neunmal, quer ueber drei voellig verschiedene Wettbewerber-Seiten.

Das ist der Kern des Ganzen. Die Screenshot-Karte ist nicht fuer Annikas drei Wettbewerber gemacht. Sie ist fuer die Struktur-Klasse *"Seite mit erkennbaren Sektionen"* gemacht. Dieselbe Karte wirkt auf einer Wikipedia-Seite, auf einem Gerichts-Portal, auf einem Blog-Artikel, auf irgendeinem Medium-Post, auf einer selbstgemachten Landingpage. Ueberall, wo Operator dieselbe Struktur-Signatur sieht. Annika sieht davon nichts — sie sieht nur den Fortschrittsbalken und danach neun Screenshots im Ordner. Aber der Mechanismus darunter ist komplett seiten-unabhaengig, und genau deshalb funktioniert er verlaesslich fuer ihre drei fremden Shops, die niemand vorher in einer Karten-Definition bedacht hat.

Waehrend des Laufs hat Annika halb mit einem Abbruch gerechnet — irgendwas funktioniert doch immer nicht beim ersten Versuch, ein Cookie-Banner, ein Captcha, irgendwas. Als Chrome sauber durchgeklickt hat ohne zu stolpern, hat sie einen Moment gewartet, ob noch eine Fehlermeldung kommt. Kam keine. Dreizehn Minuten spaeter ist der Sweep fertig. Annika oeffnet den Ordner: die Preise auf zwei Seiten sind als Bild eingebunden, nicht als HTML-Text. Sie tippt nach: *"auf Shop 2 und 3 sind die Preise als Bild dargestellt — kannst du mir die Tarife rauslesen?"*

Claude ruft `operator` auf der Pricing-URL von Shop 2 auf. Operator scannt, findet diesmal eine andere Struktur-Klasse: ein Bild-Element im Haupt-Inhaltsbereich, tabellaresk in Seitenverhaeltnis und Position, ohne umgebenden HTML-Text. Das ist die Signatur der Klasse *"informatives Bild mit tabellenartiger Form"*. Operator legt die **Bild-Inhalt-Lesen-Karte** auf den Tisch — ihre interne Handlung: einen engen Ausschnitt-Screenshot des identifizierten Bildes machen, ihn ans LLM zur Interpretation uebergeben, die strukturierten Daten zurueckliefern. Claude waehlt, Operator fuehrt aus, liest die Tarife. Gleicher Ablauf auf Shop 3.

Auch hier: die Bild-Inhalt-Lesen-Karte ist nicht fuer Shop 2 und 3 gemacht. Sie ist fuer jede Seite, auf der ein informatives Bild in tabellenartiger Form steht — Preistabellen-Bilder, Infografiken in Unternehmens-Dashboards, Screenshots in Dokumentationen, Fahrplaene in Verkehrs-Apps, Speisekarten in Restaurant-Webseiten. Eine Karte fuer eine strukturelle Klasse, nicht fuer konkrete Seiten. Die Seed-Bibliothek kennt die Klasse schon, und weil Operator strukturell scannt, greift die Karte auf Annikas fremden Shops genauso wie sie auf allen anderen Seiten greift, die dieselbe Struktur zeigen.

Annikas neues Mentalmodell ist denkbar einfach: *"Claude kann Browser bedienen, das System drunter wird mit der Zeit klueger."* Dass es Karten gibt, weiss sie nicht. Dass die strukturell sind, weiss sie nicht. Aber genau weil sie es sind, funktioniert es bei ihr.

### Journey 3 — Jamal, der Fallback-Moment und die spaetere Commons-Teilhabe

**Edge-Case und Vision-Bruecke.** Jamal betreibt eine kleine Web-Agentur in Muenchen, 41, drei Mitarbeiter. Laesst Operator seit drei Monaten taeglich Kunden-Workflows fahren — einer davon ist ein Checkout-Dauertest fuer einen mittelgrossen E-Commerce-Shop. Der Lauf ist bisher sauber durchgegangen, weil die **Zwei-Schritt-Formular-mit-Weiter-Button-Karte** aus der Seed-Bibliothek gegriffen hat. Diese Karte ist nicht fuer Jamals Shop gebaut. Sie greift auf der Struktur-Klasse *"zweischrittiges Formular mit Weiter-Button"* — was auf tausenden Seiten weltweit vorkommt: Checkouts, Hotelbuchungen, Event-Ticketing, Kontoregistrierungen, Newsletter-Einrichtungen. Hunderte andere Operator-Klienten nutzen genau dieselbe Karte taeglich, ohne Koordinierung, ohne gegenseitiges Wissen.

Am Montagmorgen hat der Shop umgebaut. Neue Struktur: drei Formular-Schritte, mit einer bedingten Einfach-Weiterklick-Variante in Schritt zwei, wenn der Kunde bereits eingeloggt ist. Operator scannt und rechnet die Struktur durch, aber kein bestehendes Muster erreicht die Schwelle. Die alte Zwei-Schritt-Karte liegt bei 0,42 statt der erforderlichen 0,65. **Operator nimmt alle Karten vom Tisch** und legt stattdessen die fuenf Primitive hin: click, type, read, wait, screenshot. Das Return enthaelt das explizite Framing: *"Kein strukturelles Muster erreicht Schwelle, Fallback-Modus aktiv, manuelle Ausfuehrung, Muster-Signatur wird registriert."*

Claude versteht das Framing und arbeitet primitiv durch. Mehr Roundtrips, aber sauber. Rechnung raus, Auftrag im System.

Waehrend des Fallback-Laufs passiert etwas Stilles und Entscheidendes. Operator beobachtet jeden Primitiv-Schritt und rekonstruiert eine **strukturelle Muster-Signatur** — nicht eine Shop-Signatur, nicht eine Domain-Signatur, nicht eine URL-Signatur. Was registriert wird, ist: *"dreischrittiges Formular, wobei der zweite Schritt bedingt uebersprungen wird, wenn ein Login-State-Marker im Header existiert."* Das ist die Beschreibung **einer Struktur-Klasse**, nicht die Beschreibung eines bestimmten Unternehmens. Sie ist formal so formuliert, dass sie auf jeder anderen Seite anwendbar ist, auf der dieselbe Verschachtelung vorkommt — auf einem Hotel-Buchungsflow in Japan genauso wie auf einer Event-Ticket-Plattform in Brasilien.

In Phase 1 reicht Jamal die Signatur als Pull Request in das oeffentliche Seed-Repository ein. Julian reviewt sie, testet gegen zwei, drei weitere Seiten mit derselben strukturellen Verschachtelung (bewusst ausserhalb von Jamals Kunden-Stack, um zu verifizieren dass die Karte wirklich auf der Struktur-Klasse wirkt und nicht auf Besonderheiten dieses einen Shops), merged sie. Die Karte ist in der Seed-Bibliothek. Von da an greift sie automatisch bei jedem Shop, Buchungs-System, Registrierungs-Workflow weltweit, wo derselbe strukturelle Dreischritt vorkommt. Jamals einzelne Beobachtung ist zu Infrastruktur fuer eine ganze Klasse geworden.

Der Phase-2-Ausblick haelt dasselbe Prinzip einen Schritt weiter offen. Mit aktivem Harvester wird die Signatur anonym an eine Cloud-Sammelstelle uebertragen. Vier andere Operator-Klienten stossen im naechsten Monat auf dieselbe strukturelle Verschachtelung — nicht auf Jamals Shop, sondern auf anderen Seiten mit derselben Klasse — und ihr Harvester meldet dieselbe Signatur. Fuenf unabhaengige Quellen, Schwelle erreicht. Auf der oeffentlichen Transparenz-Seite erscheint ein Karten-Vorschlag: *"Dreischrittiges-Formular-mit-bedingtem-Zweit-Schritt, fuenf unabhaengige Quellen, Entwurfsstatus."* Jamal scrollt vorbei, erkennt sich als *"Source 3 of 5"*, versteht den Leitsatz *"Teilhabe statt Produkt"* intuitiv — und sieht, dass die Karte ueberall wirken wird, wo diese Struktur vorkommt.

Diese Journey verankert zwei harte Anforderungen im MVP. Erstens, die Muster-Signatur muss strukturell formuliert sein, nicht shop-bezogen, nicht domain-bezogen. Sonst skaliert die Commons-Logik nicht: eine Million Seiten geteilt durch ein paar hundert Struktur-Klassen funktioniert, eine Million Seiten geteilt durch eine Million seiten-spezifischer Karten funktioniert nie. Zweitens, das Signatur-Format muss schon heute so aussehen, dass es in Phase 2 ohne Struktur-Bruch vom Harvester aufgenommen werden kann.

### Journey 4 — Lena, der gefaehrlichste Fehler und die Audit-Spur

**Support und Troubleshooting.** Lena ist Product Managerin in Berlin, 32, und hat ein wiederkehrendes Reporting-Skript, das jeden Freitag ein SaaS-Dashboard ausliest und einen PDF-Report generiert. Operator laeuft es seit sechs Wochen stabil. An einem Freitag: Report kommt an, Zahlen alle Null. Login scheint geklappt zu haben, aber das Dashboard zeigt *"Sie sind nicht eingeloggt"*. Das ist die gefaehrlichste Fehlerklasse — nicht eine fehlende Karte, sondern die falsche Karte.

Was ist passiert? Das Dashboard hatte ein neues Sicherheits-Element eingebaut, ein zweites Passwort-Feld fuer 2FA-Rescue, das strukturell wie ein regulaeres Login-Formular aussieht. Die **Login-Formular-Karte** aus der Seed-Bibliothek — dieselbe Karte, die bei Marek auf Shopware-Backend greift, die auf hunderten anderer Seiten weltweit korrekt wirkt, gerade **weil sie seiten-unabhaengig ist** — hat angeschlagen, weil ihre strukturellen Haupt-Signale erfuellt waren: Form-Element, zwei Input-Felder, Passwort-Typ, Submit-Button mit *"Login"*-Text. Score 0,68, knapp ueber Schwelle.

Was die Karte in ihrer Definition als Gegen-Signal dokumentiert hatte — *"greift nicht, wenn irgendwo im Document-Body ein weiterer Passwort-Input vom Typ 'rescue' oder 'backup' existiert"* — wurde nicht zuverlaessig geprueft, weil der Check nur den Viewport-Bereich erfasste und das zweite Feld im unsichtbaren Scroll-Bereich lag.

Lena oeffnet den Operator-Log und findet das Feld `why_this_card`. Es listet jedes Signal mit seinem Gewicht — Form-Element 0,15, zwei Inputs 0,12, Password-Typ 0,18, Submit-Text *"Login"* 0,13, Summe 0,68 — und den Gegen-Signal-Check, der leer blieb, weil nur der Viewport gescannt wurde. Das ist keine Anekdote, sondern eine saubere Audit-Spur. Sie schreibt zwei Absaetze, haengt URL und Log-Auszug an, eskaliert.

Julian sieht die Signatur und versteht sofort. Sein Hotfix schaerft **die Erkennungs-Regel der Login-Formular-Karte auf Struktur-Klassen-Ebene** — nicht mit einer Ausnahme fuer Lenas konkretes Dashboard, sondern mit einer generellen Verbesserung der Signatur-Logik: *"Gegen-Signal-Check erstreckt sich auf den gesamten Document-Body, nicht nur auf den Viewport."* Veroeffentlicht in v0.6.1.

Ab sofort wirkt diese Verbesserung auf **jede Seite weltweit, die strukturell aehnlich gebaut ist**, nicht nur auf Lenas Dashboard. Jeder andere Nutzer, der dieselbe Fehlerklasse (*"Login-Karte greift faelschlich, weil 2FA-Rescue-Feld ausserhalb des Viewports liegt"*) gehabt haette oder in Zukunft haben koennte, ist mit einer einzigen Julian-Intervention geschuetzt. Ein einzelner Bug-Report wird zu einer Infrastruktur-Verbesserung. Bei seiten-spezifischen Skripten (Mareks alte Gists-Welt) haette derselbe Fix nur Lenas Skript geholfen — alle anderen Nutzer derselben Fehlerklasse haetten den Fehler einzeln entdecken, einzeln diagnostizieren, einzeln patchen muessen. Mit strukturellen Karten ist jede Pruefung eine Investition in die ganze Nutzer-Menge.

Hier wird ein Punkt konkret, der fuer die Seed-Bibliotheks-Arbeit zentral ist: manche Struktur-Klassen lassen sich nicht leicht voneinander unterscheiden. *"Login-Formular"* und *"2FA-Rescue-Formular"* sehen strukturell fast identisch aus — beide sind Form-Elemente mit Passwort-Feldern und Submit-Buttons. Der Unterschied liegt im Kontext (ist die Seite bereits hinter einem Login?) und in sekundaeren Elementen (gibt es ein zweites Passwort-Feld anderswo?). Das ist die harte, empirische Seite der Seed-Bibliotheks-Arbeit: Klassen sauber auseinanderzuhalten ist an manchen Stellen einfach, an anderen knifflig, und Lena-artige Bugs werden bei jeder neu hinzugefuegten Klasse einmal auftreten. Das ist kein Design-Fehler, das ist die Natur der Sache. Was der Mechanismus bietet, ist nicht Fehlerfreiheit — sondern saubere Analysierbarkeit und einen Multiplikator-Effekt bei jeder Korrektur. Und das `why_this_card`-Feld ist die Garantie, dass das funktioniert.

### Randnote — Die LLM-Perspektive

Das LLM ist der eigentliche Benutzer der Tool-Liste, und aus seiner Innenperspektive sind vier Dinge wichtig.

Erstens, die Tool-Anzahl im Standard-Modus ist zwei — `virtual_desk` und `operator`. Nicht fuenfundzwanzig. Der Auswahl-Aufwand im LLM-Kopf schrumpft radikal, und die Karten, die es zur Auswahl hat, kommen vom Server pro Seite geliefert, nicht aus einem Katalog, den das LLM durchsuchen muesste.

Zweitens, die Karten sind strukturell, nicht seiten-spezifisch. Das LLM sieht nie eine hypothetische *"Tausend-Karten-Bibliothek"*, in der es sich orientieren muesste. Es sieht immer nur fuenf bis fuenfzehn Karten, die Operator **fuer die aktuelle Seite** auf den Tisch gelegt hat. Die Karten-Beschreibungen sind semantisch formuliert — *"Login-Formular ausfuellen und absenden"*, *"Bild-Inhalt zur Interpretation uebergeben"* — nicht prozedural. Das LLM erkennt semantische Handlungen schneller als mechanische Element-Listen. Und weil die Karten strukturelle Klassen abbilden, bleibt die Zahl klein und die Auswahl schnell — egal wie viele Seiten die Welt hat.

Drittens, der Loop ist asymmetrisch. Das LLM denkt nur an zwei Punkten: bei der Karten-Auswahl und beim Parameter-Fuellen. Die komplette Ausfuehrung samt Folge-Seite-Scan samt neuer-Karten-Lieferung passiert serverseitig, ohne LLM-Zwischenaufruf. Aus Sicht des LLM sind zwei, fuenf, zehn mechanische Aktionen gleich viel Denkaufwand wie eine — weil es nur die semantische Entscheidung trifft.

Viertens, der Fallback-Modus ist kein Fehlerzustand, sondern ein alternativer Tool-Kontext mit explizitem Framing. Das `operator`-Return muss beim Wechsel in Fallback einen Satz wie *"Kein strukturelles Muster erreicht Schwelle — fuenf Primitive verfuegbar, manuelle Ausfuehrung erwuenscht, Muster-Signatur wird registriert"* liefern. Ohne dieses Framing faellt das LLM in Defensiv-Schleifen. Mit dem Framing versteht es den Fallback als *"ich arbeite manuell, weil gelernt werden soll"*, nicht als *"ich bin gescheitert"*.

### Randnote — Der Maintainer

Der Maintainer taucht in den Journeys nur als Gegenstelle auf: derjenige, der Jamals Pull Request merged, derjenige, der Lenas Bug-Report in einen Hotfix verwandelt, derjenige, der die Seed-Bibliothek handpflegt. In Phase 1 ist das Julian allein. Drei Anforderungen leiten sich daraus ab. Erstens, die Karten-Datenstruktur muss von Hand pflegbar sein — Textformat, in Git versionierbar, mit menschenlesbaren Erkennungs-Signalen und Hinweiszeilen. Zweitens, **weil die Karten strukturelle Klassen abbilden, bleibt die Zahl der pflegebeduerftigen Karten klein** — hoechstens ein paar hundert, nicht Millionen — was Solo-Pflege in Phase 1 ueberhaupt erst machbar macht. Waere die Architektur seiten-spezifisch, waere der Maintainer von Tag eins ueberfordert. Drittens, der Pull-Request-Pfad muss so dokumentiert sein, dass Nutzer wie Jamal ohne Ruecksprache beitragen koennen.

### Journey Requirements Summary

Die gesamte Operator-Architektur steht und faellt mit einer Idee: **Karten gehoeren zur Struktur, nicht zur Seite.** Die folgenden fuenf Bloecke sind die user-seitige Uebersetzung dieser einen These.

**Block A — Karten-Tisch als strukturbasierter Mechanismus.** Zwei Top-Level-Tools `virtual_desk` und `operator`. Karten sind **strukturelle Muster-Klassen**, beschrieben durch DOM-Verschachtelungs-Signale, Parameter-Schema und Handlungsanweisung. Sie sind per Definition **seiten-unabhaengig** — eine Karte wirkt ueberall, wo die Struktur passt, ohne Kenntnis von URL, Domain oder Betreiber. Der Ausfuehrungs-Loop ist serverseitig fliessend: Seite laden → strukturell scannen → Karten auf Tisch legen → an LLM melden → LLM waehlt und fuellt Karte → Operator fuehrt mechanisch aus, inklusive Scan der Folge-Seite und Lieferung der neuen Karten im selben Durchlauf. Zwischen Karten-Auswahl und Neuer-Karten-Lieferung keine LLM-Zwischenaufrufe. Die Karten-Zahl im Tool-Kontext ist konstant klein (zwei Tools plus jeweils die wenigen aktuell auf dem Tisch liegenden Karten). Seed-Bibliothek mit 20–30 validierten **Struktur-Klassen** fuer haeufig vorkommende Muster, jede Klasse gegen die Benchmark und gegen mindestens drei strukturell-aehnliche Produktionsseiten aus unterschiedlichen Domains getestet.

**Block B — Fallback als Zustandswechsel und Lern-Modus.** Wenn kein Muster die Schwelle erreicht oder eine Karten-Ausfuehrung scheitert, nimmt Operator alle Karten vom Tisch und bietet stattdessen fuenf Primitive an (click, type, read, wait, screenshot). Der Wechsel muss im `operator`-Return mit explizitem Framing angekuendigt werden — kein Fehlerzustand, sondern alternativer Tool-Kontext. Waehrend des Fallback-Laufs registriert Operator strukturelle Muster-Signaturen. Diese Signaturen beschreiben **Struktur-Klassen**, nicht Shops oder Seiten. Das ist keine Stil-Frage, sondern die Grundlage dafuer, dass das Commons-Lernen in Phase 2 ueberhaupt skaliert.

**Block C — Transparenz und Audit-Spur.** Das `why_this_card`-Feld im Operator-Return liefert vollstaendigen Signal-Breakdown, Score, Schwelle, Gegen-Signal-Check-Ergebnisse und Karten-Version mit Quelle. Fallback-Log hat dasselbe strukturierte Format. Ohne diese Audit-Spur laesst sich Karten-Falschauswahl nicht debuggen — und ohne debugbare Falschauswahl kann die Commons-Community in Phase 2 niemandem vertrauen. Besondere Relevanz hat das Feld an Struktur-Klassen, die sich nur in Nuancen voneinander unterscheiden (Login-Formular vs. 2FA-Rescue-Formular als Beispiel aus Lenas Journey). Dort ist das Audit-Feld das Werkzeug, mit dem Falsch-Matches eingegrenzt und die Signatur geschaerft werden — auf Klassen-Ebene, mit Wirkung auf alle Seiten derselben Klasse weltweit.

**Block D — Zweigleisige Doku und Onboarding.** Migrations-Track fuer Bestandsnutzer mit Vorher-Nachher-Beispielen (run_plan-Template vs. einmal-getippter Satz an operator). Getting-Started-Track fuer Einsteiger ohne Vorwissen ueber run_plan oder das fruehere Werkzeugkasten-Modell. Die beiden Spuren in Dokumentation und Release-Kommunikation sauber getrennt. Installations-Pfad so kurz, dass ein Sonntagabend reicht. Pull-Request-Pfad fuer Nutzer-Beitraege zur Seed-Bibliothek dokumentiert, so dass Jamal-artige Nutzer ohne Ruecksprache strukturelle Signaturen einreichen koennen.

**Block E — Phase-2-Bruecke schon im MVP verankert.** Die Muster-Signatur, die im Fallback registriert wird, ist strukturell beschrieben und in einem Format, das spaeter vom Harvester ohne Struktur-Bruch aufgenommen werden kann. Passive Harvester-Hook-Stelle im Klient-Code bereits vorgesehen, auch wenn sie in v1 nicht aktiv ist. Das Karten-Datenmodell ist so ausgelegt, dass spaeter Crowd-eingereichte Karten (mit Quellen-Liste, Confidence-Score, Wartebereich auf der Transparenz-Seite) ohne Schema-Migration ergaenzt werden koennen.

**Rahmen-Bemerkung zur Spar-These.** Die fuenf Bloecke sind user-seitige Verankerung der technischen Ziele — jede Erfolgskriterium-Zahl im PRD hat jetzt eine Person im Kopf, die davon profitiert oder scheitert (Marek, Annika, Jamal, Lena). Gleichzeitig steht die ganze Konstruktion auf einer Wette: der Kartentisch spart nur dann wirklich Laufzeit, wenn die Seed-Bibliothek die haeufigsten Muster gut abdeckt (Ziel 85 Prozent Hit-Rate) und wenn die Karten echte Multi-Step-Handlungen buendeln. Der Schutz gegen die Wette ist der Fallback auf zwei Ebenen: situativ pro Seite (Primitive, wenn die Karte nicht passt) und auf Produkt-Ebene im Worst Case (Rueckfall auf das aktuelle run_plan-Modell, das heute schon mit Playwright MCP auf Augenhoehe mithaelt). Testen werden wir's erst, wenn wir auf dem Weg sind — aber durch die doppelte Sicherheit koennen wir den Weg ohne existentielles Risiko gehen. Unter den vier Journeys ist **Mareks Journey Launch-kritisch** (wenn der Bestandsnutzer-Uebergang klemmt, gibt es Abwanderung und das MVP-Gate faellt), **Annikas Journey strategisch tragend** (sie oeffnet den Adoption-Trichter fuer alle, die nie vom Werkzeugkasten wussten). Jamal und Lena sichern die Qualitaet des Mechanismus, sind aber nicht erster Launch-Eindruck.

## Domain-Specific Requirements

Als Developer-Tool mit general domain hat SilbercueChrome keine schweren Compliance-Pflichten — kein HIPAA, kein PCI-DSS, kein FDA-Rahmen. Trotzdem gibt es drei Beruehrungspunkte, die bei der MVP- und Phase-2-Planung mitgedacht werden muessen.

**Datenschutz der Muster-Signaturen in Phase 2.** In Phase 1 (Epic 19) bleiben alle Muster-Signaturen lokal auf dem Klienten-Rechner. Kein Upload, keine Uebertragung, keine Datenschutz-Frage. In Phase 2 (Epic 20) kommt der Harvester, der Muster-Signaturen an eine Cloud-Sammelstelle schickt. Hier gilt: die Signaturen muessen **strukturell bleiben und nicht identifizierend werden**. Konkret bedeutet das, dass die DOM-Verschachtelungs-Beschreibung keine URL-Teile, keine Textinhalte und keine personenbezogenen Daten mitschleppen darf. Das ist nicht *"nice to have"*, sondern Privacy-by-Design als harte Konstruktionsvorgabe fuer den Harvester-Schritt. Da Phase 2 erst nach Phase 1 beginnt, kann der Klienten-Code im MVP schon so strukturiert werden, dass der spaetere Harvester keine sensiblen Felder aggregieren *kann* — nicht nur *sollte*.

**Lizenzen der Basis-Libraries fuer die Container-Aggregation.** Die Struktur-Erkennungs-Schicht baut auf Chromium-Feldtypen (118 Typen, BSD-3-Clause-lizenziert) und Mozilla Fathom-Rulesets (MIT-lizenziert) auf. Beide Lizenzen sind permissive und mit dem Open-Source-Free-Tier (MIT) und dem proprietaeren Pro-Binary vertraeglich. Attribution ist Pflicht und wird in der NOTICE-Datei sowie in der Documentation-Attribution-Seite gepflegt. Keine virale Kopierpflicht, keine Source-Code-Herausgabe-Pflicht fuer den Pro-Teil. Das ist der Grund, warum diese beiden Libraries ausgewaehlt wurden und nicht etwa GPL-lizenzierte Alternativen.

**Payment Processing ueber Polar.sh.** Die Pro-Subscription laeuft ueber Polar.sh als Lizenz-Gateway. Damit sind Zahlungsdaten, Rechnungsstellung und DSGVO-konforme Verarbeitung an Polar.sh ausgelagert — SilbercueChrome selbst speichert keine Zahlungsinformationen. Die einzige clientseitige Beruehrung ist der Lizenz-Schluessel, der entweder als Umgebungsvariable (`SILBERCUECHROME_LICENSE`) oder als lokale Datei (`~/.silbercuechrome/license.json`) liegt und nur gegen Polar.sh online verifiziert wird, mit Sieben-Tage-Grace-Period fuer Offline-Robustheit. Das Modell ist bereits bei SilbercueSwift validiert und im Produktionseinsatz.

Weitere Domain-spezifische Anforderungen sind fuer dieses Produkt nicht relevant. Sicherheits-Features (Sandbox, Authentifizierung), Performance-Ziele und nicht-funktionale Anforderungen werden im dafuer vorgesehenen NFR-Abschnitt des PRDs behandelt und sind nicht Teil dieses Domain-Kapitels.

## Innovation & Novel Patterns

### Detected Innovation Areas

Das Neue an SilbercueChrome liegt nicht in einer einzelnen technischen Erfindung, sondern in einer Kombination von drei Saeulen, die einzeln nicht ausreichen und zusammen einen stabilen Graben bilden.

Die erste Saeule ist der **Perspektivwechsel von Werkzeug zu Handlung**. Der heutige Werkzeugkasten-Ansatz (Playwright MCP, Chrome DevTools MCP, Stagehand, browser-use) bietet dem LLM mechanische Primitive an — click, type, scroll, evaluate — und ueberlaesst ihm die Planung jedes einzelnen Schritts. SilbercueChrome dreht das um: Der Server liest die Seite, erkennt strukturelle Muster, legt dem LLM fertige **Handlungskarten** vor. Das LLM waehlt semantisch, nicht mechanisch. Empirische Vorhut dafuer ist das Vercel-Experiment mit dem Reduktions-Verhaeltnis 25-auf-5-Tools, das bei gleichzeitig hundertprozentiger Erfolgsrate einen dreieinhalbfachen Geschwindigkeitsgewinn zeigte — ein externer Befund, der unsere Spar-These stuetzt, ohne sie zu beweisen.

Die zweite Saeule ist der **Struktur-statt-Seite-Kniff**. Karten sind nicht fuer konkrete Shops oder Domains gebaut, sondern fuer Muster-Klassen — Login-Formular, Zwei-Schritt-Formular mit Weiter-Button, Bild-Inhalt-zur-Interpretation. Eine einzige Login-Karte greift auf Shopware-Backend, Gmail, Jira und jedem handgebauten Admin-Panel mit derselben DOM-Signatur. Das ist der Grund, warum das System mit einem handpflegbaren Stapel von ein paar hundert Karten funktioniert statt mit Millionen seiten-spezifischer Skripte. Mathematisch: **eine Million Seiten geteilt durch ein paar hundert Struktur-Klassen ist eine pflegbare Zahl, eine Million geteilt durch eine Million ist keine**.

Die dritte Saeule ist der **Commons-Graben als Wachstumsmechanik**. Jeder Fallback-Moment in Phase 1 wird zu einem Kandidaten fuer eine neue Karte. In Phase 2 fliessen solche Beobachtungen anonym an eine Cloud-Sammelstelle, und sobald fuenf unabhaengige Quellen dieselbe strukturelle Signatur sehen, wird daraus eine offizielle Karte. Jeder Nutzer, auch der Free-User, arbeitet unbemerkt am kollektiven Nutzen mit — daher der Leitsatz **"Teilhabe statt Produkt"**. Das ist nicht Marketing-Sosse, sondern eine technische Konsequenz der Struktur-Logik: ohne sie skaliert das Lernen nicht. Diese dritte Saeule ist bewusst **Vision-Ausblick, nicht MVP-Versprechen**: In Epic 19 wird sie als passive Hook-Stelle im Klient-Code vorbereitet, aktiviert wird sie erst in Epic 20. Der MVP prueft Saeule eins und zwei (Perspektivwechsel und Struktur-statt-Seite) — Saeule drei (Commons) ist die Wachstumshebel-Wette fuer Phase 2 und 3. Die Schema.org-/OSM-/Wikidata-Parallelen zeigen, was moeglich ist, nicht in welchem Tempo — alle drei Beispiele hatten institutionelle Traeger und ein bis zwei Jahrzehnte Zeit. SilbercueChrome startet mit Solo-Maintainer und MVP-Zeitbox, und genau deshalb ist der Commons kein MVP-Gate.

Einzeln waere jede Saeule kopierbar. Der Werkzeugkasten-Konkurrent kann morgen seine Tools buendeln — Stagehand und browser-use stossen teilweise schon in diese Richtung. Struktur-basierte Erkennung existiert in Fathom und in Chromium's Feldtyp-Klassifizierung, beide BSD/MIT-lizenziert, also nicht unser exklusives Territorium. Und einen Commons zu starten ist kein Patent-Akt. Der **Graben ist die Kombination plus die Zeit**: wer jetzt anfaengt und sauber durchhaelt, baut Vertrauen, eine Seed-Bibliothek und eine Beitraeger-Community auf, die eine nachziehende Firma strukturell nicht einholen kann. Die Parallelen sind Schema.org fuer Markup, OpenStreetMap fuer Karten, Wikidata fuer Entitaeten — alle erfolgreich, weil sie kein Firmenprodukt sind, und deshalb nachziehende kommerzielle Versuche (Google Places, Facebook Graph als Gegenbeispiele) nie dieselbe Adoption erreichen.

### Market Context & Competitive Landscape

Das Umfeld ist voll mit Werkzeugkasten-MCPs, und sie sind gut. Heutiger Stand: Playwright MCP liegt bei rund 56 MQS-Punkten mit einem Tool-Definition-Overhead von 13'700 Tokens; Chrome DevTools MCP ist schwerer (rund 17'000 Tokens Overhead, instabile Pass-Rate); Stagehand und browser-use spielen als Agent-Frameworks ein Stueck weiter oben in der Abstraktion, aber beide basieren weiterhin auf mechanischen Primitives im LLM-Kontext. SilbercueChrome fuehrt heute knapp mit 60,3 Punkten, das ist ein Rasiermesser-Vorsprung auf `run_plan`-Basis und kein stabiler Graben — in zwei bis drei Wochen nachbaubar.

Was *niemand* im Markt bietet: **ein strukturbasiertes Karten-Modell mit serverseitiger Bündelung von Folge-Seiten-Scan und Karten-Lieferung**, und **kein oeffentlicher Commons fuer Action-Patterns**. Die Marktluecke ist beide Male die Kombination: einzelne Bausteine (Fathom-Regeln, Chromium-Feldtypen, Buendeln in Agent-Frameworks) existieren, aber niemand hat sie in ein MCP-Format zusammengezogen, und niemand hat versucht, die resultierenden Muster als gemeinsame Infrastruktur zu organisieren. Der OpenAI-Operator, der in Namensfrage unser Nachbar ist, ist ein komplett anderes Produkt — ein Agent, der selbst in einem Browser sitzt und durch ein LLM gesteuert wird, ohne MCP-Schicht, ohne Commons-Ambition, ohne Community-Graben. Die Namens-Kollision ist Reibungspunkt, keine Wettbewerbs-Frage.

Eine Web-Recherche vor Release-Drop ist trotzdem sinnvoll: *"MCP browser automation new paradigm 2026"* und *"open source action pattern commons 2026"*, um zu pruefen, ob ein Parallel-Versuch in den letzten Wochen aufgetaucht ist. Bis zu Redaktionsschluss dieses PRDs ist kein solcher Versuch bekannt.

### Validation Approach

Die Wette auf das neue Paradigma wird auf drei Ebenen validiert, und alle drei muessen halten, damit wir beim Phase-1-Release nicht alleine ueberzeugt dastehen.

Die **harte Ebene** ist der MQS-Benchmark als quantitatives Gate. Baseline heute 60,3 Punkte. Epic 18 soll 63–65 bringen (Absicherung durch Forensik-Fixes, nicht durch den Paradigma-Wechsel). Epic 19 muss dann ueber 70 Punkte springen — nicht durch bessere Tool-Latenzen, sondern durch eingesparte LLM-Denkzeit. Wenn der Sprung bei Epic 19 ausbleibt, ist der Kartentisch-Kern nicht wie erhofft wirksam, und wir muessen die Seed-Bibliothek erweitern oder die Fallback-Schwelle nachschaerfen, bevor Phase 1 release-reif wird. Parallel dazu die Wall-Clock-Messung: Der Benchmark-Durchlauf im Operator-Modus muss mindestens fuenfzig Prozent kuerzer laufen als im `run_plan`-Modus der v0.5.0-Baseline — das ist die eigentliche Spar-These in physikalischer Zeit. Zusaetzlich zum End-Epic-Gate ein **Zwischencheckpoint bei Epic-19-Halbzeit** (etwa Tag 20 des MVP-Laufs): MQS muss dann mindestens 66 Punkte zeigen — nicht 70, das waere zu streng fuer die Halbzeit, aber genug als Truehwarn-Indikator. Bleibt der Zwischenwert unter 66, wird nachgesteuert (Seed-Bibliothek erweitern oder Fallback-Schwelle schaerfen), bevor die zweite Haelfte der MVP-Box verbrannt wird. Der Grund ist nuechtern: bei 45 Tagen MVP-Umsetzungsdauer willst du am Tag 40 nicht erst merken, dass die Erkennungsrate haengt.

Die **mechanische Ebene** ist der Erkennungstest auf dem Benchmark-Parcours. Mindestens fuenfundachtzig Prozent aller Tests muessen mindestens ein passendes Muster erkennen; die restlichen fuenfzehn Prozent fallen sauber in den Fallback. Falscherkennungen unter fuenf Prozent — die harte Zahl dafuer, dass Karten nicht *"vielleicht passend"*, sondern *"sicher passend"* anschlagen. Die Container-Aggregations-Schicht ist dabei der Neuland-Teil, fuer den keine Open-Source-Referenz existiert, also auch der Teil mit dem groessten Implementierungs-Risiko.

Die **qualitative Ebene** ist der blinde Nutzer-Test mit fuenf SilbercueChrome-Bestandsnutzern der Marek-Klasse. Mindestens drei von fuenf muessen den Unterschied zum alten `run_plan`-Modell spontan in eigenen Worten beschreiben als *"schneller, weil ich weniger Schritte planen muss"* oder sinngemaess. Wenn niemand einen Unterschied erlebt, den er in Worte fassen kann, hat das Paradigma seinen Sinn verfehlt — selbst wenn die Benchmark-Zahlen stimmen.

Validation fuer die Commons-Wette faellt in Phase 2 und ist deshalb nicht MVP-Gate. Messpunkt dort: Anzahl externer Beitraege zum Kartenstapel, Anzahl unabhaengiger Harvester-Quellen (Ziel: fuenf pro promoteter Karte als Schwelle, deshalb die Zahl), und die Erwaehnung des Leitsatzes in substantiellen externen Artikeln (Ziel: drei im ersten Jahr nach Phase-2-Launch).

### Risk Mitigation

Die Konstruktion ist ueber drei Risiko-Klassen hinweg abgesichert, und alle drei sind explizit im PRD-Rahmen verankert.

Das **technische Hauptrisiko** ist, dass die Spar-These nicht traegt — entweder weil die Erkennungs-Rate unter 85% liegt, oder weil die Seed-Bibliothek die haeufigsten Muster nicht gut genug abdeckt, oder weil LLMs die Karten-Abstraktion doch nicht so gut verstehen, wie das Vercel-Experiment suggeriert. Die Absicherung ist der **Fallback auf zwei Ebenen**: situativ pro Seite werden die fuenf bis sechs Primitive (click, type, read, wait, screenshot) angeboten, wenn keine Karte die Schwelle erreicht; produkt-weit bleibt das alte `run_plan`-Modell als Rueckfall-Produktlinie erhalten, das heute schon mit Playwright auf Augenhoehe mithaelt. Im Worst Case verlieren wir das Innovations-Argument, nicht die Produkt-Existenz.

Das **kulturelle Risiko** ist, dass Werkzeugkasten-Gewohnte den Kartentisch als Bevormundung empfinden und den Fallback-Modus als Fehlerzustand interpretieren. Die Absicherung ist das explizite Framing im Operator-Return (*"kein strukturelles Muster erreicht Schwelle — fuenf Primitive verfuegbar, manuelle Ausfuehrung erwuenscht"*), das den Fallback als gleichwertigen Zustand markiert, und die zweigleisige Doku (Migrations-Track fuer Marek, Getting-Started fuer Annika), die den Uebergang narrative absichert.

Das **Falsch-Match-Risiko** ist die Lena-Klasse: eine Karte greift knapp ueber der Schwelle auf einer Seite, die strukturell nur aussieht wie das gewuenschte Muster, und erzeugt einen unauffaelligen Folgefehler (Zahlen alle Null, obwohl Login scheinbar geklappt hat). Die Absicherung ist das `why_this_card`-Feld mit vollstaendigem Signal-Breakdown, Score, Schwelle und Gegen-Signal-Check-Ergebnis — nicht als Debug-Luxus, sondern als *verpflichtender* Teil jedes Operator-Returns. Ohne diese Audit-Spur sind Falsch-Matches in Phase 2 im Crowd-Konsens nicht nachvollziehbar, und ohne Nachvollziehbarkeit gibt es keinen Commons-Vertrauen.

Das **Commons-Risiko** ist, dass keine Nutzer beitragen und der Stapel klein bleibt. Die Absicherung ist, dass Phase 1 lokal funktioniert — die Seed-Bibliothek mit 20–30 handgepflegten Karten reicht fuer den MVP-Nutzen aus. Commons ist Wachstumshebel in Phase 2 und Vision in Phase 3, kein MVP-Gate. Wenn die Teilhabe ausbleibt, ist der Commons-Graben nicht da, aber das Produkt funktioniert trotzdem.

**Kontext-Rahmen zur gesamten Wette.** Dieses PRD beschreibt eine **7-plus-45-Tage-Wette** — sieben Tage sind bereits in Planungs- und Forensik-Arbeit geflossen (Sprint Change Proposal, Forschungsdokumente, dieses PRD selbst), rund 45 Tage sind fuer die Umsetzung von Epic 18 und 19 veranschlagt. Das ist die Box, in der alle oben genannten Risiken gemessen werden muessen. In dieser Groessenordnung ist die Beibehaltung des `run_plan`-Modells als Produktlinien-Fallback **Sicherheitsnetz, nicht langfristige Parallelarchitektur** — die Pflege-Kosten der Doppel-Linie sind ueber 45 Tage manageable und werden im Vision-Abschnitt (Epic 21) explizit neu verhandelt, wenn der Kartentisch seine These erfuellt hat. Der Grund, diese Zeitbox ins Risk-Kapitel zu schreiben: wer das PRD spaeter ohne diesen Rahmen liest, koennte Plan-B-Architektur-Overheads vorschlagen, die in einer so engen Wette strukturell nicht hinpassen.

Ein **offener Punkt** bleibt die **Namens-Kollision mit OpenAI Operator**, die in Epic 21 (Neu-Launch) geklaert werden muss. Bis dahin arbeiten wir mit *"Operator"* als internem Codenamen, und die Entscheidung kommt bewusst erst dann, wenn das Produkt content-lich steht — Naming-by-committee vor Produkt-Klarheit hat bei uns noch nie funktioniert.

## Developer-Tool Specific Requirements

### Project-Type Overview

SilbercueChrome ist ein **Node.js-MCP-Server**, der KI-Agenten ueber das Model Context Protocol (MCP) an einen echten Chrome-Browser bindet — Stdio-Transport, direkte Chrome-DevTools-Protocol-Anbindung (CDP), kein Headless-Zwang, keine Playwright-Schicht als Umweg. In der Kategorisierung *developer_tool* ist das Produkt ein **Library/Server-Hybrid**: der Endnutzer (ein Entwickler oder LLM-Power-User) installiert es einmal, konfiguriert es in seinem MCP-Client und ruft die Tools dann indirekt durch sein Sprachmodell auf. Es ist kein interaktives Desktop-Programm und keine SaaS — es ist eine Integrations-Komponente fuer andere LLM-Produkte.

Nach dem Operator-Pivot wird der Charakter schaerfer: Statt eines Werkzeugkastens mit rund fuenfundzwanzig Tools exportiert SilbercueChrome im Standard-Modus nur noch zwei Top-Level-Tools (`virtual_desk`, `operator`) plus einen Fallback-Modus mit fuenf bis sechs Primitives. Diese Oberflaechen-Verschlankung ist nicht nur Kosmetik — sie ist der Hauptgrund, warum das Produkt im neuen Zustand **weniger als dreitausend Tokens Tool-Definition-Overhead** braucht, waehrend Playwright MCP bei 13'700 und Chrome DevTools MCP bei rund 17'000 liegt.

### Technical Architecture Considerations

Die tragende Konstruktion steht auf drei Schichten. **Erstens** der MCP-Server-Kern, der heute schon existiert und unveraendert bleibt — Stdio-Transport, Tool-Registry, Session-Management, Refs-System, Accessibility-Tree-Abstraktion. **Zweitens** die **Container-Aggregations-Schicht**, die im MVP neu entsteht und als einziger Teil keine direkte Open-Source-Referenz hat: Sie fragt Chromium-Feldtypen (118 Klassifikationen, BSD-3-Clause) und Mozilla-Fathom-Rulesets (MIT) ab, konsolidiert deren Einzel-Signale zu DOM-Struktur-Signaturen und entscheidet, welche Karten-Muster die Schwelle erreichen. **Drittens** der Operator-Konversations-Loop, der serverseitig Folge-Seiten-Scans und Karten-Lieferungen buendelt, ohne das LLM dazwischen aufzurufen — das ist die Stelle, an der die Spar-These sich mechanisch materialisiert.

Die Connection-Modes bleiben wie heute: **Auto-Launch** als Default (Zero-Config, Chrome wird als Kindprozess gestartet), **WebSocket** optional (bestehender Chrome mit Remote-Debugging auf Port 9222), und **Fehler** wenn beides nicht geht. Der Auto-Launch-Pfad ist der wichtigste fuer Annika-Einsteiger, weil er eine installationsfreie Erfahrung produziert.

Brownfield-Constraint: die 17 Epics, die das bisherige Produkt gebaut haben, bleiben unveraendert. Epic 18 (Forensik-Fixes) und Epic 19 (Kartentisch, Seed, Fallback) bauen **auf** dieser Basis auf, schneiden aber kein bestehendes Feature weg. Der alte `run_plan`-Tool-Kontext bleibt als internes Sicherheitsnetz verfuegbar — siehe Kontext-Rahmen im Innovation-Kapitel.

### Language Matrix

Runtime **Node.js 18+** als Mindest-Version (wie heute in der `package.json` unter `engines.node` eingetragen — eine Anhebung auf Node 20 ist eine Detail-Entscheidung, die in Epic 19 separat getroffen werden kann, wenn eine neu benoetigte Dependency es erzwingt). Implementierungssprache **TypeScript**, Build ueber `tsc → build/`. Testframework **Vitest** (rund 1100 bestehende Unit-Tests). Unterstuetzte Betriebssysteme **macOS, Linux, Windows** ueberall dort, wo Node 18 laeuft. Unterstuetzter Browser **Chrome 100+** (CDP 1.3 als Minimum, real getestet bis Chrome 146). Keine Python-, Go- oder Rust-Variante und keine Portierung auf Firefox/WebKit/Safari geplant — das waere eine eigene Produktlinie, nicht Teil dieses PRDs.

### Installation Methods

Der Haupt-Installationspfad ist **npm**: `npm install silbercuechrome` oder direkt ueber den MCP-Client-Config-Eintrag mit `npx silbercuechrome`. Das ist der Kanal fuer den Free-Teil (MIT-Lizenz), den Annika ohne Vorwissen in zehn Minuten durchlaeuft. Der Pro-Teil laeuft ueber ein **Node SEA Binary**, das ueber den Release-Skill `silbercuechrome-publish` gebaut und via GitHub-Release verteilt wird — lizenziert ueber **Polar.sh** (Org-ID separat, License-Keys getrennt von SilbercueSwift). Die Lizenz wird entweder als Umgebungsvariable `SILBERCUECHROME_LICENSE` oder als Datei unter `~/.silbercuechrome/license.json` gepflegt, mit sieben Tagen Offline-Grace.

Environment-Variablen fuer das Runtime-Verhalten bleiben wie heute: `SILBERCUE_CHROME_AUTO_LAUNCH` (Default true), `SILBERCUE_CHROME_HEADLESS` (Default false), `SILBERCUE_CHROME_PROFILE` und `CHROME_PATH`. Diese Liste waechst im MVP nicht — jede zusaetzliche Env-Variable ist Komplexitaet, die im schlanken Operator-Modell nicht hingehoert.

### API Surface

Die **oeffentliche Oberflaeche** besteht im Standard-Modus aus genau zwei Tools: `virtual_desk` (legt einen sitzungseigenen Arbeits-Kontext an, startet und verwaltet Tabs) und `operator` (das eigentliche Kartentisch-Tool, das Seite laedt, Muster erkennt, Karten zum LLM schickt, Karten-Auswahl mechanisch ausfuehrt, Folgeseiten scannt). Im **Fallback-Modus** ersetzt `operator` seine Karten durch **fuenf Primitives** (click, type, read, wait, screenshot), mit optionalem sechsten Primitive `evaluate` fuer Power-User. Der Uebergang zwischen beiden Modi geschieht automatisch durch die Erkennungs-Schwelle und wird im Operator-Return mit explizitem Framing kommuniziert.

Alle bisherigen fuenfundzwanzig Tools des Werkzeugkastens bleiben **intern als Bausteine** erhalten — sie sind die Implementierungs-Grundlage der Karten-Ausfuehrung und des `run_plan`-Sicherheitsnetzes — aber sie werden im Standard-Tool-Kontext des LLMs nicht mehr exportiert. Das ist die entscheidende Unterscheidung zwischen **API-Oberflaeche** (was das LLM sieht) und **Implementierungs-Inventar** (was der Server intern zur Verfuegung hat).

Das `operator`-Return-Format folgt einem festen Schema: Tab-Kontext, Karten-Liste mit Parameter-Schemas, pro Karte ein `why_this_card`-Feld mit Signal-Breakdown und Score, bei Fallback ein explizites Framing *"Kein strukturelles Muster erreicht Schwelle — fuenf Primitive verfuegbar, manuelle Ausfuehrung erwuenscht, Muster-Signatur wird registriert"*. Dieses Return-Schema ist der Vertrag mit dem LLM, und jede Aenderung daran ist eine Breaking-Change-Entscheidung.

### Code Examples

Die README im MVP traegt **drei Code-Walkthroughs**, die die drei Erlebens-Modi des Produkts abdecken. **Walkthrough eins — Migration (Marek)**: Nebeneinander gestellt der alte `run_plan`-Template-Weg und der neue `operator`-Einzeiler fuer dieselbe Aufgabe (Login auf einer Shop-Backend-Seite, einen Report ziehen). Zeigt mit minimalem Text, wieviel weniger geplant werden muss. **Walkthrough zwei — First Contact (Annika)**: Der Screenshot-Sweep-Fall aus Journey 2, ein einziger Satz vom Nutzer zum LLM, drei URLs, neun Screenshots. Keine Erlaeuterung, wie man *"richtig"* formuliert — sondern Demonstration, dass das Modell den Satz versteht, ohne dass der Leser sich durch Tool-Syntax quaelen muesste. **Walkthrough drei — Fallback (Jamal)**: Ein bewusst uninterpretierbares Beispiel, in dem Operator beim Scan keinen Karten-Match findet, die Primitive hinlegt und das LLM mechanisch durchklickt. Zeigt den Fallback als normalen Zustand, nicht als Fehlermeldung — mit sichtbarem `why_this_card`-Audit-Output als Beleg dafuer, warum keine Karte gewirkt hat.

Keine hundert Karten-Beispiele im README, kein API-Reference-Dump, keine Parameter-Tabelle fuer jede Karte. Die Seed-Bibliothek ist im Repository unter `cards/` auffindbar, aber die README zeigt nur die drei Walkthroughs plus einen Zwei-Saetze-Verweis auf den Ordner.

### Migration Guide

Der Migrations-Teil ist **in der README** verankert, nicht in einer separaten Migration-Datei. Ein eigener Abschnitt *"Wenn du von v0.5.0 umsteigst"*, der in weniger als zehn Absaetzen den Uebergang beschreibt: was sich aendert (zwei Tools statt fuenfundzwanzig, Karten statt Plans), was gleich bleibt (Session-Modell, Refs-System, Connection-Modes, Env-Variablen), was weg ist (`run_plan` als Haupt-Haltung, nicht als technische Entitaet — sie bleibt intern verfuegbar), und was neu ist (Kartentisch, Fallback-Framing, `why_this_card`-Audit). Ein Vorher-Nachher-Code-Beispiel aus Walkthrough eins deckt den groessten Teil des Lernens ab.

Der harte Test: Mareks Probe aus dem Success-Criteria-Abschnitt — *"ein Nutzer, der von v0.5.0 updated, kann seine Haupt-Use-Cases ohne einen einzigen Blick in die Doku weiterfuehren, weil der Fallback ihn auffaengt."* Der Migration-Guide ist dann nicht die Notwendigkeit, sondern die Vertiefung fuer diejenigen, die es wissen wollen.

### Implementation Considerations

Drei Punkte, die keine Detail-Anforderung sind, aber bei der Umsetzung nicht vergessen werden duerfen.

**Test-Hardest-Benchmark als release-kritisches Gate.** Der lokale Parcours in `test-hardest/` (aktuell 35 Tests, wird bei Bedarf erweitert) ist die einzige quantitative Instanz, die sowohl fuer MQS als auch fuer Wall-Clock-Laufzeit herangezogen wird. Jede Epic-19-Iteration muss gegen den Parcours gefahren werden, und das Zwischen-Gate bei Tag 20 (mindestens 66 MQS-Punkte) wird an genau diesem Parcours gemessen.

**Kein Docs-Website, nur README.** Bewusste Entscheidung: Die Doku-Arbeit waechst nicht ueber den README-Rahmen hinaus, weil die zweigleisige Narrative (Migration + Getting-Started) in einem einzigen Dokument besser zusammenzuhalten ist als in einer Doku-Website, die strukturell zur Trennung zwingt. Das spart Infrastruktur-Aufwand und haelt die Informationsdichte hoch.

**Free/Pro-Schnitt neu dokumentieren.** Der Schnitt aendert sich mit dem Operator-Pivot: Kartentisch, Seed-Bibliothek und Fallback sind **frei und Open Source** (MIT). Der Pro-Layer bleibt fuer parallele Execution (`executeParallel`, existiert aus Epic 7.6/16), erweiterte Observability, prioritaeren Karten-Update-Kanal (relevant ab Phase 2), Enterprise-Deployment und Support/SLA. Dieser Schnitt muss im Release-Narrativ und in der Pricing-Kommunikation konsistent gefuehrt werden, weil der alte Schnitt auf anderen Trennlinien basiert hat.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

Der MVP ist ein **Hybrid aus Problem-Solving-MVP und Experience-MVP** — bewusst auf beiden Beinen, weil jedes einzelne Bein alleine zu duenn waere. Der **Problem-Solving-Teil** adressiert die LLM-Denkzeit als primaeren Laufzeit-Fresser und validiert mit harten MQS-Zahlen: MQS mindestens 70 Punkte nach Epic 19, Wall-Clock mindestens 50 Prozent kuerzer als `run_plan`-Baseline. Der **Experience-Teil** validiert den Aha-Moment qualitativ ueber den Blind-Test mit fuenf Marek-Typ-Nutzern — drei von fuenf muessen den Unterschied spontan in eigenen Worten fassen koennen. Beide Messpunkte stuetzen sich gegenseitig: ohne MQS-Sprung ist die Spar-These widerlegt, ohne Aha-Moment bleibt der Paradigma-Wechsel ein Trick ohne Kommunikationsanker.

Explizit **nicht** ein Platform-MVP (wir bauen kein Ecosystem, Phase 2 ist Commons-Infrastruktur und Phase 3 ist Community-Launch), nicht ein Revenue-MVP (Pro-Conversion ist Nebenziel, nicht Gate), nicht ein klassischer Lean-Discovery-MVP (das Produkt ist Brownfield mit 17 Epics Basis, nicht Nullpunkt).

### Resource Requirements

**Solo-Entwicklung** ueber den gesamten Phase-1-Zyklus. Julian allein, kein Co-Maintainer, kein externes Review, keine Community-Beitraege als MVP-Voraussetzung. Das ist harte Realitaet und formt mehrere PRD-Entscheidungen retroaktiv sichtbar: Die Karten-Zahl bleibt klein (hoechstens 30 Seed-Karten), die Container-Aggregations-Schicht nutzt Chromium-Feldtypen und Fathom-Rulesets als Basis statt neu gebaut zu werden, die Doku ist auf README beschraenkt, die Namens-Entscheidung wird auf Epic 21 verschoben statt jetzt Review-Runden einzubauen. Jede Zusatz-Anforderung muss durch die Solo-Umsetzbarkeit gefiltert werden, sonst faellt die Zeitbox.

**Zeitbox: 45 Tage MVP-Umsetzung** (Epic 18 Forensik-Fixes plus Epic 19 Kartentisch/Seed/Fallback), Zwischencheckpoint bei Tag 20 mit MQS mindestens 66 Punkten. Die 45 Tage sind absichtlich eng gewaehlt — eine laengere Zeitbox waere fuer Solo-Entwicklung strukturell unrealistisch und wuerde das Projekt in Motivations-Drift schieben, eine kuerzere wuerde die Container-Aggregations-Schicht nicht tragen. Siebentags-Elastizitaet ist akzeptabel (7-plus-45-plus-7 statt 7-plus-45), alles darueber hinaus ist Umplanung.

### MVP Feature Set (Phase 1)

Die konkrete MVP-Feature-Liste ist im **Product-Scope-Kapitel**, den **Funktional-Requirements** und den **Success Criteria** ausgefuehrt — dieses Kapitel liefert ausschliesslich die strategische Rahmung darueber. Zwei Priorisierungs-Punkte, die fuer die Rahmung wesentlich sind: **Launch-kritisch** ist Mareks Journey (Bestandsnutzer-Rettung — wenn der Uebergang klemmt, gibt es Abwanderung und das MVP-Gate faellt). **Strategisch tragend** ist Annikas Journey (Adoption-Trichter fuer alle, die nie vom Werkzeugkasten wussten). Jamal und Lena sichern die Qualitaet des Mechanismus, sind aber nicht erster Launch-Eindruck.

### Post-MVP Features

Phase 2 (Epic 20) und Phase 3 (Epic 21) sind im **Product-Scope-Kapitel** unter *"Growth Features"* und *"Vision"* ausgefuehrt. Die strategischen Gates und Transitions-Kriterien sind dort dokumentiert und werden hier nicht wiederholt.

### Risk Mitigation Strategy

Drei Risiko-Klassen, explizit nach Step-8-Struktur getrennt, mit expliziter Abgrenzung gegen das bereits im Innovation-Kapitel stehende.

**Technische Risiken.** Im Innovation-Kapitel ausfuehrlich behandelt und hier nur verlinkt: Spar-These traegt nicht → Fallback auf zwei Ebenen (situativ plus produkt-weit `run_plan` als Sicherheitsnetz); Falsch-Match zwischen aehnlichen Struktur-Klassen → `why_this_card`-Audit-Feld; Container-Aggregations-Schicht als Neuland-Teil → schrittweise Validierung gegen Benchmark-Parcours mit Zwischencheckpoint Tag 20 (MQS mindestens 66). Keine Wiederholung hier, Referenz auf das Innovation-Kapitel reicht.

**Marktrisiken.** Drei nicht-redundante Punkte, die in den vorherigen Kapiteln noch nicht explizit stehen. **Erstens Substitution-Threat aus einer anderen Ecke als gedacht:** Wenn Anthropic, OpenAI oder eine andere Plattform in den naechsten sechs Monaten einen *"Structured Action Layer"* direkt ins SDK einbaut, wird die MCP-Schicht teilweise ueberfluessig. Mitigation: der Commons-Graben (Phase 2 und 3) ist **kulturell, nicht technisch**, und laesst sich nicht durch SDK-Features verdraengen; in Phase 1 ist die Mitigation vor allem *"schnell fertig werden"*, weil die 45-Tage-Zeitbox hier ihre eigentliche strategische Funktion bekommt. **Zweitens Timing-Risk:** Ein Konkurrent baut dasselbe Paradigma vor uns. Mitigation: SilbercueChrome existiert mit 17 Epics Basis schon laenger als jeder denkbare Parallel-Versuch und hat den Benchmark-Parcours als Referenz, auf dem ein Konkurrent uns nicht schnell einholen kann. **Drittens Adoption-Risk:** Bestandsnutzer weigern sich umzusteigen. Mitigation: Fallback-Modus macht den Umstieg sanft (kein Zwang zum Neu-Lernen), zweigleisige Doku adressiert beide Zielgruppen, und Mareks Success-Criteria-Probe (*"ohne einen einzigen Blick in die Doku weiterfuehren koennen"*) ist die harte Messung dieser These.

**Resource-Risiken.** Drei nicht-redundante Punkte, die bisher nur implizit waren und hier explizit stehen. **Erstens Solo-Ueberforderung:** Julian schafft die 45 Tage nicht. Mitigation ist ein **Minimum-MVP-Szenario** mit 20 Karten statt 30, groesserem Fallback-Anteil, akzeptierter Release-Verschiebung um sieben Tage auf 7-plus-45-plus-7. Alles darueber hinaus ist echte Umplanung, nicht Elastizitaet. **Zweitens Motivation-Drift:** Andere Projekte oder Gesundheitsprobleme ziehen Aufmerksamkeit ab. Mitigation: die 7-plus-45-Tage-Wette ist bewusst klein genug, dass der Lernwert allein die Investition rechtfertigt — wenn das Kartentisch-Paradigma nicht traegt, bleibt ein tiefes Verstaendnis von LLM-Tool-Steering, Browser-Automation-Feldtypen und MCP-Architektur, das fuer Folgeprojekte unmittelbar nutzbar ist. **Drittens Scope-Creep durch Perfektionismus:** Julian baut mehr als der MVP verlangt. Mitigation: Zwischencheckpoint Tag 20 mit harter MQS-Zahl (66) zwingt Realismus, die explizite *"bewusst nicht MVP"*-Liste im Phase-1-Abschnitt dient als taegliche Referenz, und das Zweigleisige der Doku wird auf genau drei Walkthroughs begrenzt.

## Functional Requirements

### Kartentisch-Erkennung und Seitenlesart

- **FR1:** Operator kann eine aktuelle Seite scannen und sowohl strukturelle DOM-Signale fuer die Karten-Erkennung extrahieren als auch eine strukturierte Seitenlesart aufbauen.
- **FR2:** Operator kann im Return eine strukturierte Seitenlesart liefern: Seitentitel, hierarchische Content-Struktur (Ueberschriften, Textbloecke, Listen, Tabellen) und interaktive Elemente (Links, Buttons, Formulare) mit Ref-Handles. Diese Lesart ersetzt den bisherigen separaten `read_page`-Aufruf im Standard-Modus.
- **FR3:** Operator kann erkannte Karten direkt an dem Element der Seitenlesart verankern, auf das sie sich beziehen — als Annotationen im Seitenbaum, nicht als separate Karten-Liste daneben.
- **FR4:** Operator kann fuer jede in der Seed-Bibliothek registrierte Struktur-Klasse einen Match-Score berechnen und nur Karten annotieren, die die Erkennungs-Schwelle erreichen.
- **FR5:** Operator kann Gegen-Signale auf Document-Body-Ebene pruefen und Karten verwerfen, wenn diese Gegen-Signale anschlagen.
- **FR6:** Operator kann mehrere Karten gleichzeitig an unterschiedlichen Stellen der Seitenlesart annotieren, wenn eine Seite mehrere unabhaengige Struktur-Klassen enthaelt.

### Karten-Ausfuehrung und Loop

- **FR7:** Das LLM kann eine Karte aus der Seitenlesart auswaehlen und die benoetigten Parameter-Werte setzen.
- **FR8:** Operator kann die ausgewaehlte Karte serverseitig mechanisch ausfuehren, entsprechend der in der Karte definierten Handlungs-Sequenz.
- **FR9:** Operator kann nach der Karten-Ausfuehrung die Folge-Seite laden, scannen und die neue Seitenlesart (inklusive eingebetteter Karten) ans LLM liefern — ohne LLM-Zwischenaufruf.
- **FR10:** Operator kann mehrstufige Karten-Ablaeufe (z.B. zweischrittige Formulare) innerhalb eines einzigen Operator-Loops ausfuehren.
- **FR11:** Operator kann Navigations-Ereignisse (Page Loads, Redirects, Tab-Wechsel) innerhalb der Karten-Ausfuehrung sauber handhaben, ohne den Loop zu brechen.

### Fallback-Modus und Primitive

- **FR12:** Operator kann alle Karten aus der Seitenlesart entfernen und in den Fallback-Modus wechseln, wenn kein Muster die Erkennungs-Schwelle erreicht.
- **FR13:** Operator kann im Fallback-Modus zwischen fuenf und sechs Primitive (click, type, read, wait, screenshot, optional evaluate) als Tool-Kontext anbieten.
- **FR14:** Operator kann den Wechsel in den Fallback-Modus im Return mit explizitem Framing kommunizieren, damit das LLM den Modus nicht als Fehlerzustand interpretiert.
- **FR15:** Operator kann waehrend eines Fallback-Laufs strukturelle Muster-Signaturen registrieren, die als Kandidaten fuer zukuenftige Seed-Karten dienen.
- **FR16:** Das LLM kann zwischen Standard-Modus und Fallback-Modus wechseln, ohne die Session zu verlieren oder die Tab-Referenzen zu invalidieren.

### Session- und Tab-Verwaltung

- **FR17:** Ein Nutzer kann ueber `virtual_desk` einen neuen Arbeits-Kontext (Session) anlegen.
- **FR18:** Ein Nutzer kann innerhalb einer Session mehrere Tabs oeffnen, zwischen ihnen wechseln und sie schliessen.
- **FR19:** SilbercueChrome kann Chrome im Auto-Launch-Modus (Zero-Config) starten oder sich mit einem bereits laufenden Chrome mit Remote-Debugging verbinden.
- **FR20:** SilbercueChrome kann ein vom Nutzer konfiguriertes Chrome-Profil nutzen, um Login-Sessions ueber Session-Grenzen hinweg zu erhalten.
- **FR21:** SilbercueChrome kann den Chrome-Lifecycle sauber managen: Auto-Launch, Verbindungspruefung und Connection-Recovery bei Netzausfaellen.

### Audit und Transparenz

- **FR22:** Operator kann im Return fuer jede annotierte Karte ein `why_this_card`-Feld liefern, das alle geprueften Signale mit Gewicht, Score und Schwelle auflistet.
- **FR23:** Operator kann die Gegen-Signal-Check-Ergebnisse im `why_this_card`-Feld sichtbar machen, inklusive welche Gegen-Signale geprueft wurden und mit welchem Ergebnis.
- **FR24:** Operator kann Karten-Version und Karten-Quelle im Return mitliefern, damit Falsch-Matches ueber Versionsgrenzen hinweg nachvollziehbar sind.
- **FR25:** Operator kann im Fallback-Modus einen strukturell gleichwertigen Log liefern wie im Standard-Modus — erklaerend, warum keine Karte die Schwelle erreicht hat.

### Karten-Datenmodell und Pflege

- **FR26:** Entwickler koennen Karten in einem menschenlesbaren, in Git pflegbaren Text-Format definieren.
- **FR27:** Entwickler koennen pro Karte Erkennungs-Signale (positiv), Gegen-Signale, Parameter-Schema und Ausfuehrungs-Sequenz definieren.
- **FR28:** Entwickler koennen Karten gegen den Test-Hardest-Benchmark-Parcours validieren, bevor sie in die Seed-Bibliothek aufgenommen werden.
- **FR29:** Entwickler koennen Karten gegen mindestens drei strukturell aehnliche Produktionsseiten aus unterschiedlichen Domains testen, bevor sie aufgenommen werden.
- **FR30:** Externe Beitragende koennen neue Karten-Kandidaten als Pull Request ins oeffentliche Seed-Repository einreichen, nach einem dokumentierten Pfad.

### Lizenzierung und Distribution

- **FR31:** Der Free-Build (MIT-lizenziert) kann den kompletten Kartentisch-Mechanismus inklusive Seed-Bibliothek und Fallback-Modus nutzen.
- **FR32:** Der Pro-Build kann zusaetzlich parallele Plan-Ausfuehrung, erweiterte Observability und prioritaeren Karten-Update-Kanal anbieten.
- **FR33:** Der Pro-Build kann eine Polar.sh-Lizenz (Umgebungsvariable oder lokale Datei) validieren und bei Offline-Zustand sieben Tage Grace-Period gewaehren.
- **FR34:** Nutzer koennen SilbercueChrome ueber npm (Free) oder als Node SEA Binary via GitHub-Release (Pro) installieren.

### Migration und Onboarding

- **FR35:** Die README kann einen Migrations-Abschnitt fuer v0.5.0-Umsteiger enthalten, der den Uebergang in weniger als zehn Absaetzen beschreibt.
- **FR36:** Die README kann drei Code-Walkthroughs enthalten, die Migration (Marek), First Contact (Annika) und Fallback (Jamal) abdecken.
- **FR37:** Ein v0.5.0-Bestandsnutzer kann seine Haupt-Use-Cases ohne Dokumentations-Konsultation weiterfuehren, weil der Fallback-Modus und die Seed-Karten ihn auffangen.
- **FR38:** Ein Neuling kann SilbercueChrome mit einer dreizeiligen MCP-Client-Config starten und die erste Browser-Aufgabe in weniger als zehn Minuten erfolgreich ausfuehren.

## Non-Functional Requirements

### Performance

Die gesamte Spar-These haengt an messbaren Performance-Zahlen — deshalb ist das der ausfuehrlichste Abschnitt.

- **NFR1:** Tool-Definition-Overhead im Standard-Modus unter **3000 Tokens** (Vergleich: Playwright MCP 13'700, Chrome DevTools MCP rund 17'000).
- **NFR2:** Operator-Return-Latenz im Nennzustand unter **800 Millisekunden** pro Aufruf auf einer durchschnittlichen Seite (Scan, Seitenlesart-Erzeugung und Karten-Annotation zusammen).
- **NFR3:** Benchmark-Gesamtlaufzeit im Operator-Modus mindestens **50 Prozent kuerzer** als die v0.5.0-`run_plan`-Baseline, gemessen in Wall-Clock-Sekunden auf dem Test-Hardest-Parcours.
- **NFR4:** Karten-Erkennungs-Rate auf dem Benchmark-Parcours mindestens **85 Prozent** (Tests, in denen mindestens ein Muster die Schwelle erreicht und eine passende Karte annotiert wird).
- **NFR5:** Falscherkennungs-Rate unter **5 Prozent** (Karten, die ueber der Schwelle anschlagen, aber bei Ausfuehrung einen nachweisbaren Folgefehler verursachen).

### Security

Kein Umgang mit sensiblen Nutzer-Daten in Phase 1, kein Payment-Processing im SilbercueChrome-Prozess selbst, keine Compliance-Pflichten wie HIPAA oder PCI-DSS. Die relevanten Punkte sind dennoch nicht trivial.

- **NFR6:** Polar.sh-Lizenz-Schluessel werden weder in Log-Ausgaben noch in Telemetrie-Streams aufgezeichnet. Sie erscheinen ausschliesslich im Memory des laufenden Prozesses.
- **NFR7:** Phase 1 uebertraegt **keinerlei Seiten-Inhalte oder Muster-Signaturen an externe Dienste**. Der Operator-Scan bleibt vollstaendig lokal auf dem Nutzer-Rechner.
- **NFR8:** SilbercueChrome respektiert die `SILBERCUE_CHROME_PROFILE`-Einstellung und veraendert keine Profil-Daten ausserhalb der aktiven Session (keine Cookie-Modifikation, keine Preference-Aenderung, keine History-Manipulation ausserhalb der Nutzer-Aktionen).
- **NFR9:** Fuer Phase 2 (Epic 20, nicht MVP) gilt als Privacy-by-Design-Konstruktionsvorgabe: Muster-Signaturen, die der Harvester an eine Cloud-Sammelstelle schicken wuerde, duerfen keine URLs, Text-Inhalte oder personenbezogenen Daten enthalten. Das MVP-Codemodell wird so strukturiert, dass der spaetere Harvester diese Felder **nicht aggregieren kann**, nicht nur dass er sollte.

### Scalability

SilbercueChrome ist ein lokaler Ein-Prozess-Server, also kein Datenbank-oder-Horizontal-Scale-Thema. Die echte Skalierungs-Frage liegt an anderer Stelle.

- **NFR10:** SilbercueChrome laeuft als **Ein-Nutzer-Prozess** pro MCP-Client-Instanz. Skalierung auf mehrere Nutzer erfolgt durch mehrere unabhaengige Prozesse, nicht durch Shared-State — das vermeidet Race-Conditions und Lizenz-Ambiguitaeten.
- **NFR11:** Die Seed-Bibliothek skaliert auf mindestens **100 Karten** ohne spuerbare Scan-Latenz-Einbussen gegenueber dem MVP-Start-Zustand mit 20-30 Karten. Konkret: Scan-Latenz bei 100 Karten hoechstens **doppelt so hoch** wie bei 30 Karten.
- **NFR12:** Die Container-Aggregations-Schicht ist so implementiert, dass zusaetzliche Karten keine quadratische Latenz-Explosion verursachen (Erkennung waechst hoechstens linear mit Karten-Zahl).

### Reliability

Browser-Automation ist historisch bruechig. Die Kern-Reliabilitaets-These ist, dass Kartentisch plus Fallback zusammen eine robustere Erfahrung liefern als ein reiner Werkzeugkasten — aber das muss messbar werden.

- **NFR13:** Bei Verbindungs-Verlust zum Browser versucht SilbercueChrome automatisch eine **Wiederverbindung** (Connection-Recovery), bevor ein Fehler an das LLM zurueckgemeldet wird. Konkret: mindestens drei Wiederverbindungs-Versuche mit Exponential Backoff, bevor aufgegeben wird.
- **NFR14:** Jede Seite, auf der keine Karte die Schwelle erreicht, fuehrt zu einem **sauberen Fallback-Uebergang** und nicht zu einem Crash, nicht zu einem leeren Return, nicht zu einer Exception. Der Fallback-Modus ist damit die Reliability-Grundlage fuer alle unbekannten Seiten.
- **NFR15:** Benchmark-Pass-Rate im Operator-Modus mindestens **35 von 35 Tests** (gleich oder besser als die v0.5.0-`run_plan`-Baseline). Dies ist die harte Reliability-Kennziffer im Test-Hardest-Parcours.

### Integration

Das Produkt ist ausschliesslich eine Integrations-Komponente — ohne Integration in MCP-Clients und Chrome-Browser hat es keinen Zweck.

- **NFR16:** SilbercueChrome implementiert das MCP-Protokoll ueber **Stdio-Transport** nach Spezifikation und funktioniert mit allen Standard-MCP-Clients ohne client-spezifische Anpassungen — validiert gegen Claude Code, Cursor und Claude Desktop, kompatibel mit jedem spezifikations-konformen Custom-Client.
- **NFR17:** SilbercueChrome nutzt das Chrome DevTools Protocol in **CDP-Version 1.3** als Minimum, validiert bis **Chrome 146**. Neue Chrome-Versionen werden mit Zwei-Release-Cycle-Verzoegerung unterstuetzt, Breaking-Changes im CDP werden als kritische Bugs behandelt.
- **NFR18:** Zur Laufzeit hat SilbercueChrome **keine Netzwerk-Abhaengigkeit ausser Polar.sh-Lizenz-Check** (nur Pro-Build, mit sieben Tagen Offline-Grace). Das Free-Build laeuft vollstaendig ohne Netzwerk-Verbindungen ausserhalb dessen, was der gesteuerte Browser selbst an Seiten-Requests macht.
