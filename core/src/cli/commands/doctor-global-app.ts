/**
 * Read-only global-app diagnostics; never require app bootstrap.
 * The last install timestamp comes from the dist Landofile mtime.
 */

import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as LandoLogger from "@lando/engine/logging/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import type { ConfigService } from "@lando/sdk/services";
import { FileSystem, GlobalAppService, PluginRegistry } from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";
import { failCheck, passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding, DoctorSectionResult, DoctorSolution } from "./doctor-contract";

const NOT_INSTALLED_SOLUTION: DoctorSolution = {
  kind: "manual",
  description:
    "The global app is not installed yet. Starting an app that needs Traefik, Mailpit, or ssh-agent will provision it automatically. To materialize the stack now, run `lando global:reconcile`.",
  command: "lando global:reconcile",
};

/**
 * Extract the top-level service ids from the generated dist Landofile content.
 *
 * The dist file is machine-generated and consistently formatted: service keys
 * are indented by exactly two spaces directly under the `services:` block.
 */
const parseServiceIds = (content: string): ReadonlyArray<string> => {
  const serviceIds: string[] = [];
  let inServices = false;
  for (const line of content.split(/\r?\n/)) {
    if (line === "services:") {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    const match = /^ {2}([a-zA-Z0-9_-]+):/.exec(line);
    if (match !== null) {
      serviceIds.push(match[1] as string);
    } else if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) {
      break;
    }
  }
  return serviceIds;
};

export const globalAppDoctor = Effect.fnUntraced(function* (): Effect.fn.Return<
  DoctorSectionResult,
  never,
  GlobalAppService | PluginRegistry | FileSystem
> {
  const globalApp = yield* GlobalAppService;
  const pluginRegistry = yield* PluginRegistry;
  const fileSystem = yield* FileSystem;

  const paths = yield* globalApp.paths.pipe(Effect.catch(() => Effect.succeed(undefined)));

  const manifests = yield* pluginRegistry.list.pipe(Effect.catch(() => Effect.succeed([])));

  const contributingPlugins = manifests
    .filter((manifest) => (manifest.contributes?.globalServices ?? []).length > 0)
    .map((manifest) => manifest.name)
    .sort();

  if (paths === undefined) {
    const check: DoctorFinding = warnCheck({
      name: "global-app",
      context: { installed: "false" },
      solutions: [NOT_INSTALLED_SOLUTION],
    });
    return { checks: [check] };
  }

  const context: Record<string, string | ReadonlyArray<string>> = {
    installed: "false",
    distLandofilePath: String(paths.distLandofile),
    userLandofilePath: String(paths.userLandofile),
  };
  if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

  const exists = yield* fileSystem
    .exists(paths.distLandofile)
    .pipe(Effect.catch(() => Effect.succeed(false)));

  if (!exists) {
    const check: DoctorFinding = warnCheck({
      name: "global-app",
      context,
      solutions: [NOT_INSTALLED_SOLUTION],
    });
    return { checks: [check] };
  }

  const stat = yield* fileSystem
    .lstat(paths.distLandofile)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));

  const content = yield* Effect.result(fileSystem.readText(paths.distLandofile));
  const lastInstallTimestamp =
    stat !== undefined ? DateTime.formatIso(DateTime.makeUnsafe(stat.mtimeMs)) : undefined;
  context.installed = "true";
  if (lastInstallTimestamp !== undefined) context.lastInstallTimestamp = lastInstallTimestamp;

  if (content._tag === "Failure") {
    context.readError = content.failure.message;

    const check: DoctorFinding = failCheck({
      name: "global-app",
      context,
      solutions: [
        {
          kind: "manual",
          description:
            "The global app dist Landofile exists but could not be read. Check file permissions and rerun `lando global:reconcile` if needed.",
        },
      ],
    });
    return { checks: [check] };
  }

  const serviceIds = parseServiceIds(content.success);

  context.services = serviceIds;

  const check: DoctorFinding = passCheckNamed({
    name: "global-app",
    context,
  });

  return { checks: [check] };
});

export const DefaultGlobalAppDoctorLayer: Layer.Layer<
  GlobalAppService | PluginRegistry | FileSystem,
  never,
  ConfigService
> = Layer.mergeAll(
  GlobalAppServiceLayer.layer.pipe(Layer.provide(BunFileSystem.layer)),
  PluginRegistryLayer.layer.pipe(Layer.provideMerge(LandoLogger.layer({ mode: "silent" }))),
  BunFileSystem.layer,
);
