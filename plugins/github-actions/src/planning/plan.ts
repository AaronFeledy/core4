import { data } from "@actions/expressions";
import { isMapping, isString } from "@actions/workflow-parser";
import type { MappingToken, TemplateToken } from "@actions/workflow-parser/templates/tokens/index";
import { Effect } from "effect";
import {
  type VerifiedActionSource,
  loadActionMetadata,
  parseActionReference,
} from "../actions/source/index.ts";
import {
  type ContextFacts,
  type ContextSite,
  type Status,
  type StatusSnapshot,
  evaluateCondition,
  evaluateContextTemplate,
} from "../contexts/index.ts";
import { UnavailableContext, languageError } from "../language/errors.ts";
import { expressionDataFromUnknownSync } from "../language/expressions.ts";
import type { ParsedWorkflowLanguage } from "../language/parse.ts";
import { tokenSource } from "../language/template.ts";
import { type PlanningError, planningError } from "./errors.ts";
import { validateJobGraph } from "./graph.ts";
import { type MatrixLeg, type MatrixValue, expandMatrixWithBudget } from "./matrix.ts";

export interface PlanOptions {
  readonly facts?: ContextFacts;
  readonly maxJobs?: number;
  readonly maxParallel?: number;
  readonly actionSources?: readonly VerifiedActionSource[];
}
export type LegState = "queued" | "waiting" | "ready" | "running" | "completed" | "cancel-requested";
export interface PlannedLeg {
  readonly id: string;
  readonly jobId: string;
  readonly matrix: MatrixLeg;
  readonly state: LegState;
  readonly continueOnError: boolean;
  readonly timeoutMs: number;
  readonly maxParallel: number;
  readonly failFast: boolean;
  readonly outcome?: Status;
  readonly conclusion?: Status;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly active: boolean;
  readonly completionOrder?: number;
  readonly cancellation?: "workflow" | "fail-fast" | "timeout";
}
export interface PlannedJob {
  readonly id: string;
  readonly needs: readonly string[];
  readonly state: "deferred" | "skipped" | "expanded";
  readonly reason?: "context-unavailable";
  readonly outputResolution: "absent" | "external-job-facts-required";
  readonly outputNames: readonly string[];
  readonly expansionBudget: number;
}
export interface ExternalCompletion {
  readonly legId: string;
  readonly outcome: Status;
  readonly outputs?: Readonly<Record<string, string>>;
}
export interface AdvanceFacts {
  readonly resolvedOutputs?: readonly {
    readonly legId: string;
    readonly outputs: Readonly<Record<string, string>>;
  }[];
  readonly completions?: readonly ExternalCompletion[];
  readonly started?: readonly string[];
  readonly cancelled?: boolean;
  readonly elapsedMs?: Readonly<Record<string, number>>;
}
export interface PlannedAction {
  readonly jobId: string;
  readonly stepIndex: number;
  readonly kind: "script" | "metadata-deferred" | "node20" | "node24" | "docker";
  readonly lifecycle: "external-facts-required";
}
const freezeData = <A>(value: A): A => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
};
interface PrivateState {
  readonly conditions: Readonly<Record<string, string>>;
  readonly actions: readonly PlannedAction[];
  readonly parsed: ParsedWorkflowLanguage;
  readonly options: PlanOptions;
  readonly cancelled: boolean;
}
const internals = new WeakMap<WorkflowPlan, PrivateState>();
/** Private semantic state. Its authored data cannot accidentally become JSON or inspection output. */
export class WorkflowPlan {
  constructor(
    readonly jobs: readonly PlannedJob[],
    readonly legs: readonly PlannedLeg[],
    state: PrivateState,
  ) {
    freezeData(jobs);
    freezeData(legs);
    freezeData(state.actions);
    internals.set(this, state);
    this.actions = state.actions;
    Object.freeze(this);
  }
  readonly actions: readonly PlannedAction[];
  readonly assessment = "execution-unassessed" as const;
  toJSON() {
    return "<private Actions planning state>";
  }
  toString() {
    return this.toJSON();
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toJSON();
  }
}
// Preserve evaluator numbers until the destination field applies its own validation.
const plain = (value: data.ExpressionData): MatrixValue => {
  if (value instanceof data.Null) return null;
  if (
    value instanceof data.StringData ||
    value instanceof data.NumberData ||
    value instanceof data.BooleanData
  )
    return value.value;
  if (value instanceof data.Array) return value.values().map(plain);
  return Object.fromEntries(value.pairs().map(({ key, value }) => [key, plain(value)]));
};
const rawJobs = (parsed: ParsedWorkflowLanguage): MappingToken | undefined => {
  if (!isMapping(parsed.token)) return undefined;
  const jobs = parsed.token.find("jobs");
  return jobs !== undefined && isMapping(jobs) ? jobs : undefined;
};
const rawJob = (parsed: ParsedWorkflowLanguage, id: string): MappingToken | undefined => {
  const token = rawJobs(parsed)?.find(id);
  return token !== undefined && isMapping(token) ? token : undefined;
};
const aggregate = (legs: readonly PlannedLeg[]): Status | undefined => {
  if (legs.some((leg) => leg.conclusion === undefined)) return undefined;
  if (legs.some((leg) => leg.conclusion === "failure")) return "failure";
  if (legs.some((leg) => leg.conclusion === "cancelled")) return "cancelled";
  return legs.length > 0 && legs.every((leg) => leg.conclusion === "skipped") ? "skipped" : "success";
};
const dependencyFacts = (
  job: PlannedJob,
  jobs: readonly PlannedJob[],
  legs: readonly PlannedLeg[],
  cancelled: boolean,
  facts: ContextFacts,
): { facts: ContextFacts; snapshot: StatusSnapshot | undefined; complete: boolean } => {
  const needs: Record<string, { result: Status; outputs?: Record<string, string> }> = Object.create(null);
  let complete = true;
  for (const id of job.needs) {
    const needed = jobs.find((candidate) => candidate.id === id);
    const neededLegs = legs.filter((leg) => leg.jobId === id);
    const result =
      needed?.state === "skipped"
        ? "skipped"
        : needed?.state === "expanded"
          ? aggregate(neededLegs)
          : undefined;
    if (result === undefined) {
      complete = false;
      continue;
    }
    const ordered = [...neededLegs].sort(
      (left, right) => (left.completionOrder ?? 0) - (right.completionOrder ?? 0),
    );
    needs[id] = {
      result,
      ...(needed?.outputResolution === "external-job-facts-required" &&
      neededLegs.some((leg) => leg.outputs === undefined)
        ? {}
        : { outputs: Object.fromEntries(ordered.flatMap((leg) => Object.entries(leg.outputs ?? {}))) }),
    };
  }
  const { needs: _needs, matrix: _matrix, strategy: _strategy, ...baseFacts } = facts;
  const ancestorIds = new Set<string>();
  const collect = (id: string): void => {
    if (ancestorIds.has(id)) return;
    ancestorIds.add(id);
    for (const need of jobs.find((candidate) => candidate.id === id)?.needs ?? []) collect(need);
  };
  for (const id of job.needs) collect(id);
  const ancestorJobs = [...ancestorIds].map((id) => ({
    result:
      jobs.find((candidate) => candidate.id === id)?.state === "skipped"
        ? ("skipped" as const)
        : (aggregate(legs.filter((leg) => leg.jobId === id)) ?? ("skipped" as const)),
  }));
  return {
    facts: { ...baseFacts, ...(complete ? { needs } : {}) },
    complete,
    snapshot: complete ? { cancelled, previousSteps: [], ancestorJobs } : undefined,
  };
};
const evaluateField = Effect.fnUntraced(function* (
  token: TemplateToken | undefined,
  site: ContextSite,
  facts: ContextFacts,
  file: string,
) {
  if (token === undefined) return { kind: "known" as const, value: null };
  const source = tokenSource(token, file);
  const decision = yield* evaluateContextTemplate(token, site, facts, source);
  if (decision.kind === "deferred") return decision;
  return yield* Effect.try({
    try: () => ({ kind: "known" as const, value: plain(decision.value) }),
    catch: (error) =>
      languageError(
        error instanceof UnavailableContext ? "context-unavailable" : "expression-evaluation",
        source,
      ),
  }).pipe(
    Effect.catchIf(
      (error) => error.code === "context-unavailable",
      () => Effect.succeed({ kind: "deferred" as const, reason: "context-unavailable" as const }),
    ),
  );
});
const admitLimits = (options: PlanOptions): Effect.Effect<void, PlanningError> => {
  const jobs = options.maxJobs ?? 256;
  const parallel = options.maxParallel ?? 4;
  return Number.isInteger(jobs) &&
    jobs > 0 &&
    jobs <= 256 &&
    Number.isInteger(parallel) &&
    parallel > 0 &&
    parallel <= 4
    ? Effect.void
    : Effect.fail(planningError("plan-limit"));
};
const unsupportedPermissions = (
  token: TemplateToken | undefined,
  file: string,
): Effect.Effect<void, PlanningError> => {
  if (token === undefined) return Effect.void;
  if (isString(token) && token.value === "write-all")
    return Effect.fail(planningError("unsupported-oidc", tokenSource(token, file)));
  if (isMapping(token)) {
    const idToken = token.find("id-token");
    if (idToken !== undefined && (!isString(idToken) || idToken.value !== "none"))
      return Effect.fail(planningError("unsupported-oidc", tokenSource(idToken, file)));
  }
  return Effect.void;
};
const unsupported = Effect.fnUntraced(function* (parsed: ParsedWorkflowLanguage) {
  if (isMapping(parsed.token) && parsed.token.find("concurrency") !== undefined)
    return yield* Effect.fail(
      planningError("unsupported-concurrency", tokenSource(parsed.token, parsed.source.file)),
    );
  for (const job of parsed.workflow.jobs) {
    const raw = rawJob(parsed, job.id.value);
    if (raw === undefined) return yield* Effect.fail(planningError("job-invalid", parsed.source));
    for (const field of ["concurrency", "environment", "snapshot"] as const)
      if (raw.find(field) !== undefined)
        return yield* Effect.fail(
          planningError(`unsupported-${field}`, tokenSource(raw.find(field) ?? raw, parsed.source.file)),
        );
    if (job.type === "reusableWorkflowJob")
      return yield* Effect.fail(
        planningError("unsupported-reusable-workflow", tokenSource(job.id, parsed.source.file)),
      );
    // This is authored intent validation, regardless of narrower permission overrides.
    yield* unsupportedPermissions(raw.find("permissions"), parsed.source.file);
  }
  yield* unsupportedPermissions(
    isMapping(parsed.token) ? parsed.token.find("permissions") : undefined,
    parsed.source.file,
  );
});
const expandPending = Effect.fn("ActionsPlanning.expandPending")(function* (
  state: PrivateState,
  inputJobs: readonly PlannedJob[],
  inputLegs: readonly PlannedLeg[],
) {
  const jobs = [...inputJobs];
  const legs = [...inputLegs];
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    if (job === undefined) return yield* Effect.fail(planningError("job-invalid", state.parsed.source));
    if (job.state !== "deferred") continue;
    const raw = rawJob(state.parsed, job.id);
    if (raw === undefined) return yield* Effect.fail(planningError("job-invalid", state.parsed.source));
    const file = state.parsed.source.file;
    const dependency = dependencyFacts(job, jobs, legs, state.cancelled, state.options.facts ?? {});
    const condition = yield* evaluateCondition(
      state.conditions[job.id] ?? "success()",
      "job.if",
      dependency.facts,
      dependency.snapshot,
      tokenSource(raw.find("if") ?? raw, file),
    );
    if (condition.kind === "deferred") continue;
    if (!condition.value) {
      jobs[index] = { ...job, state: "skipped" };
      continue;
    }
    const strategy = yield* evaluateField(raw.find("strategy"), "job.strategy", dependency.facts, file);
    if (strategy.kind === "deferred") continue;
    if (strategy.value !== null && (typeof strategy.value !== "object" || Array.isArray(strategy.value)))
      return yield* Effect.fail(planningError("strategy-invalid", tokenSource(raw, file)));
    const settings = (strategy.value ?? {}) as Record<string, MatrixValue>;
    const maximum = settings["max-parallel"] ?? state.options.maxParallel ?? 4;
    const failFast = settings["fail-fast"] ?? true;
    if (
      typeof maximum !== "number" ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 256 ||
      typeof failFast !== "boolean"
    )
      return yield* Effect.fail(planningError("strategy-invalid", tokenSource(raw, file)));
    const remaining =
      (state.options.maxJobs ?? 256) - jobs.reduce((total, job) => total + job.expansionBudget, 0);
    if (remaining < 1)
      return yield* Effect.fail(
        planningError("workflow-matrix-limit", tokenSource(raw.find("strategy") ?? raw, file)),
      );
    const expansion =
      settings.matrix === undefined
        ? { legs: [{}], budgetUsed: 1 }
        : yield* expandMatrixWithBudget(settings.matrix, {
            maxJobs: remaining,
            source: tokenSource(raw.find("strategy") ?? raw, file),
          });
    const matrices = expansion.legs;
    if (legs.length + matrices.length > (state.options.maxJobs ?? 256))
      return yield* Effect.fail(planningError("workflow-matrix-limit", tokenSource(raw, file)));
    if (matrices.length === 0) {
      jobs[index] = { ...job, state: "skipped", expansionBudget: expansion.budgetUsed };
      continue;
    }
    const next: PlannedLeg[] = [];
    for (let matrixIndex = 0; matrixIndex < matrices.length; matrixIndex++) {
      const matrix = matrices[matrixIndex];
      if (matrix === undefined)
        return yield* Effect.fail(planningError("matrix-invalid", state.parsed.source));
      const facts = {
        ...dependency.facts,
        matrix,
        strategy: {
          "job-index": matrixIndex,
          "job-total": matrices.length,
          "max-parallel": maximum,
          "fail-fast": failFast,
        },
      };
      const continueOnError = yield* evaluateField(
        raw.find("continue-on-error"),
        "job.continue-on-error",
        facts,
        file,
      );
      const timeout = yield* evaluateField(raw.find("timeout-minutes"), "job.timeout-minutes", facts, file);
      const runner = yield* evaluateField(raw.find("runs-on"), "job.runs-on", facts, file);
      if (continueOnError.kind === "deferred" || timeout.kind === "deferred" || runner.kind === "deferred") {
        next.length = 0;
        break;
      }
      const continueValue = continueOnError.value ?? false;
      const timeoutValue = timeout.value ?? 360;
      if (
        typeof continueValue !== "boolean" ||
        typeof timeoutValue !== "number" ||
        !Number.isFinite(timeoutValue) ||
        timeoutValue <= 0 ||
        timeoutValue > 360
      )
        return yield* Effect.fail(planningError("job-field-invalid", tokenSource(raw, file)));
      if (
        typeof runner.value !== "string" &&
        (!Array.isArray(runner.value) ||
          runner.value.length === 0 ||
          runner.value.some((value) => typeof value !== "string"))
      )
        return yield* Effect.fail(planningError("runner-invalid", tokenSource(raw, file)));
      next.push({
        id: `job-${index}-leg-${matrixIndex}`,
        jobId: job.id,
        matrix,
        state: "waiting",
        active: false,
        continueOnError: continueValue,
        timeoutMs: timeoutValue * 60000,
        maxParallel: Math.min(maximum, state.options.maxParallel ?? 4),
        failFast,
      });
    }
    if (next.length !== matrices.length) continue;
    jobs[index] = { ...job, state: "expanded", expansionBudget: expansion.budgetUsed };
    legs.push(...next);
  }
  const globalLimit = state.options.maxParallel ?? 4;
  let occupied = legs.filter((leg) => leg.active).length;
  const perJob = new Map<string, number>();
  for (const leg of legs) if (leg.active) perJob.set(leg.jobId, (perJob.get(leg.jobId) ?? 0) + 1);
  for (let index = 0; index < legs.length; index++) {
    const leg = legs[index];
    if (leg === undefined) return yield* Effect.fail(planningError("plan-invalid", state.parsed.source));
    if (leg.state === "completed" || leg.state === "cancel-requested") continue;
    const owner = jobs.find((job) => job.id === leg.jobId);
    if (owner === undefined) return yield* Effect.fail(planningError("plan-invalid", state.parsed.source));
    const dependency = dependencyFacts(owner, jobs, legs, state.cancelled, state.options.facts ?? {});
    const failed = legs.some((other) => other.jobId === leg.jobId && other.conclusion === "failure");
    if (leg.failFast && failed) {
      legs[index] = { ...leg, state: "cancel-requested", cancellation: "fail-fast" };
      continue;
    }
    if (state.cancelled) {
      if (leg.state === "running") {
        const raw = rawJob(state.parsed, owner.id);
        const source = tokenSource(raw?.find("if") ?? raw ?? state.parsed.token, state.parsed.source.file);
        const condition = yield* evaluateCondition(
          state.conditions[owner.id] ?? "success()",
          "job.if",
          dependency.facts,
          dependency.snapshot,
          source,
        );
        if (condition.kind === "deferred")
          return yield* Effect.fail(languageError("context-unavailable", source));
        if (condition.value) continue;
      }
      legs[index] = { ...leg, state: "cancel-requested", cancellation: "workflow" };
      continue;
    }
    if (leg.state === "running") continue;
    if (!dependency.complete) {
      legs[index] = { ...leg, state: "waiting" };
      continue;
    }
    if (occupied < globalLimit && (perJob.get(leg.jobId) ?? 0) < leg.maxParallel) {
      legs[index] = { ...leg, state: "ready" };
      occupied++;
      perJob.set(leg.jobId, (perJob.get(leg.jobId) ?? 0) + 1);
    } else legs[index] = { ...leg, state: "queued" };
  }
  return new WorkflowPlan(jobs, legs, state);
});
const assessActions = Effect.fn("ActionsPlanning.assessActions")(function* (
  parsed: ParsedWorkflowLanguage,
  sources: readonly VerifiedActionSource[],
) {
  if (sources.length > 64) return yield* Effect.fail(planningError("action-metadata-limit", parsed.source));
  const metadata = [];
  for (const source of sources) metadata.push(yield* loadActionMetadata(source));
  const used = new Set<(typeof metadata)[number]>();
  const actions: PlannedAction[] = [];
  for (const job of parsed.workflow.jobs) {
    if (job.type !== "job") continue;
    if (job.steps.length > 256 || actions.length + job.steps.length > 1024)
      return yield* Effect.fail(planningError("step-limit", parsed.source));
    for (let stepIndex = 0; stepIndex < job.steps.length; stepIndex++) {
      const step = job.steps[stepIndex];
      if (step === undefined) return yield* Effect.fail(planningError("job-invalid", parsed.source));
      if ("run" in step) {
        actions.push({
          jobId: job.id.value,
          stepIndex,
          kind: "script",
          lifecycle: "external-facts-required",
        });
        continue;
      }
      if (!("uses" in step)) return yield* Effect.fail(planningError("unsupported-step-kind", parsed.source));
      const reference = yield* parseActionReference(
        step.uses.value,
        tokenSource(step.uses, parsed.source.file),
      );
      const resolved =
        reference.kind === "repository"
          ? metadata.find(
              (item) =>
                item.receipt.origin === reference.origin &&
                item.receipt.repository === reference.repository &&
                item.receipt.subpath === reference.subpath &&
                item.receipt.requestedRef === reference.requestedRef &&
                (reference.commit === undefined || item.receipt.commit === reference.commit),
            )
          : undefined;
      if (resolved !== undefined) used.add(resolved);
      if (resolved?.kind === "composite" || resolved?.kind === "reusable-workflow")
        return yield* Effect.fail(
          planningError("unsupported-composite-expansion", tokenSource(step.uses, parsed.source.file)),
        );
      actions.push({
        jobId: job.id.value,
        stepIndex,
        kind: resolved?.kind ?? "metadata-deferred",
        lifecycle: "external-facts-required",
      });
    }
  }
  if (used.size !== metadata.length)
    return yield* Effect.fail(planningError("action-metadata-mismatch", parsed.source));
  return actions;
});
export const planWorkflow = Effect.fn("ActionsPlanning.planWorkflow")(function* (
  input: ParsedWorkflowLanguage,
  initialOptions: PlanOptions = {},
) {
  let parsed = input;
  let options = initialOptions;
  const captured = yield* Effect.try({
    try: () => {
      const descriptors = Object.getOwnPropertyDescriptors(options);
      if (
        Object.keys(descriptors).some(
          (key) =>
            !["facts", "maxJobs", "maxParallel", "actionSources"].includes(key) ||
            !("value" in (descriptors[key] ?? {})),
        )
      )
        throw planningError("plan-limit", parsed.source);
      const inputFacts = options.facts ?? {};
      if (
        Object.getPrototypeOf(inputFacts) !== Object.prototype &&
        Object.getPrototypeOf(inputFacts) !== null
      )
        throw planningError("plan-limit", parsed.source);
      const factDescriptors = Object.getOwnPropertyDescriptors(inputFacts);
      if (
        Object.keys(factDescriptors).length > 12 ||
        Object.values(factDescriptors).some((descriptor) => !("value" in descriptor))
      )
        throw planningError("plan-limit", parsed.source);
      const { secrets, ...jsonFacts } = inputFacts;
      expressionDataFromUnknownSync(jsonFacts, {
        limits: { valueNodes: 20000, valueBytes: 262144, valueDepth: 32 },
      });
      const facts = freezeData({
        ...JSON.parse(JSON.stringify(jsonFacts)),
        ...(secrets === undefined ? {} : { secrets }),
      }) as ContextFacts;
      const sources = options.actionSources ?? [];
      if (
        !Array.isArray(sources) ||
        Object.getPrototypeOf(sources) !== Array.prototype ||
        sources.length > 64 ||
        Reflect.ownKeys(sources).length !== sources.length + 1 ||
        Object.values(Object.getOwnPropertyDescriptors(sources)).some(
          (descriptor) => !("value" in descriptor),
        )
      )
        throw planningError("action-metadata-limit", parsed.source);
      const conditions = Object.freeze(
        Object.fromEntries(parsed.workflow.jobs.map((job) => [job.id.value, job.if.expression])),
      );
      return {
        conditions,
        parsed: { ...parsed, source: Object.freeze({ ...parsed.source }), token: parsed.token.clone() },
        options: Object.freeze({ ...options, facts, actionSources: Object.freeze([...sources]) }),
      };
    },
    catch: () => planningError("plan-limit", parsed.source),
  });
  parsed = captured.parsed;
  options = captured.options;
  yield* admitLimits(options).pipe(Effect.mapError((error) => planningError(error.code, parsed.source)));
  const jobs = parsed.workflow.jobs.map((job) => ({
    expansionBudget: 0,
    outputNames: (() => {
      const outputs = rawJob(parsed, job.id.value)?.find("outputs");
      return outputs !== undefined && isMapping(outputs)
        ? [...outputs].map((pair) => pair.key.toString())
        : [];
    })(),
    id: job.id.value,
    needs: (job.needs ?? []).map((need) => need.value),
    state: "deferred" as const,
    reason: "context-unavailable" as const,
    outputResolution:
      rawJob(parsed, job.id.value)?.find("outputs") === undefined
        ? ("absent" as const)
        : ("external-job-facts-required" as const),
  }));
  const order = yield* validateJobGraph(
    jobs.map((job) => ({
      ...job,
      source: tokenSource(
        rawJob(parsed, job.id)?.find("needs") ?? rawJob(parsed, job.id) ?? parsed.token,
        parsed.source.file,
      ),
    })),
    parsed.source,
  );
  yield* unsupported(parsed);
  const actions = yield* assessActions(parsed, options.actionSources ?? []);
  return yield* expandPending(
    { parsed, options, actions, conditions: captured.conditions, cancelled: false },
    order.flatMap((id) => jobs.filter((job) => job.id === id)),
    [],
  );
});
export const advancePlan = Effect.fn("ActionsPlanning.advancePlan")(function* (
  plan: WorkflowPlan,
  facts: AdvanceFacts,
) {
  const previous = internals.get(plan);
  if (previous === undefined) return yield* Effect.fail(planningError("plan-invalid"));
  yield* Effect.try({
    try: () =>
      expressionDataFromUnknownSync(facts, {
        limits: { valueNodes: 20000, valueBytes: 262144, valueDepth: 32 },
      }),
    catch: () => planningError("completion-limit", previous.parsed.source),
  });
  if (
    (facts.completions?.length ?? 0) > 256 ||
    (facts.started?.length ?? 0) > 256 ||
    Object.keys(facts.elapsedMs ?? {}).length > 256
  )
    return yield* Effect.fail(planningError("completion-limit", previous.parsed.source));
  const legs = [...plan.legs];
  const seen = new Set<string>();
  let completionOrder = Math.max(0, ...legs.map((leg) => leg.completionOrder ?? 0));
  for (const completion of facts.completions ?? []) {
    const index = legs.findIndex((leg) => leg.id === completion.legId);
    const leg = legs[index];
    if (
      leg === undefined ||
      !["ready", "running", "cancel-requested"].includes(leg.state) ||
      leg.conclusion !== undefined ||
      seen.has(leg.id) ||
      !["success", "failure", "cancelled", "skipped"].includes(completion.outcome)
    )
      return yield* Effect.fail(planningError("completion-invalid", previous.parsed.source));
    seen.add(leg.id);
    const outputs = completion.outputs ?? {};
    const declared = plan.jobs.find((job) => job.id === leg.jobId)?.outputNames;
    if (declared === undefined)
      return yield* Effect.fail(planningError("plan-invalid", previous.parsed.source));
    if (Object.keys(outputs).some((key) => !declared.includes(key)))
      return yield* Effect.fail(planningError("outputs-invalid", previous.parsed.source));
    if (
      Object.keys(outputs).length > 256 ||
      Object.entries(outputs).some(
        ([key, value]) => key.length > 256 || typeof value !== "string" || value.length > 16384,
      ) ||
      Object.values(outputs).reduce((total, value) => total + value.length, 0) > 262144
    )
      return yield* Effect.fail(planningError("completion-limit", previous.parsed.source));
    legs[index] = {
      ...leg,
      state: "completed",
      active: false,
      completionOrder: ++completionOrder,
      outcome: completion.outcome,
      conclusion: completion.outcome === "failure" && leg.continueOnError ? "success" : completion.outcome,
      ...(completion.outputs === undefined ? {} : { outputs: { ...outputs } }),
    };
  }
  for (const fact of facts.resolvedOutputs ?? []) {
    const index = legs.findIndex((leg) => leg.id === fact.legId);
    const leg = legs[index];
    if (
      leg === undefined ||
      leg.state !== "completed" ||
      leg.outputs !== undefined ||
      Object.keys(fact.outputs).length > 256 ||
      Object.entries(fact.outputs).some(
        ([key, value]) => key.length > 256 || typeof value !== "string" || value.length > 16384,
      )
    )
      return yield* Effect.fail(planningError("outputs-invalid", previous.parsed.source));
    if (
      Object.keys(fact.outputs).some(
        (key) => !plan.jobs.find((job) => job.id === leg.jobId)?.outputNames.includes(key),
      )
    )
      return yield* Effect.fail(planningError("outputs-invalid", previous.parsed.source));
    legs[index] = { ...leg, outputs: { ...fact.outputs } };
  }
  for (const id of facts.started ?? []) {
    const index = legs.findIndex((leg) => leg.id === id);
    const leg = legs[index];
    if (leg === undefined || leg.state !== "ready")
      return yield* Effect.fail(planningError("start-invalid", previous.parsed.source));
    legs[index] = { ...leg, state: "running", active: true };
  }
  if (legs.filter((leg) => leg.active).length > (previous.options.maxParallel ?? 4))
    return yield* Effect.fail(planningError("parallel-limit", previous.parsed.source));
  for (const [id, elapsed] of Object.entries(facts.elapsedMs ?? {})) {
    const index = legs.findIndex((leg) => leg.id === id);
    const leg = legs[index];
    if (leg === undefined || !leg.active || !Number.isFinite(elapsed) || elapsed < 0)
      return yield* Effect.fail(planningError("elapsed-invalid", previous.parsed.source));
    if (leg.conclusion === undefined && elapsed >= leg.timeoutMs)
      legs[index] = { ...leg, state: "cancel-requested", cancellation: "timeout" };
  }
  return yield* expandPending(
    { ...previous, cancelled: previous.cancelled || facts.cancelled === true },
    plan.jobs,
    legs,
  );
});
