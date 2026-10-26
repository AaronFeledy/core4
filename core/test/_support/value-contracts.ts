import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { SecretNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  CurrentExecutableAppPlan,
  type LandofileShape,
  LoadScopedLandofile,
} from "@lando/sdk/schema";
import { SecretStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

export const currentTestPlan = (
  input: Omit<CurrentExecutableAppPlan, "valueModel">,
): CurrentExecutableAppPlan => CurrentExecutableAppPlan.make({ ...input, valueModel: 1 });

/** Already-loaded literal data only; authored expressions must use the real compiler. */
export const literalLandofile = (document: LandofileShape, root: string): LoadScopedLandofile =>
  LoadScopedLandofile.make({
    stage: "load-scoped",
    document,
    pendingSites: [],
    context: { appRoot: AbsolutePath.make(root), env: {} },
  });

export const environmentResolverLayer = (
  values: Readonly<Record<string, string>> = {},
  redaction = makeRedactionService(),
) => {
  const store = SecretStore.of({
    id: "core-test",
    get: (reference) => {
      const value = values[reference];
      return value === undefined
        ? Effect.fail(
            new SecretNotFoundError({
              secret: reference,
              message: "Test secret is not seeded.",
              remediation: "Seed the required reference in this test fixture.",
            }),
          )
        : Effect.succeed(value);
    },
    has: (reference) => Effect.succeed(Object.hasOwn(values, reference)),
    list: Effect.succeed(Object.keys(values)),
  });
  return EnvironmentValueResolverLayer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(SecretStore, store), Layer.succeed(RedactionService, redaction)),
    ),
  );
};
