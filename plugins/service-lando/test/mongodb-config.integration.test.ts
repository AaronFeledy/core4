import { describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";

import { mongodbServiceType } from "../src/services/mongodb.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

/** Well away from the 600000 the stock mongo:7 image reports on its own. */
const CURSOR_TIMEOUT_MILLIS = "123456";
const SLUG = "mongocfg638";

describe("mongodb service type — live integration: file-backed server config", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "boots MongoDB from the mounted config file and the running server reports its setParameter value",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined || socketPath.length === 0) {
        throw new Error("a live provider socket is required for the MongoDB config integration test");
      }

      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const appRoot = yield* acquireTempAppRoot("lando-mongodb-config-");
            yield* writeFixture(
              appRoot,
              "config/mongod.conf",
              `storage:\n  dbPath: /data/db\nnet:\n  bindIpAll: true\nsetParameter:\n  cursorTimeoutMillis: ${CURSOR_TIMEOUT_MILLIS}\n`,
            );

            const plan = yield* composeCatalogConfigPlan({
              serviceType: mongodbServiceType,
              slug: SLUG,
              serviceName: "db",
              appRoot,
              service: { type: "mongodb", config: { server: "config/mongod.conf" } },
              source: "mongodb-config.integration.test",
            });

            const app = yield* acquireLiveApp({ plan, socketPath });
            // getParameter reads the value the running server holds, so it
            // proves mongod parsed the mounted file's setParameter block.
            // mongosh prints 64-bit ints as `Long('...')`, so the probe casts.
            const result = yield* execUntil({
              app,
              service: "db",
              command: [
                "sh",
                "-c",
                'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "print(Number(db.adminCommand({getParameter: 1, cursorTimeoutMillis: 1}).cursorTimeoutMillis))"',
              ],
              accept: (candidate) => candidate.exitCode === 0 && candidate.stdout.trim().length > 0,
              timeoutMs: 150_000,
            });
            return result.stdout.trim();
          }),
        ),
      );

      expect(observed).toBe(CURSOR_TIMEOUT_MILLIS);
    },
    240_000,
  );
});
