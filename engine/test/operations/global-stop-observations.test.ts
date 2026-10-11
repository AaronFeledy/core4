import { expect, test } from "bun:test";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  executeGlobalStopSelection,
  resolveGlobalStopSelection,
} from "../../src/operations/global-teardown.ts";
import { type Resolved, harness, plan } from "./global-stop-selection-fixture.ts";

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
    // Then only the exact owned observation is removed, leaving foreign and sibling IDs intact.
    expect(h.removed).toEqual([selected]);
    expect(h.observed()).toEqual([...source.filter((service) => service !== selected), foreign]);
  });
}

test("a container disappearing after observation produces an unchanged removal receipt", async () => {
  // Given the provider will report the selected observation already absent.
  const h = harness({ race: true });
  // When the observed selected container is removed.
  const receipt = await h.run(["mail"]);
  // Then no removal is claimed and the selected route is withdrawn without restoring stopped routes.
  expect(receipt).toEqual({ changed: false, services: [] });
  expect(h.removed).toEqual([]);
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
    ),
  );
  // Then container removal succeeds without touching the router.
  expect(receipt).toEqual({ changed: true, services: ["mail"] });
});

test("selected teardown retains routes only for active unselected containers", async () => {
  // Given an exited sibling still exists in applied runtime observations.
  const h = harness();
  h.states.set("sibling", "exited");
  // When an active service is removed.
  await h.run(["mail"]);
  // Then the exited sibling container survives, but its route is not restored.
  expect(h.observed().map((service) => service.containerId)).toEqual([
    "database-container",
    "sibling-container",
  ]);
  expect(h.published).toEqual([["database"]]);
});
