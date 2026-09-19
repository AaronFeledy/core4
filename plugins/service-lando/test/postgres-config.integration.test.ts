import { describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";

import { POSTGRES_CONFIG_TARGET, postgresServiceType } from "../src/services/postgres.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

/** Well away from the 100 the stock postgres:16 image reports on its own. */
const MAX_CONNECTIONS = "137";
const SLUG = "pgcfg638";

describe("postgres service type — live integration: file-backed server config", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "boots PostgreSQL from the mounted config file and the running server reports both the file and its setting",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined || socketPath.length === 0) {
        throw new Error("a live provider socket is required for the PostgreSQL config integration test");
      }

      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const appRoot = yield* acquireTempAppRoot("lando-postgres-config-");
            // The whole server config is replaced, so the file keeps the
            // listener open for other services as well as carrying the probe.
            yield* writeFixture(
              appRoot,
              "config/postgresql.conf",
              `listen_addresses = '*'\nmax_connections = ${MAX_CONNECTIONS}\n`,
            );

            const plan = yield* composeCatalogConfigPlan({
              serviceType: postgresServiceType,
              slug: SLUG,
              serviceName: "db",
              appRoot,
              service: { type: "postgres", config: { server: "config/postgresql.conf" } },
              source: "postgres-config.integration.test",
            });

            const app = yield* acquireLiveApp({ plan, socketPath });
            // `SHOW` reads the running server's own view, so it proves the
            // daemon loaded the file rather than that the flag was generated.
            const result = yield* execUntil({
              app,
              service: "db",
              command: [
                "sh",
                "-c",
                'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SHOW config_file; SHOW max_connections"',
              ],
              accept: (candidate) => candidate.exitCode === 0 && candidate.stdout.trim().length > 0,
              timeoutMs: 150_000,
            });
            return result.stdout
              .trim()
              .split("\n")
              .map((line) => line.trim());
          }),
        ),
      );

      expect(observed).toEqual([String(POSTGRES_CONFIG_TARGET), MAX_CONNECTIONS]);
    },
    240_000,
  );
});
