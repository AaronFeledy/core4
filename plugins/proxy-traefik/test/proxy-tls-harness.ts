import { Effect } from "effect";

import type { CaError } from "@lando/sdk/errors";
import { AppId, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import type { CertificateAuthorityShape, CertificateSpec } from "@lando/sdk/services";

import { makeTraefikRouterService } from "../src/proxy.ts";

export const app = AppId.make("demo/app");
export const httpsRoutes: ReadonlyArray<RoutePlan> = [
  {
    hostname: "z.demo.lndo.site",
    scheme: "https",
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
  },
  {
    hostname: "a.demo.lndo.site",
    scheme: "both",
    service: ServiceName.make("api"),
    backend: { service: ServiceName.make("api"), protocol: "http", port: 8081 },
  },
];

export const makeHarness = (issueFailure?: CaError) => {
  const calls: CertificateSpec[] = [];
  const operations: string[] = [];
  const files = new Map<string, string>([
    ["/issued/default.crt", "default cert"],
    ["/issued/default.key", "default key"],
    ["/issued/app.crt", "app cert"],
    ["/issued/app.key", "app key"],
  ]);
  const certificateAuthority: CertificateAuthorityShape = {
    id: "test-ca",
    setup: () => Effect.sync(() => void operations.push("ca:setup")),
    issueCert: (spec) => {
      calls.push(spec);
      if (issueFailure !== undefined) return Effect.fail(issueFailure);
      const prefix = spec.cn.startsWith("*.") ? "default" : "app";
      return Effect.succeed({
        certPath: `/issued/${prefix}.crt`,
        keyPath: `/issued/${prefix}.key`,
        caPath: "/issued/ca.crt",
      });
    },
  };
  const service = makeTraefikRouterService({
    certificateAuthority,
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
      ensureRunning: () =>
        Effect.succeed([
          {
            name: "traefik",
            state: "running",
            endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
          },
        ]),
    },
  });
  return { calls, files, operations, service };
};
