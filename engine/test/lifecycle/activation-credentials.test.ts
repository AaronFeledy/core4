import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { databaseAdminSeedPath, makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ProviderInternalError } from "@lando/sdk/errors";
import { type AppPlan, PortNumber, PortablePath, type ServicePlan } from "@lando/sdk/schema";
import { PathsService, type RuntimeProviderShape, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Stream } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { convergeActivationCredentials } from "../../src/lifecycle/activation-credentials.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

const activation = (
  family: "postgres" | "mssql" | "mongodb",
  options: {
    readonly userDataRoot?: string;
    readonly privateFileAccess?: boolean;
    readonly authorOwned?: boolean;
    readonly database?: string;
    readonly password?: string;
    readonly redaction?: ReturnType<typeof makeRedactionService>;
  } = {},
) => {
  const store = `${family}-data`;
  const catalog = {
    postgres: { image: "postgres:16", mount: "/var/lib/postgresql/data", port: 5432, user: "app_user" },
    mssql: {
      image: "mcr.microsoft.com/mssql/server:2022-latest",
      mount: "/var/opt/mssql",
      port: 1433,
      user: "sa",
    },
    mongodb: { image: "mongo:7", mount: "/data/db", port: 27017, user: "app_user" },
  }[family];
  const { command: _command, sqlite: _sqlite, nonSqlCreds: _nonSqlCreds, ...base } = web;
  const db: ServicePlan = {
    ...base,
    extensions: options.authorOwned
      ? {}
      : {
          "@lando/core/catalog-database": catalog.image,
        },
    type: family,
    serviceTypeId: family,
    artifact: {
      kind: "ref",
      ref: catalog.image,
    },
    mounts: [
      {
        type: "volume",
        store,
        target: PortablePath.make(catalog.mount),
        readOnly: false,
      },
    ],
    endpoints: [],
    connection: {
      family,
      port: PortNumber.make(catalog.port),
      creds: {
        user: catalog.user,
        password: options.password ?? "FixturePassword1!",
        database: options.database ?? "appdb",
      },
    },
  };
  const target: AppPlan = {
    ...plan,
    stores: [{ name: store, kind: "data", scope: "service" }],
    services: { [db.name]: db },
  };
  const calls = { inspect: 0, volume: 0, exec: 0 };
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    capabilities: { ...TestRuntimeProvider.capabilities, serviceExec: true },
    inspect: () =>
      Effect.sync(() => {
        calls.inspect++;
        return {
          app: target.id,
          appRoot: target.root,
          providerId: target.provider,
          service: db.name,
          containerId: "native-db",
          status: "running" as const,
          publications: { status: "unknown" as const },
        };
      }),
    observeVolume: () =>
      Effect.sync(() => {
        calls.volume++;
        return {
          ref: { app: target.id, store },
          identity: {
            nativeName: store,
            ownerRoot: target.root,
            generation: "fixture-generation",
            coordinationKey: "fixture-volume-key",
            origin: "created" as const,
          },
        };
      }),
    execStream: () => {
      calls.exec++;
      return Stream.make(
        { kind: "stdout" as const, chunk: new TextEncoder().encode("lando-matched\n") },
        { exitCode: 0 },
      );
    },
  };
  const warnings = makeCommandWarnings(true);
  const paths =
    options.userDataRoot === undefined
      ? makeLandoPaths()
      : makeLandoPaths({
          env: {},
          sources: { user: false, env: false },
          userDataRoot: options.userDataRoot,
          userCacheRoot: join(options.userDataRoot, "cache"),
          userConfRoot: join(options.userDataRoot, "conf"),
          systemPluginRoot: join(options.userDataRoot, "plugins"),
        });
  const run = (
    action: "kept" | "started" | "created" | "replaced",
    execStream = provider.execStream,
    fresh = false,
    previousPassword?: string,
  ) =>
    Effect.runPromise(
      convergeActivationCredentials({
        plan: target,
        previousPlan:
          previousPassword === undefined || db.connection === undefined
            ? target
            : {
                ...target,
                services: {
                  [db.name]: {
                    ...db,
                    connection: {
                      ...db.connection,
                      creds: { ...db.connection.creds, password: previousPassword },
                    },
                  },
                },
              },
        provider: { ...provider, execStream },
        applied: {
          changed: action !== "kept",
          services: { [db.name]: { action } },
          ...(fresh
            ? {
                createdVolumes: [
                  { nativeName: store, ownerRoot: target.root, generation: "fixture-generation" },
                ],
              }
            : {}),
        },
        session: {
          resolveEnvironment: (env) =>
            Effect.succeed(
              Object.fromEntries(
                Object.entries(env).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              ),
            ),
        },
      }).pipe(
        Effect.provideService(PathsService, paths),
        Effect.provideService(RedactionService, options.redaction ?? makeRedactionService()),
        Effect.provideService(StateStore, makeTestStateStore().service),
        Effect.provideService(CommandWarnings, warnings),
        (effect) =>
          options.privateFileAccess ? Effect.provide(effect, PrivateFileAccessService.layer) : effect,
      ),
    );
  return { run, calls, warnings };
};

