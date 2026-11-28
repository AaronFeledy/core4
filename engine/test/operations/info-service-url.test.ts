import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, ProxyAuthority, RoutePlan } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { infoForPlan } from "../../src/operations/info.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const route = (hostname: string, scheme: RoutePlan["scheme"], pathPrefix?: string): RoutePlan => ({
  hostname,
  priority: 2,
  scheme,
  service: web.name,
  ...(pathPrefix === undefined ? {} : { pathPrefix }),
  backend: { service: web.name, protocol: "http", port: 3000 },
});

const plain = route("plain.demo.lndo.site", "http");
const wildcard = route("*.demo.lndo.site", "both");
const secure = route("Web.Demo.lndo.site", "both", "/api");

const authority = (hostname: string, scheme: ProxyAuthority["scheme"]): ProxyAuthority => ({
  hostname: hostname.toLowerCase(),
  scheme,
  port: scheme === "https" ? 38443 : 38080,
});
const everyAuthority = [plain, wildcard, secure].flatMap((candidate) => [
  authority(candidate.hostname, "http"),
  authority(candidate.hostname, "https"),
]);

const urlOf = async (input: {
  readonly routes: readonly RoutePlan[];
  readonly authorities?: readonly ProxyAuthority[];
  readonly routerEnabled?: boolean;
  readonly applied?: readonly RoutePlan[] | "unreadable";
  readonly run?: "running" | "exited";
}) => {
  const planned: AppPlan = {
    ...plan,
    services: {
      [web.name]: { ...web, endpoints: [{ kind: "internal", protocol: "http", port: 3000 }] },
    },
    routes: [...input.routes],
    router: { enabled: input.routerEnabled ?? true },
  };
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: planned.id,
        service: web.name,
        providerId: planned.provider,
        status: input.run ?? "running",
        publications: { status: "unknown" as const },
      }),
  };
  const applied = input.applied;
  const result = await Effect.runPromise(
    infoForPlan(planned).pipe(
      Effect.provideService(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({
          select: () => Effect.succeed(provider),
          readAppliedPlanStrict: () =>
            applied === "unreadable"
              ? Effect.fail(
                  new ProviderUnavailableError({
                    providerId: planned.provider,
                    operation: "applied-state.read",
                    message: "unreadable",
                    remediation: "rewrite it",
                    details: { path: "/state/applied.json" },
                  }),
                )
              : Effect.succeed(applied === undefined ? undefined : { ...planned, routes: [...applied] }),
        }),
      ),
      Effect.provide(
        Layer.succeed(RouterService, {
          ...makeTestRouterService(),
          observeRoutes: () =>
            Effect.succeed({
              configuredAuthorities: [...(input.authorities ?? everyAuthority)],
              observation: { status: "unknown" as const },
            }),
        }),
      ),
    ),
  );
  return result.services[0];
};

describe("service url", () => {
  test("names the first concrete https route, skipping wildcards and earlier http routes", async () => {
    expect((await urlOf({ routes: [plain, wildcard, secure] }))?.url).toBe(
      "https://web.demo.lndo.site:38443/api",
    );
  });

  test("falls back to the first concrete http route", async () => {
    expect((await urlOf({ routes: [wildcard, plain] }))?.url).toBe("http://plain.demo.lndo.site:38080");
  });

  test("is absent while the primary route has no router authority", async () => {
    const row = await urlOf({ routes: [plain, secure], authorities: [authority(plain.hostname, "http")] });
    expect(row?.url).toBeUndefined();
    expect(row?.routes).toMatchObject([
      { binding: "assigned", hostMatch: "exact" },
      { binding: "pending", hostMatch: "exact" },
      { binding: "pending", hostMatch: "exact" },
    ]);
  });

  test("is absent when the router is disabled", async () => {
    expect(await urlOf({ routes: [secure], routerEnabled: false })).not.toHaveProperty("url");
  });

  test("is absent without a concrete route", async () => {
    const row = await urlOf({ routes: [wildcard] });
    expect(row).not.toHaveProperty("url");
    expect(row?.connections.filter((connection) => connection.scope === "host")).toEqual([]);
    const routes = row?.routes;
    expect(routes).toMatchObject([
      { host: "*.demo.lndo.site", hostMatch: "pattern", protocol: "http", port: 38080 },
      { host: "*.demo.lndo.site", hostMatch: "pattern", protocol: "https", port: 38443 },
    ]);
    expect(routes?.map((connection) => "url" in connection)).toEqual([false, false]);
  });

  test("keeps hostname patterns pending when the router reports no port", async () => {
    const row = await urlOf({ routes: [wildcard], authorities: [] });
    const routes = row?.routes;
    expect(routes).toMatchObject([
      { binding: "pending", hostMatch: "pattern", protocol: "http" },
      { binding: "pending", hostMatch: "pattern", protocol: "https" },
    ]);
    expect(routes?.map((connection) => "port" in connection || "url" in connection)).toEqual([false, false]);
  });

  test("keeps the primary exact URL when the configured route is inactive", async () => {
    const row = await urlOf({ routes: [wildcard, secure], run: "exited" });
    expect(row?.url).toBe("https://web.demo.lndo.site:38443/api");
    expect(
      row?.routes.find((report) => report.hostMatch === "exact" && report.protocol === "https"),
    ).toMatchObject({ binding: "assigned", state: "inactive" });
  });

  test("follows the applied route table over the shown plan", async () => {
    expect((await urlOf({ routes: [secure, plain], applied: [plain] }))?.url).toBe(
      "http://plain.demo.lndo.site:38080",
    );
    expect((await urlOf({ routes: [secure, plain] }))?.url).toBe("https://web.demo.lndo.site:38443/api");
  });

  test("is absent when the applied state cannot be read", async () => {
    expect(await urlOf({ routes: [secure], applied: "unreadable" })).not.toHaveProperty("url");
  });
});
