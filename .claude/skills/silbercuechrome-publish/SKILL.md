---
name: silbercuechrome-publish
description: Release-Skill fuer SilbercueChrome. Prueft beide Repos (public Free + private Pro), bumpt die Version, baut + testet, dry-run, dann npm publish + GitHub Release ueber scripts/publish.ts. Trigger-Phrasen: "publish", "release", "veroeffentlichen", "neues release", "version pushen", "deploy", "npm publish", "auf npm bringen", "rausbringen", "an die endkunden bringen"
---

# SilbercueChrome Publish

Release-Skill fuer das SilbercueChrome Open-Core-Projekt: bringt den lokalen Stand als neue Version zu den Endkunden ueber `npx @silbercue/chrome@latest`.

## Architektur

Zwei separate GitHub-Repos bilden zusammen das Distribution-Bundle:

| Repo | Pfad | GitHub | npm-Paket |
|------|------|--------|-----------|
| **Public (Free)** | `/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome` | `Silbercue/silbercuechrome` | `@silbercue/chrome` |
| **Private (Pro)** | `/Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro` | `Silbercue/SilbercueChromePro` | `silbercuechrome-pro` (intern, npm published) |

Anders als SilbercueSwift wird hier **nicht** ueber GitHub Actions / Tag-Push getriggert, sondern direkt ueber das lokale Pipeline-Script `scripts/publish.ts` (`npm run publish:release`). Das macht in einem Rutsch: Push beider Repos → Build + Tests → Tag → `npm publish` → `gh release create` → Verify.

## Voraussetzung

Wenn der User "publish" sagt, ist alles getestet und bereit. Frag NICHT nach "hast du alles getestet?" — das nervt nur. Starte direkt in Phase 1.

Hintergrund fuer den Endstatus: Waehrend der Entwicklung zeigt `~/.claude.json` oft auf einen lokalen Build (`node /Users/.../build/index.js`). Nach dem erfolgreichen Release setzt dieser Skill die Config **automatisch** zurueck auf das npm-Paket — siehe Phase 7b. Der User soll am Ende immer auf derselben Version sitzen, die auch die Endkunden per `npx @silbercue/chrome@latest` ziehen.

## Ablauf — 7 Phasen

Fuehre ALLE Phasen der Reihe nach aus. Ueberspringe keine Phase.

### Phase 1: Status beider Repos pruefen

```bash
# Free Repo
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
echo "=== FREE REPO ==="
git status --short
git log --oneline -5
git tag --sort=-v:refname | head -5
node -p "require('./package.json').version"

# Pro Repo
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
echo "=== PRO REPO ==="
git status --short
git log --oneline -5
git log origin/master..HEAD --oneline  # ungepushte Commits
node -p "require('./package.json').version"
```

**Pruefe:**
- Working tree beider Repos sauber? (akzeptable Ignorables im Free-Repo: `prompt.md`, `marketing/`)
- Beide auf Branch `master`?
- Versionen in beiden `package.json` gleich?
- npm authentifiziert? `npm whoami`
- gh CLI authentifiziert? `gh auth status`

Zeige dem User eine Kurz-Zusammenfassung:
```
FREE: [clean/dirty] | vX.Y.Z | N ungepushte Commits
PRO:  [clean/dirty] | vX.Y.Z | N ungepushte Commits
npm:  ok / NICHT EINGELOGGT
gh:   ok / NICHT AUTH
```

Wenn etwas klemmt: STOPP, gemeinsam mit User fixen.

### Phase 2: Aenderungen committen und pushen

Falls einer der Repos uncommitted Changes hat: vorher mit dem User klaeren ob die ins Release sollen oder nicht. Wenn ja → committen. Wenn nein → ggf. stashen oder erst in einem separaten Schritt rausnehmen.

`scripts/publish.ts` pusht in Phase 2 selbst — du musst hier nichts manuell pushen. Nur sicherstellen dass alles committed ist.

