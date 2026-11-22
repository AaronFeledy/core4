import { describe, expect, test } from "bun:test";
import { classifyDatabaseClientResult } from "@lando/sdk/database-creds";
import { SqlCredentialApplyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";

import { mssql } from "../../src/operations/database-convergence/mssql.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialStep,
} from "../../src/operations/database-convergence/types.ts";

const SECRET = "MssqlDesired1!";
const ADMIN_SECRET = "MssqlAdmin1!";
const CANARY = "leak-canary-Mssql9!";

const failure = (message: string, exitCode?: number) =>
  new SqlCredentialApplyError({
    service: "database",
    family: "mssql",
    phase: "preflight",
    mutation: "none",
    completed: [],
    message,
    ...(exitCode === undefined ? {} : { exitCode }),
    remediation:
      "Check the database client, authentication policy, and administrator privileges before retrying.",
  });

type Handler = (request: ClientRequest) => ClientResult;

const result = (partial: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}): ClientResult => {
  const exitCode = partial.exitCode ?? 0;
  const stderr = partial.stderr ?? "";
  return {
    stdout: partial.stdout ?? "",
    stderr,
    exitCode,
    state: classifyDatabaseClientResult("mssql", { exitCode, stderr }),
  };
};

const rejected = () =>
  result({
    exitCode: 1,
    stderr: "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user 'sa'.",
  });

const makeContext = (options: {
  readonly desired?: Partial<AdapterContext["desired"]>;
  readonly applied?: Partial<AdapterContext["applied"]>;
  readonly handle: Handler;
}): AdapterContext => ({
  family: "mssql",
  port: 1433,
  host: "127.0.0.1",
  desired: {
    user: "sa",
    database: "appdb",
    password: SECRET,
    rootPassword: SECRET,
    ...options.desired,
  },
  applied: {
    user: "sa",
    password: ADMIN_SECRET,
    rootPassword: ADMIN_SECRET,
    ...options.applied,
  },
  service: ServiceName.make("database"),
  run: (request) => Effect.succeed(options.handle(request)),
  failure,
});

const runAdmin = <A>(effect: Effect.Effect<A, SqlCredentialApplyError>) => Effect.runPromise(effect);
const runExit = <A>(effect: Effect.Effect<A, SqlCredentialApplyError>) => Effect.runPromiseExit(effect);

const firstStep = (steps: readonly CredentialStep[]) => {
  const step = steps[0];
  if (step === undefined) throw new Error("expected at least one credential step");
  return step;
};

const stdinOf = (request: ClientRequest): string => request.stdin ?? "";
const argvJoined = (request: ClientRequest): string => request.argv.join(" ");

const isAdminProof = (request: ClientRequest): boolean =>
  stdinOf(request).includes("ORIGINAL_LOGIN()") && stdinOf(request).includes("IS_SRVROLEMEMBER");
const isInventory = (request: ClientRequest): boolean =>
  stdinOf(request).includes("sys.databases") && stdinOf(request).includes("state_desc");
const isPasswordProbe = (request: ClientRequest): boolean =>
  stdinOf(request).includes("ORIGINAL_LOGIN()") && !stdinOf(request).includes("IS_SRVROLEMEMBER");
const isCreateDatabase = (request: ClientRequest): boolean => stdinOf(request).includes("CREATE DATABASE");
const isAlterLogin = (request: ClientRequest): boolean => stdinOf(request).includes("ALTER LOGIN");

const catalogHandler = (options: {
  readonly inventory?: string;
  readonly passwordProbe?: ClientResult;
  readonly adminPassword?: string;
}): Handler => {
  return (request) => {
    const pwd = request.env?.SQLCMDPASSWORD ?? "";
    if (isAdminProof(request)) {
      if (options.adminPassword !== undefined && pwd !== options.adminPassword) return rejected();
      return result({ stdout: "1\n0\n" });
    }
    if (isInventory(request)) {
      if (options.adminPassword !== undefined && pwd !== options.adminPassword) return rejected();
      return result({ stdout: options.inventory ?? "appdb\tONLINE\n" });
    }
    if (isPasswordProbe(request)) {
      return options.passwordProbe ?? result({ stdout: "sa\n" });
    }
    if (isCreateDatabase(request) || isAlterLogin(request)) {
      return result({ stdout: "" });
    }
    return result({ exitCode: 1, stderr: `unhandled: ${stdinOf(request).slice(0, 80)}` });
  };
};

