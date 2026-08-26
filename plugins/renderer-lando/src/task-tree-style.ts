import {
  type BodyStyleSegment,
  csi,
  styleBodyFrame,
  styleBodyFrameSegments,
  styleBottomFrame,
} from "./task-tree-frame.ts";

export const PENDING_MARKER = "◌";
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

type BodyStyle = {
  readonly start: string;
  readonly end: string;
};

const DIM_DURATION: BodyStyle = { start: csi.dim, end: `${csi.dimReset}${csi.reset}` };
const SETTLED_GLYPHS = ["✓", "✗", "–"] as const;
const SPINNER_GLYPHS: ReadonlySet<string> = new Set(SPINNER_FRAMES);
const RUNNING_GLYPHS: ReadonlySet<string> = new Set(["·", ...SPINNER_FRAMES]);

const isRunningGlyphRow = (line: string): boolean => {
  if (!line.startsWith("│ ")) return false;
  const rest = line.slice(2);
  const glyph = rest[0];
  return glyph !== undefined && RUNNING_GLYPHS.has(glyph) && rest.startsWith(`${glyph} `);
};

const isSettledGlyphRow = (line: string): boolean =>
  SETTLED_GLYPHS.some((glyph) => line.startsWith(`│ ${glyph} `));

const selectBodyStyle = (line: string): BodyStyle | undefined => {
  if (line.includes("✗")) return { start: csi.red, end: csi.reset };
  if (line.includes("  cached")) return { start: csi.cyan, end: csi.reset };
  if (line.includes("  skipped"))
    return { start: `${csi.dim}${csi.cyan}`, end: `${csi.dimReset}${csi.reset}` };
  if (line.includes("✓")) return { start: csi.green, end: csi.reset };
  if (line.includes(PENDING_MARKER)) return { start: csi.amber, end: csi.reset };
  if (line.startsWith("│   ")) return { start: csi.dim, end: `${csi.dimReset}${csi.reset}` };
  if (isRunningGlyphRow(line)) return { start: csi.cyan, end: csi.reset };
  return undefined;
};

const bodyContent = (line: string): string =>
  line.slice(1, line.length > 1 && line.endsWith("│") ? -1 : undefined);

const QUIET_DURATION_SUFFIX = / {2}(?:\d+ms|\d+\.\d+s)$/;

const completedBodySegments = (content: string, style: BodyStyle): ReadonlyArray<BodyStyleSegment> => {
  const match = QUIET_DURATION_SUFFIX.exec(content);
  if (match === null) return [{ text: content, start: style.start, end: style.end }];
  const head = content.slice(0, match.index);
  const duration = content.slice(match.index);
  if (head.trim() === "") return [{ text: content, start: DIM_DURATION.start, end: DIM_DURATION.end }];
  return [
    { text: head, start: style.start, end: style.end },
    { text: duration, start: DIM_DURATION.start, end: DIM_DURATION.end },
  ];
};

const runningBodySegments = (content: string, style: BodyStyle): ReadonlyArray<BodyStyleSegment> => {
  if (!content.startsWith(" ")) return [{ text: content, start: style.start, end: style.end }];
  const rest = content.slice(1);
  const glyph = rest[0];
  if (glyph === undefined || !SPINNER_GLYPHS.has(glyph) || !rest.startsWith(`${glyph} `)) {
    return [{ text: content, start: style.start, end: style.end }];
  }
  return [
    { text: ` ${glyph}`, start: csi.pink, end: csi.reset },
    { text: rest.slice(glyph.length), start: style.start, end: style.end },
  ];
};

const paintBody = (line: string, style: BodyStyle, settled: boolean): string => {
  const content = bodyContent(line);
  const segments = settled ? completedBodySegments(content, style) : runningBodySegments(content, style);
  return styleBodyFrameSegments(line, segments);
};

export const styleFrame = (logical: ReadonlyArray<string>): ReadonlyArray<string> => {
  let rowStyle: BodyStyle | undefined;
  let settledRow = false;
  return logical.map((line) => {
    if (line.startsWith("╭─")) {
      rowStyle = undefined;
      settledRow = false;
      return `${csi.pink}╭─${csi.reset}${csi.bold}${line.slice(2)}${csi.reset}`;
    }
    if (line.startsWith("╰─")) {
      rowStyle = undefined;
      settledRow = false;
      return styleBottomFrame(line);
    }
    const selected = selectBodyStyle(line);
    if (selected !== undefined) {
      rowStyle = selected;
      settledRow = isSettledGlyphRow(line);
      return paintBody(line, selected, settledRow);
    }
    if (line.startsWith("│") && rowStyle !== undefined) {
      return paintBody(line, rowStyle, settledRow);
    }
    rowStyle = undefined;
    settledRow = false;
    return line.startsWith("│") ? styleBodyFrame(line, csi.cyan, csi.reset) : line;
  });
};
