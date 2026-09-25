import { Effect } from "effect";

import { exactSecretReferenceId } from "@lando/landofile/secret-reference";
import { SecretNotFoundError, type SecretStoreError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { SecretStore, type ServiceEnvironmentOverrides } from "@lando/sdk/services";

export const resolveServiceEnvironmentSecrets = (
  plan: AppPlan,
): Effect.Effect<ServiceEnvironmentOverrides, SecretStoreError> =>
  Effect.gen(function* () {
    const storeOption = yield* Effect.serviceOption(SecretStore);
    const services = yield* Effect.forEach(Object.values(plan.services), (service) =>
      Effect.forEach(Object.entries(service.environment), ([key, value]) => {
        const secret = exactSecretReferenceId(value);
        if (secret === undefined) return Effect.succeed([key, value] as const);
        if (storeOption._tag === "None") {
          return Effect.fail(
            new SecretNotFoundError({
              message: `Secret '${secret}' cannot be resolved because no SecretStore is installed.`,
              secret,
              remediation: "Install a SecretStore implementation and retry the provider action.",
            }),
          );
        }
        return storeOption.value.get(secret).pipe(Effect.map((resolved) => [key, resolved] as const));
      }).pipe(Effect.map((environment) => [service.name, Object.fromEntries(environment)] as const)),
    );
    return Object.fromEntries(services);
  });
