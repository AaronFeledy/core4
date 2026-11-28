import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { ScratchAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import { withDestroyFixture } from "./destroy-fixture.ts";

test("scratch info reports the owned applied route after discarding a v3 desired plan", async () => {
  const web = ServiceName.make("web");
  await withDestroyFixture(
    {
      desiredPlanVersion: 3,
      appliedPlan: true,
      appliedRoute: {
        hostname: "web.scratch.lndo.site",
        scheme: "https",
        service: web,
        pathPrefix: "/docs",
        priority: 65544,
        backend: { service: web, port: 80, protocol: "http" },
      },
    },
    async (fixture) => {
      const result = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (scratch) => scratch.info(fixture.id)).pipe(
          Effect.provide(fixture.layer),
        ),
      );
      expect(result.routes).toEqual([
        {
          service: web,
          host: "web.scratch.lndo.site",
          hostMatch: "exact",
          protocol: "https",
          port: 8443,
          pathPrefix: "/docs",
          url: "https://web.scratch.lndo.site:8443/docs",
        },
      ]);
    },
  );
});
