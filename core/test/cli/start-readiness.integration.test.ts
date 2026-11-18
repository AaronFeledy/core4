import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { type Socket, createConnection, createServer } from "node:net";
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
import { Effect, Exit, Fiber, Layer, Result } from "effect";

const upstreamSocket = process.env.LANDO_READINESS_WAIT_UPSTREAM;
const socket = upstreamSocket === undefined ? resolveLiveProviderSocket() : undefined;
const live = test.skipIf(socket === undefined);
const podman = ProviderId.make("podman");
const db = ServiceName.make("db");
const web = ServiceName.make("web");

/** True when the HTTP request line is a container wait (Docker or libpod). */
const isWaitRequestLine = (line: string): boolean => {
  const path = line.split(" ")[1] ?? "";
  return /\/containers\/[^/]+\/wait(?:\?|$)/u.test(path);
};

/**
 * One native wait flight observed through the test-owned forwarder.
 * `cancelled` means the client closed before a complete upstream response body.
 */
interface WaitFlight {
  readonly openedAt: number;
  closedAt?: number;
  bytesFromUpstream: number;
  cancelled?: boolean;
}

interface WaitForwarder {
  readonly whenWaitOpened: Promise<WaitFlight>;
  readonly whenWaitClosed: Promise<WaitFlight>;
  readonly flights: () => ReadonlyArray<WaitFlight>;
  readonly close: () => Promise<void>;
}

/**
 * Transparent Unix-socket forwarder to the real Podman engine.
 * The child invocation receives the forwarder socket in its environment.
 * Wait flights resolve on open/close so the test never busy-polls or sleeps.
 */
