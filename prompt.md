# eine persönliche Datei
## Claude Code
claude --dangerously-skip-permissions

## BMAD Orchestrator
Du bist ein 10x Software Ingenieur der mit der BMAD Methode arbeitet und eine vollständige Feature Implementierung des SilbercueChrome MCP bis inklusive $ARGUMENTS überwacht. Lies dir kurz die PRD durch.

Gehe wie folgt vor und öffne sequentiell für jeden Agent einen eigenen Prozess (Opus 4.6 / High), den du kompetent aber auf minimale Weise überwachst:

*Orientierung-Agent*
/bmad-help, um dir ein überblick über den aktuellen Stand der Implementierung zu machen. Du muss selbst keinen großen Überlick machen - Spare deine Token.

*Story-Agent* 
"/bmad-create-story {1}" um die nächste Story zu entwickeln. ersetze {1} dabei NUR mit der aktuell zu entwickelnden Story (zb 2.1) - keine großen prompts. /bmad-create-story, ist so aufgebaut, dass sie alle notwendigen Informationen in der Dokumentation selbstständig finden. 

*Implementierung-Agent*
"/bmad-dev-story {2}", um die entwickelte Story zu implementieren. Auch hier {3} mit der zu entwickelnden Story ersetzen (zb 2.1). Wenn der Agent sagt, dass er fertig ist fordere mit einem sehr kurzen Propmt auf mit /codexReviewer seine Implementierung zu überprüfen (zb reviewe Implementierung mit codesReviewer). Wenn er meldet, dass der Review fertig ist, soll er auch gleich die Findings fixen (schreibe zum zb "fixe deine Findings H1, H3" - entscheide dabei selbständig, welche er davon fixen muss - meistens macht er dir Vorschläge). Nach Fix soll er die Story auf "done" setzen und  anschließend commiten. Damit ist der Implementierungs-Agent Zyklus abgeschlossen. Lass den Agent alles selbst machen. Steuere in nur mit einfachen Anweisungen

Führe *Story-Agent* und *Implementierung-Agent* immer weiter fort, bis ein Epic abgeschlossen ist. Anschließend teste das abschgeschlossene Epic auf sinnvolle Weise und korrogiere eventuelle Fehler. Gehe dann weiter zum nächsten Story aus der nächsten Epic.

Führe den ganzen Vorgang selbständig weiter OHNE zu stoppen oder anzuhalten bis du die ganze $ARGUMENTS implemenitert hast. Du steuerst nur - weise die Vorgänge jeweils mit kurzen Prompts an. Überspringe niemals die codexReviewer nach Implementierung.

Stelle nur dann Rückfragen, wenn es wirklich notwendig ist.  


## Bugs - SilbercueChrome
- Bei dropdown (Filter) wird nicht gedrückt wenn aus wahl getroffen wird - so bleibt die Dropdown Auswahl weiter sichtbar und kein Effekt - Beleg Seite.









## Feature anfragen: 
prompt: dieser MCP soll ja mit dir perfekt zusammenarbeiten und meine Frage ist, wie  
könnte er noch besser sein um dir das zu ermöglichen würde wäre es schon getan  mit inspect_element? Gib dem Developer Team eine Hintergrund Story und eine     Tool Anfrage Feature Anfrage, die den Kontext aufbereitet, damit sie verstehen,  um was es geht. 

