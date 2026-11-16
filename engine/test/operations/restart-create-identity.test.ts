import { expect, test } from "bun:test";
import type { EngineHttpApi, EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { networkOwnershipLabels } from "@lando/container-runtime/native-ownership";
import { bringUp } from "@lando/container-runtime/podman/bring-up";
import { inspect } from "@lando/container-runtime/podman/inspect";
import {
  fixtureContainerLabels as commonContainerLabels,
  fixtureHelperOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { ServiceName, landoAppNetworkName, landoSharedNetworkName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { restartApp } from "../../src/operations/restart.ts";
import { serviceWithArtifact } from "../../src/services/build-artifact-runner.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

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
  origin: "build",
});
const applied: AppPlan = { ...desired, services: { ...desired.services, [web.name]: realized } };

const runRestart = (
  options: {
    readonly driftAtStop?: boolean;
    readonly initiallyStopped?: boolean;
    readonly missingContainer?: boolean;
    readonly allowsCreationValues?: boolean;
  } = {},
) => {
  const mutations: string[] = [];
  const secretReads: string[] = [];
  const requests: EngineHttpRequest[] = [];
  const inspections: (AppPlan | undefined)[] = [];
  let running = options.initiallyStopped !== true;
  let exists = options.missingContainer !== true;
  let containerId = "retained-container";
  let labels = options.missingContainer === true ? {} : commonContainerLabels(applied, realized);
  const privateNetworkName = landoAppNetworkName(applied);
  const sharedNetworkName = landoSharedNetworkName(applied);
  if (privateNetworkName === undefined || sharedNetworkName === undefined)
    throw new TypeError("Restart fixture requires private and shared network names.");
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (
          request.method === "GET" &&
          request.path === `/networks/${encodeURIComponent(privateNetworkName)}`
        )
          return {
            status: 200,
            body: JSON.stringify({
              Id: "retained-private-network",
              Name: privateNetworkName,
              Driver: "bridge",
              Labels: networkOwnershipLabels(applied),
            }),
          };
        if (request.method === "GET" && request.path === `/networks/${encodeURIComponent(sharedNetworkName)}`)
          return { status: 200, body: "{}" };
        if (request.path.startsWith("/networks/") || request.path.startsWith("/libpod/networks/"))
          throw new Error(`Unexpected network request: ${request.method} ${request.path}`);
        if (request.method === "GET" && request.path.startsWith("/containers/json"))
          return { status: 200, body: "[]" };
        if (request.method === "GET" && request.path.endsWith("/json")) {
          return exists
            ? {
                status: 200,
                body: JSON.stringify({
                  Id: containerId,
                  Config: { Labels: labels },
                  State: { Running: running },
                  Mounts: [
                    {
                      Type: "volume",
                      Name: "retained-anonymous-data",
                      Destination: "/var/lib/postgresql/data",
                    },
                  ],
                }),
              }
            : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          containerId = "recreated-container";
          exists = true;
          return { status: 201, body: "{}" };
        }
        if (request.path.endsWith("/start")) running = true;
        return { status: 204, body: "" };
      }),
  };
  const harness = makeHarness({
    plannedApp: desired,
    exec: () => Effect.die("Selected restart must not seed a GPG home"),
    inspect: (target) => {
      inspections.push(target.plan);
      return inspect(target.plan ?? desired, target, {
        api,
        ctx: { providerId: "lando", remediation: "Retry.", env: {} },
        ...fixtureHelperOptions,
      });
    },
    onStop: () => {
      mutations.push("stop");
      running = false;
      if (options.driftAtStop === true)
        labels = commonContainerLabels(applied, { ...realized, command: ["changed"] });
    },
    apply: (runtimePlan, runtimeOptions) => {
      mutations.push("apply");
      expect(Object.keys(runtimePlan.services)).toEqual([web.name]);
      return bringUp(runtimePlan, {
        ...fixtureHelperOptions,
        ...runtimeOptions,
        api,
        ctx: { providerId: "lando", remediation: "Retry.", env: {} },
        ensureImage:
          options.allowsCreationValues === true
            ? () => Effect.void
            : () => Effect.die("restart must not pull"),
        resolveServiceEnvironment:
          options.allowsCreationValues === true
            ? () => Effect.succeed({ PASSWORD: "resolved-secret" })
            : () => Effect.die("restart must not resolve creation values"),
      });
    },
    // The artifact build stamps the applied artifact onto the selected service.
    buildResult: (buildPlan) =>
      buildPlan.id !== desired.id
        ? buildPlan
        : { ...buildPlan, services: { ...buildPlan.services, [web.name]: realized } },
    providerOverrides: {
      buildArtifact: () => Effect.die("restart must not build an artifact"),
      pullArtifact: () => Effect.die("restart must not pull"),
    },
    secretStore: {
      id: "recording",
      get: (reference) =>
        Effect.sync(() => {
          secretReads.push(reference);
          return "resolved-secret";
        }),
      has: () => Effect.succeed(true),
      list: Effect.succeed([]),
    },
  });
  const operation = restartApp(
    { services: [web.name] },
    { plan: desired, root: desired.root, app: { kind: "user", id: desired.id, root: desired.root } },
  ).pipe(
    Effect.provideService(RuntimeProviderRegistry, {
      ...harness.runtimeProviderRegistry,
      resolveAppliedPlan: () => Effect.succeed(applied),
    }),
    Effect.provide(harness.layer),
  );
  return { operation, mutations, secretReads, requests, inspections, harness };
};

