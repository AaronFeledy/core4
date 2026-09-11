import { Effect, Layer } from "effect";

import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";
import { ProcessRunnerLive } from "@lando/engine/services/process-runner";
import { ProcessRunner } from "@lando/sdk/services";
import { makeOwnerOnlyFileAccess } from "@lando/state-store/private-file-access";

import { initApp } from "../cli/commands/init";

export const ScratchInitAppPortLive = Layer.effect(
  ScratchInitAppPort,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    return {
      initApp: (options) =>
        initApp({
          ...options,
          privateFileAccess: makeOwnerOnlyFileAccess({ processRunner }),
        }),
    };
  }),
).pipe(Layer.provide(ProcessRunnerLive));
