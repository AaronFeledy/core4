/**
 * Shared terminal layout primitives for the default `lando` renderer's grouped
 * summary surfaces (plans, info, diagnostics). Unlike the task-tree painter's
 * internal helpers, these are CJK/wide-character aware and wrap at any width so
 * narrow terminals stay readable.
 *
 * The painter (`task-tree-tail.ts`) keeps its own width helpers because it pins
 * byte-for-byte first-paint frames; this module is the reusable seam for static
 * result summaries that are rendered once with no cursor accounting.
 */

const ESC = String.fromCharCode(27);
const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** Strip CSI/SGR escape sequences so width math sees only visible glyphs. */
export const stripAnsi = (text: string): string => text.replace(ansiPattern, "");

const csi = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  dimReset: `${ESC}[22m`,
  cyan: `${ESC}[36m`,
  pink: `${ESC}[95m`,
  green: `${ESC}[32m`,
  amber: `${ESC}[33m`,
  red: `${ESC}[31m`,
} as const;

/** Code points that occupy two terminal columns (East Asian Wide/Fullwidth + emoji). */
const isWideCodePoint = (cp: number): boolean =>
  cp >= 0x1100 &&
  (cp <= 0x115f || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals .. Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // symbols & emoji
    (cp >= 0x20000 && cp <= 0x3fffd)); // CJK Ext B+

/** Code points that occupy zero terminal columns (combining marks, ZWJ, variation selectors). */
const isZeroWidthCodePoint = (cp: number): boolean =>
  cp === 0x200d ||
  (cp >= 0x0300 && cp <= 0x036f) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xfe20 && cp <= 0xfe2f);

const codePointWidth = (cp: number): number => {
  if (isZeroWidthCodePoint(cp)) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
};

/** Visible terminal width of `text`, counting wide glyphs as 2 and ignoring ANSI. */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    width += codePointWidth(cp);
  }
  return width;
};

const ELLIPSIS = "…";

/** Truncate `text` to at most `max` columns, appending an ellipsis when clipped. */
export const truncateToWidth = (text: string, max: number): string => {
  if (displayWidth(text) <= max) return text;
  if (max <= 1) return ELLIPSIS;
  const budget = max - 1;
  let width = 0;
  let out = "";
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const w = codePointWidth(cp);
    if (width + w > budget) break;
    out += ch;
    width += w;
  }
  return `${out}${ELLIPSIS}`;
};

const hardBreakToken = (token: string, width: number): ReadonlyArray<string> => {
  const segments: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of token) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = codePointWidth(cp);
    if (currentWidth + w > width && current.length > 0) {
      segments.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  if (current.length > 0) segments.push(current);
  return segments.length === 0 ? [""] : segments;
};

/** Word-wrap `text` to `width` columns, hard-breaking tokens that cannot fit. */
export const wrapToWidth = (text: string, width: number): ReadonlyArray<string> => {
  const budget = Math.max(1, width);
  if (displayWidth(text) <= budget) return [text];
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current.length === 0 ? token : `${current} ${token}`;
    if (displayWidth(candidate) <= budget) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
    if (displayWidth(token) <= budget) {
      current = token;
      continue;
    }
    const pieces = hardBreakToken(token, budget);
    for (let index = 0; index < pieces.length - 1; index += 1) lines.push(pieces[index] ?? "");
    current = pieces[pieces.length - 1] ?? "";
  }
  if (current.length > 0) lines.push(current);
  return lines.length === 0 ? [""] : lines;
};

const repeat = (glyph: string, count: number): string => glyph.repeat(Math.max(0, count));

/** Minimum width below which box framing is skipped to stay readable. */
export const MIN_BOX_WIDTH = 16 as const;

const capLine = (left: string, title: string, right: string, width: number): string => {
  const innerBudget = Math.max(1, width - displayWidth(left) - displayWidth(right) - 2);
  const fitted = truncateToWidth(title, innerBudget);
  const prefix = `${left} ${fitted} `;
  const fill = width - displayWidth(prefix) - displayWidth(right);
  return `${prefix}${repeat("─", fill)}${right}`;
};

/** Top frame line: `╭─ TITLE ──────╮`. */
export const boxTop = (title: string, width: number): string => capLine("╭─", title, "╮", width);

/** Bottom frame line: `╰─ TITLE ──────╯`, with optionally styled content. */
export const boxBottom = (title: string, width: number, style?: (content: string) => string): string => {
  const innerBudget = Math.max(1, width - displayWidth("╰─") - displayWidth("╯") - 2);
  const fitted = truncateToWidth(title, innerBudget);
  const content = style === undefined ? ` ${fitted} ` : style(` ${fitted} `);
  const fill = width - displayWidth(`╰─ ${fitted} `) - displayWidth("╯");
  return `${csi.pink}╰─${csi.reset}${content}${csi.pink}${repeat("─", fill)}╯${csi.reset}`;
};

/** Mid-frame separator: `├─ TITLE ──────┤`. */
export const boxSeparator = (title: string, width: number): string => capLine("├─", title, "┤", width);

/** Body line: `│ text<padding> │`, with pink borders and optionally styled content. */
export const boxBody = (text: string, width: number, style?: (content: string) => string): string => {
  const innerWidth = Math.max(1, width - 4);
  const fitted = truncateToWidth(text, innerWidth);
  const padding = repeat(" ", innerWidth - displayWidth(fitted));
  const content = style === undefined ? fitted : style(fitted);
  return `${csi.pink}│${csi.reset} ${content}${padding} ${csi.pink}│${csi.reset}`;
};

export type SummaryTone = "ok" | "warn" | "error" | "info" | "pending" | "skipped";

const TONE_CHIP_TEXT: Record<SummaryTone, string> = {
  ok: "OK",
  warn: "WARN",
  error: "FAIL",
  info: "INFO",
  pending: "WAIT",
  skipped: "SKIP",
};

const TONE_COLOR: Record<SummaryTone, string> = {
  ok: csi.green,
  warn: csi.amber,
  error: csi.red,
  info: csi.cyan,
  pending: csi.amber,
  skipped: csi.dim,
};

/**
 * Status chip whose readable text carries the tone. The chip is plain text;
 * color is applied to the whole line (see {@link paintTone}) so status is never
 * color-only and truncation never clips an escape sequence mid-line.
 */
export const toneChip = (tone: SummaryTone): string => `[${TONE_CHIP_TEXT[tone]}]`;

/** Pad `text` to `width` columns (display-aware) for aligned label columns. */
export const padEndToWidth = (text: string, width: number): string =>
  `${text}${repeat(" ", width - displayWidth(text))}`;

/** ANSI accents for the framed surfaces, mirroring the task-tree cockpit palette. */
export const styleBoxTop = (line: string): string => `${csi.bold}${csi.pink}${line}${csi.reset}`;
export const styleBoxBottom = (line: string): string =>
  `${csi.dim}${csi.cyan}${line}${csi.dimReset}${csi.reset}`;
export const styleBoxFooter = (line: string): string =>
  `${csi.dim}${csi.pink}${line}${csi.dimReset}${csi.reset}`;
export const styleBoxSeparator = (line: string): string => `${csi.pink}${line}${csi.reset}`;
export const dimText = (text: string): string => `${csi.dim}${text}${csi.dimReset}${csi.reset}`;

/** Color a whole line by tone; skipped/pending read dim so the chip text leads. */
export const paintTone = (tone: SummaryTone, line: string): string => {
  const color = TONE_COLOR[tone];
  return color === csi.dim ? `${csi.dim}${line}${csi.dimReset}${csi.reset}` : `${color}${line}${csi.reset}`;
};
