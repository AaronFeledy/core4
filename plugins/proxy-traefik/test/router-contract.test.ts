import { expect, test } from "bun:test";
import { runRouterServiceContractSuite } from "@lando/sdk/test";
import { Effect } from "effect";
import { makeHarness } from "./proxy-tls-harness.ts";

test("satisfies the SDK router contract including read-only observation", async () => {
  const { service } = makeHarness();
  const result = await Effect.runPromise(
    runRouterServiceContractSuite({
      service,
      readRoutes: service.readAppliedRoutes,
    }),
  );
  expect(result).toBeUndefined();
});
