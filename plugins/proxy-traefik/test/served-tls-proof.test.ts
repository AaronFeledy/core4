import { expect, test } from "bun:test";
import type { TlsPeerInput } from "@lando/http-client/tls-peer";
import { Clock, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { app } from "./proxy-tls-harness.ts";
import { domain, makeCertificateFixture, now, pem, route } from "./router-certificate-fixture.ts";

test.each(["stale", "wrong-root", "wrong-name"] as const)(
  "waits for current served material after a %s TLS peer even on a fresh warm apply",
  async (kind) => {
    const f = makeCertificateFixture();
    f.seed(pem.current);
    let served =
      kind === "stale"
        ? pem.expiring.certificate
        : kind === "wrong-root"
          ? pem.rotated.certificate
          : pem.exactOnly.certificate;
    let completed = false;
    const service = makeTraefikRouterService({
      ...f.dependencies,
      observeTlsPeer: () => Effect.sync(() => served),
    });
    await f.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          service.applyRoutes([route], app).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );
        yield* TestClock.adjust(0);
        expect(completed).toBe(false);
        served = pem.current.certificate;
        yield* TestClock.adjust(250);
        yield* Fiber.join(fiber);
        expect(yield* Clock.currentTimeMillis).toBe(Date.parse("2026-12-15T00:00:00Z") + 250);
      }),
      Date.parse("2026-12-15T00:00:00Z"),
    );
    expect(completed).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.operations).toEqual([]);
    expect(f.runtime.requests).toHaveLength(2);
  },
);

test("warm proof deduplicates concrete authored identities and accepts another owner's covering certificate", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.current);
  const inputs: TlsPeerInput[] = [];
  const covered = { ...route, hostname: `test.${domain}` };
  const requested = [
    covered,
    { ...covered, pathPrefix: "/api" },
    { ...route, hostname: "pre*-suffix.test.lndo.site" },
  ];
  const service = makeTraefikRouterService({
    ...f.dependencies,
    observeTlsPeer: (input) =>
      Effect.sync(() => {
        inputs.push(input);
        return input.hostname === covered.hostname ? pem.exactOnly.certificate : pem.current.certificate;
      }),
  });
  await f.run(service.applyRoutes(requested, app));
  f.operations.length = 0;
  f.calls.length = 0;
  f.runtime.requests.length = 0;
  inputs.length = 0;
  await f.run(
    Effect.gen(function* () {
      yield* service.applyRoutes(requested, app);
      expect(yield* Clock.currentTimeMillis).toBe(now);
    }),
  );
  expect(inputs.map(({ hostname }) => hostname).sort()).toEqual([
    "prex-suffix.test.lndo.site",
    "test.lndo.site",
    "test.test.lndo.site",
    "traefik.test.lndo.site",
    "x.test.lndo.site",
  ]);
  expect(
    inputs.every(
      ({ address, port, caPems }) =>
        address === "127.0.0.1" && port === 38443 && caPems.length === 1 && caPems[0] === pem.rootA,
    ),
  ).toBe(true);
  expect(f.calls).toEqual([]);
  expect(f.operations).toEqual([]);
  expect(f.runtime.requests).toHaveLength(1);
});

test("limits simultaneous peer observations to four and interrupts pending handshakes", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.current);
  const entered = Deferred.makeUnsafe<void>();
  let active = 0;
  let maximum = 0;
  let started = 0;
  const service = makeTraefikRouterService({
    ...f.dependencies,
    observeTlsPeer: () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          started++;
          active++;
          maximum = Math.max(maximum, active);
        }),
        () =>
          Effect.gen(function* () {
            if (active === 4) yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        () =>
          Effect.sync(() => {
            active--;
          }),
      ),
  });
  await f.run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        service.applyRoutes([route, { ...route, hostname: "other.test.lndo.site" }], app),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
  expect(maximum).toBe(4);
  expect(started).toBe(4);
  expect(active).toBe(0);
  await f.run(f.makeService().applyRoutes([route], app));
});

test("does not observe TLS or read the CA for HTTP-only application and withdrawal", async () => {
  const f = makeCertificateFixture();
  const service = makeTraefikRouterService({
    ...f.dependencies,
    observeTlsPeer: () => Effect.die("HTTP-only must not dial TLS"),
    certificateAuthority: {
      ...f.dependencies.certificateAuthority,
      root: Effect.die("HTTP-only must not read CA"),
    },
  });
  await f.run(service.applyRoutes([{ ...route, scheme: "http" }], app));
  await f.run(service.applyRoutes([], app));
  expect(f.calls).toEqual([]);
});

test("reports TLS currency separately from graph mismatch after the shared acceptance deadline", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.current);
  const service = makeTraefikRouterService({
    ...f.dependencies,
    observeTlsPeer: () => Effect.succeed(pem.rotated.certificate),
  });
  await f.run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(service.applyRoutes([route], app).pipe(Effect.result));
      yield* TestClock.adjust(30_000);
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProxyApplyError", cause: { classification: "tls-not-current" } },
      });
      expect(JSON.stringify(result)).not.toContain("BEGIN CERTIFICATE");
    }),
  );
  f.runtime.requests.length = 0;
  await f.run(f.makeService().applyRoutes([route], app));
  expect(f.runtime.requests).toHaveLength(1);
  expect(f.operations).toEqual([]);
  expect(f.calls).toEqual([]);
});
