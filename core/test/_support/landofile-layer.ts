import * as EngineLandofileServiceLayer from "@lando/engine/services/landofile-live";
import { ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";

export const layerTransactionGuard = Layer.succeed(ManagedFileTransactionGuard, {
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

const TestLandofileDependencies = Layer.merge(layerTransactionGuard, TestStateStoreLive);

export const layer = EngineLandofileServiceLayer.layerDefault.pipe(Layer.provide(TestLandofileDependencies));

export const layerWithInputs = (inputs: Parameters<typeof EngineLandofileServiceLayer.layer>[0]) =>
  EngineLandofileServiceLayer.layer(inputs).pipe(Layer.provide(TestLandofileDependencies));
