import {
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  identityRedactor,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";
import { Effect, Schema } from "effect";
import {
  DoctorCheck,
  type DoctorNdjsonResult,
  DoctorNdjsonResultSchema,
  type DoctorReport,
  DoctorSkip,
} from "./doctor-contract";
import { doctorCompletion } from "./doctor-report-model";

const encodeCheck = Schema.encodeSync(DoctorCheck);
const encodeSkip = Schema.encodeSync(DoctorSkip);

// The renderer boundary has already redacted the report.
export const renderDoctorReportAsNdjson = (report: DoctorReport): string => {
  const lines: string[] = [];
  for (const check of report.checks)
    lines.push(
      Effect.runSync(
        encodeStreamEventFrame({
          event: "doctor.check",
          payload: encodeCheck(check),
          redactor: identityRedactor,
        }),
      ),
    );
  for (const skip of report.skipped)
    lines.push(
      Effect.runSync(
        encodeStreamEventFrame({
          event: "doctor.skip",
          payload: encodeSkip(skip),
          redactor: identityRedactor,
        }),
      ),
    );
  const value: DoctorNdjsonResult = {
    version: report.version,
    ...(report.provider === undefined ? {} : { provider: report.provider }),
    summary: report.summary,
  };
  lines.push(
    Effect.runSync(
      encodeStreamResultFrame({
        command: "meta:doctor",
        resultSchema: DoctorNdjsonResultSchema,
        outcome: resolveCommandCompletion("meta:doctor", value, () => doctorCompletion(report)),
        redactor: identityRedactor,
      }),
    ),
  );
  return lines.join("\n");
};
