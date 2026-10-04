import { ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import * as EngineLandofileServiceLayer from "../../src/services/landofile-live.ts";

export const layerTransactionGuard = Layer.succeed(
  ManagedFileTransactionGuard,
  ManagedFileTransactionGuard.of({
    ensureConsistent: () => Effect.void,
    pending: () => Effect.succeed(null),
  }),
);

const testStateStoreLayer = Layer.succeed(
  StateStore,
  makeStateStore({
    privateFileAccess: {
      enforce: async () => undefined,
      verify: async () => undefined,
    },
  }),
);

export const layer = EngineLandofileServiceLayer.layerDefault.pipe(
  Layer.provide(Layer.merge(layerTransactionGuard, testStateStoreLayer)),
);
