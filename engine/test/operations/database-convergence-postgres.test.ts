import { describe, expect, test } from "bun:test";
import { SqlCredentialApplyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";
import { postgres } from "../../src/operations/database-convergence/postgres.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
} from "../../src/operations/database-convergence/types.ts";

const SECRET = "desired-s3cret";
const ADMIN_SECRET = "admin-s3cret";
const OLD_SECRET = "old-s3cret";
const CANARY = "canary-leak-value-9f3a";

const failure = (message: string, exitCode?: number) =>
  new SqlCredentialApplyError({
    service: "db",
    family: "postgres",
    phase: "preflight",
    mutation: "none",
    completed: [],
    message,
    ...(exitCode === undefined ? {} : { exitCode }),
    remediation:
      "Check the database client, authentication policy, and administrator privileges before retrying.",
  });

type Handler = (request: ClientRequest) => ClientResult | SqlCredentialApplyError;

const result = (partial: Partial<ClientResult> & Pick<ClientResult, "state">): ClientResult => ({
  stdout: partial.stdout ?? "",
  stderr: partial.stderr ?? "",
  exitCode: partial.exitCode ?? (partial.state === "accepted" ? 0 : 1),
  state: partial.state,
});

const contextOf = (options: {
  readonly host?: string;
  readonly desired?: Partial<AdapterContext["desired"]>;
  readonly applied?: Partial<AdapterContext["applied"]>;
  readonly handle: Handler;
}): AdapterContext => ({
  family: "postgres",
  port: 5432,
  host: options.host ?? "10.89.0.2",
  desired: {
    user: "app",
    database: "appdb",
    password: SECRET,
    ...options.desired,
  },
  applied: {
    user: "app",
    password: OLD_SECRET,
    ...options.applied,
  },
  service: ServiceName.make("db"),
  run: (request) => {
    const outcome = options.handle(request);
    return outcome instanceof SqlCredentialApplyError ? Effect.fail(outcome) : Effect.succeed(outcome);
  },
  failure,
});

const runAdmin = (ctx: AdapterContext, candidate: AdminCredential) =>
  Effect.runPromise(postgres(ctx).admin(candidate));

const runDelta = (ctx: AdapterContext, admin: AdminCredential) =>
  Effect.runPromise(postgres(ctx).delta(admin));

const runDeltaExit = (ctx: AdapterContext, admin: AdminCredential) =>
  Effect.runPromiseExit(postgres(ctx).delta(admin));

const argvText = (request: ClientRequest | undefined): string => request?.argv.join(" ") ?? "";
const sqlText = (request: ClientRequest | undefined): string => request?.stdin ?? argvText(request);

const isInventory = (request: ClientRequest): boolean =>
  sqlText(request).includes("pg_roles") && sqlText(request).includes("pg_database");

const isSuperCheck = (request: ClientRequest): boolean =>
  argvText(request).includes("rolsuper") && argvText(request).includes("current_user");

const isPasswordMeta = (request: ClientRequest | undefined): boolean =>
  request?.argv.some((part) => part.startsWith("\\password ")) === true;

const isTcpLogin = (request: ClientRequest): boolean =>
  request.argv.includes("-h") &&
  !request.argv.includes("/var/run/postgresql") &&
  request.argv.includes("SELECT 1");

const isCreateRole = (request: ClientRequest | undefined): boolean =>
  sqlText(request).includes("CREATE ROLE");
const isCreateDatabase = (request: ClientRequest | undefined): boolean =>
  sqlText(request).includes("CREATE DATABASE");

