import { join } from "node:path";
import { requiresProvider } from "@lando/landofile/tooling-normalize";
import { Clock, Effect, Option, Result } from "effect";

import type { ToolingError, ToolingResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingCompileError,
  type ToolingDisabledError,
  type ToolingInputError,
} from "@lando/sdk/errors";
import type { Environment, HostTerminal, LoadScopedLandofile } from "@lando/sdk/schema";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import {
  AppPlanner,
  ConfigService,
  type EnvironmentValueResolver,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  type ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../config/agent-env-policy.ts";
import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import {
  type ResolvedAppTarget,
  loadUserLandofile,
  loadUserLandofileAt,
} from "../landofile/app-resolution.ts";
import { resolveConnectionClientTask } from "../planner/connection-client-task.ts";
import { invocationToolingForPlan, sitesUnder } from "../planner/invocation-authority.ts";
import { materializeLandofileScopesForPlan } from "../planner/landofile-scopes.ts";
import {
  collectAppPlanPublicCredentialValues,
  collectAppPlanRedactionTokens,
} from "../services/app-plan-redaction.ts";
import { resolveToolingTaskShape } from "../tooling/step-runner.ts";
import { reservedToolingNameConflict } from "./reserved-aliases.ts";

import { LANDOFILE_NAME, findAppRoot } from "@lando/landofile/discovery";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { runBracketedInvocations } from "./tooling-bracket.ts";
import { runBunShellTooling } from "./tooling-bun-script.ts";
import { compileToolingInvocations } from "./tooling-compile.ts";
import { withToolingOutput } from "./tooling-output.ts";
import { beginLiveToolingTree } from "./tooling-progress.ts";

export interface RunToolingOptions {
  readonly name: string;
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Environment;
  readonly cacheRoot?: string;
  readonly tty?: boolean;
  readonly hostTerminal?: HostTerminal;
  readonly stdinStream?: ToolingInvocation["stdinStream"];
  readonly terminalResize?: ToolingInvocation["terminalResize"];
  readonly signal?: AbortSignal;
}

export type RunToolingResult = ToolingResult & {
  readonly redactionTokens?: ReadonlyArray<string>;
};
export type { ToolingResult };

export const runToolingRedactionTokens = (result: RunToolingResult): ReadonlyArray<string> =>
  result.redactionTokens ?? [];

type RunToolingError =
  | ToolingError
  | ComposeKeyRejectedError
  | LandofileLoadExpressionError
  | ToolingDisabledError
  | ToolingInputError;

type RunToolingServices =
  | EnvironmentValueResolver
  | AppPlanner
  | ConfigService
  | LandofileService
  | PrivateFileAccessService
  | RuntimeProviderRegistry
  | ToolingEngine;

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

const resolveToolingPlan = Effect.fnUntraced(function* (input: {
  readonly landofile: LoadScopedLandofile;
  readonly appRoot: string | undefined;
}) {
  const planner = yield* AppPlanner;
  const registry = yield* RuntimeProviderRegistry;
  const capabilities = yield* registry.capabilities;
  return yield* input.appRoot === undefined
    ? planner.plan(input.landofile, capabilities)
    : withProcessCwd(input.appRoot, () => planner.plan(input.landofile, capabilities));
});

export const runTooling = Effect.fn("AppOperation.tooling")(function* (
  options: RunToolingOptions,
  target?: ResolvedAppTarget,
): Effect.fn.Return<RunToolingResult, RunToolingError, RunToolingServices> {
  const landofileService = yield* LandofileService;

  const loadedLandofile =
    target === undefined
      ? yield* loadUserLandofile(landofileService)
      : (target.landofile ?? (yield* loadUserLandofileAt(landofileService, target.root)));
  const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? target?.root ?? process.cwd()));
  const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
  const authoredTaskNames = new Set(Object.keys(loadedLandofile.document.tooling ?? {}));
  const servicesCanContributeTooling = Object.keys(loadedLandofile.document.services ?? {}).length > 0;

  if (
    target === undefined &&
    !servicesCanContributeTooling &&
    !authoredTaskNames.has(toolingLookupKey) &&
    appRoot !== undefined
  ) {
    const scriptResult = yield* runBunShellTooling(options, appRoot);
    if (scriptResult !== undefined) return scriptResult;
  }

  const planResult =
    target === undefined
      ? yield* Effect.result(resolveToolingPlan({ landofile: loadedLandofile, appRoot }))
      : Result.succeed(target.plan);
  if (Result.isFailure(planResult)) {
    if (appRoot !== undefined) {
      const scriptResult = yield* runBunShellTooling(options, appRoot);
      if (scriptResult !== undefined) return scriptResult;
    }
    return yield* Effect.fail(planResult.failure);
  }
  const plan = planResult.success;
  // Captured or freshly loaded declarations stay authoritative over the plan, so they
  // need the same deferred-scope resolution the planner applied, or an authored
  // `{{ app.name }}` would reach the container as literal text. This runs only
  // once a plan exists so the script fallback above keeps its old inputs.
  const config = yield* ConfigService;
  const globalConfig = yield* config.load;
  const landofileRoot = loadedLandofile.context.appRoot;
  const serviceScoped = yield* materializeLandofileScopesForPlan(
    {
      landofile: loadedLandofile,
      appRoot: landofileRoot,
      landofilePath: join(landofileRoot, LANDOFILE_NAME),
      globalConfig,
    },
    plan,
  );
  const landofile = serviceScoped.document;
  const { tooling, sites } = yield* invocationToolingForPlan(
    serviceScoped,
    plan,
    readProxyDefaultDomain(globalConfig),
  );
  const task = tooling[toolingLookupKey];
  const reservedConflict = reservedToolingNameConflict(toolingLookupKey);

  if (task !== undefined && reservedConflict !== undefined) {
    return yield* Effect.fail(reservedConflict);
  }

  if (task === undefined) {
    if (appRoot !== undefined) {
      const scriptResult = yield* runBunShellTooling(options, appRoot);
      if (scriptResult !== undefined) return scriptResult;
    }
    return yield* Effect.fail(
      new ToolingCompileError({
        message: `Unknown tooling command: ${options.name}.`,
        tool: options.name,
        remediation:
          "Verify the tooling task name, then run `lando app:cache:refresh` after changing tooling configuration.",
      }),
    );
  }

  const source = {
    path: join(appRoot ?? target?.root ?? String(plan.root), LANDOFILE_NAME),
    task: toolingLookupKey,
  };
  const agentEnvAllowlist = yield* resolveAgentEnvForwardAllowlist(landofile.agentEnv, process.env);
  const client = yield* resolveConnectionClientTask({
    plan,
    name: toolingLookupKey,
    task,
    sites: sitesUnder(sites, ["tooling", toolingLookupKey]),
    currentLandofile: landofile,
  });
  const resolvedTask = yield* resolveToolingTaskShape(client.task, {}, client.sites);
  const compiled = yield* compileToolingInvocations({
    ...options,
    lookupKey: toolingLookupKey,
    task: resolvedTask,
    source,
    agentEnvAllowlist,
  });
  const invocations = compiled.invocations;
  const publicValues = collectAppPlanPublicCredentialValues(plan);
  const redactionTokens = [
    ...new Set([
      ...collectAppPlanRedactionTokens(plan),
      ...invocations.flatMap((invocation) =>
        collectSecretEnvValues(
          Object.fromEntries(
            Object.entries(invocation.env ?? {}).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          publicValues,
        ),
      ),
    ]),
  ];
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) yield* redaction.value.registerValues(redactionTokens);

  const events = yield* Effect.serviceOption(EventService);
  const progressEvents = Option.getOrUndefined(events);
  const liveTree =
    progressEvents === undefined ? undefined : beginLiveToolingTree(progressEvents, options.name);
  if (liveTree !== undefined) yield* liveTree.start;

  const startedAt = yield* Clock.currentTimeMillis;
  const exit = yield* Effect.result(
    withToolingOutput(
      runBracketedInvocations({
        plan,
        tool: options.name,
        lookupKey: toolingLookupKey,
        invocations,
        requiresProvider: requiresProvider(compiled.normalized),
        redactionTokens,
      }),
    ),
  );
  const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
  if (liveTree !== undefined) {
    const exitCode = exit._tag === "Success" ? exit.success.exitCode : 1;
    yield* liveTree.finish(exitCode, durationMs);
  }
  if (exit._tag === "Failure") return yield* Effect.fail(exit.failure);
  const result = exit.success;

  return {
    tool: result.tool,
    service: String(result.service),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    redactionTokens,
  };
});
