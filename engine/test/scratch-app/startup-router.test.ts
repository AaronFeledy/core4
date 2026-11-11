import { expect, spyOn, test } from "bun:test";
import { ProxyError } from "@lando/sdk/errors";
import { BuildOrchestrator, ScratchAppService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import * as ServiceCertificates from "../../src/lifecycle/service-certificates.ts";
import * as AppPlacement from "../../src/providers/app-placement.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";
import { withStartupFixture } from "./startup-fixture.ts";

const missingRouter = makeUnavailableRouter(
  new ProxyError({
    message: "Router service missing is not installed.",
    proxyId: "missing",
    remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
  }),
);

test("#2138 a routed scratch start without a selectable router refuses before placement, certificates, build, or apply", async () => {
  const placement = spyOn(AppPlacement, "ensureAppPlacement");
  const certificates = spyOn(ServiceCertificates, "prepareServiceCertificates");
  const builds: string[] = [];
  const builder = Layer.succeed(
    BuildOrchestrator,
    BuildOrchestrator.of({
      build: (plan) => Effect.sync(() => void builds.push("build")).pipe(Effect.as(plan)),
      buildApp: () => Effect.sync(() => void builds.push("buildApp")),
    }),
  );
  try {
    await withStartupFixture(
      {},
      async (fixture) => {
        // When: a routed scratch fork is acquired while the configured router cannot be selected.
        const result = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (scratch) =>
            scratch.acquire({ source: { kind: "fork" }, isolate: "none", detached: true }),
          ).pipe(Effect.scoped, Effect.result, Effect.provide(fixture.layer.pipe(Layer.provide(builder)))),
        );

        // Then: the selection reason is reported and nothing was placed, certified, built, or applied.
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ScratchAppError",
            operation: "start",
            cause: { _tag: "ProxySetupError", proxyId: "missing" },
          },
        });
        expect({
          placed: placement.mock.calls.length,
          certified: certificates.mock.calls.length,
          built: builds.length,
          applied: fixture.applied.length,
        }).toEqual({ placed: 0, certified: 0, built: 0, applied: 0 });
      },
      { router: missingRouter },
    );
  } finally {
    placement.mockRestore();
    certificates.mockRestore();
  }
});
