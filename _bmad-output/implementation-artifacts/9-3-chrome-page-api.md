# Story 9.3: Chrome + Page API

Status: done

## Story

As a Python-Developer,
I want `Chrome.connect(port=9222)` und `chrome.new_page()` als einfache, synchrone API nutzen,
So that ich Browser-Automation-Skripte ohne Boilerplate schreiben kann.

## Acceptance Criteria

1. **Given** Chrome laeuft mit --script
   **When** `Chrome.connect(port=9222)` aufgerufen wird
   **Then** wird eine Verbindung hergestellt und ein Chrome-Objekt zurueckgegeben

2. **Given** eine Chrome-Verbindung
   **When** `with chrome.new_page() as page:` als Context Manager verwendet wird
   **Then** wird ein neuer Tab geoeffnet, und beim Verlassen des Context Managers wird der Tab automatisch geschlossen

3. **Given** ein Page-Objekt
   **When** die Methoden navigate(url), click(selector), fill(fields), type(selector, text), wait_for(condition), evaluate(js), download() aufgerufen werden
   **Then** fuehren sie die jeweilige Browser-Aktion ueber CDP aus und geben das Ergebnis zurueck

4. **Given** ein Page-Objekt in einem Script-Tab
   **When** das Script Aktionen ausfuehrt
   **Then** bleiben MCP-Tabs komplett unberuehrt (Tab-Isolation)

## Tasks / Subtasks

