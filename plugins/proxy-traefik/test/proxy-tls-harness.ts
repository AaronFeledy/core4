import type { CaError } from "@lando/sdk/errors";
import { type RoutePlan, ServiceName } from "@lando/sdk/schema";
import type { CertificateAuthorityShape, CertificateSpec } from "@lando/sdk/services";
import { Effect, Redacted } from "effect";
import { makeTraefikRouterService } from "../src/proxy.ts";
import type { TraefikProxyDependencies } from "../src/proxy-types.ts";
import { makeApplyRuntime } from "./apply-runtime-fixture.ts";
import { routeOwner } from "./route-owner-fixture.ts";

export const app = routeOwner("demo/app");
export const httpsRoutes: ReadonlyArray<RoutePlan> = [
  {
    hostname: "z.demo.lndo.site",
    priority: 2,
    scheme: "https",
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
  },
  {
    hostname: "a.demo.lndo.site",
    priority: 3,
    scheme: "both",
    service: ServiceName.make("api"),
    backend: { service: ServiceName.make("api"), protocol: "http", port: 8081 },
  },
];

export const makeHarness = (issueFailure?: CaError) => {
  const calls: CertificateSpec[] = [];
  const operations: string[] = [];
  const files = new Map<string, string>();
  const certificateAuthority: CertificateAuthorityShape = {
    id: "test-ca",
    setup: () => Effect.sync(() => void operations.push("ca:setup")),
    root: Effect.succeed({ certificate: "issuer cert" }),
    issueCert: (spec) => {
      calls.push(spec);
      if (issueFailure !== undefined) return Effect.fail(issueFailure);
      const prefix = spec.cn.startsWith("*.") ? "default" : "app";
      return Effect.succeed({
        certificate: `${prefix} cert`,
        privateKey: Redacted.make(`${prefix} key`),
        root: { certificate: "issuer cert" },
      });
    },
  };
  const runtime = makeApplyRuntime(files);
  const dependencies: TraefikProxyDependencies = {
    readTraefikState: () => Effect.succeed("running"),
    httpClient: runtime.httpClient,
    certificateAuthority,
    probeBind: () => Effect.succeed({ kind: "success" }),
    probeForward: () => Effect.succeed({ kind: "success" }),
    fileSystem: {
      mkdir: (path) => Effect.sync(() => void operations.push(`mkdir:${path}`)),
      writeAtomic: (path, content) =>
        Effect.sync(() => {
          operations.push(`write:${path}`);
          files.set(path, String(content));
        }),
      writeSecretAtomic: (path, content) =>
        Effect.sync(() => {
          operations.push(`write-secret:${path}`);
          files.set(path, String(content));
        }),
      remove: (path) =>
        Effect.sync(() => {
          operations.push(`remove:${path}`);
          files.delete(path);
        }),
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
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: {
      ownedPublishPorts: runtime.ownedPublishPorts,
      ensureRunning: () =>
        Effect.succeed([
          {
            name: "traefik",
            state: "running",
            endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
          },
        ]),
    },
  };
  const makeService = () => makeTraefikRouterService(dependencies);
  return { calls, files, operations, dependencies, runtime, service: makeService(), makeService };
};
