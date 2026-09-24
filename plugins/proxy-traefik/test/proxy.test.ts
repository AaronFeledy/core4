import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { FileNotFoundError } from "@lando/sdk/errors";
import type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import type { SchemeProbe } from "../src/port-acquisition.ts";
import { makeTraefikRouterService, renderTraefikDynamicConfig } from "../src/proxy.ts";

const app = AppId.make("demo");
const routes = [
  {
    hostname: "api.demo.lndo.site",
    priority: 3,
    scheme: "https" as const,
    service: ServiceName.make("api"),
    pathPrefix: "/v1",
    backend: { service: ServiceName.make("api"), protocol: "https" as const, port: 9443 },
  },
  {
    hostname: "web.demo.lndo.site",
    priority: 2,
    scheme: "http" as const,
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 8088 },
  },
];

const highPortOverride: { readonly http: SchemeProbe; readonly https: SchemeProbe } = {
  http: { bind: { kind: "other-error", code: "ECONNREFUSED" }, forward: { kind: "failure" } },
  https: { bind: { kind: "other-error", code: "ECONNREFUSED" }, forward: { kind: "failure" } },
};

const unusedRunner = {
  run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  stream: () => {
    throw new Error("stream is unused");
  },
  streamWithExit: () => {
    throw new Error("streamWithExit is unused");
  },
};

const unusedPrivilege = {
  elevate: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
};

type WatcherDependencies = {
  readonly readTraefikLogs?: () => Effect.Effect<
    { readonly providerId: string; readonly text: string },
    unknown
  >;
  readonly redactDiagnostic?: (text: string) => string;
};

// Keep the persistence fixture inside the plugin test tier, below the engine.
const makeMemoryPluginStateStore = (): PluginStateStore => {
  const values = new Map<string, unknown>();
  return {
    open: <A, I>(spec: PluginStateBucketSpec<A, I>) => {
      const key = [spec.namespace ?? "", spec.key].join("/");
      const current = (): A | null => (values.has(key) ? (values.get(key) as A) : null);
      const bucket: StateBucket<A> = {
        path: AbsolutePath.make(`/tmp/proxy-state/${key}`),
        get: Effect.sync(current),
        set: (value) => Effect.sync(() => void values.set(key, value)),
        update: (f) =>
          Effect.sync(() => {
            const next = f(current());
            values.set(key, next);
            return next;
          }),
        modify: (f) =>
          Effect.sync(() => {
            const [result, next] = f(current());
            values.set(key, next);
            return result;
          }),
        remove: Effect.sync(() => void values.delete(key)),
        exists: Effect.sync(() => values.has(key)),
      };
      return Effect.succeed(bucket);
    },
    withLock: (_key, body) => body,
  };
};

