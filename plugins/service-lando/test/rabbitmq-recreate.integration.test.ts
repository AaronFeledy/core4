import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { bringDown, bringUp, exec } from "@lando/provider-lando";
import { ServiceName, appIdentityKey, normalizeAppSlug } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { rabbitmqServiceType } from "../src/services/rabbitmq.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { type LiveApp, acquireLiveApp, acquireTempAppRoot, execUntil } from "./support/live-app-scope.ts";

const admin = ["rabbitmqadmin", "--username", "lando", "--password", "lando"];
const succeeded = (result: { readonly exitCode: number }): boolean => result.exitCode === 0;

const containerId = (app: LiveApp, name: string) =>
  Effect.gen(function* () {
    const request = app.api.request;
    if (request === undefined) throw new Error("Missing container inspect API");
    const response = yield* request({ method: "GET", path: `/containers/${name}/json` });
    return Schema.decodeUnknownSync(Schema.Struct({ Id: Schema.String }))(JSON.parse(response.body)).Id;
  });

describe("RabbitMQ data across container recreation", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "keeps its node name and durable queues when the app is renamed",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined) throw new Error("live RabbitMQ test requires a provider socket");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given: a broker holding a persistent message in a durable queue.
            const appRoot = yield* acquireTempAppRoot("lando-rabbit-recreate-");
            const slug = normalizeAppSlug(basename(appRoot), appRoot);
            const plan = yield* composeCatalogConfigPlan({
              serviceType: rabbitmqServiceType,
              slug,
              serviceName: "queue",
              appRoot,
              service: { type: rabbitmqServiceType.id },
              source: "rabbitmq-recreate.integration.test",
            });
            const name = serviceContainerName(plan, "queue");
            const app = yield* acquireLiveApp({ plan, socketPath });
            yield* execUntil({
              app,
              service: "queue",
              command: [...admin, "declare", "queue", "--name", "lando-durable", "--durable", "true"],
              accept: succeeded,
              timeoutMs: 120_000,
            });
            const published = yield* app.exec("queue", [
              ...admin,
              "publish",
              "message",
              "--routing-key",
              "lando-durable",
              "--payload",
              "kept",
              "--properties",
              '{"delivery_mode":2}',
            ]);
            expect(published.exitCode).toBe(0);
            const before = yield* containerId(app, name);

            // When: a renamed runtime reuses the recorded data volume.
            const renamedPlan = yield* composeCatalogConfigPlan({
              serviceType: rabbitmqServiceType,
              slug: `${slug}-renamed`,
              dataName: slug,
              serviceName: "queue",
              appRoot,
              service: { type: rabbitmqServiceType.id },
              source: "rabbitmq-recreate.integration.test",
            });
            const renamed = {
              ...renamedPlan,
              identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root), dataName: slug },
            };
            yield* bringDown(plan, { api: app.api });
            yield* Effect.acquireRelease(bringUp(renamed, { api: app.api }), () =>
              Effect.orDie(bringDown(renamed, { api: app.api, volumes: true })),
            );
            const renamedApp: LiveApp = {
              plan: renamed,
              api: app.api,
              exec: (service, command) =>
                exec(
                  renamed,
                  { app: renamed.id, service: ServiceName.make(service) },
                  { command: [...command] },
                  { api: app.api },
                ),
            };

            // Then: the new container keeps the node name, so the broker finds its queue and message.
            expect(yield* containerId(app, serviceContainerName(renamed, "queue"))).not.toBe(before);
            expect((yield* renamedApp.exec("queue", ["hostname"])).stdout.trim()).toBe(
              serviceContainerName(renamed, "queue"),
            );
            const queues = yield* execUntil({
              app: renamedApp,
              service: "queue",
              command: ["rabbitmqctl", "-q", "list_queues", "name", "durable", "messages"],
              accept: (result) => succeeded(result) && result.stdout.includes("lando-durable"),
              timeoutMs: 120_000,
            });
            expect(queues.stdout).toMatch(/^lando-durable\s+true\s+1$/mu);
          }),
        ),
      );
    },
    240_000,
  );
});