test.each([
  { action: "kept", expected: { inspect: 0, volume: 0, exec: 0 } },
  { action: "started", expected: { inspect: 1, volume: 1, exec: 1 } },
] as const)(
  "performs only the necessary credential I/O for a $action database",
  async ({ action, expected }) => {
    const { run, calls } = activation("postgres");
    expect(await run(action)).toEqual([]);
    expect(calls).toEqual(expected);
  },
);

test.each([
  {
    action: "started",
    stderr: 'FATAL: password authentication failed for user "app_user"',
    warning: "LANDO_DATABASE_CREDENTIALS_REJECTED",
  },
  { action: "replaced", stderr: 'FATAL: database "appdb" does not exist', warning: "LANDO_DATABASE_MISSING" },
  {
    action: "kept",
    previousPassword: "old-password",
    stderr: 'FATAL: password authentication failed for user "app_user"',
    warning: "LANDO_DATABASE_CREDENTIALS_REJECTED",
  },
  { action: "kept", stderr: "", warning: undefined },
] as const)("observes an unmanaged $action database only in activation scope ($warning)", async (fixture) => {
  const { run, calls, warnings } = activation("postgres", { authorOwned: true });
  const commands: string[] = [];
  expect(
    await run(
      fixture.action,
      (_target, options) => {
        commands.push(options.command.join(" "));
        return Stream.make(
          { kind: "stderr", chunk: new TextEncoder().encode(fixture.stderr) },
          { exitCode: 2 },
        );
      },
      false,
      "previousPassword" in fixture ? fixture.previousPassword : undefined,
    ),
  ).toEqual([]);
  expect(calls).toEqual({ inspect: 0, volume: 0, exec: 0 });
  expect(commands.map((command) => command.includes("SELECT 1"))).toEqual(
    fixture.warning === undefined ? [] : [true],
  );
  expect((await Effect.runPromise(warnings.list)).map(({ code }) => code)).toEqual(
    fixture.warning === undefined ? [] : [fixture.warning],
  );
});

test("waits for the final PostgreSQL listener before inspecting the administrator", async () => {
  const { run, warnings } = activation("postgres");
  let listenerChecks = 0;
  let prematureAdminChecks = 0;
  const reply = (stdout: string, exitCode = 0) =>
    Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(stdout) }, { exitCode });
  const changes = await run(
    "created",
    (_target, options) => {
      if (options.command.some((arg) => arg.includes("pg_isready"))) {
        listenerChecks++;
        return reply("", 2);
      }
      if (options.command.some((arg) => arg.includes("lando-matched")))
        return listenerChecks === 0 ? reply("", 2) : reply("lando-matched\n");
      if (options.command[0] === "psql") {
        prematureAdminChecks++;
        return Stream.make(
          {
            kind: "stderr",
            chunk: new TextEncoder().encode(
              'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n',
            ),
          },
          { exitCode: 2 },
        );
      }
      return reply("10.89.0.2\n");
    },
    true,
  );
  expect(prematureAdminChecks).toBe(0);
  expect(listenerChecks).toBe(1);
  expect(changes).toEqual([]);
  expect(await Effect.runPromise(warnings.list)).toEqual([]);
});

