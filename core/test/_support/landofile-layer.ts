import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { LandofileServiceLive, makeEngineLandofileServiceLive } from "../../src/testing/engine-layers.ts";

export const NoopTransactionGuardLive = Layer.succeed(ManagedFileTransactionGuard, {
  ensureConsistent: () => Effect.void,
  pending: () => Effect.succeed(null),
});

export const TestLandofileServiceLive = LandofileServiceLive.pipe(Layer.provide(NoopTransactionGuardLive));

export const makeTestLandofileServiceLive = (inputs: Parameters<typeof makeEngineLandofileServiceLive>[0]) =>
  makeEngineLandofileServiceLive(inputs).pipe(Layer.provide(NoopTransactionGuardLive));
