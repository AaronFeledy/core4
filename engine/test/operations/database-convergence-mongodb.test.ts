import { describe, expect, test } from "bun:test";
import { classifyDatabaseClientResult } from "@lando/sdk/database-creds";
import { SqlCredentialApplyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";

import { mongodb } from "../../src/operations/database-convergence/mongodb.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialStep,
} from "../../src/operations/database-convergence/types.ts";

const SECRET = "mongo-s3cret-value";
const ADMIN_SECRET = "admin-s3cret-value";
const CANARY = "leak-canary-mongo-9f3a";

const failure = (message: string, exitCode?: number) =>
  new SqlCredentialApplyError({
    service: "db",
    family: "mongodb",
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
    state: classifyDatabaseClientResult("mongodb", { exitCode, stderr }),
  };
};

const rejected = () =>
  result({
    exitCode: 1,
    stderr: "MongoServerError: Authentication failed.",
  });

const makeContext = (options: {
  readonly desired?: Partial<AdapterContext["desired"]>;
  readonly applied?: Partial<AdapterContext["applied"]>;
  readonly handle: Handler;
}): AdapterContext => ({
  family: "mongodb",
  port: 27017,
  host: "127.0.0.1",
  desired: {
    user: "lando",
    database: "appdb",
    password: SECRET,
    ...options.desired,
  },
  applied: {
    user: "lando",
    password: "old-mongo",
    ...options.applied,
  },
  service: ServiceName.make("db"),
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

const evalOf = (request: ClientRequest): string => request.env?.LANDO_MONGO_EVAL ?? "";
const uriOf = (request: ClientRequest): string => request.env?.MONGO_URI ?? "";

const isAdminProof = (request: ClientRequest): boolean => evalOf(request).includes("connectionStatus");
const isUserInfo = (request: ClientRequest): boolean => evalOf(request).includes("usersInfo");
const isCreateUser = (request: ClientRequest): boolean => evalOf(request).includes("createUser");
const isChangePassword = (request: ClientRequest): boolean => evalOf(request).includes("changeUserPassword");
const isPing = (request: ClientRequest): boolean =>
  evalOf(request).includes("ping:1") || evalOf(request).includes("ping: 1");

const catalogHandler = (options: {
  readonly usersInfo?: string;
  readonly appLogin?: ClientResult;
  readonly adminPassword?: string;
}): Handler => {
  return (request) => {
    if (isAdminProof(request)) {
      if (
        options.adminPassword !== undefined &&
        !uriOf(request).includes(encodeURIComponent(options.adminPassword))
      ) {
        return rejected();
      }
      return result({ stdout: "1\n" });
    }
    if (isUserInfo(request)) {
      return result({ stdout: `${options.usersInfo ?? "1"}\n` });
    }
    if (isPing(request)) {
      return options.appLogin ?? result({ stdout: "{ ok: 1 }\n" });
    }
    if (isCreateUser(request) || isChangePassword(request)) {
      return result({ stdout: "" });
    }
    return result({ exitCode: 1, stderr: `unhandled: ${evalOf(request).slice(0, 80)}` });
  };
};

describe("mongodb credential adapter admin", () => {
  test("accepts a root-authenticated admin over MONGO_URI", async () => {
    const adapter = mongodb(
      makeContext({
        handle: catalogHandler({ adminPassword: ADMIN_SECRET }),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "lando", password: ADMIN_SECRET }))).resolves.toBe(
      "accepted",
    );
  });

  test("rejects authentication failures via shared classifier", async () => {
    const adapter = mongodb(
      makeContext({
        handle: () => rejected(),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "lando", password: "nope" }))).resolves.toBe("rejected");
  });

  test("returns insufficient-privilege when root role is absent", async () => {
    const adapter = mongodb(
      makeContext({
        handle: () => result({ stdout: "0\n" }),
      }),
    );
    await expect(runAdmin(adapter.admin({ user: "app", password: SECRET }))).resolves.toBe(
      "insufficient-privilege",
    );
  });

  test("never places secrets on argv", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mongodb(
      makeContext({
        handle: (request) => {
          calls.push(request);
          return result({ stdout: "1\n" });
        },
      }),
    );
    await runAdmin(adapter.admin({ user: "lando", password: ADMIN_SECRET }));
    expect(calls[0]?.argv.some((part) => part.includes(ADMIN_SECRET))).toBe(false);
    expect(JSON.stringify(calls[0]?.argv)).not.toContain(ADMIN_SECRET);
    expect(
      uriOf(
        calls[0] ??
          (() => {
            throw new Error("expected call");
          })(),
      ),
    ).toContain(encodeURIComponent(ADMIN_SECRET));
  });
});

