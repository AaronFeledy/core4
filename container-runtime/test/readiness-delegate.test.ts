import { expect, test } from "bun:test";
import { ServiceExecError } from "@lando/sdk/errors";
import { AppPlan, type HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Result, Schema, Stream } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { ownedNetworkInspection } from "./network-inspection-fixture.ts";

const probe = {
  kind: "command",
  command: ["ready", "$HOME", ""],
  intervalSeconds: 0,
  timeoutSeconds: 1,
  retries: 0,
} as const;
const ctx = { providerId: "test", remediation: "retry", env: {} };
const planWith = (readiness: HealthcheckPlan) =>
  Schema.decodeUnknownSync(AppPlan)({
    id: "readiness-delegate",
    name: "readiness-delegate",
    slug: "readiness-delegate",
    provider: "test",
    root: "/tmp/readiness-delegate",
    valueModel: 1,
    services: Object.fromEntries(
      ["db", "web"].map((name) => [
        name,
        {
          name,
          type: "test",
          provider: "test",
          primary: name === "web",
          artifact: { kind: "ref", ref: "test" },
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          hostAliases: [],
          extensions: {},
          dependsOn: name === "web" ? [{ service: "db", condition: "service_healthy", required: true }] : [],
          ...(name === "db" ? { healthcheck: probe, readiness } : {}),
          metadata: { source: "test", runtime: 4, resolvedAt: "2026-10-01T00:00:00Z" },
        },
      ]),
    ),
    stores: [],
    routes: [],
    fileSync: [],
    extensions: {},
    metadata: { source: "test", runtime: 4, resolvedAt: "2026-10-01T00:00:00Z" },
  });

const fixture = (plan: AppPlan) => {
  const requests: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.path.startsWith("/networks/"))
          return {
            status: 200,
            body: JSON.stringify(
              ownedNetworkInspection(plan, decodeURIComponent(request.path.slice("/networks/".length))),
            ),
          };
        if (request.path.startsWith("/exec/")) return { status: 200, body: '{"ExitCode":0}' };
        if (request.path.endsWith("/exec")) return { status: 201, body: '{"Id":"readiness-exec"}' };
        const service = Object.values(plan.services).find((service) =>
          request.path.endsWith(`-${service.name}/json`),
        );
        if (service !== undefined)
          return {
            status: 200,
            body: JSON.stringify({
              Id: `native-${service.name}`,
              State: { Running: true },
              Config: { Labels: commonContainerLabels(plan, service) },
            }),
          };
        return { status: 204, body: "" };
      }),
    stream: () => Stream.empty,
  };
  return { api, requests };
};

test.each(["host", "service"] as const)(
  "provider uses the engine delegate for %s dependency attempts",
  async (executionTarget) => {
    // Given
    const readiness = { ...probe, executionTarget };
    const plan = planWith(readiness);
    const { api, requests } = fixture(plan);
    const attempts: unknown[] = [];
    // When
    await Effect.runPromise(
      bringUp(plan, {
        api,
        ctx,
        executeReadinessAttempt: (service, probe) =>
          Effect.sync(() => {
            attempts.push({ service, probe });
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    );
    // Then
    expect(attempts).toEqual([{ service: ServiceName.make("db"), probe: readiness }]);
    expect(requests.filter((request) => request.path.endsWith("/exec"))).toEqual([]);
  },
);

test("direct provider rejects host readiness before any API action", async () => {
  // Given
  const plan = planWith({ ...probe, executionTarget: "host" });
  const { api, requests } = fixture(plan);
  // When
  const result = await Effect.runPromise(Effect.result(bringUp(plan, { api, ctx })));
  // Then
  expect(requests).toEqual([]);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
});

test.each([true, false])(
  "disabled readiness cannot relax explicit healthy dependencies before apply (required=%s)",
  async (required) => {
    // Given
    const original = planWith({ ...probe, kind: "none" });
    const web = original.services[ServiceName.make("web")];
    if (web === undefined) throw new TypeError("Missing fixture service");
    const plan = {
      ...original,
      services: {
        ...original.services,
        web: {
          ...web,
          dependsOn: [{ service: ServiceName.make("db"), condition: "service_healthy" as const, required }],
        },
      },
    };
    const { api, requests } = fixture(plan);
    // When
    const result = await Effect.runPromise(Effect.result(bringUp(plan, { api, ctx })));
    // Then
    expect(requests).toEqual([]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("ProviderConfigError");
  },
);

test("direct service fallback uses exact probe user and unwrapped argv", async () => {
  // Given
  const plan = planWith({ ...probe, user: "1001:1002" });
  const { api, requests } = fixture(plan);
  // When
  await Effect.runPromise(bringUp(plan, { api, ctx }));
  // Then
  expect(requests.filter((request) => request.path.endsWith("/exec")).map((request) => request.body)).toEqual(
    [expect.objectContaining({ User: "1001:1002", Cmd: ["ready", "$HOME", ""] })],
  );
});

test("failed dependency retains bounded redacted infrastructure diagnostics", async () => {
  // Given
  const plan = planWith(probe);
  const { api } = fixture(plan);
  const secret = "delegate-failure-private-secret";
  // When
  const result = await Effect.runPromise(
    Effect.result(
      bringUp(plan, {
        api,
        ctx: { ...ctx, env: { PRIVATE_TOKEN: secret } },
        executeReadinessAttempt: () =>
          Effect.fail(
            new ServiceExecError({
              providerId: "test",
              service: "db",
              operation: "readiness",
              message: `runner unavailable ${secret} ${"x".repeat(3000)}`,
              remediation: "retry",
            }),
          ),
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("ServiceStartError");
    const serialized = JSON.stringify(result.failure);
    expect(serialized).toContain("runner unavailable");
    expect(serialized).not.toContain(secret);
    expect(serialized.length).toBeLessThan(4000);
  }
});
