/**
 * Rail grouped-summary formatter: the task tree's frame language (pink
 * `╭─ │ ├─ ╰─`, single-cell `✓ ! ✗` glyphs) applied to a static report, so a
 * result printed under a live tree reads as the same surface. Rows carry their
 * details on dim indented lines and a suggested fix on a `↳` line whose
 * backtick-quoted commands are painted cyan.
 *
 * The document is already redacted; public callers go through
 * {@link formatRailSummary} in `summary.ts`.
 */

import {
  REMEDY_ARROW,
  cyanText,
  dimText,
  displayWidth,
  hyperlink,
  paintCodeSpans,
  paintRail,
  paintTone,
  paintToneBold,
  toneGlyph,
  truncateToWidth,
  wrapToWidth,
} from "./console-layout.ts";
import type { SummaryDocument, SummaryRow, SummarySection } from "./summary.ts";

const MIN_SUMMARY_WIDTH = 10;
const DEFAULT_SUMMARY_WIDTH = 80;
/** `│ ` before every body line. */
const RAIL_WIDTH = 2;
/** Details sit under the row label, past its `! ` glyph. */
const DETAIL_INDENT = 2;
const FIELD_SEPARATOR = " · ";

type Style = (segment: string) => string;

const resolveWidth = (columns: number | undefined): number =>
  Math.max(MIN_SUMMARY_WIDTH, columns ?? DEFAULT_SUMMARY_WIDTH);

const railLine = (content = ""): string =>
  content.length === 0 ? paintRail("│") : `${paintRail("│")} ${content}`;

/**
 * Wrap `raw` under the rail at `indent`, with continuation lines hung a further
 * `hang` cells. `paint` receives every wrapped segment at once so styles that
 * track state across lines (code spans) stay continuous.
 */
const pushWrapped = (
  lines: string[],
  raw: string,
  budget: number,
  indent: number,
  hang: number,
  paint: (segments: ReadonlyArray<string>) => ReadonlyArray<string>,
): void => {
  const segments = wrapToWidth(raw, Math.max(1, budget - indent - hang));
  paint(segments).forEach((segment, index) => {
    const pad = " ".repeat(index === 0 ? indent : indent + hang);
    lines.push(railLine(`${pad}${segment}`));
  });
};

const each =
  (style: Style | undefined) =>
  (segments: ReadonlyArray<string>): ReadonlyArray<string> =>
    style === undefined ? segments : segments.map(style);

const rowLabelStyle = (row: SummaryRow): Style | undefined => {
  const tone = row.tone;
  const muted = row.muted === true;
  const href = row.href;
  if (tone === undefined && !muted && href === undefined) return undefined;
  return (segment) => {
    const toned = tone === undefined ? segment : paintTone(tone, segment);
    const dimmed = muted ? dimText(toned) : toned;
    return href === undefined ? dimmed : hyperlink(dimmed, href);
  };
};

const pushRowHead = (lines: string[], row: SummaryRow, budget: number): void => {
  const glyph = row.tone === undefined ? "" : `${toneGlyph(row.tone)} `;
  const head = `${glyph}${row.label}`;
  const value = row.value === undefined || row.value.length === 0 ? "" : `  ${row.value}`;
  const labelStyle = rowLabelStyle(row);
  if (displayWidth(head) + displayWidth(value) <= budget) {
    const paintedHead = labelStyle === undefined ? head : labelStyle(head);
    lines.push(railLine(`${paintedHead}${value.length === 0 ? "" : dimText(value)}`));
    return;
  }
  pushWrapped(lines, `${head}${value}`, budget, 0, displayWidth(glyph), each(labelStyle));
};

const rowHasBody = (row: SummaryRow): boolean =>
  (row.fields !== undefined && row.fields.length > 0) || row.detail !== undefined || row.remedy !== undefined;

/**
 * Pack `label: value` pairs onto lines whole, so a wrap never strands the
 * separator or splits a pair; only a pair wider than the line itself wraps.
 */
const packFields = (items: ReadonlyArray<string>, width: number): ReadonlyArray<string> => {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const candidate = current.length === 0 ? item : `${current}${FIELD_SEPARATOR}${item}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    const pieces = wrapToWidth(item, width);
    lines.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1] ?? "";
  }
  if (current.length > 0) lines.push(current);
  return lines;
};

const pushRow = (lines: string[], row: SummaryRow, budget: number): void => {
  pushRowHead(lines, row, budget);
  if (row.fields !== undefined && row.fields.length > 0) {
    const items = row.fields.map((field) => `${field.label}: ${field.value}`);
    const pad = " ".repeat(DETAIL_INDENT);
    for (const line of packFields(items, Math.max(1, budget - DETAIL_INDENT))) {
      lines.push(railLine(`${pad}${dimText(line)}`));
    }
  }
  if (row.detail !== undefined) pushWrapped(lines, row.detail, budget, DETAIL_INDENT, 0, each(dimText));
  if (row.remedy !== undefined) {
    pushWrapped(lines, row.remedy, budget, DETAIL_INDENT, displayWidth(REMEDY_ARROW), (segments) =>
      paintCodeSpans(segments).map((segment, index) =>
        index === 0 ? `${dimText(REMEDY_ARROW)}${segment}` : segment,
      ),
    );
  }
};

const pushSection = (lines: string[], section: SummarySection, budget: number): void => {
  lines.push(railLine());
  const title = section.tone === undefined ? section.title : `${toneGlyph(section.tone)} ${section.title}`;
  pushWrapped(lines, title, budget, 0, 0, each(dimText));
  if (section.rows.length === 0 && (section.notes === undefined || section.notes.length === 0)) {
    pushWrapped(lines, "(none)", budget, DETAIL_INDENT, 0, each(dimText));
  }
  section.rows.forEach((row, index) => {
    pushRow(lines, row, budget);
    const next = section.rows[index + 1];
    if (next !== undefined && (rowHasBody(row) || rowHasBody(next))) lines.push(railLine());
  });
  for (const note of section.notes ?? []) pushWrapped(lines, note, budget, DETAIL_INDENT, 0, each(undefined));
};

export const formatPreparedRailSummary = (doc: SummaryDocument, columns?: number | undefined): string => {
  const width = resolveWidth(columns);
  const budget = width - RAIL_WIDTH;
  const lines: string[] = [];

  const title = truncateToWidth(doc.title, Math.max(1, width - 3));
  lines.push(`${paintRail("╭─")} ${doc.tone === undefined ? title : paintToneBold(doc.tone, title)}`);
  if (doc.subtitle !== undefined) pushWrapped(lines, doc.subtitle, budget, 0, 0, each(dimText));

  for (const section of doc.sections) pushSection(lines, section, budget);

  if (doc.nextSteps !== undefined && doc.nextSteps.length > 0) {
    lines.push(railLine());
    lines.push(`${paintRail("├─")} ${dimText("next")}`);
    for (const step of doc.nextSteps) pushWrapped(lines, step, budget, 0, 0, each(cyanText));
  } else if (doc.sections.length > 0) {
    lines.push(railLine());
  }

  const footer = doc.footer ?? "";
  if (footer.length === 0) {
    lines.push(paintRail("╰─"));
  } else {
    wrapToWidth(footer, Math.max(1, width - 3)).forEach((segment, index) => {
      lines.push(index === 0 ? `${paintRail("╰─")} ${dimText(segment)}` : `   ${dimText(segment)}`);
    });
  }
  return lines.join("\n");
};
