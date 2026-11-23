import type { InvocationProgram } from "@lando/landofile/compiled-sites";
import { RedactionService } from "@lando/redaction/service";
import { mapFailureCause, projectToolingDiagnostic } from "@lando/sdk/command-result";
import { ToolingCompileError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppPlan, ToolingInputRevision, ToolingInvocationInput } from "@lando/sdk/schema";
import { createRedactor, isSecretEnvName } from "@lando/sdk/secrets";
import { Effect, Option } from "effect";
import { toolingSourceResolverForPlan } from "../planner/effective-tooling.ts";
import { registerPlanRedaction } from "../services/plan-redaction.ts";
import { resolveToolingTaskShape } from "../tooling/step-runner.ts";
import { resolveInvocationServiceUrls } from "./invocation-service-urls.ts";
import { type CompileToolingInput, compileToolingInvocations } from "./tooling-compile.ts";
import { makeDynamicToolingVarResolver } from "./tooling-dynamic-vars.ts";
import { admitToolingTask } from "./tooling-input-admission.ts";
import { validateToolingTargets } from "./tooling-targets.ts";

export const prepareToolingInvocation = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly options: Omit<CompileToolingInput, "admitted"> & {
    readonly input?: ToolingInvocationInput;
    readonly expectedInputRevision?: ToolingInputRevision;
  };
  readonly sites: InvocationProgram;
  readonly context?: ExpressionContext;
}) {
  const planValues = yield* registerPlanRedaction(input.plan);
  const normalizationSource = {
    ...(input.options.source.locate === undefined
      ? toolingSourceResolverForPlan(input.plan)(input.options.lookupKey)
      : input.options.source),
    task: input.options.lookupKey,
  };
  const redactionTokens: string[] = [];
  const redaction = yield* Effect.serviceOption(RedactionService);
  const register = Effect.fnUntraced(function* (name: string, value: unknown) {
    const definition = input.options.task.vars?.[name];
    if (!(isSecretEnvName(name) || (typeof definition === "object" && definition.sensitive === true))) return;
    if (
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      value === ""
    )
      return;
    const token = String(value);
    redactionTokens.push(token);
    if (Option.isSome(redaction)) yield* redaction.value.registerValues([token]);
  });
  for (const [name, value] of Object.entries(input.context?.vars ?? {})) yield* register(name, value);
  const admitted = yield* admitToolingTask({
    ...input.options,
    name: input.options.lookupKey,
    sites: input.sites,
    source: normalizationSource,
  });
  redactionTokens.push(...admitted.redactionTokens);
  return yield* Effect.gen(function* () {
    const preparedInput = { ...admitted, redactionTokens };
    const name = input.options.lookupKey;
    // A var the caller supplies never runs its definition: none of its literal, `env`, `service`,
    // or `sh` sites is evaluated, preflighted, or resolved against a route.
    const callerVars = input.context?.vars ?? {};
    const sites = input.sites.filter(
      (site) => site.path[0] !== "vars" || !Object.hasOwn(callerVars, String(site.path[1])),
    );
    const serviceUrls = yield* resolveInvocationServiceUrls({
      plan: input.plan,
      tool: name,
      sites,
      effectivePath: (site) => ["tooling", name, ...site.path],
    });
    const context = {
      ...input.context,
      ...(serviceUrls === undefined ? {} : { services: { ...input.context?.services, ...serviceUrls } }),
      flags: admitted.values.flags,
      args: admitted.values.args,
      raw:
        admitted.invocation._tag === "RawArgv"
          ? admitted.invocation.argv
          : (admitted.invocation.passthroughArgv ?? []),
      task: {
        name,
        subnamespace: name.includes(":") ? name.slice(0, name.lastIndexOf(":")) : "",
        commandNamespace: "app",
        canonicalId: `app:${name}`,
      },
    };
    const resolved = yield* resolveToolingTaskShape(input.options.task, context, sites, {
      name: input.options.lookupKey,
      evaluate: makeDynamicToolingVarResolver({
        plan: input.plan,
        options: input.options,
        admitted: preparedInput,
      }),
      register,
      validate: (task) => validateToolingTargets(task, admitted.values, input.options.lookupKey),
    });
    const compiled = yield* compileToolingInvocations(
      {
        ...input.options,
        ...resolved,
        source: normalizationSource,
        admitted: preparedInput,
      },
      input.plan,
    );
    return { ...compiled, admitted: preparedInput };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const redactor = Option.isSome(redaction)
          ? yield* redaction.value.forProfile("secrets")
          : createRedactor("secrets", {
              values: [...planValues.substring, ...redactionTokens],
              wholeTokenValues: planValues.wholeToken,
            });
        return yield* Effect.failCause(
          mapFailureCause(cause, (error) =>
            error._tag === "ToolingCompileError"
              ? new ToolingCompileError(projectToolingDiagnostic(error, redactor))
              : error,
          ),
        );
      }),
    ),
  );
});
