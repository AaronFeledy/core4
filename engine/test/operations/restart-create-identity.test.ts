import { expect, test } from "bun:test";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
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
const desired: AppPlan = { ...plan, services: { [web.name]: declared } };
const realized = serviceWithArtifact(declared, {
  providerId: plan.provider,
  ref: "lando-build-lando-web-fixture",
  digest: "sha256:built-fixture",
});
const applied: AppPlan = { ...desired, services: { [web.name]: realized } };

const runRestart = (service: ServicePlan) => {
  const mutations: string[] = [];
  const current = { ...desired, services: { [web.name]: service } };
  const harness = makeHarness({
    plannedApp: current,
    inspect: () =>
      Effect.succeed({
        app: applied.id,
        service: web.name,
        providerId: applied.provider,
        status: "running",
        state: "running",
        containerId: "retained-container",
        labels: commonContainerLabels(applied, realized),
        endpoints: [],
      }),
    onStop: () => {
      mutations.push("stop");
    },
    onApply: () => {
      mutations.push("apply");
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
      resolveAppliedPlan: () => Effect.succeed(applied),
    }),
    Effect.provide(harness.layer),
  );
  return { operation, mutations };
};

test("selected restart retains a built container with unchanged descriptor intent and unavailable store", async () => {
  // Given a container created from a derived artifact, not the authored base ref.
  const restart = runRestart(declared);
  // When restarting only that service.
  await Effect.runPromise(restart.operation);
  // Then it restarts in place without consulting the secret store.
  expect(restart.mutations).toEqual(["stop", "apply"]);
});

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
