import { describe, it, expect } from "vitest";
import {
  isStyleChange,
  extractSelector,
  formatGeometryDiff,
} from "./style-change-detection.js";

describe("isStyleChange", () => {
  // --- Positive cases (should detect style changes) ---

  it("detects element.style.property assignment", () => {
    expect(isStyleChange("el.style.color = 'red'")).toBe(true);
    expect(isStyleChange("element.style.gridTemplateColumns = '50px 1fr'")).toBe(true);
    expect(isStyleChange("row.style.display = 'none'")).toBe(true);
  });

  it("detects element.style = assignment", () => {
    expect(isStyleChange("el.style = 'color: red'")).toBe(true);
  });

  it("detects cssText assignment", () => {
    expect(isStyleChange("el.style.cssText = 'color: red; font-size: 14px'")).toBe(true);
  });

  it("detects classList.add", () => {
    expect(isStyleChange("element.classList.add('active')")).toBe(true);
  });

  it("detects classList.remove", () => {
    expect(isStyleChange("element.classList.remove('hidden')")).toBe(true);
  });

  it("detects classList.toggle", () => {
    expect(isStyleChange("el.classList.toggle('expanded')")).toBe(true);
  });

  it("detects classList.replace", () => {
    expect(isStyleChange("el.classList.replace('old', 'new')")).toBe(true);
  });

  it("detects setAttribute('style', ...)", () => {
    expect(isStyleChange("el.setAttribute('style', 'color: red')")).toBe(true);
    expect(isStyleChange('el.setAttribute("style", "color: red")')).toBe(true);
  });

  it("detects setProperty", () => {
    expect(isStyleChange("el.style.setProperty('color', 'red')")).toBe(true);
  });

  it("detects style changes in complex multi-line expressions", () => {
    const expr = `document.querySelectorAll('.beleg-row').forEach(r => {
      r.style.gridTemplateColumns = '50px 1fr 100px';
    })`;
    expect(isStyleChange(expr)).toBe(true);
  });

  // --- Negative cases (should NOT detect style changes) ---

  it("does NOT detect querySelector alone (reading)", () => {
    expect(isStyleChange("document.querySelector('.foo')")).toBe(false);
  });

  it("does NOT detect getBoundingClientRect (reading)", () => {
    expect(isStyleChange("el.getBoundingClientRect()")).toBe(false);
  });

  it("does NOT detect textContent (reading)", () => {
    expect(isStyleChange("el.textContent")).toBe(false);
  });

  it("does NOT detect getComputedStyle (reading)", () => {
    expect(isStyleChange("getComputedStyle(el).color")).toBe(false);
  });

  it("does NOT detect innerHTML read", () => {
    expect(isStyleChange("document.body.innerHTML")).toBe(false);
  });

  it("does NOT detect className read", () => {
    expect(isStyleChange("el.className")).toBe(false);
  });

  it("does NOT detect plain arithmetic", () => {
    expect(isStyleChange("1 + 1")).toBe(false);
  });

  it("does NOT detect JSON.stringify", () => {
    expect(isStyleChange("JSON.stringify({a: 1})")).toBe(false);
  });

  // --- H4: False-positive protection (patterns in strings/comments) ---

  it("does NOT detect .style. inside a string literal", () => {
    expect(isStyleChange("console.log('el.style.color changed')")).toBe(false);
    expect(isStyleChange('console.log("el.style.color = red")')).toBe(false);
  });

  it("does NOT detect classList.add inside a string literal", () => {
    expect(isStyleChange("console.log('classList.add(active)')")).toBe(false);
  });

  it("does NOT detect .style. inside a template literal", () => {
    expect(isStyleChange("console.log(`el.style.color = ${val}`)")).toBe(false);
  });

  it("does NOT detect .style. inside a single-line comment", () => {
    expect(isStyleChange("// el.style.color = 'red'\n1 + 1")).toBe(false);
  });

  it("still detects real style change when strings are also present", () => {
    expect(isStyleChange("console.log('before'); el.style.color = 'red'")).toBe(true);
  });
});