describe("postgres credential adapter", () => {
  test("refuses to reuse a marked socket administrator when host trust is unsafe", async () => {
    const ctx = contextOf({
      handle: (request) =>
        result({
          state: "accepted",
          stdout: sqlText(request).includes("pg_hba_file_rules") ? "f\n" : "t\n",
        }),
    });
    const managed = postgres(ctx).managed;
    if (managed === undefined) throw new Error("Expected managed PostgreSQL support");
    await expect(Effect.runPromise(managed.prove({ user: "lando_admin", password: "" }))).resolves.toBe(
      false,
    );
  });

  test("admin accepts socket superuser and rejects non-superuser", async () => {
    const accepted = contextOf({
      handle: (request) => {
        expect(request.argv).toContain("/var/run/postgresql");
        expect(request.argv).not.toContain("10.89.0.2");
        expect(isSuperCheck(request)).toBe(true);
        return result({ state: "accepted", stdout: "t\n" });
      },
    });
    await expect(runAdmin(accepted, { user: "lando", password: "" })).resolves.toBe("accepted");

    const plain = contextOf({
      handle: () => result({ state: "accepted", stdout: "f\n" }),
    });
    await expect(runAdmin(plain, { user: "app", password: SECRET })).resolves.toBe("insufficient-privilege");
  });

  test("admin classifies password rejection and privilege errors", async () => {
    const rejected = contextOf({
      handle: () =>
        result({
          state: "rejected",
          exitCode: 2,
          stderr: 'psql: error: connection failed: FATAL: password authentication failed for user "lando"',
        }),
    });
    await expect(runAdmin(rejected, { user: "lando", password: "nope" })).resolves.toBe("rejected");

    const denied = contextOf({
      handle: () =>
        result({
          state: "unverified",
          exitCode: 1,
          stderr: "ERROR: permission denied for table pg_roles",
        }),
    });
    await expect(runAdmin(denied, { user: "app", password: SECRET })).resolves.toBe("insufficient-privilege");
  });

  test("explicit admin uses TCP host and keeps TCP for later requests", async () => {
    const requests: ClientRequest[] = [];
    const ctx = contextOf({
      host: "10.89.0.7",
      handle: (request) => {
        requests.push(request);
        if (isSuperCheck(request)) {
          expect(request.argv).toContain("-h");
          expect(request.argv).toContain("10.89.0.7");
          expect(request.argv).not.toContain("/var/run/postgresql");
          expect(request.env?.PGPASSWORD).toBe(ADMIN_SECRET);
          return result({ state: "accepted", stdout: "t\n" });
        }
        if (isInventory(request)) {
          expect(request.argv).toContain("10.89.0.7");
          expect(request.env?.PGPASSWORD).toBe(ADMIN_SECRET);
          return result({ state: "accepted", stdout: "t\tf\n" });
        }
        if (isTcpLogin(request)) {
          const password = request.env?.PGPASSWORD ?? "";
          if (password === SECRET) return result({ state: "accepted", stdout: "1\n" });
          return result({
            state: "rejected",
            stderr: "password authentication failed",
          });
        }
        if (isCreateDatabase(request)) {
          expect(request.argv).toContain("10.89.0.7");
          expect(request.env?.PGPASSWORD).toBe(ADMIN_SECRET);
          return result({ state: "accepted" });
        }
        return result({ state: "accepted" });
      },
    });
    const adapter = postgres(ctx);
    await expect(
      Effect.runPromise(adapter.admin({ user: "lando", password: ADMIN_SECRET, explicit: true })),
    ).resolves.toBe("accepted");
    const steps = await Effect.runPromise(
      adapter.delta({ user: "lando", password: ADMIN_SECRET, explicit: true }),
    );
    expect(steps.map((step) => step.members)).toEqual([["database"]]);
    expect(requests.every((request) => request.argv.includes("10.89.0.7"))).toBe(true);
    expect(requests.every((request) => !request.argv.includes("/var/run/postgresql"))).toBe(true);
  });

  test("explicit admin on loopback fails closed before any client call", async () => {
    let called = 0;
    const ctx = contextOf({
      host: "127.0.0.1",
      handle: () => {
        called += 1;
        return result({ state: "accepted", stdout: "t\n" });
      },
    });
    const exit = await Effect.runPromiseExit(
      postgres(ctx).admin({ user: "lando", password: ADMIN_SECRET, explicit: true }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(called).toBe(0);
  });

  test("already-matched role and database yields no steps", async () => {
    const ctx = contextOf({
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "t\tt\n" });
        if (isTcpLogin(request)) {
          const password = request.env?.PGPASSWORD ?? "";
          if (password === SECRET) return result({ state: "accepted", stdout: "1\n" });
          return result({ state: "rejected", stderr: "password authentication failed" });
        }
        throw new Error(`unexpected request ${argvText(request)}`);
      },
    });
    const steps = await runDelta(ctx, { user: "lando", password: "" });
    expect(steps).toEqual([]);
  });

  test("missing role plans CREATE ROLE SUPERUSER then password meta-command", async () => {
    const ctx = contextOf({
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "f\tt\n" });
        throw new Error(`unexpected ${argvText(request)}`);
      },
    });
    const steps = await runDelta(ctx, { user: "lando", password: "" });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.members).toEqual(["user", "password"]);
    expect(isCreateRole(steps[0]?.request)).toBe(true);
    expect(sqlText(steps[0]?.request)).toContain("LOGIN SUPERUSER");
    expect(steps[0]?.request.argv).toContain("/var/run/postgresql");
    expect(steps[1]?.members).toEqual(["password"]);
    expect(isPasswordMeta(steps[1]?.request)).toBe(true);
    expect(steps[1]?.request.stdin).toBe(`${SECRET}\n${SECRET}\n`);
    expect(argvText(steps[1]?.request)).toContain('\\password "app"');
    expect(argvText(steps[0]?.request)).not.toContain(SECRET);
    expect(argvText(steps[1]?.request)).not.toContain(SECRET);
  });

  test("rejected desired password plans password-only change without promoting the role", async () => {
    const ctx = contextOf({
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "t\tt\n" });
        if (isTcpLogin(request)) {
          return result({ state: "rejected", stderr: 'password authentication failed for user "app"' });
        }
        throw new Error(`unexpected ${argvText(request)}`);
      },
    });
    const steps = await runDelta(ctx, { user: "lando", password: "" });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.members).toEqual(["password"]);
    expect(isPasswordMeta(steps[0]?.request)).toBe(true);
    expect(argvText(steps[0]?.request)).not.toContain("ALTER ROLE");
    expect(argvText(steps[0]?.request)).not.toContain("SUPERUSER");
  });

  test("missing database plans CREATE DATABASE OWNER without owner repair on existing DB", async () => {
    const ctx = contextOf({
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "t\tf\n" });
        if (isTcpLogin(request)) {
          const password = request.env?.PGPASSWORD ?? "";
          if (password === SECRET) return result({ state: "accepted", stdout: "1\n" });
          return result({ state: "rejected", stderr: "password authentication failed" });
        }
        throw new Error(`unexpected ${argvText(request)}`);
      },
    });
    const steps = await runDelta(ctx, { user: "lando", password: "" });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.members).toEqual(["database"]);
    expect(isCreateDatabase(steps[0]?.request)).toBe(true);
    expect(sqlText(steps[0]?.request)).toContain("OWNER");
    expect(argvText(steps[0]?.request)).not.toContain("ALTER DATABASE");
  });

  test("trust-masked TCP password proof fails closed", async () => {
    const ctx = contextOf({
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "t\tt\n" });
        if (isTcpLogin(request)) return result({ state: "accepted", stdout: "1\n" });
        throw new Error(`unexpected ${argvText(request)}`);
      },
    });
    const exit = await runDeltaExit(ctx, { user: "lando", password: "" });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("trust is masking");
    }
  });

  test.each([
    { role: "existing", inventory: "t\tt\n" },
    { role: "missing", inventory: "f\tt\n" },
  ])("a loopback-only container refuses before reading the catalog when the role is $role", async (row) => {
    // A missing role skips the preflight password proof, so the refusal must precede planning:
    // otherwise apply would create the role and only then fail the verification proof.
    let called = 0;
    const ctx = contextOf({
      host: "127.0.0.1",
      handle: () => {
        called += 1;
        return result({ state: "accepted", stdout: row.inventory });
      },
    });
    const exit = await runDeltaExit(ctx, { user: "lando", password: "" });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("non-loopback");
    }
    expect(called).toBe(0);
  });

  test("refuses reserved template databases and unsafe names", async () => {
    for (const database of ["template0", "template1"]) {
      const ctx = contextOf({
        desired: { database },
        handle: () => {
          throw new Error("no client");
        },
      });
      const exit = await runDeltaExit(ctx, { user: "lando", password: "" });
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const unsafe = contextOf({
      desired: { user: "bad=user" },
      handle: () => {
        throw new Error("no client");
      },
    });
    const exit = await runDeltaExit(unsafe, { user: "lando", password: "" });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("refuses missing maintenance database named postgres", async () => {
    const ctx = contextOf({
      desired: { database: "postgres" },
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "t\tf\n" });
        throw new Error("unexpected");
      },
    });
    const exit = await runDeltaExit(ctx, { user: "lando", password: "" });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("quotes role names for password meta-command and keeps secrets off argv", async () => {
    const role = 'app"role';
    const ctx = contextOf({
      desired: { user: role, password: CANARY },
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "f\tt\n" });
        throw new Error("unexpected");
      },
    });
    const steps = await runDelta(ctx, { user: "lando", password: "" });
    const passwordStep = steps.find((step) => isPasswordMeta(step.request));
    expect(passwordStep).toBeDefined();
    expect(argvText(passwordStep?.request)).toContain('\\password "app""role"');
    for (const step of steps) {
      expect(argvText(step.request)).not.toContain(CANARY);
      expect(JSON.stringify(step.request.env ?? {})).not.toContain(CANARY);
    }
    expect(passwordStep?.request.stdin).toContain(CANARY);
  });

  test("password and create requests never place secrets on -c SQL", async () => {
    const ctx = contextOf({
      desired: { password: CANARY, user: "fresh", database: "freshdb" },
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "f\tf\n" });
        throw new Error("unexpected");
      },
    });
    const steps = await runDelta(ctx, { user: "postgres", password: "" });
    expect(steps.some((step) => isCreateRole(step.request))).toBe(true);
    expect(steps.some((step) => isCreateDatabase(step.request))).toBe(true);
    expect(steps.some((step) => isPasswordMeta(step.request))).toBe(true);
    for (const step of steps) {
      const joined = argvText(step.request);
      expect(joined).not.toContain(CANARY);
      expect(joined).not.toContain(encodeURIComponent(CANARY));
      if (!isPasswordMeta(step.request)) {
        expect(step.request.stdin ?? "").not.toContain(CANARY);
      }
    }
  });

  test("unverified password control (timeout) is not treated as a match", async () => {
    let logins = 0;
    const ctx = contextOf({
      handle: (request) => {
        if (isInventory(request)) return result({ state: "accepted", stdout: "t\tt\n" });
        if (isTcpLogin(request)) {
          logins += 1;
          if (logins === 1) return result({ state: "accepted", stdout: "1\n" });
          return result({ state: "unverified", exitCode: 2, stderr: "timeout expired" });
        }
        throw new Error("unexpected");
      },
    });
    const exit = await runDeltaExit(ctx, { user: "lando", password: "" });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("timeout is not proof");
    }
  });
});
