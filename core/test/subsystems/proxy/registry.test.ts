import { describe, expect, test } from "bun:test";
import { Context, Effect, Either, Layer, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { ProxyApplyError, ProxyError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AppId, GlobalConfig, PluginManifest } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  ConfigService,
  PathsService,
  RouterService,
  type RouterServiceShape,
} from "@lando/sdk/services";

import {
  CertificateAuthorityResolver,
  type CertificateAuthorityResolverShape,
  type RouterServiceRegistration,
  RouterServiceRegistry,
  SelectedRouterServiceLive,
  makeRouterServiceRegistry,
  makeRouterServiceRegistryLive,
} from "../../../src/testing/engine-layers.ts";
import { provideTestRuntime } from "../../../src/testing/test-runtime.ts";

const service = (id: string): RouterServiceShape => ({
  id,
  capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
  setup: () => Effect.void,
  applyRoutes: (routes, app) => Effect.succeed({ app, appliedRoutes: routes, authorities: [] }),
  removeRoutes: () => Effect.void,
  status: Effect.succeed({ state: "running", authorities: [], configuredApps: [] }),
  stop: Effect.void,
});

const registration = (
  id: string,
  defaultFor?: RouterServiceRegistration["defaultFor"],
): RouterServiceRegistration => ({
  id,
  layer: Layer.succeed(RouterService, service(id)),
  ...(defaultFor === undefined ? {} : { defaultFor }),
});

const config = Schema.decodeSync(GlobalConfig)({});
const configLayer = Layer.succeed(ConfigService, {
  load: Effect.succeed(config),
  get: (key) => Effect.succeed(config[key]),
});
const pathsLayer = Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} }));

const proxyModule = (id: string, layer: RouterServiceRegistration["layer"]): LandoPluginModule => ({
  name: "@lando/proxy-test",
  manifest: Schema.decodeSync(PluginManifest)({
    name: "@lando/proxy-test",
    version: "1.0.0",
    api: 4,
    contributes: { routerServices: [{ id, module: "./proxy.ts" }] },
  }),
  routerServices: new Map([[id, layer]]),
});

const runInjectedSelection = (modules: ReadonlyArray<LandoPluginModule>, explicit: string) =>
  Effect.runPromise(
    Effect.flatMap(RouterServiceRegistry, (registry) => registry.select({ explicit })).pipe(
      Effect.provide(
        makeRouterServiceRegistryLive(modules).pipe(Layer.provide(Layer.merge(configLayer, pathsLayer))),
      ),
      Effect.either,
    ),
  );

const buildSelectedProxy = (
  registry: Context.Tag.Service<typeof RouterServiceRegistry>,
  resolver: CertificateAuthorityResolverShape,
) =>
  Effect.scoped(
    Effect.map(
      Layer.build(
        SelectedRouterServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(RouterServiceRegistry, registry),
              Layer.succeed(CertificateAuthorityResolver, resolver),
              Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: "/tmp/proxy-registry-test" })),
              provideTestRuntime({ bootstrap: "global" }),
            ),
          ),
        ),
      ),
      (context) => Context.get(context, RouterService),
    ),
  );