describe("extractSelector", () => {
  it("extracts selector from querySelector", () => {
    expect(extractSelector("document.querySelector('.beleg-row')")).toBe(".beleg-row");
  });

  it("extracts selector from querySelectorAll", () => {
    expect(extractSelector("document.querySelectorAll('.card')")).toBe(".card");
  });

  it("extracts selector from getElementById", () => {
    expect(extractSelector("document.getElementById('main')")).toBe("#main");
  });

  it("extracts selector from getElementsByClassName", () => {
    expect(extractSelector("document.getElementsByClassName('active')")).toBe(".active");
  });

  it("extracts selector from complex forEach expression", () => {
    const expr = `document.querySelectorAll('.beleg-row').forEach(r => r.style.gridTemplateColumns = '50px 1fr')`;
    expect(extractSelector(expr)).toBe(".beleg-row");
  });

  it("returns first selector when multiple are present", () => {
    const expr = `document.querySelector('.outer').querySelector('.inner')`;
    expect(extractSelector(expr)).toBe(".outer");
  });

  it("returns null when no selector is identifiable", () => {
    expect(extractSelector("el.style.color = 'red'")).toBeNull();
    expect(extractSelector("1 + 1")).toBeNull();
    expect(extractSelector("rows.forEach(r => r.style.display = 'none')")).toBeNull();
  });

  it("handles double quotes in selector", () => {
    expect(extractSelector('document.querySelector(".foo")')).toBe(".foo");
  });

  it("handles complex CSS selectors", () => {
    expect(extractSelector("document.querySelector('[data-test=\"2.2\"]')")).toBe('[data-test="2.2"]');
  });

  // --- H3: Edge cases ---

  it("handles selector with escaped quotes", () => {
    expect(extractSelector("document.querySelector('.card[data-id=\"123\"]')")).toBe('.card[data-id="123"]');
  });

  it("handles ID selector with hyphens", () => {
    expect(extractSelector("document.getElementById('my-complex-id')")).toBe("#my-complex-id");
  });

  it("handles multiple class selector", () => {
    expect(extractSelector("document.querySelector('.card.active.highlighted')")).toBe(".card.active.highlighted");
  });

  it("returns null for template literal selectors (not supported)", () => {
    // Template literals use backticks — not matched by the regex
    expect(extractSelector("document.querySelector(`#${id}`)")).toBeNull();
  });
});

describe("formatGeometryDiff", () => {
  it("returns size change text", () => {
    const result = formatGeometryDiff(
      ".beleg-row",
      { x: 10, y: 20, width: 40, height: 50 },
      { x: 10, y: 20, width: 50, height: 50 },
    );
    expect(result).toBe("Visual: .beleg-row 40×50 → 50×50px");
  });

  it("returns position change text", () => {
    const result = formatGeometryDiff(
      "#main",
      { x: 10, y: 20, width: 100, height: 100 },
      { x: 30, y: 20, width: 100, height: 100 },
    );
    expect(result).toBe("Visual: #main pos (10,20) → (30,20)");
  });

  it("returns both size and position changes", () => {
    const result = formatGeometryDiff(
      ".card",
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 10, y: 5, width: 200, height: 100 },
    );
    expect(result).toBe("Visual: .card 100×50 → 200×100px, pos (0,0) → (10,5)");
  });

  it("returns unchanged text when nothing changed", () => {
    const result = formatGeometryDiff(
      ".foo",
      { x: 10, y: 20, width: 100, height: 50 },
      { x: 10, y: 20, width: 100, height: 50 },
    );
    expect(result).toBe("Visual: .foo unchanged 100×50px");
  });

  it("rounds fractional values", () => {
    const result = formatGeometryDiff(
      ".bar",
      { x: 10.3, y: 20.7, width: 99.5, height: 50.2 },
      { x: 10.3, y: 20.7, width: 150.8, height: 50.2 },
    );
    expect(result).toBe("Visual: .bar 100×50 → 151×50px");
  });
});
