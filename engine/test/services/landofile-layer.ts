import { ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import { LandofileServiceLive } from "../../src/services/landofile-live.ts";

export const NoopTransactionGuardLive = Layer.succeed(ManagedFileTransactionGuard, {
  ensureConsistent: () => Effect.void,
  pending: () => Effect.succeed(null),
});

const TestStateStoreLive = Layer.succeed(
  StateStore,
  makeStateStore({
    privateFileAccess: {
      enforce: async () => undefined,
      verify: async () => undefined,
    },
  }),
);

export const TestLandofileServiceLive = LandofileServiceLive.pipe(
  Layer.provide(Layer.merge(NoopTransactionGuardLive, TestStateStoreLive)),
);
