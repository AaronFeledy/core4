import { Effect } from "effect";
import { classifyAdminFailure, firstTrimmedLine, step } from "./client.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialAdapter,
  CredentialStep,
} from "./types.ts";

const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";
const SYSTEM_DATABASES = new Set(["master", "model", "msdb", "tempdb"]);
const IDENT_MAX = 128;
const CONNECT_TIMEOUT = "2";
const QUERY_TIMEOUT = "5";

const ident = (value: string): string => `[${value.replaceAll("]", "]]")}]`;
const lit = (value: string): string => `N'${value.replaceAll("'", "''")}'`;

const isSafeSqlcmdValue = (value: string): boolean =>
  value.length > 0 && value.length <= IDENT_MAX && !/[\p{Cc}\p{Cs}]/u.test(value) && !value.includes("\x00");

const envFor = (password: string): Record<string, string> => ({
  SQLCMDPASSWORD: password,
  SA_PASSWORD: password,
  MSSQL_SA_PASSWORD: password,
});

const baseArgv = (port: number, login: { readonly user: string; readonly database?: string }): string[] => [
  SQLCMD,
  "-S",
  `127.0.0.1,${port}`,
  "-U",
  login.user,
  "-C",
  "-b",
  "-r1",
  "-d",
  login.database ?? "master",
  "-l",
  CONNECT_TIMEOUT,
  "-t",
  QUERY_TIMEOUT,
  "-x",
  "-h",
  "-1",
  "-W",
];

const sqlRequest = (
  context: AdapterContext,
  password: string,
  sql: string,
  login: Parameters<typeof baseArgv>[1] = { user: "sa" },
): ClientRequest => ({
  argv: baseArgv(context.port, login),
  env: envFor(password),
  stdin: `${sql.trimEnd()}\nGO\n`,
});

const privilegeDenied = (result: ClientResult): boolean =>
  /permission was denied/iu.test(result.stderr) ||
  /is not a valid login or you do not have permission/iu.test(result.stderr) ||
  /Cannot find the (?:server |database )?principal/iu.test(result.stderr);

