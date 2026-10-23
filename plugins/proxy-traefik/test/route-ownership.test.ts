import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { FileNotFoundError } from "@lando/sdk/errors";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { makeTraefikRouterService } from "../src/proxy.ts";
import { ownerKeyFromRouteConfig, routeOwnerKeyComment } from "../src/route-ownership.ts";

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
    const ownerKey = "owner-same-root";
    const oldApp = AppId.make("old-name");
    const newApp = AppId.make("new-name");
    await Effect.runPromise(harness.service.applyRoutes(routeFor("old-name"), oldApp, { ownerKey }));

    const applied = await Effect.runPromise(
      harness.service.applyRoutes(routeFor("new-name"), newApp, { ownerKey }),
    );

    expect(applied.app).toBe(newApp);
    expect(harness.files.has(routePath("new-name"))).toBe(true);
    expect(harness.files.has(routePath("old-name"))).toBe(false);
    expect(harness.files.get(routePath("new-name"))).toContain(routeOwnerKeyComment(ownerKey).trim());
    expect(ownerKeyFromRouteConfig(harness.files.get(routePath("new-name")) ?? "")).toBe(ownerKey);
  });

  test("a second app with a similar slug stays untouched", async () => {
    const harness = makeHarness();
    const renamed = AppId.make("my-app");
    const neighbor = AppId.make("my-app-2");
    await Effect.runPromise(
      harness.service.applyRoutes(routeFor("my-app"), renamed, { ownerKey: "owner-a" }),
    );
    await Effect.runPromise(
      harness.service.applyRoutes(routeFor("my-app-2"), neighbor, { ownerKey: "owner-b" }),
    );

    await Effect.runPromise(
      harness.service.applyRoutes(routeFor("my-shop"), AppId.make("my-shop"), { ownerKey: "owner-a" }),
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
});
