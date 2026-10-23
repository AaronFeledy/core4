import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";

import { FileNotFoundError } from "@lando/sdk/errors";
import { AppId, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { makeTraefikRouterService } from "../src/proxy.ts";
import {
  ROUTE_OWNER_KEY_PREFIX,
  ownerKeyFromRouteConfig,
  routeOwnerKeyComment,
} from "../src/route-ownership.ts";

const ownerA = appIdentityKey("owner", "/apps/renamed");
const ownerB = appIdentityKey("owner", "/apps/neighbor");

const routeFor = (slug: string) => [
  {
    hostname: `web.${slug}.lndo.site`,
    priority: 2,
    scheme: "http" as const,
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 8080 },
  },
];

const makeHarness = () => {
  const files = new Map<string, string>();
  const service = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
      exists: (path) =>
        Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
      readDir: (path) =>
        Effect.succeed(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1)),
        ),
      readText: (path) =>
        files.has(path)
          ? Effect.succeed(files.get(path) ?? "")
          : Effect.fail(new FileNotFoundError({ message: "removed", path })),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: { ensureRunning: () => Effect.succeed([]) },
  });
  return { files, service };
};

const routePath = (slug: string): string => `/lando/global/proxy-traefik/dynamic/routes-${slug}.yml`;

describe("router route-file ownership", () => {
  test("a slug rename leaves the previous route file and still applies", async () => {
    // Given: routes published under the old Landofile slug.
    const harness = makeHarness();
    const oldApp = AppId.make("old-name");
    const newApp = AppId.make("new-name");
    await Effect.runPromise(harness.service.applyRoutes(routeFor("old-name"), oldApp));

    // When: the same app starts again after a Landofile name/slug change.
    const applied = await Effect.runPromise(harness.service.applyRoutes(routeFor("new-name"), newApp));

    // Then: start still publishes the new slug, but the old slug file survives without an ownerKey.
    expect(applied.app).toBe(newApp);
    expect(applied.appliedRoutes).toHaveLength(1);
    expect(harness.files.has(routePath("new-name"))).toBe(true);
    expect(harness.files.has(routePath("old-name"))).toBe(true);
  });

  test("applying routes drops same-owner files that still use a previous slug", async () => {
    const harness = makeHarness();
    const oldApp = AppId.make("old-name");
    const newApp = AppId.make("new-name");
    await Effect.runPromise(harness.service.applyRoutes(routeFor("old-name"), oldApp, { ownerKey: ownerA }));

    const applied = await Effect.runPromise(
      harness.service.applyRoutes(routeFor("new-name"), newApp, { ownerKey: ownerA }),
    );

    expect(applied.app).toBe(newApp);
    expect(harness.files.has(routePath("new-name"))).toBe(true);
    expect(harness.files.has(routePath("old-name"))).toBe(false);
    expect(harness.files.get(routePath("new-name"))).toContain(routeOwnerKeyComment(ownerA).trim());
    expect(ownerKeyFromRouteConfig(harness.files.get(routePath("new-name")) ?? "")).toBe(ownerA);
  });

  test("a second app with a similar slug stays untouched", async () => {
    const harness = makeHarness();
    const renamed = AppId.make("my-app");
    const neighbor = AppId.make("my-app-2");
    await Effect.runPromise(harness.service.applyRoutes(routeFor("my-app"), renamed, { ownerKey: ownerA }));
    await Effect.runPromise(
      harness.service.applyRoutes(routeFor("my-app-2"), neighbor, { ownerKey: ownerB }),
    );

    await Effect.runPromise(
      harness.service.applyRoutes(routeFor("my-shop"), AppId.make("my-shop"), { ownerKey: ownerA }),
    );

    expect(harness.files.has(routePath("my-app"))).toBe(false);
    expect(harness.files.has(routePath("my-shop"))).toBe(true);
    expect(harness.files.has(routePath("my-app-2"))).toBe(true);
    expect(harness.files.get(routePath("my-app-2"))).toContain("web.my-app-2.lndo.site");
  });

  test("does not delete another slug by filename pattern when ownerKey is absent", async () => {
    const harness = makeHarness();
    const first = AppId.make("shop");
    const second = AppId.make("shop-extra");
    await Effect.runPromise(harness.service.applyRoutes(routeFor("shop"), first));
    await Effect.runPromise(harness.service.applyRoutes(routeFor("shop-extra"), second));

    expect(harness.files.has(routePath("shop"))).toBe(true);
    expect(harness.files.has(routePath("shop-extra"))).toBe(true);
  });

  test("reads the owner-key stamp from line 0 only when the value is 64 hex", () => {
    const key = "ab".repeat(32);
    expect(ownerKeyFromRouteConfig(`${ROUTE_OWNER_KEY_PREFIX}${key}\nhttp:\n`)).toBe(key);
    expect(ownerKeyFromRouteConfig(` ${ROUTE_OWNER_KEY_PREFIX}${key}\n`)).toBeUndefined();
    expect(ownerKeyFromRouteConfig(`http:\n${ROUTE_OWNER_KEY_PREFIX}${key}\n`)).toBeUndefined();
    expect(ownerKeyFromRouteConfig(`# note\n${ROUTE_OWNER_KEY_PREFIX}${key}\n`)).toBeUndefined();
    expect(ownerKeyFromRouteConfig(`${ROUTE_OWNER_KEY_PREFIX}not-a-hash\n`)).toBeUndefined();
    expect(ownerKeyFromRouteConfig(`${ROUTE_OWNER_KEY_PREFIX}${key}extra\n`)).toBeUndefined();
    expect(ownerKeyFromRouteConfig(`# prefix ${ROUTE_OWNER_KEY_PREFIX}${key}\n`)).toBeUndefined();
  });

  test("skips withdraw when the owner-key changes between read and remove", async () => {
    const files = new Map<string, string>();
    const stale = routePath("old-name");
    let staleReads = 0;
    const service = makeTraefikRouterService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: {
        mkdir: () => Effect.void,
        writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        remove: (path) => Effect.sync(() => void files.delete(path)),
        exists: (path) =>
          Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
        readDir: (path) =>
          Effect.succeed(
            [...files.keys()]
              .filter((file) => file.startsWith(`${path}/`))
              .map((file) => file.slice(path.length + 1)),
          ),
        readText: (path) =>
          Effect.gen(function* () {
            if (!files.has(path)) {
              return yield* Effect.fail(new FileNotFoundError({ message: "removed", path }));
            }
            const current = files.get(path) ?? "";
            if (path === stale) {
              staleReads++;
              if (staleReads === 1) {
                files.set(stale, `${routeOwnerKeyComment(ownerB)}http:\n  routers: {}\n`);
                return current;
              }
            }
            return current;
          }),
      },
      paths: { platform: "linux", globalAppRoot: "/lando/global" },
      globalApp: { ensureRunning: () => Effect.succeed([]) },
    });

    const oldApp = AppId.make("old-name");
    const newApp = AppId.make("new-name");
    await Effect.runPromise(service.applyRoutes(routeFor("old-name"), oldApp, { ownerKey: ownerA }));
    await Effect.runPromise(service.applyRoutes(routeFor("new-name"), newApp, { ownerKey: ownerA }));

    expect(files.has(routePath("new-name"))).toBe(true);
    expect(files.has(stale)).toBe(true);
    expect(ownerKeyFromRouteConfig(files.get(stale) ?? "")).toBe(ownerB);
    expect(staleReads).toBeGreaterThanOrEqual(2);
  });

  test("serializes apply so a new app claiming the old slug keeps its file", async () => {
    const files = new Map<string, string>();
    const stale = routePath("old-name");
    const firstStaleRead = Deferred.makeUnsafe<void>();
    const releaseWithdraw = Deferred.makeUnsafe<void>();
    const claimEntered = Deferred.makeUnsafe<void>();
    let staleReads = 0;
    const service = makeTraefikRouterService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: {
        mkdir: () => Effect.void,
        writeAtomic: (path, content) =>
          Effect.sync(() => {
            const text = String(content);
            if (path === stale && ownerKeyFromRouteConfig(text) === ownerB) {
              Effect.runSync(Deferred.succeed(claimEntered, undefined));
            }
            files.set(path, text);
          }),
        writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        remove: (path) => Effect.sync(() => void files.delete(path)),
        exists: (path) =>
          Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
        readDir: (path) =>
          Effect.succeed(
            [...files.keys()]
              .filter((file) => file.startsWith(`${path}/`))
              .map((file) => file.slice(path.length + 1)),
          ),
        readText: (path) =>
          Effect.gen(function* () {
            if (!files.has(path)) {
              return yield* Effect.fail(new FileNotFoundError({ message: "removed", path }));
            }
            if (path === stale) {
              staleReads++;
              if (staleReads === 1) {
                yield* Deferred.succeed(firstStaleRead, undefined);
                yield* Deferred.await(releaseWithdraw);
              }
            }
            return files.get(path) ?? "";
          }),
      },
      paths: { platform: "linux", globalAppRoot: "/lando/global" },
      globalApp: { ensureRunning: () => Effect.succeed([]) },
    });

    const oldApp = AppId.make("old-name");
    await Effect.runPromise(service.applyRoutes(routeFor("old-name"), oldApp, { ownerKey: ownerA }));
    const rename = Effect.runFork(
      service.applyRoutes(routeFor("new-name"), AppId.make("new-name"), { ownerKey: ownerA }),
    );
    await Effect.runPromise(Deferred.await(firstStaleRead));
    const claim = Effect.runFork(service.applyRoutes(routeFor("old-name"), oldApp, { ownerKey: ownerB }));
    const raced = await Effect.runPromise(
      Effect.raceFirst(
        Deferred.await(claimEntered).pipe(Effect.as("entered" as const)),
        Effect.sleep("150 millis").pipe(Effect.as("blocked" as const)),
      ),
    );
    expect(raced).toBe("blocked");
    expect(ownerKeyFromRouteConfig(files.get(stale) ?? "")).toBe(ownerA);
    await Effect.runPromise(Deferred.succeed(releaseWithdraw, undefined));
    await Effect.runPromise(Fiber.join(rename));
    await Effect.runPromise(Fiber.join(claim));
    expect(files.has(stale)).toBe(true);
    expect(ownerKeyFromRouteConfig(files.get(stale) ?? "")).toBe(ownerB);
  });
});
