import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { AppId, ProxyApplyResult, ProxyCapabilities, ProxyStatus, ServiceName } from "@lando/sdk/schema";
import {
  ContractFailure,
  TestProxyService,
  makeProxyServiceContractSuite,
  makeTestProxyService,
  runProxyServiceContractSuite,
} from "@lando/sdk/test";

describe("ProxyService contract", () => {
  test("TestProxyService satisfies the governed contract suite", async () => {
    const exit = await Effect.runPromiseExit(
      runProxyServiceContractSuite({
        service: TestProxyService,
        readRoutes: (app) => TestProxyService.readRoutes(app),
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("make and run contract-suite exports are aliases", () => {
    expect(makeProxyServiceContractSuite).toBe(runProxyServiceContractSuite);
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
      {
        hostname: "web.myapp.lndo.site",
        scheme: "https" as const,
        service: ServiceName.make("web"),
        backend: { service: ServiceName.make("web"), protocol: "https" as const, port: 9443 },
      },
    ];

    const result = await Effect.runPromise(proxy.applyRoutes(routes, appId));
    expect(proxy.routesByApp.get("myapp")).toHaveLength(1);
    expect(Schema.is(ProxyApplyResult)(result)).toBe(true);

    await Effect.runPromise(proxy.removeRoutes(appId));
    expect(proxy.routesByApp.get("myapp")).toBeUndefined();
  });

  test("makeTestProxyService setup resolves", async () => {
    const proxy = makeTestProxyService();
    await expect(
      Effect.runPromise(Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" }))),
    ).resolves.toBeUndefined();
    expect(Schema.is(ProxyCapabilities)(proxy.capabilities)).toBe(true);
  });

  test("makeTestProxyService status and stop are schema-backed", async () => {
    const proxy = makeTestProxyService();
    const status = await Effect.runPromise(proxy.status);
    expect(Schema.is(ProxyStatus)(status)).toBe(true);
    await Effect.runPromise(proxy.stop);
  });
});