export const mssql = (context: AdapterContext): CredentialAdapter => {
  if (context.family !== "mssql") {
    return {
      admin: () => Effect.fail(context.failure("mssql adapter only serves mssql.")),
      delta: () => Effect.fail(context.failure("mssql adapter only serves mssql.")),
    };
  }

  const admin = Effect.fnUntraced(function* (
    candidate: AdminCredential,
  ): Effect.fn.Return<
    "accepted" | "rejected" | "insufficient-privilege",
    ReturnType<AdapterContext["failure"]>
  > {
    if (candidate.user !== "sa") return "rejected";
    const result = yield* context.run(
      sqlRequest(
        context,
        candidate.password,
        [
          "SET NOCOUNT ON;",
          "SELECT CASE WHEN ORIGINAL_LOGIN() = N'sa' AND IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN N'1' ELSE N'0' END;",
          "SELECT CAST(is_disabled AS int) FROM sys.server_principals WHERE name = N'sa';",
        ].join("\n"),
      ),
    );
    if (result.exitCode !== 0 || result.state !== "accepted") {
      return yield* classifyAdminFailure(context, result, privilegeDenied);
    }
    const out = result.stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const proof = out[0];
    const disabled = out[1];
    if (proof !== "1") return "insufficient-privilege";
    if (disabled === "1") {
      return yield* Effect.fail(context.failure("The sa login is disabled; refusing credential apply."));
    }
    return "accepted";
  });

  const delta = Effect.fnUntraced(function* (
    adminCredential: AdminCredential,
  ): Effect.fn.Return<readonly CredentialStep[], ReturnType<AdapterContext["failure"]>> {
    const { desired } = context;
    const adminLogin = { user: adminCredential.user };
    const runAdmin = (sql: string) =>
      context.run(sqlRequest(context, adminCredential.password, sql, adminLogin));
    if (!isSafeSqlcmdValue(desired.database)) {
      return yield* Effect.fail(context.failure("The desired database name cannot be represented safely."));
    }
    if (SYSTEM_DATABASES.has(desired.database.toLowerCase())) {
      return yield* Effect.fail(
        context.failure(
          `Refusing to create or retarget the reserved SQL Server database ${desired.database}.`,
        ),
      );
    }
    const password = desired.rootPassword ?? desired.password;
    if (!isSafeSqlcmdValue(password)) {
      return yield* Effect.fail(context.failure("The desired sa password cannot be represented safely."));
    }

    // Positive catalog evidence only (sys.databases). Never use classifier database-missing as absence.
    const inventory = yield* runAdmin(
      [
        "SET NOCOUNT ON;",
        // Tab-separated name and state for stable parsing under -h -1 -W.
        `SELECT CONCAT(name COLLATE DATABASE_DEFAULT, CHAR(9), state_desc COLLATE DATABASE_DEFAULT) FROM sys.databases WHERE name = ${lit(desired.database)};`,
      ].join("\n"),
    );
    if (inventory.state === "rejected") {
      return yield* Effect.fail(
        context.failure(
          "Administrator authentication failed while reading the catalog.",
          inventory.exitCode,
          "transient",
        ),
      );
    }
    if (inventory.exitCode !== 0) {
      if (privilegeDenied(inventory)) {
        return yield* Effect.fail(
          context.failure("Administrator lacks privilege to inspect databases.", inventory.exitCode),
        );
      }
      return yield* Effect.fail(
        context.failure("Could not inspect the SQL Server catalog.", inventory.exitCode),
      );
    }

    const dbLine = firstTrimmedLine(inventory.stdout);
    const steps: CredentialStep[] = [];

    if (dbLine.length === 0) {
      steps.push(
        step(
          ["database"],
          sqlRequest(
            context,
            adminCredential.password,
            `CREATE DATABASE ${ident(desired.database)};`,
            adminLogin,
          ),
        ),
      );
    } else {
      const tab = dbLine.indexOf("\t");
      const state = tab === -1 ? "" : dbLine.slice(tab + 1).trim();
      if (state.length > 0 && state.toUpperCase() !== "ONLINE") {
        return yield* Effect.fail(
          context.failure(
            `Database ${desired.database} exists but is not ONLINE; refusing to change policy or recreate it.`,
          ),
        );
      }
    }

    const login = yield* context.run(
      sqlRequest(context, password, "SET NOCOUNT ON;\nSELECT ORIGINAL_LOGIN();", {
        user: "sa",
        ...(dbLine.length === 0 ? {} : { database: desired.database }),
      }),
    );
    if (login.state === "rejected") {
      // One sa mutation is reported under both password and rootPassword aliases.
      steps.push(
        step(
          ["password", "rootPassword"],
          sqlRequest(
            context,
            adminCredential.password,
            `ALTER LOGIN ${ident("sa")} WITH PASSWORD = ${lit(password)};`,
            adminLogin,
          ),
        ),
      );
    } else if (
      login.state !== "accepted" ||
      login.exitCode !== 0 ||
      firstTrimmedLine(login.stdout).toLowerCase() !== "sa"
    ) {
      return yield* Effect.fail(
        context.failure("Could not prove the desired sa password against SQL Server.", login.exitCode),
      );
    }

    return steps;
  });

  const prove = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* context.run(
      sqlRequest(
        context,
        candidate.password,
        "SET NOCOUNT ON; SELECT CASE WHEN ORIGINAL_LOGIN() = N'lando_admin' AND IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 1 ELSE 0 END;",
        { user: candidate.user },
      ),
    );
    return result.exitCode === 0 && firstTrimmedLine(result.stdout) === "1";
  });
  const adoption = Effect.fnUntraced(function* (candidate: AdminCredential, managed: AdminCredential) {
    const result = yield* context.run(
      sqlRequest(
        context,
        candidate.password,
        "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.server_principals WHERE name = N'lando_admin';",
      ),
    );
    if (result.exitCode !== 0 || firstTrimmedLine(result.stdout) !== "0") {
      return yield* context.failure(
        "Cannot prove the reserved SQL Server administrator is absent. Inspect lando_admin or restore the Lando seed.",
      );
    }
    return sqlRequest(
      context,
      candidate.password,
      `SET XACT_ABORT ON; BEGIN TRANSACTION; CREATE LOGIN [lando_admin] WITH PASSWORD = ${lit(managed.password)}; ALTER SERVER ROLE [sysadmin] ADD MEMBER [lando_admin]; COMMIT TRANSACTION;`,
    );
  });
  const listSiblings = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* context.run(
      sqlRequest(
        context,
        candidate.password,
        "SET NOCOUNT ON; SELECT TOP (17) name FROM sys.databases WHERE database_id > 4 ORDER BY name;",
        { user: candidate.user },
      ),
    );
    if (result.exitCode !== 0)
      return yield* context.failure("Could not read the SQL Server database inventory.");
    return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  });
  return { admin, delta, listSiblings, managed: { prove, adoption } };
};
