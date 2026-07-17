/**
 * Box-framing helpers for the task-tree painter. Every width, truncation, and
 * wrap decision is measured in terminal display cells and split on grapheme
 * boundaries via the shared primitive, so CJK and emoji content stays framed at
 * any width — including below 60 columns.
 */
import { displayWidth, graphemes, takeWidth, truncateToWidth } from "./terminal-width.ts";

const DEFAULT_TERMINAL_COLUMNS = 80;

const normalizeTerminalColumns = (terminalColumns: number | undefined): number =>
  terminalColumns === undefined ? DEFAULT_TERMINAL_COLUMNS : Math.max(1, Math.trunc(terminalColumns));

// A one-word Hangul/Han/Hiragana/Katakana fragment narrow enough to read as an awkward continuation orphan.
const SHORT_CJK_FRAGMENT = /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;
const ORPHAN_MAX_CELLS = 4;

const isShortCjkOrphan = (token: string): boolean =>
  token.length > 0 && displayWidth(token) <= ORPHAN_MAX_CELLS && SHORT_CJK_FRAGMENT.test(token);

/**
 * Pull the previous word onto the final line when that line is only a short CJK
 * fragment, so a semantic tail is never stranded alone — but only when the two
 * still fit the budget and the preceding line keeps at least one word. ASCII
 * tails never match, so ordinary wrapping is untouched.
 */
const rebalanceCjkOrphan = (lines: ReadonlyArray<string>, budget: number): ReadonlyArray<string> => {
  if (lines.length < 2) return lines;
  const last = lines[lines.length - 1] ?? "";
  if (last.includes(" ") || !isShortCjkOrphan(last)) return lines;
  const prevWords = (lines[lines.length - 2] ?? "").split(" ");
  if (prevWords.length < 2) return lines;
  const combined = `${prevWords[prevWords.length - 1]} ${last}`;
  if (displayWidth(combined) > budget) return lines;
  return [...lines.slice(0, -2), prevWords.slice(0, -1).join(" "), combined];
};

const splitContentToWidth = (content: string, width: number): ReadonlyArray<string> => {
  const budget = Math.max(1, width);
  if (displayWidth(content) <= budget) return [content];
  const words = content.split(/(\s+)/).filter((part) => part.length > 0);
  const lines: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current.length === 0) return;
    lines.push(current.trimEnd());
    current = "";
  };
  for (const word of words) {
    if (displayWidth(current) + displayWidth(word) <= budget) {
      current += word;
      continue;
    }
    if (current.trim().length > 0) pushCurrent();
    let remaining = word.trimStart();
    while (displayWidth(current) + displayWidth(remaining) > budget) {
      const available = Math.max(1, budget - displayWidth(current));
      const [head, rest] = takeWidth(remaining, available);
      if (head === "") {
        if (current.length > 0) {
          pushCurrent();
          continue;
        }
        const parts = graphemes(remaining);
        current += parts[0] ?? "";
        remaining = parts.slice(1).join("");
        pushCurrent();
        continue;
      }
      current += head;
      remaining = rest;
      pushCurrent();
    }
    current += remaining;
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  const wrapped = lines.length === 0 ? [takeWidth(content, budget)[0]] : lines;
  return rebalanceCjkOrphan(wrapped, budget);
};

const capLine = (left: string, text: string, right: string, width: number): string => {
  const maxTextWidth = Math.max(1, width - displayWidth(left) - displayWidth(right) - 2);
  const fittedText = truncateToWidth(text, maxTextWidth);
  const prefix = `${left} ${fittedText} `;
  const fill = Math.max(0, width - displayWidth(prefix) - displayWidth(right));
  return `${prefix}${"─".repeat(fill)}${right}`;
};

const bodyLine = (text: string, width: number): string => {
  const bodyWidth = Math.max(1, width - 4);
  const padding = Math.max(0, bodyWidth - displayWidth(text));
  return `│ ${text}${" ".repeat(padding)} │`;
};

export const wrapFrameLines = (
  lines: ReadonlyArray<string>,
  terminalColumns: number | undefined,
): ReadonlyArray<string> => {
  const columns = normalizeTerminalColumns(terminalColumns);
  return lines.flatMap((line) => {
    if (line.startsWith("╭─")) return [capLine("╭─", line.slice(2).trim(), "╮", columns)];
    if (line.startsWith("╰─")) return [capLine("╰─", line.slice(2).trim(), "╯", columns)];
    if (line.startsWith("│")) {
      const hangingIndent = line.startsWith("│    ") ? "  " : "";
      const content = line.slice(1).trimStart();
      const contentWidth = Math.max(1, columns - 4 - displayWidth(hangingIndent));
      return splitContentToWidth(content, contentWidth).map((segment) =>
        bodyLine(`${hangingIndent}${segment}`, columns),
      );
    }
    return splitContentToWidth(line, columns).map((segment) => bodyLine(segment, columns));
  });
};

const physicalRowsForLine = (line: string, terminalColumns: number | undefined): number => {
  const columns = normalizeTerminalColumns(terminalColumns);
  return line
    .split("\n")
    .reduce((rows, segment) => rows + Math.max(1, Math.ceil(displayWidth(segment) / columns)), 0);
};

export const physicalRowsForFrame = (
  frame: ReadonlyArray<string>,
  terminalColumns: number | undefined,
): number => frame.reduce((rows, line) => rows + physicalRowsForLine(line, terminalColumns), 0);

export interface TaskTreeFrameStyles {
  readonly pink: string;
  readonly reset: string;
  readonly dim: string;
  readonly dimReset: string;
}

export const styleBodyFrame = (
  line: string,
  styleStart: string,
  styleEnd: string,
  styles: TaskTreeFrameStyles,
): string => {
  const hasTrailingFrame = line.endsWith("│");
  const content = line.slice(1, hasTrailingFrame ? -1 : undefined);
  const trailingFrame = hasTrailingFrame ? `${styles.pink}│${styles.reset}` : "";
  return `${styles.pink}${line.slice(0, 1)}${styles.reset}${styleStart}${content}${styleEnd}${trailingFrame}`;
};

export const styleBottomFrame = (line: string, styles: TaskTreeFrameStyles): string => {
  let trailingFrameStart = line.length;
  if (line.endsWith("╯")) {
    trailingFrameStart -= 1;
    while (trailingFrameStart > 2 && line[trailingFrameStart - 1] === "─") trailingFrameStart -= 1;
  }
  const content = line.slice(2, trailingFrameStart);
  const trailingFrame = line.slice(trailingFrameStart);
  const styledTrailingFrame =
    trailingFrame.length === 0 ? "" : `${styles.pink}${trailingFrame}${styles.reset}`;
  return `${styles.pink}${line.slice(0, 2)}${styles.reset}${styles.dim}${styles.pink}${content}${styles.dimReset}${styles.reset}${styledTrailingFrame}`;
};
