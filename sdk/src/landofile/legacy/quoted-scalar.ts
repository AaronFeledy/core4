import type { LegacyScalarNode } from "./contract.ts";
import type { LegacyScanner } from "./scanner.ts";

const trimTrailing = (text: string, chars: string): string => {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1] ?? "")) end -= 1;
  return end === text.length ? text : text.slice(0, end);
};

const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  '"': '"',
  "/": "/",
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "0": "\0",
  a: "\x07",
  v: "\v",
  e: "\x1b",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
  " ": " ",
};

const foldBreak = (scan: LegacyScanner, escaped: boolean): string => {
  let breaks = 0;
  do {
    scan.nextLine();
    scan.spaces();
    breaks += 1;
  } while (scan.atBreak);
  return escaped ? "\n".repeat(breaks - 1) : breaks === 1 ? " " : "\n".repeat(breaks - 1);
};

export const parseQuotedScalar = (scan: LegacyScanner): LegacyScalarNode => {
  const start = scan.offset;
  const quote = scan.char;
  scan.offset += 1;
  let text = "";
  while (!scan.done) {
    const char = scan.char;
    if (char === quote) {
      scan.offset += 1;
      if (quote === "'" && scan.char === "'") {
        text += "'";
        scan.offset += 1;
      } else return scan.scalar(text, quote === "'" ? "single" : "double", start);
    } else if (char === "\\" && quote === '"') {
      const escapeStart = scan.offset;
      scan.offset += 1;
      if (scan.atBreak) {
        text += foldBreak(scan, true);
        continue;
      }
      const escapedChar = scan.char;
      scan.offset += 1;
      const width = escapedChar === "x" ? 2 : escapedChar === "u" ? 4 : escapedChar === "U" ? 8 : 0;
      if (width > 0) {
        const hex = scan.content.slice(scan.offset, scan.offset + width);
        if (hex.length !== width || !/^[\da-f]+$/i.test(hex))
          scan.fail("Invalid hexadecimal YAML escape.", escapeStart);
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
          scan.fail("Invalid Unicode YAML escape.", escapeStart);
        scan.offset += width;
        text += String.fromCodePoint(code);
      } else {
        text +=
          ESCAPES[escapedChar] ??
          scan.fail(
            `Unknown YAML escape \\${escapedChar}.`,
            escapeStart,
            "Use a supported YAML escape or a single-quoted scalar.",
          );
      }
    } else if (scan.atBreak) {
      text = trimTrailing(text, " \t") + foldBreak(scan, false);
    } else {
      text += char;
      scan.offset += 1;
    }
  }
  return scan.fail(
    "Unterminated quoted YAML scalar.",
    start,
    "Close the scalar with its opening quote character.",
  );
};