```bash
# Falls Free-Repo dirty:
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
git add <files>
git commit -m "<message>"

# Falls Pro-Repo dirty:
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
git add <files>
git commit -m "<message>"
```

### Phase 3: Version bestimmen

Lese den letzten Tag und schlage eine neue Version vor:

```bash
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
git tag --sort=-v:refname | head -1
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
```

**Versionsregeln (SemVer):**
- **Patch** (0.2.0 → 0.2.1): Bug-Fixes, kein Verhaltenswechsel fuer User
- **Minor** (0.2.0 → 0.3.0): Neue Features oder spuerbare Verhaltensaenderung, API rueckwaertskompatibel
- **Major** (0.2.0 → 1.0.0): Breaking Changes in der API

Schlage dem User die passende Version vor basierend auf den Commits seit dem letzten Tag. Heuristik:
- Nur `fix:` → patch
- `feat:` oder `refactor:` mit Verhaltensaenderung → minor
- `BREAKING CHANGE` im Commit-Body → major

Warte auf Bestaetigung vom User.

### Phase 4: package.json in beiden Repos updaten + committen

NICHT `npm version` benutzen — das macht automatisch git tag, was wir scripts/publish.ts ueberlassen. Stattdessen direkt die JSON-Datei rewrites:

```bash
# Free-Repo
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
python3 -c "
import json
with open('package.json') as f: d = json.load(f)
d['version'] = '<NEW_VERSION>'
with open('package.json', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
"
git add package.json
git commit -m "chore: bump version to v<NEW_VERSION>"

# Pro-Repo (Versionen MUESSEN matchen — publish.ts faellt sonst hart)
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
python3 -c "
import json
with open('package.json') as f: d = json.load(f)
d['version'] = '<NEW_VERSION>'
with open('package.json', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
"
git add package.json
git commit -m "chore: bump version to v<NEW_VERSION>"
```

Nicht pushen — `publish.ts` macht das in Phase 2 selbst.

### Phase 5: Dry-Run

```bash
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
npm run publish:release -- --dry-run
```

Lies den Output sorgfaeltig. Erwartet:
- **Phase 1:** `Repo status OK (vX.Y.Z)`
- **Phase 2:** `repo: N commit(s) ahead` und `[DRY-RUN] Would push ...`
- **Phase 3:** Build + Tests echt durchgelaufen, alle gruen. Fuer Pro-Repo: `npm install`, `npm run build`, `npm pack` simuliert.
- **Phase 4:** Tag-Erstellung simuliert
- **Phase 5:** `[DRY-RUN] Would publish to npm: @silbercue/chrome@X.Y.Z` und `[DRY-RUN] Would create GitHub release vX.Y.Z`
- **Phase 6:** Verify-Schritt simuliert

Wenn irgendwas im Dry-Run scheitert: STOPP, mit User fixen, dann nochmal Dry-Run.

### Phase 5b: User-Konfirmation

Zeig dem User eine kurze Zusammenfassung:
- Welche Version raus geht
- Wieviele Commits seit dem letzten Tag drin sind (`git log $LAST_TAG..HEAD --oneline`)
- Pro-Repo bewegt sich mit
- Naechste Aktion: `npm run publish:release` (echter Publish)

Frage dann konkret: **"Soll ich publishen?"** Warte auf eindeutige Bestaetigung ("ja", "go", "publish", "raus damit"). Bei Unsicherheit: nicht publishen.

### Phase 6: Echter Publish

```bash
cd /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome
npm run publish:release
```

Streame den Output mit. Das Script macht:
1. Phase 1 Sanity-Check
2. Phase 2 Push beider Repos
3. Phase 3 Build + Tests + Pro-Build + npm pack
4. Phase 4 Tag erstellen + pushen
5. Phase 5 `npm publish` + `gh release create`
6. Phase 6 Verify

