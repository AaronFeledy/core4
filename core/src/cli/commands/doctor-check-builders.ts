import { Schema } from "effect";
import { DOCTOR_SEVERITIES, DOCTOR_STATUSES, type DoctorSolution } from "./doctor-contract";
import type { SubsystemRecovery } from "./doctor-subsystem-checks";

export const DoctorStatusSchema = Schema.Literals(DOCTOR_STATUSES);
export const DoctorSeveritySchema = Schema.Literals(DOCTOR_SEVERITIES);

type CheckInput<Name extends string> = {
  readonly name: Name;
  readonly context: Readonly<Record<string, string>>;
  readonly recovery?: SubsystemRecovery;
};
type DegradedInput<Name extends string, Solution extends DoctorSolution> = CheckInput<Name> & {
  readonly solutions: readonly Solution[];
};
type Recovery = { readonly recovery: SubsystemRecovery };
type Check<
  Name extends string,
  Status extends string,
  Severity extends string,
  Solution,
> = CheckInput<Name> & {
  readonly status: Status;
  readonly severity: Severity;
  readonly solutions: readonly Solution[];
};

export function warnCheck<Name extends string, Solution extends DoctorSolution>(
  input: DegradedInput<Name, Solution> & Recovery,
): Check<Name, "warn", "warn", Solution> & Recovery;
export function warnCheck<Name extends string, Solution extends DoctorSolution>(
  input: DegradedInput<Name, Solution>,
): Check<Name, "warn", "warn", Solution>;
export function warnCheck<Name extends string, Solution extends DoctorSolution>(
  input: DegradedInput<Name, Solution>,
): Check<Name, "warn", "warn", Solution> {
  return {
    name: input.name,
    status: "warn",
    severity: "warn",
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    context: input.context,
    solutions: input.solutions,
  };
}

export function failCheck<Name extends string, Solution extends DoctorSolution>(
  input: DegradedInput<Name, Solution> & Recovery,
): Check<Name, "fail", "error", Solution> & Recovery;
export function failCheck<Name extends string, Solution extends DoctorSolution>(
  input: DegradedInput<Name, Solution>,
): Check<Name, "fail", "error", Solution>;
export function failCheck<Name extends string, Solution extends DoctorSolution>(
  input: DegradedInput<Name, Solution>,
): Check<Name, "fail", "error", Solution> {
  return {
    name: input.name,
    status: "fail",
    severity: "error",
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    context: input.context,
    solutions: input.solutions,
  };
}

export function passCheckNamed<Name extends string>(
  input: CheckInput<Name> & Recovery,
): Check<Name, "pass", "info", never> & Recovery;
export function passCheckNamed<Name extends string>(
  input: CheckInput<Name>,
): Check<Name, "pass", "info", never>;
export function passCheckNamed<Name extends string>(
  input: CheckInput<Name>,
): Check<Name, "pass", "info", never> {
  return {
    name: input.name,
    status: "pass",
    severity: "info",
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    context: input.context,
    solutions: [],
  };
}
