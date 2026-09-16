import { Effect, Layer } from "effect";

import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { initApp } from "../cli/commands/init";

export const ScratchInitAppPortLive = Layer.effect(
  ScratchInitAppPort,
  Effect.gen(function* () {
    const privateFileAccess = yield* PrivateFileAccessService;
    return {
      initApp: (options) =>
        initApp({
          ...options,
          privateFileAccess,
        }),
    };
  }),
);
