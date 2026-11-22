import { describe, expect, test } from "bun:test";
import { classifyDatabaseClientResult } from "@lando/sdk/database-creds";
import { SqlCredentialApplyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";

import { mysqlFamily } from "../../src/operations/database-convergence/mysql-family.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialStep,
} from "../../src/operations/database-convergence/types.ts";

const SECRET = "app-s3cret-value";
const ROOT_SECRET = "root-s3cret-value";
const OLD_ROOT = "old-root-s3cret";
const CANARY = "leak-canary-ZZ9";

const failure = (message: string, exitCode?: number) =>
  new SqlCredentialApplyError({
    service: "database",
    family: "mysql",
    phase: "preflight",
    mutation: "none",
    completed: [],
    message,
    ...(exitCode === undefined ? {} : { exitCode }),
    remediation:
      "Check the database client, authentication policy, and administrator privileges before retrying.",
  });

type Handler = (request: ClientRequest) => ClientResult;

const result = (
  family: "mysql" | "mariadb",
  partial: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number },
): ClientResult => {
  const exitCode = partial.exitCode ?? 0;
  const stderr = partial.stderr ?? "";
  return {
    stdout: partial.stdout ?? "",
    stderr,
    exitCode,
    state: classifyDatabaseClientResult(family, { exitCode, stderr }),
  };
};

const rejected = (family: "mysql" | "mariadb") =>
  result(family, {
    exitCode: 1,
    stderr: "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)",
  });

const makeContext = (options: {
  readonly family?: "mysql" | "mariadb";
  readonly host?: string;
  readonly desired?: Partial<AdapterContext["desired"]>;
  readonly applied?: Partial<AdapterContext["applied"]>;
  readonly handle: Handler;
}): AdapterContext => {
  const family = options.family ?? "mysql";
  return {
    family,
    port: 3306,
    host: options.host ?? "10.89.0.2",
    desired: {
      user: "lando",
      database: "appdb",
      password: SECRET,
      ...options.desired,
    },
    applied: {
      user: "lando",
      password: "old-app",
      rootPassword: OLD_ROOT,
      ...options.applied,
    },
    service: ServiceName.make("database"),
    run: (request) => Effect.succeed(options.handle(request)),
    failure,
  };
};

const runAdmin = <A>(effect: Effect.Effect<A, SqlCredentialApplyError>) => Effect.runPromise(effect);
const runExit = <A>(effect: Effect.Effect<A, SqlCredentialApplyError>) => Effect.runPromiseExit(effect);

const firstStep = (steps: readonly CredentialStep[]) => {
  const step = steps[0];
  if (step === undefined) throw new Error("expected at least one credential step");
  return step;
};

const stdinOf = (steps: readonly CredentialStep[]) => steps.map((step) => step.request.stdin ?? "");
const argvJoined = (steps: readonly CredentialStep[]) => steps.map((step) => step.request.argv.join(" "));

const catalogHandler = (options: {
  readonly family?: "mysql" | "mariadb";
  readonly users?: string;
  readonly schema?: string;
  readonly partial?: string;
  readonly grants?: string;
  readonly appLogin?: ClientResult;
  readonly rootLocal?: ClientResult;
  readonly rootPercent?: ClientResult;
  readonly adminPassword?: string;
}): Handler => {
  const family = options.family ?? "mysql";
  return (request) => {
    const stdin = request.stdin ?? "";
    const argv = request.argv.join(" ");
    const isSocket = argv.includes("--protocol=SOCKET");
    const userFlag = request.argv[request.argv.indexOf("-u") + 1];

    if (stdin.includes("SELECT CURRENT_USER()") && stdin.includes("FROM mysql.user LIMIT 1")) {
      if (userFlag !== "root") return rejected(family);
      if (options.adminPassword !== undefined && request.env?.MYSQL_PWD !== options.adminPassword) {
        return rejected(family);
      }
      return result(family, { stdout: "root@localhost\n1\n1\n" });
    }

    if (stdin.includes("FROM mysql.user WHERE")) {
      return result(family, {
        stdout:
          options.users ??
          "lando\t%\tcaching_sha2_password\nroot\t%\tcaching_sha2_password\nroot\tlocalhost\tcaching_sha2_password\n",
      });
    }
    if (stdin.includes("information_schema.SCHEMATA")) {
      return result(family, { stdout: options.schema ?? "appdb\n" });
    }
    if (stdin.includes("@@partial_revokes")) {
      return result(family, { stdout: `${options.partial ?? "0"}\n` });
    }
    if (stdin.includes("SHOW GRANTS FOR")) {
      return result(family, {
        stdout: options.grants ?? "GRANT ALL PRIVILEGES ON `appdb`.* TO `lando`@`%`\n",
      });
    }
    if (stdin.includes("SELECT CURRENT_USER()") && !isSocket && userFlag === "lando") {
      return options.appLogin ?? result(family, { stdout: "lando@%\n" });
    }
    if (stdin.includes("SELECT CURRENT_USER()") && isSocket && userFlag === "root") {
      return options.rootLocal ?? rejected(family);
    }
    if (stdin.includes("SELECT CURRENT_USER()") && !isSocket && userFlag === "root") {
      return options.rootPercent ?? rejected(family);
    }
    if (stdin.includes("CREATE ") || stdin.includes("ALTER ") || stdin.includes("GRANT ")) {
      return result(family, { stdout: "" });
    }
    return result(family, {
      exitCode: 1,
      stderr: `unhandled probe: ${stdin.slice(0, 80)}`,
    });
  };
};

