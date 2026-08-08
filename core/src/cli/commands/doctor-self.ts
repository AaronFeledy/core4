/**
 * Doctor self-resilience substrate.
 *
 * `lando doctor` is the tool a user reaches for when the host is already
 * broken, so it must survive the breakage it reports on. Every fallible
 * section of the report routes through {@link isolateDoctorSection}, which
 * bounds the section with a deadline and converts a typed failure, an untyped
 * defect, or a timeout into a {@link DoctorSelfCheck} carrying remediation
 * instead of failing the whole report.
 *
 * Invariant: `lando doctor` always emits a structured report. A section that
 * cannot answer degrades to its fallback plus one self check naming the
 * section, never a propagated error or a stack trace.
 *
 * Cancellation by the user is deliberately *not* absorbed: sections run in a
 * child fiber, so interrupting the parent still cancels the whole run, while a
 * section that interrupts itself is recorded as a section defect.
 */
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";

import {
  DOCTOR_SELF_CHECK_NAME,
  type DoctorSelfCheck,
  type DoctorSelfFailureReason,
  type DoctorSelfSolution,
} from "./doctor-self-contract";

export * from "./doctor-self-contract";

const DEFAULT_SECTION_BUDGET_MS = 10_000;
const MIN_SECTION_BUDGET_MS = 1_000;
const MAX_SECTION_BUDGET_MS = 120_000;

export const DOCTOR_SECTION_BUDGET_ENV = "LANDO_DOCTOR_SECTION_BUDGET_MS";

/**
 * Per-section deadline in milliseconds. An unparsable or out-of-range override
 * falls back to the default rather than failing: budget resolution must never
 * be the reason doctor cannot run.
 */
export const doctorSectionBudgetMs = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): number => {
  const raw = env[DOCTOR_SECTION_BUDGET_ENV];
  if (raw === undefined) return DEFAULT_SECTION_BUDGET_MS;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_SECTION_BUDGET_MS;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SECTION_BUDGET_MS;
  if (parsed < MIN_SECTION_BUDGET_MS) return MIN_SECTION_BUDGET_MS;
  if (parsed > MAX_SECTION_BUDGET_MS) return MAX_SECTION_BUDGET_MS;
  return parsed;
};

const REPORT_ISSUE_SOLUTION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "A `lando doctor` section failed to run. Re-run with `--format=json` for the full record, then report it at https://github.com/lando/core/issues.",
};

const TAG_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const FAILURE_INSPECTION_FALLBACK = "Failure details could not be inspected safely.";

const MAX_MESSAGE_CHARS = 2_000;
const TRUNCATION_MARKER = "… (truncated)";

