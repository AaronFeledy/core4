import { expect, test } from "bun:test";
import { PortNumber, type ServiceConnection, ServiceName } from "@lando/sdk/schema";
import { serviceTypes } from "../src/index.ts";

test.each([
  ["mysql", "mysql", "mysql", "MYSQL_PWD"],
  ["mysql:8.4", "mysql", "mysql", "MYSQL_PWD"],
  ["mariadb", "mariadb", "mariadb", "MYSQL_PWD"],
  ["postgres", "postgres", "psql", "PGPASSWORD"],
  ["mongodb", "mongodb", "mongosh", "MONGO_URI"],
  ["mssql", "mssql", "sqlcmd", "SQLCMDPASSWORD"],
  ["mssql:2019", "mssql", "sqlcmd", "SQLCMDPASSWORD"],
] as const)("registered %s rebuilds its client from supplied connection facts", (id, family, client, key) => {
  const definition = serviceTypes.get(id);
  const facts: ServiceConnection = {
    family,
    port: PortNumber.make(5566),
    creds: {
      user: family === "mssql" ? "sa" : "applied-user",
      database: "applied-db",
      password: { _tag: "SecretRef", reference: "APPLIED" },
    },
  };
  const task = definition?.toolingForConnection?.(ServiceName.make("existing-db"), facts)[client];
  expect(task?.service).toBe("existing-db");
  if (family === "mongodb") {
    expect(task?.env?.[key]).toEqual({
      _tag: "BoundText",
      parts: [
        "mongodb://applied-user:",
        { reference: "APPLIED", encoding: "uri-component" },
        "@127.0.0.1:5566/applied-db?authSource=admin",
      ],
    });
  } else {
    expect(task?.env?.[key]).toEqual({ _tag: "SecretRef", reference: "APPLIED" });
    expect(task?.cmd).toContain(family === "mssql" ? "localhost,5566" : "5566");
    if (family !== "mssql") {
      expect(task?.cmd).toContain("applied-user");
      expect(task?.cmd).toContain("applied-db");
    }
  }
  expect(
    definition?.toolingForConnection?.(ServiceName.make("existing-db"), {
      ...facts,
      family: family === "postgres" ? "mysql" : "postgres",
    }),
  ).toEqual({});
});