const makeHarness = (
  failingPathSuffix?: string,
  watcherDependencies: WatcherDependencies = {},
  platform: "linux" | "win32" = "linux",
  durableReloadState = false,
) => {
  let failRestart = false;
  const ensured: Array<ReadonlyArray<string>> = [];
  const restarted: string[] = [];
  let running = false;
  const files = new Map<string, string>();
  const stateStore = durableReloadState ? makeMemoryPluginStateStore() : undefined;
  const socketProxy = {
    user: "test",
    hasHostSystemd: () => false,
    exists: () => Effect.succeed(false),
    readText: () => Effect.fail(new Error("missing")),
    processRunner: unusedRunner,
    privilege: unusedPrivilege,
    classifyOverride: highPortOverride,
  };
  const service = makeTraefikRouterService({
    ...watcherDependencies,
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      writeAtomic: (path, content) =>
        failingPathSuffix !== undefined && path.endsWith(failingPathSuffix)
          ? Effect.fail(new Error("injected atomic replacement failure"))
          : Effect.sync(() => void files.set(path, String(content))),
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
      readText: (path) => {
        if (files.has(path)) {
          return Effect.succeed(files.get(path) ?? "");
        }
        if (path.startsWith("/tmp/test-certs/")) {
          return Effect.succeed("test pem");
        }
        return Effect.fail(new FileNotFoundError({ message: "removed", path }));
      },
    },
    paths: { platform, globalAppRoot: "/lando/global" },
    globalApp: {
      restartRunningService: (service) =>
        Effect.gen(function* () {
          if (!running) return false;
          if (failRestart) return yield* Effect.fail(new Error("injected Traefik restart failure"));
          restarted.push(String(service));
          return true;
        }),
      ensureRunning: (services) =>
        Effect.sync(() => {
          running = true;
          ensured.push(services);
          const endpoints = ["http://127.0.0.1:38080", "https://127.0.0.1:38443"];
          return [{ name: "traefik", state: "running", endpoints }];
        }),
    },
    socketProxy,
    ...(stateStore === undefined ? {} : { stateStore }),
  });
  const makePersistedService = (watcherDependencies: WatcherDependencies = {}) =>
    makeTraefikRouterService({
      ...watcherDependencies,
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
        readText: (path) => Effect.succeed(files.get(path) ?? ""),
      },
      paths: { platform, globalAppRoot: "/lando/global" },
      globalApp: {
        ensureRunning: () => Effect.succeed([]),
        restartRunningService: (service) =>
          Effect.sync(() => {
            restarted.push(String(service));
            return true;
          }),
      },
      ...(stateStore === undefined ? {} : { stateStore }),
    });
  return {
    ensured,
    files,
    makePersistedService,
    restarted,
    service,
    setFailRestart: (value: boolean) => {
      failRestart = value;
    },
  };
};

