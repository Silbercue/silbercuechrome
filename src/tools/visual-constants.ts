// Shared constants used by dom-snapshot and a11y-tree visual enrichment.

export const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

export const CLICKABLE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "tab", "menuitem",
  "switch", "slider", "option", "treeitem",
]);

export const COMPUTED_STYLES = [
  "display", "visibility", "color", "background-color",
  "font-size", "position", "z-index",
] as const;
