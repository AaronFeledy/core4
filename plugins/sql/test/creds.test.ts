import { describe, expect, test } from "bun:test";
import { type DatabaseConnection, PortNumber } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";
import { credsEnv, currentAppliedDatabaseConnection, resolveSqlCreds } from "../src/creds.ts";
import { dumpCommand, loadCommand } from "../src/families.ts";

describe("applied SQL credentials", () => {
  test.each(["mysql", "mariadb", "postgres", "mongodb", "mssql"] as const)(
    "preserves %s connection facts without defaults",
    (family) => {
      const connection: DatabaseConnection = {
        family,
        port: PortNumber.make(43210),
        creds: {
          user: "custom-user",
          database: "custom-db",
          password: { _tag: "SecretRef", reference: "DATABASE" },
          rootPassword: { _tag: "SecretRef", reference: "ROOT" },
        },
      };
      const creds = resolveSqlCreds(connection);
      expect(creds).toEqual({ ...connection.creds, port: 43210 });
    },
  );

  test("fails closed for historical environment-only services", async () => {
    const exit = await Effect.runPromiseExit(
      currentAppliedDatabaseConnection(
        {
          name: "db",
          type: "mysql:8",
          environment: { MYSQL_PASSWORD: "old-password" },
          storage: [],
        },
        { app: "app", providerId: "docker" },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("PlanReplanRequiredError");
  });

  test.each(["mysql", "mariadb", "postgres", "mssql"] as const)("projects %s password bindings", (family) => {
    const password = { _tag: "SecretRef", reference: "DATABASE" } as const;
    const env = credsEnv(family, { user: "sa", password, database: "db", port: 43210 });
    expect(Object.values(env)).toContainEqual(password);
  });

  test("encodes Mongo components explicitly and keeps credentials off argv", () => {
    const creds = { user: "a@b", password: "p:/?#'!", database: "d b", port: 47017 };
    expect(credsEnv("mongodb", creds).MONGO_URI).toBe(
      "mongodb://a%40b:p%3A%2F%3F%23%27%21@127.0.0.1:47017/d%20b?authSource=admin",
    );
    for (const argv of [dumpCommand("mongodb", creds), loadCommand("mongodb", creds)]) {
      expect(argv.join(" ")).not.toContain(creds.password);
      expect(argv.join(" ")).not.toContain("--uri");
      expect(argv.join(" ")).toContain("--config=/dev/fd/3");
    }
  });
});
