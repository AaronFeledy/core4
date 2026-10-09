import { Effect, type Stream } from "effect";

import type { ExecAppOptions, ExecAppResult, ExecAppError as SdkExecAppError } from "@lando/sdk/app";
import {
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan, HostTerminal, LandofileShape, ServicePlan } from "@lando/sdk/schema";
import {
  type AppPlanner,
  type CommandSpec,
  type ConfigService,
  type ExecTarget,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../config/agent-env-policy.ts";
import { withAgentContextEnv } from "../config/agent-env.ts";
import { withTerminalEnv } from "../config/terminal-env.ts";
import { type ResolvedAppTarget, loadUserLandofileAt, planDesiredApp } from "../landofile/app-resolution.ts";
import {
  collectAppPlanRedactionTokens,
  registerAppPlanRedactionTokens,
} from "../services/app-plan-redaction.ts";
import { resolveContainerCwd } from "../subsystems/host-proxy/cwd-remap.ts";
import { collectExecStream } from "./exec-stream.ts";
import { StreamFrameSink } from "./stream-frame-sink.ts";
import { availableServiceList, unknownPlanServiceError } from "./unknown-service.ts";

export type ExecAppError = SdkExecAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { ExecAppOptions, ExecAppResult } from "@lando/sdk/app";

export type ExecAppRuntimeOptions = ExecAppOptions & {
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly terminalResize?: Stream.Stream<{ readonly columns: number; readonly rows: number }>;
  readonly hostTerminal?: HostTerminal;
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
  if (match === undefined) return { service: undefined, command };
  const peeled = rest[0] === "--" ? rest.slice(1) : rest;
  return { service: first, command: peeled };
};

const resolveService = (
  requested: string | undefined,
  plan: AppPlan,
): Effect.Effect<ServicePlan, ToolingExecError> => {
  if (requested !== undefined && requested.length > 0) {
    const match = Object.values(plan.services).find((service) => String(service.name) === requested);
    if (match === undefined)
      return Effect.fail(
        unknownPlanServiceError({
          prefix: "exec",
          tool: "app:exec",
          requested,
          services: plan.services,
          remediation: (first) => `Example: lando exec ${first} -- <command>`,
        }),
      );
    return Effect.succeed(match);
  }
  const primary = Object.values(plan.services).find((service) => service.primary === true);
  if (primary === undefined) return Effect.fail(noPrimaryServiceError(plan.services));
  return Effect.succeed(primary);
};

const inheritTty = (options: ExecAppRuntimeOptions): boolean => options.tty === true;

const inheritStdin = (options: ExecAppRuntimeOptions): boolean => options.stdinStream !== undefined;

export const execApp = Effect.fn("AppOperation.exec")(function* (
  options: ExecAppRuntimeOptions,
  appTarget?: ResolvedAppTarget,
): Effect.fn.Return<ExecAppResult, ExecAppError, ExecAppServices> {
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;

  let plan: AppPlan;
  let landofile: LandofileShape;
  if (appTarget?.plan !== undefined) {
    plan = appTarget.plan;
    landofile = yield* loadUserLandofileAt(landofileService, appTarget.root);
  } else {
    ({ plan, landofile } = yield* planDesiredApp);
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
  const mergedEnv = withTerminalEnv({
    tty,
    hostEnv: process.env,
    ...(options.hostTerminal === undefined ? {} : { hostTerminal: options.hostTerminal }),
    serviceEnv: service.environment,
    ...(env === undefined ? {} : { env }),
  });
  const cwd = resolveContainerCwd(service, options.cwd, process.cwd());
  const spec: CommandSpec = {
    command: split.command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(mergedEnv === undefined || Object.keys(mergedEnv).length === 0 ? {} : { env: mergedEnv }),
    ...(tty
      ? {
          tty: true,
          ...(options.hostTerminal?.columns !== undefined && options.hostTerminal.rows !== undefined
            ? { terminalSize: { columns: options.hostTerminal.columns, rows: options.hostTerminal.rows } }
            : {}),
          ...(options.terminalResize === undefined ? {} : { terminalResize: options.terminalResize }),
        }
      : {}),
    ...(attachStdin ? { stdin: "inherit", stdinStream: options.stdinStream } : {}),
  };

  yield* registerAppPlanRedactionTokens(plan);
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
