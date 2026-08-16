import { Context, Effect, Either, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { type SshService } from "@lando/sdk/services";

import { bundledPluginModules } from "../../composition.ts";
import { makePluginCapabilityIndex } from "../../plugins/module-set.ts";
import { SshServiceUnavailableLive } from "./api.ts";

export type SshServiceLayer = Layer.Layer<SshService, SshError>;

export interface SshServiceRegistration {
  readonly id: string;
  readonly layer: SshServiceLayer;
  readonly defaultFor?: {
    readonly platform?: ReadonlyArray<string> | undefined;
  };
}

export interface SshServiceSelection {
  readonly explicit?: string;
}

interface SshServiceRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<string>>;
  readonly select: (selection?: SshServiceSelection) => Effect.Effect<SshServiceRegistration, SshError>;
}

export class SshServiceRegistry extends Context.Tag("@lando/core/SshServiceRegistry")<
  SshServiceRegistry,
  SshServiceRegistryShape
>() {}

const selectionError = (message: string, sshId: string): SshError =>
  new SshError({
    message,
    sshId,
    remediation: "Install an SshService plugin or configure `defaultSshService` to an installed id.",
  });

const registrationsFromModules = (
  modules: ReadonlyArray<LandoPluginModule>,
): Effect.Effect<ReadonlyArray<SshServiceRegistration>, SshError> =>
  Effect.gen(function* () {
    const indexResult = makePluginCapabilityIndex(modules);
    if (Either.isLeft(indexResult)) return yield* Effect.fail(selectionError("Unable to discover SshService contributions.", "unknown"));
    const index = indexResult.right;
    const contributions = index.manifests.flatMap((manifest) => manifest.contributes?.sshServices ?? []);
    return yield* Effect.forEach(contributions, (contribution) => {
      const layer = index.sshServices?.get(contribution.id);
      return layer === undefined
        ? Effect.fail(
            new SshError({
              message: `SSH service descriptor does not export ${contribution.id}.`,
              sshId: contribution.id,
              remediation:
                "Repair the plugin sshServices map and regenerate the BUNDLED_PLUGIN_MODULES descriptor table.",
            }),
          )
        : Effect.succeed({
            id: contribution.id,
            layer,
            ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
          });
    });
  });

export const makeSshServiceRegistryLive = (modules: ReadonlyArray<LandoPluginModule>) =>
  Layer.effect(
    SshServiceRegistry,
    Effect.gen(function* () {
      const registrations = yield* registrationsFromModules(modules);
      const byId = new Map(registrations.map((registration) => [registration.id, registration]));
      
      return {
        list: Effect.succeed([...byId.keys()]),
        select: (selection = {}) =>
          Effect.gen(function* () {
            if (selection.explicit !== undefined) {
              const registration = byId.get(selection.explicit);
              return registration === undefined
                ? yield* Effect.fail(selectionError(`SSH service ${selection.explicit} is not installed.`, selection.explicit))
                : registration;
            }
            
            // Return the first (and likely only) SSH service
            const sole = registrations[0];
            if (sole !== undefined) return sole;
            
            return yield* Effect.fail(
              selectionError("No SshService plugin could be selected unambiguously.", "unknown"),
            );
          }),
      };
    }),
  );

export const SshServiceRegistryLive = Layer.suspend(() =>
  makeSshServiceRegistryLive(bundledPluginModules()),
);

export const SelectedSshServiceLive = Layer.unwrapEffect(
  Effect.flatMap(SshServiceRegistry, (registry) =>
    Effect.flatMap(registry.list, (ids) =>
      ids.length === 0
        ? Effect.succeed(SshServiceUnavailableLive)
        : registry
            .select()
            .pipe(
              Effect.map((selected) => selected.layer),
            ),
    ),
  ),
);
