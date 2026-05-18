/**
 * `lando exec` — run a command in a service through the active runtime
 * provider's exec channel.
 *
 * `ssh` is `exec` with default `--interactive --tty` and a default command
 * of `sh -l`. Bootstrap level: `app`.
 */
import { Effect } from "effect";

import type {
  CapabilityError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  type ExecTarget,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

export interface ExecAppOptions {
  /**
   * Service to run the command in. When omitted (or empty string), the
   * service marked `primary: true` in the planned `AppPlan` is used; if no
   * primary service exists, the call fails with `ToolingExecError`.
   */
  readonly service?: string;
  /**
   * The argv to execute inside the service. Empty argv fails with
   * `ToolingExecError`.
   */
  readonly command: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Accepted for parity with `ssh` semantics. The Alpha
   * `RuntimeProvider.exec` API does not allocate a TTY (`execStream` is
   * deferred), so these are recorded but do not change exec behavior.
   */
  readonly interactive?: boolean;
  readonly tty?: boolean;
}

export interface ExecAppResult {
  readonly app: string;
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecAppError =
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError;

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

    const landofile = yield* landofileService.discover;
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);

    // Resolve service before selecting provider so a bad --service surfaces
    // ToolingExecError with the available list instead of being masked by a
    // provider-selection failure (e.g. NoProviderInstalledError).
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
      yield* Effect.sync(() => {
        process.stderr.write(result.stderr);
      });
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

/**
 * Render the exec result. Returns the captured stdout (already-decoded
 * provider output) for printing through OCLIF's `this.log`. As a side
 * effect, sets `process.exitCode` to the child command's exit code so
 * non-zero exits propagate through both the source OCLIF path and the
 * compiled `$bunfs` dispatcher without requiring extra plumbing.
 */
export const renderExecAppResult = (result: ExecAppResult): string | undefined => {
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  return result.stdout.length === 0 ? undefined : result.stdout;
};
