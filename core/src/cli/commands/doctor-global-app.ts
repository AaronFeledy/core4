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
import { Effect, Layer } from "effect";

import type { ConfigService } from "@lando/sdk/services";
import { FileSystem, GlobalAppService, PluginRegistry } from "@lando/sdk/services";

import { GlobalAppServiceLive } from "../../global-app/service.ts";
import { LoggerLive } from "../../logging/service.ts";
import { PluginRegistryLive } from "../../plugins/registry.ts";
import { FileSystemLive } from "../../services/file-system.ts";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson.ts";
import { renderSolution } from "./doctor.ts";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor.ts";

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
    "The global app is not installed. Run `lando global:install` to provision Traefik routing and Mailpit mail capture.",
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
 *   check with a `lando global:install` solution.
 * - When the dist file exists, returns a `pass` check carrying:
 *   - `distLandofilePath` / `userLandofilePath` — materialized file paths
 *   - `lastInstallTimestamp` — mtime of the dist file (ISO 8601)
 *   - `services` — comma-separated list of materialized service ids
 *   - `contributingPlugins` — comma-separated plugin names with `globalServices:`
 */
export const globalAppDoctor = (): Effect.Effect<
  GlobalAppDoctorResult,
  never,
  GlobalAppService | PluginRegistry | FileSystem
> =>
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const pluginRegistry = yield* PluginRegistry;
    const fileSystem = yield* FileSystem;

    const paths = yield* globalApp.paths.pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const manifests = yield* pluginRegistry.list.pipe(Effect.catchAll(() => Effect.succeed([])));

    const contributingPlugins = manifests
      .filter((manifest) => (manifest.contributes?.globalServices ?? []).length > 0)
      .map((manifest) => manifest.name)
      .sort()
      .join(", ");

    if (paths === undefined) {
      const check: GlobalAppDoctorCheck = {
        name: "global-app",
        status: "warn",
        severity: "warn",
        context: { installed: "false" },
        solutions: [NOT_INSTALLED_SOLUTION],
      };
      return { checks: [check] };
    }

    const exists = yield* fileSystem
      .exists(paths.distLandofile)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));

    if (!exists) {
      const context: Record<string, string> = {
        installed: "false",
        distLandofilePath: String(paths.distLandofile),
        userLandofilePath: String(paths.userLandofile),
      };
      if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

      const check: GlobalAppDoctorCheck = {
        name: "global-app",
        status: "warn",
        severity: "warn",
        context,
        solutions: [NOT_INSTALLED_SOLUTION],
      };
      return { checks: [check] };
    }

    const stat = yield* fileSystem
      .lstat(paths.distLandofile)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const content = yield* Effect.either(fileSystem.readText(paths.distLandofile));
    const lastInstallTimestamp = stat !== undefined ? new Date(stat.mtimeMs).toISOString() : undefined;

    if (content._tag === "Left") {
      const context: Record<string, string> = {
        installed: "true",
        distLandofilePath: String(paths.distLandofile),
        userLandofilePath: String(paths.userLandofile),
        readError: content.left.message,
      };
      if (lastInstallTimestamp !== undefined) context.lastInstallTimestamp = lastInstallTimestamp;
      if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

      const check: GlobalAppDoctorCheck = {
        name: "global-app",
        status: "fail",
        severity: "error",
        context,
        solutions: [
          {
            kind: "manual",
            description:
              "The global app dist Landofile exists but could not be read. Check file permissions and rerun `lando global:install` if needed.",
          },
        ],
      };
      return { checks: [check] };
    }

    const serviceIds = parseServiceIds(content.right);

    const context: Record<string, string> = {
      installed: "true",
      distLandofilePath: String(paths.distLandofile),
      userLandofilePath: String(paths.userLandofile),
    };
    if (lastInstallTimestamp !== undefined) context.lastInstallTimestamp = lastInstallTimestamp;
    context.services = serviceIds.length === 0 ? "(none)" : serviceIds.join(", ");
    if (contributingPlugins.length > 0) context.contributingPlugins = contributingPlugins;

    const check: GlobalAppDoctorCheck = {
      name: "global-app",
      status: "pass",
      severity: "info",
      context,
      solutions: [],
    };

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
  GlobalAppServiceLive.pipe(Layer.provide(FileSystemLive)),
  PluginRegistryLive.pipe(Layer.provideMerge(LoggerLive({ mode: "silent" }))),
  FileSystemLive,
);

// ── renderers ────────────────────────────────────────────────────────────────

const renderCheck = (check: GlobalAppDoctorCheck): ReadonlyArray<string> => {
  const lines: string[] = [`${check.name}: ${check.status}`, `severity: ${check.severity}`];
  for (const [field, value] of Object.entries(check.context)) {
    lines.push(`${field}: ${value}`);
  }
  for (const solution of check.solutions) {
    lines.push(renderSolution(solution));
  }
  return lines;
};

export const renderGlobalAppDoctorResult = (result: GlobalAppDoctorResult): string =>
  result.checks.flatMap((check) => renderCheck(check)).join("\n");

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "installed",
  "distLandofilePath",
  "userLandofilePath",
  "lastInstallTimestamp",
  "services",
  "contributingPlugins",
];

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> =>
  orderKnownKeys(context, CONTEXT_KEY_ORDER);

const checkEventPayload = (check: GlobalAppDoctorCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  context: orderContextKeys(check.context),
  solutions: check.solutions.map((solution) => ({
    kind: solution.kind,
    description: solution.description,
    ...(solution.command === undefined ? {} : { command: solution.command }),
  })),
});

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
    checkEventPayload,
  });
