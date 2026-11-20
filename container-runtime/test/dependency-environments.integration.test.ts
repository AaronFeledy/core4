import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  DEPENDENCY_ENVIRONMENT_EXTENSION_KEY,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Deferred, Effect, Fiber, Stream } from "effect";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";
import { makeDockerApiClient } from "../src/docker/api-client.ts";
import { buildContainerRemoveRequest } from "../src/engine-api.ts";
import { serviceContainerName } from "../src/plan.ts";
import { makePodmanApiClient } from "../src/podman/api-client.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { containerHelperTestOptions } from "./support/exec-supervision.ts";

const socket = process.env.LANDO_TEST_PODMAN_SOCKET;
const docker = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;

for (const target of [
  { socket, kind: "lando" },
  { socket: docker, kind: "docker" },
] as const) {
  test.skipIf(target.socket === undefined)(
    `${target.kind}: prepare gates start, skips keep, and stops on cancellation`,
    async () => {
      const provider = ProviderId.make(target.kind);
      if (target.socket === undefined) throw new TypeError("Missing explicit test socket");
      const ctx = { providerId: provider, remediation: "Check the live test runtime.", env: {} };
      const api =
        target.kind === "lando"
          ? makePodmanApiClient(target.socket, ctx)
          : makeDockerApiClient(target.socket, ctx);
      const { request, stream } = api;
      if (request === undefined || stream === undefined) throw new TypeError("Missing engine API");
      const dialect = target.kind === "lando" ? libpodLifecycleDialect : dockerLifecycleDialect;
      const slug = `depenv-${crypto.randomUUID().slice(0, 12)}`;
      const metadata = {
        source: "dependency-environments-live",
        runtime: 4,
        resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      } as const;
      const image = "docker.io/library/alpine:3.22";
      const jobName = ServiceName.make("test-env");
      const consumerName = ServiceName.make("consumer");
      const common = {
        provider,
        type: "compose",
        primary: false,
        init: true,
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        hostAliases: [],
        metadata,
        extensions: {},
        artifact: { kind: "ref", ref: image },
      } satisfies Partial<ServicePlan>;
      const consumer: ServicePlan = {
        ...common,
        name: consumerName,
        command: ["tail", "-f", "/dev/null"],
        dependsOn: [{ service: jobName, condition: "service_completed_successfully", required: true }],
      };
      const job: ServicePlan = {
        ...common,
        name: jobName,
        command: ["true"],
        dependsOn: [],
        extensions: { [DEPENDENCY_ENVIRONMENT_EXTENSION_KEY]: { kind: "test", consumers: [consumerName] } },
      };
      const plan: AppPlan = {
        valueModel: 1,
        id: AppId.make(slug),
        slug,
        name: slug,
        root: AbsolutePath.make(`/tmp/${slug}`),
        provider,
        metadata,
        services: { [jobName]: job, [consumerName]: consumer },
        routes: [],
        stores: [],
        fileSync: [],
        extensions: {},
      };
      const nativeJob = serviceContainerName(plan, jobName);
      const nativeConsumer = serviceContainerName(plan, consumerName);
      const observe = (name: string) => request({ method: "GET", path: `/containers/${name}/json` });
      const changedCommand = (command: ServicePlan["command"]): AppPlan => ({
        ...plan,
        services: { ...plan.services, [jobName]: { ...job, command } },
      });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const helper = yield* containerHelperTestOptions(api);
            const local = yield* request({
              method: "GET",
              path: `/images/${encodeURIComponent(image)}/json`,
            });
            if (local.status === 404)
              yield* Stream.runDrain(
                stream({ method: "POST", path: `/images/create?fromImage=${encodeURIComponent(image)}` }),
              );
            yield* Effect.addFinalizer(() =>
              Effect.forEach(
                [nativeConsumer, nativeJob],
                (name) => request(buildContainerRemoveRequest(name)).pipe(Effect.orDie),
                { discard: true },
              ),
            );
            const fresh = changedCommand(["sh", "-c", "echo prepare-failed; exit 23"]);
            const failed = yield* Effect.result(bringUp(fresh, { api, ctx, dialect, ...helper }));
            expect(failed).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "ServiceStartError",
                service: consumerName,
                logTail: { exitCode: 23, lines: ["prepare-failed"] },
              },
            });
            expect((yield* observe(nativeConsumer)).status).toBe(404);
            yield* bringUp(plan, { api, ctx, dialect, ...helper });
            const stamp = (body: string) => JSON.parse(body).State.StartedAt;
            const first = stamp((yield* observe(nativeJob)).body);
            yield* bringUp(plan, { api, ctx, dialect, ...helper });
            expect(stamp((yield* observe(nativeJob)).body)).toBe(first);
            yield* request({ method: "POST", path: `/containers/${nativeConsumer}/stop` });
            yield* bringUp(plan, { api, ctx, dialect, ...helper });
            expect(stamp((yield* observe(nativeJob)).body)).not.toBe(first);
            yield* request({ method: "POST", path: `/containers/${nativeConsumer}/stop` });
            const waiting = yield* Deferred.make<void>();
            const watched = {
              ...api,
              request: (input: Parameters<typeof request>[0]) =>
                input.path.includes("/wait")
                  ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(request(input)))
                  : request(input),
            };
            const fiber = yield* Effect.forkScoped(
              bringUp(changedCommand(["tail", "-f", "/dev/null"]), { api: watched, ctx, dialect, ...helper }),
            );
            yield* Deferred.await(waiting);
            yield* Fiber.interrupt(fiber);
            expect(JSON.parse((yield* observe(nativeJob)).body).State.Running).toBe(false);
            expect(JSON.parse((yield* observe(nativeConsumer)).body).State.Running).toBe(false);
          }),
        ),
      );
    },
    30_000,
  );
}
