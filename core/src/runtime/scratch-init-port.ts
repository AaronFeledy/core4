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
    const sources = yield* retainedRecipeSources();
    const context = yield* Effect.context<ProcessRunner>();
    const run = Effect.runPromiseWith(context);
    return ScratchInitAppPort.of({
      initApp: (options) =>
        run(
          initApp({
            ...sources,
            ...options,
            privateFileAccess,
          }),
        ),
    });
  }),
);
