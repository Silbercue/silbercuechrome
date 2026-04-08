# Handoff — 2026-04-08 nach Epic 16 Abschluss

**Letzte Session:** Story 16.7 Phase 7 — Pro-Tier Benchmark gegen aktualisierten Pro-Server (inkl. FR-021..FR-024 Tool-Steering-Fixes).

**Status:** Epic 16 COMPLETE. Alle 7 Acceptance Criteria auf PASS. Zwei Folge-Tickets wurden beim Benchmark-Run identifiziert und warten auf die nächste Session.

---

## Was du in der neuen Session NICHT mehr machen musst

- ✅ Pro-Binary ist gebaut und via Symlink aktiv (`~/.silbercuechrome/bin/silbercuechrome-pro → dist/silbercuechrome-pro`)
- ✅ Benchmark-Run ist dokumentiert in `test-hardest/results/silbercuechrome-pro-v0.1.2-2026-04-08.json`
- ✅ `_bmad-output/implementation-artifacts/16-7-verification-results.md` ist auf PASS aktualisiert (AC #5 + #7)
- ✅ Memory `project_distribution-setup-status.md` ist auf Phase 7 done / Epic 16 complete aktualisiert
- ✅ Memory `reference_node-sea-build.md` hat den neuen "macOS Provenance Gotcha"-Abschnitt
- ✅ Der temporäre MCP-Eintrag `silbercuechrome-pro` ist aus der lokalen Claude-Config entfernt (Benchmark-Mount war Session-temporär)

---

## Was aktuell im Git-Zustand ist

### Free-Repo (`SilbercueChrome`) — uncommitted

**Die Tool-Steering-Fixes** (sollten in einen Commit):
- `src/cache/a11y-tree.ts` + `src/cache/a11y-tree.test.ts` — FR-021 Truncation-Marker + FR-022 Hidden-Content-Hint
- `src/tools/read-page.ts` + `src/tools/read-page.test.ts` — FR-022 Note-Generator
- `src/tools/type.ts` + `src/tools/type.test.ts` — FR-023 fill_form Streak-Detector (⚠ Scope-Bug, siehe Folge-Ticket 2)
- `src/tools/evaluate.ts` + `src/tools/evaluate.test.ts` — FR-024 Anti-Pattern-Scanner
- `src/registry.ts` (+ evtl. `src/registry.test.ts`) — neue Cross-Tool-Descriptions
- `scripts/visual-feedback.test.ts`, `src/tools/element-utils.ts` + `.test.ts`, `src/tools/switch-tab.test.ts`, `_bmad-output/planning-artifacts/epics.md` — pre-existing lokale Drifts (bleiben weiter lokal per Memory-Instruktion)

**Benchmark-Ergebnis** (sollte in separaten Commit):
- `test-hardest/results/silbercuechrome-pro-v0.1.2-2026-04-08.json` (NEU)
- `_bmad-output/implementation-artifacts/16-7-verification-results.md` (MODIFIED — AC #5 + #7 auf PASS)
- `_bmad-output/implementation-artifacts/handoff-2026-04-08-post-benchmark.md` (NEU — dieses Dokument)

### Pro-Repo (`silbercuechrome-pro`) — clean

Keine Änderungen nötig. Der Pro-Binary-Rebuild zieht die Free-Fixes automatisch via `file:..` Dependency ein, sobald man `bash scripts/build-binary.sh` laufen lässt. Pro-package.json ist weiter auf 0.1.1 — Version-Bump ist eine separate Entscheidung (siehe Folge-Ticket 4).

---

## Die vier offenen Folge-Tickets (priorisiert)

### 1. T4.7 Token-Budget-Kalibrierung (kleinste Priorität — kosmetisch)

**Was:** T4.7 im Benchmark hat ein Budget von `interactive: 2000 tokens` für einen read_page-Call auf 240 interaktive Elemente. Tool liefert ehrliche 2585 → Test fail.

**Warum ist das ein Ticket, kein Bug:** Die Free-Baseline vom 06.04. hat 200 Tokens gemessen — das ist numerisch unmöglich (0.83 Token pro Element). Vermutlich wurde der leere Container vor dem Klick auf "Generate" gemessen oder falsche Werte an `t4_7_verify` übergeben. Die `generate()`-Funktion im HTML ist seit Dezember unverändert.

**Optionen:**
- **(a) Budget im Test auf 4000 erhöhen** — passt zur realen Output-Größe
- **(b) Tool-Output bei vielen gleichartigen Elementen aggressiver zusammenfassen** — z.B. "40× button 'Action N'" statt einzelne Zeilen (würde allgemein Token sparen)
- **(c) Benchmark-Test so umschreiben dass er den T4.7-Subtree statt die Full-Page misst**

**Empfehlung:** (b) wäre die beste Lösung — spart allgemein Tokens und löst den Test. (a) ist das minimale Minimum. (c) versteckt das Symptom.

**Scope:** Kleine Story, 2-4 Stunden.

### 2. FR-023 Streak-Detector Scope-Fix (mittel — UX-Polish)

**Was:** Der "Try fill_form next time" Hint feuert auch, wenn 2 aufeinanderfolgende `type`-Calls in **unterschiedlichen Formularen** landen (z.B. Eingabefeld in Test-Card T6.2 und dann Eingabefeld in Test-Card T6.4 — die sind nicht verwandt, aber der Detector erkennt nur "2 type calls in 10s").

**Wo:** `src/tools/type.ts` — der Streak-Detector (neu in FR-023) trackt sessionId + timestamp, aber keinen Form-Scope.

**Fix-Ansatz:** Beim type-Call prüfen, ob der vorherige type im **gleichen Formular-Ancestor** war (`closest('form')` oder ähnliches). Wenn ja, triggern. Wenn nein, nicht. Der Detector sollte pro-form scoped sein.

**Scope:** Kleine Story, 1-2 Stunden inkl. Test.

### 3. Commit der FR-021..FR-024 Fixes (Entscheidung des Users)

**Empfohlener Flow:**

```bash
# 1. Tool-Steering-Fixes in einen Commit
git add src/cache/a11y-tree.ts src/cache/a11y-tree.test.ts \
        src/tools/read-page.ts src/tools/read-page.test.ts \
        src/tools/type.ts src/tools/type.test.ts \
        src/tools/evaluate.ts src/tools/evaluate.test.ts \
        src/registry.ts
git commit -m "feat(tool-steering): FR-021..FR-024 — truncation marker, content-hidden hint, fill_form streak detector, evaluate anti-pattern scanner"

# 2. Benchmark-Ergebnis separat
git add test-hardest/results/silbercuechrome-pro-v0.1.2-2026-04-08.json \
        _bmad-output/implementation-artifacts/16-7-verification-results.md \
        _bmad-output/implementation-artifacts/handoff-2026-04-08-post-benchmark.md
git commit -m "docs(story-16.7): Pro-Tier Benchmark Run — Epic 16 complete"
```

**Pre-existing lokale Drifts bleiben uncommitted** (siehe Memory-Instruktion `pre-existing free-repo changes`): `scripts/visual-feedback.test.ts`, `src/tools/element-utils.ts` + `.test.ts`, `src/tools/switch-tab.test.ts`, `_bmad-output/planning-artifacts/epics.md`.

### 4. Pro-Version Bump auf 0.1.2 (Entscheidung des Users)

**Wann:** Sobald Ticket 3 (Commits) durch ist. Mit den neuen Fixes sollte eine neue Pro-Release-Version rausgehen.

**Flow:**
```bash
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
npm version patch                          # 0.1.1 → 0.1.2
git push origin master --follow-tags       # triggert release.yml auf GH Actions
```

**Ergebnis:** GitHub Actions baut das Pro-Binary mit den neuen Fixes, erzeugt v0.1.2 Release mit tar.gz Asset + SHA256.

**Alternative:** Bump sparen und nächsten Batch an Fixes sammeln, dann erst bumpen. Lohnt sich wenn 2-3 weitere kleine Fixes schon in Arbeit sind.

---

## Für Context7 / Debugging relevant

- **macOS Provenance Gotcha** ist jetzt in `reference_node-sea-build.md` dokumentiert — beim nächsten Pro-Binary-Install lokal den Symlink-Trick oder `codesign --force --sign -` nutzen, nicht nur `cp`.
- **Benchmark-Reset-Verhalten:** `Benchmark.reset()` setzt nur Result-States zurück, NICHT die Form-Inputs. Für einen wirklich fresh run muss man zusätzlich die Seite neu laden (`navigate` oder `location.reload()`).
- **read_page(ref, filter:"all") bei T4.3 Large DOM:** Die 10000-Element-Liste sprengt den Token-Budget des read_page Tools auch mit max_tokens-Override. Für Needle-Suche ist evaluate mit `document.querySelector('[data-needle="true"]')` der einzig praktikable Weg — das ist ein legitimer Ausnahmefall gegen den FR-024 Anti-Pattern-Hint.

---

## Wie die nächste Session optimal startet

**Option A — Tickets abarbeiten (empfohlen wenn du Zeit hast):**
1. Commits aus Ticket 3 machen
2. Entscheidung zu Ticket 4 (Version-Bump jetzt oder später)
3. FR-023 Scope-Fix (Ticket 2) — kleine, saubere Story
4. T4.7 Budget-Kalibrierung (Ticket 1) — optional, kann auch warten

**Option B — Nur Commits + Bump:**
1. Commits aus Ticket 3
2. Version-Bump + Release (Ticket 4)
3. Tickets 1 und 2 als Backlog-Einträge in `_bmad-output/planning-artifacts/epics.md` notieren, für einen späteren Sprint.

**Option C — Komplett neues Thema:**
Die Epic-16-Arbeit ist abgeschlossen, wenn du Tickets 3 + 4 noch nachziehst. Alles andere kann in separaten Stories laufen. Falls du in der neuen Session ein ganz anderes Thema angehen willst (z.B. Epic 5b, Ambient Context, oder was auch immer), ist der Commit-Stand das einzige was vorher sauber gemacht werden sollte.
