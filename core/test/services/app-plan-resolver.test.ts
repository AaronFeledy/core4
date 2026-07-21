import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { TestRuntimeProvider } from "@lando/core/testing";
import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath, AppPlan, type ProviderCapabilities, ServiceName } from "@lando/sdk/schema";
import { AppPlanResolver, AppPlanner, GlobalAppService } from "@lando/sdk/services";

import { AppPlanResolverLive, deriveRouteAuthorityPorts } from "../../src/services/app-plan-resolver.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const capabilities = TestRuntimeProvider.capabilities;

const makePlan = (
  name: string,
  services: ReadonlyArray<{
    readonly name: string;
    readonly endpoints: ReadonlyArray<Record<string, unknown>>;
  }>,
) =>
  Schema.decodeUnknownSync(AppPlan)({
    id: name,
    name,
    slug: name,
    root: `/workspace/${name}`,
    provider: "lando",
    services: Object.fromEntries(
      services.map((service) => [
        service.name,
        {
          name: service.name,
          type: "test",
          provider: "lando",
          primary: service.name === "proxy",
          environment: {},
          mounts: [],
          storage: [],
          endpoints: service.endpoints,
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata: {
            resolvedAt: "2026-07-21T00:00:00.000Z",
            source: `/workspace/${name}/.lando.yml`,
            runtime: 4,
          },
          extensions: {},
        },
      ]),
    ),
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: {
      resolvedAt: "2026-07-21T00:00:00.000Z",
      source: `/workspace/${name}/.lando.yml`,
      runtime: 4,
    },
    extensions: {},
  });

describe("AppPlanResolver", () => {
  test("derives published HTTP and HTTPS authority ports from one global service", async () => {
    const plan = makePlan("global", [
      {
        name: "proxy",
        endpoints: [
          { protocol: "http", port: 80, publishedPort: 18080, name: "http" },
          { protocol: "https", port: 443, publishedPort: 18443, name: "https" },
        ],
      },
    ]);

    const ports = await Effect.runPromise(deriveRouteAuthorityPorts(plan));

    expect(ports).toEqual({ http: 18080, https: 18443 });
  });

  test("ignores unpublished semantic HTTP and HTTPS endpoints", async () => {
    // Given
    const plan = makePlan("global", [
      {
        name: "internal",
        endpoints: [
          { protocol: "http", port: 80 },
          { protocol: "https", port: 443 },
        ],
      },
      {
        name: "proxy",
        endpoints: [{ protocol: "http", port: 80, publishedPort: 18080 }],
      },
    ]);

    // When
    const ports = await Effect.runPromise(deriveRouteAuthorityPorts(plan));

    // Then
    expect(ports).toEqual({ http: 18080 });
  });

  test("fails with typed validation when authority protocols belong to different services", async () => {
    const plan = makePlan("global", [
      { name: "http-proxy", endpoints: [{ protocol: "http", port: 80, publishedPort: 18080 }] },
      { name: "https-proxy", endpoints: [{ protocol: "https", port: 443, publishedPort: 18443 }] },
    ]);

    const exit = await Effect.runPromiseExit(deriveRouteAuthorityPorts(plan));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected authority derivation to fail");
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (!Option.isSome(failure)) throw new Error("expected typed failure");
    expect(failure.value).toBeInstanceOf(LandofileValidationError);
  });

  test("global planning cannot recurse and user or scratch plans receive its authority ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-plan-resolver-"));
    const distLandofile = AbsolutePath.make(join(root, ".lando.dist.yml"));
    const userLandofile = AbsolutePath.make(join(root, ".lando.yml"));
    await writeFile(distLandofile, "name: global\nruntime: 4\nservices: {}\n");
    const calls: string[] = [];
    const rawPlanner = {
      plan: (
        _landofile: unknown,
        _providerCapabilities: ProviderCapabilities,
        options: {
          readonly kind: "user" | "global" | "scratch";
          readonly routeAuthorityPorts?: { readonly http?: number; readonly https?: number };
        },
      ) =>
        Effect.sync(() => {
          calls.push(options.kind);
          if (options.kind === "global") {
            return makePlan("global", [
              {
                name: "proxy",
                endpoints: [
                  { protocol: "http", port: 80, publishedPort: 18080 },
                  { protocol: "https", port: 443, publishedPort: 18443 },
                ],
              },
            ]);
          }
          return {
            ...makePlan(`${options.kind}-app`, []),
            routes: [
              {
                hostname: `${options.kind}.lndo.site`,
                scheme: "https" as const,
                service: ServiceName.make("web"),
                ...(options.routeAuthorityPorts === undefined
                  ? {}
                  : { authorityPorts: options.routeAuthorityPorts }),
              },
            ],
          };
        }),
    };
    const globalApp = {
      id: "global" as const,
      root: Effect.succeed(AbsolutePath.make(root)),
      ensureRoot: Effect.void,
      paths: Effect.succeed({ root: AbsolutePath.make(root), distLandofile, userLandofile }),
      ensureUserLandofile: Effect.succeed({ path: userLandofile, created: false }),
      regenerateDist: () => Effect.die("not used"),
    };
    const layer = AppPlanResolverLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystemLive,
          Layer.succeed(AppPlanner, rawPlanner),
          Layer.succeed(GlobalAppService, globalApp),
        ),
      ),
    );

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const resolver = yield* AppPlanResolver;
          const global = yield* resolver.global(capabilities);
          const user = yield* resolver.plan({ name: "user-app", runtime: 4 }, capabilities, {
            kind: "user",
          });
          const scratch = yield* resolver.plan({ name: "scratch-app", runtime: 4 }, capabilities, {
            kind: "scratch",
          });
          return { global, user, scratch };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.global.materialized).toBe(true);
      expect(result.user.routes[0]?.authorityPorts).toEqual({ http: 18080, https: 18443 });
      expect(result.scratch.routes[0]?.authorityPorts).toEqual({ http: 18080, https: 18443 });
      expect(calls).toEqual(["global", "global", "user", "global", "scratch"]);

      await rm(distLandofile);
      const withoutGlobal = await Effect.runPromise(
        Effect.flatMap(AppPlanResolver, (resolver) =>
          resolver.plan({ name: "user-app", runtime: 4 }, capabilities, { kind: "user" }),
        ).pipe(Effect.provide(layer)),
      );
      expect(withoutGlobal.routes[0]?.authorityPorts).toBeUndefined();
      expect(calls).toEqual(["global", "global", "user", "global", "scratch", "user"]);

      await writeFile(distLandofile, "services: [\n");
      const withInvalidGlobal = await Effect.runPromise(
        Effect.flatMap(AppPlanResolver, (resolver) =>
          resolver.plan({ name: "user-app", runtime: 4 }, capabilities, { kind: "user" }),
        ).pipe(Effect.provide(layer)),
      );
      expect(withInvalidGlobal.routes[0]?.authorityPorts).toBeUndefined();
      expect(calls).toEqual(["global", "global", "user", "global", "scratch", "user", "user"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