describe("mssql credential adapter admin", () => {
  test("accepts sa with sysadmin proof", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({ adminPassword: ADMIN_SECRET }),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "sa", password: ADMIN_SECRET }))).resolves.toBe("accepted");
  });

  test("rejects non-sa candidates without a client call", async () => {
    let called = 0;
    const adapter = mssql(
      makeContext({
        handle: () => {
          called += 1;
          return result({ stdout: "1\n0\n" });
        },
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "app", password: ADMIN_SECRET }))).resolves.toBe("rejected");
    expect(called).toBe(0);
  });

  test("classifies login failure via shared classifier", async () => {
    const adapter = mssql(
      makeContext({
        handle: () => rejected(),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "sa", password: "nope" }))).resolves.toBe("rejected");
  });

  test("projects sa aliases into SQLCMDPASSWORD environment and keeps secrets off argv", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mssql(
      makeContext({
        handle: (request) => {
          calls.push(request);
          return result({ stdout: "1\n0\n" });
        },
      }),
    );
    await runAdmin(adapter.admin({ user: "sa", password: ADMIN_SECRET }));
    expect(calls[0]?.env?.SQLCMDPASSWORD).toBe(ADMIN_SECRET);
    expect(calls[0]?.env?.SA_PASSWORD).toBe(ADMIN_SECRET);
    expect(calls[0]?.env?.MSSQL_SA_PASSWORD).toBe(ADMIN_SECRET);
    expect(
      argvJoined(
        calls[0] ??
          (() => {
            throw new Error("expected call");
          })(),
      ),
    ).not.toContain(ADMIN_SECRET);
    expect(calls[0]?.argv[0]).toBe("/opt/mssql-tools18/bin/sqlcmd");
    expect(calls[0]?.argv).toContain("-x");
  });
});

describe("mssql credential adapter delta", () => {
  const admin: AdminCredential = { user: "sa", password: ADMIN_SECRET };

  test("returns no steps when database and sa password already match", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({
          inventory: "appdb\tONLINE\n",
          passwordProbe: result({ stdout: "sa\n" }),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toEqual([]);
  });

  test("missing database plans CREATE DATABASE from positive catalog absence", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({
          inventory: "",
          passwordProbe: result({ stdout: "sa\n" }),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    expect([...firstStep(steps).members]).toEqual(["database"]);
    expect(isCreateDatabase(firstStep(steps).request)).toBe(true);
    expect(stdinOf(firstStep(steps).request)).toContain("CREATE DATABASE [appdb];");
  });

  test("rejected desired sa password plans ALTER LOGIN under both aliases", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({
          inventory: "appdb\tONLINE\n",
          passwordProbe: rejected(),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    expect([...firstStep(steps).members]).toEqual(["password", "rootPassword"]);
    expect(isAlterLogin(firstStep(steps).request)).toBe(true);
    expect(stdinOf(firstStep(steps).request)).toContain("ALTER LOGIN [sa] WITH PASSWORD = ");
    expect(stdinOf(firstStep(steps).request)).toContain(`N'${SECRET}'`);
    expect(argvJoined(firstStep(steps).request)).not.toContain(SECRET);
  });

  test("plans create then rotate when both database and password need repair", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({
          inventory: "",
          passwordProbe: rejected(),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps.map((step: CredentialStep) => [...step.members])).toEqual([
      ["database"],
      ["password", "rootPassword"],
    ]);
  });

  test("quotes identifiers and password literals with doubled metacharacters", async () => {
    const password = "p'ass]word!";
    const adapter = mssql(
      makeContext({
        desired: { database: "db]y", password, rootPassword: password },
        handle: catalogHandler({
          inventory: "",
          passwordProbe: rejected(),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    const sql = steps.map((step) => stdinOf(step.request)).join("\n");
    expect(sql).toContain("CREATE DATABASE [db]]y];");
    expect(sql).toContain("ALTER LOGIN [sa] WITH PASSWORD = N'p''ass]word!';");
  });

  test("refuses reserved system databases", async () => {
    for (const database of ["master", "model", "msdb", "tempdb"]) {
      const adapter = mssql(
        makeContext({
          desired: { database },
          handle: () => {
            throw new Error("no client");
          },
        }),
      );
      const exit = await runExit(adapter.delta(admin));
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  test("refuses offline existing database rather than recreating it", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({
          inventory: "appdb\tOFFLINE\n",
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("never treats classifier database-missing as permission to create", async () => {
    // Positive absence is empty inventory stdout; a login that would classify as
    // database-missing must not by itself schedule CREATE DATABASE.
    const adapter = mssql(
      makeContext({
        handle: (request) => {
          if (isInventory(request)) return result({ stdout: "appdb\tONLINE\n" });
          if (isPasswordProbe(request)) {
            return result({
              exitCode: 1,
              stderr: 'Cannot open database "other" requested by the login.',
            });
          }
          if (isAdminProof(request)) return result({ stdout: "1\n0\n" });
          return result({ stdout: "" });
        },
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    // Password probe unclassified as rejected (database-missing state) is fail-closed, not create.
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("fail-closed when desired password proof is unverified", async () => {
    const adapter = mssql(
      makeContext({
        handle: catalogHandler({
          inventory: "appdb\tONLINE\n",
          passwordProbe: result({ exitCode: 2, stderr: "Sqlcmd: Error: network error" }),
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("keeps canary secrets off argv", async () => {
    const adapter = mssql(
      makeContext({
        desired: { password: CANARY, rootPassword: CANARY, database: "freshdb" },
        handle: catalogHandler({
          inventory: "",
          passwordProbe: rejected(),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    for (const step of steps) {
      expect(argvJoined(step.request)).not.toContain(CANARY);
      expect(JSON.stringify(step.request.argv)).not.toContain(CANARY);
    }
    const alter = steps.find((step) => isAlterLogin(step.request));
    expect(alter?.request.stdin).toContain(CANARY);
  });
});
