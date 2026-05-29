import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  ContractFailure,
  TestHostProxyService,
  makeTestHostProxyService,
  runHostProxyContract,
} from "@lando/sdk/test";

describe("HostProxyService contract", () => {
  test("TestHostProxyService satisfies runHostProxyContract", async () => {
    const exit = await Effect.runPromiseExit(runHostProxyContract(TestHostProxyService));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestHostProxyService has the expected id", () => {
    expect(TestHostProxyService.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestHostProxyService records setup calls and reflects mode in status", async () => {
    const service = makeTestHostProxyService();

    await Effect.runPromise(service.setup({ mode: "auto" }));

    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]?.op).toBe("setup");

    const status = await Effect.runPromise(service.status());
    expect(status.active).toBe(true);
    expect(status.mode).toBe("auto");
  });

  test("makeTestHostProxyService respects mode=none opt-out", async () => {
    const service = makeTestHostProxyService();

    await Effect.runPromise(service.setup({ mode: "none" }));
    const status = await Effect.runPromise(service.status());

    expect(status.active).toBe(false);
    expect(status.mode).toBe("none");
    expect(status.mechanism).toBe("skipped");
  });

  test("makeTestHostProxyService teardown clears active state", async () => {
    const service = makeTestHostProxyService();

    await Effect.runPromise(service.setup({ mode: "auto" }));
    await Effect.runPromise(service.teardown());

    const status = await Effect.runPromise(service.status());
    expect(status.active).toBe(false);

    const teardownCalls = service.calls.filter((c) => c.op === "teardown");
    expect(teardownCalls).toHaveLength(1);
  });
});
