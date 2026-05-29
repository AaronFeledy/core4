import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId } from "@lando/sdk/schema";
import { ContractFailure, TestSshService, makeTestSshService, runSshServiceContract } from "@lando/sdk/test";

describe("SshService contract", () => {
  test("TestSshService satisfies runSshServiceContract", async () => {
    const exit = await Effect.runPromiseExit(runSshServiceContract(TestSshService));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestSshService has the expected id", () => {
    expect(TestSshService.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestSshService records setup and getAgentSocket calls", async () => {
    const ssh = makeTestSshService();

    await Effect.runPromise(ssh.setup({ force: false }));
    await Effect.runPromise(ssh.getAgentSocket(AppId.make("myapp")));

    expect(ssh.calls).toHaveLength(2);
    expect(ssh.calls[0]?.op).toBe("setup");
    expect(ssh.calls[1]?.op).toBe("getAgentSocket");
  });

  test("makeTestSshService getAgentSocket returns non-empty socketPath", async () => {
    const ssh = makeTestSshService();
    const result = await Effect.runPromise(ssh.getAgentSocket(AppId.make("myapp")));
    expect(result.socketPath.length).toBeGreaterThan(0);
    expect(result.appId).toBe(AppId.make("myapp"));
  });
});
