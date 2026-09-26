import { Effect, Option } from "effect";

import { exactSecretReference } from "@lando/landofile/secret-reference";
import { RedactionService } from "@lando/redaction/service";
import { SecretNotFoundError, SecretReferenceInvalidError, type SecretStoreError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { SecretStore, type ServiceEnvironmentOverrides } from "@lando/sdk/services";

export const resolveServiceEnvironmentSecrets = (
  plan: AppPlan,
): Effect.Effect<ServiceEnvironmentOverrides, SecretStoreError> =>
  Effect.gen(function* () {
    const storeOption = yield* Effect.serviceOption(SecretStore);
    const redaction = yield* Effect.serviceOption(RedactionService);
    const services = yield* Effect.forEach(Object.values(plan.services), (service) =>
      Effect.forEach(Object.entries(service.environment), ([key, value]) => {
        const reference = exactSecretReference(value);
        if (reference === undefined) return Effect.succeed([key, value] as const);
        if (reference instanceof SecretReferenceInvalidError) return Effect.fail(reference);
        const secret = reference.raw;
        if (storeOption._tag === "None") {
          return Effect.fail(
            new SecretNotFoundError({
              message: `Secret '${secret}' cannot be resolved because no SecretStore is installed.`,
              secret,
              remediation: "Install a SecretStore implementation and retry the provider action.",
            }),
          );
        }
        return storeOption.value.get(secret).pipe(
          Effect.tap((resolved) =>
            Option.match(redaction, {
              onNone: () => Effect.void,
              onSome: (service) => service.registerValues([resolved]),
            }),
          ),
          Effect.map((resolved) => [key, resolved] as const),
        );
      }).pipe(Effect.map((environment) => [service.name, Object.fromEntries(environment)] as const)),
    );
    return Object.fromEntries(services);
  });
