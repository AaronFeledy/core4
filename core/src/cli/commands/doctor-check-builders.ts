import type { DoctorFinding, DoctorRecovery, DoctorSolution } from "./doctor-contract";

type CheckInput = {
  readonly name: string;
  readonly context: Readonly<Record<string, string>>;
  readonly recovery?: DoctorRecovery;
};
type DegradedInput = CheckInput & {
  readonly solutions: readonly DoctorSolution[];
};

const severityByStatus = { pass: "info", warn: "warn", fail: "error" } as const;

const buildCheck = (
  input: CheckInput,
  status: DoctorFinding["status"],
  solutions: readonly DoctorSolution[],
): DoctorFinding => ({
  name: input.name,
  status,
  severity: severityByStatus[status],
  ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
  context: input.context,
  solutions,
});

export const warnCheck = (input: DegradedInput): DoctorFinding => buildCheck(input, "warn", input.solutions);

export const failCheck = (input: DegradedInput): DoctorFinding => buildCheck(input, "fail", input.solutions);

export const passCheckNamed = (input: CheckInput): DoctorFinding => buildCheck(input, "pass", []);
