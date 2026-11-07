import { expect, test } from "bun:test";
import {
  type HealthcheckPlan,
  ServiceInfo,
  ServiceInfoConsistent,
  ServiceName,
  type ServicePlan,
  type ServiceRunObservation,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { projectServiceObservation } from "../../src/operations/info-probes.ts";
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
  run: ServiceRunObservation = { status: "running" },
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
          publications: { status: "unknown" as const },
          ...run,
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
    { status: "running", health: "healthy" },
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
    { status: "running", health: "healthy" },
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
    { status: "running", health: "healthy" },
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

test.each([
  [{ status: "running" }, "running"],
  [{ status: "exited", exitCode: 1 }, "stopped"],
  [{ status: "absent" }, "stopped"],
] as const)("%j without probe policy is not readiness evidence", async (run, status) => {
  // Given / When
  const { result } = await observe([web], run);
  // Then
  expect(result.services[0]?.status).toBe(status);
  expect(result.services[0]?.health?.state).toBe("unknown");
  expect(result.services[0]?.readiness).toEqual({ state: "not-configured", source: "none" });
});

test("an observed inherited image check is not a configured readiness command", async () => {
  // Given / When
  const { result } = await observe([web], { status: "running", health: "healthy" });
  // Then
  expect(result.services[0]?.health).toEqual({ state: "healthy" });
  expect(result.services[0]?.readiness).toEqual({ state: "not-configured", source: "none" });
});

test.each([
  { status: "running", health: "healthy" },
  { status: "running", health: "starting" },
  { status: "running", health: "unhealthy" },
  { status: "running" },
  { status: "paused" },
  { status: "restarting" },
  { status: "exited", exitCode: 1 },
  { status: "dead" },
  { status: "created" },
  { status: "removing" },
  { status: "absent" },
  { status: "unknown" },
] as const satisfies ReadonlyArray<ServiceRunObservation>)(
  "projects status and health.state of one %j observation consistently",
  async (run) => {
    // Given / When
    const { result } = await observe([web], run);
    // Then a native health verdict only ever sits beside a live status.
    const service = result.services[0];
    expect(Schema.decodeUnknownResult(ServiceInfoConsistent)(service)._tag).toBe("Success");
    expect(service?.health?.state).toBe(run.status === "running" ? (run.health ?? "unknown") : "unknown");
  },
);

test("info projection uses the current observation instead of a contradictory prior state", () => {
  const projected = projectServiceObservation(web, {
    name: "web",
    state: "completed",
    runtime: {
      app: plan.id,
      service: web.name,
      providerId: plan.provider,
      status: "running",
      health: "unhealthy",
      publications: { status: "unknown" },
    },
  });
  expect(projected.status).toBe("running");
  expect(projected.health?.state).toBe("unhealthy");
});
