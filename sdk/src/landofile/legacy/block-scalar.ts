import type { LegacyScalarNode } from "./contract.ts";
import type { LegacyScanner } from "./scanner.ts";

const trimTrailing = (text: string, chars: string): string => {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1] ?? "")) end -= 1;
  return end === text.length ? text : text.slice(0, end);
};

export const parseBlockScalar = (scan: LegacyScanner, parentIndent: number): LegacyScalarNode => {
  const start = scan.offset;
  const header = scan.content.slice(start, scan.lineEnd());
  const match = /^([|>])(?:(?:([1-9])([+-])?)|(?:([+-])([1-9])?))?(?:[ \t]+(?:#.*)?)?$/.exec(header);
  if (match === null)
    scan.fail(
      "Invalid block scalar header.",
      start,
      "Use | or > with one indentation digit and one optional + or - chomping indicator.",
    );
  const style = match[1] === "|" ? "literal" : "folded";
  const digit = match[2] ?? match[5];
  const chomp = match[3] ?? match[4];
  // The indicator is relative to the parent, and the document root parent is -1.
  let indent = digit === undefined ? undefined : parentIndent + Number(digit);
  const lines: { readonly text: string; readonly break: boolean; readonly more: boolean }[] = [];
  scan.nextLine();
  let leadingIndent = 0;
  while (!scan.done) {
    const end = scan.lineEnd();
    const raw = scan.content.slice(scan.offset, end);
    const spaces = raw.match(/^ */)?.[0].length ?? 0;
    const blank = /^ *$/.test(raw);
    if (!blank && spaces <= parentIndent) break;
    if (!blank && indent === undefined) {
      indent = spaces;
      if (leadingIndent > indent)
        scan.fail(
          "Malformed indentation before block scalar content.",
          scan.offset,
          "Indent leading blank lines no further than the first content line.",
        );
    }
    if (!blank && spaces < (indent ?? 0)) break;
    if (blank && indent === undefined) leadingIndent = Math.max(leadingIndent, spaces);
    const text = raw.slice(indent ?? spaces);
    lines.push({ text, break: end < scan.content.length, more: /^[ \t]/.test(text) });
    scan.nextLine();
  }
  let text = "";
  const lastContent = lines.findLastIndex((line) => line.text !== "");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const next = lines[index + 1];
    text += line.text;
    if (!line.break) continue;
    if (style === "literal" || next === undefined || line.more || next.more) text += "\n";
    else if (line.text !== "" && next.text !== "") text += " ";
    else if (line.text === "" || index >= lastContent) text += "\n";
    else if (next.text === "") {
      // A blank line before a more-indented line keeps the paragraph break
      // and the blank line. Before ordinary text, the empty line supplies
      // the single paragraph break.
      let following: typeof line | undefined;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor];
        if (candidate !== undefined && candidate.text !== "") {
          following = candidate;
          break;
        }
      }
      if (following?.more) text += "\n";
    }
  }
  if (chomp === "-") text = trimTrailing(text, "\n");
  else if (chomp !== "+") {
    const trimmed = trimTrailing(text, "\n");
    text = lastContent < 0 || trimmed === text ? trimmed : `${trimmed}\n`;
  }
  return scan.scalar(text, style, start);
};
