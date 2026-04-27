/**
 * Story 12a.1: Seitentyp-Taxonomie + A11y-Tree-Klassifikator.
 *
 * Regelbasierter Klassifikator der aus dem A11y-Tree (AXNode[]) den
 * Seitentyp bestimmt. Kein ML, kein Training, deterministisch.
 *
 * Drei Exportgruppen:
 *  1. Taxonomie: PageType (Union), PAGE_TYPES (Array)
 *  2. Feature-Extraktion: PageFeatureVector, extractFeatures()
 *  3. Klassifikation: classify(), classifyPage() (Public API)
 *
 * Fehlerphilosophie: Wie alle Cortex-Module — NIEMALS den Tool-Flow
 * stoeren. Jeder Fehler wird geschluckt und "unknown" zurueckgegeben.
 *
 * Privacy (NFR21): Seitentyp ist weniger identifizierend als Domain —
 * "login" verraet nicht WELCHE Seite besucht wurde.
 */
import { debug } from "../cdp/debug.js";
import type { AXNode } from "../cache/a11y-tree.js";

// ─── Taxonomie ───────────────────────────────────────────────────────

/**
 * Seitentyp-Taxonomie fuer Cortex-Pattern-Zuordnung.
 *
 * Jeder Typ beschreibt eine funktionale Seitenkategorie, die ueber
 * ARIA-Rollen, Marker und Label-Keywords erkannt wird. Die Reihenfolge
 * der Regeln bestimmt die Prioritaet bei Mehrdeutigkeit.
 */
export type PageType =
  /** Form + Passwort-Feld + Submit-Button (keine Passwort-Bestaetigung). */
  | "login"
  /** Form + 2+ textbox inkl. Passwort + Bestaetigungsfeld oder Name+Email+Passwort. */
  | "signup"
  /** Code-/OTP-Eingabe oder MFA-Hinweis (aria-label mit "code", "verify", "2fa", "otp", "authenticator"). */
  | "mfa"
  /** search-Landmark oder prominentes textbox + Submit, wenig sonstige Formularfelder. */
  | "search_form"
  /** search-Landmark + Liste von Links/Ergebnissen (hohe Link-Dichte + Liststruktur). */
  | "search_results"
  /** grid/table + columnheader — typisch fuer Admin-Panels und Dashboards. */
  | "data_table"
  /** 1-3 textbox/select/textarea, kein Passwort-Feld. */
  | "form_simple"
  /** Multi-Step-Indikator (progressbar, "step"-Keywords, Tab-Navigation) + Formularfelder. */
  | "form_wizard"
  /** Langer Text-Content (heading + StaticText-Bloecke), wenige interaktive Elemente. */
  | "article"
  /** Hohe Link-Dichte (>15 Links), wenig Formulare — Landing/Index-Seiten. */
  | "navigation"
  /** Mischung aus data_table + Metriken + Grafiken (img/figure + headings + stats). */
  | "dashboard"
  /** Konfigurationsformular (checkbox/switch-Cluster + Speichern-Button). */
  | "settings"
  /** Video/Audio-Player (role=video/application + Steuerelemente). */
  | "media"
  /** Formular mit Zahlungsindikatoren ("payment", "card", "billing", "checkout"). */
  | "checkout"
  /** Einzelnes Datenprofil (img/heading + Detailfelder, weniger als Data-Table). */
  | "profile"
  /** Fehlerseite (Heading mit "404", "error", "not found", wenig interaktive Elemente). */
  | "error"
  /** Fallback wenn kein anderer Typ zutrifft. */
  | "unknown";

/**
 * Alle bekannten Seitentypen OHNE "unknown" (der ist Fallback, kein aktiver Typ).
 * Wird in Tests und Markov-Tabelle (Story 12a.3) verwendet.
 */
export const PAGE_TYPES: readonly PageType[] = [
  "login",
  "signup",
  "mfa",
  "search_form",
  "search_results",
  "data_table",
  "form_simple",
  "form_wizard",
  "article",
  "navigation",
  "dashboard",
  "settings",
  "media",
  "checkout",
  "profile",
  "error",
] as const;