describe("mysqlFamily admin", () => {
  test("accepts root over the stock socket with catalog read proof", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({ adminPassword: OLD_ROOT }),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "root", password: OLD_ROOT }))).resolves.toBe("accepted");
  });

  test("rejects a wrong root password without mutation probes", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mysqlFamily(
      makeContext({
        handle: (request) => {
          calls.push(request);
          return rejected("mysql");
        },
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "root", password: "nope" }))).resolves.toBe("rejected");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toContain("--protocol=SOCKET");
    expect(calls[0]?.argv.join(" ")).not.toContain(CANARY);
  });

  test("returns insufficient-privilege when root cannot read mysql.user", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: () =>
          result("mysql", {
            exitCode: 1,
            stderr: "ERROR 1142 (42000): SELECT command denied to user 'root'@'localhost' for table 'user'",
          }),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "root", password: OLD_ROOT }))).resolves.toBe(
      "insufficient-privilege",
    );
  });

  test("never puts the password on argv and uses MYSQL_PWD", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mysqlFamily(
      makeContext({
        handle: (request) => {
          calls.push(request);
          return result("mysql", { stdout: "root@localhost\n1\n1\n" });
        },
      }),
    );
    await runAdmin(adapter.admin({ user: "root", password: OLD_ROOT }));
    expect(calls[0]?.argv.some((part) => part.includes(OLD_ROOT))).toBe(false);
    expect(calls[0]?.env?.MYSQL_PWD).toBe(OLD_ROOT);
    expect(calls[0]?.argv[0]).toBe("mysql");
    expect(calls[0]?.argv).toContain("--no-defaults");
    expect(calls[0]?.argv).toContain("--binary-mode");
  });

  test("mariadb admin uses the mariadb client binary", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mysqlFamily(
      makeContext({
        family: "mariadb",
        handle: (request) => {
          calls.push(request);
          return result("mariadb", { stdout: "root@localhost\n1\n1\n" });
        },
      }),
    );
    await runAdmin(adapter.admin({ user: "root", password: OLD_ROOT }));
    expect(calls[0]?.argv[0]).toBe("mariadb");
  });
});

