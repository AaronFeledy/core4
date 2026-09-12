// allow: SIZE_OK — tooling operation and exported invocation builder share a file under the current ownership boundary.
import { join } from "node:path";
import { parseToolingArgv, resolveServiceRef } from "@lando/landofile/tooling-input";
import {
  type NormalizedToolingStep,
  normalizeToolingTask,
  requiresProvider,
} from "@lando/landofile/tooling-normalize";
import { Effect, Either, Option } from "effect";

import type { ToolingError, ToolingResult } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingCompileError,
  ToolingDisabledError,
  ToolingExecError,
  type ToolingInputError,
} from "@lando/sdk/errors";
import type { LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";

import { RedactionService, collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";
import {
  AppPlanner,
  type ConfigService,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../config/agent-env-policy.ts";
import {
  type ResolvedAppTarget,
  loadUserLandofile,
  loadUserLandofileAt,
} from "../landofile/app-resolution.ts";
import { compileEffectiveTooling, effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { runtimeProviderService } from "../runtime/bootstrap-layer-support.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { runHostToolingWith } from "../services/host-tooling-engine.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "./reserved-aliases.ts";

import { LANDOFILE_NAME, findAppRoot } from "@lando/landofile/discovery";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { StreamFrameSink } from "./stream-frame-sink.ts";
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

const POSITIONAL_PARAMETER = /\$(?:@|[1-9]|\{(?:@|[1-9]))/u;

const shellCommand = (command: string, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  POSITIONAL_PARAMETER.test(command) ? command : `${command} "$@"`,
  "lando-tooling",
  ...args,
];

export const validateToolingArguments = (
  name: string,
  task: ToolingTaskShape | { readonly acceptsArguments: boolean },
  args: ReadonlyArray<string>,
): ToolingCompileError | undefined =>
  ("acceptsArguments" in task ? !task.acceptsArguments : task.arguments === false) && args.length > 0
    ? new ToolingCompileError({
        message: `Tooling command ${name} does not accept positional arguments.`,
        tool: name,
        remediation: `Run \`lando ${name}\` without arguments.`,
      })
    : undefined;

type InvocationOptions = Pick<RunToolingOptions, "args" | "user" | "cwd" | "env"> & {
  readonly agentEnvAllowlist?: ReadonlyArray<string>;
};

const stepInvocation = (
  tool: string,
  step: NormalizedToolingStep & { readonly resolvedService?: string },
  options: InvocationOptions,
): ToolingInvocation => {
  const args = options.args ?? [];
  const cwd = step.dir ?? options.cwd;
  const user = options.user ?? step.user;
  return {
    tool,
    ...(step.resolvedService === undefined ? {} : { service: step.resolvedService }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(user === undefined ? {} : { user }),
    ...(Object.keys(step.env).length === 0 && options.env === undefined
      ? {}
      : { env: { ...step.env, ...options.env } }),
    ...(options.agentEnvAllowlist === undefined ? {} : { agentEnvAllowlist: options.agentEnvAllowlist }),
    commands: [step.argv === undefined ? shellCommand(step.cmd, args) : [...step.argv, ...args]],
    hostSteps: [
      step.argv === undefined
        ? { kind: "shell", source: step.cmd, argv: args }
        : { kind: "argv", argv: [...step.argv, ...args] },
    ],
  };
};

export const buildToolingInvocation = (
  name: string,
  task: ToolingTaskShape,
  options: InvocationOptions = {},
): ToolingInvocation => {
  const normalized = Either.getOrThrowWith(normalizeToolingTask(name, task), (error) => error);
  const values = Either.getOrThrowWith(
    parseToolingArgv(normalized, normalized.acceptsArguments ? (options.args ?? []) : []),
    (error) => error,
  );
  const invocations = normalized.steps.map((step, index) => {
    const service = Either.getOrThrowWith(resolveServiceRef(step.service, values), (error) => error);
    return stepInvocation(
      name,
      { ...step, ...(service === undefined ? {} : { resolvedService: service }) },
      {
        ...options,
        args: index === normalized.steps.length - 1 ? values.argv : [],
      },
    );
  });
  return {
    tool: name,
    ...invocations[0],
    commands: invocations.flatMap((invocation) => invocation.commands),
    hostSteps: invocations.flatMap((invocation) => invocation.hostSteps ?? []),
  };
};

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
    const normalized = yield* normalizeToolingTask(toolingLookupKey, task, source);
    if (normalized.disabled) {
      return yield* Effect.fail(
        new ToolingDisabledError({
          message: `Tooling command ${options.name} is disabled.`,
          tool: toolingLookupKey,
          source,
          remediation: `Enable tooling task ${toolingLookupKey} in ${source.path} before running it.`,
        }),
      );
    }
    if (normalized.steps.length === 0) {
      return yield* Effect.fail(
        new ToolingCompileError({
          message: `Tooling command ${options.name} does not define cmd or cmds.`,
          tool: options.name,
        }),
      );
    }

    const argumentFailure = validateToolingArguments(options.name, normalized, options.args ?? []);
    if (argumentFailure !== undefined) return yield* Effect.fail(argumentFailure);
    const values = yield* parseToolingArgv(normalized, options.args ?? []);
    const agentEnvAllowlist = yield* resolveAgentEnvForwardAllowlist(landofile.agentEnv, process.env);
    const invocations = yield* Effect.forEach(normalized.steps, (step, index) =>
      Effect.gen(function* () {
        const service = yield* resolveServiceRef(step.service, values);
        return stepInvocation(
          options.name,
          { ...step, ...(service === undefined ? {} : { resolvedService: service }) },
          {
            ...options,
            args: index === normalized.steps.length - 1 ? values.argv : [],
            agentEnvAllowlist,
          },
        );
      }),
    );
    const provider = requiresProvider(normalized)
      ? yield* Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select(plan))
      : runtimeProviderService;
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
      Effect.gen(function* () {
        let combined: ToolingEngineResult = {
          tool: options.name,
          service: "",
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
        for (const invocation of invocations) {
          const result = yield* invocation.service === ":host"
            ? Effect.gen(function* () {
                const shell = yield* Effect.serviceOption(ShellRunner);
                if (Option.isNone(shell))
                  return yield* Effect.fail(
                    new ToolingCompileError({
                      message: `ShellRunner is unavailable for tooling command ${options.name}.`,
                      tool: options.name,
                    }),
                  );
                return yield* runHostToolingWith(shell.value, invocation, plan, provider);
              })
            : Effect.flatMap(ToolingEngine, (engine) => engine.run(invocation, plan, provider));
          if (result.exitCode !== 0)
            return yield* Effect.fail(
              new ToolingExecError({
                message: `Tooling command ${options.name} failed with exit code ${result.exitCode}.`,
                tool: options.name,
                exitCode: result.exitCode,
              }),
            );
          combined = {
            ...result,
            stdout: combined.stdout + result.stdout,
            stderr: combined.stderr + result.stderr,
          };
        }
        return combined;
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
