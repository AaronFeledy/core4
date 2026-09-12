import { join } from "node:path";

import { LANDOFILE_NAME } from "@lando/landofile/discovery";
import type { AppPlan, ToolingTaskShape } from "@lando/sdk/schema";

import { runBracketedTooling } from "./tooling-bracket.ts";

/**
 * Runs a canonical `app:<task>` command reached from an event `command:` step.
 *
 * This is a second top-level tooling entry point, so it brackets `pre-<task>`/`post-<task>`
 * exactly like a direct CLI run. Re-entering the event that invoked it is rejected by the
 * active-frame guard rather than recursing. The authored `arguments` declaration is kept so
 * a task that refuses positionals still refuses them here.
 */
export const runEventToolingCommand = (
  plan: AppPlan,
  name: string,
  task: ToolingTaskShape,
  raw: ReadonlyArray<string>,
) =>
  runBracketedTooling({
    plan,
    name,
    lookupKey: name,
    task,
    args: raw,
    cwd: String(plan.root),
    source: { path: join(String(plan.root), LANDOFILE_NAME), task: name },
  });
