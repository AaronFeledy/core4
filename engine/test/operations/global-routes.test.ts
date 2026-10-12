import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderUnavailableError, ProxyApplyError, ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";

import { publishGlobalRoutes } from "../../src/operations/global-routes.ts";

const mail = ServiceName.make("mailpit");
const plan: AppPlan = {
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root: AbsolutePath.make("/tmp/lando-global"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [
    {
      hostname: "mailpit.lndo.site",
      priority: 1,
      scheme: "https",
      service: mail,
      endpoint: 8025,
      backend: { service: mail, protocol: "http", port: 8025 },
    },
  ],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-22T00:00:00Z"),
    source: "global-routes.test",
    runtime: 4,
  },
  extensions: {},
};

const makeRouter = () => ({
  ...makeTestRouterService(),
  setup: () => Effect.die("Global publication must not set up the router"),
  prepare: () => Effect.die("Global publication must not prepare the router"),
});

const sibling = ServiceName.make("sibling");
const siblingPlan: AppPlan = {
  ...plan,
  routes: [
    ...plan.routes,
    {
      hostname: "sibling.lndo.site",
      priority: 1,
      scheme: "https",
      service: sibling,
      endpoint: 8080,
      backend: { service: sibling, protocol: "http", port: 8080 },
    },
  ],
};
const observation = {
  app: plan.id,
  appRoot: plan.root,
  providerId: plan.provider,
  service: sibling,
  status: "running" as const,
  state: "running",
  endpoints: [],
};

