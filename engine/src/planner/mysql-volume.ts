import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";

/** Select an unambiguous existing identity; never mutate provider storage. */
export const adoptMysqlVolume = (
  plan: AppPlan,
  registry: Context.Tag.Service<typeof RuntimeProviderRegistry> | undefined,
): Effect.Effect<AppPlan, LandofileValidationError> => {
  const mysqlServices = Object.values(plan.services).filter(
    (service) => service.type === "mysql" || service.type.startsWith("mysql:"),
  );
  const service = mysqlServices[0];
  if (registry === undefined || mysqlServices.length !== 1 || service === undefined) {
    return Effect.succeed(plan);
  }
  const scoped = `${plan.name}-${service.name}-mysql-data`;
  const legacy = `${plan.name}-mysql-data`;
  if (!service.storage.some((mount) => mount.store === scoped && mount.target === "/var/lib/mysql")) {
    return Effect.succeed(plan);
  }

  return Effect.gen(function* () {
    const provider = yield* registry.select(plan);
    const scopedVolumes = yield* provider.listVolumes({ app: plan.id, store: scoped });
    if (scopedVolumes.length > 0) return plan;
    const legacyVolumes = yield* provider.listVolumes({ app: plan.id, store: legacy });
    if (legacyVolumes.length === 0) return plan;
    return {
      ...plan,
      services: {
        ...plan.services,
        [service.name]: {
          ...service,
          storage: service.storage.map((mount) =>
            mount.store === scoped ? { ...mount, store: legacy } : mount,
          ),
        },
      },
      stores: plan.stores.map((store) => (store.name === scoped ? { ...store, name: legacy } : store)),
    };
  }).pipe(
    Effect.catchAll((cause) =>
      cause._tag === "ProviderUnavailableError"
        ? Effect.succeed(plan)
        : Effect.fail(
            new LandofileValidationError({
              message: `Cannot select MySQL storage: ${cause.message}. Restore provider access and retry; no volumes have been changed.`,
              file: `${plan.root}/.lando.yml`,
              issues: [`services.${service.name}.storage`],
            }),
          ),
    ),
  );
};
