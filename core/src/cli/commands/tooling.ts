import { Effect } from "effect";

import type {
  AppIdReservedError,
  CapabilityError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
  ShellExecError,
  ShellScriptOutsideRootError,
} from "@lando/sdk/errors";
import {
  type BunShellScriptEmptyError,
  type BunShellScriptFrontMatterError,
  NotImplementedError,
  ToolingCompileError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan, LandofileShape, PluginManifest, ToolingTaskShape } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";
import {
  AppPlanner,
  CacheService,
  ConfigService,
  LandofileService,
  PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";

import {
  type AppPlanSourceFingerprint,
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../../cache/app-plan.ts";
import { resolveUserCacheRoot } from "../../cache/paths.ts";
import { type DiscoveredBunShellScript, discoverBunShellScripts } from "../../landofile/bun-sh-discovery.ts";
import { findAppRoot } from "../../landofile/discovery.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../providers/precedence.ts";
import { runHostScript } from "../../services/host-tooling-engine.ts";

export interface RunToolingOptions {
  readonly name: string;
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cacheRoot?: string;
}

export interface RunToolingResult {
  readonly tool: string;
  readonly service: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunToolingError =
  | AppIdReservedError
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ShellExecError
  | ShellScriptOutsideRootError
  | ToolingCompileError
  | ToolingExecError;

type RunToolingServices =
  | AppPlanner
  | ConfigService
  | LandofileService
  | RuntimeProviderRegistry
  | ToolingEngine;

const HOST_SERVICE = ":host";

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const joinShell = (parts: ReadonlyArray<string>): string => parts.filter(isNonEmptyString).join(" ");

const normalizeCommands = (
  task: ToolingTaskShape,
  args: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const cmds = task.cmds;
  if (cmds !== undefined && cmds.length > 0) {
    return cmds.map((cmd, index) => {
      const lastIndex = cmds.length - 1;
      const tail = index === lastIndex && args.length > 0 ? ` ${joinShell(args)}` : "";
      return ["sh", "-c", `${cmd}${tail}`];
    });
  }
  if (task.cmd !== undefined) {
    if (typeof task.cmd === "string") {
      const tail = args.length > 0 ? ` ${joinShell(args)}` : "";
      return [["sh", "-c", `${task.cmd}${tail}`]];
    }
    return [[...task.cmd, ...args]];
  }
  return [];
};

export const buildToolingInvocation = (
  name: string,
  task: ToolingTaskShape,
  options: Pick<RunToolingOptions, "args" | "user" | "cwd" | "env"> = {},
): ToolingInvocation => {
  const commands = normalizeCommands(task, options.args ?? []);
  return {
    tool: name,
    ...(task.service === undefined ? {} : { service: task.service }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    commands,
  };
};

export const renderRunToolingResult = (result: RunToolingResult): string | undefined =>
  result.stdout.length === 0 ? undefined : result.stdout;

const canonicalLookupKey = (name: string): string => (name.startsWith("app:") ? name : `app:${name}`);

const findBunShellScriptForName = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  name: string,
): DiscoveredBunShellScript | undefined => {
  const target = canonicalLookupKey(name);
  return scripts.find((script) => script.id === target);
};

const toolingAppName = (landofile: LandofileShape): string => landofile.name ?? "app";

const toolingPlanCacheKey = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly providerId: string;
  readonly pluginManifests: ReadonlyArray<PluginManifest>;
  readonly sourceFingerprint?: AppPlanSourceFingerprint;
}): string =>
  deriveAppPlanCacheKey({
    appRoot: input.appRoot,
    landofile: { ...input.landofile, provider: ProviderId.make(input.providerId) },
    pluginManifests: input.pluginManifests,
    ...(input.sourceFingerprint === undefined ? {} : { sourceFingerprint: input.sourceFingerprint }),
  });

const listPluginManifestsForCache = (): Effect.Effect<ReadonlyArray<PluginManifest> | null> =>
  Effect.gen(function* () {
    const pluginRegistry = yield* Effect.serviceOption(PluginRegistry);
    if (pluginRegistry._tag === "None") return null;
    return yield* pluginRegistry.value.list.pipe(Effect.catchAll(() => Effect.succeed(null)));
  });

const readToolingCachedPlan = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string | undefined;
  readonly providerId: string;
  readonly cacheRoot: string;
}): Effect.Effect<AppPlan | null, never> =>
  Effect.gen(function* () {
    if (input.appRoot === undefined) return null;
    const pluginManifests = yield* listPluginManifestsForCache();
    if (pluginManifests === null) return null;
    const sourceFingerprint = yield* readAppPlanSourceFingerprint(input.appRoot).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    const key = toolingPlanCacheKey({
      landofile: input.landofile,
      appRoot: input.appRoot,
      providerId: input.providerId,
      pluginManifests,
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    });
    return yield* readCachedAppPlan({
      cacheRoot: input.cacheRoot,
      appName: toolingAppName(input.landofile),
      appRoot: input.appRoot,
      key,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
  });

const writeToolingCachedPlan = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string | undefined;
  readonly providerId: string;
  readonly cacheRoot: string;
  readonly plan: AppPlan;
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (input.appRoot === undefined) return;
    const cacheService = yield* Effect.serviceOption(CacheService);
    if (cacheService._tag === "None") return;
    const pluginManifests = yield* listPluginManifestsForCache();
    if (pluginManifests === null) return;
    const sourceFingerprint = yield* readAppPlanSourceFingerprint(input.appRoot).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    const key = toolingPlanCacheKey({
      landofile: input.landofile,
      appRoot: input.appRoot,
      providerId: input.providerId,
      pluginManifests,
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    });
    yield* writeCachedAppPlan({
      cacheRoot: input.cacheRoot,
      appName: toolingAppName(input.landofile),
      appRoot: input.appRoot,
      key,
      plan: input.plan,
    }).pipe(
      Effect.provideService(CacheService, cacheService.value),
      Effect.catchAll(() => Effect.void),
    );
  });

