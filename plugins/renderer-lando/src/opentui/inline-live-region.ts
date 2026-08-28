import { isInPlaceTerminalUpdate, stripNonSgrControls } from "./ansi-styled-text.ts";

export type InlineLiveRegionPainter = {
  readonly paint: (lines: ReadonlyArray<string>) => void;
  readonly commitAbove: (text: string) => void;
  readonly release: () => void;
};

const ESC = String.fromCharCode(27);

const bodyOf = (lines: ReadonlyArray<string>): string => {
  if (lines.length === 0) return "";
  return `${lines.map((line) => stripNonSgrControls(line)).join("\n")}\n`;
};

const rowsFor = (text: string): ReadonlyArray<string> =>
  (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

export const createInlineLiveRegionPainter = (write: (text: string) => void): InlineLiveRegionPainter => {
  let paintedRows = 0;
  return {
    paint: (lines) => {
      const body = bodyOf(lines);
      write(paintedRows === 0 ? body : `${ESC}[${paintedRows}A${ESC}[J${body}`);
      paintedRows = lines.length;
    },
    commitAbove: (text) => {
      if (paintedRows > 0) {
        write(`${ESC}[${paintedRows}A${ESC}[J`);
        paintedRows = 0;
      }
      const inPlace = isInPlaceTerminalUpdate(text);
      const stripped = stripNonSgrControls(text, inPlace ? { allowCursor: true } : {});
      if (stripped.length === 0) return;
      // Composer/wget overwrite with CR or CSI G/K; do not synthesize a newline.
      if (inPlace) {
        write(stripped);
        return;
      }
      const lines = rowsFor(stripped);
      if (lines.length === 1 && lines[0] === "") return;
      write(`${lines.join("\n")}\n`);
    },
    release: () => {
      paintedRows = 0;
    },
  };
};
