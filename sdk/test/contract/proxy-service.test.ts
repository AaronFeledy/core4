import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";
import {
  ContractFailure,
  TestProxyService,
  makeTestProxyService,
  runProxyServiceContract,
} from "@lando/sdk/test";

describe("ProxyService contract", () => {
  test("TestProxyService satisfies runProxyServiceContract", async () => {
    const exit = await Effect.runPromiseExit(runProxyServiceContract(TestProxyService));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestProxyService has the expected id", () => {
    expect(TestProxyService.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestProxyService tracks applyRoutes and removeRoutes by appId", async () => {
    const proxy = makeTestProxyService();
    const appId = AppId.make("myapp");
    const routes = [
      { hostname: "web.myapp.lndo.site", scheme: "https" as const, service: ServiceName.make("web") },
    ];

    await Effect.runPromise(proxy.applyRoutes(routes, appId));
    expect(proxy.routesByApp.get("myapp")).toHaveLength(1);

    await Effect.runPromise(proxy.removeRoutes(appId));
    expect(proxy.routesByApp.get("myapp")).toBeUndefined();
  });

  test("makeTestProxyService setup resolves", async () => {
    const proxy = makeTestProxyService();
    await expect(Effect.runPromise(proxy.setup())).resolves.toBeUndefined();
  });
});
