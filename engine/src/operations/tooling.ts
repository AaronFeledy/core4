import { join } from "node:path";
import { requiresProvider } from "@lando/landofile/tooling-normalize";
import { Effect } from "effect";

import type { ToolingError, ToolingResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingCompileError,
  type ToolingDisabledError,
  type ToolingInputError,
} from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";

import { RedactionService, collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";
import {
  AppPlanner,
  type ConfigService,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  type ToolingEngine,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../config/agent-env-policy.ts";
import {
  type ResolvedAppTarget,
  loadUserLandofile,
  loadUserLandofileAt,
} from "../landofile/app-resolution.ts";
import { compileEffectiveTooling, effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "./reserved-aliases.ts";

import { LANDOFILE_NAME, findAppRoot } from "@lando/landofile/discovery";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { StreamFrameSink } from "./stream-frame-sink.ts";
import { runBracketedInvocations } from "./tooling-bracket.ts";
import { compileToolingInvocations } from "./tooling-compile.ts";
export { validateToolingArguments } from "./tooling-compile.ts";
import { runBunShellTooling } from "./tooling-bun-script.ts";
import { beginLiveToolingTree, emitToolingOutputProgress } from "./tooling-progress.ts";

export interface RunToolingOptions {
  readonly name: string;
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cacheRoot?: string;
  readonly renderProgress?: boolean;
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

const resolveToolingPlan = (input: {
  readonly landofile: LandofileShape;
  readonly appRoot: string | undefined;
}) =>
  Effect.gen(function* () {
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;
    const capabilities = yield* registry.capabilities;
    return yield* input.appRoot === undefined
      ? planner.plan(input.landofile, capabilities)
      : withProcessCwd(input.appRoot, () => planner.plan(input.landofile, capabilities));
  });

export const runTooling = (
  options: RunToolingOptions,
  target?: ResolvedAppTarget,
): Effect.Effect<RunToolingResult, RunToolingError, RunToolingServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;

    const landofile =
      target === undefined
        ? yield* loadUserLandofile(landofileService)
        : yield* loadUserLandofileAt(landofileService, target.root);
    const appRoot = yield* Effect.promise(() => findAppRoot(options.cwd ?? target?.root ?? process.cwd()));
    const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
    const authoredTooling = compileEffectiveTooling({ landofile, services: [] });
    const servicesCanContributeTooling = Object.keys(landofile.services ?? {}).length > 0;

    if (
      target === undefined &&
      !servicesCanContributeTooling &&
      authoredTooling[toolingLookupKey] === undefined &&
      appRoot !== undefined
    ) {
      const scriptResult = yield* runBunShellTooling(options, appRoot);
      if (scriptResult !== undefined) return scriptResult;
    }

    const planResult =
      target === undefined
        ? yield* Effect.either(resolveToolingPlan({ landofile, appRoot }))
        : ({ _tag: "Right", right: target.plan } as const);
    if (planResult._tag === "Left") {
      if (appRoot !== undefined) {
        const scriptResult = yield* runBunShellTooling(options, appRoot);
        if (scriptResult !== undefined) return scriptResult;
      }
      return yield* Effect.fail(planResult.left);
    }
    const plan = planResult.right;
    const tooling = { ...effectiveToolingForPlan(plan), ...authoredTooling };
    const task = tooling[toolingLookupKey];
    const reservedOwner = reservedTopLevelAliasOwner(toolingLookupKey);

    if (task !== undefined && reservedOwner !== undefined) {
      return yield* Effect.fail(
        commandAliasConflictError(toolingLookupKey, `tooling task ${toolingLookupKey}`),
      );
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
    const compiled = yield* compileToolingInvocations({
      name: options.name,
      lookupKey: toolingLookupKey,
      task,
      source,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      agentEnvAllowlist,
    });
    const invocations = compiled.invocations;
    const events = options.renderProgress === true ? yield* Effect.serviceOption(EventService) : undefined;
    const redactionTokens = [
      ...new Set([
        ...collectAppPlanRedactionTokens(plan),
        ...invocations.flatMap((invocation) => collectSecretEnvValues(invocation.env)),
      ]),
    ];

    const sink = yield* Effect.serviceOption(StreamFrameSink);
    const progressEvents = events?._tag === "Some" ? events.value : undefined;
    const streamedLive = sink._tag === "Some";
    const liveTree =
      streamedLive && progressEvents !== undefined
        ? beginLiveToolingTree(progressEvents, options.name)
        : undefined;
    if (liveTree !== undefined) yield* liveTree.start;

    const startedAt = Date.now();
    const exit = yield* Effect.either(
      runBracketedInvocations({
        plan,
        tool: options.name,
        lookupKey: toolingLookupKey,
        invocations,
        requiresProvider: requiresProvider(compiled.normalized),
        redactionTokens,
      }),
    );
    const durationMs = Date.now() - startedAt;
    if (liveTree !== undefined) {
      const exitCode = exit._tag === "Right" ? exit.right.exitCode : 1;
      yield* liveTree.finish(exitCode, durationMs);
    }
    if (exit._tag === "Left") return yield* Effect.fail(exit.left);
    const result = exit.right;

    if (progressEvents !== undefined && !streamedLive) {
      const redaction = yield* Effect.serviceOption(RedactionService);
      const redactor =
        redaction._tag === "Some"
          ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env, redactionTokens })
          : createStandaloneRedactor("secrets", { sourceEnv: process.env, redactionTokens });
      yield* emitToolingOutputProgress({
        events: progressEvents,
        tool: result.tool,
        service: String(result.service),
        exitCode: result.exitCode,
        stdout: redactor.redactString(result.stdout),
        stderr: redactor.redactString(result.stderr),
        durationMs,
      });
    }

    return {
      tool: result.tool,
      service: String(result.service),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      redactionTokens,
      ...(progressEvents === undefined && !streamedLive ? {} : { rendered: true }),
    };
  });
