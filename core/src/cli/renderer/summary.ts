/**
 * Typed grouped-summary model and the decorated formatter for the default
 * `lando` TTY renderer. Commands build a {@link SummaryDocument} from their
 * typed result and hand it to {@link formatSummary}; the boundary calls this
 * only in the decorated path (`lando` mode on a TTY), so `plain`/`json`/non-TTY
 * keep their existing undecorated output.
 *
 * The formatter renders already-redacted values verbatim; redaction stays at
 * the command/result layer, never here.
 */

import {
  type SummaryTone,
  boxBody,
  boxBottom,
  boxSeparator,
  boxTop,
  displayWidth,
  padEndToWidth,
  paintTone,
  styleBoxBottom,
  styleBoxSeparator,
  styleBoxTop,
  toneChip,
  wrapToWidth,
} from "./console-layout.ts";

export type { SummaryTone };

export const worstSummaryTone = (tones: ReadonlyArray<SummaryTone>): SummaryTone => {
  if (tones.includes("error")) return "error";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("pending")) return "warn";
  if (tones.includes("skipped")) return "warn";
  if (tones.includes("ok")) return "ok";
  return "info";
};

export interface SummaryField {
  readonly label: string;
  readonly value: string;
}

export interface SummaryRow {
  readonly label: string;
  readonly tone?: SummaryTone;
  readonly value?: string;
  readonly detail?: string;
  readonly fields?: ReadonlyArray<SummaryField>;
}

export interface SummarySection {
  readonly title: string;
  readonly tone?: SummaryTone;
  readonly rows: ReadonlyArray<SummaryRow>;
  readonly notes?: ReadonlyArray<string>;
}

export interface SummaryDocument {
  readonly title: string;
  readonly tone?: SummaryTone;
  readonly subtitle?: string;
  readonly sections: ReadonlyArray<SummarySection>;
  readonly nextSteps?: ReadonlyArray<string>;
  readonly footer?: string;
}

export interface FormatSummaryOptions {
  readonly columns?: number | undefined;
}

const MIN_SUMMARY_WIDTH = 24;
const DEFAULT_SUMMARY_WIDTH = 80;

const resolveWidth = (columns: number | undefined): number =>
  Math.max(MIN_SUMMARY_WIDTH, columns ?? DEFAULT_SUMMARY_WIDTH);

const headerTitle = (doc: SummaryDocument): string => {
  const chip = doc.tone === undefined ? "" : ` ${toneChip(doc.tone)}`;
  const subtitle = doc.subtitle === undefined ? "" : `  ${doc.subtitle}`;
  return `${doc.title}${chip}${subtitle}`;
};

const sectionTitle = (section: SummarySection): string =>
  section.tone === undefined ? section.title : `${section.title} ${toneChip(section.tone)}`;

const rowHead = (row: SummaryRow): string => {
  const chip = row.tone === undefined ? "" : `${toneChip(row.tone)} `;
  const value = row.value === undefined ? "" : ` · ${row.value}`;
  return `${chip}${row.label}${value}`;
};

export const formatSummary = (doc: SummaryDocument, options: FormatSummaryOptions = {}): string => {
  const width = resolveWidth(options.columns);
  const innerWidth = width - 4;
  const lines: string[] = [];

  const pushBody = (raw: string, indent: number, style: ((line: string) => string) | undefined): void => {
    const pad = " ".repeat(indent);
    for (const segment of wrapToWidth(raw, Math.max(1, innerWidth - indent))) {
      lines.push(boxBody(`${pad}${segment}`, width, style));
    }
  };

  lines.push(styleBoxTop(boxTop(headerTitle(doc), width)));

  for (const section of doc.sections) {
    lines.push(styleBoxSeparator(boxSeparator(sectionTitle(section), width)));
    if (section.rows.length === 0 && (section.notes === undefined || section.notes.length === 0))
      pushBody("(none)", 2, undefined);
    for (const row of section.rows) {
      const rowTone = row.tone;
      const rowStyle = rowTone === undefined ? undefined : (line: string) => paintTone(rowTone, line);
      pushBody(rowHead(row), 0, rowStyle);
      if (row.fields !== undefined && row.fields.length > 0) {
        const labelWidth = Math.max(...row.fields.map((field) => displayWidth(field.label)));
        for (const field of row.fields) {
          pushBody(`${padEndToWidth(field.label, labelWidth)} : ${field.value}`, 2, styleBoxBottom);
        }
      }
      if (row.detail !== undefined) pushBody(row.detail, 2, styleBoxBottom);
    }
    if (section.notes !== undefined) {
      for (const note of section.notes) pushBody(`• ${note}`, 2, styleBoxBottom);
    }
  }

  if (doc.nextSteps !== undefined && doc.nextSteps.length > 0) {
    lines.push(styleBoxSeparator(boxSeparator("next steps", width)));
    for (const step of doc.nextSteps) pushBody(`• ${step}`, 2, undefined);
  }

  lines.push(boxBottom(doc.footer ?? "", width, styleBoxBottom));
  return lines.join("\n");
};
