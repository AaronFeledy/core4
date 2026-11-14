import { compileInspectedAppCommands, scriptLoadError } from "@lando/engine/cache/command-compiler";
import {
  readDataIdentityFingerprint,
  writeAppCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
import { fingerprintsFromInspection } from "@lando/engine/cache/command-script-freshness";
import {
  commandWarningsUseMachineOutput,
  recordCommandWarning,
} from "@lando/engine/landofile/command-warnings";
import { makeSubscriberRegistrationClosure } from "@lando/engine/lifecycle/subscriber-index";
import { publishHostShellWarnings } from "@lando/engine/operations/host-shell-warnings";
import { plannedServiceArtifact } from "@lando/engine/operations/planned-service-artifact";
import { effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
import { type BunShellScriptDiscoveryError, inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import type { AppPlanResolutionError } from "@lando/sdk/app";
import type {
  CacheError,
  CommandAliasConflictError,
  CommandAliasTargetError,
  EventError,
  LandoCommandError,
  PluginManifestError,
  SubscriberLevelMismatchError,
  ToolingCompileError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { createRedactor } from "@lando/sdk/secrets";
import {
  AppPlanner,
  EventService,
  LandofileService,
  PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
/** Rebuilds the app plan and command index caches without contacting the provider. */
import { DateTime, Effect, Option, Schema } from "effect";
import { loadUserLandofile } from "../app-resolution";
import { commandAliasRegistrationError } from "../command-alias-policy";
import { BUILT_IN_COMMAND_IDS } from "../generated/command-ids";

export interface AppCacheRefreshOptions {
  readonly cwd?: string;
  readonly cacheRoot?: string;
}

const PlannedServiceArtifactSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ref"),
    ref: Schema.String.annotate({ description: "Registry image reference the plan will use." }),
    digest: Schema.optionalKey(Schema.String).annotate({
      description: "Pinned digest, when the plan recorded one.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("build"),
    contentHash: Schema.optionalKey(Schema.String).annotate({
      description: "Build content hash, when the plan recorded one.",
    }),
  }),
]);

const PlannedServiceSchema = Schema.Struct({
  service: Schema.String.annotate({ description: "Service name." }),
  type: Schema.String.annotate({ description: "Resolved service type." }),
  artifact: Schema.optionalKey(PlannedServiceArtifactSchema).annotate({
    description:
      "Planned artifact identity. The same shape as lando info, without build context, arguments, or inline source.",
  }),
});

export const AppCacheRefreshResultSchema = Schema.Struct({
  app: Schema.String,
  commandsCompiled: Schema.Number,
  appCommandCachePath: Schema.optionalKey(Schema.String),
  services: Schema.Array(PlannedServiceSchema).annotate({
    description: "Planned services and their artifact identity. Refresh does not pull or start them.",
  }),
});
export type AppCacheRefreshResult = typeof AppCacheRefreshResultSchema.Type;

type AppCacheRefreshError =
  | AppPlanResolutionError
  | ProviderError
  | ToolingCompileError
  | PluginManifestError
  | SubscriberLevelMismatchError
  | BunShellScriptDiscoveryError
  | CommandAliasConflictError
  | CommandAliasTargetError
  | CacheError
  | EventError
  | LandoCommandError;

type AppCacheRefreshServices = AppPlanner | LandofileService | PluginRegistry | RuntimeProviderRegistry;

export const renderAppCacheRefreshResult = (result: AppCacheRefreshResult): string =>
  `refreshed: ${result.app} (${result.commandsCompiled} command${result.commandsCompiled === 1 ? "" : "s"})`;

export const refreshAppCache = Effect.fn("AppCacheRefresh.refresh")(function* (
  options: AppCacheRefreshOptions = {},
): Effect.fn.Return<AppCacheRefreshResult, AppCacheRefreshError, AppCacheRefreshServices> {
  const landofileService = yield* LandofileService;
  const pluginRegistry = yield* PluginRegistry;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;

  const landofile = yield* loadUserLandofile(landofileService);
  const capabilities = yield* registry.capabilities;
  const dataIdentityFingerprint = yield* readDataIdentityFingerprint(landofile.context.appRoot);
  const plan = yield* planner.plan(landofile, capabilities);
  yield* publishHostShellWarnings(plan);

  const cwd = options.cwd ?? (yield* discoveryCwd());
  const inspection = yield* inspectBunShellScripts({ appRoot: plan.root });
  const io = inspection.problems.find((problem) => problem.io);
  if (io !== undefined) return yield* Effect.fail(io.error);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(redaction)
    ? yield* redaction.value.forProfile("secrets")
    : createRedactor("secrets", { values: collectSecretEnvValues(process.env) });
  const entries = yield* Effect.sync(() =>
    compileInspectedAppCommands({
      landofile: landofile.document,
      inspection,
      effectiveTooling: effectiveToolingForPlan(plan),
      redact: redactor.redactString,
    }),
  );
  const machineOutput = yield* commandWarningsUseMachineOutput;
  const events = Option.getOrUndefined(yield* Effect.serviceOption(EventService));
  const warned = new Set<string>();
  const toolingWarnings = entries.flatMap((entry) =>
    entry.source === undefined && entry.loadError !== undefined
      ? [
          {
            code: "LANDO_TOOLING_INVALID",
            message: entry.loadError.message,
            ...(entry.loadError.remediation === undefined
              ? {}
              : { remediation: entry.loadError.remediation }),
            context: { path: plan.metadata.source, task: entry.id.slice("app:".length) },
          },
        ]
      : [],
  );
  for (const warning of toolingWarnings) {
    yield* recordCommandWarning(warning);
    if (!machineOutput && events !== undefined)
      yield* events.publish(
        MessageWarnEvent.make({
          body: `${warning.message} ${warning.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      );
  }
  for (const problem of inspection.problems) {
    if (warned.has(problem.id ?? problem.file)) continue;
    warned.add(problem.id ?? problem.file);
    const diagnostic = scriptLoadError(problem, redactor.redactString);
    const warning = {
      code: "LANDO_SCRIPT_INVALID",
      message: diagnostic.message,
      ...(diagnostic.remediation === undefined ? {} : { remediation: diagnostic.remediation }),
      context: { path: problem.file },
    };
    yield* recordCommandWarning(warning);
    if (!machineOutput && events !== undefined)
      yield* events.publish(
        MessageWarnEvent.make({
          body: `${warning.message} ${warning.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      );
  }
  const manifests = yield* pluginRegistry.list;
  const aliasError = commandAliasRegistrationError(
    landofile.document.commandAliases,
    entries.map((entry) => entry.id),
    entries,
    manifests.flatMap((manifest) => (manifest.contributes?.commands ?? []).map((command) => command.id)),
  );
  if (aliasError !== undefined) yield* Effect.fail(aliasError);

  yield* makeSubscriberRegistrationClosure(manifests).close({
    builtIns: BUILT_IN_COMMAND_IDS,
    appCommandIds: entries.map((entry) => entry.id),
  });

  const appCachePath = yield* writeAppCommandCacheStrict({
    sourceScripts: fingerprintsFromInspection(inspection),
    dataIdentityFingerprint,
    landofile: landofile.document,
    entries,
    cwd,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  });

  const services = Object.values(plan.services)
    .map((service) => {
      const artifact = plannedServiceArtifact(service.artifact);
      return {
        service: String(service.name),
        type: service.type,
        ...(artifact === undefined ? {} : { artifact }),
      };
    })
    .sort((left, right) => (left.service < right.service ? -1 : left.service > right.service ? 1 : 0));

  return {
    app: plan.name,
    commandsCompiled: entries.length,
    services,
    ...(appCachePath === undefined ? {} : { appCommandCachePath: appCachePath }),
  };
});