- [ ] Task 1: session_id-Routing in CdpClient nachrüsten (AC: #3)
  - [ ] 1.1 `CdpClient.send()` in `python/silbercuechrome/cdp.py` um optionalen Parameter `session_id: str | None = None` erweitern
  - [ ] 1.2 Wenn `session_id` gesetzt, `"sessionId"` ins JSON-RPC-Request-Dict einfuegen
  - [ ] 1.3 CDP-Events mit `sessionId`-Feld nur an Handler dispatchen die zu dieser Session gehoeren
  - [ ] 1.4 Tests in `python/tests/test_cdp.py` erweitern: send() mit session_id formatiert korrekt, Events mit sessionId werden korrekt dispatcht

- [ ] Task 2: Chrome-Klasse implementieren (AC: #1)
  - [ ] 2.1 `python/silbercuechrome/chrome.py` erstellen
  - [ ] 2.2 `Chrome.connect(host, port)` als synchrone classmethod: intern `CdpClient.connect()` aufrufen (Browser-Level-WebSocket), Chrome-Instanz zurueckgeben
  - [ ] 2.3 Synchrones asyncio-Wrapping: persistenten Event-Loop in Daemon-Thread starten, alle async-Aufrufe via `run_coroutine_threadsafe()` ausfuehren. NICHT `asyncio.run()` pro Aufruf (scheitert wenn bereits ein Loop laeuft, z.B. Jupyter)
  - [ ] 2.4 `chrome.new_page()` gibt ein `_PageContextManager`-Objekt zurueck (fuer `with`-Statement)
  - [ ] 2.5 `chrome.close()` schliesst die Browser-Level-CDP-Verbindung
  - [ ] 2.6 `Chrome` als Context Manager: `__enter__` gibt self zurueck, `__exit__` ruft `close()` auf. Ermoeglicht `with Chrome.connect() as chrome:`

- [ ] Task 3: Page-Klasse implementieren (AC: #2, #3, #4)
  - [ ] 3.1 `python/silbercuechrome/page.py` erstellen
  - [ ] 3.2 Page-Konstruktor: nimmt CdpClient (Browser-Level) + event_loop_runner. Erstellt neuen Tab via `Target.createTarget(url="about:blank")`, attached via `Target.attachToTarget(targetId, flatten=True)`, speichert sessionId
  - [ ] 3.3 `page.navigate(url)` — `Page.navigate` + warten auf `Page.loadEventFired` mit Timeout (Default 30s)
  - [ ] 3.4 `page.click(selector)` — Element per `Runtime.evaluate` (querySelector, getBoundingClientRect) lokalisieren, dann `Input.dispatchMouseEvent` (mousePressed + mouseReleased). Wirft Exception wenn Element nicht gefunden
  - [ ] 3.5 `page.fill(fields: dict)` — Fuer jedes Key-Value-Paar: Element per querySelector fokussieren, bestehenden Wert leeren (select-all + delete), dann Text per `Input.dispatchKeyEvent` eingeben
  - [ ] 3.6 `page.type(selector, text)` — Element per querySelector fokussieren, dann Text per `Input.dispatchKeyEvent` Zeichen fuer Zeichen eingeben
  - [ ] 3.7 `page.wait_for(condition, timeout=30)` — Polling mit `Runtime.evaluate`. condition kann JS-Expression (string) oder `"text=..."` Pattern sein
  - [ ] 3.8 `page.evaluate(js)` — `Runtime.evaluate(expression=js)`, gibt Ergebnis zurueck. Bei CDP-Error → Python Exception
  - [ ] 3.9 `page.download()` — `Browser.setDownloadBehavior(behavior="allowAndName", downloadPath=tempdir)`, gibt Download-Info zurueck
  - [ ] 3.10 `page.close()` — `Target.closeTarget(targetId)`. Tab-Cleanup
  - [ ] 3.11 Alle Page-Methoden nutzen `session_id` aus Task 1 fuer Tab-spezifische CDP-Commands

- [ ] Task 4: Context-Manager-Pattern (AC: #2, #4)
  - [ ] 4.1 `_PageContextManager` Klasse: `__enter__` erstellt Page (neuer Tab), `__exit__` schliesst den Tab (auch bei Exception)
  - [ ] 4.2 `__exit__` muss robust sein: wenn `Target.closeTarget` fehlschlaegt (Tab schon geschlossen), Exception schlucken
  - [ ] 4.3 Tab-Isolation sicherstellen: Page erstellt eigenen Tab via `Target.createTarget`, operiert nur auf eigenem `sessionId`

- [ ] Task 5: __init__.py aktualisieren (AC: alle)
  - [ ] 5.1 `python/silbercuechrome/__init__.py` erweitern: `Chrome` und `Page` exportieren (zusaetzlich zu `CdpClient`)
  - [ ] 5.2 `__all__` aktualisieren: `["CdpClient", "Chrome", "Page"]`

- [ ] Task 6: Tests (AC: #1, #2, #3, #4)
  - [ ] 6.1 `python/tests/test_chrome.py` erstellen
  - [ ] 6.2 Unit-Test: Chrome.connect() erstellt CdpClient mit Browser-Level-WebSocket
  - [ ] 6.3 Unit-Test: Chrome als Context Manager schliesst Verbindung bei Exit
  - [ ] 6.4 Unit-Test: chrome.new_page() erstellt neuen Tab via Target.createTarget und attached via Target.attachToTarget
  - [ ] 6.5 `python/tests/test_page.py` erstellen
  - [ ] 6.6 Unit-Test: Page.navigate() sendet Page.navigate + Page.enable und wartet auf loadEventFired
  - [ ] 6.7 Unit-Test: Page.click() sendet Runtime.evaluate (querySelector) + Input.dispatchMouseEvent
  - [ ] 6.8 Unit-Test: Page.fill() iteriert ueber dict-Eintraege, fokussiert und tippt jeden Wert
  - [ ] 6.9 Unit-Test: Page.type() fokussiert Element und sendet Input.dispatchKeyEvent pro Zeichen
  - [ ] 6.10 Unit-Test: Page.wait_for() pollt Runtime.evaluate bis truthy oder Timeout
  - [ ] 6.11 Unit-Test: Page.evaluate() sendet Runtime.evaluate und gibt Ergebnis zurueck
  - [ ] 6.12 Unit-Test: Page.close() sendet Target.closeTarget
  - [ ] 6.13 Unit-Test: Context Manager schliesst Tab bei normalem Exit UND bei Exception
  - [ ] 6.14 Unit-Test: session_id wird bei allen Tab-Commands korrekt mitgesendet
  - [ ] 6.15 Integrations-Test (markiert als slow/skip-ci): Vollstaendiger Workflow — Chrome.connect → new_page → navigate → evaluate → close

## Dev Notes

### Kontext und Architektur

Story 9.3 baut auf Story 9.2 (CdpClient) auf und implementiert die zwei hoeheren Abstraktionsschichten: `Chrome` (Verbindung zum Browser) und `Page` (Tab-Interaktion). Zusammen bilden sie die oeffentliche API die Python-Developer nutzen:

```python
from silbercuechrome import Chrome

with Chrome.connect(port=9222) as chrome:
    with chrome.new_page() as page:
        page.navigate("https://example.com")
        page.click("button#submit")
        result = page.evaluate("document.title")
```

[Source: _bmad-output/planning-artifacts/prd.md#Journey 5 (Tomek)]

**Architektur-Schichtung:**
- `CdpClient` (Story 9.2, bereits implementiert) — Low-Level WebSocket + JSON-RPC
- `Chrome` (diese Story) — Browser-Level: connect, new_page, close
- `Page` (diese Story) — Tab-Level: navigate, click, fill, type, wait_for, evaluate, download

**Abhaengigkeit zu Story 9.1:** Das `--script` CLI-Flag ist bereits implementiert (Commit `753a28e`). Der MCP-Server filtert extern erstellte Tabs aus seinem Tracking. Die Python-API kann bedenkenlos Tabs erstellen.

### KRITISCH: session_id-Routing in CdpClient nachrüsten

Die aktuelle `CdpClient.send()` hat KEINEN `session_id`-Parameter. Story 9.2 Dev Notes erwaehnten dies als architektonische Entscheidung ("Multiplexing ueber Target.attachToTarget(flatten:true)"), aber es wurde noch nicht implementiert. **Task 1 muss dies nachrüsten** bevor Page-Methoden funktionieren koennen.

Das Multiplexing funktioniert so:
1. Browser-Level-WebSocket zu `ws://localhost:9222/devtools/browser/UUID`
2. `Target.createTarget(url="about:blank")` → neuer Tab, liefert `targetId`
3. `Target.attachToTarget(targetId, flatten=True)` → liefert `sessionId`
4. Alle Tab-Commands muessen `"sessionId": "..."` im Request-JSON enthalten
5. Events mit `sessionId` muessen korrekt dispatcht werden

[Source: _bmad-output/implementation-artifacts/9-2-python-cdp-client.md#Session-Routing fuer Tab-Commands]

### CDP-Commands fuer Page-Methoden

Referenz aus dem bestehenden Node.js-Server:

**navigate(url):**
```
Page.enable → Page.navigate(url=url) → warten auf Page.loadEventFired
```
Timeout noetig: Seiten die nie "load" feuern (z.B. Long-Polling) muessen nach Default 30s abbrechen.

**click(selector):**
```
Runtime.evaluate(expression="(() => { const el = document.querySelector('selector'); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()")
→ Input.dispatchMouseEvent(type="mousePressed", x, y, button="left", clickCount=1)
→ Input.dispatchMouseEvent(type="mouseReleased", x, y, button="left", clickCount=1)
```
[Source: src/tools/click.ts — Ref-Aufloesung + dispatchMouseEvent Pattern]

**fill(fields) und type(selector, text):**
```
Runtime.evaluate(expression="document.querySelector('selector').focus()")
Runtime.evaluate(expression="document.querySelector('selector').select()")  // select all
Input.dispatchKeyEvent(type="keyDown", key="Backspace") // clear
→ Fuer jedes Zeichen: Input.dispatchKeyEvent(type="keyDown", text=char, key=char)
→ Input.dispatchKeyEvent(type="keyUp", key=char)
```
[Source: src/tools/type.ts — Focus + Key-Event Pattern]

**wait_for(condition):**
```
Loop alle 100ms: Runtime.evaluate(expression=condition)
→ Wenn truthy: return
→ Wenn Timeout erreicht: TimeoutError werfen
```
Spezialfall `"text=Dashboard"`: wird zu `document.body.innerText.includes("Dashboard")` uebersetzt.
[Source: src/tools/wait-for.ts — Polling-Pattern]

**evaluate(js):**
```
Runtime.evaluate(expression=js, returnByValue=True)
```
`returnByValue: True` sorgt dafuer dass JSON-serialisierbare Ergebnisse direkt zurueckkommen statt als RemoteObject-Referenz.

### Synchrone API: Event-Loop-Management

Die oeffentliche API muss synchron sein (kein `await`, kein `async with`). Intern laeuft alles ueber asyncio. Das Wrapping-Pattern:

```python
import asyncio
import threading

class Chrome:
    def __init__(self, client: CdpClient, loop: asyncio.AbstractEventLoop, thread: threading.Thread):
        self._client = client
        self._loop = loop
        self._thread = thread

    def _run(self, coro):
        """Run an async coroutine from sync context."""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=60)

    @classmethod
    def connect(cls, host="localhost", port=9222):
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        future = asyncio.run_coroutine_threadsafe(
            CdpClient.connect(host, port), loop
        )
        client = future.result(timeout=10)
        return cls(client, loop, thread)
```

**Warum Daemon-Thread statt asyncio.run():** `asyncio.run()` erstellt jedes Mal einen neuen Event-Loop und kann nicht in einem bereits laufenden Loop aufgerufen werden (z.B. in Jupyter Notebook). Der Daemon-Thread-Ansatz funktioniert ueberall.

[Source: _bmad-output/implementation-artifacts/9-2-python-cdp-client.md#Synchrone API]

### Bestehende Code-Patterns (aus Story 9.2)

**Python-Projekt-Konventionen:**
- Type Hints: PEP 484, alle oeffentlichen Methoden annotiert
- Docstrings fuer alle oeffentlichen Klassen und Methoden
- ruff als Formatter/Linter (target-version: py310, line-length: 100)
- Tests: pytest in `python/tests/`, Naming `test_*.py`
- Async-Tests: pytest-asyncio mit `asyncio_mode = "auto"` in pyproject.toml

**Test-Pattern aus Story 9.2:**
- FakeWebSocket in `python/tests/conftest.py` — simuliert websockets async Iterator
- `make_client(fake_ws)` Helper erstellt CdpClient mit injiziertem FakeWebSocket
- CDP-Responses werden via `fake_ws.inject_response({"id": N, "result": {...}})` simuliert
- Tests gruppiert in Klassen: `TestCdpClientSend`, `TestCdpClientEvents`, etc.

Fuer Chrome/Page-Tests: Den `CdpClient` mocken (nicht den WebSocket direkt). Chrome.connect() soll mit einem Fake-CdpClient getestet werden der voraufgezeichnete CDP-Responses liefert.

### Dateien die erstellt werden

1. **`python/silbercuechrome/chrome.py`** — Chrome-Klasse (connect, new_page, close, Context Manager)
2. **`python/silbercuechrome/page.py`** — Page-Klasse (navigate, click, fill, type, wait_for, evaluate, download, close)
3. **`python/tests/test_chrome.py`** — Chrome Unit-Tests
4. **`python/tests/test_page.py`** — Page Unit-Tests

**Dateien die geaendert werden:**

5. **`python/silbercuechrome/cdp.py`** — session_id-Parameter in send(), sessionId-Routing in Events
6. **`python/silbercuechrome/__init__.py`** — Chrome und Page exportieren
7. **`python/tests/test_cdp.py`** — Tests fuer session_id-Erweiterung

**Keine Aenderungen an Node.js-Dateien. Keine neuen Dependencies.**

### Risiken und Edge Cases

1. **Event-Loop-Wiederverwendung in Jupyter:** `asyncio.run()` scheitert wenn ein Loop bereits laeuft. Loesung: Daemon-Thread mit eigenem Loop (Task 2.3). Muss in Tests verifiziert werden.
2. **Tab-Cleanup bei Exception:** `__exit__` im Context Manager muss `Target.closeTarget` aufrufen, auch bei unhandled Exceptions. Wenn closeTarget selbst fehlschlaegt (Tab schon weg), die Exception schlucken.
3. **Navigation-Race:** `Page.navigate()` + Warten auf `Page.loadEventFired` kann rasen: Event kann ankommen bevor wir den Listener registriert haben. Loesung: Listener VOR `Page.navigate` registrieren.
4. **Selector-Fehler:** `querySelector` kann `null` zurueckgeben wenn das Element nicht existiert. Alle Methoden die querySelector nutzen (click, fill, type) muessen das pruefen und eine klare Exception werfen.
5. **wait_for Timeout:** Polling alle 100ms fuer max 30s. Bei Timeout muss ein klarer `TimeoutError` mit der Condition im Text geworfen werden.
6. **Grosse evaluate-Ergebnisse:** `Runtime.evaluate` mit `returnByValue: True` kann bei grossen Objekten zu grossen Payloads fuehren. websockets handelt das intern (max_size 64MB in CdpClient), aber der Developer sollte gewarnt werden.
7. **Thread-Safety der sync-Wrapper:** `_run()` nutzt `run_coroutine_threadsafe` — das ist thread-safe by design. Aber: der CdpClient darf nie von zwei Threads gleichzeitig `send()` aufgerufen bekommen. `run_coroutine_threadsafe` serialisiert das ueber den Event-Loop.
8. **close() nach close():** Doppeltes close() auf Chrome oder Page darf keinen Fehler werfen. Idempotent implementieren.

### Previous Story Intelligence (Story 9.2)

Aus Story 9.2 (Python CDP Client):
- CdpClient ist async-only — send(), connect(), close() sind alle async. Die sync-Wrapper muessen in Chrome/Page implementiert werden, nicht im CdpClient selbst
- CdpClient hat KEINEN session_id Parameter — muss in Task 1 nachgeruestet werden
- FakeWebSocket Pattern in conftest.py funktioniert gut fuer Unit-Tests
- pyproject.toml nutzt hatchling als Build-Backend (nicht setuptools wie im Story 9.2 Dev Notes stand — die tatsaechliche Implementierung nutzt hatchling)
- websockets Version ist >=14.0 (nicht >=12.0 wie in Story 9.2 Dev Notes)
- Event-Loop-Management wurde im CdpClient bewusst async gehalten — die sync-Entscheidung faellt in dieser Story

Aus Story 9.1 (--script CLI-Mode):
- `--script` ist implementiert (Commit `753a28e`)
- MCP-owned-Tab-Tracking filtert extern erstellte Tabs aus
- Port 9222 ist immer offen — kein spezielles Setup noetig
- Chrome erlaubt mehrere CDP-Clients gleichzeitig

### Git Intelligence

Relevante Commits:
- `753a28e` feat(story-9.1): --script CLI-Mode — MCP-Server toleriert externe CDP-Clients
- `f54f7ec` docs(story-8.2): CHANGELOG erweitert — v1.0 ist aktueller Stand
- `8bdb477` chore: bump version to v1.0.0 — Python-Package-Version synchron (1.0.0)
- `294fc72` feat(story-22.3): --attach CLI mode — Pattern-Referenz fuer CLI-Flag-Handling

### Project Structure Notes

- Neue Dateien in `python/silbercuechrome/` (chrome.py, page.py) — konsistent mit bestehendem Package-Layout
- Neue Test-Dateien in `python/tests/` (test_chrome.py, test_page.py) — konsistent mit test_cdp.py
- Kein Konflikt mit Node.js-Projektstruktur
- Alignment mit Architecture-Dokument: `python/silbercuechrome/` Verzeichnisstruktur stimmt exakt ueberein mit der Architektur-Spezifikation

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.3] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/architecture.md#Script API & CDP-Koexistenz] — Architektur-Entscheidung, Distribution, Boundary 6
- [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] — python/ Verzeichnisstruktur
- [Source: _bmad-output/planning-artifacts/prd.md#FR36-FR38] — Tab-Isolation, Context-Manager-Pattern, Methoden
- [Source: _bmad-output/planning-artifacts/prd.md#Journey 5 (Tomek)] — Zielgruppe, Use Case, Beispiel-Code
- [Source: _bmad-output/planning-artifacts/prd.md#NFR19] — CDP-Koexistenz
- [Source: _bmad-output/implementation-artifacts/9-2-python-cdp-client.md] — CdpClient-Implementierung, Session-Routing-Architektur
- [Source: _bmad-output/implementation-artifacts/9-1-script-cli-mode-server-seite.md] — MCP-owned-Tab-Tracking, Tab-Isolation
- [Source: python/silbercuechrome/cdp.py] — Bestehender CdpClient (async, kein session_id)
- [Source: python/tests/conftest.py] — FakeWebSocket Test-Infrastruktur
- [Source: src/tools/click.ts] — CDP-Pattern fuer Element-Click (querySelector + dispatchMouseEvent)
- [Source: src/tools/type.ts] — CDP-Pattern fuer Texteingabe (focus + dispatchKeyEvent)
- [Source: src/tools/wait-for.ts] — CDP-Pattern fuer Condition-Polling

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
