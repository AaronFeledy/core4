import { expect, test } from "bun:test";

import { ServiceName } from "@lando/sdk/schema";

import { planMysqlApp } from "./support/mysql-planner.ts";

for (const type of ["mysql:8.0", "mysql:8.4", "mysql:9.7"]) {
  for (const hosts of [undefined, "db"]) {
    test(`Given ${type} and phpMyAdmin hosts=${hosts}, when planning, then it wires the sibling credentials and dependency`, async () => {
      const services = {
        [ServiceName.make("db")]: {
          type,
          creds: { user: "alice", password: "db-secret", database: "example" },
          healthcheck: { kind: "command" as const, command: ["mysqladmin", "ping"] },
        },
        [ServiceName.make("pma")]: {
          type: "phpmyadmin",
          certs: false,
          ...(hosts === undefined ? {} : { hosts }),
        },
      };

      const plan = await planMysqlApp(services);

      const pma = plan.services[ServiceName.make("pma")];
      expect(pma?.environment).toMatchObject({
        PMA_HOSTS: "db",
        PMA_USER: "alice",
        PMA_PASSWORD: "db-secret",
      });
      expect(pma?.dependsOn).toContainEqual({
        service: ServiceName.make("db"),
        condition: "service_healthy",
        required: true,
      });
    });
  }
}
