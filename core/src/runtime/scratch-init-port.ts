import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";
import type { ProcessRunner, StateStore } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";

import { initApp } from "../cli/commands/init";
import { retainedRecipeSourceStore } from "../recipes/runtime-sources";

export const layer = Layer.effect(
  ScratchInitAppPort,
  Effect.gen(function* () {
    const privateFileAccess = yield* PrivateFileAccessService;
    const context = yield* Effect.context<ProcessRunner | StateStore>();
    const run = Effect.runPromiseWith(context);
    return ScratchInitAppPort.of({
      initApp: (options) =>
        run(
          Effect.gen(function* () {
            const { store: recipeSourceStore } = yield* retainedRecipeSourceStore();
            return yield* initApp({
              recipeSourceStore,
              ...options,
              privateFileAccess,
            });
          }),
        ),
    });
  }),
);
