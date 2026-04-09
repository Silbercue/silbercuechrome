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

### Phase 6b: Public Pro-Release + Homebrew Formula Patch

Nach Phase 6 (npm publish + leeres gh release) wird jetzt das Pro-SEA-Binary gebaut, als Asset an den public Free-Repo-Release gehaengt, und die Homebrew-Formula im Tap-Repo `Silbercue/homebrew-silbercue` auf die neue Version + sha256 gepatcht. Das ist der Weg, auf dem Pro-Kunden das Binary via `brew install silbercue/silbercue/silbercuechrome` bekommen.

**Voraussetzungen (alle automatisch durch vorherige Phasen erfuellt):**
- Phase 6 war erfolgreich — das public Release `vX.Y.Z` existiert im Free-Repo, ist aber noch leer.
- Pro-Repo ist auf derselben Version wie Free (Phase 1 haert das hart gegen).
- `gh` CLI ist authentifiziert mit Schreibrechten auf `Silbercue/silbercuechrome` UND `Silbercue/homebrew-silbercue`.
- `scripts/build-binary.sh` im Pro-Repo ist **unangetastet** — der Skill ruft es unveraendert auf.

**Ablauf — sequentiell, bei jedem Fehler STOPP:**

```bash
VERSION="<NEW_VERSION>"  # z.B. 0.1.2 — ohne v-prefix
TAP_WORK=/tmp/hb-silbercue

# 1) Pro-Binary bauen (build-binary.sh bleibt unberuehrt)
cd /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro
bash scripts/build-binary.sh

# Sanity: Binary existiert, ist ausfuehrbar, zeigt die erwartete Version
test -x ./dist/silbercuechrome-pro || { echo "FAIL: binary not built"; exit 1; }
./dist/silbercuechrome-pro version | grep -q "@silbercuechrome/mcp-pro ${VERSION}" \
  || { echo "FAIL: binary version mismatch"; exit 1; }

# 2) Binary als tar.gz packen
BIN_TGZ="/tmp/silbercuechrome-pro-v${VERSION}-macos-arm64.tar.gz"
rm -f "${BIN_TGZ}" "${BIN_TGZ}.sha256"
tar -czf "${BIN_TGZ}" -C dist silbercuechrome-pro

# 3) SHA256 berechnen und als Sidecar
SHA256=$(shasum -a 256 "${BIN_TGZ}" | awk '{print $1}')
echo "${SHA256}  silbercuechrome-pro-v${VERSION}-macos-arm64.tar.gz" > "${BIN_TGZ}.sha256"

# 4) Assets an das Free-Repo-Release haengen (existiert bereits aus Phase 6)
gh release upload "v${VERSION}" "${BIN_TGZ}" "${BIN_TGZ}.sha256" \
  --repo Silbercue/silbercuechrome

# 5) Tap-Repo clonen/pullen + Formula create-or-patch
# Achtung: Tap-Repo `Silbercue/homebrew-silbercue` nutzt den Branch `main`
# (nicht `master` wie die Free/Pro-Repos).
if [ -d "${TAP_WORK}/.git" ]; then
  git -C "${TAP_WORK}" fetch origin
  git -C "${TAP_WORK}" checkout main
  git -C "${TAP_WORK}" reset --hard origin/main
else
  gh repo clone Silbercue/homebrew-silbercue "${TAP_WORK}"
fi

# Erster Lauf: Formula existiert noch nicht im Tap → aus dem Skill-Template
# kopieren. Folgelauf: existierende Formula wird nur patched.
TEMPLATE_SRC="/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome/.claude/skills/silbercuechrome-publish/templates/silbercuechrome.rb"
FORMULA_DST="${TAP_WORK}/Formula/silbercuechrome.rb"
if [ ! -f "${FORMULA_DST}" ]; then
  echo "Tap has no silbercuechrome formula yet — bootstrapping from skill template"
  mkdir -p "${TAP_WORK}/Formula"
  cp "${TEMPLATE_SRC}" "${FORMULA_DST}"
fi

SHA256="${SHA256}" VERSION="${VERSION}" FORMULA_DST="${FORMULA_DST}" python3 <<'PY'
import os, pathlib, re
version = os.environ["VERSION"]
sha256 = os.environ["SHA256"]
f = pathlib.Path(os.environ["FORMULA_DST"])
t = f.read_text()
t = re.sub(
    r'url "https://github\.com/Silbercue/silbercuechrome/releases/download/v[^/]+/silbercuechrome-pro-v[^"]+\.tar\.gz"',
    f'url "https://github.com/Silbercue/silbercuechrome/releases/download/v{version}/silbercuechrome-pro-v{version}-macos-arm64.tar.gz"',
    t,
)
t = re.sub(r'version "[^"]+"', f'version "{version}"', t)
t = re.sub(r'sha256 "[0-9a-f]{64}"', f'sha256 "{sha256}"', t)
f.write_text(t)
print(f"Formula patched: version={version}, sha256={sha256[:12]}...")
PY

# 6) Commit + push Tap main (kein PR, kein Branch — direkter Push)
cd "${TAP_WORK}"
git add Formula/silbercuechrome.rb
git commit -m "silbercuechrome ${VERSION}"
git push origin main

# 7) Smoke-Test: Formula aus Tap ziehen und installieren
brew update
brew uninstall silbercue/silbercue/silbercuechrome 2>/dev/null || true
brew install silbercue/silbercue/silbercuechrome

# 8) Version-Smoke-Test am installierten Binary
/opt/homebrew/bin/silbercuechrome version | tee /tmp/sc-brew-version.log
grep -q "@silbercuechrome/mcp-pro ${VERSION}" /tmp/sc-brew-version.log \
  || { echo "FAIL: installed binary version mismatch"; exit 1; }

# 9) Finaler brew audit (jetzt mit echtem Release erreichbar)
brew audit --strict --online silbercue/silbercue/silbercuechrome \
  || echo "WARN: brew audit hat Findings — manuell pruefen"

echo "Phase 6b OK — silbercuechrome ${VERSION} ist via 'brew install silbercue/silbercue/silbercuechrome' verfuegbar"
```

