import { Effect } from "effect";

import {
  GlobalAppError,
  type GlobalDistConflictError,
  type GlobalLandofilePathConflictError,
} from "@lando/sdk/errors";
import type { GlobalAppPaths, GlobalDistResult } from "@lando/sdk/services";
import { GlobalAppService } from "@lando/sdk/services";

export interface GlobalInstallOptions {
  readonly plugin?: string;
}

export interface GlobalInstallResult {
  readonly paths: GlobalAppPaths;
  readonly dist: GlobalDistResult;
  readonly userLandofileCreated: boolean;
}

const pluginInstallError = (plugin: string): GlobalAppError =>
  new GlobalAppError({
    message: `Global service plugin installation for ${plugin} is not available yet.`,
    operation: "install",
    remediation:
      "Plugin global-service enablement is a later deliverable; run `lando global:install` with no argument to materialize the global app.",
  });

export const globalInstall = (
  options: GlobalInstallOptions = {},
): Effect.Effect<
  GlobalInstallResult,
  GlobalAppError | GlobalDistConflictError | GlobalLandofilePathConflictError,
  GlobalAppService
> =>
  Effect.gen(function* () {
    if (options.plugin !== undefined && options.plugin !== "") {
      return yield* Effect.fail(pluginInstallError(options.plugin));
    }

    const globalApp = yield* GlobalAppService;
    yield* Effect.scoped(globalApp.ensureRoot);
    const user = yield* globalApp.ensureUserLandofile;
    const dist = yield* globalApp.regenerateDist({});
    const paths = yield* globalApp.paths;

    return {
      paths,
      dist,
      userLandofileCreated: user.created,
    };
  });

export const renderGlobalInstallResult = (result: GlobalInstallResult): string =>
  [
    "Global app Landofile stack materialized.",
    `Generated dist Landofile: ${result.dist.path} (${result.dist.status})`,
    `User Landofile: ${result.paths.userLandofile} (${result.userLandofileCreated ? "created" : "preserved"})`,
    `Global services: ${result.dist.serviceIds.length === 0 ? "none" : result.dist.serviceIds.join(", ")}`,
  ].join("\n");
