/**
 * Quiet grouped-summary formatter: whitespace and restrained typography instead
 * of a framed box. Commands that want the boxed cockpit still call
 * {@link formatSummary}; start's decorated TTY path uses this.
 *
 * Paint is applied after wrapping so OSC 8 links close and reopen per segment.
 * The document is already redacted; public callers go through {@link formatQuietSummary}.
 */

import {
  dimText,
  displayWidth,
  hyperlink,
  padEndToWidth,
  paintTone,
  toneChip,
  wrapToWidth,
} from "./console-layout.ts";
import type { SummaryDocument, SummaryRow, SummarySection } from "./summary.ts";

const MIN_SUMMARY_WIDTH = 24;
const DEFAULT_SUMMARY_WIDTH = 80;
const BODY_INDENT = 2;
const FIELD_INDENT = 4;

const resolveWidth = (columns: number | undefined): number =>
  Math.max(MIN_SUMMARY_WIDTH, columns ?? DEFAULT_SUMMARY_WIDTH);

const isOkTone = (tone: SummaryRow["tone"]): boolean => tone === "ok";

const quietRowHead = (row: SummaryRow): string => {
  const tone = row.tone;
  const chip = tone === undefined || isOkTone(tone) ? "" : `${toneChip(tone)} `;
  const value = row.value === undefined ? "" : `  ${row.value}`;
  return `${chip}${row.label}${value}`;
};

const composeQuietRowStyle = (row: SummaryRow): ((line: string) => string) | undefined => {
  const tone = row.tone === undefined || isOkTone(row.tone) ? undefined : row.tone;
  const muted = row.muted === true;
  const href = row.href;
  if (tone === undefined && !muted && href === undefined) return undefined;
  return (line: string) => {
    const toned = tone === undefined ? line : paintTone(tone, line);
    const dimmed = muted ? dimText(toned) : toned;
    return href === undefined ? dimmed : hyperlink(dimmed, href);
  };
};

const pushWrapped = (
  lines: string[],
  raw: string,
  indent: number,
  width: number,
  style: ((line: string) => string) | undefined,
): void => {
  const pad = " ".repeat(indent);
  for (const segment of wrapToWidth(raw, Math.max(1, width - indent))) {
    lines.push(`${pad}${style === undefined ? segment : style(segment)}`);
  }
};

const renderSection = (section: SummarySection, width: number): ReadonlyArray<string> => {
  const lines: string[] = [];
  pushWrapped(lines, section.title, 0, width, dimText);
  if (section.rows.length === 0 && (section.notes === undefined || section.notes.length === 0)) {
    pushWrapped(lines, "(none)", BODY_INDENT, width, undefined);
  }
  for (const row of section.rows) {
    pushWrapped(lines, quietRowHead(row), BODY_INDENT, width, composeQuietRowStyle(row));
    if (row.fields !== undefined && row.fields.length > 0) {
      const labelWidth = Math.max(...row.fields.map((field) => displayWidth(field.label)));
      for (const field of row.fields) {
        pushWrapped(
          lines,
          `${padEndToWidth(field.label, labelWidth)} : ${field.value}`,
          FIELD_INDENT,
          width,
          undefined,
        );
      }
    }
    if (row.detail !== undefined) pushWrapped(lines, row.detail, FIELD_INDENT, width, undefined);
  }
  if (section.notes !== undefined) {
    for (const note of section.notes) pushWrapped(lines, note, BODY_INDENT, width, undefined);
  }
  return lines;
};

export const formatPreparedQuietSummary = (doc: SummaryDocument, columns?: number | undefined): string => {
  const width = resolveWidth(columns);
  const groups: Array<ReadonlyArray<string>> = [];

  const header: string[] = [];
  pushWrapped(header, doc.title, 0, width, undefined);
  if (doc.subtitle !== undefined) pushWrapped(header, doc.subtitle, BODY_INDENT, width, dimText);
  groups.push(header);

  for (const section of doc.sections) groups.push(renderSection(section, width));

  if (doc.nextSteps !== undefined && doc.nextSteps.length > 0) {
    const next: string[] = [];
    pushWrapped(next, "Next", 0, width, dimText);
    for (const step of doc.nextSteps) pushWrapped(next, step, BODY_INDENT, width, undefined);
    groups.push(next);
  }

  if (doc.footer !== undefined && doc.footer.length > 0) {
    const footer: string[] = [];
    pushWrapped(footer, doc.footer, 0, width, dimText);
    groups.push(footer);
  }

  return groups.map((group) => group.join("\n")).join("\n\n");
};
