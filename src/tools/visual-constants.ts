// Shared constants used by dom-snapshot and a11y-tree visual enrichment.

export const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

export const CLICKABLE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "tab", "menuitem",
  "switch", "slider", "option", "treeitem",
]);

// Story 18.4: `pointer-events` appended as index 7 for paint-order occlusion
// filtering in a11y-tree. Do NOT reorder — existing readers use numeric
// indices (display=0, visibility=1, color=2, bg=3, font-size=4, position=5,
// z-index=6). `pointer-events` must stay at the end.
export const COMPUTED_STYLES = [
  "display", "visibility", "color", "background-color",
  "font-size", "position", "z-index", "pointer-events",
] as const;