describe("Traefik RouterService", () => {
  test("renders resolved HTTPS and named non-80 backends", () => {
    const rendered = renderTraefikDynamicConfig(routes, app);

    expect(rendered).toContain("https://api.demo.internal:9443");
    expect(rendered).toContain("http://web.demo.internal:8088");
    expect(rendered).toContain("PathPrefix(`/v1`)");
    expect(rendered).toContain("tls: {}");
  });

  test("dials an explicit backend host when the route cannot use .internal DNS", () => {
    const rendered = renderTraefikDynamicConfig(
      [
        {
          hostname: "web.shop.lndo.site",
          priority: 2,
          scheme: "https" as const,
          service: ServiceName.make("web"),
          backend: {
            service: ServiceName.make("web"),
            protocol: "http" as const,
            port: 32768,
            host: "host.lando.internal",
          },
        },
      ],
      AppId.make("shop"),
    );

    expect(rendered).toContain("http://host.lando.internal:32768");
    expect(rendered).not.toContain("web.shop.internal");
  });

  test("namespaces routers and services by app", () => {
    const otherApp = AppId.make("other");
    const objectNames = (content: string) =>
      content.split("\n").flatMap((line) => line.match(/^ {4}([^ ]+):$/)?.[1] ?? []);

    const demoNames = new Set(objectNames(renderTraefikDynamicConfig(routes, app)));
    const otherNames = objectNames(renderTraefikDynamicConfig(routes, otherApp));

    expect(otherNames.every((name) => !demoNames.has(name))).toBe(true);
  });

  test("setup installs the unmatched-route diagnostics before starting the global services", async () => {
    const harness = makeHarness();

    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    expect(harness.files.get("/lando/global/proxy-traefik/diagnostic/nginx.conf")).toBeDefined();
    expect(harness.files.get("/lando/global/proxy-traefik/dynamic/fallback.yml")).toContain(
      "traefik-diagnostics.global.internal:8080",
    );
    expect(harness.ensured).toEqual([["traefik", "traefik-diagnostics"]]);
  });

  test("fallback routing has separate lowest-priority HTTP and HTTPS routers", async () => {
    const harness = makeHarness();

    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    const fallback = harness.files.get("/lando/global/proxy-traefik/dynamic/fallback.yml") ?? "";
    expect(fallback).toContain("entryPoints: [web]");
    expect(fallback).toContain("entryPoints: [websecure]");
    expect(fallback.match(/priority: 1/g)).toHaveLength(2);
    expect(fallback.match(/tls: \{\}/g)).toHaveLength(1);
    expect(fallback).toContain('rule: "PathPrefix(`/`)"');
  });

  test("diagnostic page is private and offers actionable recovery commands", async () => {
    const harness = makeHarness();

    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    const html = harness.files.get("/lando/global/proxy-traefik/diagnostic/404.html") ?? "";
    expect(html).toContain("lando start");
    expect(html).toContain("lando info");
    expect(html).toContain("lando doctor");
    expect(html).not.toContain("$host");
    expect(html).not.toContain("$http_host");
    expect(html).not.toContain("/home/");
  });

  test("prepare carries custom domain and router ports into the first route application", async () => {
    const harness = makeHarness();

    const prepare = harness.service.prepare;
    if (prepare === undefined) throw new Error("Traefik prepare is unavailable");
    await Effect.runPromise(
      prepare({
        defaultDomain: "example.test",
        router: { httpFallbacks: [19080], httpsFallbacks: [19443] },
      }),
    );
    const applied = await Effect.runPromise(harness.service.applyRoutes(routes, app));

    expect(applied.authorities.map(({ port }) => port)).toEqual([19443, 19080]);
    expect([...harness.files.keys()]).toContain(
      "/lando/global/proxy-traefik/dynamic/certs/default-example.test.crt",
    );
    expect(harness.ensured).toEqual([]);
  });

  test("apply reports selected external authorities and atomically replaces stale routes", async () => {
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    const first = await Effect.runPromise(harness.service.applyRoutes(routes, app));
    const second = await Effect.runPromise(harness.service.applyRoutes(routes.slice(1), app));

    expect(first.authorities).toEqual([
      { scheme: "https", hostname: "api.demo.lndo.site", port: 8443 },
      { scheme: "http", hostname: "web.demo.lndo.site", port: 8080 },
    ]);
    expect(second.appliedRoutes).toHaveLength(1);
    expect(harness.files.get("/lando/global/proxy-traefik/dynamic/routes-demo.yml")).not.toContain(
      "api.demo.lndo.site",
    );
    expect(harness.files.get("/lando/global/proxy-traefik/dynamic/fallback.yml")).toContain("priority: 1");
  });

  test("uses acquisition decision ports for live and persisted authorities", async () => {
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    const applied = await Effect.runPromise(harness.service.applyRoutes(routes, app));
    const freshService = harness.makePersistedService();

    const status = await Effect.runPromise(freshService.status);

    expect(applied.authorities.map(({ port }) => port)).toEqual([8443, 8080]);
    expect(status.state).toBe("running");
    expect(status.authorities.map(({ port }) => port)).toEqual([8443, 8080]);
  });

  test("stop durably disables routing and clears configured apps", async () => {
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(harness.service.applyRoutes(routes, app));

    await Effect.runPromise(harness.service.stop);
    const fresh = harness.makePersistedService();

    expect(await Effect.runPromise(fresh.status)).toEqual({
      state: "stopped",
      authorities: [],
      configuredApps: [],
    });
    expect(harness.files.has("/lando/global/proxy-traefik/dynamic/fallback.yml")).toBe(false);
    expect(harness.files.has("/lando/global/proxy-traefik/diagnostic/nginx.conf")).toBe(false);
  });

  test("status skips route files removed after the directory snapshot", async () => {
    const service = makeTraefikRouterService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: {
        mkdir: () => Effect.void,
        writeAtomic: () => Effect.void,
        writeSecretAtomic: () => Effect.void,
        remove: () => Effect.void,
        exists: (path) => Effect.succeed(path.endsWith("/dynamic")),
        readDir: () => Effect.succeed(["routes-removed.yml"]),
        readText: (path) => Effect.fail(new FileNotFoundError({ message: "removed", path })),
      },
      paths: { platform: "linux", globalAppRoot: "/lando/global" },
      globalApp: { ensureRunning: () => Effect.succeed([]) },
    });

    expect(await Effect.runPromise(service.status)).toEqual({
      state: "stopped",
      authorities: [],
      configuredApps: [],
    });
  });

  test("an atomic replacement failure leaves the prior route file untouched", async () => {
    const harness = makeHarness("routes-demo.yml");
    harness.files.set("/lando/global/proxy-traefik/dynamic/routes-demo.yml", "previous");

    const exit = await Effect.runPromiseExit(harness.service.applyRoutes(routes, app));

    expect(exit._tag).toBe("Failure");
    expect(harness.files.get("/lando/global/proxy-traefik/dynamic/routes-demo.yml")).toBe("previous");
  });

  test("an atomic diagnostic replacement failure leaves the prior config untouched", async () => {
    const harness = makeHarness("nginx.conf");
    const path = "/lando/global/proxy-traefik/diagnostic/nginx.conf";
    harness.files.set(path, "previous");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );

    expect(exit._tag).toBe("Failure");
    expect(harness.files.get(path)).toBe("previous");
    expect(harness.ensured).toEqual([]);
  });

  test("reloads running Windows Traefik only when routes change, including removal", async () => {
    const harness = makeHarness(undefined, {}, "win32");
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    await Effect.runPromise(harness.service.applyRoutes(routes, app));
    await Effect.runPromise(harness.service.applyRoutes(routes, app));
    expect(harness.restarted).toEqual(["traefik", "traefik"]);

    await Effect.runPromise(harness.service.applyRoutes(routes.slice(1), app));
    await Effect.runPromise(harness.service.removeRoutes(app));
    await Effect.runPromise(harness.service.removeRoutes(app));
    expect(harness.restarted).toEqual(["traefik", "traefik", "traefik", "traefik"]);
  });

  test("reuses a durable acknowledged HTTP route across fresh Windows service instances", async () => {
    const harness = makeHarness(undefined, {}, "win32", true);
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    const httpRoutes = routes.slice(1);

    await Effect.runPromise(harness.service.applyRoutes(httpRoutes, app));
    const fresh = harness.makePersistedService();
    await Effect.runPromise(fresh.applyRoutes(httpRoutes, app));

    expect(harness.restarted).toEqual(["traefik"]);
  });

  test("does not trust an acknowledgement after route bytes change", async () => {
    const harness = makeHarness(undefined, {}, "win32", true);
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    const httpRoutes = routes.slice(1);
    await Effect.runPromise(harness.service.applyRoutes(httpRoutes, app));
    const routePath = [...harness.files.keys()].find((path) => path.endsWith("routes-demo.yml"));
    if (routePath === undefined) throw new Error("route fixture missing");
    harness.files.set(routePath, "stale route bytes");

    await Effect.runPromise(harness.makePersistedService().applyRoutes(httpRoutes, app));

    expect(harness.restarted).toEqual(["traefik", "traefik"]);
  });

  test("does not acknowledge a failed Windows reload and retries unchanged persisted routes", async () => {
    const harness = makeHarness(undefined, {}, "win32", true);
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    harness.setFailRestart(true);
    const httpRoutes = routes.slice(1);

    const first = await Effect.runPromiseExit(harness.service.applyRoutes(httpRoutes, app));
    expect(first._tag).toBe("Failure");
    expect(harness.restarted).toEqual([]);

    harness.setFailRestart(false);
    await Effect.runPromise(harness.makePersistedService().applyRoutes(httpRoutes, app));
    expect(harness.restarted).toEqual(["traefik"]);
  });

  test("does not restart a Windows router before the global service starts", async () => {
    const harness = makeHarness(undefined, {}, "win32");

    await Effect.runPromise(harness.service.applyRoutes(routes, app));

    expect(harness.restarted).toEqual([]);
  });

  test("keeps Linux route updates on file-provider watch without restarting Traefik", async () => {
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    await Effect.runPromise(harness.service.applyRoutes(routes, app));
    await Effect.runPromise(harness.service.removeRoutes(app));

    expect(harness.restarted).toEqual([]);
  });

  test("removeRoutes is idempotent", async () => {
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(harness.service.applyRoutes(routes, app));

    await Effect.runPromise(harness.service.removeRoutes(app));
    await Effect.runPromise(harness.service.removeRoutes(app));

    expect(harness.files.has("/lando/global/proxy-traefik/dynamic/routes-demo.yml")).toBe(false);
    expect(harness.files.has("/lando/global/proxy-traefik/dynamic/fallback.yml")).toBe(true);
    expect(harness.files.has("/lando/global/proxy-traefik/diagnostic/nginx.conf")).toBe(true);
  });
});

