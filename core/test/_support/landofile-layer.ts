import { LandofileServiceLive, makeEngineLandofileServiceLive } from "@lando/engine/services/landofile-live";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

export const NoopTransactionGuardLive = Layer.succeed(ManagedFileTransactionGuard, {
  ensureConsistent: () => Effect.void,
  pending: () => Effect.succeed(null),
});

export const TestLandofileServiceLive = LandofileServiceLive.pipe(Layer.provide(NoopTransactionGuardLive));

export const makeTestLandofileServiceLive = (inputs: Parameters<typeof makeEngineLandofileServiceLive>[0]) =>
  makeEngineLandofileServiceLive(inputs).pipe(Layer.provide(NoopTransactionGuardLive));