test("waits for the final MongoDB listener before inspecting the root catalog", async () => {
  const { run, warnings } = activation("mongodb");
  let listenerChecks = 0;
  let prematureCatalogReads = 0;
  const reply = (stdout: string, exitCode = 0) =>
    Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(stdout) }, { exitCode });
  await run(
    "created",
    (_target, options) => {
      if (options.command.some((arg) => arg.includes("container_address"))) {
        return ++listenerChecks === 1 ? reply("", 1) : reply("");
      }
      if (listenerChecks < 2) prematureCatalogReads++;
      const script = options.env?.LANDO_MONGO_EVAL ?? "";
      return reply(script.includes("ping:1") ? "{ ok: 1 }\n" : "1\n");
    },
    true,
  );

  expect(prematureCatalogReads).toBe(0);
  expect(listenerChecks).toBe(2);
  expect((await Effect.runPromise(warnings.list)).map(({ code }) => code)).toEqual([
    "LANDO_DATABASE_ADMIN_SEED_UNAVAILABLE",
  ]);
});

const execUnavailable = new ProviderInternalError({
  providerId: plan.provider,
  operation: "exec",
  message: "Temporary exec transport failure",
  remediation: "Retry after startup.",
});

const mssqlExec =
  (state: {
    databaseExists: boolean;
    managed?: { ready: boolean; catalogReads: number };
    loseWriteResponse?: boolean;
  }): RuntimeProviderShape["execStream"] =>
  (_target, options) =>
    Stream.unwrap(
      Effect.promise(async () => {
        const input = new TextDecoder().decode(
          await Bun.readableStreamToArrayBuffer(
            new ReadableStream({
              async start(controller) {
                for await (const chunk of options.stdinStream ?? []) controller.enqueue(chunk);
                controller.close();
              },
            }),
          ),
        );
        const sa = options.command.includes("sa") && options.env?.SQLCMDPASSWORD === "FixturePassword1!";
        const managedProof = options.command.includes("lando_admin") && input.includes("IS_SRVROLEMEMBER");
        const managedWorks = managedProof && state.managed?.ready === true;
        if (state.managed && sa && input.includes("IS_SRVROLEMEMBER")) state.managed.ready = true;
        if (state.managed && input.includes("sys.server_principals") && input.includes("COUNT(*)")) {
          state.managed.catalogReads++;
          return Stream.make(
            { kind: "stdout" as const, chunk: new TextEncoder().encode("1\n") },
            { exitCode: 0 },
          );
        }
        const admin = sa || (options.command.includes("lando_admin") && state.managed?.ready === true);
        if (sa && input.includes("CREATE DATABASE [appdb]")) {
          state.databaseExists = true;
          if (state.loseWriteResponse) return Stream.fail(execUnavailable);
        }
        const stdout = managedProof
          ? managedWorks
            ? "1\n"
            : ""
          : !admin
            ? ""
            : input.includes("IS_SRVROLEMEMBER")
              ? "1\n0\n"
              : input.includes("state_desc")
                ? state.databaseExists
                  ? "appdb\tONLINE\n"
                  : ""
                : input.includes("ORIGINAL_LOGIN()")
                  ? "sa\n"
                  : "";
        return Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode(stdout) },
          { exitCode: (managedProof ? managedWorks : admin) ? 0 : 1 },
        );
      }),
    );

test("converges after a transient preflight exec failure", async () => {
  const { run, warnings } = activation("mssql");
  const state = { databaseExists: false };
  const exec = mssqlExec(state);
  let available = false;
  const changes = await run("created", (target, options) => {
    if (available) return exec(target, options);
    available = true;
    return Stream.fail(execUnavailable);
  });

  expect(state.databaseExists).toBe(true);
  expect(changes).toEqual([{ service: "web", family: "mssql", changedMembers: ["database"] }]);
  expect((await Effect.runPromise(warnings.list)).map(({ code }) => code)).not.toContain(
    "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
  );
});

