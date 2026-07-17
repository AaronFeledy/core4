const ESC = String.fromCharCode(27);

export const csi = {
  dim: `${ESC}[2m`,
  dimReset: `${ESC}[22m`,
  bold: `${ESC}[1m`,
  reset: `${ESC}[0m`,
  cyan: `${ESC}[36m`,
  pink: `${ESC}[95m`,
  green: `${ESC}[32m`,
  amber: `${ESC}[33m`,
  red: `${ESC}[31m`,
} as const;

const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const DEFAULT_TERMINAL_COLUMNS = 80;

const visibleLength = (line: string): number => Bun.stringWidth(line.replace(ansiPattern, ""));

const takeVisibleWidth = (text: string, width: number): string => {
  let result = "";
  let cells = 0;
  for (const character of text) {
    const next = Bun.stringWidth(character);
    if (cells + next > width) break;
    result += character;
    cells += next;
  }
  return result;
};

const normalizeTerminalColumns = (terminalColumns: number | undefined): number =>
  terminalColumns === undefined ? DEFAULT_TERMINAL_COLUMNS : Math.max(1, Math.trunc(terminalColumns));

const splitContentToWidth = (content: string, width: number): ReadonlyArray<string> => {
  if (visibleLength(content) <= width) return [content];
  const words = content.split(/(\s+)/).filter((part) => part.length > 0);
  const lines: string[] = [];
  let current = "";
  const budget = Math.max(1, width);

  const pushCurrent = (): void => {
    if (current.length === 0) return;
    lines.push(current.trimEnd());
    current = "";
  };

  for (const word of words) {
    if (visibleLength(current) + visibleLength(word) <= budget) {
      current += word;
      continue;
    }
    if (current.trim().length > 0) pushCurrent();
    let remaining = word.trimStart();
    while (visibleLength(current) + visibleLength(remaining) > budget) {
      const available = Math.max(1, budget - visibleLength(current));
      const head = takeVisibleWidth(remaining, available);
      if (head === "") break;
      current += head;
      remaining = remaining.slice(head.length);
      pushCurrent();
    }
    current += remaining;
  }

  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines.length === 0 ? [takeVisibleWidth(content, width)] : lines;
};

const capLine = (left: string, text: string, right: string, width: number): string => {
  const maxTextWidth = Math.max(1, width - visibleLength(left) - visibleLength(right) - 2);
  const fittedText =
    visibleLength(text) <= maxTextWidth ? text : `${takeVisibleWidth(text, Math.max(1, maxTextWidth - 1))}…`;
  const prefix = `${left} ${fittedText} `;
  const fill = Math.max(0, width - visibleLength(prefix) - visibleLength(right));
  return `${prefix}${"─".repeat(fill)}${right}`;
};

const bodyLine = (text: string, width: number): string => {
  const bodyWidth = Math.max(1, width - 4);
  const padding = Math.max(0, bodyWidth - visibleLength(text));
  return `│ ${text}${" ".repeat(padding)} │`;
};

export const styleBodyFrame = (line: string, styleStart: string, styleEnd: string): string => {
  const hasTrailingFrame = line.length > 1 && line.endsWith("│");
  const content = line.slice(1, hasTrailingFrame ? -1 : undefined);
  const trailingFrame = hasTrailingFrame ? `${csi.pink}│${csi.reset}` : "";
  return `${csi.pink}${line.slice(0, 1)}${csi.reset}${styleStart}${content}${styleEnd}${trailingFrame}`;
};

export const styleBottomFrame = (line: string): string => {
  let trailingFrameStart = line.length;
  if (line.endsWith("╯")) {
    trailingFrameStart -= 1;
    while (trailingFrameStart > 2 && line[trailingFrameStart - 1] === "─") trailingFrameStart -= 1;
  }
  const content = line.slice(2, trailingFrameStart);
  const trailingFrame = line.slice(trailingFrameStart);
  const styledTrailingFrame = trailingFrame.length === 0 ? "" : `${csi.pink}${trailingFrame}${csi.reset}`;
  return `${csi.pink}${line.slice(0, 2)}${csi.reset}${csi.dim}${csi.pink}${content}${csi.dimReset}${csi.reset}${styledTrailingFrame}`;
};

export const wrapFrameLines = (
  lines: ReadonlyArray<string>,
  terminalColumns: number | undefined,
): ReadonlyArray<string> => {
  const columns = normalizeTerminalColumns(terminalColumns);
  const framed = lines.flatMap((line) => {
    if (line.startsWith("╭─")) return [capLine("╭─", line.slice(2).trim(), "╮", columns)];
    if (line.startsWith("╰─")) return [capLine("╰─", line.slice(2).trim(), "╯", columns)];
    if (line.startsWith("│")) {
      const hangingIndent = line.startsWith("│    ") ? "  " : "";
      const content = line.slice(1).trimStart();
      const contentWidth = Math.max(1, columns - 4 - visibleLength(hangingIndent));
      return splitContentToWidth(content, contentWidth).map((segment) =>
        bodyLine(`${hangingIndent}${segment}`, columns),
      );
    }
    return splitContentToWidth(line, columns).map((segment) => bodyLine(segment, columns));
  });
  return framed.map((line) => takeVisibleWidth(line, columns));
};
