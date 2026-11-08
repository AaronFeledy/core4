import { withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import type { LoadScopedLandofile } from "@lando/sdk/schema";
import { AppPlanner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

export const resolveToolingPlan = Effect.fnUntraced(function* (input: {
  readonly landofile: LoadScopedLandofile;
  readonly appRoot: string | undefined;
}) {
  const planner = yield* AppPlanner;
  const registry = yield* RuntimeProviderRegistry;
  const capabilities = yield* registry.capabilities;
  return yield* input.appRoot === undefined
    ? planner.plan(input.landofile, capabilities)
    : withDiscoveryCwd(input.appRoot, planner.plan(input.landofile, capabilities));
});
