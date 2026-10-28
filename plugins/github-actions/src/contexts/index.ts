import * as data from "@actions/expressions/data/index";
import type { FunctionDefinition } from "@actions/expressions/funcs/info";
import { truthy } from "@actions/expressions/result";
import type { TemplateToken } from "@actions/workflow-parser/templates/tokens/template-token";
import { Effect } from "effect";
import {
  ExpressionLimit,
  type LanguageError,
  type LanguageSource,
  UnavailableContext,
  languageError,
} from "../language/errors.ts";
import {
  PartialDictionary,
  evaluateExpression,
  expressionDataFromUnknownSync,
  expressionFunctionNames,
  validateExpression,
} from "../language/expressions.ts";
import { evaluateTemplate } from "../language/template.ts";

export type JsonData =
  | null
  | string
  | number
  | boolean
  | readonly JsonData[]
  | { readonly [key: string]: JsonData };
export type Status = "success" | "failure" | "cancelled" | "skipped";
export interface StatusSnapshot {
  readonly cancelled: boolean;
  readonly previousSteps: readonly { readonly outcome: Status; readonly conclusion: Status }[];
  readonly ancestorJobs: readonly { readonly result: Status }[];
}
const secretValues = new WeakMap<AdmittedSecrets, Readonly<Record<string, string>>>();
export class AdmittedSecrets {
  private constructor(values: Readonly<Record<string, string>>) {
    secretValues.set(this, values);
  }
  static admit<E, R>(
    values: Readonly<Record<string, string>>,
    register: (values: readonly string[]) => Effect.Effect<void, E, R>,
    source: LanguageSource = { file: "workflow" },
  ): Effect.Effect<AdmittedSecrets, E | LanguageError, R> {
    return Effect.try({
      try: () => {
        expressionDataFromUnknownSync(values, { limits: { valueNodes: 1000, valueBytes: 65536 } });
        if (Object.values(values).some((value) => typeof value !== "string")) throw new ExpressionLimit();
        return Object.freeze({ ...values });
      },
      catch: () => languageError("expression-limit", source),
    }).pipe(
      Effect.flatMap((copy) =>
        register(Object.values(copy)).pipe(Effect.map(() => new AdmittedSecrets(copy))),
      ),
    );
  }
  toJSON() {
    return "<admitted Actions secrets>";
  }
  toString() {
    return "<admitted Actions secrets>";
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toString();
  }
}
// The host must provide the canonical redactor's registration operation. This does
// not resolve references, authorize secrets, or create a default token.
export const admitSecrets = AdmittedSecrets.admit;
export interface ContextFacts {
  readonly github?: Readonly<Record<string, JsonData>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly vars?: Readonly<Record<string, string>>;
  readonly inputs?: Readonly<Record<string, JsonData>>;
  readonly secrets?: AdmittedSecrets;
  readonly runner?: Readonly<Record<string, JsonData>>;
  readonly job?: Readonly<Record<string, JsonData>>;
  readonly steps?: Readonly<
    Record<
      string,
      {
        readonly outcome?: Status;
        readonly conclusion?: Status;
        readonly outputs?: Readonly<Record<string, string>>;
      }
    >
  >;
  readonly needs?: Readonly<
    Record<string, { readonly result: Status; readonly outputs?: Readonly<Record<string, string>> }>
  >;
  readonly matrix?: Readonly<Record<string, JsonData>>;
  readonly strategy?: Readonly<Record<string, JsonData>>;
}
const workflow = ["github", "inputs", "vars"] as const;
const job = [...workflow, "needs", "strategy", "matrix"] as const;
const step = [...job, "job", "runner", "env", "steps"] as const;
// Field-specific policy follows the official context availability table. Adding a
// new field requires a deliberate row; phase labels alone are not sufficient.
const policies = {
  "workflow.run-name": workflow,
  "workflow.concurrency": workflow,
  "workflow.env": [...workflow, "secrets"],
  "job.if": [...workflow, "needs"],
  "job.strategy": [...workflow, "needs"],
  "job.name": job,
  "job.runs-on": job,
  "job.concurrency": job,
  "job.container": job,
  "job.environment": job,
  "job.with": job,
  "job.env": [...job, "secrets"],
  "job.defaults.run": [...job, "env"],
  "job.outputs": [...step, "secrets"],
  "job.environment.url": step,
  "job.container.credentials": [...job, "env", "secrets"],
  "job.container.env": [...step.filter((name) => name !== "steps"), "secrets"],
  "job.continue-on-error": job,
  "job.timeout-minutes": job,
  "job.secrets": [...job, "secrets"],
  "step.if": step,
  "step.run": [...step, "secrets"],
  "step.env": [...step, "secrets"],
  "step.with": [...step, "secrets"],
  "step.name": [...step, "secrets"],
  "step.continue-on-error": [...step, "secrets"],
  "step.timeout-minutes": [...step, "secrets"],
  "step.working-directory": [...step, "secrets"],
} as const;
export type ContextSite = keyof typeof policies;
class LazyContext extends data.Dictionary {
  constructor(
    private readonly allowed: readonly string[],
    private readonly valuesByRoot: ReadonlyMap<string, data.ExpressionData>,
  ) {
    super();
  }
  override get(name: string): data.ExpressionData | undefined {
    const normalized = name.toLowerCase();
    if (!this.allowed.includes(normalized)) return undefined;
    const value = this.valuesByRoot.get(normalized);
    if (value === undefined) throw new UnavailableContext();
    return value;
  }
}
export const createContext = (site: ContextSite, facts: ContextFacts): data.Dictionary => {
  const prototype = Object.getPrototypeOf(facts);
  if (prototype !== Object.prototype && prototype !== null) throw new ExpressionLimit();
  const selected: Record<string, unknown> = Object.create(null);
  for (const root of policies[site]) {
    const descriptor = Object.getOwnPropertyDescriptor(facts, root);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) throw new ExpressionLimit();
    if (descriptor.value === undefined) continue;
    if (root === "secrets") {
      const value = secretValues.get(descriptor.value);
      if (value === undefined) throw new ExpressionLimit();
      selected[root] = value;
    } else selected[root] = descriptor.value;
  }
  const converted = expressionDataFromUnknownSync(selected);
  if (!(converted instanceof data.Dictionary)) throw new ExpressionLimit();
  const values = new Map(converted.pairs().map(({ key, value }) => [key, value]));
  const needs = values.get("needs");
  if (needs !== undefined) {
    if (!(needs instanceof data.Dictionary)) throw new ExpressionLimit();
    values.set(
      "needs",
      new data.Dictionary(
        ...needs.pairs().map(({ key, value }) => {
          if (!(value instanceof data.Dictionary)) throw new ExpressionLimit();
          const outputs = value.get("outputs");
          if (outputs !== undefined && !(outputs instanceof data.Dictionary)) throw new ExpressionLimit();
          return { key, value: outputs === undefined ? new PartialDictionary(value, ["outputs"]) : value };
        }),
      ),
    );
  }
  return new LazyContext(policies[site], values);
};
const statusNames = ["always", "cancelled", "success", "failure"] as const;
export const statusFunctions = (
  site: "job.if" | "step.if",
  snapshot: StatusSnapshot | undefined,
): ReadonlyMap<string, FunctionDefinition> => {
  let result: { cancelled: boolean; success: boolean; failure: boolean } | undefined;
  return new Map(
    statusNames.map((name) => [
      name,
      {
        name,
        minArgs: 0,
        maxArgs: 0,
        call: () => {
          if (name === "always") return new data.BooleanData(true);
          if (!snapshot) throw new UnavailableContext();
          if (result === undefined) {
            expressionDataFromUnknownSync(snapshot, { limits: { valueNodes: 20000 } });
            result = {
              cancelled: snapshot.cancelled,
              failure:
                site === "job.if"
                  ? snapshot.ancestorJobs.some((j) => j.result === "failure")
                  : !snapshot.cancelled && snapshot.previousSteps.some((s) => s.conclusion === "failure"),
              success:
                !snapshot.cancelled &&
                (site === "job.if"
                  ? snapshot.ancestorJobs.every((j) => j.result === "success")
                  : !snapshot.previousSteps.some(
                      (s) => s.conclusion === "failure" || s.conclusion === "cancelled",
                    )),
            };
          }
          return new data.BooleanData(
            name === "cancelled" ? result.cancelled : name === "failure" ? result.failure : result.success,
          );
        },
      },
    ]),
  );
};
export type ContextDecision =
  | { readonly kind: "known"; readonly value: data.ExpressionData }
  | { readonly kind: "deferred"; readonly reason: "context-unavailable" };
