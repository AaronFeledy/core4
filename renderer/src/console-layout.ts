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
const osc8Pattern = new RegExp(`${ESC}\\]8;.*?(?:${ESC}\\\\|\\x07)`, "g");

/** Strip CSI/SGR and OSC 8 sequences so width math sees only visible glyphs. */
export const stripAnsi = (text: string): string => text.replace(osc8Pattern, "").replace(ansiPattern, "");

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
  defaultFg: `${ESC}[39m`,
} as const;

const hasC0OrDel = (value: string): boolean => {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) return true;
  }
  return false;
};

const isSafeHttpHref = (href: string): boolean =>
  href.length > 0 && (href.startsWith("https://") || href.startsWith("http://")) && !hasC0OrDel(href);

/** Wrap `text` in OSC 8 ST hyperlinks when `href` is a safe non-empty http(s) URL. */
export const hyperlink = (text: string, href: string): string => {
  if (!isSafeHttpHref(href)) return text;
  const terminator = `${ESC}\\`;
  return `${ESC}]8;;${href}${terminator}${text}${ESC}]8;;${terminator}`;
};

/**
 * Width is measured in terminal cells per grapheme cluster, never per code
 * point: `Bun.stringWidth` supplies the cell count (wide CJK and emoji
 * presentation are 2, combining marks and joiners are 0) and `Intl.Segmenter`
 * supplies cluster boundaries so a flag, skin-tone modifier, or ZWJ family is
 * never split by truncation or a hard break. The segmenter is built on first use.
 */
let graphemeSegmenter: Intl.Segmenter | undefined;

const graphemes = (text: string): ReadonlyArray<string> => {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(graphemeSegmenter.segment(text), (entry) => entry.segment);
};

/** Visible terminal width of `text`, counting wide glyphs as 2 and ignoring ANSI. */
export const displayWidth = (text: string): number => Bun.stringWidth(stripAnsi(text));

const ELLIPSIS = "…";

const LINE_BREAKS = /\r\n|\r|\n/gu;

/** True when `text` contains a hard line break that must start a new row. */
export const hasLineBreak = (text: string): boolean => /[\r\n]/u.test(text);

/** Truncate `text` to at most `max` columns, appending an ellipsis when clipped. */
export const truncateToWidth = (input: string, max: number): string => {
  // Truncation targets single-line surfaces (frame titles, footers); a line
  // break there would escape the frame, so it reads as a space.
  const text = input.replace(LINE_BREAKS, " ");
  if (displayWidth(text) <= max) return text;
  if (max <= 1) return ELLIPSIS;
  const budget = max - 1;
  let width = 0;
  let out = "";
  for (const grapheme of graphemes(stripAnsi(text))) {
    const w = displayWidth(grapheme);
    if (width + w > budget) break;
    out += grapheme;
    width += w;
  }
  return `${out}${ELLIPSIS}`;
};

const hardBreakToken = (token: string, width: number): ReadonlyArray<string> => {
  const segments: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const grapheme of graphemes(token)) {
    const w = displayWidth(grapheme);
    if (currentWidth + w > width && current.length > 0) {
      segments.push(current);
      current = "";
      currentWidth = 0;
    }
    current += grapheme;
    currentWidth += w;
  }
  if (current.length > 0) segments.push(current);
  return segments.length === 0 ? [""] : segments;
};

/** Word-wrap `text` to `width` columns, hard-breaking tokens that cannot fit. */
export const wrapToWidth = (text: string, width: number): ReadonlyArray<string> => {
  if (!hasLineBreak(text)) return wrapLineToWidth(text, width);
  // Each embedded line break starts a new physical row; blank rows are dropped
  // so callers that indent every row never emit whitespace-only lines.
  const lines = text
    .split(LINE_BREAKS)
    .flatMap((line) => (line.trim().length === 0 ? [] : wrapLineToWidth(line, width)));
  return lines.length === 0 ? [""] : lines;
};

