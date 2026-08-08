import { Effect, Layer } from "effect";

import { HealthcheckRunner, RuntimeProvider } from "@lando/sdk/services";

import { makeHealthcheckRunner } from "./runner-factory.ts";

export const HealthcheckRunnerLive: Layer.Layer<HealthcheckRunner, never, RuntimeProvider> = Layer.effect(
  HealthcheckRunner,
  Effect.map(RuntimeProvider, (provider) => makeHealthcheckRunner({ exec: provider.exec })),
);
