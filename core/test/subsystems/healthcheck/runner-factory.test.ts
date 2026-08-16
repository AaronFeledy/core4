import { describe, expect, test } from "bun:test";

import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { makeHealthcheckRunner } from "../../../src/testing/engine-layers.ts";
import { appId, commandPlan, drive, execSequence, nonePlan, service } from "./support.ts";

describe("makeHealthcheckRunner", () => {
  test("kind none resolves healthy without calling exec", async () => {
    const fake = execSequence([0]);
    const provider = { ...TestRuntimeProvider, exec: fake.exec } satisfies RuntimeProviderShape;

    const result = await drive(
      makeHealthcheckRunner({ exec: provider.exec }).run(nonePlan(), appId, service),
    );

    expect(result).toEqual({ healthy: true, service, attempts: 0, lastStatus: "skipped" });
    expect(fake.calls).toHaveLength(0);
  });

  test.each([
    { exitCode: 0, healthy: true, lastStatus: "ok" },
    { exitCode: 1, healthy: false, lastStatus: "exit 1" },
  ])("command exit $exitCode decides healthy=$healthy", async ({ exitCode, healthy, lastStatus }) => {
    const fake = execSequence([exitCode]);
    const provider = { ...TestRuntimeProvider, exec: fake.exec } satisfies RuntimeProviderShape;

    const result = await drive(
      makeHealthcheckRunner({ exec: provider.exec }).run(commandPlan(["health"]), appId, service),
    );

    expect(result).toEqual({ healthy, service, attempts: 1, lastStatus });
    expect(fake.calls).toHaveLength(1);
  });

  test("uses the provider-exec runner id", () => {
    const fake = execSequence([0]);
    const provider = { ...TestRuntimeProvider, exec: fake.exec } satisfies RuntimeProviderShape;

    const runner = makeHealthcheckRunner({ exec: provider.exec });

    expect(runner.id).toBe("provider-exec");
  });
});
