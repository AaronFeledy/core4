import { Context, Effect, Layer } from "effect";

import type { LandoPaths } from "@lando/paths";
import type {
  HostMaintenanceContribution,
  HostRuntimePaths,
  HostTeardownResult,
  LandoPluginModule,
} from "@lando/sdk/plugins";
import { AbsolutePath, type HostPlatform } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { makePluginStateStore } from "../plugins/context-state.ts";

export interface HostMaintenanceRegistryShape {
  readonly maintainers: ReadonlyArray<HostMaintenanceContribution & { readonly pluginId: string }>;
}

export class HostMaintenanceRegistry extends Context.Service<
  HostMaintenanceRegistry,
  HostMaintenanceRegistryShape
>()("@lando/engine/HostMaintenanceRegistry") {}

export const makeHostMaintenanceRegistryLayer = (
  modules: ReadonlyArray<LandoPluginModule>,
): Layer.Layer<HostMaintenanceRegistry> =>
  Layer.succeed(
    HostMaintenanceRegistry,
    HostMaintenanceRegistry.of({
      maintainers: modules.flatMap((module) =>
        (module.hostMaintainers ?? []).map((maintainer) => ({ ...maintainer, pluginId: module.name })),
      ),
    }),
  );

export const teardownHostMaintainers = (
  registry: HostMaintenanceRegistryShape,
  input: {
    readonly paths: HostRuntimePaths & Pick<LandoPaths, "pluginStateDir">;
    readonly platform: HostPlatform;
    readonly stateStore: StateStoreShape;
    readonly privateFileAccess: PrivateFileAccess;
  },
): Effect.Effect<HostTeardownResult> =>
  Effect.forEach(registry.maintainers, (maintainer) =>
    maintainer.teardown === undefined
      ? Effect.succeed({ terminated: false } satisfies HostTeardownResult)
      : maintainer.teardown({
          paths: input.paths,
          platform: input.platform,
          stateStore: makePluginStateStore(
            input.stateStore,
            AbsolutePath.make(input.paths.pluginStateDir(maintainer.pluginId)),
            input.privateFileAccess,
          ),
        }),
  ).pipe(
    Effect.map((results) => {
      const resultWithPid = results.find((result) => result.pid !== undefined);
      return {
        terminated: results.some((result) => result.terminated),
        ...(resultWithPid?.pid === undefined ? {} : { pid: resultWithPid.pid }),
      };
    }),
  );
