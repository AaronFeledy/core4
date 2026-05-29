import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId } from "@lando/sdk/schema";
import { ContractFailure, TestUrlScanner, makeTestUrlScanner, runScannerContract } from "@lando/sdk/test";

describe("UrlScanner contract", () => {
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
