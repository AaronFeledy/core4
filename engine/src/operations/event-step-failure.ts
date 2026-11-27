import { projectToolingDiagnostic } from "@lando/sdk/command-result";
import {
  ConfigExpressionError,
  LandofileEventStepFailedError,
  LandofileExpressionParseError,
  ToolingCompileError,
  ToolingDisabledError,
  ToolingInputError,
  ToolingStepConditionError,
  ToolingStepSelectorUnavailableError,
  causeMessage,
} from "@lando/sdk/errors";
import { Predicate } from "effect";

interface StepIdentity {
  readonly event: string;
  /** Human location of the step, e.g. `post-start step 2`. */
  readonly label: string;
  readonly index: number;
  readonly kind: "cmd" | "task" | "command";
  readonly service?: string | undefined;
  /** True when the step's command was handed to Bun Shell on the host. */
  readonly hostShell?: boolean;
}

const wrappedRemediation = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "remediation") &&
  typeof error.remediation === "string" &&
  /\S/u.test(error.remediation)
    ? error.remediation
    : undefined;

const processExitCode = (error: unknown): number | undefined =>
  Predicate.hasProperty(error, "exitCode") && typeof error.exitCode === "number" ? error.exitCode : undefined;

/** The remediation for a step that ran and failed, or failed outside Lando's own refusals. */
export const stepRetryRemediation = (label: string, hostShell: boolean): string =>
  `Fix ${label}, then rerun the lifecycle command.${hostShell ? " The step runs in Bun Shell." : ""}`;

/** Failures raised while Lando resolves a step, before any process for it starts. */
const refusedBeforeStart = (error: unknown) =>
  error instanceof ToolingStepConditionError ||
  error instanceof ToolingStepSelectorUnavailableError ||
  error instanceof ToolingInputError ||
  error instanceof ConfigExpressionError ||
  error instanceof LandofileExpressionParseError;

/**
 * The one projection of an event step failure. A step Lando refused before it started (its
 * command could not be compiled or a value it reads could not be resolved) keeps the refusal's
 * bounded, redacted diagnostic and reports no exit code. Any other failure keeps the exit code of
 * the process that exited, when one did, and the failure text as its output tail.
 */
export const eventStepFailure = (
  step: StepIdentity,
  error: unknown,
  redactor: { readonly redactString: (value: string) => string },
): LandofileEventStepFailedError => {
  const identity = {
    event: step.event,
    index: step.index,
    kind: step.kind,
    ...(step.service === undefined ? {} : { service: step.service }),
  };
  if (error instanceof ToolingCompileError) {
    const diagnostic = projectToolingDiagnostic(error, redactor);
    return new LandofileEventStepFailedError({
      ...identity,
      message: `Event ${step.label} did not run: ${diagnostic.message}`,
      outputTail: "",
      issues: diagnostic.issues,
      omittedIssueCount: diagnostic.omittedIssueCount,
      remediation: diagnostic.remediation,
    });
  }
  if (refusedBeforeStart(error))
    return new LandofileEventStepFailedError({
      ...identity,
      message: `Event ${step.label} did not run: ${redactor.redactString(error.message)}`,
      outputTail: "",
      remediation: redactor.redactString(error.remediation),
    });
  const exitCode = processExitCode(error);
  const wrapped = wrappedRemediation(error);
  const remediation =
    error instanceof ToolingDisabledError
      ? redactor.redactString(error.remediation)
      : [
          stepRetryRemediation(step.label, step.hostShell === true),
          ...(wrapped === undefined ? [] : [redactor.redactString(wrapped)]),
        ].join(" ");
  return new LandofileEventStepFailedError({
    ...identity,
    message: `Event ${step.label} failed.`,
    ...(exitCode === undefined ? {} : { exitCode }),
    outputTail: redactor.redactString(causeMessage(error)),
    remediation,
  });
};
