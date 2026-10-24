import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { LANDO_SHARED_CROSS_APP_NETWORK, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";

import { mongodbServiceType } from "../src/services/mongodb.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

describe("MongoDB final-server readiness", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined).each([false, true])(
    "rejects the authenticated init server before the final listener (shared-only=%s)",
    async (sharedOnly) => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined) throw new Error("live MongoDB test requires a provider socket");

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given: the official entrypoint runs .sh hooks after creating the root user.
            const appRoot = yield* acquireTempAppRoot("lando-mongo-ready-");
            const hook = yield* writeFixture(
              appRoot,
              "init/hold.sh",
              [
                "mkdir /tmp/lando-init-gate",
                "mkfifo -m 666 /tmp/lando-init-gate/release",
                "exec 3<>/tmp/lando-init-gate/release",
                "touch /tmp/lando-init-ready",
                "read -r release <&3",
                "exec 3>&-",
              ].join("\n"),
            );
            const composed = yield* composeCatalogConfigPlan({
              serviceType: mongodbServiceType,
              slug: basename(appRoot),
              serviceName: "db",
              appRoot,
              service: { type: "mongodb" },
              source: "mongodb-readiness.integration.test",
            });
            const db = composed.services[ServiceName.make("db")];
            if (db === undefined) throw new Error("MongoDB service is missing");
            const plan = {
              ...composed,
              ...(sharedOnly
                ? {
                    networking: {
                      perAppBridge: null,
                      sharedNetworkMembership: { name: LANDO_SHARED_CROSS_APP_NETWORK, aliases: {} },
                    },
                  }
                : {}),
              services: {
                [db.name]: {
                  ...db,
                  mounts: [
                    ...db.mounts,
                    {
                      type: "bind" as const,
                      source: hook,
                      target: PortablePath.make("/docker-entrypoint-initdb.d/hold.sh"),
                      readOnly: true,
                      realization: "passthrough" as const,
                    },
                  ],
                },
              },
            };
            const probe = plan.services[ServiceName.make("db")]?.healthcheck?.command;
            if (probe === undefined || typeof probe === "string")
              throw new Error("MongoDB plan requires an argv healthcheck");
            const app = yield* acquireLiveApp({ plan, socketPath });
            // A non-sticky directory avoids protected_fifos blocking a different exec user.
            // Opening both ends prevents cleanup from blocking if the hook already exited.
            const release = app.exec("db", [
              "bash",
              "-ec",
              "if test -p /tmp/lando-init-gate/release; then exec 3<>/tmp/lando-init-gate/release; printf 'release\\n' >&3; fi",
            ]);
            yield* Effect.addFinalizer(() => release.pipe(Effect.orDie));
            yield* execUntil({
              app,
              service: "db",
              command: ["test", "-f", "/tmp/lando-init-ready"],
              accept: (result) => result.exitCode === 0,
              timeoutMs: 120_000,
            });
            const authenticated = yield* app.exec("db", [
              "bash",
              "-ec",
              'exec env HOME=/tmp mongosh --quiet --norc -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "quit(db.adminCommand({ping: 1}).ok === 1 ? 0 : 1)"',
            ]);
            expect(authenticated.exitCode).toBe(0);

            // When: readiness runs while the init daemon is held on loopback.
            const initializing = yield* app.exec("db", probe);

            // Then: it must reject that daemon, but accept the final network listener.
            expect(initializing.exitCode).not.toBe(0);
            const released = yield* release;
            expect({ exitCode: released.exitCode, stderr: released.stderr }).toEqual({
              exitCode: 0,
              stderr: "",
            });
            const ready = yield* execUntil({
              app,
              service: "db",
              command: probe,
              accept: (result) => result.exitCode === 0,
              timeoutMs: 120_000,
            });
            expect(ready.exitCode).toBe(0);
          }),
        ),
      );
    },
    240_000,
  );
});
