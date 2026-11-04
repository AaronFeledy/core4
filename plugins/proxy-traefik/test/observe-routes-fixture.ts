import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { AcquisitionState } from "../src/port-acquisition-state.ts";
import { acquisitionStateFile, defaultDomainFile } from "../src/proxy-paths.ts";
import type { TraefikProxyDependencies } from "../src/proxy-types.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";

export const app = AppId.make("demo");
export const route: RoutePlan = {
  hostname: "demo.example.test",
  scheme: "both",
  pathPrefix: "/api",
  priority: 200000,
  service: ServiceName.make("web"),
  backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
};
export const acquisition: AcquisitionState = {
  mode: "direct",
  httpPort: 38080,
  httpsPort: 38443,
  notices: [],
  fingerprint: { bindAddress: "127.0.0.1", http: [38080], https: [38443] },
};
export const liveGraph = () => ({
  routers: {
    "route-demo-7-http@file": {
      rule: 'Host("demo.example.test") && PathPrefix("/api")',
      service: "route-demo-7",
      entryPoints: ["web"],
      using: ["web"],
      priority: 200000,
      status: "enabled",
    },
    "route-demo-7-https@file": {
      rule: 'Host("demo.example.test") && PathPrefix("/api")',
      service: "route-demo-7",
      entryPoints: ["websecure"],
      using: ["websecure"],
      priority: 200000,
      tls: {},
      status: "enabled",
    },
  },
  services: {
    "route-demo-7@file": {
      loadBalancer: {
        servers: [{ url: "http://web.demo.internal:8080" }],
        passHostHeader: true,
        responseForwarding: { flushInterval: "100ms" },
      },
      status: "enabled",
      usedBy: ["route-demo-7-http@file", "route-demo-7-https@file"],
      serverStatus: { "http://web.demo.internal:8080": "UP" },
    },
  },
});

export const makeObserveFixture = (payload: unknown = liveGraph()) => {
  const paths = { platform: "linux" as const, globalAppRoot: "/lando/global" };
  const files = new Map<string, string>([
    [acquisitionStateFile(paths), JSON.stringify(acquisition)],
    [defaultDomainFile(paths), "example.test\n"],
  ]);
  const mutations: string[] = [];
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly host: string | undefined;
  }> = [];
  const probes: Array<readonly [string, number, string]> = [];
  const ownedRequests: number[][] = [];
  const httpClient = HttpClient.make((request) => {
    requests.push({ method: request.method, url: request.url, host: request.headers.host });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload)));
  });
  const mutate = (name: string) =>
    Effect.sync(() => {
      mutations.push(name);
    });
  const dependencies: TraefikProxyDependencies = {
    paths,
    httpClient,
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      readText: (path) => (files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail("missing")),
      exists: (path) => Effect.succeed(files.has(path)),
      readDir: () => Effect.succeed([]),
      mkdir: () => mutate("mkdir"),
      writeAtomic: () => mutate("write"),
      writeSecretAtomic: () => mutate("secret"),
      remove: () => mutate("remove"),
    },
    probeForward: (host, port, scheme) =>
      Effect.sync(() => {
        probes.push([host, port, scheme]);
        return { kind: "success" as const };
      }),
    globalApp: {
      ensureProviderReady: mutate("provider-ready"),
      ensureRunning: () => mutate("start").pipe(Effect.as([])),
      restartRunningService: () => mutate("restart").pipe(Effect.as(true)),
      ownedPublishPorts: (_service, ports) =>
        Effect.sync(() => {
          ownedRequests.push([...ports]);
          return ports;
        }),
    },
  };
  return {
    paths,
    files,
    mutations,
    requests,
    probes,
    ownedRequests,
    dependencies,
    service: makeTraefikRouterService(dependencies),
  };
};

export const makeAckStore = (mutations: string[]): PluginStateStore => {
  const values = new Map<string, unknown>();
  return {
    withLock: (_key, body) =>
      Effect.sync(() => {
        mutations.push("lock");
      }).pipe(Effect.andThen(body)),
    open: (spec) => {
      const current = () =>
        values.has(spec.key)
          ? Schema.decodeUnknownSync(Schema.toType(spec.schema))(values.get(spec.key))
          : null;
      return Effect.succeed({
        path: AbsolutePath.make(`/test/${spec.key}`),
        get: Effect.sync(current),
        exists: Effect.sync(() => values.has(spec.key)),
        set: (value) =>
          Effect.sync(() => {
            mutations.push("ack:set");
            values.set(spec.key, value);
          }),
        remove: Effect.sync(() => {
          mutations.push("ack:remove");
          values.delete(spec.key);
        }),
        update: (f) =>
          Effect.sync(() => {
            mutations.push("ack:update");
            const value = f(current());
            values.set(spec.key, value);
            return value;
          }),
        modify: (f) =>
          Effect.sync(() => {
            mutations.push("ack:modify");
            const [result, value] = f(current());
            values.set(spec.key, value);
            return result;
          }),
      });
    },
  };
};
