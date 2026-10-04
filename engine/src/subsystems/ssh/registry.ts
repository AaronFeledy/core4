import { Context, Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { FileSystem, GlobalAppService, PathsService, SshService } from "@lando/sdk/services";

import { bundledPluginModules } from "../../composition.ts";
import { indexContributions, selectRegistration } from "../../plugins/capability-registry.ts";
import * as UnavailableSshService from "./api.ts";

export type SshServiceLayer = Layer.Layer<SshService, SshError, FileSystem | GlobalAppService | PathsService>;

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

export class SshServiceRegistry extends Context.Service<SshServiceRegistry, SshServiceRegistryShape>()(
  "@lando/engine/SshServiceRegistry",
) {
  static readonly layerWith = (modules: ReadonlyArray<LandoPluginModule>) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const registrations = yield* registrationsFromModules(modules);
        const byId = new Map(registrations.map((registration) => [registration.id, registration]));

        return SshServiceRegistry.of({
          list: Effect.succeed([...byId.keys()]),
          select: Effect.fn("SshServiceRegistry.select")(function* (selection = {}) {
            if (selection.explicit !== undefined) {
              const selected = yield* selectRegistration({
                registrations: byId,
                id: selection.explicit,
                onMissing: (id) => selectionError(`SSH service ${id} is not installed.`, id),
              });
              return selected.registration;
            }

            // Return the first (and likely only) SSH service
            const sole = registrations[0];
            if (sole !== undefined) return sole;

            return yield* Effect.fail(
              selectionError("No SshService plugin could be selected unambiguously.", "unknown"),
            );
          }),
        });
      }),
    );

  static readonly layer = Layer.suspend(() => this.layerWith(bundledPluginModules()));
}

const selectionError = (message: string, sshId: string): SshError =>
  new SshError({
    message,
    sshId,
  });

const registrationsFromModules = Effect.fnUntraced(function* (
  modules: ReadonlyArray<LandoPluginModule>,
): Effect.fn.Return<ReadonlyArray<SshServiceRegistration>, SshError> {
  const indexed = yield* indexContributions(modules, "sshServices", () =>
    selectionError("Unable to discover SshService contributions.", "unknown"),
  );
  const contributions = modules.flatMap(({ manifest }) => manifest.contributes?.sshServices ?? []);
  return yield* Effect.forEach(contributions, (contribution) => {
    const layer = indexed.get(contribution.id);
    return layer === undefined
      ? Effect.fail(
          new SshError({
            message: `SSH service descriptor does not export ${contribution.id}.`,
            sshId: contribution.id,
          }),
        )
      : Effect.succeed({
          id: contribution.id,
          layer,
          ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
        });
  });
});

export const layerSelected = Layer.unwrap(
  Effect.flatMap(SshServiceRegistry, (registry) =>
    Effect.flatMap(registry.list, (ids) =>
      ids.length === 0
        ? Effect.succeed(UnavailableSshService.layerUnavailable)
        : registry.select().pipe(Effect.map((selected) => selected.layer)),
    ),
  ),
);
