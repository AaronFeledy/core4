import { LandofileServiceLive, makeEngineLandofileServiceLive } from "@lando/engine/services/landofile-live";
import { ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";

export const NoopTransactionGuardLive = Layer.succeed(ManagedFileTransactionGuard, {
  ensureConsistent: () => Effect.void,
  pending: () => Effect.succeed(null),
});

export const TestStateStoreLive = Layer.succeed(
  StateStore,
  makeStateStore({
    privateFileAccess: {
      enforce: async () => undefined,
      verify: async () => undefined,
    },
  }),
);

const TestLandofileDependencies = Layer.merge(NoopTransactionGuardLive, TestStateStoreLive);

export const TestLandofileServiceLive = LandofileServiceLive.pipe(Layer.provide(TestLandofileDependencies));

export const makeTestLandofileServiceLive = (inputs: Parameters<typeof makeEngineLandofileServiceLive>[0]) =>
  makeEngineLandofileServiceLive(inputs).pipe(Layer.provide(TestLandofileDependencies));