describe("watcher diagnostics", () => {
  const recordPath = "/lando/global/proxy-traefik/watcher-diagnostic.json";
  const markerPath = "/lando/global/proxy-traefik/dynamic/.lando-routing-state";
  const fallbackPath = "/lando/global/proxy-traefik/dynamic/fallback.yml";
  const failureText =
    'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: no space left on device"';
  const readFailure = () => Effect.succeed({ providerId: "lando", text: failureText });
  const previousRecord = JSON.stringify({
    version: 1,
    providerId: "lando",
    failureClass: "inotify-limit",
    observedAt: "2026-09-01T00:00:00.000Z",
    watcherHost: "lando VM",
    detail: "Previous file watcher failure",
  });
  const diagnosticRecord = Schema.Struct({
    version: Schema.Literal(1),
    providerId: Schema.Literal("lando"),
    failureClass: Schema.Literal("inotify-limit"),
    observedAt: Schema.String,
    watcherHost: Schema.String,
    detail: Schema.String,
  });
  const watcherFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(exit._tag).toBe("Failure");
    const failure = Exit.match(exit, {
      onFailure: (cause) => Option.getOrUndefined(Cause.failureOption(cause)),
      onSuccess: () => undefined,
    });
    expect(failure).toMatchObject({ _tag: "RouterWatcherError" });
    return Schema.decodeUnknownSync(
      Schema.Struct({
        _tag: Schema.Literal("RouterWatcherError"),
        failureClass: Schema.Literal("inotify-limit"),
        proxyId: Schema.Literal("traefik"),
        watcherHost: Schema.NonEmptyTrimmedString,
        detail: Schema.NonEmptyTrimmedString,
        remediation: Schema.NonEmptyTrimmedString,
      }),
    )(failure);
  };
  const readRecord = (files: ReadonlyMap<string, string>) => {
    const content = files.get(recordPath);
    expect(content).toBeDefined();
    const parsed: unknown = JSON.parse(content ?? "null");
    return Schema.decodeUnknownSync(diagnosticRecord)(parsed);
  };

  test("fails setup with a tagged diagnostic when inotify watches are exhausted", async () => {
    // Given
    const harness = makeHarness(undefined, { readTraefikLogs: readFailure });
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then
    const failure = watcherFailure(exit);
    expect(failure.failureClass).toBe("inotify-limit");
    expect(failure.proxyId).toBe("traefik");
    expect(harness.files.has(fallbackPath)).toBe(false);
    expect(harness.files.has(markerPath)).toBe(false);
  });

  test("persists versioned evidence when the file watcher fails", async () => {
    // Given
    const harness = makeHarness(undefined, { readTraefikLogs: readFailure });
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then
    const record = readRecord(harness.files);
    expect(record).toMatchObject({ version: 1, providerId: "lando", failureClass: "inotify-limit" });
    expect(record.observedAt).toEqual(expect.any(String));
    expect(record.watcherHost).toEqual(expect.any(String));
    expect(record.detail).toEqual(expect.any(String));
    expect(exit._tag).toBe("Failure");
  });

  test("removes a stale routing marker when the file watcher fails", async () => {
    // Given
    const harness = makeHarness(undefined, { readTraefikLogs: readFailure });
    harness.files.set(markerPath, "http://127.0.0.1:8080\nhttps://127.0.0.1:8443");
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then: leaving it would let the router report running while the doctor check reports failure.
    expect(harness.files.has(markerPath)).toBe(false);
    expect(exit._tag).toBe("Failure");
  });

  test("clears prior evidence and enables routing when logs are healthy", async () => {
    // Given
    const harness = makeHarness(undefined, {
      readTraefikLogs: () =>
        Effect.succeed({ providerId: "lando", text: 'level=info msg="Configuration loaded from flags."' }),
    });
    harness.files.set(recordPath, previousRecord);
    // When
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    // Then
    expect(harness.files.has(recordPath)).toBe(false);
    expect(harness.files.has(markerPath)).toBe(true);
  });

  test("preserves evidence when no log reader is supplied", async () => {
    // Given: this preserves today's behavior when the provider cannot supply logs.
    const harness = makeHarness();
    harness.files.set(recordPath, previousRecord);
    // When
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    // Then
    expect(harness.files.get(recordPath)).toBe(previousRecord);
  });

  test("preserves evidence without failing start or retrying when logs are unreadable", async () => {
    // Given
    let reads = 0;
    const harness = makeHarness(undefined, {
      readTraefikLogs: () => {
        reads += 1;
        return Effect.fail(new Error("boom"));
      },
    });
    harness.files.set(recordPath, previousRecord);
    // When
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    // Then: an unreadable stream must never clear evidence or fail a start.
    expect(harness.files.get(recordPath)).toBe(previousRecord);
    expect(reads).toBe(1);
  });

  test("clears prior evidence and restores routing when startup revalidation sees healthy logs", async () => {
    // Given: acquisition is persisted, but a previous watcher failure disabled routing.
    const harness = makeHarness(undefined, {
      readTraefikLogs: () =>
        Effect.succeed({ providerId: "lando", text: 'level=info msg="Configuration loaded from flags."' }),
    });
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    harness.files.set(recordPath, previousRecord);
    harness.files.delete(markerPath);
    harness.files.delete(fallbackPath);
    // When
    await Effect.runPromise(harness.service.revalidateStartup);
    // Then
    expect(harness.files.has(recordPath)).toBe(false);
    expect(harness.files.has(markerPath)).toBe(true);
    expect(harness.files.get(markerPath)).toBe("http://127.0.0.1:8080\nhttps://127.0.0.1:8443");
    expect(harness.files.has(fallbackPath)).toBe(true);
    expect(harness.files.get(fallbackPath)).toContain("http://traefik-diagnostics.global.internal:8080");
    expect(harness.files.get(fallbackPath)).toContain("entryPoints: [web]");
    expect(harness.files.get(fallbackPath)).toContain("entryPoints: [websecure]");
  });

  test("refreshes prior evidence when startup revalidation sees the same watcher failure", async () => {
    // Given
    const harness = makeHarness(undefined, { readTraefikLogs: readFailure });
    harness.files.set(recordPath, previousRecord);
    const previous = readRecord(harness.files);
    // When
    const exit = await Effect.runPromiseExit(harness.service.revalidateStartup);
    // Then
    const failure = watcherFailure(exit);
    expect(failure.failureClass).toBe("inotify-limit");
    const record = readRecord(harness.files);
    expect(record.failureClass).toBe("inotify-limit");
    expect(Date.parse(record.observedAt)).toBeGreaterThan(Date.parse(previous.observedAt));
  });

  test("preserves evidence when startup revalidation has no log reader", async () => {
    // Given
    const harness = makeHarness();
    harness.files.set(recordPath, previousRecord);
    // When
    await Effect.runPromise(harness.service.revalidateStartup);
    // Then
    expect(harness.files.get(recordPath)).toBe(previousRecord);
  });

  test("preserves evidence when startup revalidation cannot read logs", async () => {
    // Given
    const harness = makeHarness(undefined, {
      readTraefikLogs: () => Effect.fail(new Error("logs unavailable")),
    });
    harness.files.set(recordPath, previousRecord);
    // When
    await Effect.runPromise(harness.service.revalidateStartup);
    // Then
    expect(harness.files.get(recordPath)).toBe(previousRecord);
  });

  test("restores persisted advertised ports when a fresh service revalidates startup", async () => {
    // Given: only the shared filesystem carries the first service's acquisition decision.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    const advertised = harness.files.get(markerPath) ?? "";
    expect(advertised).toMatch(/^http:\/\/127\.0\.0\.1:\d+\nhttps:\/\/127\.0\.0\.1:\d+$/u);
    const advertisedPorts = advertised.split("\n").map((endpoint) => new URL(endpoint).port);
    harness.files.delete(markerPath);
    harness.files.delete(fallbackPath);
    const freshService = harness.makePersistedService({
      readTraefikLogs: () =>
        Effect.succeed({ providerId: "lando", text: 'level=info msg="Configuration loaded from flags."' }),
    });
    // When
    await Effect.runPromise(freshService.revalidateStartup);
    // Then
    const restored = harness.files.get(markerPath) ?? "";
    expect(restored).toBe(advertised);
    expect(restored.split("\n").map((endpoint) => new URL(endpoint).port)).toEqual(advertisedPorts);
  });

  test("redacts pattern-matched secrets from the failure and persisted detail", async () => {
    // Given: the secrets profile masks TOKEN assignments without seeded values.
    const secret = "watcher-test-credential-123456";
    const harness = makeHarness(undefined, {
      readTraefikLogs: () => Effect.succeed({ providerId: "lando", text: `${failureText} TOKEN=${secret}` }),
    });
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then
    const failure = watcherFailure(exit);
    const record = readRecord(harness.files);
    for (const detail of [failure.detail, record.detail]) {
      expect(detail).not.toContain(secret);
      expect(detail).toContain("[redacted]");
    }
  });

  test("offers non-privileged recovery before host tuning when the watcher fails", async () => {
    // Given
    const harness = makeHarness(undefined, { readTraefikLogs: readFailure });
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then
    const { remediation } = watcherFailure(exit);
    const firstSentence = remediation.split(/[.!?](?:\s|$)/u)[0] ?? "";
    expect(firstSentence.trim().length).toBeGreaterThan(0);
    expect(firstSentence).not.toMatch(/sysctl|sudo/iu);
  });

  test("still fails with RouterWatcherError when diagnostic persistence fails", async () => {
    // Given: watcher evidence cannot be written.
    const harness = makeHarness("watcher-diagnostic.json", { readTraefikLogs: readFailure });
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then: the tagged watcher error is preserved even if the record is missing.
    const failure = watcherFailure(exit);
    expect(failure.failureClass).toBe("inotify-limit");
    expect(harness.files.has(recordPath)).toBe(false);
    expect(harness.files.has(markerPath)).toBe(false);
  });

  test("redacts URL userinfo that spans the detail bound", async () => {
    // Given: a matching line whose userinfo secret starts before char 300 and whose @ is after it.
    const secret = "watcher-url-secret-credential-ABCDEFGH";
    const head =
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for http://user:';
    const padding = "x".repeat(280 - head.length);
    const logText = `${head}${padding}${secret}@example.com/etc/traefik/dynamic: no space left on device"`;
    expect(logText.indexOf("@")).toBeGreaterThan(300);
    const harness = makeHarness(undefined, {
      readTraefikLogs: () => Effect.succeed({ providerId: "lando", text: logText }),
    });
    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })),
    );
    // Then
    const failure = watcherFailure(exit);
    const record = readRecord(harness.files);
    for (const detail of [failure.detail, record.detail]) {
      expect(detail).not.toContain(secret);
      expect(detail).toContain("[redacted]");
    }
  });

  test("reads logs once after services start and before routing files are written", async () => {
    // Given
    let reads = 0;
    const harness = makeHarness(undefined, {
      readTraefikLogs: () =>
        Effect.sync(() => {
          reads += 1;
          expect(harness.ensured).toEqual([["traefik", "traefik-diagnostics"]]);
          expect(harness.files.has(fallbackPath)).toBe(false);
          expect(harness.files.has(markerPath)).toBe(false);
          return { providerId: "lando", text: 'level=info msg="Configuration loaded from flags."' };
        }),
    });
    // When
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    // Then
    expect(reads).toBe(1);
    expect(harness.files.has(fallbackPath)).toBe(true);
    expect(harness.files.has(markerPath)).toBe(true);
  });
});
