/**
 * Chart palette. Validated with the dataviz skill's `validate_palette.js`
 * in both modes (adjacent-pair CVD and normal-vision floors pass). Slot order
 * is the colour-blind-safety mechanism: assign in order, never cycle.
 */
export const CATEGORICAL_LIGHT = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
] as const;

export const CATEGORICAL_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

export const MAX_SERIES = CATEGORICAL_LIGHT.length;

export function isDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function seriesColor(index: number, dark = isDarkMode()): string {
  const pal = dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
  return pal[Math.min(index, pal.length - 1)] ?? pal[0];
}
