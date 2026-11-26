import { expect, test } from "bun:test";
import type { RoutePlan } from "@lando/sdk/schema";
import { ScratchAppService } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import { web } from "../operations/start-progress-topology-support.ts";
import { failureOf } from "../subsystems/healthcheck/support.ts";
import { withStartupFixture } from "./startup-fixture.ts";

const route = (hostname: string): RoutePlan => ({
  hostname,
  scheme: "http",
  service: web.name,
  priority: 2,
  backend: { service: web.name, protocol: "http", port: 3000 },
});

test("an invalid preserved hostname fails scratch planning before runtime preparation", async () => {
  const hostname = `${"x".repeat(64)}.lndo.site`;
  await withStartupFixture(
    { ensureReady: Effect.die("Invalid plans must not prepare the runtime") },
    async ({ layer, entries }) => {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({
            source: { kind: "fork" },
            isolate: "none",
            detached: true,
            hostnames: [hostname],
          }),
        ).pipe(Effect.scoped, Effect.provide(layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        _tag: "ScratchAppError",
        operation: "plan",
        cause: { _tag: "LandofileValidationError", issues: [{ path: ["routes", 0, "hostname"] }] },
      });
      expect(entries.size).toBe(0);
    },
    {
      router: TestRouterService,
      routes: [route(hostname)],
    },
  );
});

const collision = (number: number) => `collisionabc${String(number).padStart(48, "x")}.lndo.site`;
const longDomain = Array.from({ length: 4 }, () => "x".repeat(60)).join(".");

test.each([
  ["a hostname with no room for a suffix", [`x.${longDomain}`], longDomain],
  ["distinct hostnames that shorten to the same name", [collision(41487), collision(55912)], undefined],
] as const)("scratch planning rejects %s before apply", async (_, hostnames, defaultDomain) => {
  await withStartupFixture(
    { ensureReady: Effect.die("Unrewritable hostnames must not prepare the runtime") },
    async ({ layer, entries }) => {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({
            source: { kind: "fork" },
            isolate: "none",
            detached: true,
            name: "a".repeat(25),
          }),
        ).pipe(Effect.scoped, Effect.provide(layer)),
      );
      const hostname = hostnames.at(-1);
      if (hostname === undefined) throw new TypeError("Expected a route in the fixture");
      expect(failureOf(exit)).toMatchObject({
        _tag: "ScratchAppError",
        operation: "plan",
        message: expect.stringContaining(hostname),
      });
      expect(entries.size).toBe(0);
    },
    { router: TestRouterService, routes: hostnames.map(route), defaultDomain },
  );
});
