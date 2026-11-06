import { expect, test } from "bun:test";
import { type HealthcheckPlan, ServiceInfo, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { infoForPlan } from "../../src/operations/info.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const probe: HealthcheckPlan = {
  kind: "command",
  command: ["probe-canary-secret", "literal argument"],
  intervalSeconds: 2,
  timeoutSeconds: 3,
  retries: 4,
};

const observe = async (
  services: readonly ServicePlan[],
  health?: ServiceRuntimeInfo["health"],
  status = "running",
) => {
  const planned = {
    ...plan,
    services: Object.fromEntries(services.map((service) => [service.name, service])),
    routes: [],
  };
  let inspections = 0;
  let executions = 0;
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
      Effect.sync(() => {
        inspections++;
        return {
          app: planned.id,
          service: target.service,
          providerId: planned.provider,
          status,
          publications: { status: "unknown" as const },
          ...(health === undefined ? {} : { health }),
        };
      }),
    exec: () => {
      executions++;
      return Effect.die(new TypeError("Info must not execute a probe"));
    },
  };
  const result = await Effect.runPromise(
    infoForPlan(planned).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([planned.provider]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
    ),
  );
  return { result, inspections, executions };
};

test("native healthy never becomes readiness proof and commands stay private", async () => {
  // Given / When
  const { result } = await observe(
    [
      {
        ...web,
        healthcheck: probe,
        readiness: { ...probe, executionTarget: "host" },
        readinessSource: "authored",
      },
    ],
    "healthy",
  );
  // Then
  expect(result.services[0]?.health?.state).toBe("healthy");
  expect(result.services[0]?.readiness).toMatchObject({
    state: "not-observed",
    source: "authored",
    check: {
      target: "host",
      userSource: "cli",
      commandConfigured: true,
      configPath: ["services", "web", "readiness"],
      intervalSeconds: 2,
      timeoutSeconds: 3,
      retries: 4,
    },
  });
  expect(JSON.stringify(result)).not.toContain("probe-canary-secret");
  for (const service of result.services)
    expect(Schema.decodeUnknownSync(ServiceInfo)(Schema.encodeSync(ServiceInfo)(service))).toEqual(service);
});

test("probe inspection reuses one observation per service without execution", async () => {
  // Given / When
  const { inspections, executions } = await observe(
    [
      { ...web, healthcheck: probe },
      { ...web, name: ServiceName.make("other"), readiness: probe },
    ],
    "healthy",
  );
  // Then
  expect(inspections).toBe(2);
  expect(executions).toBe(0);
});

test("native disabling does not hide contributed readiness or its listener", async () => {
  // Given / When
  const { result } = await observe([
    {
      ...web,
      user: "1000",
      healthcheck: { ...probe, kind: "none" },
      readiness: { ...probe, target: { port: 3000, transport: "tcp", names: [], primary: false } },
      readinessSource: "contributed",
    },
  ]);
  // Then
  expect(result.services[0]?.health?.state).toBe("not-monitored");
  expect(result.services[0]?.readiness).toMatchObject({
    state: "not-observed",
    source: "contributed",
    check: {
      target: "service",
      user: "1000",
      userSource: "service",
      listener: { port: 3000, transport: "tcp" },
    },
  });
});

test("explicit readiness disabling blocks healthy fallback", async () => {
  // Given / When
  const { result } = await observe(
    [{ ...web, healthcheck: probe, readiness: { ...probe, kind: "none" }, readinessSource: "authored" }],
    "healthy",
  );
  // Then
  expect(result.services[0]?.readiness).toMatchObject({
    state: "disabled",
    source: "authored",
    check: { commandConfigured: false },
  });
});

test("unmarked historical readiness has unknown provenance", async () => {
  // Given / When
  const { result } = await observe([{ ...web, readiness: probe }]);
  // Then
  expect(result.services[0]?.readiness).toMatchObject({ state: "not-observed", source: "unknown" });
});

test("native fallback identifies its actual configuration pointer", async () => {
  // Given / When
  const { result } = await observe([{ ...web, healthcheck: probe }]);
  // Then
  expect(result.services[0]?.readiness).toMatchObject({
    state: "not-observed",
    source: "healthcheck",
    check: { configPath: ["services", "web", "healthcheck"], userSource: "image" },
  });
});

test.each(["running", "stopped"])("%s without probe policy is not readiness evidence", async (status) => {
  // Given / When
  const { result } = await observe([web], undefined, status);
  // Then
  expect(result.services[0]?.status).toBe(status);
  expect(result.services[0]?.health?.state).toBe("unknown");
  expect(result.services[0]?.readiness).toEqual({ state: "not-configured", source: "none" });
});

test("an observed inherited image check is not a configured readiness command", async () => {
  // Given / When
  const { result } = await observe([web], "healthy");
  // Then
  expect(result.services[0]?.health).toEqual({ state: "healthy" });
  expect(result.services[0]?.readiness).toEqual({ state: "not-configured", source: "none" });
});
