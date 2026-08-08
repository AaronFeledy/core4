import { Context, Effect, Layer } from "effect";

import type {
  HostMaintenanceContribution,
  HostRuntimePaths,
  HostTeardownResult,
  LandoPluginModule,
} from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";

export interface HostMaintenanceRegistryShape {
  readonly maintainers: ReadonlyArray<HostMaintenanceContribution>;
}

export class HostMaintenanceRegistry extends Context.Tag("@lando/core/HostMaintenanceRegistry")<
  HostMaintenanceRegistry,
  HostMaintenanceRegistryShape
>() {}

export const makeHostMaintenanceRegistryLayer = (
  modules: ReadonlyArray<LandoPluginModule>,
): Layer.Layer<HostMaintenanceRegistry> =>
  Layer.succeed(HostMaintenanceRegistry, {
    maintainers: modules.flatMap((module) => module.hostMaintainers ?? []),
  });

export const teardownHostMaintainers = (
  registry: HostMaintenanceRegistryShape,
  input: { readonly paths: HostRuntimePaths; readonly platform: HostPlatform },
): Effect.Effect<HostTeardownResult> =>
  Effect.forEach(registry.maintainers, (maintainer) => maintainer.teardown(input)).pipe(
    Effect.map((results) => {
      const resultWithPid = results.find((result) => result.pid !== undefined);
      return {
        terminated: results.some((result) => result.terminated),
        ...(resultWithPid?.pid === undefined ? {} : { pid: resultWithPid.pid }),
      };
    }),
  );
