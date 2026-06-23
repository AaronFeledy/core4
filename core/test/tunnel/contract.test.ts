import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { type TunnelServiceContractHarness, runTunnelServiceContract } from "@lando/sdk/test";

import { TestTunnelService, makeTestTunnelService } from "@lando/core/testing";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("TunnelService contract suite", () => {
  test("TestTunnelService satisfies the TunnelService contract", async () => {
    const harness: TunnelServiceContractHarness = {
      name: "TestTunnelService",
      service: TestTunnelService.service,
      unsupportedTarget: TestTunnelService.unsupportedTarget,
      observations: TestTunnelService.observations,
      events: () => Effect.sync(() => TestTunnelService.events()),
    };

    const result = await run(runTunnelServiceContract(harness));
    expect(result).toBeUndefined();
  });

  test("a fresh TestTunnelService instance satisfies the contract", async () => {
    const testService = makeTestTunnelService().pipe(Effect.runSync);
    const harness: TunnelServiceContractHarness = {
      name: "fresh TestTunnelService",
      service: testService.service,
      unsupportedTarget: testService.unsupportedTarget,
      observations: testService.observations,
      events: () => Effect.sync(() => testService.events()),
    };

    const result = await run(runTunnelServiceContract(harness));
    expect(result).toBeUndefined();
  });
});
