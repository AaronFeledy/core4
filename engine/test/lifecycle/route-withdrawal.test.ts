import { expect, test } from "bun:test";
import { ProxyError } from "@lando/sdk/errors";
import { AppId, appIdentityKey } from "@lando/sdk/schema";
import { EventService, type LandoEvent, RouterService, type RouterServiceShape } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect, Result, Stream } from "effect";
import { withdrawOwnerRoutes } from "../../src/lifecycle/route-withdrawal.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";

const owner = { id: AppId.make("demo"), ownerKey: appIdentityKey("owner", "/apps/demo") };
const reason = new ProxyError({
  message: "Router service missing is not installed.",
  proxyId: "missing",
  remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
});

const withdraw = (router: RouterServiceShape | undefined) => {
  const events: LandoEvent[] = [];
  const effect = withdrawOwnerRoutes(owner).pipe(
    Effect.provideService(
      EventService,
      EventService.of({
        publish: (event) => Effect.sync(() => void events.push(event)),
        subscribe: () => Stream.die("unused subscription"),
        subscribeQueue: Effect.die("unused queue"),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  return Effect.runPromise(
    (router === undefined ? effect : effect.pipe(Effect.provideService(RouterService, router))).pipe(
      Effect.result,
      Effect.map((result) => ({
        result,
        warnings: events.flatMap((e) => (e._tag === "message.warn" ? [e.body] : [])),
      })),
    ),
  );
};

test("an unavailable router with no installed router skips withdrawal with a warning naming the reason", async () => {
  // Given / When
  const { result, warnings } = await withdraw(makeUnavailableRouter(reason));

  // Then
  expect(result).toEqual(
    Result.succeed({ kind: "skipped", reason: `${reason.message} ${reason.remediation}` }),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("not withdrawn");
  expect(warnings[0]).toContain(owner.id);
  expect(warnings[0]).toContain(reason.message);
  expect(warnings[0]).toContain(reason.remediation);
});

test("a runtime without a router service skips withdrawal with a warning", async () => {
  const { result, warnings } = await withdraw(undefined);

  expect(result).toEqual(
    Result.succeed({ kind: "skipped", reason: "No router service is available in this runtime." }),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("not withdrawn");
  expect(warnings[0]).toContain(owner.id);
});

test.each([false, true])(
  "an installed router withdraws routes and keeps its failure fatal (fails: %s)",
  async (fails) => {
    // Given: an installed router whose withdrawal may fail.
    const failure = new ProxyError({
      message: "route removal failed",
      proxyId: "test",
      remediation: "Retry.",
    });
    const removed: unknown[] = [];
    const router = RouterService.of({
      ...makeTestRouterService(),
      removeRoutes: (target) =>
        Effect.sync(() => void removed.push(target)).pipe(
          Effect.andThen(fails ? Effect.fail(failure) : Effect.void),
        ),
    });

    // When
    const { result, warnings } = await withdraw(router);

    // Then: success proves withdrawal; failure propagates and never degrades to a warning.
    expect(removed).toEqual([owner]);
    expect(result).toEqual(fails ? Result.fail(failure) : Result.succeed({ kind: "withdrawn" }));
    expect(warnings).toEqual([]);
  },
);

test("an unavailable router that withdraws through the installed routers proves cleanup without a warning", async () => {
  // Given: no selectable router, but the installed routers withdraw the owner's routes.
  const withdrawn: unknown[] = [];
  const router = makeUnavailableRouter(reason, (target) => Effect.sync(() => void withdrawn.push(target)));

  // When
  const { result, warnings } = await withdraw(router);

  // Then
  expect(withdrawn).toEqual([owner]);
  expect(result).toEqual(Result.succeed({ kind: "withdrawn" }));
  expect(warnings).toEqual([]);
});

test("an unavailable router whose installed routers fail to withdraw skips and reports that failure", async () => {
  // Given: no selectable router, and an installed router that cannot withdraw.
  const failure = new ProxyError({
    message: "route removal failed",
    proxyId: "alpha",
    remediation: "Retry.",
  });
  const router = makeUnavailableRouter(reason, () => Effect.fail(failure));

  // When
  const { result, warnings } = await withdraw(router);

  // Then: teardown continues without claiming cleanup, and names the installed router's failure
  // instead of the selection reason.
  const detail = `${failure.message} ${failure.remediation}`;
  expect(result).toEqual(Result.succeed({ kind: "skipped", reason: detail }));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("not withdrawn");
  expect(warnings[0]).toContain(owner.id);
  expect(warnings[0]).toContain("an installed router could not remove them");
  expect(warnings[0]).toContain(failure.message);
  expect(warnings[0]).toContain(failure.remediation);
  expect(warnings[0]).not.toContain(reason.message);
});