### Feature Request: inspect_element Tool für SilbercueChrome MCP                 
                                                                                
  Hintergrund: Was passiert ist                
                                                                                
  Ein AI-Agent (Claude Code) nutzt SilbercueChrome MCP um eine Web-App zu       
  debuggen. Der User meldet: "Die Empfänger-Spalte ist zentriert statt links
  ausgerichtet."                                                                
                               
  Der Agent hat folgende Tools zur Verfügung: screenshot, read_page, evaluate,  
  dom_snapshot.                                
                                                                                
  Was dann passierte — 45 Minuten CSS-Debugging:                                
                                      
  1. Screenshot zeigt: Ja, Text sieht zentriert aus. Agent ändert CSS           
  (text-align: left, justify-content: flex-start).
  2. Screenshot nach Fix: Sieht identisch aus. Agent ist ratlos — die           
  CSS-Änderung müsste greifen.                                                  
  3. Agent schreibt manuell JS in evaluate:
  const cell = document.querySelector('.beleg-name-cell');                      
  const s = window.getComputedStyle(cell);                                      
  JSON.stringify({ justifyContent: s.justifyContent, textAlign: s.textAlign })  
  3. Ergebnis: justify-content: flex-start ist korrekt gesetzt. Also liegt das  
  Problem woanders.                                                             
  4. Agent schreibt weiteres JS um getBoundingClientRect() zu vergleichen — Span
   startet 39px vom Zellenrand statt 6px. Beweis, dass ein anderer Mechanismus  
  die Position beeinflusst.           
  5. Agent schreibt JS um die Parent-Chain abzufragen — findet text-align:      
  center geerbt von .App. Fixt das. Hilft aber immer noch nicht vollständig.    
  6. Agent schreibt JS um flexDirection zu prüfen — findet column statt row.
  Aber woher kommt das?                                                         
  7. Agent schreibt JS um alle CSS-Regeln im Dokument zu durchsuchen:
  for (const sheet of document.styleSheets) {                                   
    for (const rule of sheet.cssRules) {                                        
      if (rule.style?.flexDirection && cell.matches(rule.selectorText)) {       
        // gefunden!                                                            
      }                               
    }                                                                           
  }                                                                             
  7. Endlich: .beleg-name-cell bekommt flex-direction: column von einer anderen 
  CSS-Datei (BelegAuswahlModal.css), nicht von der erwarteten BelegeManager.css.
                               
  Das Kernproblem: Der Agent musste 4 separate evaluate-Aufrufe mit             
  handgeschriebenem JS-Code machen, um schrittweise dem Bug auf die Spur zu
  kommen. Jeder Aufruf war ein eigener Roundtrip mit Trial-and-Error. Der Agent 
  wusste nicht im Voraus, welche CSS-Properties relevant sind, und musste sich
  manuell durch die Kaskade arbeiten. 
                                               
  Was ein inspect_element Tool lösen würde                                      
   
  Ein einziger Tool-Aufruf statt 4+ evaluate-Roundtrips:                        
                               
  inspect_element(selector: ".beleg-name-cell")                                 
                                                                                
  Erwartete Rückgabe:                 
                                                                                
  {                            
    "element": {                      
      "tag": "div",                                                             
      "classes": ["beleg-cell", "beleg-name-cell"],
      "boundingRect": { "x": 181, "y": 389, "width": 266, "height": 50 }        
    },                                                                          
    "computedStyles": {               
      "display": "flex",                                                        
      "flexDirection": "column",
      "justifyContent": "normal",     
      "alignItems": "center",                  
      "textAlign": "left",
      "overflow": "hidden"                                                      
    },
    "matchingRules": [                                                          
      {                        
        "selector": ".belege-manager .beleg-cell",
        "source": "BelegeManager.css:272",                                      
        "properties": { "display": "flex", "align-items": "center", "padding":  
  "2px 6px" }                                                                   
      },                                                                        
      {                                                                         
        "selector": ".beleg-name-cell",        
        "source": "BelegAuswahlModal.css:183", 
        "properties": { "display": "flex", "flex-direction": "column", "gap":
  "6px" }                                                                       
      },
      {                                                                         
        "selector": ".beleg-name-cell",
        "source": "BelegeManager.css:304",
        "properties": { "overflow": "hidden", "text-overflow": "ellipsis" }     
      }
    ],                                                                          
    "inheritedStyles": {       
      "textAlign": { "value": "center", "from": ".App" },
      "fontFamily": { "value": "-apple-system, ...", "from": ".beleg-row" }     
    },                                                                          
    "children": [                                                               
      {                                                                         
        "tag": "span",                
        "classes": ["beleg-empfaenger"],                                        
        "text": "Google Commerce Limited",     
        "boundingRect": { "x": 220, "y": 391, "width": 186, "height": 15 }      
      }                                                                         
    ]                                 
  }                                                                             
                               
  Warum die einzelnen Felder wichtig sind                                       
                                               
  Feld: computedStyles                                                          
  Warum der Agent es braucht: Zeigt den tatsächlichen Zustand — nicht was im CSS
                                                                                
    steht, sondern was der Browser anwendet. Der Agent sieht sofort           
    flexDirection: column und weiß, dass etwas nicht stimmt.                  
  ────────────────────────────────────────                                      
  Feld: matchingRules mit Source-Datei                                        
  Warum der Agent es braucht: Das ist der entscheidende Unterschied zu          
    getComputedStyle(). Der Agent sieht sofort: "column kommt aus
    BelegAuswahlModal.css, nicht aus BelegeManager.css" — das                   
    CSS-Konflikt-Problem ist in Sekunden gelöst statt in 20 Minuten.
  ────────────────────────────────────────                                      
  Feld: inheritedStyles mit Herkunft                                            
  Warum der Agent es braucht: Zeigt geerbte Werte und woher sie kommen. Agent
    sieht sofort text-align: center von .App — keine Parent-Chain-Abfrage nötig.
  ────────────────────────────────────────
  Feld: children mit boundingRect                                               
  Warum der Agent es braucht: Agent kann Positionsabweichungen erkennen: "Span
    startet bei x=220 aber Cell bei x=181 — 39px Offset, da stimmt was nicht."  
                               
  Design-Überlegungen                 
                                               
  Parameter:                                                                    
  - selector (CSS-Selektor) oder ref (A11y-Tree Ref) — konsistent mit den
  anderen Tools                                                                 
  - styles (optional): Array von interessierenden Properties, z.B. ["display", 
  "flex*", "text-align", "position"]. Default: Layout-relevante Properties      
  (display, flex*, grid*, position, text-align, overflow, width, height, margin,
   padding)                                                                     
  - include_children (optional, default: true): Ob direkte Kinder mit ausgegeben
   werden                                                                       
  - include_rules (optional, default: true): Ob matchende CSS-Regeln aufgelistet
   werden                                                                       
                                                                                
  Zum Source-Pfad in matchingRules: Der Browser kennt die Source über
  CSSRule.parentStyleSheet.href bzw. bei inline-Styles über das ownerNode. Bei  
  Webpack/Vite Bundles sind das oft gemappte Dateinamen — auch die sind
  hilfreich, weil der Agent nach dem Dateinamen im Repo suchen kann.            
                               
  Token-Budget: Die Ausgabe sollte kompakt sein. Nicht alle 300+ computed styles
   ausgeben, sondern nur die Layout-relevanten (oder die per styles-Parameter
  angefragten). Die matchingRules sollten nur Properties enthalten, die         
  tatsächlich gesetzt werden (nicht den gesamten Rule-Block).
                                      
  Zusammenfassung                                                               
   
  ┌───────────────────────────────────────────┬─────────────────────────────┐   
  │                   Heute                   │     Mit inspect_element     │
  ├───────────────────────────────────────────┼─────────────────────────────┤
  │ 4 evaluate-Aufrufe, handgeschriebenes JS  │ 1 Tool-Aufruf               │
  ├───────────────────────────────────────────┼─────────────────────────────┤
  │ Trial-and-Error: "Ist es text-align?      │ Alle relevanten Werte auf   │   
  │ justify-content? flex-direction?"         │ einen Blick                 │   
  ├───────────────────────────────────────────┼─────────────────────────────┤   
  │ CSS-Konflikt zwischen Dateien nicht       │ matchingRules zeigt sofort  │   
  │ auffindbar ohne document.styleSheets      │ welche Datei überschreibt   │   
  │ Iteration                                 │                             │
  ├───────────────────────────────────────────┼─────────────────────────────┤   
  │ ~20 Minuten bis zur Root Cause            │ ~30 Sekunden                │
  └───────────────────────────────────────────┴─────────────────────────────┘

