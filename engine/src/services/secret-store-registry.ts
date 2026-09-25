import {
  LandoRuntimeBootstrapError,
  SecretReferenceInvalidError,
  type SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import type { LandoPluginModule, SecretStoreContributionLayer } from "@lando/sdk/plugins";
import { parseSecretReference } from "@lando/sdk/secrets";
import {
  ConfigService,
  type FileSystem,
  type PathsService,
  type ProcessRunner,
  SecretStore,
  type SecretStoreShape,
} from "@lando/sdk/services";
import { Context, Effect, Either, Layer, Scope } from "effect";
import { makePluginCapabilityIndex } from "../plugins/module-set.ts";
import { SecretStoreLive } from "./secret-store.ts";

export interface SecretStoreRegistration {
  readonly id: string;
  readonly schemes: readonly string[];
  readonly layer: SecretStoreContributionLayer;
}

export class SecretStoreRegistry extends Context.Tag("@lando/core/SecretStoreRegistry")<
  SecretStoreRegistry,
  {
    readonly list: Effect.Effect<readonly SecretStoreRegistration[]>;
    readonly select: (id: string) => Effect.Effect<SecretStoreRegistration, SecretReferenceInvalidError>;
  }
>() {}

const invalidReference = (reference: string) =>
  new SecretReferenceInvalidError({
    message: "No installed secret store owns this reference.",
    reference,
    remediation: "Install the store owning this scheme or set defaultSecretStore to an installed store id.",
  });

const bootstrapError = (message: string, cause?: unknown) =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "minimal",
    cause,
  });

export const makeSecretStoreRegistryLive = (modules: readonly LandoPluginModule[]) =>
  Layer.effect(
    SecretStoreRegistry,
    Effect.gen(function* () {
      const index = yield* makePluginCapabilityIndex(modules).pipe(
        Either.mapLeft((cause) =>
          bootstrapError("Invalid secret store plugin descriptor. Repair the plugin descriptor.", cause),
        ),
      );
      const registrations = new Map<string, SecretStoreRegistration>([
        ["env", { id: "env", schemes: [], layer: SecretStoreLive }],
      ]);
      const schemes = new Set<string>();
      for (const manifest of index.manifests) {
        for (const contribution of manifest.contributes?.secretStores ?? []) {
          const layer = index.secretStores.get(contribution.id);
          if (layer === undefined || registrations.has(contribution.id)) {
            return yield* Effect.fail(
              bootstrapError(
                `Invalid or duplicate secret store ${contribution.id}. Repair its contribution.`,
              ),
            );
          }
          for (const scheme of contribution.schemes) {
            if (!/^[a-z][a-z0-9-]*$/.test(scheme) || schemes.has(scheme)) {
              return yield* Effect.fail(
                bootstrapError(
                  `Invalid or duplicate secret scheme ${scheme}. Give every scheme exactly one owner.`,
                ),
              );
            }
            schemes.add(scheme);
          }
          registrations.set(contribution.id, { id: contribution.id, schemes: contribution.schemes, layer });
        }
      }
      return {
        list: Effect.succeed([...registrations.values()]),
        select: (id: string) => {
          const registration = registrations.get(id);
          return registration === undefined
            ? Effect.fail(invalidReference(id))
            : Effect.succeed(registration);
        },
      };
    }),
  );

export const RoutedSecretStoreLive = Layer.scoped(
  SecretStore,
  Effect.gen(function* () {
    const registry = yield* SecretStoreRegistry;
    const config = yield* ConfigService;
    const scope = yield* Scope.Scope;
    const dependencies = yield* Effect.context<ProcessRunner | PathsService | FileSystem>();
    const registrations = yield* registry.list;
    const stores = new Map<string, Effect.Effect<SecretStoreShape, SecretStoreUnavailableError>>();
    const owners = new Map<string, string>();
    for (const registration of registrations) {
      const store = yield* Effect.cached(
        Layer.buildWithScope(registration.layer, scope).pipe(
          Effect.provide(dependencies),
          Effect.map((context) => Context.get(context, SecretStore)),
        ),
      );
      stores.set(registration.id, store);
      for (const scheme of registration.schemes) owners.set(scheme, registration.id);
    }
    const select = (raw: string) =>
      Effect.gen(function* () {
        const reference = yield* parseSecretReference(raw);
        const id =
          reference.scheme === undefined
            ? ((yield* config.get("defaultSecretStore").pipe(Effect.mapError(() => invalidReference(raw)))) ??
              "env")
            : owners.get(reference.scheme);
        const store = id === undefined ? undefined : stores.get(id);
        if (store === undefined) return yield* Effect.fail(invalidReference(raw));
        return yield* store;
      });
    return {
      id: "routed",
      schemes: [...owners.keys()],
      get: (reference) => select(reference).pipe(Effect.flatMap((store) => store.get(reference))),
      has: (reference) =>
        select(reference).pipe(
          Effect.flatMap((store) => store.has(reference)),
          Effect.catchTag("SecretReferenceInvalidError", () => Effect.succeed(false)),
        ),
      list: Effect.forEach([...stores.values()], (store) =>
        store.pipe(
          Effect.flatMap((member) => member.list),
          Effect.catchTag("SecretStoreUnavailableError", () => Effect.succeed([])),
        ),
      ).pipe(Effect.map((lists) => [...new Set(lists.flat())].sort())),
    } satisfies SecretStoreShape;
  }),
);
