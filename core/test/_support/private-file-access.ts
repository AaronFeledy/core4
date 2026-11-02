import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { ProcessRunner } from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type AppConfigMigrateOptions, appConfigMigrate } from "../../src/cli/commands/app-config-migrate.ts";
import {
  type AppConfigTranslateOptions,
  appConfigTranslate,
} from "../../src/cli/commands/app-config-translate.ts";
import { type InitAppOptions, type InitAppResult, initApp } from "../../src/cli/commands/init.ts";

export const ownerOnlyFileAccess: PrivateFileAccess = PrivateFileAccessService.of({
  enforce: (path) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(PrivateFileAccessService, (access) => Effect.promise(() => access.enforce(path))).pipe(
          Effect.provide(PrivateFileAccessService.layer),
        ),
      ),
    ),
  verify: (path) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(PrivateFileAccessService, (access) => Effect.promise(() => access.verify(path))).pipe(
          Effect.provide(PrivateFileAccessService.layer),
        ),
      ),
    ),
});

export const initAppWithOwnerOnlyFileAccess = (
  options: Omit<InitAppOptions, "privateFileAccess">,
  runner = Effect.runSync(ProcessRunner.pipe(Effect.provide(BunProcessRunner.layer))),
): Promise<InitAppResult> =>
  Effect.runPromise(
    initApp({ ...options, privateFileAccess: ownerOnlyFileAccess }).pipe(
      Effect.provideService(ProcessRunner, runner),
    ),
  );

export const initAppWithProcessRunner = (options: InitAppOptions): Promise<InitAppResult> =>
  Effect.runPromise(initApp(options).pipe(Effect.provide(BunProcessRunner.layer)));

export const appConfigMigrateWithOwnerOnlyFileAccess = (options: AppConfigMigrateOptions = {}) =>
  appConfigMigrate({ ...options, privateFileAccess: ownerOnlyFileAccess });

export const appConfigTranslateWithOwnerOnlyFileAccess = (options: AppConfigTranslateOptions = {}) =>
  appConfigTranslate({ ...options, privateFileAccess: ownerOnlyFileAccess });

export const privateFileAccessLayer = PrivateFileAccessService.layer;
