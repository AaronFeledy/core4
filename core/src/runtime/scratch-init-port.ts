import { Effect, Layer } from "effect";

import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";
import type { ProcessRunner } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { initApp } from "../cli/commands/init";
import { retainedRecipeSources } from "../recipes/runtime-sources";

export const layer = Layer.effect(
  ScratchInitAppPort,
  Effect.gen(function* () {
    const privateFileAccess = yield* PrivateFileAccessService;
    const context = yield* Effect.context<ProcessRunner>();
    const run = Effect.runPromiseWith(context);
    return ScratchInitAppPort.of({
      initApp: (options) =>
        run(
          Effect.gen(function* () {
            const sources = yield* retainedRecipeSources();
            return yield* initApp({
              ...sources,
              ...options,
              privateFileAccess,
            });
          }),
        ),
    });
  }),
);
