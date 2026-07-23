import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";

import { makeTraefikProxyService, renderTraefikDynamicConfig } from "../src/proxy.ts";

const app = AppId.make("demo");
const routes = [
  {
    hostname: "api.demo.lndo.site",
    scheme: "https" as const,
    service: ServiceName.make("api"),
    pathPrefix: "/v1",
    backend: { service: ServiceName.make("api"), protocol: "https" as const, port: 9443 },
  },
  {
    hostname: "web.demo.lndo.site",
    scheme: "http" as const,
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 8088 },
  },
];

const makeHarness = (failAtomic = false) => {
  const ensured: Array<ReadonlyArray<string>> = [];
  const files = new Map<string, string>();
  const service = makeTraefikProxyService({
    fileSystem: {
      mkdir: () => Effect.void,
      writeAtomic: (path, content) =>
        failAtomic
          ? Effect.fail(new Error("injected atomic replacement failure"))
          : Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: {
      ensureRunning: (services) =>
        Effect.sync(() => {
          ensured.push(services);
        }),
    },
  });
  return { ensured, files, service };
};

describe("Traefik ProxyService", () => {
  test("renders resolved HTTPS and named non-80 backends", () => {
    const rendered = renderTraefikDynamicConfig(routes, app);

    expect(rendered).toContain("https://api.demo.internal:9443");
    expect(rendered).toContain("http://web.demo.internal:8088");
    expect(rendered).toContain("PathPrefix(`/v1`)");
    expect(rendered).toContain("tls: {}");
  });

  test("setup ensures the global Traefik service is running", async () => {
    const harness = makeHarness();

    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    expect(harness.ensured).toEqual([["traefik"]]);
  });

  test("apply reports selected external authorities and atomically replaces stale routes", async () => {
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    const first = await Effect.runPromise(harness.service.applyRoutes(routes, app));
    const second = await Effect.runPromise(harness.service.applyRoutes(routes.slice(1), app));

    expect(first.authorities).toEqual([
      { scheme: "https", hostname: "api.demo.lndo.site", port: 38443 },
      { scheme: "http", hostname: "web.demo.lndo.site", port: 38080 },
    ]);
    expect(second.appliedRoutes).toHaveLength(1);
    expect([...harness.files.values()][0]).not.toContain("api.demo.lndo.site");
  });

  test("an atomic replacement failure leaves the prior route file untouched", async () => {
    const harness = makeHarness(true);
    harness.files.set("/lando/global/proxy-traefik/dynamic/routes-demo.yml", "previous");

    const exit = await Effect.runPromiseExit(harness.service.applyRoutes(routes, app));

    expect(exit._tag).toBe("Failure");
    expect([...harness.files.values()]).toEqual(["previous"]);
  });

  test("removeRoutes is idempotent", async () => {
    const harness = makeHarness();

    await Effect.runPromise(harness.service.removeRoutes(app));
    await Effect.runPromise(harness.service.removeRoutes(app));

    expect(harness.files.size).toBe(0);
  });
});
