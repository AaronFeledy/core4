/**
 * Plugin-private terminal-cell width primitive.
 *
 * Every renderer surface measures, truncates, and hard-splits text by terminal
 * display cells and grapheme clusters — never by UTF-16 code units — so wide
 * (CJK) glyphs and multi-code-point emoji stay correctly framed. `Bun.stringWidth`
 * supplies the cell width (and ignores ANSI escapes by default); `Intl.Segmenter`
 * supplies grapheme boundaries so a cluster is never split mid-character.
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const displayWidth = (text: string): number => Bun.stringWidth(text);

export const graphemes = (text: string): ReadonlyArray<string> =>
  Array.from(graphemeSegmenter.segment(text), (entry) => entry.segment);

/**
 * Take the longest leading run of whole graphemes whose combined display width
 * does not exceed `maxWidth`, returning `[head, rest]`. A grapheme is never
 * split; `head` is empty when even the first grapheme is wider than `maxWidth`.
 */
export const takeWidth = (text: string, maxWidth: number): readonly [string, string] => {
  const budget = Math.max(0, maxWidth);
  const parts = graphemes(text);
  let head = "";
  let width = 0;
  let taken = 0;
  for (const grapheme of parts) {
    const graphemeWidth = displayWidth(grapheme);
    if (width + graphemeWidth > budget) break;
    head += grapheme;
    width += graphemeWidth;
    taken += 1;
  }
  return [head, parts.slice(taken).join("")] as const;
};

/**
 * Truncate `text` to at most `maxWidth` display cells, appending `ellipsis`
 * (default `…`) when truncation occurs. Grapheme-safe: the cut never lands
 * inside a cluster, and the ellipsis budget is reserved by display width.
 */
export const truncateToWidth = (text: string, maxWidth: number, ellipsis = "…"): string => {
  if (displayWidth(text) <= maxWidth) return text;
  const [head] = takeWidth(text, Math.max(0, maxWidth - displayWidth(ellipsis)));
  return `${head}${ellipsis}`;
};

/**
 * Hard-wrap `text` into lines whose display width is at most `maxWidth`.
 * Empty text or a non-positive budget yields a single empty line. A grapheme
 * wider than the budget is emitted whole so wrapping always makes progress.
 */
export const wrapToWidth = (text: string, maxWidth: number): readonly string[] => {
  if (text === "" || maxWidth <= 0) return [""];
  const lines: string[] = [];
  let rest = text;
  while (rest !== "") {
    const [head, next] = takeWidth(rest, maxWidth);
    if (head === "") {
      const parts = graphemes(rest);
      const first = parts[0];
      if (first === undefined) break;
      lines.push(first);
      rest = parts.slice(1).join("");
      continue;
    }
    lines.push(head);
    rest = next;
  }
  return lines;
};

/**
 * Wrap `text` on whitespace so lines stay within `maxWidth` display cells.
 * A single token wider than the budget falls back to {@link wrapToWidth}.
 * Empty text or a non-positive budget yields a single empty line.
 */
export const wrapWordsToWidth = (text: string, maxWidth: number): readonly string[] => {
  if (text === "" || maxWidth <= 0) return [""];
  const budget = Math.max(1, maxWidth);
  if (displayWidth(text) <= budget) return [text];
  const tokens = text.split(/(\s+)/).filter((part) => part.length > 0);
  const lines: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length === 0) return;
    lines.push(current.trimEnd());
    current = "";
  };
  for (const token of tokens) {
    if (displayWidth(current) + displayWidth(token) <= budget) {
      current += token;
      continue;
    }
    if (current.trim().length > 0) flush();
    else current = "";
    if (/^\s+$/.test(token)) continue;
    if (displayWidth(token) <= budget) {
      current = token;
      continue;
    }
    for (const piece of wrapToWidth(token, budget)) {
      lines.push(piece);
    }
  }
  flush();
  return lines.length === 0 ? [""] : lines;
};
