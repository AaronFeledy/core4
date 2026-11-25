import { expect, test } from "bun:test";
import { AbsolutePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  executeGlobalStopSelection,
  resolveGlobalStopSelection,
} from "../../src/operations/global-teardown.ts";
import { type Resolved, harness, plan } from "./global-stop-selection-fixture.ts";

test("selected teardown preserves a foreign-labeled planned container and its siblings", async () => {
  // Given normal listing synthesizes the planned root, while discovery exposes the actual labels.
  const observations = harness()
    .observed()
    .map((service) =>
      String(service.service) === "mail"
        ? { ...service, appRoot: AbsolutePath.make("/tmp/foreign-global") }
        : service,
    );
  const h = harness({ observations });
  h.resolved.provider = {
    ...h.resolved.provider,
    list: (filter) =>
      Effect.sync(() =>
        h
          .observed()
          .map((service) =>
            filter.includeUnplanned === true ? service : { ...service, appRoot: plan.root },
          ),
      ),
  };
  // When the foreign-labeled service is selected for teardown.
  await h.run(["mail"]);
  // Then no container is stopped, including the selected foreign ID and unselected siblings.
  expect(h.stopped).toEqual([]);
  expect(h.removed).toEqual([]);
  expect(h.observed()).toEqual(observations);
});

for (const mismatch of ["root", "provider"] as const) {
  test(`selected teardown excludes same-app observations with mismatched ${mismatch}`, async () => {
    // Given both an owned selected container and a same-name foreign observation.
    const source = harness().observed();
    const selected = source.find((service) => String(service.service) === "mail");
    if (selected === undefined) throw new Error("fixture requires mail");
    const foreign = {
      ...selected,
      containerId: "foreign-mail",
      ...(mismatch === "root"
        ? { appRoot: AbsolutePath.make("/tmp/foreign-global") }
        : { providerId: ProviderId.make("docker") }),
    };
    const h = harness({ observations: [...source, foreign] });
    // When mail is selected for teardown.
    await h.run(["mail"]);
    // Then only the exact owned observation is stopped, and every container is kept.
    expect(h.stopped).toEqual([selected]);
    expect(h.removed).toEqual([]);
    expect(h.observed()).toEqual([...source, foreign]);
  });
}

test("a container disappearing after observation produces an unchanged stop receipt", async () => {
  // Given the provider will report the selected observation already absent.
  const h = harness({ race: true });
  // When the observed selected container is stopped.
  const receipt = await h.run(["mail"]);
  // Then no stop is claimed and the selected route is withdrawn without restoring stopped routes.
  expect(receipt).toEqual({
    changed: false,
    services: [],
    containers: [{ service: ServiceName.make("mail"), action: "absent" }],
  });
  expect(h.stopped).toEqual([]);
  expect(h.published).toEqual([["database", "sibling"]]);
});

test("stopping a service without authored routes leaves sibling route publication untouched", async () => {
  // Given a selected container whose applied plan has routes only for siblings.
  const h = harness();
  const resolved: Resolved = {
    ...h.resolved,
    evidence: {
      kind: "applied",
      plan: { ...plan, routes: plan.routes.filter((route) => String(route.service) !== "mail") },
    },
  };
  // When the non-routed service is selected.
  const receipt = await Effect.runPromise(
    Effect.gen(function* () {
      const selection = yield* resolveGlobalStopSelection(resolved, ["mail"]);
      return yield* executeGlobalStopSelection(resolved, selection);
    }).pipe(
      Effect.provideService(RouterService, {
        ...makeTestRouterService(),
        setup: () => Effect.die("selected stop must not set up routes"),
        applyRoutes: () => Effect.die("non-routed selection must not rewrite sibling routes"),
      }),
      Effect.provide(h.layer),
    ),
  );
  // Then the container stops without touching the router.
  expect(receipt).toEqual({
    changed: true,
    services: ["mail"],
    containers: [{ service: ServiceName.make("mail"), containerId: "mail-container", action: "stopped" }],
  });
});

test("selected teardown retains routes only for active unselected containers", async () => {
  // Given an exited sibling still exists in applied runtime observations.
  const h = harness();
  h.states.set("sibling", "exited");
  // When an active service is stopped.
  await h.run(["mail"]);
  // Then every container survives, but the exited sibling's route is not restored.
  expect(h.observed().map((service) => service.containerId)).toEqual([
    "mail-container",
    "database-container",
    "sibling-container",
  ]);
  expect(h.published).toEqual([["database"]]);
});
