import { describe, expect, test } from "bun:test";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

const cases = [
  { serviceType: mysqlServiceType, port: 13306, client: "mysql", config: "[mysqld]\nport=3306\n" },
  { serviceType: mariadbServiceType, port: 23306, client: "mariadb", config: "[mariadbd]\nport=3306\n" },
  {
    serviceType: mongodbServiceType,
    port: 37017,
    client: "mongosh",
    config: "net:\n  port: 27017\n  bindIp: 0.0.0.0\n",
  },
] as const;

for (const { serviceType, port, client, config } of cases) {
  describe(`${serviceType.id} live listener`, () => {
    test.skipIf(
      process.env.LANDO_TEST_PODMAN_SOCKET === undefined || resolveLiveProviderSocket() === undefined,
    )(
      "serves on port despite a conflicting config file",
      async () => {
        const socketPath = resolveLiveProviderSocket()?.socketPath;
        if (socketPath === undefined) throw new Error("a live provider socket is required");
        const observed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const appRoot = yield* acquireTempAppRoot(`lando-${serviceType.id}-port-`);
              yield* writeFixture(appRoot, "config/server.conf", config);
              const plan = yield* composeCatalogConfigPlan({
                serviceType,
                slug: `port${serviceType.id}${appRoot
                  .split("/")
                  .at(-1)
                  ?.replace(/[^a-z0-9]/gi, "")
                  .toLowerCase()}`,
                serviceName: "db",
                appRoot,
                service: { type: serviceType.id, port, config: { server: "config/server.conf" } },
                source: "listen-port.integration.test",
              });
              const app = yield* acquireLiveApp({ plan, socketPath });
              const command =
                client === "mongosh"
                  ? [
                      "sh",
                      "-c",
                      `exec env HOME=/tmp mongosh --host 127.0.0.1 --port ${port} -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --quiet --eval 'print(db.runCommand({ping:1}).ok)'`,
                    ]
                  : [
                      "sh",
                      "-c",
                      `exec ${client} -h 127.0.0.1 -P ${port} -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -N -B -e 'SELECT @@port'`,
                    ];
              const expected = client === "mongosh" ? "1" : String(port);
              const result = yield* execUntil({
                app,
                service: "db",
                command,
                accept: (candidate) => candidate.exitCode === 0 && candidate.stdout.trim() === expected,
                timeoutMs: 150_000,
              });
              return result.stdout.trim();
            }),
          ),
        );
        expect(observed).toBe(client === "mongosh" ? "1" : String(port));
      },
      240_000,
    );
  });
}
