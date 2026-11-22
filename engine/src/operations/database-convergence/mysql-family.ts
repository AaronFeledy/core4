import { DATABASE_FAMILY_LOCAL_CLIENT_ARGS } from "@lando/sdk/database-creds";
import { Effect } from "effect";
import { step } from "./client.ts";
import { mysqlAdminProofSql } from "./mysql-admin-proof.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialAdapter,
  CredentialStep,
} from "./types.ts";

const SYSTEM_DATABASES = new Set(["mysql", "information_schema", "performance_schema", "sys"]);
const NATIVE_PLUGINS = new Set([
  "mysql_native_password",
  "caching_sha2_password",
  "mariadb_native_password",
  "mysql_clear_password",
]);
const USER_MAX = 32;
const DATABASE_MAX = 64;

const ident = (value: string): string => `\`${value.replaceAll("`", "``")}\``;
const lit = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const account = (user: string, host: string): string => `${ident(user)}@${ident(host)}`;

const isSafeName = (value: string, max: number): boolean =>
  value.length > 0 &&
  value.length <= max &&
  !/[\p{Cc}\p{Cs}]/u.test(value) &&
  new TextEncoder().encode(value).length <= max;

const clientBin = (family: AdapterContext["family"]): "mysql" | "mariadb" =>
  family === "mariadb" ? "mariadb" : "mysql";

const baseArgv = (context: AdapterContext): string[] => [
  clientBin(context.family),
  "--no-defaults",
  "--batch",
  "--raw",
  "--skip-column-names",
  "--connect-timeout=2",
  "--binary-mode",
];

const withSqlMode = (sql: string): string =>
  `SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES');\n${sql}`;

const socketRequest = (context: AdapterContext, admin: AdminCredential, sql: string): ClientRequest => ({
  argv: [...baseArgv(context), "--protocol=SOCKET", "-u", admin.user],
  env: { MYSQL_PWD: admin.password },
  stdin: withSqlMode(sql),
});

const tcpFamilyArgs = (family: AdapterContext["family"]): readonly string[] =>
  family === "mysql" || family === "mariadb" ? DATABASE_FAMILY_LOCAL_CLIENT_ARGS[family] : [];

const tcpRequest = (
  context: AdapterContext,
  options: { readonly user: string; readonly password: string; readonly host: string; readonly sql: string },
): ClientRequest => ({
  argv: [
    ...baseArgv(context),
    "-h",
    options.host,
    "-P",
    String(context.port),
    "-u",
    options.user,
    ...tcpFamilyArgs(context.family),
  ],
  env: { MYSQL_PWD: options.password },
  stdin: withSqlMode(options.sql),
});

const firstLine = (stdout: string): string => {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.length > 0);
  return line ?? "";
};

const lines = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0);

type UserRow = { readonly user: string; readonly host: string; readonly plugin: string };

const parseUserRows = (stdout: string): readonly UserRow[] =>
  lines(stdout).flatMap((line) => {
    const [user, host, plugin] = line.split("\t");
    if (user === undefined || host === undefined) return [];
    return [{ user, host, plugin: plugin ?? "" }];
  });

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./u.test(host);

const grantPattern = (database: string, partialRevokes: boolean): string =>
  partialRevokes ? `${ident(database)}.*` : `${ident(database.replaceAll("_", "\\_"))}.*`;

const hasDirectDatabaseGrant = (
  grants: readonly string[],
  database: string,
  partialRevokes: boolean,
): boolean => {
  const scopes = [`${ident(database)}.*`, `${database}.*`, grantPattern(database, partialRevokes)];
  return grants.some((grant) => {
    if (!/GRANT\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+/iu.test(grant)) return false;
    return scopes.some((scope) => {
      const escaped = scope.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`\\sON\\s+${escaped}\\s+TO\\s`, "iu").test(grant);
    });
  });
};

const privilegeDenied = (result: ClientResult): boolean =>
  /ERROR\s+1227\b/u.test(result.stderr) ||
  /ERROR\s+1142\b/u.test(result.stderr) ||
  /ERROR\s+1044\b/u.test(result.stderr) ||
  /Access denied(?: for user)?[^\n]* to (?:database |table )/iu.test(result.stderr) ||
  /command denied to user/iu.test(result.stderr);

