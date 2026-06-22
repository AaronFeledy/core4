import { Effect } from "effect";

import type { ExecAppError, ExecAppOptions, ExecAppResult } from "@lando/sdk/app";
import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  type ExecTarget,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
import { emitOptionalStderr } from "../renderer-boundary.ts";

export type { ExecAppError, ExecAppOptions, ExecAppResult } from "@lando/sdk/app";

export type ExecAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

const availableServiceList = (services: AppPlan["services"]): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

const noPrimaryServiceError = (services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  return new ToolingExecError({
    message:
      list.length === 0
        ? "exec requires --service: the app has no services."
        : `exec requires --service: the app has no primary service (available: ${list}).`,
    tool: "app:exec",
  });
};

const unknownServiceError = (requested: string, services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  return new ToolingExecError({
    message:
      list.length === 0
        ? `exec: service ${requested} is not in the app plan.`
        : `exec: service ${requested} is not in the app plan (available: ${list}).`,
    tool: "app:exec",
  });
};

const resolveService = (
  options: ExecAppOptions,
  plan: AppPlan,
): Effect.Effect<ServicePlan, ToolingExecError> => {
  const declared = options.service !== undefined && options.service.length > 0 ? options.service : undefined;
  if (declared !== undefined) {
    const match = Object.values(plan.services).find((service) => String(service.name) === declared);
    if (match === undefined) {
      return Effect.fail(unknownServiceError(declared, plan.services));
    }
    return Effect.succeed(match);
  }
  const primary = Object.values(plan.services).find((service) => service.primary === true);
  if (primary === undefined) {
    return Effect.fail(noPrimaryServiceError(plan.services));
  }
  return Effect.succeed(primary);
};

export const execApp = (
  options: ExecAppOptions,
  appTarget?: ResolvedAppTarget,
): Effect.Effect<ExecAppResult, ExecAppError, ExecAppServices> =>
  Effect.gen(function* () {
    if (options.command.length === 0) {
      return yield* Effect.fail(
        new ToolingExecError({
          message: "exec requires a command to run.",
          tool: "app:exec",
        }),
      );
    }
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;

    const plan =
      appTarget?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      }));

    // Resolve service before selecting provider so an invalid --service
    // returns ToolingExecError with the available list instead of a
    // provider-selection failure.
    const service = yield* resolveService(options, plan);
    const provider = yield* registry.select(plan);
    const target: ExecTarget = {
      app: plan.id,
      service: service.name,
      plan,
      ...(options.user === undefined ? {} : { user: options.user }),
    };
    const spec: CommandSpec = {
      command: options.command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };

    const result = yield* provider.exec(target, spec);

    if (result.stderr.length > 0) {
      yield* emitOptionalStderr(result.stderr);
    }

    return {
      app: plan.name,
      service: String(service.name),
      command: options.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });

export const renderExecAppResult = (result: ExecAppResult): string | undefined => {
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  if (result.stdout.length === 0) return undefined;
  // Strip one trailing newline so callers don't add a second one.
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
};
