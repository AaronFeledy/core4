import { describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";

import { mysqlServiceType } from "../src/services/mysql.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

/** Well away from the 151 the stock mysql:8.0 image reports on its own. */
const MAX_CONNECTIONS = "314";
const SLUG = "mysqlcfg638";

describe.each(["stock", "without-global-config"] as const)(
  "mysql service type — live integration: file-backed server config (%s)",
  (imageConfig) => {
    test.skipIf(resolveLiveProviderSocket() === undefined)(
      "boots MySQL with a mounted my.cnf and the running server reports its max_connections",
      async () => {
        const socketPath = resolveLiveProviderSocket()?.socketPath;
        if (socketPath === undefined || socketPath.length === 0) {
          throw new Error("a live provider socket is required for the MySQL config integration test");
        }

        const observed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const appRoot = yield* acquireTempAppRoot("lando-mysql-config-");
              yield* writeFixture(
                appRoot,
                "config/my.cnf",
                `[mysqld]\nmax_connections = ${MAX_CONNECTIONS}\n`,
              );

              const plan = yield* composeCatalogConfigPlan({
                serviceType: mysqlServiceType,
                slug: SLUG,
                serviceName: "db",
                appRoot,
                service: {
                  type: "mysql",
                  config: { server: "config/my.cnf" },
                  // Ubuntu's host AppArmor profile can deny /etc/my.cnf reads.
                  // Remove it inside the container to test without its includes,
                  // without installing a host-wide security profile for the test.
                  ...(imageConfig === "without-global-config"
                    ? { entrypoint: ["sh", "-c", "rm -f /etc/my.cnf && exec docker-entrypoint.sh mysqld"] }
                    : {}),
                },
                source: "mysql-config.integration.test",
              });

              const app = yield* acquireLiveApp({ plan, socketPath });
              // Asking the server for its own global variable proves the daemon
              // parsed the mounted config, not merely that the file is mounted.
              const result = yield* execUntil({
                app,
                service: "db",
                command: [
                  "sh",
                  "-c",
                  'mysql -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -N -B -e "SELECT @@global.max_connections"',
                ],
                accept: (candidate) => candidate.exitCode === 0 && candidate.stdout.trim().length > 0,
                timeoutMs: 150_000,
              });
              return result.stdout.trim();
            }),
          ),
        );

        expect(observed).toBe(MAX_CONNECTIONS);
      },
      240_000,
    );
  },
);
