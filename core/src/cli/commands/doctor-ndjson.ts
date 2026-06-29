import { Effect, Schema } from "effect";

import { StreamFrame } from "@lando/sdk/schema";

import { encodeStreamResultFrame, identityRedactor } from "../result-encode.ts";

export type DoctorNdjsonStatus = "pass" | "warn" | "fail";

export interface DoctorNdjsonCheck {
  readonly status: DoctorNdjsonStatus;
}

export interface DoctorNdjsonRenderOptions<Check extends DoctorNdjsonCheck> {
  readonly command?: string;
  readonly checks: ReadonlyArray<Check>;
  readonly now?: Date | undefined;
  readonly checkEventPayload: (check: Check) => Record<string, unknown>;
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

export const renderDoctorChecksAsNdjson = <Check extends DoctorNdjsonCheck>({
  command = "meta:doctor",
  checks,
  now,
  checkEventPayload,
}: DoctorNdjsonRenderOptions<Check>): string => {
  const timestamp = (now ?? new Date()).toISOString();
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(
      JSON.stringify(
        Schema.encodeSync(StreamFrame)({
          _tag: "event",
          event: "doctor.check",
          payload: checkEventPayload(check),
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
        redactor: identityRedactor,
      }),
    ),
  );
  return `${lines.join("\n")}\n`;
};