test("selected restart retains a built container with unchanged descriptor intent", async () => {
  // Given a container created from a derived artifact, not the authored base ref.
  const restart = runRestart();
  // When restarting only that service.
  await Effect.runPromise(restart.operation);
  // Then it restarts in place without consulting creation values or replacing the container.
  expect(restart.mutations).toEqual(["stop", "apply"]);
  expect(restart.requests.filter((request) => request.method !== "GET")).toMatchObject([
    { method: "POST", path: expect.stringContaining("/start") },
  ]);
  expect(restart.inspections[0]?.services).toEqual(applied.services);
  expect(restart.secretReads).toEqual([]);
  expect(byTag(restart.harness.events, "message.info")).toEqual([]);
});

test("selected restart recreates a container whose create intent drifted after preflight", async () => {
  // Given matching preflight evidence that changes when the container is stopped.
  const restart = runRestart({ driftAtStop: true, allowsCreationValues: true });
  // When the apply re-inspects the stopped container.
  await Effect.runPromise(restart.operation);
  // Then it replaces the container and announces the replacement instead of refusing.
  expect(restart.mutations).toEqual(["stop", "apply"]);
  expect(
    restart.requests.some(
      (request) => request.method === "POST" && request.path.startsWith("/containers/create"),
    ),
  ).toBe(true);
  expect(byTag(restart.harness.events, "message.info").map((event) => event.body)).toEqual([
    "Lando replaced web's container instead of restarting it in place. Named volumes were kept.",
  ]);
});

test("selected restart starts a stopped container without resolving creation values", async () => {
  // Given an existing stopped container whose anonymous volume must survive.
  const restart = runRestart({ initiallyStopped: true });
  // When the apply runs.
  await Effect.runPromise(restart.operation);
  // Then its only engine mutation starts the existing container, retaining every mount.
  expect(restart.requests.filter((request) => request.method !== "GET")).toMatchObject([
    { method: "POST", path: expect.stringContaining("/start") },
  ]);
  expect(restart.mutations).toEqual(["stop", "apply"]);
  expect(restart.secretReads).toEqual([]);
  expect(byTag(restart.harness.events, "message.info")).toEqual([]);
});

test("selected restart creates a missing container and announces it", async () => {
  // Given the service lost its container between start and this restart.
  const restart = runRestart({ missingContainer: true, allowsCreationValues: true });
  // When the restart runs.
  await Effect.runPromise(restart.operation);
  // Then it creates the container and announces the creation.
  expect(
    restart.requests.some(
      (request) => request.method === "POST" && request.path.startsWith("/containers/create"),
    ),
  ).toBe(true);
  expect(byTag(restart.harness.events, "message.info").map((event) => event.body)).toEqual([
    "web had no container, so Lando created one.",
  ]);
});