// ─── Feature-Vektor ──────────────────────────────────────────────────

/**
 * Strukturierter Feature-Vektor der aus dem A11y-Tree extrahiert wird.
 * Dient als Input fuer die regelbasierte Klassifikation.
 */
export interface PageFeatureVector {
  /** ARIA-Rollen → Anzahl (z.B. "textbox" → 3, "button" → 2). */
  roleCounts: Map<string, number>;
  /** textbox mit type=password oder aria-label *password*. */
  hasPasswordField: boolean;
  /** role=search Landmark vorhanden. */
  hasSearchLandmark: boolean;
  /** role=grid oder role=table + columnheader. */
  hasGrid: boolean;
  /** Gesamtzahl role=link. */
  linkCount: number;
  /** Gesamtzahl role=heading. */
  headingCount: number;
  /** Gesamtzahl role=form. */
  formCount: number;
  /** Gesamtzahl role=textbox (inkl. searchbox). */
  textboxCount: number;
  /** Gesamtzahl role=button. */
  buttonCount: number;
  /** Gesamtzahl role=checkbox + switch. */
  checkboxCount: number;
  /** Gesamtzahl role=img. */
  imageCount: number;
  /** Gesammelte Keywords aus name/aria-label (lowercase, dedupliziert). */
  labelKeywords: Set<string>;
}

/**
 * Extrahiert einen Feature-Vektor aus rohen CDP AXNode-Daten.
 *
 * Iteriert einmal ueber alle Nodes (O(n) single-pass). Ignorierte
 * Nodes (ignored: true) werden uebersprungen.
 *
 * @param nodes - Das rohe AXNode-Array aus Accessibility.getFullAXTree()
 * @returns Feature-Vektor fuer die Klassifikation
 */
export function extractFeatures(nodes: AXNode[]): PageFeatureVector {
  const roleCounts = new Map<string, number>();
  let hasPasswordField = false;
  let hasSearchLandmark = false;
  let hasGrid = false;
  let linkCount = 0;
  let headingCount = 0;
  let formCount = 0;
  let textboxCount = 0;
  let buttonCount = 0;
  let checkboxCount = 0;
  let imageCount = 0;
  const labelKeywords = new Set<string>();

  /** Track whether we have seen a columnheader (needed for table+columnheader → hasGrid). */
  let hasColumnHeader = false;
  let hasTable = false;

  for (const node of nodes) {
    // Skip ignored nodes — getFullAXTree delivers them but they are not visible
    if (node.ignored) continue;

    const role = (typeof node.role?.value === "string" ? node.role.value : "").toLowerCase();
    if (!role) continue;

    // Count roles
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    // Specific role counts
    switch (role) {
      case "link":
        linkCount++;
        break;
      case "heading":
        headingCount++;
        break;
      case "form":
        formCount++;
        break;
      case "textbox":
      case "searchbox":
        textboxCount++;
        break;
      case "button":
        buttonCount++;
        break;
      case "checkbox":
      case "switch":
        checkboxCount++;
        break;
      case "img":
      case "image":
        imageCount++;
        break;
      case "search":
        hasSearchLandmark = true;
        break;
      case "grid":
        hasGrid = true;
        break;
      case "table":
        hasTable = true;
        break;
      case "columnheader":
        hasColumnHeader = true;
        break;
    }

    // Password detection via autocomplete property
    if (role === "textbox" || role === "searchbox") {
      if (node.properties) {
        for (const prop of node.properties) {
          if (prop.name === "autocomplete") {
            const val = (typeof prop.value?.value === "string" ? prop.value.value : "").toLowerCase();
            if (val === "current-password" || val === "new-password") {
              hasPasswordField = true;
            }
          }
        }
      }
    }

    // Password detection via name/description containing "password"
    const nameVal = (typeof node.name?.value === "string" ? node.name.value : "").toLowerCase();
    const descVal = (typeof node.description?.value === "string" ? node.description.value : "").toLowerCase();
    if (
      (role === "textbox" || role === "searchbox") &&
      (nameVal.includes("password") || descVal.includes("password"))
    ) {
      hasPasswordField = true;
    }

    // Keyword extraction from name and description
    for (const text of [nameVal, descVal]) {
      if (!text) continue;
      const words = text.split(/\s+/);
      for (const word of words) {
        const trimmed = word.replace(/[^a-z0-9]/g, "");
        if (trimmed.length > 2) {
          labelKeywords.add(trimmed);
        }
      }
    }
  }

  // table + columnheader → hasGrid (ARIA: table is static, grid is interactive,
  // but Chrome sometimes reports grid for tables — both get the same signal)
  if (hasTable && hasColumnHeader) {
    hasGrid = true;
  }

  return {
    roleCounts,
    hasPasswordField,
    hasSearchLandmark,
    hasGrid,
    linkCount,
    headingCount,
    formCount,
    textboxCount,
    buttonCount,
    checkboxCount,
    imageCount,
    labelKeywords,
  };
}