const withProcessCwd = <A, E, R>(
  cwd: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ToolingCompileError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(cwd);
        return original;
      },
      catch: (cause) =>
        new ToolingCompileError({
          message: `Unable to enter the app directory at ${cwd}.`,
          tool: "tooling",
          cause,
        }),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

const resolveToolingProviderId = (landofile: LandofileShape): Effect.Effect<string> =>
  Effect.gen(function* () {
    const configService = yield* Effect.serviceOption(ConfigService);
    const configProvider =
      configService._tag === "None"
        ? undefined
        : yield* configService.value
            .get("defaultProviderId")
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const envProvider = readProviderEnvVar(process.env);
    return String(
      resolveProviderSelection({
        ...(landofile.provider === undefined ? {} : { landofile: landofile.provider }),
        ...(envProvider === undefined ? {} : { env: envProvider }),
        ...(configProvider === undefined || configProvider === null ? {} : { config: configProvider }),
        capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
      }).providerId,
    );
  });

const resolveToolingPlan = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string | undefined;
  readonly providerId: string;
  readonly cacheRoot: string;
}) =>
  Effect.gen(function* () {
    const cachedPlan = yield* readToolingCachedPlan(input);
    if (cachedPlan !== null) return cachedPlan;

    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;
    const capabilities = yield* registry.capabilities;
    const plan = yield* input.appRoot === undefined
      ? planner.plan(input.landofile, capabilities)
      : withProcessCwd(input.appRoot, () => planner.plan(input.landofile, capabilities));
    yield* writeToolingCachedPlan({ ...input, providerId: String(plan.provider), plan });
    return plan;
  });

const runBunShellScript = (
  script: DiscoveredBunShellScript,
  appRoot: string,
  options: RunToolingOptions,
): Effect.Effect<
  RunToolingResult,
  NotImplementedError | ShellExecError | ShellScriptOutsideRootError | ToolingExecError
> =>
  Effect.gen(function* () {
    if (script.service !== HOST_SERVICE) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `.bun.sh script "${script.id}" declares service "${script.service}"; service-targeted .bun.sh scripts are deferred to Beta.`,
          commandId: "tooling.run",
          specSection: "§8.5.9",
          remediation:
            "Remove the `service:` field (or set it to `:host`) so the script runs through the host engine, or move the body into a Landofile tooling task that targets the desired service.",
        }),
      );
    }
    const cwd = options.cwd ?? appRoot;
    const env = options.env;
    const result = yield* runHostScript(script.path, [appRoot], {
      cwd,
      ...(env === undefined ? {} : { env }),
    }).pipe(
      Effect.catchTag("ShellExecError", (shellError) =>
        Effect.fail(
          new ToolingExecError({
            message: `Script-backed tooling task ${script.id} failed: ${shellError.message}`,
            tool: script.id,
            ...(shellError.exitCode === undefined ? {} : { exitCode: shellError.exitCode }),
            cause: shellError,
          }),
        ),
      ),
    );
    return {
      tool: script.id,
      service: HOST_SERVICE,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    } satisfies RunToolingResult;
  });

export const runTooling = (
  options: RunToolingOptions,
): Effect.Effect<RunToolingResult, RunToolingError, RunToolingServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;

    const landofile = yield* loadUserLandofile(landofileService);
    const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
    const task = landofile.tooling?.[toolingLookupKey];

    if (task === undefined) {
      const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
      if (appRoot !== undefined) {
        const scripts = yield* discoverBunShellScripts({ appRoot });
        const script = findBunShellScriptForName(scripts, options.name);
        if (script !== undefined) {
          return yield* runBunShellScript(script, appRoot, options);
        }
      }
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Unknown tooling command: ${options.name}.`,
          tool: options.name,
        }),
      );
    }

    if (task.cmd === undefined && (task.cmds === undefined || task.cmds.length === 0)) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Tooling command ${options.name} does not define cmd or cmds.`,
          tool: options.name,
        }),
      );
    }

    const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? process.cwd()));
    const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
    const providerId = yield* resolveToolingProviderId(landofile);
    const plan = yield* resolveToolingPlan({
      landofile,
      appRoot,
      providerId,
      cacheRoot,
    });
    const registry = yield* RuntimeProviderRegistry;
    const engine = yield* ToolingEngine;
    const provider = yield* registry.select(plan);

    const invocation = buildToolingInvocation(options.name, task, {
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const result = yield* engine.run(invocation, plan, provider);

    return {
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