### Feature Request: Visual Feedback after Code Edits                             
                                               
  Killer Feature: "Visual Feedback"                                             
                                                                                
  Problem                                                                       
                               
  Wenn ein LLM (Claude, GPT, etc.) CSS/TSX/HTML-Dateien in einem Web-Projekt mit
   Hot Reload editiert, hat es kein visuelles Feedback, dass die Änderung
  korrekt übernommen wurde. Das führt zu einem teuren Round-Trip-Pattern:       
                               
  1. CSS-Datei editieren                                                        
  2. Zur Hauptseite navigieren (um frische Element-Refs zu bekommen)
  3. Seite lesen (um klickbare Refs zu erhalten)                                
  4. Zur relevanten View durchklicken                                           
  5. Screenshot machen um zu verifizieren                                       
                                                                                
  Ein Mensch würde einfach auf den Browser schauen — Hot Reload aktualisiert    
  sofort. Das LLM hat diesen "Blick" nicht und kompensiert mit 4-5 unnötigen
  Tool-Calls pro Edit.                                                          
                                               
  ---                                 
  Lösungsansätze (aufsteigend nach Aufwand)    
                                                                                
  Tier 1 — Instruktion (0 Aufwand)
  CLAUDE.md-Eintrag: "Nach CSS/TSX-Änderungen direkt screenshot aufrufen, nie   
  navigieren." Löst 80%, aber LLMs vergessen es.                                
                                                                                
  Tier 2 — PostToolUse Hook + Voll-Screenshot                                   
  - Hook triggert nach Edit/Write auf Frontend-Dateien (.css, .tsx, .jsx)
  - Führt ein Script aus, das per Chrome DevTools Protocol (CDP                 
  Page.captureScreenshot an localhost:9222) einen Screenshot macht
  - Screenshot-Pfad landet im Hook-Output → LLM sieht das Ergebnis ohne         
  nachzufragen                                                         
  - Nachteil: Immer Vollbild, auch wenn nur ein kleiner Bereich betroffen ist   
                                                                             
  Tier 3 — Gezielter Screenshot der geänderten Stelle                           
  - Hook parst den CSS-Selektor aus dem Diff (z.B. .beleg-name-cell)            
  - Fragt Chrome:                                                               
  document.querySelector('.beleg-name-cell').getBoundingClientRect()            
  - CDP Page.captureScreenshot mit clip-Parameter — nur die betroffene Region   
  - LLM bekommt einen Ausschnitt genau der Stelle die sich geändert hat      
                                                                                
  Tier 4 — Killer Feature: Visueller Diff                                       
  - Vor dem Edit: Screenshot leise cachen                                       
  - Nach Hot Reload: zweiten Screenshot machen                                  
  - Pixel-Diff berechnen → nur die veränderte Region zurückgeben                
  - Framework-agnostisch, funktioniert bei CSS und JSX                          
  - Zeigt dem LLM exakt was sich verändert hat — so wie ein Mensch es sieht
                                                                                
  ---                                                                           
  Ergänzung: MCP-Push für Browser-seitige Änderungen                            
                                                                                
  Die Hook-Lösung deckt nur LLM-initiierte Änderungen ab. Für Fälle wo sich die
  Seite von selbst ändert (API-Response kommt zurück, Button erscheint, Timer   
  läuft ab):                                   
  - MCP-Server beobachtet DOM via MutationObserver                              
  - Bei signifikanter DOM-Änderung: Screenshot automatisch cachen               
  - tab_status gibt dom_changed: true Flag zurück                
  - Webpack HMR loggt [HMR] Updated modules: in die Console — MCP könnte darauf 
  reagieren                    
                                                                                
  ---                                          
  Warum das wichtig ist                                                         
                               
  - Token-Ersparnis: 4-5 Tool-Calls pro Verifikation eliminiert
  - Geschwindigkeit: Verifikation wird instant statt Multi-Step                 
  - Genauigkeit: LLM sieht sofort ob eine CSS-Änderung funktioniert oder ein    
  Konflikt vorliegt                                                             
  - Universell: Jedes LLM das mit Browser-Frontends arbeitet profitiert davon   
                                                                                 
  Praxis-Beispiel                              
                                                                                
  Heutige Session: .beleg-name-cell CSS-Alignment fixen. Text war zentriert     
  wegen eines flex-direction: column Konflikts aus einer anderen CSS-Datei. Es
  brauchte ~8 Round-Trips zur Diagnose, weil jede Verifikation eine komplette   
  Seitennavigation erforderte. Mit Visual Feedback wären es 2-3 Edits mit
  sofortigem Ergebnis gewesen. 

	So könnte die LLM schnell Iterieren, denn sie sehen, dass die Seite nicht refresh werden muss theoretisch möglich, Visuelle Bestätigung und auch Nachbesserung.



## Prompt für Verbesserungen
###  Verbinde dich mit Session 9254a969-1fcb-4203-9fae-12679ce7363e das ist eine Session, in der wir mit der aktuellen Version des SilbercueChrome MCP unseren Testparcour (http://localhost:4242/) durchlauden haben. wir versuchen den MTC so anzupassen, dass er perfekt mit einem LLM zusammenarbeitet. Schau dir den gesamten Testverlauf an und finde Fictions Points, an denen wir die Zusammenarbeit zwischen   
LLM und MCP verbessern können. Immer mit der Premissie, dass der MCP so eingestellt sein muss, dass das LLM sich sofort auskennt. Wir müssen nicht das LLM dazu bringen, den MCP richtig zu bedienen. Umgekehrt. Wir müssen schauen, wo das LLM Umwege gemacht hat, beziehungsweise nicht sofort weitergekommen ist und noch mal einen anderen Weg gesucht hat finde solche Fractions und Liste sicher auf.


