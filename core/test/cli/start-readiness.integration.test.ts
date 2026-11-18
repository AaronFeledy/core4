import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { openLandoRuntime } from "@lando/core";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import { layerUnavailable } from "@lando/engine/subsystems/ssh/api";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient } from "@lando/provider-podman";
import type { App } from "@lando/sdk/app";
import { ServiceNotReadyError, ServiceStartError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type LandofileShape,
  PortablePath,
  ProviderId,
  ServiceName,
  landoAppNetworkName,
} from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Result } from "effect";

const socket = resolveLiveProviderSocket();
const live = test.skipIf(socket === undefined);
const podman = ProviderId.make("podman");
const db = ServiceName.make("db");
const web = ServiceName.make("web");

const withReadinessApp = async <E>(
  services: NonNullable<LandofileShape["services"]>,
  check: (
    app: App,
    provider: RuntimeProviderShape,
    plan: import("@lando/sdk/schema").AppPlan,
  ) => Effect.Effect<void, E>,
) => {
  if (socket === undefined) throw new Error("An explicit answering Podman socket is required");
  const api = makePodmanApiClient(socket.socketPath);
  const request = api.request;
  if (request === undefined) throw new Error("Podman inspect API is required");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "lando-readiness-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const root = AbsolutePath.make(yield* Effect.promise(() => realpath(directory)));
        const runtime = yield* openLandoRuntime({
          cwd: root,
          config: {
            defaultProviderId: podman,
            userDataRoot: AbsolutePath.make(join(root, "data")),
            userCacheRoot: AbsolutePath.make(join(root, "cache")),
            userConfRoot: AbsolutePath.make(join(root, "conf")),
          },
          plugins: {
            policy: "bundled-only",
            layers: [Layer.succeed(RouterService, TestRouterService), layerUnavailable],
          },
        });
        const app = yield* runtime.app({
          root,
          landofile: {
            name: `readiness-${crypto.randomUUID().slice(0, 8)}`,
            runtime: 4,
            provider: podman,
            router: { enabled: false },
            services,
          },
        });
        const plan = yield* app.plan;
        const provider = yield* runtime.run(
          RuntimeProviderRegistry.pipe(Effect.flatMap((registry) => registry.select(plan))),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const outcome = yield* app.destroy({ volumes: true, purgeCaches: true });
            const network = landoAppNetworkName(plan);
            const paths: ReadonlyArray<`/${string}`> = [
              ...Object.values(plan.services).map(
                (service) =>
                  `/containers/${encodeURIComponent(serviceContainerName(plan, service.name))}/json` as const,
              ),
              ...(network === undefined ? [] : [`/networks/${encodeURIComponent(network)}` as const]),
              ...plan.stores.map((store) => `/volumes/${encodeURIComponent(store.name)}` as const),
            ];
            for (const path of paths) {
              const response = yield* request({ method: "GET", path });
              expect(response.status, path).toBe(404);
            }
            if (plan.stores.length > 0 && outcome.outcome === "destroyed")
              expect(outcome.dataVolumesRemoved).toBe(true);
          }).pipe(Effect.timeout("45 seconds"), Effect.orDie),
        );
        yield* check(app, provider, plan);
      }),
    ).pipe(Effect.provideService(HostProviderOverride, podman)),
  );
};

live(
  "fresh PostgreSQL 18 answers a query immediately after start returns",
  () =>
    withReadinessApp(
      { [db]: { type: "postgres:18", appMount: false, home: false, routes: [] } },
      Effect.fnUntraced(function* (app, provider, plan) {
        yield* app.start().pipe(Effect.timeout("90 seconds"));
        const result = yield* provider.exec(
          { app: plan.id, service: db },
          {
            command: ["sh", "-c", 'psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 18"'],
          },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("18");
      }),
    ),
  150_000,
);

live(
  "Apache runtime startup failure retains the container and reports exit code and logs",
  () =>
    withReadinessApp(
      {
        [web]: {
          type: "apache",
          appMount: false,
          webroot: PortablePath.make("/srv/missing"),
          home: false,
          routes: [],
        },
      },
      Effect.fnUntraced(function* (app, provider, plan) {
        const result = yield* Effect.result(app.start().pipe(Effect.timeout("90 seconds")));
        if (!Result.isFailure(result) || !(result.failure instanceof ServiceNotReadyError))
          return yield* Effect.die(`Expected post-apply ServiceNotReadyError: ${JSON.stringify(result)}`);
        expect(result.failure.exitCode).toBeGreaterThan(0);
        expect(result.failure.logTail?.lines.join("\n")).toContain("AH00526");
        const observed = yield* provider.inspect({ app: plan.id, service: web });
        expect(observed.containerId).toBeDefined();
        expect(observed.exitCode).toBe(result.failure.exitCode);
      }),
    ),
  150_000,
);

const busybox = {
  type: "compose",
  image: "docker.io/library/busybox:1.37",
  appMount: false,
  home: false,
} as const;

live(
  "an exited healthy dependency stops retries and leaves owned partial apply for destroy (#2431)",
  () =>
    withReadinessApp(
      {
        [db]: {
          ...busybox,
          command: [
            "sh",
            "-c",
            "until test -e /tmp/start-probed; do sleep 0.1; done; echo readiness-fixture-exit; exit 7",
          ],
          readiness: {
            kind: "command",
            command: ["sh", "-c", "touch /tmp/start-probed; exit 1"],
            intervalSeconds: 5,
            timeoutSeconds: 3,
            retries: 40,
          },
        },
        [web]: {
          ...busybox,
          command: ["sleep", "600"],
          dependsOn: [{ service: db, condition: "service_healthy", required: true }],
        },
      },
      Effect.fnUntraced(function* (app, provider, plan) {
        const result = yield* Effect.result(app.start().pipe(Effect.timeout("30 seconds")));
        if (!Result.isFailure(result) || !(result.failure instanceof ServiceStartError))
          return yield* Effect.die(`Expected dependency-gate ServiceStartError: ${JSON.stringify(result)}`);
        expect(result.failure.details).toEqual({
          dependencyExit: { service: "db", gate: "db:healthy", status: "exited", exitCode: 7 },
        });
        expect(result.failure.logTail?.lines.join("\n")).toContain("readiness-fixture-exit");
        const observed = yield* provider.list({ app: plan.id, includeUnplanned: true });
        expect(observed.map((service) => [service.service, service.status])).toEqual([[db, "exited"]]);
      }),
    ),
  90_000,
);
