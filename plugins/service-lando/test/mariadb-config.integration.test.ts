import { describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";

import { mariadbServiceType } from "../src/services/mariadb.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

/** Well away from the 151 the stock mariadb:11.4 image reports on its own. */
const MAX_CONNECTIONS = "271";
const SLUG = "mariadbcfg638";

describe("mariadb service type — live integration: file-backed server config", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "boots MariaDB with a mounted my.cnf and the running server reports its max_connections",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined || socketPath.length === 0) {
        throw new Error("a live provider socket is required for the MariaDB config integration test");
      }

      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const appRoot = yield* acquireTempAppRoot("lando-mariadb-config-");
            yield* writeFixture(appRoot, "config/my.cnf", `[mysqld]\nmax_connections = ${MAX_CONNECTIONS}\n`);

            const plan = yield* composeCatalogConfigPlan({
              serviceType: mariadbServiceType,
              slug: SLUG,
              serviceName: "db",
              appRoot,
              service: { type: "mariadb", config: { server: "config/my.cnf" } },
              source: "mariadb-config.integration.test",
            });

            const app = yield* acquireLiveApp({ plan, socketPath });
            // Asking the server for its own global variable proves the daemon
            // parsed the mounted drop-in, not merely that the file is mounted.
            const result = yield* execUntil({
              app,
              service: "db",
              command: [
                "sh",
                "-c",
                'mariadb -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -N -B -e "SELECT @@global.max_connections"',
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
});
