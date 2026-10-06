import { DateTime, Effect, Schema } from "effect";

import type { Redactor } from "@lando/sdk/secrets";

import { encodeStreamEventFrame, encodeStreamResultFrame, identityRedactor } from "@lando/sdk/command-result";
import type { DoctorSectionCheck, DoctorSolution } from "./doctor-contract";

export type DoctorNdjsonStatus = "pass" | "warn" | "fail";

export interface DoctorNdjsonCheck {
  readonly status: DoctorNdjsonStatus;
}

export interface DoctorNdjsonRenderOptions<Check extends DoctorNdjsonCheck> {
  readonly command?: string;
  readonly checks: ReadonlyArray<Check>;
  readonly now?: Date | DateTime.DateTime | undefined;
  readonly checkEventPayload: (check: Check) => Record<string, unknown>;
  /** Defaults to {@link identityRedactor} to keep output byte-compatible; inject a `RedactionService` redactor to mask secret-bearing check results. */
  readonly redactor?: Redactor;
}

export const DoctorNdjsonSummarySchema = Schema.Struct({
  timestamp: Schema.String,
  checks: Schema.Number,
  failed: Schema.Number,
  warned: Schema.Number,
});

export type DoctorNdjsonSummary = typeof DoctorNdjsonSummarySchema.Type;

export const orderKnownKeys = <Value>(
  values: Readonly<Record<string, Value>>,
  knownOrder: ReadonlyArray<string>,
): Record<string, Value> => {
  const ordered: Record<string, Value> = {};
  for (const key of knownOrder) {
    if (Object.hasOwn(values, key)) ordered[key] = values[key] as Value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value as Value;
  }
  return ordered;
};

export const doctorSolutionPayloads = (solutions: ReadonlyArray<DoctorSolution>) =>
  solutions.map((solution) => ({
    kind: solution.kind,
    description: solution.description,
    ...(solution.command === undefined ? {} : { command: solution.command }),
  }));

export const sectionCheckEventPayload = (
  check: DoctorSectionCheck,
  contextKeyOrder: ReadonlyArray<string>,
): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  context: orderKnownKeys(check.context, contextKeyOrder),
  solutions: doctorSolutionPayloads(check.solutions),
});

export const renderDoctorChecksAsNdjson = <Check extends DoctorNdjsonCheck>({
  command = "meta:doctor",
  checks,
  now,
  checkEventPayload,
  redactor = identityRedactor,
}: DoctorNdjsonRenderOptions<Check>): string => {
  const timestamp = DateTime.formatIso(now === undefined ? DateTime.nowUnsafe() : DateTime.makeUnsafe(now));
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(
      Effect.runSync(
        encodeStreamEventFrame({
          event: "doctor.check",
          payload: checkEventPayload(check),
          redactor,
        }),
      ),
    );
  }
  let failed = 0;
  let warned = 0;
  for (const check of checks) {
    if (check.status === "fail") failed += 1;
    else if (check.status === "warn") warned += 1;
  }
  const summary: DoctorNdjsonSummary = {
    timestamp,
    checks: checks.length,
    failed,
    warned,
  };
  lines.push(
    Effect.runSync(
      encodeStreamResultFrame({
        command,
        resultSchema: DoctorNdjsonSummarySchema,
        outcome: { _tag: "success", value: summary },
        redactor,
      }),
    ),
  );
  return `${lines.join("\n")}\n`;
};
