/**
 * Global-app diagnostics for `lando doctor`.
 *
 * Reports whether the global app is installed, its materialized Landofile
 * paths, the last `meta:global:install` timestamp (derived from the dist file
 * mtime), the list of materialized global services, and the list of plugins
 * that contribute `globalServices:` entries.
 *
 * The check is read-only and never requires app bootstrap.  It requires only
 * `GlobalAppService`, `PluginRegistry`, and `FileSystem`; callers should
 * provide `DefaultGlobalAppDoctorLayer` which composes those services from
 * the ambient `ConfigService`.
 */
import { DateTime, Effect, Layer } from "effect";

import type { ConfigService } from "@lando/sdk/services";
import { FileSystem, GlobalAppService, PluginRegistry } from "@lando/sdk/services";

import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as LandoLogger from "@lando/engine/logging/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor";
import { failCheck, passCheckNamed, warnCheck } from "./doctor-check-builders";
import { renderDoctorChecksAsNdjson, sectionCheckEventPayload } from "./doctor-ndjson";
import { renderSectionCheck } from "./doctor-section-render";

export interface GlobalAppDoctorCheck {
  readonly name: "global-app";
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export interface GlobalAppDoctorResult {
  readonly checks: ReadonlyArray<GlobalAppDoctorCheck>;
}

const NOT_INSTALLED_SOLUTION: DoctorSolution = {
  kind: "manual",
  description:
    "The global app is not installed yet. Starting an app that needs Traefik, Mailpit, or ssh-agent will provision it automatically. To materialize the stack now, run `lando global:install`.",
  command: "lando global:install",
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
      // A new top-level key — the services block is finished.
      break;
    }
  }
  return serviceIds;
};

/**
 * Build the global-app diagnostic check.
 *
 * - When the dist file is absent (global app not installed), returns a `warn`
 *   check noting that `lando start` will auto-provision it, with an optional
 *   `lando global:install` solution to materialize the stack now.
 * - When the dist file exists, returns a `pass` check carrying:
 *   - `distLandofilePath` / `userLandofilePath` — materialized file paths
 *   - `lastInstallTimestamp` — mtime of the dist file (ISO 8601)
 *   - `services` — comma-separated list of materialized service ids
 *   - `contributingPlugins` — comma-separated plugin names with `globalServices:`
 */
export const globalAppDoctor = Effect.fnUntraced(function* (): Effect.fn.Return<
  GlobalAppDoctorResult,
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
    .sort()
    .join(", ");

  if (paths === undefined) {
    const check: GlobalAppDoctorCheck = warnCheck({
      name: "global-app",
      context: { installed: "false" },
      solutions: [NOT_INSTALLED_SOLUTION],
    });
    return { checks: [check] };
  }

  const exists = yield* fileSystem
    .exists(paths.distLandofile)
    .pipe(Effect.catch(() => Effect.succeed(false)));

  if (!exists) {
    const context: Record<string, string> = {
      installed: "false",
      distLandofilePath: String(paths.distLandofile),
      userLandofilePath: String(paths.userLandofile),
    };
    if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

    const check: GlobalAppDoctorCheck = warnCheck({
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

  if (content._tag === "Failure") {
    const context: Record<string, string> = {
      installed: "true",
      distLandofilePath: String(paths.distLandofile),
      userLandofilePath: String(paths.userLandofile),
      readError: content.failure.message,
    };
    if (lastInstallTimestamp !== undefined) context.lastInstallTimestamp = lastInstallTimestamp;
    if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

    const check: GlobalAppDoctorCheck = failCheck({
      name: "global-app",
      context,
      solutions: [
        {
          kind: "manual",
          description:
            "The global app dist Landofile exists but could not be read. Check file permissions and rerun `lando global:install` if needed.",
        },
      ],
    });
    return { checks: [check] };
  }

  const serviceIds = parseServiceIds(content.success);

  const context: Record<string, string> = {
    installed: "true",
    distLandofilePath: String(paths.distLandofile),
    userLandofilePath: String(paths.userLandofile),
  };
  if (lastInstallTimestamp !== undefined) context.lastInstallTimestamp = lastInstallTimestamp;
  context.services = serviceIds.length === 0 ? "(none)" : serviceIds.join(", ");
  if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

  const check: GlobalAppDoctorCheck = passCheckNamed({
    name: "global-app",
    context,
  });

  return { checks: [check] };
});

/**
 * Default layer for `globalAppDoctor`.
 *
 * Provides `GlobalAppService | PluginRegistry | FileSystem` from the ambient
 * `ConfigService`.  Use as:
 *
 * ```ts
 * yield* globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer))
 * ```
 */
export const DefaultGlobalAppDoctorLayer: Layer.Layer<
  GlobalAppService | PluginRegistry | FileSystem,
  never,
  ConfigService
> = Layer.mergeAll(
  GlobalAppServiceLayer.layer.pipe(Layer.provide(BunFileSystem.layer)),
  PluginRegistryLayer.layer.pipe(Layer.provideMerge(LandoLogger.layer({ mode: "silent" }))),
  BunFileSystem.layer,
);

export const renderGlobalAppDoctorResult = (result: GlobalAppDoctorResult): string =>
  result.checks.flatMap((check) => renderSectionCheck(check)).join("\n");

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "installed",
  "distLandofilePath",
  "userLandofilePath",
  "lastInstallTimestamp",
  "services",
  "contributingPlugins",
];

export interface GlobalAppDoctorNdjsonOptions {
  readonly now?: Date;
}

export const renderGlobalAppDoctorResultAsNdjson = (
  result: GlobalAppDoctorResult,
  options: GlobalAppDoctorNdjsonOptions = {},
): string =>
  renderDoctorChecksAsNdjson({
    checks: result.checks,
    now: options.now,
    checkEventPayload: (check) => sectionCheckEventPayload(check, CONTEXT_KEY_ORDER),
  });
