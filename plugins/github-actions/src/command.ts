import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";
import { Effect } from "effect";
import { renderInspection } from "./render.ts";
import { WorkflowInspection } from "./schema.ts";

export const spec = {
  id: "github-actions:list",
  namespace: "github-actions",
  bootstrap: "minimal",
  strict: true,
  flags: {
    root: { type: "string", description: "Repository directory (defaults to invocation working directory)." },
    workflow: {
      type: "string",
      description: "Exact .github/workflows/<filename>.yml or .yaml path; no glob patterns.",
    },
  },
  resultSchema: WorkflowInspection,
  run: (input) => {
    const root = input.flags.root === undefined ? process.cwd() : input.flags.root;
    const options = {
      root,
      ...(input.flags.workflow === undefined ? {} : { workflow: input.flags.workflow }),
    };
    return Effect.promise(() => import("./list.ts")).pipe(
      Effect.flatMap((module) => module.listWorkflowsFromInput(options)),
    );
  },
  completion: () => ({ ok: true, exitCode: 0 }),
  render: Effect.fnUntraced(function* ({ result }) {
    const renderer = yield* Renderer;
    yield* renderer.output.stdout(`${renderInspection(result)}\n`);
  }),
} as const satisfies ExecutableCommandSpec<WorkflowInspection>;
