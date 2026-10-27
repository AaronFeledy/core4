import { expect, test } from "bun:test";
import { Effect } from "effect";

import { type AppPlan, ServiceName } from "@lando/sdk/schema";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("scoped rebuild passes resolved service secrets only through transient provider options", async () => {
  const secretPlan: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        environment: { PLAIN: "visible", TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" } },
      },
    },
  };
  let applied: { readonly plan: AppPlan; readonly environment: unknown } | undefined;
  const harness = makeHarness({
    plannedApp: secretPlan,
    secretStore: {
      id: "test",
      get: () => Effect.succeed("resolved-canary"),
      has: () => Effect.succeed(true),
      list: Effect.succeed(["API_TOKEN"]),
    },
    onApply: (appliedPlan, options) =>
      Effect.gen(function* () {
        const resolve = options?.resolveServiceEnvironment;
        if (resolve === undefined) throw new Error("creation resolver missing");
        const entries = yield* Effect.forEach(Object.values(appliedPlan.services), (service) =>
          resolve(service).pipe(Effect.map((env) => [service.name, env] as const)),
        );
        applied = { plan: appliedPlan, environment: Object.fromEntries(entries) };
      }),
  });

  await Effect.runPromise(
    rebuildApp(
      { services: [ServiceName.make("web")] },
      {
        plan: secretPlan,
        root: secretPlan.root,
        app: { kind: "user", id: secretPlan.id, root: secretPlan.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );

  expect(applied?.environment).toMatchObject({ web: { PLAIN: "visible", TOKEN: "resolved-canary" } });
  expect(applied?.plan.services[web.name]?.environment).toEqual({
    PLAIN: "visible",
    TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" },
  });
  expect(JSON.stringify(applied?.plan)).not.toContain("resolved-canary");
});
