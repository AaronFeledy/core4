import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";
import {
  ContractFailure,
  TestHealthcheckRunner,
  makeTestHealthcheckRunner,
  runHealthcheckContract,
} from "@lando/sdk/test";

describe("HealthcheckRunner contract", () => {
  test("TestHealthcheckRunner satisfies runHealthcheckContract", async () => {
    const exit = await Effect.runPromiseExit(runHealthcheckContract(TestHealthcheckRunner));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestHealthcheckRunner has the expected id", () => {
    expect(TestHealthcheckRunner.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestHealthcheckRunner records run calls", async () => {
    const runner = makeTestHealthcheckRunner();

    await Effect.runPromise(
      runner.run(
        {
          kind: "command",
          command: ["sh", "-c", "exit 0"],
          intervalSeconds: 5,
          timeoutSeconds: 30,
          retries: 3,
        },
        AppId.make("myapp"),
        ServiceName.make("web"),
      ),
    );

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.service).toBe(ServiceName.make("web"));
  });

  test("makeTestHealthcheckRunner run returns healthy=true and attempts>0", async () => {
    const runner = makeTestHealthcheckRunner();
    const result = await Effect.runPromise(
      runner.run(
        { kind: "tcp", port: 80, intervalSeconds: 5, timeoutSeconds: 30, retries: 3 },
        AppId.make("myapp"),
        ServiceName.make("web"),
      ),
    );
    expect(result.healthy).toBe(true);
    expect(result.attempts).toBeGreaterThan(0);
  });
});