describe("mysqlFamily delta", () => {
  const admin: AdminCredential = { user: "root", password: OLD_ROOT };

  test("returns no steps when app user, password, database, and grants already match", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: "lando@%\n" }),
          grants: "GRANT ALL PRIVILEGES ON `appdb`.* TO `lando`@`%`\n",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toEqual([]);
  });

  test("plans CREATE DATABASE, CREATE USER, and GRANT for a fresh baseline", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          users: "root\tlocalhost\tcaching_sha2_password\n",
          schema: "",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps.map((step) => [...step.members])).toEqual([["database"], ["user", "password"], ["user"]]);
    const sql = stdinOf(steps).join("\n");
    expect(sql).toContain("CREATE DATABASE `appdb`;");
    expect(sql).toContain("CREATE USER `lando`@`%` IDENTIFIED BY ");
    expect(sql).toContain(`'${SECRET}'`);
    expect(sql).toContain("GRANT ALL PRIVILEGES ON `appdb`.* TO `lando`@`%`;");
    expect(argvJoined(steps).every((argv) => argv.includes("--protocol=SOCKET"))).toBe(true);
    expect(argvJoined(steps).some((argv) => argv.includes(SECRET))).toBe(false);
  });

  test("plans ALTER USER when the desired app password is rejected over TCP", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: rejected("mysql"),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    const alter = firstStep(steps);
    expect([...alter.members]).toEqual(["password"]);
    expect(alter.request.stdin).toContain("ALTER USER `lando`@`%` IDENTIFIED BY ");
    expect(alter.request.stdin).toContain(SECRET);
  });

  test("plans GRANT only when the direct database grant is missing", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: "lando@%\n" }),
          grants: "GRANT USAGE ON *.* TO `lando`@`%`\n",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    const grant = firstStep(steps);
    expect([...grant.members]).toEqual(["user"]);
    expect(grant.request.stdin).toContain("GRANT ALL PRIVILEGES ON `appdb`.* TO `lando`@`%`;");
  });

  test("escapes underscore database names when partial_revokes is off", async () => {
    const adapter = mysqlFamily(
      makeContext({
        desired: { database: "my_db" },
        handle: catalogHandler({
          users: "root\tlocalhost\tmysql_native_password\n",
          schema: "my_db\n",
          partial: "0",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    const grant = steps.find((step) => step.request.stdin?.includes("GRANT "));
    expect(grant?.request.stdin).toContain("ON `my\\_db`.* TO");
  });

  test("uses a literal grant scope when partial_revokes is on", async () => {
    const adapter = mysqlFamily(
      makeContext({
        desired: { database: "my_db" },
        handle: catalogHandler({
          users: "root\tlocalhost\tmysql_native_password\n",
          schema: "",
          partial: "ON",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    const grant = steps.find((step) => step.request.stdin?.includes("GRANT "));
    expect(grant?.request.stdin).toContain("ON `my_db`.* TO");
    expect(grant?.request.stdin).not.toContain("my\\_db");
  });

  test("quotes identifiers and literals with doubled metacharacters", async () => {
    const password = "p'ass`word";
    const adapter = mysqlFamily(
      makeContext({
        desired: { user: "u`x", database: "db`y", password },
        handle: catalogHandler({
          users: "root\tlocalhost\tcaching_sha2_password\n",
          schema: "",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    const sql = stdinOf(steps).join("\n");
    expect(sql).toContain("CREATE DATABASE `db``y`;");
    expect(sql).toContain("CREATE USER `u``x`@`%` IDENTIFIED BY 'p''ass`word';");
  });

  test("refuses system database names and unsafe grant patterns", async () => {
    for (const database of ["mysql", "sys", "db%name", "db\\name"]) {
      const adapter = mysqlFamily(
        makeContext({
          desired: { database },
          handle: catalogHandler({}),
        }),
      );
      const exit = await runExit(adapter.delta(admin));
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("refuses application user root", async () => {
    const adapter = mysqlFamily(
      makeContext({
        desired: { user: "root" },
        handle: catalogHandler({}),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("refuses non-native authentication plugins for password rotation", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          users: "lando\t%\tunix_socket\nroot\tlocalhost\tcaching_sha2_password\n",
          appLogin: rejected("mysql"),
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("refuses shadowed CURRENT_USER on a successful TCP login", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: "lando@127.0.0.1\n" }),
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("shadowed-login diagnostic never echoes client stdout", async () => {
    const canary = `shadow-canary-${CANARY}`;
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: `${canary}\n` }),
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const message = String(exit.cause);
      expect(message).toContain("refusing shadowed credentials");
      expect(message).toContain("lando@%");
      expect(message).not.toContain(canary);
      expect(message).not.toContain(CANARY);
    }
  });

  test("rotates drifted configured root credentials even with no descriptor change", async () => {
    const adapter = mysqlFamily(
      makeContext({
        desired: { rootPassword: ROOT_SECRET },
        applied: { rootPassword: ROOT_SECRET },
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: "lando@%\n" }),
          rootLocal: rejected("mysql"),
          rootPercent: rejected("mysql"),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    const rootSteps = steps.filter((step) => step.members.includes("rootPassword"));
    expect(steps.slice(-2)).toEqual(rootSteps);
    expect(rootSteps).toHaveLength(2);
    expect(rootSteps[0]?.request.stdin).toContain("ALTER USER `root`@`%`");
    expect(rootSteps[1]?.request.stdin).toContain("ALTER USER `root`@`localhost`");
    expect(rootSteps.every((step) => step.request.argv.includes("--protocol=SOCKET"))).toBe(true);
    expect(rootSteps.every((step) => step.request.env?.MYSQL_PWD === OLD_ROOT)).toBe(true);
  });

  test("skips root rows that already accept the desired root password", async () => {
    const adapter = mysqlFamily(
      makeContext({
        desired: { rootPassword: ROOT_SECRET },
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: "lando@%\n" }),
          rootLocal: result("mysql", { stdout: "root@localhost\n" }),
          rootPercent: result("mysql", { stdout: "root@%\n" }),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps.some((step) => step.members.includes("rootPassword"))).toBe(false);
  });

  test("refuses root@'%' rotation when only a loopback host is available", async () => {
    const adapter = mysqlFamily(
      makeContext({
        host: "127.0.0.1",
        desired: { rootPassword: ROOT_SECRET },
        handle: catalogHandler({
          appLogin: result("mysql", { stdout: "lando@%\n" }),
          users:
            "lando\t%\tcaching_sha2_password\nroot\t%\tcaching_sha2_password\nroot\tlocalhost\tcaching_sha2_password\n",
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("does not block app repair when rootPassword is not requested", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: rejected("mysql"),
          users: "lando\t%\tcaching_sha2_password\nroot\t%\tunix_socket\n",
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    expect([...firstStep(steps).members]).toEqual(["password"]);
  });

  test("after root rotation, delta with the desired root admin is already-matched for root", async () => {
    const adapter = mysqlFamily(
      makeContext({
        desired: { rootPassword: ROOT_SECRET },
        handle: catalogHandler({
          adminPassword: ROOT_SECRET,
          appLogin: result("mysql", { stdout: "lando@%\n" }),
          rootLocal: result("mysql", { stdout: "root@localhost\n" }),
          rootPercent: result("mysql", { stdout: "root@%\n" }),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta({ user: "root", password: ROOT_SECRET }));
    expect(steps).toEqual([]);
  });

  test("sets NO_BACKSLASH_ESCAPES and never places secrets on argv", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mysqlFamily(
      makeContext({
        handle: (request) => {
          calls.push(request);
          return catalogHandler({
            users: "root\tlocalhost\tcaching_sha2_password\n",
            schema: "",
          })(request);
        },
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    for (const step of steps) {
      expect(step.request.stdin?.startsWith("SET SESSION sql_mode")).toBe(true);
      expect(step.request.argv.some((part) => part.includes(SECRET))).toBe(false);
      expect(JSON.stringify(step.request.argv)).not.toContain(SECRET);
    }
    expect(calls.some((call) => JSON.stringify(call.argv).includes(SECRET))).toBe(false);
  });

  test("mariadb TCP probes include skip-ssl-verify-server-cert; mysql does not", async () => {
    const mysqlCalls: string[] = [];
    const mariaCalls: string[] = [];
    const mysql = mysqlFamily(
      makeContext({
        family: "mysql",
        handle: (request) => {
          mysqlCalls.push(request.argv.join(" "));
          return catalogHandler({ family: "mysql", appLogin: rejected("mysql") })(request);
        },
      }),
    );
    const maria = mysqlFamily(
      makeContext({
        family: "mariadb",
        handle: (request) => {
          mariaCalls.push(request.argv.join(" "));
          return catalogHandler({ family: "mariadb", appLogin: rejected("mariadb") })(request);
        },
      }),
    );
    await runAdmin(mysql.delta(admin));
    await runAdmin(maria.delta(admin));
    expect(
      mysqlCalls.some((argv) => argv.includes("127.0.0.1") && argv.includes("--skip-ssl-verify-server-cert")),
    ).toBe(false);
    expect(
      mariaCalls.some((argv) => argv.includes("127.0.0.1") && argv.includes("--skip-ssl-verify-server-cert")),
    ).toBe(true);
  });

  test("fail-closed when app password proof is unverified", async () => {
    const adapter = mysqlFamily(
      makeContext({
        handle: catalogHandler({
          appLogin: result("mysql", { exitCode: 2, stderr: "Can't connect to MySQL server" }),
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