/** Failure messages are capped only after the complete raw value has been redacted. */
const bounded = (message: string): string =>
  message.length <= MAX_MESSAGE_CHARS
    ? message
    : `${message.slice(0, MAX_MESSAGE_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;

/** Only identifier-shaped tags may reach machine-readable failure context. */
const inspectFailure = (value: unknown): { readonly tag?: string; readonly message: string } => {
  try {
    let tag: string | undefined;
    if (typeof value === "object" && value !== null && "_tag" in value) {
      const candidate = value._tag;
      if (typeof candidate === "string" && TAG_PATTERN.test(candidate)) tag = candidate;
    }

    let message: string;
    if (typeof value === "string") message = value;
    else if (value instanceof Error && value.message.length > 0) message = value.message;
    else if (typeof value === "object" && value !== null && "message" in value) {
      const candidate = value.message;
      message = typeof candidate === "string" && candidate.length > 0 ? candidate : (tag ?? String(value));
    } else message = tag ?? String(value);

    return { ...(tag === undefined ? {} : { tag }), message };
  } catch {
    return { message: FAILURE_INSPECTION_FALLBACK };
  }
};

export const redactDoctorMessage = (message: string, redact: (value: string) => string): string =>
  bounded(redact(message));

interface DescribedCause {
  readonly reason: DoctorSelfFailureReason;
  readonly tag?: string;
  readonly message: string;
}

/**
 * Describe an already-caught failure value for callers holding an `Either`
 * rather than a `Cause`. Counterpart to {@link describeDoctorCause}.
 */
export const describeDoctorFailure = (value: unknown): { readonly tag?: string; readonly message: string } =>
  inspectFailure(value);

/**
 * Reduce a `Cause` to the reason/tag/message a self check reports. Typed
 * failures keep their `_tag` so agents can branch on it; defects report the
 * thrown value's message.
 */
export const describeDoctorCause = (cause: Cause.Cause<unknown>): DescribedCause => {
  // Defects outrank typed failures: a mixed cause is the more severe of the two.
  const defect = Cause.dieOption(cause);
  if (Option.isSome(defect)) {
    const described = inspectFailure(defect.value);
    return {
      reason: "defect",
      ...(described.tag === undefined ? {} : { tag: described.tag }),
      message: described.message,
    };
  }
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const described = inspectFailure(failure.value);
    return {
      reason: "failure",
      ...(described.tag === undefined ? {} : { tag: described.tag }),
      message: described.message,
    };
  }
  try {
    return { reason: "defect", message: Cause.pretty(cause) };
  } catch {
    return { reason: "defect", message: FAILURE_INSPECTION_FALLBACK };
  }
};

export interface IsolateDoctorSectionOptions<A, E, R> {
  readonly section: string;
  readonly effect: Effect.Effect<A, E, R>;
  readonly fallback: A;
  readonly budgetMs?: number;
  /**
   * Applied to the failure message before it reaches the report. Callers pass
   * a redactor so a secret in an error string never lands in output.
   */
  readonly redact?: (value: string) => string;
  readonly solutions?: ReadonlyArray<DoctorSelfSolution>;
  readonly context?: Readonly<Record<string, string>>;
}

export interface IsolatedDoctorSection<A> {
  readonly value: A;
  readonly self?: DoctorSelfCheck;
}

export const doctorSelfCheck = (input: {
  readonly section: string;
  readonly reason: DoctorSelfFailureReason;
  readonly message: string;
  readonly tag?: string | undefined;
  readonly solutions?: ReadonlyArray<DoctorSelfSolution> | undefined;
  readonly context?: Readonly<Record<string, string>> | undefined;
}): DoctorSelfCheck => ({
  name: DOCTOR_SELF_CHECK_NAME,
  section: input.section,
  status: "fail",
  severity: "error",
  reason: input.reason,
  context: {
    ...input.context,
    section: input.section,
    reason: input.reason,
    ...(input.tag === undefined ? {} : { failure: input.tag }),
    message: input.message,
  },
  solutions: [REPORT_ISSUE_SOLUTION, ...(input.solutions ?? [])],
});

/**
 * Run one report section under a deadline with failure *and* defect capture.
 *
 * Returns the section value on success, or the caller's fallback plus a self
 * check describing why the section is missing. The error channel is `never`:
 * an isolated section can never take the report down with it.
 *
 * Caveat: a section that blocks the event loop synchronously cannot be
 * interrupted by a deadline. Section programs must stay `Effect`-shaped and
 * interruptible for the budget to bite.
 */
export const isolateDoctorSection = <A, E, R>(
  options: IsolateDoctorSectionOptions<A, E, R>,
): Effect.Effect<IsolatedDoctorSection<A>, never, R> =>
  Effect.gen(function* () {
    const budgetMs = options.budgetMs ?? doctorSectionBudgetMs();
    const redact = options.redact ?? ((value: string) => value);
    // Forked so a section that interrupts *itself* cannot masquerade as user
    // cancellation: if the parent were interrupted, `Fiber.await` would itself be
    // interrupted and never reach the classification below.
    const fiber = yield* Effect.fork(options.effect.pipe(Effect.timeoutOption(Duration.millis(budgetMs))));
    const outcome = yield* Fiber.await(fiber);

    if (Exit.isSuccess(outcome)) {
      if (Option.isSome(outcome.value)) return { value: outcome.value.value };
      return {
        value: options.fallback,
        self: doctorSelfCheck({
          section: options.section,
          reason: "timeout",
          message: `Section did not complete within ${budgetMs}ms and was abandoned.`,
          context: { budgetMs: String(budgetMs), ...options.context },
          ...(options.solutions === undefined ? {} : { solutions: options.solutions }),
        }),
      };
    }

    // Reaching here with an interrupt means the section aborted itself, which is
    // a section defect rather than the user asking to stop.
    if (Cause.isInterruptedOnly(outcome.cause)) {
      return {
        value: options.fallback,
        self: doctorSelfCheck({
          section: options.section,
          reason: "defect",
          message: "Section interrupted itself before producing a result.",
          ...(options.context === undefined ? {} : { context: options.context }),
          ...(options.solutions === undefined ? {} : { solutions: options.solutions }),
        }),
      };
    }

    const described = describeDoctorCause(outcome.cause);
    return {
      value: options.fallback,
      self: doctorSelfCheck({
        section: options.section,
        reason: described.reason,
        message: redactDoctorMessage(described.message, redact),
        ...(described.tag === undefined ? {} : { tag: described.tag }),
        ...(options.context === undefined ? {} : { context: options.context }),
        ...(options.solutions === undefined ? {} : { solutions: options.solutions }),
      }),
    };
  });
