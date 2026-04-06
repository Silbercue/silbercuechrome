export const EMULATED_WIDTH = 1280;
export const EMULATED_HEIGHT = 800;
export const DEVICE_SCALE_FACTOR = 1;
export const MOBILE = false;

export const DEVICE_METRICS_OVERRIDE = {
  width: EMULATED_WIDTH,
  height: EMULATED_HEIGHT,
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  mobile: MOBILE,
} as const;

/**
 * Runtime headless state, set once after connection is established.
 * Used by tools (e.g. switch-tab) to decide emulation vs window-resize.
 */
let _headless = true;
export function setHeadless(value: boolean): void { _headless = value; }
export function isHeadless(): boolean { return _headless; }
