/**
 * Typed grouped-summary model and the decorated formatter for the default
 * `lando` TTY renderer. Commands build a {@link SummaryDocument} from their
 * typed result and hand it to {@link formatSummary}; the boundary calls this
 * only in the decorated path (`lando` mode on a TTY), so `plain`/`json`/non-TTY
 * keep their existing undecorated output.
 *
 * The formatter paints already-redacted values; callers may pass `options.redact` so fields are masked before SGR. Redaction never rewrites painted output.
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
  styleBoxFooter,
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
  /** Applied to every document string before paint so SGR is never redacted. */
  readonly redact?: ((text: string) => string) | undefined;
}

/** Redact every user-facing string on a summary document, leaving tones intact. */
export const redactSummaryDocument = (
  doc: SummaryDocument,
  redact: (text: string) => string,
): SummaryDocument => ({
  title: redact(doc.title),
  ...(doc.tone === undefined ? {} : { tone: doc.tone }),
  ...(doc.subtitle === undefined ? {} : { subtitle: redact(doc.subtitle) }),
  sections: doc.sections.map((section) => ({
    title: redact(section.title),
    ...(section.tone === undefined ? {} : { tone: section.tone }),
    rows: section.rows.map((row) => ({
      label: redact(row.label),
      ...(row.tone === undefined ? {} : { tone: row.tone }),
      ...(row.value === undefined ? {} : { value: redact(row.value) }),
      ...(row.detail === undefined ? {} : { detail: redact(row.detail) }),
      ...(row.fields === undefined
        ? {}
        : {
            fields: row.fields.map((field) => ({
              label: redact(field.label),
              value: redact(field.value),
            })),
          }),
    })),
    ...(section.notes === undefined ? {} : { notes: section.notes.map(redact) }),
  })),
  ...(doc.nextSteps === undefined ? {} : { nextSteps: doc.nextSteps.map(redact) }),
  ...(doc.footer === undefined ? {} : { footer: redact(doc.footer) }),
});

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
  const prepared = options.redact === undefined ? doc : redactSummaryDocument(doc, options.redact);
  const width = resolveWidth(options.columns);
  const innerWidth = width - 4;
  const lines: string[] = [];

  const pushBody = (raw: string, indent: number, style: ((line: string) => string) | undefined): void => {
    const pad = " ".repeat(indent);
    for (const segment of wrapToWidth(raw, Math.max(1, innerWidth - indent))) {
      lines.push(boxBody(`${pad}${segment}`, width, style));
    }
  };

  lines.push(styleBoxTop(boxTop(headerTitle(prepared), width)));

  for (const section of prepared.sections) {
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

  if (prepared.nextSteps !== undefined && prepared.nextSteps.length > 0) {
    lines.push(styleBoxSeparator(boxSeparator("next steps", width)));
    for (const step of prepared.nextSteps) pushBody(`• ${step}`, 2, undefined);
  }

  lines.push(boxBottom(prepared.footer ?? "", width, styleBoxFooter));
  return lines.join("\n");
};
