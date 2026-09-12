import {
  type PrivateFileAccess,
  PrivateFileAccessLive,
  PrivateFileAccessService,
} from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type AppConfigMigrateOptions, appConfigMigrate } from "../../src/cli/commands/app-config-migrate.ts";
import {
  type AppConfigTranslateOptions,
  appConfigTranslate,
} from "../../src/cli/commands/app-config-translate.ts";
import { type InitAppOptions, type InitAppResult, initApp } from "../../src/cli/commands/init.ts";

export const ownerOnlyFileAccess: PrivateFileAccess = {
  enforce: (path) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(PrivateFileAccessService, (access) => Effect.promise(() => access.enforce(path))).pipe(
          Effect.provide(PrivateFileAccessLive),
        ),
      ),
    ),
  verify: (path) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(PrivateFileAccessService, (access) => Effect.promise(() => access.verify(path))).pipe(
          Effect.provide(PrivateFileAccessLive),
        ),
      ),
    ),
};

export const initAppWithOwnerOnlyFileAccess = (
  options: Omit<InitAppOptions, "privateFileAccess">,
): Promise<InitAppResult> => initApp({ ...options, privateFileAccess: ownerOnlyFileAccess });

export const appConfigMigrateWithOwnerOnlyFileAccess = (options: AppConfigMigrateOptions = {}) =>
  appConfigMigrate({ ...options, privateFileAccess: ownerOnlyFileAccess });

export const appConfigTranslateWithOwnerOnlyFileAccess = (options: AppConfigTranslateOptions = {}) =>
  appConfigTranslate({ ...options, privateFileAccess: ownerOnlyFileAccess });

export { PrivateFileAccessLive as privateFileAccessLive };