const requireNativePlugin = (
  context: AdapterContext,
  row: UserRow | undefined,
  label: string,
): Effect.Effect<void, ReturnType<AdapterContext["failure"]>> => {
  if (row === undefined) return Effect.void;
  if (row.plugin.length === 0 || NATIVE_PLUGINS.has(row.plugin)) return Effect.void;
  return Effect.fail(
    context.failure(
      `Refusing to change ${label} ${row.user}@${row.host}: authentication plugin ${row.plugin} is unsupported.`,
    ),
  );
};

const readCatalog = Effect.fnUntraced(function* (
  context: AdapterContext,
  runAdmin: (sql: string) => Effect.Effect<ClientResult, ReturnType<AdapterContext["failure"]>>,
  desired: AdapterContext["desired"],
) {
  const users = yield* runAdmin(
    `SELECT User, Host, plugin FROM mysql.user WHERE (User = ${lit(desired.user)} AND Host = '%') OR (User = 'root' AND Host IN ('%', 'localhost')) ORDER BY User, FIELD(Host, '%', 'localhost');`,
  );
  if (users.state === "rejected") {
    return yield* Effect.fail(
      context.failure(
        "Administrator authentication failed while reading the catalog.",
        users.exitCode,
        "transient",
      ),
    );
  }
  if (users.exitCode !== 0) {
    if (privilegeDenied(users)) {
      return yield* Effect.fail(
        context.failure("Administrator lacks privilege to inspect accounts and databases.", users.exitCode),
      );
    }
    return yield* Effect.fail(context.failure("Could not inspect mysql.user.", users.exitCode));
  }

  const schema = yield* runAdmin(
    `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${lit(desired.database)};`,
  );
  if (schema.exitCode !== 0) {
    return yield* Effect.fail(
      context.failure("Could not inspect information_schema.SCHEMATA.", schema.exitCode),
    );
  }

  const partial = yield* runAdmin("SELECT @@partial_revokes;");
  return {
    userRows: parseUserRows(users.stdout),
    schemaPresent: lines(schema.stdout).includes(desired.database),
    // MariaDB / older MySQL may lack the variable; treat as off rather than guessing ON.
    partialRevokes: partial.exitCode === 0 && /^(?:1|ON)$/iu.test(firstLine(partial.stdout)),
  };
});