// ─── Klassifikation ──────────────────────────────────────────────────

/**
 * Hilfsfunktion: Prueft ob eines der Keywords im Set enthalten ist.
 */
function hasAnyKeyword(keywords: Set<string>, targets: string[]): boolean {
  for (const t of targets) {
    if (keywords.has(t)) return true;
  }
  return false;
}

/**
 * Regelbasierte Klassifikation anhand des Feature-Vektors.
 *
 * Reine Funktion, kein State, deterministisch.
 * Regeln in Prioritaetsreihenfolge — erste zutreffende Regel gewinnt.
 *
 * @param features - Feature-Vektor aus extractFeatures()
 * @returns Bestimmter Seitentyp
 */
export function classify(features: PageFeatureVector): PageType {
  const {
    hasPasswordField,
    hasSearchLandmark,
    hasGrid,
    linkCount,
    headingCount,
    formCount,
    textboxCount,
    buttonCount,
    checkboxCount,
    imageCount,
    labelKeywords,
    roleCounts,
  } = features;

  // 1. error — "404", "error", "not found" keywords, keine Textfelder
  //    Zusaetzlich: headingCount >= 1 (Fehlerseiten haben Fehler-Headline) UND
  //    buttonCount <= 2 (echte Error-Seiten haben wenige Buttons — "Back"/"Home").
  //    Verhindert false positives bei Demo-Seiten mit "Show Error"-Buttons.
  if (
    hasAnyKeyword(labelKeywords, ["404", "error", "not", "found"]) &&
    textboxCount === 0 &&
    headingCount >= 1 &&
    buttonCount <= 2
  ) {
    // Refine: "not" alone is too generic — require "found" nearby or explicit error signals
    if (
      labelKeywords.has("404") ||
      labelKeywords.has("error") ||
      (labelKeywords.has("not") && labelKeywords.has("found"))
    ) {
      return "error";
    }
  }

  // 2. login — Passwort-Feld + max 2 textbox + Formular (username/email + password)
  //    <= 2 statt <= 3: Signups haben typischerweise 3+ Felder (Name+Email+Password
  //    oder Email+Password+Confirm). 3 Felder = signup, nicht login.
  if (hasPasswordField && textboxCount <= 2 && formCount >= 1) {
    return "login";
  }

  // 3. signup — Passwort-Feld + 3+ textbox (Name+Email+Password oder Email+Password+Confirm)
  if (hasPasswordField && textboxCount >= 3) {
    return "signup";
  }

  // 4. mfa — MFA-Keywords + (Passwort oder wenige textbox)
  if (
    hasAnyKeyword(labelKeywords, ["otp", "2fa", "verify", "authenticator", "code"]) &&
    (hasPasswordField || textboxCount <= 2)
  ) {
    return "mfa";
  }

  // 5. checkout — Zahlungs-Keywords + Formular
  if (
    hasAnyKeyword(labelKeywords, ["payment", "card", "billing", "checkout"]) &&
    formCount >= 1
  ) {
    return "checkout";
  }

  // 6. search_results — search-Landmark + viele Links
  if (hasSearchLandmark && linkCount >= 5) {
    return "search_results";
  }

  // 6b. search_results (alternativer Pfad) — kein search-Landmark, aber prominentes
  //     textbox mit Search/Suche/Find-Keyword + Submit-Button + viele Links
  if (
    !hasSearchLandmark &&
    textboxCount >= 1 &&
    buttonCount >= 1 &&
    linkCount >= 5 &&
    hasAnyKeyword(labelKeywords, ["search", "suche", "find"])
  ) {
    return "search_results";
  }

  // 7. search_form — search-Landmark oder "search"-Keyword, wenig textbox, wenig Links
  if (
    (hasSearchLandmark || labelKeywords.has("search")) &&
    textboxCount <= 2 &&
    linkCount < 10
  ) {
    return "search_form";
  }

  // 8. dashboard — viele Headings + (Grid oder viele Bilder) + einige Links
  //    MUSS VOR data_table stehen: Grid allein ist data_table, Grid + headings + links ist dashboard.
  if (headingCount >= 3 && (hasGrid || imageCount >= 2) && linkCount >= 5) {
    return "dashboard";
  }

  // 9. data_table — grid/table mit columnheader
  if (hasGrid) {
    return "data_table";
  }

  // 10. form_wizard — Formular + Step/Progress/Wizard/Next Keywords
  if (
    formCount >= 1 &&
    hasAnyKeyword(labelKeywords, ["step", "progress", "wizard", "next"])
  ) {
    return "form_wizard";
  }

  // 10. settings — checkbox/switch-Cluster oder checkboxes + settings Keywords
  if (
    checkboxCount >= 3 ||
    (checkboxCount >= 1 &&
      hasAnyKeyword(labelKeywords, ["settings", "preferences"]))
  ) {
    return "settings";
  }

  // 11. media — video/audio Rollen oder application + player Keyword
  if (
    roleCounts.has("video") ||
    roleCounts.has("audio") ||
    (roleCounts.has("application") && labelKeywords.has("player"))
  ) {
    return "media";
  }

  // 12. profile — Bild + Heading + wenig textbox + wenig Links + profile Keywords
  if (
    imageCount >= 1 &&
    headingCount >= 1 &&
    textboxCount <= 2 &&
    linkCount < 10 &&
    hasAnyKeyword(labelKeywords, ["profile", "account", "user"])
  ) {
    return "profile";
  }

  // 13. form_simple — Formular + textbox, kein Passwort
  //     Auch ohne explizites form-Landmark: textbox + button reicht
  //     (viele Seiten haben kein <form>-Tag mit accessible name)
  if (
    (formCount >= 1 || buttonCount >= 1) &&
    textboxCount >= 1 &&
    !hasPasswordField
  ) {
    return "form_simple";
  }

  // 15. article — mehrere Headings + wenig Links + keine textbox
  if (headingCount >= 2 && linkCount < 15 && textboxCount === 0) {
    return "article";
  }

  // 16. navigation — viele Links + wenig textbox
  if (linkCount >= 15 && textboxCount <= 1) {
    return "navigation";
  }

  // 17. unknown — Default-Fallback
  return "unknown";
}

/**
 * Public API: Klassifiziert eine Seite anhand ihrer AXNode-Daten.
 *
 * Wrapper um extractFeatures() → classify(). Bei jedem Fehler wird
 * "unknown" zurueckgegeben (Cortex-Fehlerphilosophie).
 *
 * @param nodes - Das rohe AXNode-Array aus Accessibility.getFullAXTree()
 * @returns Bestimmter Seitentyp ("unknown" bei Fehlern)
 */
export function classifyPage(nodes: AXNode[]): PageType {
  try {
    if (!nodes || !Array.isArray(nodes)) {
      return "unknown";
    }
    const features = extractFeatures(nodes);
    return classify(features);
  } catch (err) {
    debug("[page-classifier] classify failed: %s", err);
    return "unknown";
  }
}
