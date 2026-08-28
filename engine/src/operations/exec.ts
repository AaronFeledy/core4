import { Effect, Option, type Scope, Stream } from "effect";

import type { ExecAppOptions, ExecAppResult, ExecAppError as SdkExecAppError } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan, LandofileShape, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  type ConfigService,
  type ExecChunk,
  type ExecTarget,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../config/agent-env-policy.ts";
import { withAgentContextEnv } from "../config/agent-env.ts";
import {
  type ResolvedAppTarget,
  loadUserLandofile,
  loadUserLandofileAt,
} from "../landofile/app-resolution.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { StreamFrameSink, type StreamFrameSinkShape } from "./stream-frame-sink.ts";

export type ExecAppError = SdkExecAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { ExecAppOptions, ExecAppResult } from "@lando/sdk/app";

export type ExecAppRuntimeOptions = ExecAppOptions & {
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly terminalResize?: Stream.Stream<{ readonly columns: number; readonly rows: number }>;
};

export type ExecAppResultWithTokens = ExecAppResult & {
  readonly redactionTokens?: ReadonlyArray<string>;
};

export const execAppRedactionTokens = (result: unknown): ReadonlyArray<string> => {
  if (result === null || typeof result !== "object" || !("redactionTokens" in result)) return [];
  const tokens = result.redactionTokens;
  if (!Array.isArray(tokens)) return [];
  return tokens.filter((token): token is string => typeof token === "string");
};

export type ExecAppServices = AppPlanner | ConfigService | LandofileService | RuntimeProviderRegistry;

const availableServiceList = (services: AppPlan["services"]): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

const noPrimaryServiceError = (services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  const first = list.split(", ")[0];
  return new ToolingExecError({
    message:
      list.length === 0
        ? "exec needs a service, but this app has none."
        : `exec needs a service (available: ${list}).`,
    tool: "app:exec",
    ...(first === undefined || first.length === 0
      ? {}
      : { remediation: `Example: lando exec ${first} -- <command>` }),
  });
};

const unknownServiceError = (requested: string, services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  const first = list.split(", ")[0];
  return new ToolingExecError({
    message:
      list.length === 0
        ? `exec: service ${requested} is not in the app plan.`
        : `exec: service ${requested} is not in the app plan (available: ${list}).`,
    tool: "app:exec",
    ...(first === undefined || first.length === 0
      ? {}
      : { remediation: `Example: lando exec ${first} -- <command>` }),
  });
};

export const splitExecServiceCommand = (
  plan: AppPlan,
  explicitService: string | undefined,
  command: ReadonlyArray<string>,
): { readonly service: string | undefined; readonly command: ReadonlyArray<string> } => {
  if (explicitService !== undefined && explicitService.length > 0) {
    return { service: explicitService, command };
  }
  const [first, ...rest] = command;
  if (first === undefined || rest.length === 0) return { service: undefined, command };
  const match = Object.values(plan.services).find((service) => String(service.name) === first);
  return match === undefined ? { service: undefined, command } : { service: first, command: rest };
};

const resolveService = (
  requested: string | undefined,
  plan: AppPlan,
): Effect.Effect<ServicePlan, ToolingExecError> => {
  if (requested !== undefined && requested.length > 0) {
    const match = Object.values(plan.services).find((service) => String(service.name) === requested);
    if (match === undefined) return Effect.fail(unknownServiceError(requested, plan.services));
    return Effect.succeed(match);
  }
  const primary = Object.values(plan.services).find((service) => service.primary === true);
  if (primary === undefined) return Effect.fail(noPrimaryServiceError(plan.services));
  return Effect.succeed(primary);
};

const emitRaw = (
  sink: Option.Option<StreamFrameSinkShape>,
  kind: "stdout" | "stderr",
  text: string,
): Effect.Effect<void> => {
  if (text.length === 0 || Option.isNone(sink)) return Effect.void;
  return sink.value.emit({ _tag: kind, chunk: text, raw: true });
};

