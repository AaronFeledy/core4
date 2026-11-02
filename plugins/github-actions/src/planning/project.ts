import type { SecretRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { planningError } from "./errors.ts";
import type { WorkflowPlan } from "./plan.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1024));
const Label = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u),
);
const Result = Schema.Literals(["success", "failure", "cancelled", "skipped"]);
/** Consumer-facing graph decisions only. Authored fields and dynamic values remain private. */
export const WorkflowPlanResult = Schema.Struct({
  assessment: Schema.Literal("execution-unassessed"),
  jobs: Schema.Array(
    Schema.Struct({
      id: Label,
      state: Schema.Literals(["deferred", "skipped", "expanded"]),
      needs: Count,
      legs: Count,
      outputs: Schema.Literals(["absent", "external-job-facts-required"]),
    }),
  ).check(Schema.isMaxLength(256)),
  legs: Schema.Array(
    Schema.Struct({
      id: Label,
      jobId: Label,
      state: Schema.Literals(["queued", "waiting", "ready", "running", "completed", "cancel-requested"]),
      dimensions: Count,
      outcome: Schema.optionalKey(Result),
      conclusion: Schema.optionalKey(Result),
      cancellation: Schema.optionalKey(Schema.Literals(["workflow", "fail-fast", "timeout"])),
    }),
  ).check(Schema.isMaxLength(256)),
  actions: Schema.Array(
    Schema.Struct({
      jobId: Label,
      step: Count,
      metadata: Schema.Literals(["script", "metadata-deferred", "node20", "node24", "docker"]),
      lifecycle: Schema.Literal("external-facts-required"),
    }),
  ).check(Schema.isMaxLength(1024)),
  summary: Schema.Struct({
    jobs: Count,
    expanded: Count,
    deferred: Count,
    ready: Count,
    running: Count,
    completed: Count,
    cancellationRequested: Count,
  }),
  capabilities: Schema.Struct({
    workloads: Schema.Literal("execution-unassessed"),
    jobOutputs: Schema.Literal("external-job-facts"),
    actionLifecycle: Schema.Literal("external-facts-required"),
    concurrencyGroups: Schema.Literal("unsupported"),
    reuseExpansion: Schema.Literal("unsupported"),
  }),
});
export type WorkflowPlanResult = typeof WorkflowPlanResult.Type;
export const projectPlan = Effect.fn("ActionsPlanning.projectPlan")(function* (
  plan: WorkflowPlan,
  redactor: SecretRedactor,
) {
  const projected = yield* Effect.try({
    try: () => {
      const safe = (text: string): string => {
        if (text.length > 512) throw planningError("projection-limit");
        const value =
          redactor.redactBounded === undefined ? redactor.redact(text) : redactor.redactBounded(text, 2048);
        if (value === undefined) throw planningError("projection-limit");
        if (
          value.length > 512 ||
          new TextEncoder().encode(value).length > 2048 ||
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
        )
          throw planningError("projection-limit");
        return value;
      };
      if (plan.jobs.length > 256 || plan.legs.length > 256 || plan.actions.length > 1024)
        throw planningError("projection-limit");
      return {
        assessment: plan.assessment,
        jobs: plan.jobs.map((job) => ({
          id: safe(job.id),
          state: job.state,
          needs: job.needs.length,
          legs: plan.legs.filter((leg) => leg.jobId === job.id).length,
          outputs: job.outputResolution,
        })),
        legs: plan.legs.map((leg) => ({
          id: safe(leg.id),
          jobId: safe(leg.jobId),
          state: leg.state,
          dimensions: Object.keys(leg.matrix).length,
          ...(leg.outcome === undefined ? {} : { outcome: leg.outcome }),
          ...(leg.conclusion === undefined ? {} : { conclusion: leg.conclusion }),
          ...(leg.cancellation === undefined ? {} : { cancellation: leg.cancellation }),
        })),
        actions: plan.actions.map((action) => ({
          jobId: safe(action.jobId),
          step: action.stepIndex,
          metadata: action.kind,
          lifecycle: action.lifecycle,
        })),
        summary: {
          jobs: plan.jobs.length,
          expanded: plan.legs.length,
          deferred: plan.jobs.filter((job) => job.state === "deferred").length,
          ready: plan.legs.filter((leg) => leg.state === "ready").length,
          running: plan.legs.filter((leg) => leg.active).length,
          completed: plan.legs.filter((leg) => leg.state === "completed").length,
          cancellationRequested: plan.legs.filter((leg) => leg.state === "cancel-requested").length,
        },
        capabilities: {
          workloads: "execution-unassessed" as const,
          jobOutputs: "external-job-facts" as const,
          actionLifecycle: "external-facts-required" as const,
          concurrencyGroups: "unsupported" as const,
          reuseExpansion: "unsupported" as const,
        },
      };
    },
    catch: () => planningError("projection-limit"),
  });
  return yield* Schema.decodeUnknownEffect(WorkflowPlanResult)(projected, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => planningError("projection-invalid")),
  );
});
