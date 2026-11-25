import { expect, test } from "bun:test";
import { ScratchAppService } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import { web } from "../operations/start-progress-topology-support.ts";
import { failureOf } from "../subsystems/healthcheck/support.ts";
import { withStartupFixture } from "./startup-fixture.ts";

test("an invalid preserved hostname fails scratch planning before runtime preparation", async () => {
  const hostname = `${"x".repeat(64)}.lndo.site`;
  await withStartupFixture(
    { ensureReady: Effect.die("Invalid plans must not prepare the runtime") },
    async ({ layer, entries }) => {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({ source: { kind: "fork" }, isolate: "none", detached: true, hostnames: [hostname] }),
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
      routes: [
        {
          hostname,
          scheme: "http",
          service: web.name,
          priority: 2,
          backend: { service: web.name, protocol: "http", port: 3000 },
        },
      ],
    },
  );
});
