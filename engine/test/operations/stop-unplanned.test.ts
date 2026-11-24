import { expect, test } from "bun:test";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

const row = (
  service: string,
  status: ServiceRuntimeInfo["status"],
  appRoot: AbsolutePath = plan.root,
): ServiceRuntimeInfo => ({
  app: plan.id,
  appRoot,
  service: ServiceName.make(service),
  providerId: plan.provider,
  containerId: `cid-${service}`,
  status,
  publications: { status: "unknown" },
});

// The planned web container, a running leftover of a dropped service, an exited leftover, and a
// running container of the same app id recorded at another root.
const observed = [
  row("web", "running"),
  row("legacy", "running"),
  row("retired", "exited"),
  row("elsewhere", "running", AbsolutePath.make(`${plan.root}-other`)),
];

const harnessFor = (stopped: string[]) =>
  makeHarness({
    resolveAppliedPlan: () => Effect.succeed(plan),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "applied", plan }),
    providerOverrides: { list: () => Effect.succeed(observed) },
    onStop: (container) => stopped.push(String(container.service)),
  });

test("whole-app stop also stops a running owned container the plan does not name", async () => {
  // Given
  const stopped: string[] = [];
  const harness = harnessFor(stopped);
  // When
  const result = await Effect.runPromise(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
  // Then only the running owned leftover was stopped by identity, beside the planful stop of web.
  expect(stopped).toEqual(["legacy"]);
  expect(result.servicesStopped).toEqual(["web", "legacy"]);
  expect(result.containers).toEqual([
    { service: ServiceName.make("web"), containerId: "cid-web", action: "stopped" },
    { service: ServiceName.make("legacy"), containerId: "cid-legacy", action: "stopped" },
  ]);
});

test("selected stop never reaches containers outside the selection", async () => {
  // Given
  const stopped: string[] = [];
  const harness = harnessFor(stopped);
  // When
  const result = await Effect.runPromise(
    stopAppForTarget({ services: [ServiceName.make("web")] }, target).pipe(Effect.provide(harness.layer)),
  );
  // Then
  expect(stopped).toEqual(["web"]);
  expect(result.servicesStopped).toEqual(["web"]);
});