describe("global route publication", () => {
  test("route-free plans never touch router or provider methods", async () => {
    // Given a route-free app and unavailable routing and observation methods.
    const router = {
      ...makeRouter(),
      applyRoutes: () => Effect.die("Route-free publication must not apply"),
      removeRoutes: () => Effect.die("Route-free publication must not remove"),
    };
    const provider = { list: () => Effect.die("Route-free publication must not list") };
    // When publication runs without declared routes.
    const urls = await Effect.runPromise(
      publishGlobalRoutes(
        router,
        provider,
        { ...plan, routes: [] },
        { started: new Set(), failed: new Set() },
      ),
    );
    // Then no router is required and no URLs are advertised.
    expect(urls.size).toBe(0);
  });

  test("failed routes are withdrawn while active owned sibling routes stay", async () => {
    // Given a failed service still observed active alongside an untouched active sibling.
    const router = makeRouter();
    const provider = { list: () => Effect.succeed([observation, { ...observation, service: mail }]) };
    // When failure reconciliation observes the untouched sibling.
    await Effect.runPromise(
      publishGlobalRoutes(router, provider, siblingPlan, { started: new Set(), failed: new Set([mail]) }),
    );
    // Then an active observation cannot resurrect a failed route.
    expect(router.routesByApp.get(plan.id)?.map((route) => route.service)).toEqual([sibling]);
  });

  test("failed services alone do not trigger provider listing", async () => {
    // Given every routed service either started or failed.
    const router = makeRouter();
    const provider = { list: () => Effect.die("Failed services must not trigger listing") };
    // When publication reconciles the failed sibling.
    await Effect.runPromise(
      publishGlobalRoutes(router, provider, siblingPlan, {
        started: new Set([mail]),
        failed: new Set([sibling]),
      }),
    );
    // Then the failed route is withdrawn without observing the provider.
    expect(router.routesByApp.get(plan.id)).toEqual(plan.routes);
  });

  test("bare start publishes all routes without listing services or setting up the router", async () => {
    // Given every routed service started successfully.
    const router = makeRouter();
    const provider = { list: () => Effect.die("Bare start must not list") } satisfies Pick<
      RuntimeProviderShape,
      "list"
    >;
    // When the global route file is published.
    const urls = await Effect.runPromise(
      publishGlobalRoutes(router, provider, siblingPlan, {
        started: new Set([mail, sibling]),
        failed: new Set(),
      }),
    );
    // Then all declared routes and their advertised URLs are available.
    expect(router.routesByApp.get(plan.id)).toEqual(siblingPlan.routes);
    expect(urls.get(mail)).toEqual(["https://mailpit.lndo.site:38443"]);
  });

  for (const status of ["stopped", "missing", "running", "paused", "restarting"] as const) {
    test(`selected start ${status === "stopped" || status === "missing" ? "excludes" : "preserves"} ${status} siblings`, async () => {
      // Given a selected service and an owned sibling with the indicated status.
      const router = makeRouter();
      const provider = {
        list: () => Effect.succeed(status === "missing" ? [] : [{ ...observation, status }]),
      } satisfies Pick<RuntimeProviderShape, "list">;
      // When selected start publishes routes.
      await Effect.runPromise(
        publishGlobalRoutes(router, provider, siblingPlan, { started: new Set([mail]), failed: new Set() }),
      );
      // Then only active owned siblings remain published.
      expect(router.routesByApp.get(plan.id)?.map((route) => route.service)).toEqual(
        status === "stopped" || status === "missing" ? [mail] : [mail, sibling],
      );
    });
  }

  for (const foreign of [
    { appRoot: AbsolutePath.make("/tmp/foreign") },
    { providerId: ProviderId.make("docker") },
    { app: AppId.make("foreign") },
  ]) {
    test(`selected start excludes foreign sibling observations by ${Object.keys(foreign)[0]}`, async () => {
      // Given an active same-name sibling belonging elsewhere.
      const router = makeRouter();
      const provider = { list: () => Effect.succeed([{ ...observation, ...foreign }]) } satisfies Pick<
        RuntimeProviderShape,
        "list"
      >;
      // When selected start publishes routes.
      await Effect.runPromise(
        publishGlobalRoutes(router, provider, siblingPlan, { started: new Set([mail]), failed: new Set() }),
      );
      // Then foreign resources cannot keep the sibling hostname live.
      expect(router.routesByApp.get(plan.id)).toEqual(plan.routes);
    });
  }

  test("disabled router removes routes without applying or listing", async () => {
    // Given disabled routing with a previously published route file.
    const removed: string[] = [];
    const router = {
      ...makeRouter(),
      removeRoutes: (app: AppId) =>
        Effect.sync(() => {
          removed.push(app);
        }),
      applyRoutes: () => Effect.die("Disabled routing must not apply"),
    };
    const provider = { list: () => Effect.die("Disabled routing must not list") };
    // When publication runs.
    const urls = await Effect.runPromise(
      publishGlobalRoutes(
        router,
        provider,
        { ...plan, router: { enabled: false } },
        { started: new Set(), failed: new Set() },
      ),
    );
    // Then the global file is removed and no route URLs are returned.
    expect(removed).toEqual([plan.id]);
    expect(urls.size).toBe(0);
  });

  test("disabled router tolerates route removal failure", async () => {
    // Given a disabled router whose stale file cannot be removed.
    const router = {
      ...makeRouter(),
      removeRoutes: () => Effect.fail(new ProxyError({ proxyId: "test", message: "unavailable" })),
    };
    // When best-effort withdrawal runs.
    const urls = await Effect.runPromise(
      publishGlobalRoutes(
        router,
        { list: () => Effect.die("Must not list") },
        { ...plan, router: { enabled: false } },
        { started: new Set(), failed: new Set() },
      ),
    );
    // Then disabled routing still returns no URLs.
    expect(urls.size).toBe(0);
  });

  test("publication withdraws stale routes when nothing routable is running", async () => {
    // Given no started or observed routed services.
    const router = makeRouter();
    // When publication replaces the global file.
    await Effect.runPromise(
      publishGlobalRoutes(router, { list: () => Effect.succeed([]) }, plan, {
        started: new Set(),
        failed: new Set(),
      }),
    );
    // Then applyRoutes receives an empty route set, not a skipped update.
    expect(router.routesByApp.get(plan.id)).toEqual([]);
  });

  test("publication propagates route application failures unchanged", async () => {
    // Given a router that cannot publish the started service's routes.
    const error = new ProxyApplyError({
      proxyId: "test",
      app: "global",
      message: "unavailable",
      remediation: "Retry route publication.",
    });
    const router = { ...makeRouter(), applyRoutes: () => Effect.fail(error) };
    // When publication attempts to apply the routes.
    const failure = await Effect.runPromise(
      publishGlobalRoutes(router, { list: () => Effect.die("Must not list") }, plan, {
        started: new Set([mail]),
        failed: new Set(),
      }).pipe(Effect.flip),
    );
    // Then the original router error reaches the caller instead of advertised URLs.
    expect(failure).toBe(error);
  });

  test("publication propagates sibling observation failures", async () => {
    // Given the provider cannot observe a routed sibling.
    const error = new ProviderUnavailableError({
      providerId: "lando",
      operation: "list",
      message: "unavailable",
    });
    const router = makeRouter();
    // When publication needs the sibling observation.
    const result = await Effect.runPromise(
      publishGlobalRoutes(router, { list: () => Effect.fail(error) }, plan, {
        started: new Set(),
        failed: new Set(),
      }).pipe(Effect.result),
    );
    // Then the provider error survives and the route file is not replaced.
    expect(result).toMatchObject({ _tag: "Failure", failure: error });
    expect(router.routesByApp.size).toBe(0);
  });
});