Wenn Fehler:
- **Phase 1-4:** Meist kein Schaden, fixen und retry
- **Phase 5 mid-stream (npm publish geklappt, gh release nicht):** Paket ist live, nur GitHub Release fehlt. Manuell nachholen: `gh release create vX.Y.Z --generate-notes`
- **Phase 6:** Publish ist durch, nur Verify hat ein Problem. Manuell pruefen mit `npm view @silbercue/chrome version` und `gh release view vX.Y.Z`

### Phase 7: Verifizieren

```bash
npm view @silbercue/chrome version
gh release view v<NEW_VERSION>
git log -1 --format="%H %s"
```

Alle drei sollten konsistent die neue Version zeigen. Wenn nicht: Fehler analysieren, User informieren, ggf. Phase 7b ueberspringen.

### Phase 7b: Auto-Switch `~/.claude.json` auf npm-Version

**Zweck**: Nach einem erfolgreichen Release soll der User auf seinem Rechner auf **derselben** Version sitzen, die auch die Endkunden per `npx @silbercue/chrome@latest` ziehen. Kein lokaler Build mehr, keine Abfrage — einfach machen.

**Ablauf**:

1. Backup der aktuellen Config:
   ```bash
   cp ~/.claude.json ~/.claude.json.backup-$(date +%Y%m%d-%H%M%S)
   ```

2. Pruefe den aktuellen `silbercuechrome` MCP-Eintrag. Typisch sind zwei Varianten:
   - **Lokal (node build)**: `"command": "node", "args": ["/Users/.../build/index.js"]`
   - **npm (npx)**: `"command": "npx", "args": ["-y", "@silbercue/chrome@latest"]`

3. Falls bereits `npx` → nichts zu tun, Phase 7b uebersprungen.

4. Falls `node`-Variante → Eintrag mit Python rewriten (jq wuerde die Reihenfolge kaputt machen, Python bewahrt sie):
   ```bash
   python3 <<'PY'
   import json, pathlib
   p = pathlib.Path.home() / ".claude.json"
   data = json.loads(p.read_text())
   entry = data.get("mcpServers", {}).get("silbercuechrome")
   if entry is None:
       print("No silbercuechrome MCP entry found — skipping.")
       raise SystemExit(0)
   entry["type"] = "stdio"
   entry["command"] = "npx"
   entry["args"] = ["-y", "@silbercue/chrome@latest"]
   entry.setdefault("env", {})
   p.write_text(json.dumps(data, indent=2) + "\n")
   print("Updated ~/.claude.json → npx @silbercue/chrome@latest")
   PY
   ```

5. Bestaetige dem User:
   > "~/.claude.json ist jetzt auf `npx @silbercue/chrome@latest` umgestellt. Beim naechsten Claude-Code-Start oder `/mcp`-Reconnect wird die frische v<NEW_VERSION> von npm gezogen — genau wie bei deinen Kunden."

**Nicht fragen**, einfach machen. Der User hat explizit gesagt: nach Publish IMMER auf die aktuelle npm-Version stellen.

**Wenn der User ausnahmsweise auf dem lokalen Build bleiben will** (z.B. weil er direkt den naechsten Fix angeht): Er muss das aktiv sagen. Default ist Umschalten.

### Phase 7c: User informieren

Sage dem User:
1. **Version live** auf `https://www.npmjs.com/package/@silbercue/chrome`
2. **GitHub Release** auf `https://github.com/Silbercue/silbercuechrome/releases/tag/v<NEW_VERSION>`
3. **Pro-Repo Update** falls relevant
4. **Claude-Code-Config** ist automatisch auf `npx @silbercue/chrome@latest` umgestellt (Backup unter `~/.claude.json.backup-<timestamp>`). Hinweis: `/mcp` im Prompt eintippen um die neue Version sofort zu laden, oder Claude Code neu starten.

## Fehlerbehebung

