import { join } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { ConfigService, FileSystem, GlobalAppService } from "@lando/sdk/services";

export { GlobalAppService } from "@lando/sdk/services";

export const GLOBAL_APP_ID = "global";

const makeGlobalAppService = (
  configService: Context.Tag.Service<typeof ConfigService>,
  fileSystem: Context.Tag.Service<typeof FileSystem>,
): Context.Tag.Service<typeof GlobalAppService> => {
  const root = configService.get("userDataRoot").pipe(
    Effect.mapError(
      (cause) =>
        new GlobalAppError({
          message: "Unable to resolve the user data root for the global app.",
          operation: "root",
          cause,
        }),
    ),
    Effect.flatMap((userDataRoot) =>
      userDataRoot === undefined
        ? Effect.fail(
            new GlobalAppError({
              message: "No user data root is configured; cannot locate the global app directory.",
              operation: "root",
              remediation: "Set userDataRoot in the Lando config or LANDO_USER_DATA_ROOT.",
            }),
          )
        : Effect.succeed(AbsolutePath.make(join(userDataRoot, GLOBAL_APP_ID))),
    ),
  );

  const ensureRoot = root.pipe(
    Effect.flatMap((path) =>
      fileSystem.mkdir(path).pipe(
        Effect.mapError(
          (cause) =>
            new GlobalAppError({
              message: `Unable to create the global app directory at ${path}.`,
              operation: "ensureRoot",
              cause,
            }),
        ),
      ),
    ),
  );

  return { id: GLOBAL_APP_ID, root, ensureRoot };
};

export const GlobalAppServiceLive = Layer.effect(
  GlobalAppService,
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const fileSystem = yield* FileSystem;
    return makeGlobalAppService(configService, fileSystem);
  }),
);