test("does not retry a refusal to target a reserved SQL Server database", async () => {
  const { run, calls, warnings } = activation("mssql", { database: "master" });
  const state = { databaseExists: false };
  expect(await run("created", mssqlExec(state))).toEqual([]);

  expect(calls.inspect).toBe(1);
  expect(state.databaseExists).toBe(false);
  expect((await Effect.runPromise(warnings.list)).map(({ code }) => code)).toContain(
    "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
  );
});

test("does not retry when the provider loses the response to a database write", async () => {
  const { run, calls, warnings } = activation("mssql");
  const state = { databaseExists: false, loseWriteResponse: true };
  expect(await run("created", mssqlExec(state))).toEqual([]);

  expect(state.databaseExists).toBe(true);
  expect(calls.inspect).toBe(3);
  expect((await Effect.runPromise(warnings.list)).map(({ code }) => code)).toContain(
    "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
  );
});

test("rechecks the retained SQL Server managed login once sa has authenticated", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-activation-mssql-"));
  try {
    const { run, warnings } = activation("mssql", { userDataRoot: root, privateFileAccess: true });
    const managed = { ready: false, catalogReads: 0 };
    await run("started", mssqlExec({ databaseExists: true, managed }));

    expect(await Effect.runPromise(warnings.list)).toEqual([]);
    expect(managed.catalogReads).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports the SQL Server database created with sa on existing storage", async () => {
  const { run, warnings } = activation("mssql");
  const state = { databaseExists: false };
  const changes = await run("created", mssqlExec(state));

  expect(state.databaseExists).toBe(true);
  expect(changes).toEqual([{ service: "web", family: "mssql", changedMembers: ["database"] }]);
  const notices = await Effect.runPromise(warnings.list);
  expect(notices.map(({ code }) => code)).toEqual([
    "LANDO_DATABASE_ADMIN_SEED_UNAVAILABLE",
    "LANDO_DATABASE_CREATED_ON_EXISTING_STORAGE",
  ]);
});

test("does not report SQL Server database creation on positively identified fresh storage", async () => {
  const { run, warnings } = activation("mssql");
  const state = { databaseExists: false };
  const changes = await run("created", mssqlExec(state), true);

  expect(state.databaseExists).toBe(true);
  expect(changes).toEqual([]);
  const notices = await Effect.runPromise(warnings.list);
  expect(notices.map(({ code }) => code)).toEqual(["LANDO_DATABASE_ADMIN_SEED_UNAVAILABLE"]);
});

test.skipIf(process.platform === "win32")(
  "converges with the desired administrator when the seed cannot be read",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-activation-seed-"));
    try {
      const seed = databaseAdminSeedPath(root);
      await mkdir(dirname(seed), { recursive: true, mode: 0o700 });
      await writeFile(seed, "not a seed\n", { mode: 0o600 });
      const { run, warnings } = activation("mssql", {
        userDataRoot: root,
        privateFileAccess: true,
      });
      const state = { databaseExists: false };
      const changes = await run("created", mssqlExec(state));

      expect(state.databaseExists).toBe(true);
      expect(changes).toEqual([{ service: "web", family: "mssql", changedMembers: ["database"] }]);
      const notices = await Effect.runPromise(warnings.list);
      expect(notices.map(({ code }) => code)).toEqual([
        "LANDO_DATABASE_ADMIN_SEED_UNAVAILABLE",
        "LANDO_DATABASE_CREATED_ON_EXISTING_STORAGE",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("keeps public default passwords out of substring redaction", async () => {
  // The catalog default password is published, so registering it as a substring would mask
  // every later "lando" in the command's output, such as "lando_admin" or "lando start".
  const redaction = makeRedactionService();
  const { run } = activation("postgres", { password: "lando", redaction });
  await run("started");
  const secrets = await Effect.runPromise(redaction.forProfile("secrets"));
  expect(secrets.redactString("Run lando start for lando_admin.")).toBe("Run lando start for lando_admin.");
});
