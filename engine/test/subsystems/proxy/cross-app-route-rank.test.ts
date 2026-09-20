import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { makeTraefikRouterService } from "@lando/proxy-traefik";
import { AppId, RoutePlan, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { prioritizeRoutes } from "../../../src/planner/route-identity.ts";

const makeHarness = () => {
  const files = new Map<string, string>();
  const service = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      exists: (path) =>
        Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
      readDir: (path) =>
        Effect.succeed(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1)),
        ),
      readText: (path) => Effect.succeed(files.get(path) ?? ""),
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
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
  return { files, service };
};

const route = (hostname: string, pathPrefix?: string): RoutePlan =>
  Schema.decodeUnknownSync(RoutePlan)({
    hostname,
    scheme: "http",
    service: ServiceName.make("appserver"),
    backend: { service: ServiceName.make("appserver"), protocol: "http", port: 80 },
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
  });

const DynamicConfig = Schema.Struct({
  http: Schema.Struct({
    routers: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({ rule: Schema.String, priority: Schema.Number }),
    }),
  }),
});

const readRouters = (files: ReadonlyMap<string, string>) => {
  const appliedFiles = [...files].filter(([path]) => path.includes("/proxy-traefik/dynamic/routes-"));
  expect(appliedFiles).toHaveLength(2);
  for (const [path] of appliedFiles) {
    expect(path.slice(0, path.lastIndexOf("/") + 1)).toBe("/lando/global/proxy-traefik/dynamic/");
  }
  return appliedFiles.flatMap(([, content]) =>
    Object.values(Schema.decodeUnknownSync(DynamicConfig)(Bun.YAML.parse(content)).http.routers),
  );
};

const priorityForRule = (
  routers: readonly { readonly rule: string; readonly priority: number }[],
  rule: string,
): number => {
  const matches = routers.filter((router) => router.rule === rule);
  expect(matches).toHaveLength(1);
  return Schema.decodeUnknownSync(Schema.Number)(matches[0]?.priority);
};

test("an exact host in a one-route app outranks a wildcard in a many-route app", async () => {
  // Given
  const { files, service } = makeHarness();
  const many = prioritizeRoutes([route("*.shared.test"), route("*.y.test"), route("*.z.test")]);
  const one = prioritizeRoutes([route("www.shared.test")]);

  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* service.applyRoutes(many, AppId.make("many"));
      yield* service.applyRoutes(one, AppId.make("one"));
    }),
  );

  // Then
  const routers = readRouters(files);
  const wildcardPriority = priorityForRule(routers, "HostRegexp(`^[a-z0-9-]+\\.shared\\.test$`)");
  const exactPriority = priorityForRule(routers, "Host(`www.shared.test`)");
  expect(exactPriority).toBeGreaterThan(wildcardPriority);
});

test("a longer path prefix outranks a shorter one across apps", async () => {
  // Given
  const { files, service } = makeHarness();
  const bare = prioritizeRoutes([route("www.shared.test")]);
  const deep = prioritizeRoutes([route("www.shared.test", "/api")]);

  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* service.applyRoutes(bare, AppId.make("bare"));
      yield* service.applyRoutes(deep, AppId.make("deep"));
    }),
  );

  // Then
  const routers = readRouters(files);
  const barePriority = priorityForRule(routers, "Host(`www.shared.test`)");
  const deepPriority = priorityForRule(routers, "Host(`www.shared.test`) && PathPrefix(`/api`)");
  expect(deepPriority).toBeGreaterThan(barePriority);
});
