import { Schema } from "effect";
import type { NdjsonReport } from "../renderer-machine-output";
import {
  DoctorCheck,
  type DoctorNdjsonResult,
  DoctorNdjsonResultSchema,
  type DoctorReport,
  DoctorSkip,
} from "./doctor-contract";

const encodeCheck = Schema.encodeSync(DoctorCheck);
const encodeSkip = Schema.encodeSync(DoctorSkip);

/**
 * `lando doctor --format=ndjson`: one `doctor.check` event per check, one
 * `doctor.skip` event per skipped entry, then a result frame holding the
 * report's version, provider, summary, and page. Its `ok` and exit code come
 * from the same completion policy as `--format=json`.
 */
export const doctorNdjsonReport: NdjsonReport<DoctorReport> = {
  events: (report) => [
    ...report.checks.map((check) => ({ event: "doctor.check", payload: encodeCheck(check) })),
    ...report.skipped.map((skip) => ({ event: "doctor.skip", payload: encodeSkip(skip) })),
  ],
  resultSchema: DoctorNdjsonResultSchema,
  result: (report): DoctorNdjsonResult => ({
    version: report.version,
    ...(report.provider === undefined ? {} : { provider: report.provider }),
    summary: report.summary,
    ...(report.page === undefined ? {} : { page: report.page }),
  }),
};