**Fehlerbehebung Phase 6b:**

- **`bash scripts/build-binary.sh` failed:** Pro-Build-Problem. STOPP, mit User klaeren. `scripts/build-binary.sh` NICHT modifizieren (AC-6).
- **`gh release upload` exit 1 mit "asset already exists":** Re-Release-Szenario — `--clobber` zum upload-Call hinzufuegen und retry.
- **`git push origin master` im Tap failed mit Auth-Error:** `gh auth status` pruefen, ggf. `gh auth login`, retry.
- **`brew install` failed mit "SHA256 mismatch":** Formula wurde mit dem falschen sha256 gepatcht. Asset manuell pruefen (`gh release view v${VERSION} --repo Silbercue/silbercuechrome --json assets`), sha256 aus dem echten Asset neu berechnen, Formula neu patchen, commit+push retry.
- **`/opt/homebrew/bin/silbercuechrome version` zeigt alte Version:** Homebrew-Cache. `brew uninstall` + `brew cleanup -s silbercuechrome` + `brew install ...` retry.
- **`brew audit --strict --online` hat Findings:** Kein Hard-Fail — nur warnen. Haeufige Findings: Desc-Format, Homepage-HTTPS-Check, Fehlende Trailing-Newline in der Formula. Fix ueber separaten Tap-Commit nachreichen.

**Sicherheits-Regeln fuer Phase 6b:**

- **Kein Pro-Source im Free-Release.** Nur das ad-hoc-signierte SEA-Binary (`silbercuechrome-pro-vX.Y.Z-macos-arm64.tar.gz`) + sha256-Sidecar. Kein `npm pack`, kein Git-Bundle, kein Source-Tarball.
- **`scripts/build-binary.sh` im Pro-Repo nicht modifizieren** — der Skill ruft es unveraendert auf.
- **Tap-Repo `main` direkt pushen** — kein PR-Workflow noetig. Maintainer = User. Achtung: Tap nutzt Branch `main`, Free/Pro-Repos nutzen `master` — nicht verwechseln.
- **Bei SHA256-Mismatch zwischen Asset und Formula:** NICHT retry-loopen. Root Cause finden (meist: Tarball wurde neu generiert zwischen Upload und Formula-Patch).

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
1. **Free-Version live auf npm:** `https://www.npmjs.com/package/@silbercue/chrome`
2. **GitHub Release (public):** `https://github.com/Silbercue/silbercuechrome/releases/tag/v<NEW_VERSION>` — enthaelt das Pro-Binary als Asset (`silbercuechrome-pro-v<NEW_VERSION>-macos-arm64.tar.gz` + `.sha256`)
3. **Pro via Homebrew verfuegbar:** Kunden installieren jetzt mit drei Befehlen:
   ```bash
   brew install silbercue/silbercue/silbercuechrome
   claude mcp add --scope user silbercuechrome /opt/homebrew/bin/silbercuechrome
   silbercuechrome activate <LICENSE-KEY>
   ```
   Der Kunde muss Claude Code **komplett neu starten** nach `claude mcp add` (`/mcp reconnect` reicht nicht — Session-Cache-Gotcha).
4. **Tap-Repo gepusht:** `https://github.com/Silbercue/homebrew-silbercue/commits/main` — `Formula/silbercuechrome.rb` wurde auf `version "<NEW_VERSION>"` + neuen `sha256` gepatcht.
5. **Claude-Code-Config** ist automatisch auf `npx @silbercue/chrome@latest` umgestellt (Backup unter `~/.claude.json.backup-<timestamp>`). Hinweis: `/mcp` im Prompt eintippen um die neue Version sofort zu laden, oder Claude Code neu starten.

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
- [ ] **Phase 6b: Pro-Binary gebaut, an Free-Release angehaengt, Formula im Tap gepatcht + gepusht, `brew install` Smoke-Test gruen**
- [ ] Phase 7: npm registry, GitHub release und git tag verifiziert
- [ ] Phase 7b: `~/.claude.json` automatisch auf `npx @silbercue/chrome@latest` umgestellt
- [ ] Phase 7c: User informiert (Free-Links + Pro-Homebrew-Link + Hinweis auf Claude-Code-Restart)
