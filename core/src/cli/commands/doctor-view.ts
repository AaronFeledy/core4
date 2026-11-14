import { DOCTOR_SECTION_IDS, type DoctorReport, type DoctorStatus } from "./doctor-contract";

export type DoctorViewOptions = {
  readonly statuses?: ReadonlyArray<DoctorStatus> | undefined;
  readonly limit?: number | undefined;
  readonly after?: string | undefined;
};

const sectionOrder: ReadonlyArray<string> = DOCTOR_SECTION_IDS;
const sectionIndex = (id: string): number => sectionOrder.indexOf(id.split("/", 1)[0] ?? "");

const compareIds = (left: string, right: string): number =>
  sectionIndex(left) - sectionIndex(right) || (left < right ? -1 : left > right ? 1 : 0);

/** Select records without changing the whole-run evidence or completion policy. */
export const selectDoctorView = (report: DoctorReport, options: DoctorViewOptions): DoctorReport => {
  const statuses = options.statuses;
  const matched =
    statuses === undefined || statuses.length === 0
      ? report.checks
      : report.checks.filter((check) => statuses.includes(check.status));
  if (options.limit === undefined) return { ...report, checks: matched };
  const remaining = [...matched]
    .sort((left, right) => compareIds(left.id, right.id))
    .filter((check) => options.after === undefined || compareIds(check.id, options.after) > 0);
  const checks = remaining.slice(0, options.limit);
  const last = checks.at(-1);
  return {
    ...report,
    checks,
    page: {
      limit: options.limit,
      matched: matched.length,
      ...(remaining.length > checks.length && last !== undefined ? { next: last.id } : {}),
    },
  };
};
