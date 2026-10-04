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
import { Context, Effect, Layer, Scope } from "effect";
import { indexContributions } from "../plugins/capability-registry.ts";
import * as EnvSecretStore from "./secret-store.ts";

export interface SecretStoreRegistration {
  readonly id: string;
  readonly schemes: readonly string[];
  readonly layer: SecretStoreContributionLayer;
}

export class SecretStoreRegistry extends Context.Service<
  SecretStoreRegistry,
  {
    readonly list: Effect.Effect<readonly SecretStoreRegistration[]>;
    readonly select: (id: string) => Effect.Effect<SecretStoreRegistration, SecretReferenceInvalidError>;
  }
>()("@lando/engine/SecretStoreRegistry") {
  static readonly layer = (modules: readonly LandoPluginModule[]) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const indexed = yield* indexContributions(modules, "secretStores", (cause) =>
          bootstrapError("Invalid secret store plugin descriptor. Repair the plugin descriptor.", cause),
        );
        const registrations = new Map<string, SecretStoreRegistration>([
          ["env", { id: "env", schemes: [], layer: EnvSecretStore.layer }],
        ]);
        const schemes = new Set<string>();
        for (const { manifest } of modules) {
          for (const contribution of manifest.contributes?.secretStores ?? []) {
            const layer = indexed.get(contribution.id);
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
        return SecretStoreRegistry.of({
          list: Effect.succeed([...registrations.values()]),
          select: (id: string) => {
            const registration = registrations.get(id);
            return registration === undefined
              ? Effect.fail(invalidReference(id))
              : Effect.succeed(registration);
          },
        });
      }),
    );
}

const invalidReference = (reference: string) =>
  new SecretReferenceInvalidError({
    message: "No installed secret store owns this reference.",
    reference,
    remediation: "Install the store owning this scheme or set defaultSecretStore to an installed store id.",
  });

const configReadFailure = (reference: string) =>
  new SecretReferenceInvalidError({
    message: `Could not read defaultSecretStore from Lando config while resolving '${reference}'.`,
    reference,
    remediation:
      "Repair the Lando config value for defaultSecretStore, then retry. Leave it unset to use the env store.",
  });

const bareIdNeedsStoreSupport = (reference: string, storeId: string) =>
  new SecretReferenceInvalidError({
    message: `The default secret store '${storeId}' does not accept bare ids; it needs bare-id support.`,
    reference,
    remediation: "Set defaultSecretStore to env for bare ids, or use a scheme reference owned by that store.",
  });

const bootstrapError = (message: string, cause?: unknown) =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "minimal",
    cause,
  });

export const layer = Layer.effect(
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
    const select = Effect.fnUntraced(function* (raw: string) {
      const reference = yield* Effect.fromResult(parseSecretReference(raw));
      const id =
        reference.scheme === undefined
          ? ((yield* config.get("defaultSecretStore").pipe(Effect.mapError(() => configReadFailure(raw)))) ??
            "env")
          : owners.get(reference.scheme);
      if (reference.scheme === undefined && id !== undefined) {
        const registration = registrations.find((entry) => entry.id === id);
        if (registration !== undefined && registration.schemes.length > 0) {
          return yield* Effect.fail(bareIdNeedsStoreSupport(raw, id));
        }
      }
      const store = id === undefined ? undefined : stores.get(id);
      if (store === undefined) return yield* Effect.fail(invalidReference(raw));
      return yield* store;
    });
    return SecretStore.of({
      id: "routed",
      schemes: [...owners.keys()],
      get: Effect.fn("SecretStore.get")((reference) =>
        select(reference).pipe(Effect.flatMap((store) => store.get(reference))),
      ),
      has: Effect.fn("SecretStore.has")((reference) =>
        select(reference).pipe(
          Effect.flatMap((store) => store.has(reference)),
          Effect.catchTag("SecretReferenceInvalidError", () => Effect.succeed(false)),
        ),
      ),
      list: Effect.forEach([...stores.values()], (store) =>
        store.pipe(
          Effect.flatMap((member) => member.list),
          Effect.catchTag("SecretStoreUnavailableError", () => Effect.succeed([])),
        ),
      ).pipe(Effect.map((lists) => [...new Set(lists.flat())].sort())),
    });
  }),
);