const wrapLineToWidth = (text: string, width: number): ReadonlyArray<string> => {
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

/** Narrowest width the summary layouts render at; below this a frame has no room for content. */
export const MIN_SUMMARY_WIDTH = 10;
/** Width assumed when the terminal does not report a usable column count. */
export const DEFAULT_SUMMARY_WIDTH = 80;

/**
 * Resolve a summary width from a reported column count. `undefined`,
 * non-finite, and non-positive counts mean the terminal size is unknown (a
 * detached or zero-sized stdout), so they read as the default, not the minimum.
 */
export const resolveSummaryWidth = (columns: number | undefined): number =>
  Math.max(
    MIN_SUMMARY_WIDTH,
    columns !== undefined && Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_SUMMARY_WIDTH,
  );

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

/** Prefix for a suggested-fix line under a summary row. */
export const REMEDY_ARROW = "↳ ";

/** Pad `text` to `width` columns (display-aware) for aligned label columns. */
export const padEndToWidth = (text: string, width: number): string =>
  `${text}${repeat(" ", width - displayWidth(text))}`;

/**
 * Wrap field values without changing their bytes. Prefer the last ordinary
 * space that fits, leaving that space on the preceding line; oversized tokens
 * are split at the width limit.
 */
const wrapFieldValueToWidth = (value: string, width: number): ReadonlyArray<string> => {
  const budget = Math.max(1, width);
  const lines: string[] = [];
  let remaining = value;
  while (displayWidth(remaining) > budget) {
    let end = 0;
    let used = 0;
    let lastSpaceEnd = 0;
    for (const grapheme of graphemes(remaining)) {
      const graphemeWidth = displayWidth(grapheme);
      if (used + graphemeWidth > budget) break;
      end += grapheme.length;
      used += graphemeWidth;
      if (grapheme === " ") lastSpaceEnd = end;
    }
    const breakAt = lastSpaceEnd > 0 && /\S/u.test(remaining.slice(0, lastSpaceEnd)) ? lastSpaceEnd : end;
    if (breakAt === 0) return [...lines, ...hardBreakToken(remaining, budget)];
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  lines.push(remaining);
  return lines;
};

/** Each embedded line break in a field value starts a new physical row. */
const wrapFieldValueLines = (value: string, width: number): ReadonlyArray<string> =>
  value.split(LINE_BREAKS).flatMap((part) => wrapFieldValueToWidth(part, width));

/** Width of the ` : ` separator between a field label and its value. */
const FIELD_SEPARATOR_WIDTH = 3;
/** Fewest columns a value keeps beside its label; a label that leaves less stacks instead. */
const MIN_FIELD_VALUE_WIDTH = 8;

/**
 * Shared label column for a group of fields laid out in `width` columns: the
 * widest label that still leaves {@link MIN_FIELD_VALUE_WIDTH} columns for its
 * value. Wider labels stack over their value (see {@link wrapFieldToWidth})
 * instead of squeezing the column or being split to fit it.
 */
export const fieldLabelWidth = (labels: ReadonlyArray<string>, width: number): number => {
  const cap = width - FIELD_SEPARATOR_WIDTH - MIN_FIELD_VALUE_WIDTH;
  return Math.max(0, ...labels.map(displayWidth).filter((labelWidth) => labelWidth <= cap));
};

/**
 * Stacked field: `label :` on its own line, then the value wrapped across the
 * full field width beneath it. The label is split only when it cannot fit
 * beside its separator at all.
 */
const stackFieldToWidth = (label: string, value: string, width: number): ReadonlyArray<string> => {
  const labels = wrapToWidth(label, Math.max(1, width - 2));
  const lastLabel = labels[labels.length - 1] ?? "";
  return [...labels.slice(0, -1), `${lastLabel} :`, ...wrapFieldValueLines(value, width)];
};

/**
 * Keep the field separator aligned while long values wrap. A label wider than
 * the shared `labelWidth` column stacks over its value rather than being split.
 */
export const wrapFieldToWidth = (
  label: string,
  value: string,
  labelWidth: number,
  width: number,
): ReadonlyArray<string> => {
  if (hasLineBreak(label) || displayWidth(label) > labelWidth) return stackFieldToWidth(label, value, width);
  const prefix = `${padEndToWidth(label, labelWidth)} : `;
  const prefixWidth = displayWidth(prefix);
  if (!/\s/u.test(value) && displayWidth(value) > width - prefixWidth && displayWidth(value) <= width) {
    return [prefix.slice(0, -1), value];
  }
  const values = wrapFieldValueLines(value, width - prefixWidth);
  return [
    `${prefix}${values[0] ?? ""}`,
    ...values.slice(1).map((line) => `${repeat(" ", prefixWidth)}${line}`),
  ];
};

/** ANSI accents for the framed surfaces, mirroring the task-tree cockpit palette. */
export const styleBoxTop = (line: string): string => `${csi.bold}${csi.pink}${line}${csi.reset}`;
export const styleBoxBottom = (line: string): string => `${csi.cyan}${line}${csi.reset}`;
export const styleBoxFooter = (line: string): string =>
  `${csi.dim}${csi.pink}${line}${csi.dimReset}${csi.reset}`;
export const styleBoxSeparator = (line: string): string => `${csi.pink}${line}${csi.reset}`;
export const dimText = (text: string): string => `${csi.dim}${text}${csi.dimReset}${csi.reset}`;

/** Color a whole line by tone; skipped/pending read dim so the chip text leads. */
export const paintTone = (tone: SummaryTone, line: string): string => {
  const color = TONE_COLOR[tone];
  return color === csi.dim ? `${csi.dim}${line}${csi.dimReset}${csi.reset}` : `${color}${line}${csi.reset}`;
};

const TONE_GLYPH: Record<SummaryTone, string> = {
  ok: "✓",
  warn: "!",
  error: "✗",
  info: "·",
  pending: "◌",
  skipped: "–",
};

/**
 * Single-cell status glyph matching the task-tree painter. Warn is ASCII `!`
 * because `⚠` renders with emoji presentation in most terminal fonts and
 * spills past its one measured cell.
 */
export const toneGlyph = (tone: SummaryTone): string => TONE_GLYPH[tone];

/** Pink rail/frame chrome shared with the task tree (`╭─`, `│`, `├─`, `╰─`). */
export const paintRail = (text: string): string => `${csi.pink}${text}${csi.reset}`;

/** Bold text in the tone color, for a summary title. */
export const paintToneBold = (tone: SummaryTone, text: string): string =>
  `${csi.bold}${TONE_COLOR[tone]}${text}${csi.reset}`;

/** Cyan text, the palette color for commands. */
export const cyanText = (text: string): string => `${csi.cyan}${text}${csi.defaultFg}`;

/**
 * Paint backtick-quoted spans cyan across already-wrapped lines. A span that
 * wraps stays painted on its continuation line; backticks stay visible so the
 * text still reads as code without color.
 */
export const paintCodeSpans = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  let inCode = false;
  return lines.map((line) => {
    let out = inCode ? csi.cyan : "";
    for (const ch of line) {
      if (ch === "`") {
        out += inCode ? `${ch}${csi.defaultFg}` : `${csi.cyan}${ch}`;
        inCode = !inCode;
      } else {
        out += ch;
      }
    }
    return inCode ? `${out}${csi.defaultFg}` : out;
  });
};