### "Free repo has uncommitted changes"
`scripts/publish.ts` ist hart bei working-tree status. Akzeptable Ignorables (`prompt.md`, `marketing/`) muessen vorher entweder committed, gestasht oder bewusst entfernt werden — `publish.ts` kennt keine Ausnahmen. Im Zweifel mit dem User klaeren.

### "Version mismatch: free=X.Y.Z, pro=A.B.C"
Pro-Repo hat eine andere Version in `package.json`. Beide muessen exakt matchen. Phase 4 nochmal sauber durchlaufen.

### "npm not authenticated"
```bash
npm login
```
Im interaktiven Terminal-Prompt — der MCP kann das nicht selber machen. User muss es im Terminal tippen. Hinweis: Der User kann `! npm login` direkt im Claude-Code-Prompt eingeben damit es in der Session laeuft.

### "gh CLI not authenticated"
```bash
gh auth login
```
Selber Hinweis wie bei npm.

### npm publish gescheitert mit "EPRIVATE"
Free-Repo `package.json` hat `"private": true`. Auf `false` setzen, committen, retry. (`scripts/publish.ts` hat dafuer einen Hard-Fail in Phase 1.)

### Tests rot in Phase 3
Stoppen. `npm test` lokal ausfuehren, Fehler analysieren, fixen, committen. Dann nochmal von vorne.

### Pro-Repo nicht gefunden
Wenn `../silbercuechrome-pro` nicht existiert, laeuft `publish.ts` im "Free-Only release" Modus. Kein Fehler — aber dann werden auch nur die Free-Bits released. Falls der User erwartet hat dass das Pro-Paket mit released wird: STOPP und Pro-Repo erst klonen.

## Sicherheits-Regeln

NIE brechen, auch wenn der User es nahelegt:

1. **Kein Publish ohne explizite User-Konfirmation in Phase 5b.** "Mach mal" reicht nicht — es muss klar auf "Soll ich publishen?" geantwortet werden. Aber: frag NICHT vorher nach "hast du alles getestet?" — wenn der User "publish" sagt, ist alles getestet.
2. **Keine `--skip-npm` / `--skip-github` Flags** in Production-Releases. Die sind nur fuer Debugging.
3. **Kein `npm unpublish`.** Wenn was schiefgeht — auch wenn der User danach fragt — erst mit ihm reden. `unpublish` ist innerhalb 72h moeglich aber npm hasst es. Lieber Patch-Version drueberlegen.
4. **Keine `--force`-Flags** auf git oder npm Befehle. Wenn was nicht klappt, Root Cause finden.
5. **Niemals nur Pro-Repo allein publishen.** Free-Repo muss immer mit. `publish.ts` setzt das schon richtig durch, aber sei vorsichtig wenn jemand "nur Pro" vorschlaegt.
6. **Phase 7b (Auto-Switch `~/.claude.json`) darf nicht uebersprungen werden.** Der User hat explizit gesagt: nach Publish immer auf npm umstellen. Einzige Ausnahme: User sagt aktiv "ich will am lokalen Build bleiben".

## Checkliste (Kurzfassung)

- [ ] Phase 1: Status beider Repos geprueft, npm + gh authentifiziert
- [ ] Phase 2: Uncommitted Changes entweder committed oder geklaert
- [ ] Phase 3: Version mit User abgestimmt
- [ ] Phase 4: package.json in beiden Repos gebumpt + committed
- [ ] Phase 5: Dry-Run gruen
- [ ] Phase 5b: User-Konfirmation eingeholt
- [ ] Phase 6: `npm run publish:release` durchgelaufen
- [ ] Phase 7: npm registry, GitHub release und git tag verifiziert
- [ ] Phase 7b: `~/.claude.json` automatisch auf `npx @silbercue/chrome@latest` umgestellt
- [ ] Phase 7c: User informiert (Links + Hinweis auf `/mcp` Reconnect)
