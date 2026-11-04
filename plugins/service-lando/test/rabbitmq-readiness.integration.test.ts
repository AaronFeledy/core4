import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { basename } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { compileServiceProbe } from "@lando/container-runtime/service-probe";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { rabbitmq3ServiceType, rabbitmqServiceType } from "../src/services/rabbitmq.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

describe("RabbitMQ cookie-safe readiness", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined).each([
    { held: true, type: rabbitmqServiceType, port: 5672 },
    { held: true, type: rabbitmq3ServiceType, port: 5673 },
    { held: false, type: rabbitmqServiceType, port: 5672 },
  ])(
    "starts $type.id on $port (held=$held)",
    async (input) => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined) throw new Error("live RabbitMQ test requires a provider socket");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given: a fresh data volume, optionally held after entrypoint ownership preparation.
            const appRoot = yield* acquireTempAppRoot("lando-rabbit-ready-");
            const wrapper = yield* writeFixture(
              appRoot,
              "bin/rabbitmq-server",
              [
                "#!/bin/bash",
                "set -e",
                "mkdir /tmp/lando-rabbit-gate",
                "mkfifo -m 666 /tmp/lando-rabbit-gate/release",
                "exec 3<>/tmp/lando-rabbit-gate/release",
                "id -un > /tmp/lando-rabbit-gate/user",
                "touch /tmp/lando-rabbit-gate/ready",
                "read -r release <&3",
                "exec 3>&-",
                'exec /opt/rabbitmq/sbin/rabbitmq-server "$@"',
              ].join("\n"),
            );
            yield* Effect.promise(() => chmod(wrapper, 0o755));
            const composed = yield* composeCatalogConfigPlan({
              serviceType: input.type,
              slug: basename(appRoot),
              serviceName: "queue",
              appRoot,
              service: { type: input.type.id, port: input.port },
              source: "rabbitmq-readiness.integration.test",
            });
            const queue = composed.services[ServiceName.make("queue")];
            if (queue === undefined || queue.readiness === undefined || queue.healthcheck === undefined)
              throw new Error("RabbitMQ service probes are missing");
            const service = {
              ...queue,
              environment: {
                ...queue.environment,
                ...(input.held
                  ? {
                      PATH: "/lando-test-bin:/opt/rabbitmq/sbin:/opt/erlang/bin:/opt/openssl/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    }
                  : {}),
              },
              mounts: [
                ...queue.mounts,
                ...(input.held
                  ? [
                      {
                        type: "bind" as const,
                        source: wrapper,
                        target: PortablePath.make("/lando-test-bin/rabbitmq-server"),
                        readOnly: true,
                        realization: "passthrough" as const,
                      },
                    ]
                  : []),
              ],
            };
            const plan = { ...composed, services: { [queue.name]: service } };
            const readiness = compileServiceProbe(queue.readiness, plan, service);
            const healthcheck = compileServiceProbe(queue.healthcheck, plan, service);
            if (readiness === undefined || healthcheck === undefined)
              throw new Error("Missing compiled probes");
            const app = yield* acquireLiveApp({ plan, socketPath });
            const entrypoint = yield* app.exec("queue", ["cat", "/usr/local/bin/docker-entrypoint.sh"]);
            expect(entrypoint.exitCode).toBe(0);
            expect(entrypoint.stdout).toContain("chown");
            expect(entrypoint.stdout).toContain("gosu rabbitmq");
            expect(entrypoint.stdout).toContain('exec "$@"');
            const release = app.exec("queue", [
              "bash",
              "-ec",
              "if test -p /tmp/lando-rabbit-gate/release; then exec 3<>/tmp/lando-rabbit-gate/release; printf 'release\\n' >&3; fi",
            ]);
            if (input.held) {
              yield* Effect.addFinalizer(() => release.pipe(Effect.orDie));
              yield* execUntil({
                app,
                service: "queue",
                command: ["test", "-f", "/tmp/lando-rabbit-gate/ready"],
                accept: (result) => result.exitCode === 0,
                timeoutMs: 120_000,
              });
              expect((yield* app.exec("queue", ["cat", "/tmp/lando-rabbit-gate/user"])).stdout.trim()).toBe(
                "rabbitmq",
              );
              const dataOwner = yield* app.exec("queue", ["stat", "-c", "%U", "/var/lib/rabbitmq"]);
              expect(dataOwner.stdout.trim()).toBe("rabbitmq");
              // When: both roles repeatedly run as the container's effective user before Erlang starts.
              for (let attempt = 0; attempt < 3; attempt++) {
                expect((yield* app.exec("queue", healthcheck)).exitCode).not.toBe(0);
                const blocked = yield* app.exec("queue", readiness);
                expect(blocked.exitCode).toBe(1);
                expect(blocked.stderr.trim()).toMatch(/^Lando's TCP probe could not connect to .+:\d+$/);
                // Then: no probe creates the broker's cookie during the dangerous window.
                const cookieAbsent = yield* app.exec("queue", [
                  "test",
                  "!",
                  "-e",
                  "/var/lib/rabbitmq/.erlang.cookie",
                ]);
                expect(cookieAbsent.exitCode).toBe(0);
              }
              expect((yield* release).exitCode).toBe(0);
            }
            const ready = yield* execUntil({
              app,
              service: "queue",
              command: readiness,
              accept: (result) => result.exitCode === 0,
              timeoutMs: 120_000,
            });
            expect(ready.exitCode).toBe(0);
            const cookie = yield* app.exec("queue", [
              "stat",
              "-c",
              "%U:%G %a",
              "/var/lib/rabbitmq/.erlang.cookie",
            ]);
            expect(cookie.stdout.trim()).toBe("rabbitmq:rabbitmq 400");
            expect((yield* app.exec("queue", healthcheck)).exitCode).toBe(0);
            const request = app.api.request;
            if (request === undefined) throw new Error("Missing container inspect API");
            const response = yield* request({
              method: "GET",
              path: `/containers/${serviceContainerName(plan, queue.name)}/json`,
            });
            const inspect = Schema.decodeUnknownSync(
              Schema.Struct({ State: Schema.Struct({ Running: Schema.Boolean }) }),
            )(JSON.parse(response.body));
            expect(inspect.State.Running).toBe(true);
          }),
        ),
      );
    },
    240_000,
  );
});
