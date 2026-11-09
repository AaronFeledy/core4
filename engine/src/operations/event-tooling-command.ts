import { requiresProvider } from "@lando/landofile/tooling-normalize";
import type {
  AppPlan,
  ToolingInputRevision,
  ToolingInvocationInput,
  ToolingTaskShape,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveConnectionClientTask } from "../planner/connection-client-task.ts";
import { toolingSourcePathForPlan } from "../planner/effective-tooling.ts";
import { invocationAuthorityForPlan, sitesUnder } from "../planner/invocation-authority.ts";
import { resolveToolingTaskShape } from "../tooling/step-runner.ts";

import { registerPlanRedaction } from "../services/plan-redaction.ts";
import { runBracketedInvocations } from "./tooling-bracket.ts";
import { compileToolingInvocations } from "./tooling-compile.ts";
import { makeDynamicToolingVarResolver } from "./tooling-dynamic-vars.ts";
import { admitToolingTask } from "./tooling-input-admission.ts";

export interface EventToolingInvocation {
  readonly plan: AppPlan;
  readonly name: string;
  readonly task: ToolingTaskShape;
  readonly input: ToolingInvocationInput;
  readonly expectedInputRevision?: ToolingInputRevision;
}

/**
 * Runs a canonical `app:<task>` command reached from an event `command:` step.
 *
 * This is a second top-level tooling entry point, so it brackets `pre-<task>`/`post-<task>`
 * exactly like a direct CLI run. Re-entering the event that invoked it is rejected by the
 * active-frame guard rather than recursing. The authored `arguments` declaration is kept so
 * a task that refuses positionals still refuses them here.
 */
export const runEventToolingCommand = Effect.fnUntraced(function* (input: EventToolingInvocation) {
  const { plan, name, task } = input;
  const client = yield* resolveConnectionClientTask({
    plan,
    name,
    task,
    sites: sitesUnder(invocationAuthorityForPlan(plan)?.sites ?? [], ["tooling", name]),
  });
  const options = {
    name,
    lookupKey: name,
    task: client.task,
    input: input.input,
    ...(input.expectedInputRevision === undefined
      ? {}
      : { expectedInputRevision: input.expectedInputRevision }),
    cwd: String(plan.root),
    source: {
      path: toolingSourcePathForPlan(plan, name),
      task: name,
    },
  };
  const admitted = yield* admitToolingTask(options);
  yield* registerPlanRedaction(plan);
  const resolved = yield* resolveToolingTaskShape(client.task, {}, client.sites, {
    name,
    evaluate: makeDynamicToolingVarResolver({ plan, options, admitted }),
  });
  return yield* compileToolingInvocations({ ...options, task: resolved, admitted }).pipe(
    Effect.flatMap((compiled) =>
      runBracketedInvocations({
        plan,
        tool: name,
        lookupKey: name,
        invocations: compiled.invocations,
        requiresProvider: requiresProvider(compiled.normalized),
        redactionTokens: compiled.redactionTokens,
      }),
    ),
  );
});
