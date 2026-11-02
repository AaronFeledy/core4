import { expect, test } from "bun:test";
import { runProbe } from "@lando/sdk/probe";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Duration, Effect, Stream } from "effect";
import { buildContainerRemoveRequest } from "../src/engine-api.ts";
import { observeTcpListener } from "../src/listener-observation.ts";
import { serviceContainerName } from "../src/plan.ts";
import { makePodmanApiClient } from "../src/podman/api-client.ts";
import { exec, execStream } from "../src/podman/exec.ts";

const socket = process.env.LANDO_TEST_PODMAN_SOCKET;

test.skipIf(socket === undefined)(
  "observes real Redis on 6379 when the expected listener is 6380",
  async () => {
    if (socket === undefined) throw new TypeError("Missing explicit test socket");
    const ctx = { providerId: "lando", remediation: "Check the live test runtime.", env: {} };
    const api = makePodmanApiClient(socket, ctx);
    const request = api.request;
    if (request === undefined) throw new TypeError("Missing request API");
    await Effect.runPromise(api.ping);
    const metadata = {
      resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      source: "listener-live",
      runtime: 4,
    } as const;
    const service: ServicePlan = {
      name: ServiceName.make("cache"),
      type: "redis",
      provider: ProviderId.make("lando"),
      primary: true,
      environment: {},
      mounts: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      extensions: {},
      metadata,
      endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
    };
    const plan: AppPlan = {
      id: AppId.make(`listener-${crypto.randomUUID().slice(0, 8)}`),
      name: "Listener live",
      slug: `listener-${crypto.randomUUID().slice(0, 8)}`,
      valueModel: 1,
      provider: service.provider,
      root: AbsolutePath.make("/tmp/listener-live"),
      services: { [service.name]: service },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    };
    const name = serviceContainerName(plan, service.name);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const image = "docker.io/library/redis:7";
          const inspect = yield* request({
            method: "GET",
            path: `/images/${encodeURIComponent(image)}/json`,
          });
          if (inspect.status === 404) {
            if (api.stream === undefined) throw new TypeError("Missing pull stream");
            yield* Stream.runDrain(
              api.stream({ method: "POST", path: `/images/create?fromImage=${encodeURIComponent(image)}` }),
            );
          }
          yield* Effect.acquireRelease(
            request({
              method: "POST",
              path: `/containers/create?name=${name}`,
              body: {
                Image: image,
                Cmd: ["redis-server", "--save", "", "--appendonly", "no", "--bind", "0.0.0.0"],
                HostConfig: { NetworkMode: "none" },
              },
            }).pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(201)))),
            () => request(buildContainerRemoveRequest(name)).pipe(Effect.orDie, Effect.asVoid),
          );
          const started = yield* request({ method: "POST", path: `/containers/${name}/start` });
          expect(started.status).toBe(204);
          const target = { app: plan.id, service: service.name, plan };
          const ready = yield* runProbe(
            { id: "redis-listener-test", policy: { maxAttempts: 20, delay: Duration.millis(100) } },
            exec(plan, target, { command: ["redis-cli", "ping"], raw: true }, { api, ctx }).pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0 ? Effect.succeed(result) : Effect.fail("Redis not ready"),
              ),
            ),
          );
          expect(ready.outcome).toBe("green");
          const result = yield* observeTcpListener(service, (command) =>
            execStream(plan, target, command, { api, ctx }),
          );
          expect(result).toMatchObject({
            service: "cache",
            port: 6380,
            state: "not-listening",
            listening: [{ address: "0.0.0.0", port: 6379 }],
          });
        }),
      ),
    );
  },
  30000,
);