export const mysqlFamily = (context: AdapterContext): CredentialAdapter => {
  if (context.family !== "mysql" && context.family !== "mariadb") {
    return {
      admin: () => Effect.fail(context.failure("mysqlFamily only serves mysql and mariadb.")),
      delta: () => Effect.fail(context.failure("mysqlFamily only serves mysql and mariadb.")),
    };
  }

  const runAdmin = (admin: AdminCredential, sql: string) => context.run(socketRequest(context, admin, sql));

  const admin = Effect.fnUntraced(function* (
    candidate: AdminCredential,
  ): Effect.fn.Return<
    "accepted" | "rejected" | "insufficient-privilege",
    ReturnType<AdapterContext["failure"]>
  > {
    if (candidate.user !== "root") return "rejected";
    const result = yield* runAdmin(
      candidate,
      [
        "SELECT CURRENT_USER();",
        "SELECT 1 FROM mysql.user LIMIT 1;",
        "SELECT 1 FROM information_schema.SCHEMATA LIMIT 1;",
      ].join("\n"),
    );
    if (result.state === "rejected") return "rejected";
    if (result.exitCode !== 0) {
      if (privilegeDenied(result)) return "insufficient-privilege";
      if (result.state === "unverified") {
        return yield* Effect.fail(
          context.failure(
            "Could not prove an administrator login against the database client.",
            result.exitCode,
          ),
        );
      }
      return "rejected";
    }
    if (!/^root@/u.test(firstLine(result.stdout))) return "insufficient-privilege";
    return "accepted";
  });

  const delta = Effect.fnUntraced(function* (
    adminCredential: AdminCredential,
  ): Effect.fn.Return<readonly CredentialStep[], ReturnType<AdapterContext["failure"]>> {
    const { desired } = context;
    if (desired.user === "root") {
      return yield* Effect.fail(context.failure("The application database login cannot be root."));
    }
    if (
      SYSTEM_DATABASES.has(desired.database) ||
      desired.database.includes("%") ||
      desired.database.includes("\\")
    ) {
      return yield* Effect.fail(
        context.failure("The desired database name is reserved or cannot be granted exactly."),
      );
    }
    if (!isSafeName(desired.user, USER_MAX) || !isSafeName(desired.database, DATABASE_MAX)) {
      return yield* Effect.fail(
        context.failure("The desired database or login name cannot be represented safely."),
      );
    }
    if (desired.rootPassword === "") {
      return yield* Effect.fail(
        context.failure("A root password change was requested without a desired root password."),
      );
    }

    const catalog = yield* readCatalog(context, (sql) => runAdmin(adminCredential, sql), desired);
    const appRow = catalog.userRows.find((row) => row.user === desired.user && row.host === "%");
    const rootPercent = catalog.userRows.find((row) => row.user === "root" && row.host === "%");
    const rootLocal = catalog.userRows.find((row) => row.user === "root" && row.host === "localhost");
    const steps: CredentialStep[] = [];

    if (!catalog.schemaPresent) {
      steps.push(
        step(
          ["database"],
          socketRequest(context, adminCredential, `CREATE DATABASE ${ident(desired.database)};`),
        ),
      );
    }

    if (appRow === undefined) {
      steps.push(
        step(
          ["user", "password"],
          socketRequest(
            context,
            adminCredential,
            `CREATE USER ${account(desired.user, "%")} IDENTIFIED BY ${lit(desired.password)};`,
          ),
        ),
      );
      steps.push(
        step(
          ["user"],
          socketRequest(
            context,
            adminCredential,
            `GRANT ALL PRIVILEGES ON ${grantPattern(desired.database, catalog.partialRevokes)} TO ${account(desired.user, "%")};`,
          ),
        ),
      );
    } else {
      yield* requireNativePlugin(context, appRow, "login");
      const login = yield* context.run(
        tcpRequest(context, {
          user: desired.user,
          password: desired.password,
          host: "127.0.0.1",
          sql: "SELECT CURRENT_USER();",
        }),
      );
      if (login.state === "accepted") {
        const current = firstLine(login.stdout);
        // Never interpolate client stdout into the diagnostic.
        if (current !== `${desired.user}@%`) {
          return yield* Effect.fail(
            context.failure(
              `Login for ${desired.user} did not resolve to ${desired.user}@%; refusing shadowed credentials.`,
            ),
          );
        }
      } else if (login.state === "rejected") {
        steps.push(
          step(
            ["password"],
            socketRequest(
              context,
              adminCredential,
              `ALTER USER ${account(desired.user, "%")} IDENTIFIED BY ${lit(desired.password)};`,
            ),
          ),
        );
      } else {
        return yield* Effect.fail(
          context.failure("Could not prove the desired application password against TCP.", login.exitCode),
        );
      }

      const grantsResult = yield* runAdmin(adminCredential, `SHOW GRANTS FOR ${account(desired.user, "%")};`);
      if (grantsResult.exitCode !== 0) {
        return yield* Effect.fail(
          context.failure("Could not read grants for the application login.", grantsResult.exitCode),
        );
      }
      if (!hasDirectDatabaseGrant(lines(grantsResult.stdout), desired.database, catalog.partialRevokes)) {
        steps.push(
          step(
            ["user"],
            socketRequest(
              context,
              adminCredential,
              `GRANT ALL PRIVILEGES ON ${grantPattern(desired.database, catalog.partialRevokes)} TO ${account(desired.user, "%")};`,
            ),
          ),
        );
      }
    }

    const rootPassword = desired.rootPassword;
    if (rootPassword !== undefined) {
      const existingRoots = [rootPercent, rootLocal].filter((row): row is UserRow => row !== undefined);
      if (existingRoots.length === 0) {
        return yield* Effect.fail(
          context.failure("No stock root@localhost or root@'%' account exists to rotate."),
        );
      }
      for (const row of existingRoots) {
        yield* requireNativePlugin(context, row, "root");
      }

      const rootNeedsRotate = Effect.fnUntraced(function* (
        host: "%" | "localhost",
      ): Effect.fn.Return<boolean, ReturnType<AdapterContext["failure"]>> {
        if (host === "localhost") {
          const probe = yield* context.run(
            socketRequest(context, { user: "root", password: rootPassword }, "SELECT CURRENT_USER();"),
          );
          if (probe.state === "accepted" && /^root@localhost$/u.test(firstLine(probe.stdout))) return false;
          if (probe.state === "rejected") return true;
          return yield* Effect.fail(
            context.failure(
              "Could not prove root@localhost against the desired root password.",
              probe.exitCode,
            ),
          );
        }
        if (isLoopback(context.host)) {
          return yield* Effect.fail(
            context.failure(
              "root@'%' exists but the container has no non-loopback address to prove that account; refusing root rotation.",
            ),
          );
        }
        const probe = yield* context.run(
          tcpRequest(context, {
            user: "root",
            password: rootPassword,
            host: context.host,
            sql: "SELECT CURRENT_USER();",
          }),
        );
        if (probe.state === "accepted" && firstLine(probe.stdout) === "root@%") return false;
        if (probe.state === "rejected") return true;
        return yield* Effect.fail(
          context.failure("Could not prove root@'%' against the desired root password.", probe.exitCode),
        );
      });

      if (rootPercent !== undefined && (yield* rootNeedsRotate("%"))) {
        steps.push(
          step(
            ["rootPassword"],
            socketRequest(
              context,
              adminCredential,
              `ALTER USER ${account("root", "%")} IDENTIFIED BY ${lit(rootPassword)};`,
            ),
          ),
        );
      }
      if (rootLocal !== undefined && (yield* rootNeedsRotate("localhost"))) {
        steps.push(
          step(
            ["rootPassword"],
            socketRequest(
              context,
              adminCredential,
              `ALTER USER ${account("root", "localhost")} IDENTIFIED BY ${lit(rootPassword)};`,
            ),
          ),
        );
      }
    }

    return steps;
  });

  const prove = Effect.fnUntraced(function* (candidate: AdminCredential) {
    if (context.family === "mysql") {
      const result = yield* runAdmin(candidate, mysqlAdminProofSql);
      return result.exitCode === 0 && result.stdout.trim() === "1";
    }
    const result = yield* runAdmin(candidate, "SELECT CURRENT_USER(); SHOW GRANTS FOR CURRENT_USER;");
    if (result.exitCode !== 0 || firstLine(result.stdout) !== "lando_admin@localhost") return false;
    return lines(result.stdout).some((line) =>
      /^GRANT ALL PRIVILEGES ON \*\.\* TO .* WITH GRANT OPTION$/iu.test(line),
    );
  });
  const adoption = Effect.fnUntraced(function* (candidate: AdminCredential, managed: AdminCredential) {
    const result = yield* runAdmin(candidate, "SELECT COUNT(*) FROM mysql.user WHERE User = 'lando_admin';");
    if (result.exitCode !== 0 || firstLine(result.stdout) !== "0") {
      return yield* context.failure(
        "Cannot prove the reserved MySQL administrator is absent. Inspect lando_admin or restore the Lando seed.",
      );
    }
    const local = "'lando_admin'@'localhost'";
    const marker = context.family === "mysql" ? " COMMENT 'lando:db-admin:v1'" : "";
    return socketRequest(
      context,
      candidate,
      `CREATE USER ${local} IDENTIFIED BY ${lit(managed.password)}${marker};\nGRANT ALL PRIVILEGES ON *.* TO ${local} WITH GRANT OPTION;` +
        (context.family === "mysql" ? `\nGRANT SYSTEM_USER ON *.* TO ${local} WITH GRANT OPTION;` : ""),
    );
  });
  const listSiblings = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* runAdmin(
      candidate,
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME LIMIT 17;",
    );
    if (result.exitCode !== 0) return yield* context.failure("Could not read the MySQL database inventory.");
    return lines(result.stdout);
  });
  return { admin, delta, listSiblings, managed: { prove, adoption } };
};
