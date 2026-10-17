import { describe, expect, test } from "bun:test";
import { buildKeyForService } from "@lando/engine/services/build-key";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient, layer as providerLayer } from "@lando/provider-lando";
import { ServiceName } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";
import { tomcat9ServiceType, tomcat10ServiceType, tomcat11ServiceType } from "../src/services/tomcat.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

describe("Tomcat paired catalog configuration live compatibility", () => {
  for (const serviceType of [tomcat9ServiceType, tomcat10ServiceType, tomcat11ServiceType]) {
    for (const port of [undefined, 9090]) {
      test.skipIf(resolveLiveProviderSocket() === undefined)(
        `${serviceType.id} serves ROOT at ${port ?? 8080} with authored startup`,
        async () => {
          // Given
          const socket = resolveLiveProviderSocket();
          if (socket === undefined)
            throw new TypeError("Tomcat live compatibility requires a provider socket");
          const selectedPort = port ?? 8080;
          const expected = `tomcat-${serviceType.id}-${selectedPort}`;
          const observed = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const appRoot = yield* acquireTempAppRoot("lando-tomcat-config-");
                yield* writeFixture(appRoot, "public/index.html", expected);
                const plan = yield* composeCatalogConfigPlan({
                  serviceType,
                  slug: `tc-${crypto.randomUUID().slice(0, 8)}`,
                  serviceName: "web",
                  appRoot,
                  source: "tomcat-config.integration.test",
                  service: {
                    type: serviceType.id,
                    webroot: "public",
                    certs: false,
                    ...(port === undefined ? {} : { port }),
                    entrypoint: [
                      "bash",
                      "-c",
                      'printf entrypoint > /tmp/lando-entrypoint; exec "$@"',
                      "authored-entrypoint",
                    ],
                    command: [
                      "bash",
                      "-c",
                      "set -eu; test -f /tmp/lando-entrypoint; printf command > /tmp/lando-command; exec catalina.sh run",
                    ],
                  },
                });
                const service = plan.services[ServiceName.make("web")];
                if (service === undefined) throw new TypeError("Tomcat service plan missing");
                const api = makePodmanApiClient(socket.socketPath);
                const provider = yield* RuntimeProvider.pipe(
                  Effect.provide(
                    providerLayer({
                      platform: "linux",
                      podmanApi: api,
                      sanitizeAppliedPlan: stripHostProxyRunLando,
                    }),
                  ),
                );
                const buildKey = yield* buildKeyForService(provider, service);
                const artifact = yield* Effect.acquireRelease(
                  provider.buildArtifact({ app: plan.id, service: service.name, plan, buildKey }),
                  (built) =>
                    Effect.orDie(
                      Effect.gen(function* () {
                        if (api.request === undefined)
                          throw new TypeError("Image cleanup requires provider requests");
                        const result = yield* api.request({
                          method: "DELETE",
                          path: `/images/${encodeURIComponent(built.ref)}`,
                        });
                        if (result.status !== 200 && result.status !== 204 && result.status !== 404)
                          throw new TypeError(`Image cleanup failed: HTTP ${result.status}`);
                      }),
                    ),
                );
                // When
                const builtPlan = {
                  ...plan,
                  services: {
                    [service.name]: { ...service, artifact: { kind: "ref" as const, ref: artifact.ref } },
                  },
                };
                const app = yield* acquireLiveApp({ plan: builtPlan, socketPath: socket.socketPath });
                const response = yield* execUntil({
                  app,
                  service: "web",
                  command: ["curl", "--fail", "--silent", `http://127.0.0.1:${selectedPort}/`],
                  accept: (result) => result.exitCode === 0,
                  timeoutMs: 120_000,
                });
                const startup = yield* app.exec("web", [
                  "sh",
                  "-c",
                  "cat /tmp/lando-entrypoint /tmp/lando-command",
                ]);
                const oldPort =
                  port === undefined
                    ? undefined
                    : yield* app.exec("web", ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);
                return { response, startup, oldPort };
              }),
            ),
          );
          // Then
          expect(observed.response.stdout).toBe(expected);
          expect(observed.startup).toMatchObject({ exitCode: 0, stdout: "entrypointcommand" });
          if (port !== undefined) expect(observed.oldPort?.exitCode).toBe(1);
        },
        600_000,
      );
    }
  }
});
