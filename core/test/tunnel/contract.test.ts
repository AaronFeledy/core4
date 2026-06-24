import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { type TunnelServiceContractHarness, runTunnelServiceContract } from "@lando/sdk/test";

import { AppId, ServiceName } from "@lando/core/schema";
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

  test("the contract does not require optional detached or ephemeral URL capabilities", async () => {
    const testService = makeTestTunnelService().pipe(Effect.runSync);
    const harness: TunnelServiceContractHarness = {
      name: "foreground-only TestTunnelService",
      service: {
        ...testService.service,
        capabilities: {
          ...testService.service.capabilities,
          detached: false,
          ephemeralUrls: false,
          stableUrls: true,
        },
      },
      unsupportedTarget: testService.unsupportedTarget,
      observations: testService.observations,
      events: () => Effect.sync(() => testService.events()),
    };

    const result = await run(runTunnelServiceContract(harness));
    expect(result).toBeUndefined();
  });

  test("TestTunnelService.list filters sessions by target", async () => {
    const testService = makeTestTunnelService().pipe(Effect.runSync);
    const app = AppId.make("target-filter");
    const routeTarget = { _tag: "route" as const, routeId: "web" };
    const serviceTarget = {
      _tag: "service" as const,
      service: ServiceName.make("api"),
      port: 8080,
      protocol: "http" as const,
    };

    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const routeSession = yield* testService.service.start({ app, target: routeTarget });
          yield* testService.service.start({ app, target: serviceTarget });
          const sessions = yield* testService.service.list({ app, target: routeTarget });
          return { routeSession, sessions };
        }),
      ),
    );

    expect(result.sessions.map((session) => session.id)).toEqual([result.routeSession.id]);
    expect(
      result.sessions.every((session) => session.target._tag === "route" && session.target.routeId === "web"),
    ).toBe(true);
  });
});
