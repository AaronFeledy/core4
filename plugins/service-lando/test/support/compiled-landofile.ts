import * as BunProcessRunner from "@lando/engine/services/process-runner";
import * as EnvironmentResolver from "@lando/engine/testing/environment-value-resolver";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { SecretNotFoundError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { SecretStore } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Schema } from "effect";

/** Compile authored fixture expressions instead of granting an empty pending-site list. */
export const compileTestLandofile = (document: LandofileShape) =>
  Effect.runSync(
    loadAuthoredDocuments(
      [{ file: `${process.cwd()}/.lando.yml`, value: Schema.encodeSync(LandofileShape)(document) }],
      { appRoot: process.cwd(), file: `${process.cwd()}/.lando.yml` },
    ),
  );

export const toolingValueResolverLayer = EnvironmentResolver.layer.pipe(
  Layer.provide(
    Layer.succeed(
      SecretStore,
      SecretStore.of({
        id: "fixture",
        has: () => Effect.succeed(false),
        list: Effect.succeed([]),
        get: (secret) =>
          Effect.fail(new SecretNotFoundError({ secret, message: "Fixture secret unavailable" })),
      }),
    ),
  ),
);

export const toolingExecutionLayer = Layer.mergeAll(
  PrivateFileAccessService.layer,
  BunProcessRunner.layer,
  toolingValueResolverLayer,
);
