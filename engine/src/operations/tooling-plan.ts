import { ToolingCompileError } from "@lando/sdk/errors";
import type { LoadScopedLandofile } from "@lando/sdk/schema";
import { AppPlanner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

const withProcessCwd = <A, E, R>(
  cwd: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ToolingCompileError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(cwd);
        return original;
      },
      catch: (cause) =>
        new ToolingCompileError({
          message: `Unable to enter the app directory at ${cwd}.`,
          tool: "tooling",
          cause,
        }),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

export const resolveToolingPlan = Effect.fnUntraced(function* (input: {
  readonly landofile: LoadScopedLandofile;
  readonly appRoot: string | undefined;
}) {
  const planner = yield* AppPlanner;
  const registry = yield* RuntimeProviderRegistry;
  const capabilities = yield* registry.capabilities;
  return yield* input.appRoot === undefined
    ? planner.plan(input.landofile, capabilities)
    : withProcessCwd(input.appRoot, () => planner.plan(input.landofile, capabilities));
});