describe("mongodb credential adapter delta", () => {
  const admin: AdminCredential = { user: "lando", password: ADMIN_SECRET };

  test("returns no steps when user and password already match", async () => {
    const adapter = mongodb(
      makeContext({
        handle: catalogHandler({
          usersInfo: "1",
          appLogin: result({ stdout: "{ ok: 1 }\n" }),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toEqual([]);
  });

  test("database-name-only drift is a logical no-op with no namespace create", async () => {
    const calls: ClientRequest[] = [];
    const adapter = mongodb(
      makeContext({
        desired: { database: "brand-new-db" },
        handle: (request) => {
          calls.push(request);
          return catalogHandler({
            usersInfo: "1",
            appLogin: result({ stdout: "{ ok: 1 }\n" }),
          })(request);
        },
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toEqual([]);
    expect(calls.some((call) => evalOf(call).includes("createCollection"))).toBe(false);
    expect(calls.some((call) => evalOf(call).includes("createUser"))).toBe(false);
  });

  test("missing user plans createUser with root role", async () => {
    const adapter = mongodb(
      makeContext({
        handle: catalogHandler({ usersInfo: "0" }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    expect([...firstStep(steps).members]).toEqual(["user", "password"]);
    expect(isCreateUser(firstStep(steps).request)).toBe(true);
    expect(evalOf(firstStep(steps).request)).toContain('role:"root"');
    expect(firstStep(steps).request.env?.MONGO_TARGET_USER).toBe("lando");
    expect(firstStep(steps).request.env?.MONGO_TARGET_PASSWORD).toBe(SECRET);
    expect(JSON.stringify(firstStep(steps).request.argv)).not.toContain(SECRET);
  });

  test("rejected desired password plans changeUserPassword only", async () => {
    const adapter = mongodb(
      makeContext({
        handle: catalogHandler({
          usersInfo: "1",
          appLogin: rejected(),
        }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps).toHaveLength(1);
    expect([...firstStep(steps).members]).toEqual(["password"]);
    expect(isChangePassword(firstStep(steps).request)).toBe(true);
    expect(isCreateUser(firstStep(steps).request)).toBe(false);
  });

  test("refuses reserved system database names", async () => {
    for (const database of ["admin", "config", "local"]) {
      const adapter = mongodb(
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

  test("refuses unsafe login names before any client call", async () => {
    let called = 0;
    const adapter = mongodb(
      makeContext({
        desired: { user: "bad\0user" },
        handle: () => {
          called += 1;
          return result({ stdout: "1\n" });
        },
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(called).toBe(0);
  });

  test("positive usersInfo absence is required; never invents create from classifier database-missing", async () => {
    const adapter = mongodb(
      makeContext({
        handle: (request) => {
          if (isUserInfo(request)) return result({ stdout: "1\n" });
          if (isPing(request)) {
            // Unrelated missing-db style noise must not drive user creation.
            return result({
              exitCode: 1,
              stderr: "MongoServerError: Authentication failed.",
            });
          }
          if (isAdminProof(request)) return result({ stdout: "1\n" });
          return result({ stdout: "" });
        },
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    expect(steps.map((step: CredentialStep) => [...step.members])).toEqual([["password"]]);
    expect(steps.every((step) => isChangePassword(step.request))).toBe(true);
  });

  test("empty or unexpected usersInfo is a preflight failure and never plans createUser", async () => {
    for (const usersInfo of ["", "2", "present", "0\nmalformed extra output"]) {
      const calls: ClientRequest[] = [];
      const adapter = mongodb(
        makeContext({
          handle: (request) => {
            calls.push(request);
            if (isUserInfo(request)) {
              return result({ stdout: usersInfo.length === 0 ? "\n" : `${usersInfo}\n` });
            }
            if (isCreateUser(request) || isChangePassword(request)) {
              throw new Error("mutation must not run after malformed usersInfo");
            }
            return result({ stdout: "1\n" });
          },
        }),
      );
      const exit = await runExit(adapter.delta(admin));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls.some((call) => isCreateUser(call))).toBe(false);
      expect(calls.some((call) => isChangePassword(call))).toBe(false);
    }
  });

  test("fail-closed when password proof is unverified", async () => {
    const adapter = mongodb(
      makeContext({
        handle: catalogHandler({
          usersInfo: "1",
          appLogin: result({ exitCode: 2, stderr: "MongoNetworkError: connect ECONNREFUSED" }),
        }),
      }),
    );
    const exit = await runExit(adapter.delta(admin));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("keeps canary secrets off argv and constant eval text", async () => {
    const adapter = mongodb(
      makeContext({
        desired: { password: CANARY, user: "fresh" },
        handle: catalogHandler({ usersInfo: "0" }),
      }),
    );
    const steps = await runAdmin(adapter.delta(admin));
    for (const step of steps) {
      expect(JSON.stringify(step.request.argv)).not.toContain(CANARY);
      expect(evalOf(step.request)).not.toContain(CANARY);
      expect(step.request.env?.MONGO_TARGET_PASSWORD).toBe(CANARY);
    }
  });
});
