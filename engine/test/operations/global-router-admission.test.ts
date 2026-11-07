import { expect, test } from "bun:test";
import { Effect, Layer, Ref, Schema } from "effect";

import { ServiceName, ServicePlan } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";

import {
  type GlobalRouterStartupPlan,
  recordGlobalRouterStartupPlan,
  revalidateAppliedGlobalRouterStartup,
  withGlobalRouterStartupPlanObserver,
} from "../../src/global-app/router-admission.ts";

const routerPlan = (name: string): GlobalRouterStartupPlan => ({
  services: {
    [ServiceName.make(name)]: Schema.decodeUnknownSync(ServicePlan)({
      name,
      type: "lando",
      provider: "lando",
      primary: false,
      artifact: { kind: "ref", ref: "router-admission:test" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: { resolvedAt: "2026-10-31T00:00:00Z", source: "test", runtime: 4 },
      extensions: {},
    }),
  },
});

for (const name of [undefined, "mailpit"] as const) {
  test(`router outside the applied selection (${name ?? "no plan"}) skips startup revalidation`, async () => {
    const calls: string[] = [];
    const router = {
      ...makeTestRouterService(),
      id: "traefik",
      status: Effect.sync(() => {
        calls.push("status");
        return { state: "stopped" as const, authorities: [], configuredApps: [] };
      }),
      revalidateStartup: Effect.die("unapplied router must not be probed"),
    };
    await Effect.runPromise(
      revalidateAppliedGlobalRouterStartup(name === undefined ? undefined : routerPlan(name)).pipe(
        Effect.provide(Layer.succeed(RouterService, router)),
      ),
    );
    expect(calls).toEqual(["status"]);
  });
}

test("the applied router is observed once even if later readiness fails", async () => {
  const calls: string[] = [];
  const router = {
    ...makeTestRouterService(),
    id: "traefik",
    revalidateStartup: Effect.sync(() => {
      calls.push("revalidate");
    }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const captured = yield* Ref.make<GlobalRouterStartupPlan | undefined>(undefined);
      yield* withGlobalRouterStartupPlanObserver(
        recordGlobalRouterStartupPlan(routerPlan("traefik")),
        (plan) => Ref.set(captured, plan),
      );
      yield* revalidateAppliedGlobalRouterStartup(yield* Ref.get(captured));
    }).pipe(Effect.provide(Layer.succeed(RouterService, router))),
  );
  expect(calls).toEqual(["revalidate"]);
});
