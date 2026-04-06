# Test: Ambient Page Context (Story 13a.1)

## Was wir testen

Nach Story 13a.1 liefert jede Tool-Response automatisch einen kompakten
Snapshot der interaktiven Elemente — WENN sich die Seite geaendert hat.
Das LLM muss nie mehr "blind" arbeiten.

## Testplan (im neuen Claude Code Fenster ausfuehren)

Kopiere folgendes als Prompt:

---

Wir testen den neuen Ambient Page Context von SilbercueChrome.
Nutze NUR das SilbercueChrome MCP (mcp__silbercuechrome__*).

**Test 1 — Navigate liefert Page Context:**
Navigiere zu http://localhost:4242
Zeig mir die KOMPLETTE Response inkl. aller Text-Bloecke.
Pruefe: Enthaelt die Response einen "Page Context" Block mit interaktiven Elementen?

**Test 2 — Click ohne DOM-Aenderung:**
Klicke auf einen Tab-Button (z.B. "Basics" oder "Intermediate").
Zeig mir die komplette Response.
Pruefe: Wenn sich die Seite geaendert hat, sollte ein neuer Page Context kommen.
Wenn nicht, sollte KEIN Page Context kommen.

**Test 3 — read_page hat KEINEN doppelten Context:**
Rufe read_page auf.
Pruefe: Die Response sollte KEINEN zusaetzlichen "Page Context" Block haben
(read_page IST selbst der Page Context).

**Test 4 — Mehrere Clicks hintereinander:**
Klicke 3x auf verschiedene Elemente.
Zeig mir bei jeder Response ob Page Context angehaengt wurde oder nicht.
Erwartung: Nur wenn sich die Seite aendert, kommt neuer Context.

Berichte nach jedem Test: PASS oder FAIL mit Begruendung.

---
