/**
 * `ToolingEngine` Live Layer for the default `providerExec` engine.
 *
 * Translates a normalized `ToolingInvocation` into one or more
 * `RuntimeProvider.exec` calls against the planned target service and
 * returns the verbatim exit code plus the aggregated stdout/stderr.
 *
 * Service resolution follows §6.10: the declared `task.service` wins, else
 * the engine looks for the lone `ServicePlan` with `primary: true`. Apps
 * with zero primary services and no declared service fail with a tagged
 * `ToolingExecError`; planner currently marks `name === "web"` as primary,
 * so apps without a `web` service hit the no-primary path.
 *
 * The engine receives the runtime `RuntimeProviderShape` as an explicit
 * argument from the caller, not via the `RuntimeProvider` Tag, because the
 * runtime layer's `RuntimeProvider` is a stub: real providers come from
 * `RuntimeProviderRegistry.select(plan)`.
 */
import { Effect, Layer } from "effect";

import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ServiceName, ServicePlan } from "@lando/sdk/schema";
import {
  type RuntimeProviderShape,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

const findPrimary = (services: AppPlan["services"]): ReadonlyArray<ServicePlan> =>
  Object.values(services).filter((service) => service.primary === true);

const availableServiceList = (services: AppPlan["services"]) =>
  Object.values(services)
    .map((service) => service.name)
    .sort()
    .join(", ");

const noCommandsError = (tool: string) =>
  new ToolingExecError({
    message: `Tooling task ${tool} has no commands to run.`,
    tool,
  });

const noPrimaryServiceError = (tool: string, services: AppPlan["services"]) => {
  const available = availableServiceList(services);
  return new ToolingExecError({
    message: `Tooling task ${tool} did not declare service: and the app has no primary service. Set service: on the task or mark one of the available services as primary${available.length === 0 ? "." : `: ${available}.`}`,
    tool,
  });
};

const unknownServiceError = (tool: string, requested: string, services: AppPlan["services"]) => {
  const available = availableServiceList(services);
  return new ToolingExecError({
    message: `Tooling task ${tool} declared service: ${requested} but no such service exists in the app plan${available.length === 0 ? "." : ` (available: ${available}).`}`,
    tool,
  });
};

const resolveService = (
  invocation: ToolingInvocation,
  plan: AppPlan,
): Effect.Effect<ServiceName, ToolingExecError> => {
  if (invocation.service !== undefined) {
    const matching = Object.values(plan.services).find((service) => service.name === invocation.service);
    if (matching === undefined) {
      return Effect.fail(unknownServiceError(invocation.tool, invocation.service, plan.services));
    }
    return Effect.succeed(matching.name);
  }
  const [primary] = findPrimary(plan.services);
  if (primary === undefined) {
    return Effect.fail(noPrimaryServiceError(invocation.tool, plan.services));
  }
  return Effect.succeed(primary.name);
};

const providerExecRun = (invocation: ToolingInvocation, plan: AppPlan, provider: RuntimeProviderShape) =>
  Effect.gen(function* () {
    if (invocation.commands.length === 0) {
      return yield* Effect.fail(noCommandsError(invocation.tool));
    }
    const service = yield* resolveService(invocation, plan);
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    for (const command of invocation.commands) {
      const target = {
        app: plan.id,
        service,
        plan,
        ...(invocation.user === undefined ? {} : { user: invocation.user }),
      };
      const spec = {
        command,
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        ...(invocation.env === undefined ? {} : { env: invocation.env }),
      };
      const result = yield* provider.exec(target, spec);
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
      if (exitCode !== 0) break;
    }
    const out: ToolingEngineResult = {
      tool: invocation.tool,
      service,
      exitCode,
      stdout,
      stderr,
    };
    return out;
  });

export const ProviderExecToolingEngineLive = Layer.succeed(ToolingEngine, {
  id: "providerExec",
  run: providerExecRun,
});