const collectExecStream = (
  stream: Stream.Stream<ExecChunk, ProviderError, Scope.Scope>,
  sink: Option.Option<StreamFrameSinkShape>,
): Effect.Effect<
  { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  ProviderError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      yield* stream.pipe(
        Stream.runForEach((chunk) => {
          if ("exitCode" in chunk) {
            exitCode = chunk.exitCode;
            return Effect.void;
          }
          const decoder = chunk.kind === "stdout" ? stdoutDecoder : stderrDecoder;
          const text = decoder.decode(chunk.chunk, { stream: true });
          if (chunk.kind === "stdout") stdout += text;
          else stderr += text;
          return emitRaw(sink, chunk.kind, text);
        }),
      );
      const stdoutTail = stdoutDecoder.decode();
      const stderrTail = stderrDecoder.decode();
      stdout += stdoutTail;
      stderr += stderrTail;
      yield* emitRaw(sink, "stdout", stdoutTail);
      yield* emitRaw(sink, "stderr", stderrTail);
      return { exitCode, stdout, stderr };
    }),
  );

const envOrFallback = (name: "COLUMNS" | "LINES", fallback: string): string => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
};

const inheritTty = (options: ExecAppRuntimeOptions): boolean => options.tty === true;

const inheritStdin = (options: ExecAppRuntimeOptions): boolean =>
  options.interactive === true && options.stdinStream !== undefined;

export const execApp = (
  options: ExecAppRuntimeOptions,
  appTarget?: ResolvedAppTarget,
): Effect.Effect<ExecAppResult, ExecAppError, ExecAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;

    let plan: AppPlan;
    let landofile: LandofileShape;
    if (appTarget?.plan !== undefined) {
      plan = appTarget.plan;
      landofile = yield* loadUserLandofileAt(landofileService, appTarget.root);
    } else {
      landofile = yield* loadUserLandofile(landofileService);
      const capabilities = yield* registry.capabilities;
      plan = yield* planner.plan(landofile, capabilities);
    }

    const split = splitExecServiceCommand(plan, options.service, options.command);
    if (split.command.length === 0) {
      const list = availableServiceList(plan.services);
      const first = split.service ?? list.split(", ")[0];
      return yield* Effect.fail(
        new ToolingExecError({
          message: "exec requires a command to run.",
          tool: "app:exec",
          ...(first === undefined || first.length === 0
            ? {}
            : { remediation: `Example: lando exec ${first} -- <command>` }),
        }),
      );
    }

    const service = yield* resolveService(split.service, plan);
    const provider = yield* registry.select(plan);
    const target: ExecTarget = {
      app: plan.id,
      service: service.name,
      plan,
      ...(options.user === undefined ? {} : { user: options.user }),
    };
    const allowlist = yield* resolveAgentEnvForwardAllowlist(landofile.agentEnv, process.env);
    const env = withAgentContextEnv(options.env, process.env, {
      allowlist,
      lowerThanEnv: service.environment,
    });
    const tty = inheritTty(options);
    const attachStdin = inheritStdin(options);
    const ttyEnv = tty
      ? {
          COLUMNS: envOrFallback("COLUMNS", "80"),
          LINES: envOrFallback("LINES", "24"),
        }
      : undefined;
    const mergedEnv = env === undefined && ttyEnv === undefined ? undefined : { ...ttyEnv, ...env };
    const spec: CommandSpec = {
      command: split.command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(mergedEnv === undefined || Object.keys(mergedEnv).length === 0 ? {} : { env: mergedEnv }),
      ...(tty
        ? {
            tty: true,
            ...(options.terminalResize === undefined ? {} : { terminalResize: options.terminalResize }),
          }
        : {}),
      ...(attachStdin ? { stdin: "inherit", stdinStream: options.stdinStream } : {}),
    };

    const sink = yield* Effect.serviceOption(StreamFrameSink);
    const result = yield* collectExecStream(provider.execStream(target, spec), sink);

    const withTokens: ExecAppResultWithTokens = {
      app: plan.name,
      service: String(service.name),
      command: split.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      redactionTokens: collectAppPlanRedactionTokens(plan),
    };
    return withTokens;
  });
