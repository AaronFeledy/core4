import { expect, test } from "bun:test";
import { PortNumber } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { infoForPlan } from "../../src/operations/info.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test("projects optional listenerAuthority onto service info", async () => {
  const authority = {
    owner: "launcher" as const,
    daemon: "web",
    port: PortNumber.make(3000),
    setting: "--port 3000",
  };
  const withAuthority = {
    ...plan,
    services: { [web.name]: { ...web, listenerAuthority: authority } },
  };
  const provider = makeTestRuntimeProvider();
  await Effect.runPromise(Effect.scoped(provider.apply(withAuthority, { reconcile: true })));
  const result = await Effect.runPromise(
    infoForPlan(withAuthority).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([withAuthority.provider]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
    ),
  );
  expect(result.services[0]?.listenerAuthority).toEqual(authority);
});
