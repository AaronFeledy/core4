import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";

import { ServiceStartError } from "@lando/sdk/errors";
import { type AppId, type AppPlan, ProviderId, type ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import {
  ContractFailure,
  type ProviderStartRetentionHooks,
  TestRuntimeProvider,
  runProviderStartRetentionContract,
} from "@lando/sdk/test";

const testProviderId = ProviderId.make(TestRuntimeProvider.id);

/** Private mirror of the contract's native container name convention. */
const retentionContainerName = (slug: string, service: string): string =>
  `lando-${slug}-${service}`.replace(/[^a-zA-Z0-9_.-]+/gu, "-");

/**
 * In-memory provider double that retains resources on start failure / interrupt
 * and reuses generation-unique container ids on retry — the behavior the shared
 * retention contract requires of real providers. Observations go through inspect.
 */
const makeRetentionDouble = (): {
  readonly provider: RuntimeProviderShape;
  readonly hooks: ProviderStartRetentionHooks;
} => {
  const networks = new Set<string>();
  const volumes = new Set<string>();
  const containers = new Map<string, { id: string; running: boolean; app: AppId; service: ServiceName }>();
  let generation = 0;
  const failStartFor = new Set<string>();
  let abortAfterStarts = 0;
  let abortController: AbortController | undefined;
  let successfulStarts = 0;

  const containerName = (plan: AppPlan, service: string) => retentionContainerName(plan.slug, service);
  const networkName = (plan: AppPlan) => `lando-${plan.slug}`.replace(/[^a-zA-Z0-9_.-]+/gu, "-");

  const hooks: ProviderStartRetentionHooks = {
    setFailStartFor: (names) => {
      failStartFor.clear();
      for (const name of names) failStartFor.add(name);
    },
    setAbortAfterStarts: (count, controller) => {
      abortAfterStarts = count;
      abortController = controller;
      successfulStarts = 0;
    },
    hasNetwork: (name) => networks.has(name),
    hasVolume: (name) => volumes.has(name),
  };

  const inspectRecord = (target: {
    readonly app: AppId;
    readonly service: ServiceName;
    readonly plan?: AppPlan;
  }): ServiceRuntimeInfo => {
    const name = target.plan === undefined ? undefined : containerName(target.plan, String(target.service));
    const record = name === undefined ? undefined : containers.get(name);
    if (record === undefined) {
      return {
        app: target.app,
        service: target.service,
        providerId: testProviderId,
        status: "stopped",
      };
    }
    return {
      app: record.app,
      service: record.service,
      providerId: testProviderId,
      status: record.running ? "running" : "stopped",
      containerId: record.id,
    };
  };

  const apply = Effect.fnUntraced(function* (plan: AppPlan, options?: { readonly signal?: AbortSignal }) {
    networks.add(networkName(plan));
    for (const store of plan.stores) volumes.add(store.name);

    const services = Object.values(plan.services).sort((left, right) =>
      String(left.name).localeCompare(String(right.name)),
    );
    const started = new Set<string>();
    const pending = [...services];
    while (pending.length > 0) {
      if (options?.signal?.aborted === true) {
        return yield* Effect.interrupt;
      }
      const index = pending.findIndex((service) =>
        service.dependsOn.every(
          (dep) => dep.condition !== "service_started" || started.has(String(dep.service)),
        ),
      );
      if (index < 0) {
        return yield* Effect.fail(
          new ServiceStartError({
            providerId: "test",
            operation: "bringUp.schedule",
            service: String(pending[0]?.name ?? "unknown"),
            message: "dependency cycle in retention double",
          }),
        );
      }
      const [service] = pending.splice(index, 1);
      if (service === undefined) continue;
      const name = containerName(plan, service.name);
      let record = containers.get(name);
      if (record === undefined) {
        generation += 1;
        record = {
          id: `${name}-g${generation}`,
          running: false,
          app: plan.id,
          service: service.name,
        };
        containers.set(name, record);
      }
      if (failStartFor.has(name)) {
        return yield* Effect.fail(
          new ServiceStartError({
            providerId: "test",
            operation: "bringUp.start",
            service: String(service.name),
            message: `forced start failure for ${name}`,
          }),
        );
      }
      record.running = true;
      started.add(String(service.name));
      successfulStarts += 1;
      if (abortAfterStarts > 0 && successfulStarts >= abortAfterStarts && abortController !== undefined) {
        abortController.abort();
        return yield* Effect.interrupt;
      }
    }
    return { changed: true };
  });

  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    apply: (plan, options) => apply(plan, options),
    inspect: (target) => Effect.succeed(inspectRecord(target)),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        const plan = target.plan;
        if (plan === undefined) return { kind: "no-op" as const, reason: "no-applied-plan" as const };
        for (const service of Object.values(plan.services)) {
          containers.delete(containerName(plan, service.name));
        }
        networks.delete(networkName(plan));
        if (destroyOptions?.volumes === true) {
          for (const store of plan.stores) volumes.delete(store.name);
        }
        return { kind: "destroyed" as const };
      }),
  };

  return { provider, hooks };
};

describe("runProviderStartRetentionContract", () => {
  test("exports a runnable Effect contract helper", () => {
    const { provider, hooks } = makeRetentionDouble();
    expect(Effect.isEffect(runProviderStartRetentionContract(provider, hooks))).toBe(true);
  });

  test("passes against a retaining in-memory provider double", async () => {
    const { provider, hooks } = makeRetentionDouble();
    await Effect.runPromise(runProviderStartRetentionContract(provider, hooks));
  });

  test("rejects a double that drops containers after start failure", async () => {
    const { provider, hooks } = makeRetentionDouble();
    const wiping: RuntimeProviderShape = {
      ...provider,
      inspect: (target) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId: testProviderId,
          status: "stopped",
        }),
    };
    const wipingHooks: ProviderStartRetentionHooks = {
      ...hooks,
      hasNetwork: () => false,
      hasVolume: () => false,
    };
    const exit = await Effect.runPromiseExit(runProviderStartRetentionContract(wiping, wipingHooks));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const reason = exit.cause.reasons[0];
    expect(reason !== undefined && Cause.isFailReason(reason)).toBe(true);
    if (reason === undefined || !Cause.isFailReason(reason)) return;
    expect(reason.error).toBeInstanceOf(ContractFailure);
  });
});