describe("RouterService registry selection", () => {
  test("resolves an id from an injected plugin descriptor module", async () => {
    // Given
    const fakeLayer = Layer.succeed(RouterService, service("fake"));

    // When
    const result = await runInjectedSelection([proxyModule("fake", fakeLayer)], "fake");

    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.layer).toBe(fakeLayer);
  });

  test("preserves the typed selection error for an id absent from injected modules", async () => {
    // Given
    const fakeLayer = Layer.succeed(RouterService, service("fake"));

    // When
    const result = await runInjectedSelection([proxyModule("fake", fakeLayer)], "missing");

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ProxyError);
      expect(result.left.proxyId).toBe("missing");
      expect(result.left.message).toBe("Router service missing is not installed.");
    }
  });

  test("selects the sole bundled default", async () => {
    const registry = makeRouterServiceRegistry({
      registrations: [registration("traefik")],
      configured: Effect.succeed(undefined),
      platform: "linux",
    });

    const selected = await Effect.runPromise(registry.select());

    expect(selected.id).toBe("traefik");
  });

  test("selects the Linux manifest default for a WSL host", async () => {
    // Given
    const registry = makeRouterServiceRegistry({
      registrations: [
        registration("traefik", { platform: ["linux"] }),
        registration("remote", { platform: ["darwin"] }),
      ],
      configured: Effect.succeed(undefined),
      platform: "wsl",
    });

    // When
    const selected = await Effect.runPromise(registry.select());

    // Then
    expect(selected.id).toBe("traefik");
  });

  test("explicit test contribution overrides a bundled default", async () => {
    const registry = makeRouterServiceRegistry({
      registrations: [registration("traefik", { platform: ["linux"] }), registration("test")],
      configured: Effect.succeed("traefik"),
      platform: "linux",
    });

    const selected = await Effect.runPromise(registry.select({ explicit: "test" }));

    expect(selected.id).toBe("test");
  });

  test("global config wins before manifest defaults", async () => {
    const registry = makeRouterServiceRegistry({
      registrations: [registration("traefik", { platform: ["linux"] }), registration("remote")],
      configured: Effect.succeed("remote"),
      platform: "linux",
    });

    const selected = await Effect.runPromise(registry.select());

    expect(selected.id).toBe("remote");
  });

  test("selected proxy receives a CA that resolves only when the proxy uses it", async () => {
    // Given
    let resolutions = 0;
    const requiringCa = Layer.effect(
      RouterService,
      Effect.map(CertificateAuthority, (authority) => ({
        ...service("needs-ca"),
        applyRoutes: (routes, app) =>
          authority.issueCert({ cn: "proxy.test", sans: ["proxy.test"] }).pipe(
            Effect.as({ app, appliedRoutes: routes, authorities: [] }),
            Effect.mapError(
              (cause) =>
                new ProxyApplyError({
                  message: "proxy CA failed",
                  proxyId: "needs-ca",
                  app: String(app),
                  remediation: "Run lando setup.",
                  cause,
                }),
            ),
          ),
      })),
    );
    const resolver: CertificateAuthorityResolverShape = {
      resolve: Effect.sync(() => {
        resolutions += 1;
        return {
          id: "test-ca",
          setup: () => Effect.void,
          issueCert: () => Effect.succeed({ certPath: "/cert", keyPath: "/key", caPath: "/ca" }),
        };
      }),
    };
    const selected = await Effect.runPromise(
      buildSelectedProxy(
        {
          list: Effect.succeed(["needs-ca"]),
          select: () => Effect.succeed({ id: "needs-ca", layer: requiringCa }),
        },
        resolver,
      ),
    );
    expect(resolutions).toBe(0);

    // When
    await Effect.runPromise(selected.applyRoutes([], AppId.make("demo")));

    // Then
    expect(resolutions).toBe(1);
  });

  test("unavailable selected proxy builds without resolving a certificate authority", async () => {
    // Given
    let resolutions = 0;
    const resolver: CertificateAuthorityResolverShape = {
      resolve: Effect.sync(() => {
        resolutions += 1;
        return {
          id: "unused-ca",
          setup: () => Effect.void,
          issueCert: () => Effect.succeed({ certPath: "/cert", keyPath: "/key", caPath: "/ca" }),
        };
      }),
    };

    // When
    const selected = await Effect.runPromise(
      buildSelectedProxy(
        {
          list: Effect.succeed([]),
          select: () =>
            Effect.fail(
              new ProxyError({
                message: "selection must not run",
                proxyId: "unavailable",
              }),
            ),
        },
        resolver,
      ),
    );

    // Then
    expect(selected.id).toBe("unavailable");
    expect(resolutions).toBe(0);
  });
});
