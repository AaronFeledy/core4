import { expect, test } from "bun:test";
import type { EngineHttpApi, EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import { bringUp } from "@lando/container-runtime/podman/bring-up";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { restartApp } from "../../src/operations/restart.ts";
import { serviceWithArtifact } from "../../src/services/build-artifact-runner.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const declared: ServicePlan = {
  ...web,
  artifact: { kind: "ref", ref: "postgres:17" },
  environment: { PASSWORD: { _tag: "SecretRef", reference: "AUTHORING_DB" } },
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [{ id: "scaffold", phase: "build", command: ["mkdir", "-p", "/etc/lando"] }],
    },
  },
};
const sibling = { ...web, name: ServiceName.make("worker") };
const desired: AppPlan = { ...plan, services: { [web.name]: declared, [sibling.name]: sibling } };
const realized = serviceWithArtifact(declared, {
  providerId: plan.provider,
  ref: "lando-build-lando-web-fixture",
  digest: "sha256:built-fixture",
});
const applied: AppPlan = { ...desired, services: { ...desired.services, [web.name]: realized } };

const runRestart = (service: ServicePlan, recorded = applied, driftAtStop = false) => {
  const mutations: string[] = [];
  const requests: EngineHttpRequest[] = [];
  const inspections: (AppPlan | undefined)[] = [];
  let running = true;
  let labels = commonContainerLabels(applied, realized);
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.path.startsWith("/networks/")) return { status: 200, body: "{}" };
        if (request.method === "GET" && request.path.endsWith("/json")) {
          return {
            status: 200,
            body: JSON.stringify({
              Id: "retained-container",
              Config: { Labels: labels },
              State: { Running: running },
            }),
          };
        }
        if (request.path.endsWith("/start")) running = true;
        return { status: 204, body: "" };
      }),
  };
  const current = { ...desired, services: { ...desired.services, [web.name]: service } };
  const harness = makeHarness({
    plannedApp: current,
    inspect: (target) => {
      inspections.push(target.plan);
      return Effect.succeed({
        app: applied.id,
        service: web.name,
        providerId: applied.provider,
        status: "running",
        state: "running",
        containerId: "retained-container",
        labels,
        publications: { status: "present", bindings: [] },
      });
    },
    onStop: () => {
      mutations.push("stop");
      running = false;
      if (driftAtStop) labels = commonContainerLabels(applied, { ...realized, command: ["changed"] });
    },
    apply: (runtimePlan, options) => {
      mutations.push("apply");
      expect(options.forbidRecreate).toBe(true);
      expect(options.recordedPlan).toBe(recorded);
      expect(options.completionPlan).toBe(current);
      expect(Object.keys(runtimePlan.services)).toEqual([web.name]);
      return bringUp(runtimePlan, {
        ...options,
        api,
        ctx: { providerId: "lando", remediation: "Retry." },
        ensureImage: () => Effect.die("restart must not pull"),
        resolveServiceEnvironment: () => Effect.die("restart must not resolve creation values"),
      });
    },
    providerOverrides: {
      buildArtifact: () => Effect.die("restart must not build"),
      pullArtifact: () => Effect.die("restart must not pull"),
    },
    secretStore: {
      id: "unavailable",
      get: () => Effect.die("restart must not resolve creation values"),
      has: () => Effect.die("restart must not consult creation values"),
      list: Effect.die("unused"),
    },
  });
  const operation = restartApp(
    { services: [web.name] },
    { plan: current, root: current.root, app: { kind: "user", id: current.id, root: current.root } },
  ).pipe(
    Effect.provideService(RuntimeProviderRegistry, {
      ...harness.runtimeProviderRegistry,
      resolveAppliedPlan: () => Effect.succeed(recorded),
    }),
    Effect.provideService(BuildOrchestrator, {
      build: () => Effect.die("restart must not build"),
      buildApp: () => Effect.die("restart must not build app"),
    }),
    Effect.provide(harness.layer),
  );
  return { operation, mutations, requests, inspections };
};

test("selected restart retains a built container with unchanged descriptor intent and unavailable store", async () => {
  // Given a container created from a derived artifact, not the authored base ref.
  const restart = runRestart(declared);
  // When restarting only that service.
  await Effect.runPromise(restart.operation);
  // Then it restarts in place without consulting the secret store.
  expect(restart.mutations).toEqual(["stop", "apply"]);
  expect(restart.requests.filter((request) => request.method !== "GET")).toMatchObject([
    { method: "POST", path: expect.stringContaining("/start") },
  ]);
  expect(restart.inspections[0]?.services).toEqual(applied.services);
});

test("selected restart's actual apply guard rejects drift appearing after preflight", async () => {
  // Given matching preflight evidence that changes when the container is stopped.
  const restart = runRestart(declared, applied, true);
  // When actual apply re-inspects the stopped container.
  const error = await Effect.runPromise(Effect.flip(restart.operation));
  // Then the real forbid-recreate guard refuses without a create or start request.
  expect(error).toMatchObject({ _tag: "ServiceRestartWouldRecreateError", reason: "config" });
  expect(restart.mutations).toEqual(["stop", "apply"]);
  expect(restart.requests.every((request) => request.method === "GET")).toBe(true);
});

const { artifact: _artifact, ...withoutArtifact } = declared;

test.each([
  {},
  { [web.name]: withoutArtifact },
  { [web.name]: { ...declared, artifact: { kind: "ref", ref: "" } } },
  { [web.name]: { ...declared, artifact: { kind: "build", context: desired.root } } },
] satisfies readonly AppPlan["services"][])(
  "selected restart refuses unavailable applied artifact %# before stop",
  async (services) => {
    // Given ownership-matched state without a usable applied artifact.
    const restart = runRestart(declared, { ...applied, services });
    // When selected restart attempts projection.
    const error = await Effect.runPromise(Effect.flip(restart.operation));
    // Then no container mutation or provider inspect occurs.
    expect(error).toMatchObject({ _tag: "ProviderUnavailableError", operation: "restart" });
    expect(restart.mutations).toEqual([]);
    expect(restart.inspections).toEqual([]);
  },
);

test.each([
  { ...declared, environment: { PASSWORD: { _tag: "SecretRef", reference: "OTHER_DB" } } },
  { ...declared, command: ["different-command"] },
  { ...declared, artifact: { kind: "ref", ref: "postgres:18" } },
  {
    ...declared,
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [{ id: "scaffold", phase: "build", command: ["mkdir", "-p", "/changed"] }],
      },
    },
  },
] satisfies readonly ServicePlan[])(
  "selected restart refuses changed create intent %# before stopping",
  async (service) => {
    // Given real immutable intent drift from the existing built container.
    const restart = runRestart(service);
    // When selected restart preflights that service.
    const error = await Effect.runPromise(Effect.flip(restart.operation));
    // Then it still refuses recreation before any mutation.
    expect(error).toMatchObject({ _tag: "ServiceRestartWouldRecreateError", reason: "config" });
    expect(restart.mutations).toEqual([]);
  },
);
