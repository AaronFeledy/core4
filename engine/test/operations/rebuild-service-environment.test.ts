import { expect, test } from "bun:test";
import { Effect } from "effect";

import { type AppPlan, ServiceName } from "@lando/sdk/schema";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("scoped rebuild passes resolved service secrets only through transient provider options", async () => {
  const secretPlan: AppPlan = {
    ...plan,
    services: {
      [web.name]: { ...web, environment: { TOKEN: "${secret:API_TOKEN}" } },
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
    onApply: (appliedPlan, options) => {
      applied = { plan: appliedPlan, environment: options?.serviceEnvironment };
    },
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

  expect(applied?.environment).toEqual({ web: { TOKEN: "resolved-canary" } });
  expect(applied?.plan.services[web.name]?.environment).toEqual({ TOKEN: "${secret:API_TOKEN}" });
  expect(JSON.stringify(applied?.plan)).not.toContain("resolved-canary");
});
