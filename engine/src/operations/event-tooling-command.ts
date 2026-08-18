import { Effect, Option } from "effect";

import { ToolingCompileError } from "@lando/sdk/errors";
import type { AppPlan, ToolingTaskShape } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, ShellRunner, ToolingEngine } from "@lando/sdk/services";

import { runHostToolingWith } from "../services/host-tooling-engine.ts";
import { buildToolingInvocation, validateToolingArguments } from "./tooling.ts";

export const runEventToolingCommand = (
  plan: AppPlan,
  name: string,
  task: ToolingTaskShape,
  raw: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const argumentError = validateToolingArguments(name, task, raw);
    if (argumentError !== undefined) return yield* Effect.fail(argumentError);
    const registry = yield* RuntimeProviderRegistry;
    const engine = yield* ToolingEngine;
    const provider = yield* registry.select(plan);
    const invocation = buildToolingInvocation(name, task, { args: raw, cwd: String(plan.root) });
    if (invocation.service !== ":host") return yield* engine.run(invocation, plan, provider);
    const shell = yield* Effect.serviceOption(ShellRunner);
    if (Option.isNone(shell)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `ShellRunner is unavailable for tooling command ${name}.`,
          tool: name,
        }),
      );
    }
    return yield* runHostToolingWith(shell.value, invocation, plan, provider);
  });
