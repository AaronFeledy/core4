import { Clock, DateTime, Effect } from "effect";
import {
  HealthcheckTargetUnsupportedError,
  ServiceNotFoundError,
  ServiceStartError,
} from "../errors/index.ts";
import { effectiveReadiness } from "../schema/index.ts";
import type { RuntimeProviderShape, ServiceRuntimeFields, ServiceSelector } from "../services/index.ts";
import { TEST_PROVIDER_ID } from "./_shared.ts";

export const makeTestProviderContainers = () => {
  const containers = new Map<
    string,
    ServiceRuntimeFields & {
      readonly status: "running" | "exited";
      readonly lastStartedAt: Date;
      readonly containerId: string;
    }
  >();
  let generation = 0;
  const key = (target: ServiceSelector) => JSON.stringify([target.app, target.service]);
  const inspect = Effect.fn("RuntimeProvider.inspect")((target: ServiceSelector, operation = "inspect") =>
    Effect.suspend(() => {
      const container = containers.get(key(target));
      return container === undefined
        ? Effect.fail(
            new ServiceNotFoundError({
              providerId: TEST_PROVIDER_ID,
              operation,
              service: target.service,
              message: `Service ${target.service} is not present in the app plan.`,
              remediation: `Add service ${target.service} to the Landofile or correct the service name, then re-run the command.`,
            }),
          )
        : Effect.succeed(container);
    }),
  );
  const setRunState = (target: ServiceSelector, status: "running" | "exited") =>
    Effect.gen(function* () {
      const current = yield* inspect(target, status === "running" ? "start" : "stop");
      const now = yield* Clock.currentTimeMillis;
      containers.set(key(target), {
        ...current,
        status,
        lastStartedAt:
          status === "running" ? DateTime.toDateUtc(DateTime.makeUnsafe(now)) : current.lastStartedAt,
      });
    });
  const apply: RuntimeProviderShape["apply"] = Effect.fn("TestRuntimeProvider.applyContainers")(
    function* (plan, options) {
      for (const service of Object.values(plan.services)) {
        const probe = effectiveReadiness(service);
        if (
          probe?.kind !== "none" &&
          probe?.executionTarget === "host" &&
          options.executeReadinessAttempt === undefined
        ) {
          return yield* Effect.fail(
            new HealthcheckTargetUnsupportedError({
              service: service.name,
              target: "host",
              message: "Host readiness requires an engine-owned attempt delegate.",
              remediation:
                "Apply this plan through the engine with host readiness runners, or use a service readiness probe.",
            }),
          );
        }
      }
      let changed = false;
      for (const service of Object.values(plan.services)) {
        if (options.signal?.aborted) return yield* Effect.interrupt;
        const target = { app: plan.id, service: service.name };
        const current = containers.get(key(target));
        const now = yield* Clock.currentTimeMillis;
        if (current === undefined) generation += 1;
        changed ||= current?.status !== "running";
        containers.set(key(target), {
          app: plan.id,
          appRoot: plan.identity?.appRoot ?? plan.root,
          service: service.name,
          providerId: plan.provider,
          containerId: current?.containerId ?? `test-container-${generation}`,
          status: "running",
          lastStartedAt:
            current?.status === "running"
              ? current.lastStartedAt
              : DateTime.toDateUtc(DateTime.makeUnsafe(now)),
          publications: { status: "unknown" },
        });
        const probe = effectiveReadiness(service);
        if (probe !== undefined && probe.kind !== "none" && options.executeReadinessAttempt !== undefined) {
          const result = yield* options.executeReadinessAttempt(service.name, probe);
          if (result.exitCode !== 0) {
            return yield* Effect.fail(
              new ServiceStartError({
                providerId: TEST_PROVIDER_ID,
                service: service.name,
                operation: "readiness",
                message: `Readiness attempt for service ${service.name} failed with exit code ${result.exitCode}.`,
                remediation: "Correct the service readiness check and retry starting the app.",
              }),
            );
          }
        }
      }
      return { changed };
    },
  );
  const destroy: RuntimeProviderShape["destroy"] = (target) =>
    Effect.sync(() => {
      let removed = false;
      for (const [id, container] of containers) {
        if (container.app === target.app) {
          containers.delete(id);
          removed = true;
        }
      }
      return removed || target.plan !== undefined
        ? { kind: "destroyed" }
        : { kind: "no-op", reason: "no-applied-plan" };
    });
  const removeObservedService: RuntimeProviderShape["removeObservedService"] = (observed) =>
    Effect.sync(() => {
      const id = key(observed);
      const current = containers.get(id);
      if (observed.containerId === undefined || current?.containerId !== observed.containerId)
        return { kind: "absent" };
      containers.delete(id);
      return { kind: "removed" };
    });
  return {
    apply,
    inspect,
    start: (target: ServiceSelector) => setRunState(target, "running"),
    restart: (target: ServiceSelector) => setRunState(target, "running"),
    stop: (target: ServiceSelector) => setRunState(target, "exited"),
    destroy,
    removeObservedService,
    list: (filter: Parameters<RuntimeProviderShape["list"]>[0]) =>
      Effect.sync(() =>
        [...containers.values()].filter(
          (container) => filter.app === undefined || container.app === filter.app,
        ),
      ),
  };
};