export type ConditionDecision =
  | { readonly kind: "known"; readonly value: boolean }
  | { readonly kind: "deferred"; readonly reason: "context-unavailable" };
const functionsForSite = (
  site: ContextSite,
  snapshot?: StatusSnapshot,
  hashFiles?: FunctionDefinition,
): ReadonlyMap<string, FunctionDefinition> => {
  const functions = new Map<string, FunctionDefinition>();
  if (site === "job.if" || site === "step.if")
    for (const [name, fn] of statusFunctions(site, snapshot)) functions.set(name, fn);
  if (site.startsWith("step."))
    functions.set(
      "hashfiles",
      hashFiles ?? {
        name: "hashFiles",
        minArgs: 1,
        maxArgs: 128,
        call: () => {
          throw new UnavailableContext();
        },
      },
    );
  return functions;
};
export const evaluateContextExpression = (
  text: string,
  site: ContextSite,
  facts: ContextFacts,
  source: LanguageSource,
  snapshot?: StatusSnapshot,
  hashFiles?: FunctionDefinition,
): Effect.Effect<ContextDecision, LanguageError> => {
  const functions = functionsForSite(site, snapshot, hashFiles);
  const options = { contextNames: policies[site], functions };
  return validateExpression(text, source, options).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => createContext(site, facts),
        catch: () => languageError("expression-limit", source),
      }),
    ),
    Effect.flatMap((context) => evaluateExpression(text, context, source, options)),
    Effect.map((value): ContextDecision => ({ kind: "known", value })),
    Effect.catchIf(
      (error) => error.code === "context-unavailable",
      () => Effect.succeed<ContextDecision>({ kind: "deferred", reason: "context-unavailable" }),
    ),
  );
};
export const evaluateCondition = (
  text: string,
  site: "job.if" | "step.if",
  facts: ContextFacts,
  snapshot: StatusSnapshot | undefined,
  source: LanguageSource,
  hashFiles?: FunctionDefinition,
): Effect.Effect<ConditionDecision, LanguageError> => {
  const options = { contextNames: policies[site], functions: functionsForSite(site, snapshot, hashFiles) };
  return validateExpression(text, source, options).pipe(
    Effect.flatMap((ast) => {
      const hasStatus = expressionFunctionNames(ast).some((name) =>
        (statusNames as readonly string[]).includes(name.toLowerCase()),
      );
      return evaluateContextExpression(
        hasStatus ? text : `success() && (${text})`,
        site,
        facts,
        source,
        snapshot,
        hashFiles,
      );
    }),
    Effect.map((decision) =>
      decision.kind === "deferred" ? decision : { kind: "known" as const, value: truthy(decision.value) },
    ),
  );
};

export const evaluateContextTemplate = (
  token: TemplateToken,
  site: ContextSite,
  facts: ContextFacts,
  source: LanguageSource,
  snapshot?: StatusSnapshot,
  hashFiles?: FunctionDefinition,
): Effect.Effect<ContextDecision, LanguageError> =>
  Effect.try({
    try: () => createContext(site, facts),
    catch: () => languageError("expression-limit", source),
  }).pipe(
    Effect.flatMap((context) =>
      evaluateTemplate(token, context, {
        contextNames: policies[site],
        source,
        functions: functionsForSite(site, snapshot, hashFiles),
      }),
    ),
    Effect.map((value): ContextDecision => ({ kind: "known", value })),
    Effect.catchIf(
      (error) => error.code === "context-unavailable",
      () => Effect.succeed<ContextDecision>({ kind: "deferred", reason: "context-unavailable" }),
    ),
  );
