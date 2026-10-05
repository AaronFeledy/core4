import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { resolveBindSource } from "../src/services/_volume-helpers.ts";
import { MARIADB_CONFIG_TARGET, mariadbServiceFeature } from "../src/services/mariadb.ts";
import { MONGODB_CONFIG_TARGET, mongodbServiceFeature } from "../src/services/mongodb.ts";
import { MYSQL_CONFIG_TARGET, mysqlServiceFeature } from "../src/services/mysql.ts";
import { POSTGRES_CONFIG_TARGET, postgresServiceFeature } from "../src/services/postgres.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

describe("resolveBindSource", () => {
  test("keeps absolute POSIX sources unchanged under a Windows app root", () => {
    expect(resolveBindSource("/var/run/docker.sock", "C:\\proj")).toBe("/var/run/docker.sock");
  });

  test("resolves relative sources against a Windows app root", () => {
    expect(resolveBindSource("./.lando/php/app.ini", "C:\\proj")).toBe("C:\\proj\\.lando\\php\\app.ini");
  });

  test("resolves relative sources against a POSIX app root", () => {
    expect(resolveBindSource("./conf", "/srv/app")).toBe("/srv/app/conf");
  });
});

describe.each([
  ["mariadb", mariadbServiceFeature, MARIADB_CONFIG_TARGET],
  ["mysql", mysqlServiceFeature, MYSQL_CONFIG_TARGET],
  ["postgres", postgresServiceFeature, POSTGRES_CONFIG_TARGET],
  ["mongodb", mongodbServiceFeature, MONGODB_CONFIG_TARGET],
] as const)("%s server config mount", (serviceType, feature, target) => {
  test.each([undefined, ""])("omits the mount and config startup when server is %p", (server) => {
    // Given
    const { ctx, calls } = recordFeatureContext({
      serviceType,
      normalizedConfig: { config: server === undefined ? {} : { server } },
      config: {},
    });
    // When
    Effect.runSync(feature.apply(ctx));
    // Then
    expect(calls.filter(([method]) => method === "addMount" || method === "setCommand")).toEqual([]);
  });

  test.each([
    ["./conf/server.conf", "/srv/apps/myapp", "/srv/apps/myapp/conf/server.conf"],
    ["/etc/server.conf", "/srv/apps/myapp", "/etc/server.conf"],
    ["C:\\conf\\server.conf", "/srv/apps/myapp", "C:\\conf\\server.conf"],
    ["./conf/server.conf", "C:\\app", "C:\\app\\conf\\server.conf"],
  ])("resolves %s against %s as a read-only mount", (server, appRoot, source) => {
    // Given
    const { ctx, calls } = recordFeatureContext({
      serviceType,
      normalizedConfig: { config: { server } },
      config: {},
    });
    // When
    Effect.runSync(feature.apply({ ...ctx, appRoot }));
    // Then
    expect(calls.filter(([method]) => method === "addMount")).toEqual([
      ["addMount", { type: "bind", source, target, readOnly: true }],
    ]);
  });
});
