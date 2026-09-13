import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { AppId, AppPlan } from "@lando/sdk/schema";
import { ContractFailure, TestUrlScanner, makeTestUrlScanner, runScannerContract } from "@lando/sdk/test";

describe("UrlScanner contract", () => {
  test("records options when a plan is passed to scan", async () => {
    // Given a scanner and an app plan.
    const scanner = makeTestUrlScanner();
    const appId = AppId.make("myapp");
    const plan = Schema.decodeUnknownSync(AppPlan)({
      id: appId,
      name: "myapp",
      slug: "myapp",
      root: "/app",
      provider: "docker",
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: { resolvedAt: "2026-06-14T00:00:00.000Z", source: ".lando.yml", runtime: 4 },
    });
    const options = { plan };
    // When scanning with that plan.
    await Effect.runPromise(scanner.scan(appId, options));
    // Then record the options alongside the app id.
    expect(scanner.calls).toEqual([{ op: "scan", appId, options }]);
  });

  test("TestUrlScanner satisfies runScannerContract", async () => {
    const exit = await Effect.runPromiseExit(runScannerContract(TestUrlScanner));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestUrlScanner has the expected id", () => {
    expect(TestUrlScanner.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestUrlScanner records scan calls", async () => {
    const scanner = makeTestUrlScanner();
    const appId = AppId.make("myapp");

    await Effect.runPromise(scanner.scan(appId));

    expect(scanner.calls).toHaveLength(1);
    expect(scanner.calls[0]?.op).toBe("scan");
  });

  test("makeTestUrlScanner detectCollisions returns empty array by default", async () => {
    const scanner = makeTestUrlScanner();
    const result = await Effect.runPromise(
      scanner.detectCollisions([AppId.make("app1"), AppId.make("app2")]),
    );
    expect(result).toHaveLength(0);
  });
});