const openPodmanWaitForwarder = async (upstreamPath: string, proxyPath: string): Promise<WaitForwarder> => {
  const flights: WaitFlight[] = [];
  const opened = Promise.withResolvers<WaitFlight>();
  const closed = Promise.withResolvers<WaitFlight>();
  let openedSettled = false;
  let closedSettled = false;

  const server = createServer((client: Socket) => {
    const upstream = createConnection(upstreamPath);
    let head = Buffer.alloc(0);
    let classified = false;
    let flight: WaitFlight | undefined;
    let upstreamEnded = false;

    const finishFlight = (cancelled: boolean) => {
      if (flight === undefined || flight.closedAt !== undefined) return;
      flight.closedAt = performance.now();
      flight.cancelled = cancelled;
      if (!closedSettled) {
        closedSettled = true;
        closed.resolve(flight);
      }
    };

    const classify = (chunk: Buffer) => {
      if (classified) return;
      head = Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      const end = text.indexOf("\r\n");
      if (end === -1) {
        if (head.length > 16_384) classified = true;
        return;
      }
      classified = true;
      const line = text.slice(0, end);
      if (!isWaitRequestLine(line)) return;
      flight = { openedAt: performance.now(), bytesFromUpstream: 0 };
      flights.push(flight);
      if (!openedSettled) {
        openedSettled = true;
        opened.resolve(flight);
      }
    };

    client.on("data", (chunk) => {
      classify(chunk);
      if (!upstream.destroyed) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (flight !== undefined) flight.bytesFromUpstream += chunk.length;
      if (!client.destroyed) client.write(chunk);
    });
    upstream.on("end", () => {
      upstreamEnded = true;
      client.end();
    });
    client.on("end", () => upstream.end());
    const onClose = () => {
      if (flight !== undefined) {
        // Cancelled when the client dropped a held wait before upstream finished a body.
        finishFlight(!upstreamEnded && flight.bytesFromUpstream === 0);
      }
      client.destroy();
      upstream.destroy();
    };
    client.on("close", onClose);
    upstream.on("close", onClose);
    client.on("error", () => onClose());
    upstream.on("error", () => onClose());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPath, resolve);
  });

  return {
    whenWaitOpened: opened.promise,
    whenWaitClosed: closed.promise,
    flights: () => flights,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const withReadinessApp = async <E>(
  services: NonNullable<LandofileShape["services"]>,
  check: (
    app: App,
    provider: RuntimeProviderShape,
    plan: import("@lando/sdk/schema").AppPlan,
  ) => Effect.Effect<void, E>,
  socketPath = socket?.socketPath,
) => {
  if (socketPath === undefined) throw new Error("An explicit answering Podman socket is required");
  const api = makePodmanApiClient(socketPath);
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

live(
  "a failed oneshot completion gate reports dependencyExit for init:completed",
  () =>
    withReadinessApp(
      {
        [ServiceName.make("init")]: {
          ...busybox,
          command: ["sh", "-c", "echo oneshot-fixture-exit; exit 7"],
        },
        [web]: {
          ...busybox,
          command: ["sleep", "600"],
          dependsOn: [
            {
              service: ServiceName.make("init"),
              condition: "service_completed_successfully",
              required: true,
            },
          ],
        },
      },
      Effect.fnUntraced(function* (app, provider, plan) {
        const result = yield* Effect.result(app.start().pipe(Effect.timeout("30 seconds")));
        if (!Result.isFailure(result) || !(result.failure instanceof ServiceStartError))
          return yield* Effect.die(`Expected oneshot ServiceStartError: ${JSON.stringify(result)}`);
        expect(result.failure.message).toContain(
          "Dependency init exited with code 7. Service web could not start because dependency gate init:completed was not satisfied.",
        );
        expect(result.failure.details).toEqual({
          dependencyExit: { service: "init", gate: "init:completed", status: "exited", exitCode: 7 },
        });
        expect(result.failure.logTail?.lines.join("\n")).toContain("oneshot-fixture-exit");
        const observed = yield* provider.list({ app: plan.id, includeUnplanned: true });
        expect(observed.map((service) => [service.service, service.status])).toEqual([
          [ServiceName.make("init"), "exited"],
        ]);
      }),
    ),
  90_000,
);

live(
  "real watcher fail-fast: dependency exit during an in-flight readiness command settles without waiting out the interval",
  () =>
    withReadinessApp(
      {
        [db]: {
          ...busybox,
          // FIFO barrier: main blocks on read until readiness opens the write side, then exits.
          // No poll loop; rendezvous is the blocking open on the named pipe.
          command: [
            "sh",
            "-c",
            "mkfifo /tmp/readiness-armed; cat /tmp/readiness-armed >/dev/null; echo watcher-fail-fast-exit; exit 7",
          ],
          readiness: {
            kind: "command",
            command: ["sh", "-c", "echo armed > /tmp/readiness-armed; sleep 600; exit 1"],
            intervalSeconds: 30,
            timeoutSeconds: 30,
            retries: 40,
          },
        },
        [web]: {
          ...busybox,
          command: ["sleep", "600"],
          dependsOn: [{ service: db, condition: "service_healthy", required: true }],
        },
      },
      Effect.fnUntraced(function* (app, _provider, _plan) {
        const startedAt = performance.now();
        const result = yield* Effect.result(app.start().pipe(Effect.timeout("25 seconds")));
        const elapsedMs = performance.now() - startedAt;
        if (!Result.isFailure(result) || !(result.failure instanceof ServiceStartError))
          return yield* Effect.die(`Expected watcher fail-fast ServiceStartError: ${JSON.stringify(result)}`);
        expect(result.failure.details).toEqual({
          dependencyExit: { service: "db", gate: "db:healthy", status: "exited", exitCode: 7 },
        });
        expect(result.failure.logTail?.lines.join("\n")).toContain("watcher-fail-fast-exit");
        // Fail-fast must beat the 30s interval; record the observed settle time.
        expect(elapsedMs).toBeLessThan(15_000);
        // Surface timing in the assertion message for live logs without a fixed sleep.
        console.info(`Podman dependency exit settled in ${elapsedMs.toFixed(1)} ms`);
      }),
    ),
  90_000,
);

const greenWatcherCase =
  "real watcher green cancellation: successful readiness cancels the held native wait without a second arm";

test.skipIf(socket === undefined && upstreamSocket === undefined)(
  greenWatcherCase,
  async () => {
    if (upstreamSocket === undefined) {
      if (socket === undefined) throw new Error("An explicit answering Podman socket is required");
      const dir = await mkdtemp(join(tmpdir(), "lando-readiness-wait-fwd-"));
      try {
        const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", greenWatcherCase], {
          env: {
            ...process.env,
            LANDO_TEST_PODMAN_SOCKET: join(dir, "podman.sock"),
            LANDO_READINESS_WAIT_UPSTREAM: socket.socketPath,
          },
          stdout: "inherit",
          stderr: "inherit",
        });
        expect(await child.exited).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    const proxyPath = process.env.LANDO_TEST_PODMAN_SOCKET;
    if (proxyPath === undefined) throw new Error("The watcher child requires a forwarder socket path");
    const forwarder = await openPodmanWaitForwarder(upstreamSocket, proxyPath);
    try {
      await withReadinessApp(
        {
          [db]: {
            ...busybox,
            // Main owns the release FIFO so readiness can block without host-side polling.
            // cat on db-hold keeps the container running until destroy.
            command: ["sh", "-c", "mkfifo /tmp/release-green /tmp/db-hold; cat /tmp/db-hold"],
            readiness: {
              kind: "command",
              // Block on the release FIFO until the test observes a held /wait, then succeed.
              command: [
                "sh",
                "-c",
                "test -e /tmp/readiness-green || { read -r marker < /tmp/release-green && touch /tmp/readiness-green; }",
              ],
              intervalSeconds: 30,
              timeoutSeconds: 30,
              retries: 5,
            },
          },
          [web]: {
            ...busybox,
            command: ["sleep", "600"],
            dependsOn: [{ service: db, condition: "service_healthy", required: true }],
          },
        },
        Effect.fnUntraced(function* (app, provider, plan) {
          const startedAt = performance.now();
          const fiber = yield* Effect.forkScoped(app.start().pipe(Effect.timeout("45 seconds")));

          // Event barrier: first native wait opened on the forwarder (no fixed sleep).
          const opened = yield* Effect.promise(() =>
            Promise.race([
              forwarder.whenWaitOpened,
              new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("native /wait never opened on the forwarder")),
                  30_000,
                );
                timer.unref?.();
              }),
            ]),
          );
          const waitHeldAt = performance.now();

          // Release readiness only after the wait is held so green cancels that flight.
          const release = yield* provider.exec(
            { app: plan.id, service: db, plan },
            { command: ["sh", "-c", "echo release > /tmp/release-green"] },
          );
          expect(release.exitCode).toBe(0);

          const exit = yield* Fiber.await(fiber);
          const finishedAt = performance.now();
          if (!Exit.isSuccess(exit))
            return yield* Effect.die(`Expected green start success: ${String(exit)}`);

          const closed = yield* Effect.promise(() =>
            Promise.race([
              forwarder.whenWaitClosed,
              new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("held native /wait never closed after green")),
                  10_000,
                );
                timer.unref?.();
              }),
            ]),
          );

          expect(closed.cancelled, "held /wait must cancel without an upstream exit body").toBe(true);
          expect(forwarder.flights()).toHaveLength(1);
          expect(opened.openedAt).toBeLessThan(closed.closedAt ?? Number.POSITIVE_INFINITY);

          const observed = yield* provider.list({ app: plan.id, includeUnplanned: true });
          const byName = Object.fromEntries(
            observed.map((service) => [String(service.service), service.status]),
          );
          expect(byName.db).toBe("running");
          expect(byName.web).toBe("running");

          const holdMs = waitHeldAt - opened.openedAt;
          const totalMs = finishedAt - startedAt;
          const cancelMs = (closed.closedAt ?? finishedAt) - waitHeldAt;
          // Record timing in the assertion label for live evidence.
          console.info(
            `Podman green: wait detected in ${holdMs.toFixed(1)} ms, closed ${cancelMs.toFixed(1)} ms after release, start took ${totalMs.toFixed(1)} ms`,
          );
          // Must not burn a second readiness interval after green.
          expect(totalMs).toBeLessThan(30_000);
        }, Effect.scoped),
        proxyPath,
      );
    } finally {
      await forwarder.close();
    }
  },
  120_000,
);
