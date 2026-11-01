/** Shared SGR vocabulary; terminal policy is resolved by the host, never here. */
const ESC = String.fromCharCode(27);

export const csi = Object.freeze({
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  dimReset: `${ESC}[22m`,
  cyan: `${ESC}[36m`,
  pink: `${ESC}[95m`,
  green: `${ESC}[32m`,
  amber: `${ESC}[33m`,
  red: `${ESC}[31m`,
  defaultFg: `${ESC}[39m`,
});

export type TerminalPalette = { readonly [Token in keyof typeof csi]: string };

const monochrome = Object.freeze({ ...csi, cyan: "", pink: "", green: "", amber: "", red: "" });

/** Chromatic ink is optional; resets and typography always retain their bytes. */
export const terminalPalette = (color: boolean): TerminalPalette => (color ? csi : monochrome);
