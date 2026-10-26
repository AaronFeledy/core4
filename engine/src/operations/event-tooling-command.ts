import { requiresProvider } from "@lando/landofile/tooling-normalize";
import type { AppPlan, ToolingTaskShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveConnectionClientTask } from "../planner/connection-client-task.ts";
import { toolingSourcePathForPlan } from "../planner/effective-tooling.ts";
import { invocationAuthorityForPlan, sitesUnder } from "../planner/invocation-authority.ts";
import { resolveToolingTaskShape } from "../tooling/step-runner.ts";

import { runBracketedInvocations } from "./tooling-bracket.ts";
import { compileToolingInvocations } from "./tooling-compile.ts";

/**
 * Runs a canonical `app:<task>` command reached from an event `command:` step.
 *
 * This is a second top-level tooling entry point, so it brackets `pre-<task>`/`post-<task>`
 * exactly like a direct CLI run. Re-entering the event that invoked it is rejected by the
 * active-frame guard rather than recursing. The authored `arguments` declaration is kept so
 * a task that refuses positionals still refuses them here.
 */
export const runEventToolingCommand = Effect.fnUntraced(function* (
  plan: AppPlan,
  name: string,
  task: ToolingTaskShape,
  raw: ReadonlyArray<string>,
) {
  const client = yield* resolveConnectionClientTask({
    plan,
    name,
    task,
    sites: sitesUnder(invocationAuthorityForPlan(plan)?.sites ?? [], ["tooling", name]),
  });
  const resolved = yield* resolveToolingTaskShape(client.task, {}, client.sites);
  return yield* compileToolingInvocations({
    name,
    lookupKey: name,
    task: resolved,
    args: raw,
    cwd: String(plan.root),
    source: {
      path: toolingSourcePathForPlan(plan, name),
      task: name,
    },
  }).pipe(
    Effect.flatMap((compiled) =>
      runBracketedInvocations({
        plan,
        tool: name,
        lookupKey: name,
        invocations: compiled.invocations,
        requiresProvider: requiresProvider(compiled.normalized),
      }),
    ),
  );
});
