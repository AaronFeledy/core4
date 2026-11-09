import type { InvocationProgram } from "@lando/landofile/compiled-sites";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import { RedactionService } from "@lando/redaction/service";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { AppPlan, ToolingInputRevision, ToolingInvocationInput } from "@lando/sdk/schema";
import { isSecretEnvName } from "@lando/sdk/secrets";
import { Effect, Option } from "effect";
import { registerPlanRedaction } from "../services/plan-redaction.ts";
import { resolveToolingTaskShape } from "../tooling/step-runner.ts";
import { type CompileToolingInput, compileToolingInvocations } from "./tooling-compile.ts";
import { makeDynamicToolingVarResolver } from "./tooling-dynamic-vars.ts";
import { admitToolingTask } from "./tooling-input-admission.ts";

export const prepareToolingInvocation = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly options: Omit<CompileToolingInput, "admitted"> & {
    readonly input?: ToolingInvocationInput;
    readonly expectedInputRevision?: ToolingInputRevision;
  };
  readonly sites: InvocationProgram;
  readonly context?: ExpressionContext;
}) {
  const admitted = yield* admitToolingTask({ ...input.options, name: input.options.lookupKey });
  yield* Effect.fromResult(
    normalizeToolingTask(input.options.lookupKey, input.options.task, input.options.source),
  );
  const redactionTokens = [...admitted.redactionTokens];
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
  yield* registerPlanRedaction(input.plan);
  const preparedInput = { ...admitted, redactionTokens };
  const task = yield* resolveToolingTaskShape(input.options.task, input.context ?? {}, input.sites, {
    name: input.options.lookupKey,
    evaluate: makeDynamicToolingVarResolver({
      plan: input.plan,
      options: input.options,
      admitted: preparedInput,
    }),
    register,
  });
  const compiled = yield* compileToolingInvocations({ ...input.options, task, admitted: preparedInput });
  return { ...compiled, admitted: preparedInput };
});
