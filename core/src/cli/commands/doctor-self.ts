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
 * User interruption is deliberately *not* absorbed: an interrupt-only cause is
 * re-raised so `Ctrl-C` still cancels the run.
 */
import { Cause, Duration, Effect, Exit, Option, Schema } from "effect";

/** Why a doctor section failed to produce its own result. */
export type DoctorSelfFailureReason = "failure" | "defect" | "timeout";

/**
 * Remediation attached to a self check. Structurally identical to
 * `DoctorSolution`, declared locally so this module stays a leaf that
 * `doctor.ts` can depend on without an import cycle.
 */
export interface DoctorSelfSolution {
  readonly kind: "automatic" | "manual";
  readonly description: string;
  readonly command?: string;
}

/**
 * A failure of doctor's own machinery rather than of the host being
 * diagnosed. Reported alongside the sections that did answer.
 */
export interface DoctorSelfCheck {
  readonly name: string;
  /** The report section that failed (e.g. `subsystems`, `mcp`). */
  readonly section: string;
  readonly status: "fail";
  readonly severity: "error";
  readonly reason: DoctorSelfFailureReason;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSelfSolution>;
}

export interface DoctorSelfReport {
  readonly checks: ReadonlyArray<DoctorSelfCheck>;
}

const DoctorSelfSolutionSchema = Schema.Struct({
  kind: Schema.Literal("automatic", "manual"),
  description: Schema.String,
  command: Schema.optional(Schema.String),
});

export const DoctorSelfCheckSchema = Schema.Struct({
  name: Schema.String,
  section: Schema.String,
  status: Schema.Literal("fail"),
  severity: Schema.Literal("error"),
  reason: Schema.Literal("failure", "defect", "timeout"),
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSelfSolutionSchema),
});

export const DoctorSelfReportSchema = Schema.Struct({
  checks: Schema.Array(DoctorSelfCheckSchema),
});

/** Check name shared by every self check so consumers can filter on it. */
export const DOCTOR_SELF_CHECK_NAME = "doctor-self";

const DEFAULT_SECTION_BUDGET_MS = 10_000;
const MIN_SECTION_BUDGET_MS = 1_000;
const MAX_SECTION_BUDGET_MS = 120_000;

/** Env var that overrides the per-section deadline. */
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
  const parsed = Number.parseInt(raw.trim(), 10);
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

const tagOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("_tag" in value)) return undefined;
  const tag = (value as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" && tag.length > 0 ? tag : undefined;
};

const messageOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error && value.message.length > 0) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  const tag = tagOf(value);
  if (tag !== undefined) return tag;
  return String(value);
};

interface DescribedCause {
  readonly reason: DoctorSelfFailureReason;
  readonly tag?: string;
  readonly message: string;
}

/**
 * Describe an already-caught failure value for callers holding an `Either`
 * rather than a `Cause`. Counterpart to {@link describeDoctorCause}.
 */
export const describeDoctorFailure = (
  value: unknown,
): { readonly tag?: string; readonly message: string } => {
  const tag = tagOf(value);
  return { ...(tag === undefined ? {} : { tag }), message: messageOf(value) };
};

/**
 * Reduce a `Cause` to the reason/tag/message a self check reports. Typed
 * failures keep their `_tag` so agents can branch on it; defects report the
 * thrown value's message.
 */
export const describeDoctorCause = (cause: Cause.Cause<unknown>): DescribedCause => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const tag = tagOf(failure.value);
    return {
      reason: "failure",
      ...(tag === undefined ? {} : { tag }),
      message: messageOf(failure.value),
    };
  }
  const defect = Cause.dieOption(cause);
  if (Option.isSome(defect)) {
    const tag = tagOf(defect.value);
    return {
      reason: "defect",
      ...(tag === undefined ? {} : { tag }),
      message: messageOf(defect.value),
    };
  }
  return { reason: "defect", message: Cause.pretty(cause) };
};

export interface IsolateDoctorSectionOptions<A, E, R> {
  /** Report section label recorded on the self check. */
  readonly section: string;
  /** The section program to bound and isolate. */
  readonly effect: Effect.Effect<A, E, R>;
  /** Value substituted into the report when the section cannot answer. */
  readonly fallback: A;
  /** Per-section deadline. Defaults to {@link doctorSectionBudgetMs}. */
  readonly budgetMs?: number;
  /**
   * Applied to the failure message before it reaches the report. Callers pass
   * a redactor so a secret in an error string never lands in output.
   */
  readonly redact?: (value: string) => string;
  /** Extra remediation appended after the generic report-issue solution. */
  readonly solutions?: ReadonlyArray<DoctorSelfSolution>;
  /** Extra context merged into the self check. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface IsolatedDoctorSection<A> {
  readonly value: A;
  /** Present only when the section failed. */
  readonly self?: DoctorSelfCheck;
}

/**
 * Build a self check for a section that could not answer.
 */
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
    section: input.section,
    reason: input.reason,
    ...(input.tag === undefined ? {} : { failure: input.tag }),
    message: input.message,
    ...input.context,
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
    const outcome = yield* options.effect.pipe(Effect.timeoutOption(Duration.millis(budgetMs)), Effect.exit);

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

    // Preserve cancellation: a user interrupt is not a doctor defect.
    if (Cause.isInterruptedOnly(outcome.cause)) {
      return yield* Effect.failCause(outcome.cause as Cause.Cause<never>);
    }

    const described = describeDoctorCause(outcome.cause);
    return {
      value: options.fallback,
      self: doctorSelfCheck({
        section: options.section,
        reason: described.reason,
        message: redact(described.message),
        ...(described.tag === undefined ? {} : { tag: described.tag }),
        ...(options.context === undefined ? {} : { context: options.context }),
        ...(options.solutions === undefined ? {} : { solutions: options.solutions }),
      }),
    };
  });
