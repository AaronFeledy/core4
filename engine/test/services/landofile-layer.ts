import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { LandofileServiceLive } from "../../src/services/landofile-live.ts";

export const NoopTransactionGuardLive = Layer.succeed(ManagedFileTransactionGuard, {
  ensureConsistent: () => Effect.void,
  pending: () => Effect.succeed(null),
});

export const TestLandofileServiceLive = LandofileServiceLive.pipe(Layer.provide(NoopTransactionGuardLive));
