import { Clock, DateTime, Effect } from "effect";
import {
  HealthcheckTargetUnsupportedError,
  ProviderUnavailableError,
  ServiceNotFoundError,
  ServiceStartError,
} from "../errors/index.ts";
import {
  type BringDownOutcome,
  type ContainerBringDownReceipt,
  LANDO_DATA_ROOT_LABEL,
  type ObservedBringDown,
  effectiveReadiness,
} from "../schema/index.ts";
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
  const restart = (target: ServiceSelector) =>
    Effect.gen(function* () {
      const current = yield* inspect(target, "restart");
      const now = yield* Clock.currentTimeMillis;
      containers.set(key(target), {
        ...current,
        status: "running",
        lastStartedAt: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
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
      const completes = new Set(
        Object.values(plan.services).flatMap((service) =>
          service.dependsOn
            .filter((edge) => edge.condition === "service_completed_successfully")
            .map((edge) => edge.service),
        ),
      );
      let changed = false;
      for (const service of Object.values(plan.services)) {
        if (options.signal?.aborted) return yield* Effect.interrupt;
        const target = { app: plan.id, service: service.name };
        const current = containers.get(key(target));
        const now = yield* Clock.currentTimeMillis;
        if (current === undefined) generation += 1;
        const completesOnStart = completes.has(service.name);
        changed ||= current?.status !== "running";
        containers.set(key(target), {
          app: plan.id,
          appRoot: plan.identity?.appRoot ?? plan.root,
          service: service.name,
          providerId: plan.provider,
          containerId: current?.containerId ?? `test-container-${generation}`,
          status: completesOnStart ? "exited" : "running",
          ...(completesOnStart ? { exitCode: 0 } : {}),
          lastStartedAt:
            current?.status === "running"
              ? current.lastStartedAt
              : DateTime.toDateUtc(DateTime.makeUnsafe(now)),
          publications: { status: "unknown" },
          labels: {
            ...(plan.identity?.dataRoot === undefined
              ? {}
              : { [LANDO_DATA_ROOT_LABEL]: plan.identity.dataRoot }),
            "dev.lando.app": plan.id,
            "dev.lando.app-root": plan.identity?.appRoot ?? plan.root,
            "dev.lando.service": service.name,
          },
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
  const bringDown: RuntimeProviderShape["bringDown"] = (target, options) =>
    Effect.sync((): BringDownOutcome => {
      const receipts: ContainerBringDownReceipt[] = [];
      for (const [id, container] of containers) {
        if (container.app !== target.app) continue;
        const receipt = { service: container.service, containerId: container.containerId };
        if (options.containers === "remove") {
          containers.delete(id);
          receipts.push({ ...receipt, action: "removed" });
        } else if (container.status === "running") {
          containers.set(id, { ...container, status: "exited" });
          receipts.push({ ...receipt, action: "stopped" });
        } else receipts.push({ ...receipt, action: "already-stopped" });
      }
      if (receipts.length === 0 && target.plan === undefined)
        return { kind: "no-op", reason: "no-applied-plan" };
      return options.containers === "remove"
        ? { kind: "removed", containers: receipts, volumesRemoved: { data: 0, cache: 0 } }
        : { kind: "stopped", containers: receipts };
    });
  // The observation only addresses a container: ownership is proven by what the double stored.
  const bringDownObserved: RuntimeProviderShape["bringDownObserved"] = (observed, disposition) =>
    Effect.suspend((): Effect.Effect<ObservedBringDown, ProviderUnavailableError> => {
      const id = key(observed);
      const current = containers.get(id);
      const service = observed.service;
      if (observed.containerId === undefined || current?.containerId !== observed.containerId)
        return Effect.succeed({ service, action: "absent" });
      const containerId = current.containerId;
      if (
        observed.providerId !== current.providerId ||
        current.labels?.["dev.lando.app"] !== String(observed.app) ||
        current.labels?.["dev.lando.app-root"] !== String(observed.appRoot) ||
        current.labels?.["dev.lando.service"] !== String(observed.service)
      )
        return Effect.fail(
          new ProviderUnavailableError({
            providerId: TEST_PROVIDER_ID,
            operation: "bringDownObserved",
            message: `Container ${containerId} does not prove Lando service ownership.`,
            remediation: `Inspect container ${containerId} with your container runtime and remove it there.`,
          }),
        );
      if (disposition === "remove") {
        containers.delete(id);
        return Effect.succeed({ service, containerId, action: "removed" });
      }
      if (current.status !== "running")
        return Effect.succeed({ service, containerId, action: "already-stopped" });
      containers.set(id, { ...current, status: "exited" });
      return Effect.succeed({ service, containerId, action: "stopped" });
    });
  return {
    apply,
    inspect,
    restart,
    bringDown,
    bringDownObserved,
    list: (filter: Parameters<RuntimeProviderShape["list"]>[0]) =>
      Effect.sync(() =>
        [...containers.values()].filter(
          (container) => filter.app === undefined || container.app === filter.app,
        ),
      ),
  };
};
