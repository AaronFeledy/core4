import { expect, test } from "bun:test";
import type { ProxyApplyError, ProxyError } from "@lando/sdk/errors";
import { AppId, type AppRouteOwner, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { appCertificateFiles, routeFile } from "../src/proxy-paths.ts";
import { acceptsAllRoutes } from "../src/route-acceptance.ts";
import { persistedRuntimeGraph } from "./apply-runtime-fixture.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";

const oldOwner: AppRouteOwner = { id: AppId.make("old"), ownerKey: "a".repeat(64) };
const newOwner: AppRouteOwner = { ...oldOwner, id: AppId.make("new") };
const oldRoutes: readonly RoutePlan[] = [
  {
    hostname: "old.lndo.site",
    priority: 2,
    scheme: "https",
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
  },
];
const newRoutes = oldRoutes.map((route) => ({ ...route, hostname: "new.lndo.site" }));

test("#2062 rename replaces one owner's route file and certificates", async () => {
  const fixture = makeAcceptanceFixture();
  await Effect.runPromise(fixture.service.applyRoutes(oldRoutes, oldOwner));

  const applied = await Effect.runPromise(fixture.service.applyRoutes(newRoutes, newOwner));

  expect(applied.app).toBe(newOwner.id);
  expect([...fixture.files.keys()].filter((path) => /routes-.*\.yml$/.test(path))).toEqual([
    routeFile(fixture.dependencies.paths, newOwner),
  ]);
  const content = fixture.files.get(routeFile(fixture.dependencies.paths, newOwner));
  expect(content).toContain("new.lndo.site");
  expect(content).not.toContain("old.lndo.site");
  expect([...fixture.files.keys()].filter((path) => /\/certs\/(old|new)\.(crt|key)$/.test(path))).toEqual([]);
  expect(fixture.files.has(appCertificateFiles(fixture.dependencies.paths, newOwner).cert)).toBe(true);
});

test("#2062 rename waits until old-slug routers under the same owner disappear", async () => {
  const fixture = makeAcceptanceFixture();
  await Effect.runPromise(fixture.service.applyRoutes(oldRoutes, oldOwner));
  const stale = persistedRuntimeGraph(fixture.files);
  fixture.runtime.setGraph(stale);

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(fixture.service.applyRoutes(newRoutes, newOwner));
      yield* TestClock.adjust(0);
      const current = persistedRuntimeGraph(fixture.files);
      const mixed = {
        routers: { ...stale.routers, ...current.routers },
        services: { ...stale.services, ...current.services },
        middlewares: { ...stale.middlewares, ...current.middlewares },
      };
      expect(acceptsAllRoutes(mixed, newOwner, newRoutes)).toBe(false);
      fixture.runtime.setGraph(mixed);
      yield* TestClock.adjust(250);
      expect(yield* fixture.service.readAppliedRoutes(newOwner)).toEqual(oldRoutes);
      fixture.runtime.setGraph(current);
      yield* TestClock.adjust(250);
      expect((yield* Fiber.join(fiber)).app).toBe(newOwner.id);
      expect(acceptsAllRoutes(current, newOwner, newRoutes)).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test.each(["remove", "empty"] as const)(
  "#2062 renamed %s withdrawal works while the router is stopped",
  async (method) => {
    const fixture = makeAcceptanceFixture();
    await Effect.runPromise(fixture.service.applyRoutes(oldRoutes, oldOwner));
    fixture.runtime.setGraph({ routers: {}, services: {} });
    const requests = fixture.runtime.requests.length;

    const withdrawal: Effect.Effect<void, ProxyApplyError | ProxyError> =
      method === "remove"
        ? fixture.service.removeRoutes(newOwner)
        : fixture.service.applyRoutes([], newOwner).pipe(Effect.asVoid);
    await Effect.runPromise(withdrawal);

    expect(fixture.files.has(routeFile(fixture.dependencies.paths, newOwner))).toBe(false);
    expect(fixture.files.has(appCertificateFiles(fixture.dependencies.paths, newOwner).cert)).toBe(false);
    expect(fixture.runtime.requests).toHaveLength(requests);
  },
);

test("different owners with similar slugs preserve each other's publication", async () => {
  const fixture = makeAcceptanceFixture();
  const other: AppRouteOwner = { id: AppId.make("old-1"), ownerKey: "b".repeat(64) };
  await Effect.runPromise(fixture.service.applyRoutes(oldRoutes, oldOwner));
  await Effect.runPromise(fixture.service.applyRoutes(newRoutes, other));
  const otherFile = routeFile(fixture.dependencies.paths, other);
  const otherBytes = fixture.files.get(otherFile);
  const otherCertificate = fixture.files.get(appCertificateFiles(fixture.dependencies.paths, other).cert);

  await Effect.runPromise(fixture.service.applyRoutes(newRoutes, newOwner));
  await Effect.runPromise(fixture.service.removeRoutes(newOwner));

  expect(fixture.files.get(otherFile)).toBe(otherBytes);
  expect(fixture.files.get(appCertificateFiles(fixture.dependencies.paths, other).cert)).toBe(
    otherCertificate,
  );
  expect(await Effect.runPromise(fixture.service.readAppliedRoutes(other))).toEqual(newRoutes);
});

test("apply and withdrawal leave legacy slug files untouched", async () => {
  const fixture = makeAcceptanceFixture();
  const legacy = "/lando/global/proxy-traefik/dynamic/routes-old.yml";
  fixture.files.set(legacy, "legacy configuration");
  fixture.runtime.setGraph({ routers: {}, services: {} });
  await Effect.runPromise(fixture.service.applyRoutes([], newOwner));
  await Effect.runPromise(fixture.service.removeRoutes(newOwner));

  expect(fixture.files.get(legacy)).toBe("legacy configuration");
});

test.each(["apply", "remove", "empty"] as const)(
  "%s preserves an owner-shaped file without valid metadata",
  async (method) => {
    const fixture = makeAcceptanceFixture();
    const file = routeFile(fixture.dependencies.paths, newOwner);
    fixture.files.set(file, "unattributable configuration");
    fixture.runtime.setGraph({ routers: {}, services: {} });

    const operation: Effect.Effect<void, ProxyApplyError | ProxyError> =
      method === "remove"
        ? fixture.service.removeRoutes(newOwner)
        : fixture.service.applyRoutes(method === "empty" ? [] : newRoutes, newOwner).pipe(Effect.asVoid);
    const result = await Effect.runPromise(operation.pipe(Effect.result));

    expect(result._tag).toBe("Failure");
    expect(fixture.files.get(file)).toBe("unattributable configuration");
  },
);
