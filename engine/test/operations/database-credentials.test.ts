import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type DatabaseConnection,
  PortNumber,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk } from "@lando/sdk/services";
import { EnvironmentValueResolver, EventService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Deferred, Effect, Fiber, Layer, Logger, References, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import {
  publishDatabaseCredentialWarnings,
  publishDatabaseCredentialWarningsSafely,
  selectDatabaseCredentialWarnings,
} from "../../src/operations/database-credential-warnings.ts";
import {
  type DatabaseCredentialCheckInput,
  type DatabaseCredentialOutcome,
  changedCredentialMembers,
  checkDatabaseCredentials,
} from "../../src/operations/database-credentials.ts";
import { failReadiness } from "../../src/operations/service-readiness-error.ts";
import * as Resolver from "../../src/services/environment-value-resolver.ts";
import { EventPublicationObserver, layer as eventLayer } from "../../src/services/event-service.ts";
import * as Secrets from "../../src/services/secret-store.ts";
import { plan } from "./start-progress-topology-support.ts";

const mariadbConnection = (
  overrides: Partial<DatabaseConnection["creds"]> = {},
  family: DatabaseConnection["family"] = "mariadb",
): DatabaseConnection => ({
  family,
  port: PortNumber.make(3306),
  creds: {
    user: "lando",
    password: "original",
    database: "appdb",
    rootPassword: "rootpass",
    ...overrides,
  },
});

const service = (connection: DatabaseConnection | undefined): ServicePlan => ({
  name: ServiceName.make("db"),
  type: "mariadb",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: plan.metadata,
  ...(connection === undefined ? {} : { connection }),
});

const withDatabase = (database: ServicePlan): AppPlan => ({
  ...plan,
  services: { [database.name]: database },
});

type Terminal = { readonly exitCode: number };
type Chunk = ExecChunk | Terminal;
const encoder = new TextEncoder();
const stderr = (text: string): Chunk => ({ kind: "stderr", chunk: encoder.encode(text) });

const fakeProvider = (respond: (spec: CommandSpec) => ReadonlyArray<Chunk>) => {
  const calls: CommandSpec[] = [];
  return {
    calls,
    provider: {
      execStream: (_target: unknown, spec: CommandSpec) => {
        calls.push(spec);
        return Stream.fromIterable(respond(spec));
      },
    },
  };
};

const accepted = (): ReadonlyArray<Chunk> => [{ exitCode: 0 }];

const rejected = (family: "mysql" | "mariadb" | "postgres" | "mongodb" | "mssql") => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return [
        stderr("ERROR 1045 (28000): Access denied for user 'lando'@'127.0.0.1' (using password: YES)\n"),
        { exitCode: 1 },
      ];
    case "postgres":
      return [
        stderr(
          'psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "lando"\n',
        ),
        { exitCode: 2 },
      ];
    case "mongodb":
      return [stderr("MongoServerError: Authentication failed.\n"), { exitCode: 1 }];
    case "mssql":
      return [
        stderr("Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user 'sa'..\n"),
        { exitCode: 1 },
      ];
  }
};

const baseLayer = (secretEnv: Record<string, string> = {}) => {
  const redaction = Layer.succeed(RedactionService, makeRedactionService());
  const resolver = Resolver.layer.pipe(
    Layer.provideMerge(Layer.merge(redaction, Secrets.layerWith({ env: secretEnv }))),
  );
  return Layer.mergeAll(resolver, eventLayer.pipe(Layer.provide(redaction)));
};

const run = <A>(
  effect: Effect.Effect<A, never, EnvironmentValueResolver>,
  secretEnv: Record<string, string> = {},
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(baseLayer(secretEnv)))) as Promise<A>;

const check = (
  provider: DatabaseCredentialCheckInput["provider"],
  input: Partial<DatabaseCredentialCheckInput> = {},
): Effect.Effect<readonly DatabaseCredentialOutcome[], never, EnvironmentValueResolver> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      return yield* checkDatabaseCredentials({
        provider,
        plan: input.plan ?? plan,
        services: input.services ?? [{ name: "db", state: "ready" }],
        session,
        ...(input.previousPlan === undefined ? {} : { previousPlan: input.previousPlan }),
        ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
      });
    }),
  );

test("performs no exec when no service publishes a connection", async () => {
  // Given
  const fake = fakeProvider(accepted);
  // When
  const outcomes = await run(check(fake.provider, { plan: withDatabase(service(undefined)) }));
  // Then
  expect(outcomes).toEqual([]);
  expect(fake.calls).toEqual([]);
});

test("skips a database service that did not start", async () => {
  const fake = fakeProvider(accepted);
  const outcomes = await run(
    check(fake.provider, {
      plan: withDatabase(service(mariadbConnection())),
      services: [{ name: "db", state: "stopped" }],
    }),
  );
  expect(outcomes).toEqual([]);
  expect(fake.calls).toEqual([]);
});

test("accepts the configured credentials without a warning", async () => {
  // Given
  const fake = fakeProvider(accepted);
  // When
  const outcomes = await run(check(fake.provider, { plan: withDatabase(service(mariadbConnection())) }));
  // Then
  expect(outcomes.filter((outcome) => outcome.login === "app")).toMatchObject([{ state: "accepted" }]);
  expect(selectDatabaseCredentialWarnings(outcomes)).toEqual([]);
});

test("runs exactly one check per login for a MariaDB service", async () => {
  const fake = fakeProvider(accepted);
  await run(check(fake.provider, { plan: withDatabase(service(mariadbConnection())) }));
  expect(fake.calls.map((call) => call.command.slice(0, 1))).toEqual([["mariadb"], ["mariadb"]]);
  expect(fake.calls[1]?.command).toContain("root");
  expect(fake.calls[1]?.env?.MYSQL_PWD).toBe("rootpass");
});

test("warns for a rejected app login and names changed descriptors without values", async () => {
  // Given: the running app was applied with a different password.
  const fake = fakeProvider((spec) =>
    spec.env?.MYSQL_PWD === "rootpass" ? accepted() : rejected("mariadb"),
  );
  const current = service(mariadbConnection({ password: "sw0rdfish" }));
  // When
  const outcomes = await run(
    check(fake.provider, {
      plan: withDatabase(current),
      previousPlan: withDatabase(service(mariadbConnection({ password: "original" }))),
    }),
  );
  const warnings = selectDatabaseCredentialWarnings(outcomes);
  // Then
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    code: "LANDO_DATABASE_CREDENTIALS_REJECTED",
    context: { service: "db", family: "mariadb", login: "app", changedMembers: "password" },
  });
  const serialized = JSON.stringify(warnings);
  expect(serialized).not.toContain("sw0rdfish");
  expect(serialized).not.toContain("original");
  expect(serialized).not.toContain("rootpass");
  expect(serialized).toContain("docs.lando.dev/guides/services/mariadb");
});

test("warns for a rejected administrator login when the app login still works", async () => {
  const fake = fakeProvider((spec) =>
    spec.env?.MYSQL_PWD === "new-root" ? rejected("mariadb") : accepted(),
  );
  const outcomes = await run(
    check(fake.provider, {
      plan: withDatabase(service(mariadbConnection({ rootPassword: "new-root" }))),
      previousPlan: withDatabase(service(mariadbConnection())),
    }),
  );
  const warnings = selectDatabaseCredentialWarnings(outcomes);
  expect(warnings).toMatchObject([
    {
      code: "LANDO_DATABASE_CREDENTIALS_REJECTED",
      context: { login: "root", changedMembers: "rootPassword" },
    },
  ]);
});

test("reports a missing database with its own warning", async () => {
  const fake = fakeProvider(() => [
    stderr("ERROR 1044 (42000): Access denied for user 'lando'@'%' to database 'missingdb'\n"),
    { exitCode: 1 },
  ]);
  const outcomes = await run(check(fake.provider, { plan: withDatabase(service(mariadbConnection())) }));
  expect(selectDatabaseCredentialWarnings(outcomes)).toMatchObject([
    { code: "LANDO_DATABASE_MISSING", context: { service: "db", login: "app" } },
  ]);
});

test("keeps a missing client unverified and silent", async () => {
  const fake = fakeProvider(() => [
    stderr(
      "Error: crun: executable file `mariadb` not found in $PATH: No such file or directory: OCI runtime attempted to invoke a command that was not found\n",
    ),
    { exitCode: 127 },
  ]);
  const outcomes = await run(check(fake.provider, { plan: withDatabase(service(mariadbConnection())) }));
  expect(outcomes.every((outcome) => outcome.state === "unverified")).toBe(true);
  expect(selectDatabaseCredentialWarnings(outcomes)).toEqual([]);
});

test("sends the resolved secret the session holds, not the descriptor", async () => {
  const fake = fakeProvider(accepted);
  const connection = mariadbConnection({
    password: { _tag: "SecretRef", reference: "DATABASE" },
    rootPassword: { _tag: "SecretRef", reference: "ROOT" },
  });
  await run(check(fake.provider, { plan: withDatabase(service(connection)) }), {
    LANDO_SECRET_DATABASE: "resolved-app",
    LANDO_SECRET_ROOT: "resolved-root",
  });
  expect(fake.calls[0]?.env?.MYSQL_PWD).toBe("resolved-app");
  expect(fake.calls[1]?.env?.MYSQL_PWD).toBe("resolved-root");
});

test("registers the resolved credential for redaction before running the client", async () => {
  // Given
  const redaction = makeRedactionService();
  const fake = fakeProvider(accepted);
  const connection = mariadbConnection({ password: { _tag: "SecretRef", reference: "DATABASE" } });
  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      yield* checkDatabaseCredentials({
        provider: fake.provider,
        plan: withDatabase(service(connection)),
        services: [{ name: "db", state: "ready" }],
        session,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(RedactionService, redaction),
          Resolver.layer.pipe(
            Layer.provideMerge(
              Layer.merge(
                Layer.succeed(RedactionService, redaction),
                Secrets.layerWith({ env: { LANDO_SECRET_DATABASE: "resolved-app" } }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  // Then
  const values = await Effect.runPromise(redaction.payloadValues());
  expect(values().substring).toContain("resolved-app");
});

test("records one machine warning and prints it once in human output", async () => {
  for (const machineOutput of [true, false]) {
    // Given
    const warnings = makeCommandWarnings(machineOutput);
    const fake = fakeProvider((spec) =>
      spec.env?.MYSQL_PWD === "rootpass" ? accepted() : rejected("mariadb"),
    );
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* (yield* EnvironmentValueResolver).openSession();
        yield* publishDatabaseCredentialWarnings({
          provider: fake.provider,
          plan: withDatabase(service(mariadbConnection())),
          services: [{ name: "db", state: "ready" }],
          session,
        });
        const events = yield* EventService;
        return { warnings: yield* warnings.list, human: yield* events.query("message.warn") };
      }).pipe(
        Effect.scoped,
        Effect.provideService(CommandWarnings, warnings),
        Effect.provideService(EventPublicationObserver, (event) => {
          if (!machineOutput || !Schema.is(MessageWarnEvent)(event)) return Effect.void;
          return warnings.add({ code: "LANDO_MESSAGE_WARN", message: event.body });
        }),
        Effect.provide(baseLayer()),
      ),
    );
    // Then
    expect(
      result.warnings.filter((warning) => warning.code === "LANDO_DATABASE_CREDENTIALS_REJECTED"),
    ).toHaveLength(1);
    expect(result.human).toHaveLength(machineOutput ? 0 : 1);
  }
});

test("a hanging client expires its budget as unverified, never rejected", async () => {
  // Given: a stream that never completes.
  const hanging = { execStream: () => Stream.never };
  // When
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        check(hanging, {
          plan: withDatabase(service(mariadbConnection())),
          budgetMs: 10_000,
        }),
      );
      yield* TestClock.adjust("11 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(baseLayer()), Effect.provide(TestClock.layer())),
  );
  // Then: the per-check timeout expires as unverified and never becomes a credential claim.
  expect(outcomes.every((outcome) => outcome.state === "unverified")).toBe(true);
  expect(selectDatabaseCredentialWarnings(outcomes)).toEqual([]);
});

test("compares credential descriptors only", () => {
  const before = service(mariadbConnection({ password: "original" }));
  const after = service(mariadbConnection({ password: { _tag: "SecretRef", reference: "DATABASE" } }));
  expect(changedCredentialMembers(before, after)).toEqual(["password"]);
  expect(changedCredentialMembers(undefined, after)).toEqual([]);
  expect(
    changedCredentialMembers(
      service(mariadbConnection({ user: "old", database: "olddb" })),
      service(mariadbConnection({ user: "new", database: "newdb" })),
    ),
  ).toEqual(["user", "database"]);
});

test.each([
  { family: "postgres" as const, password: "failed" },
  { family: "mssql" as const, password: "Login" },
])(
  "still classifies a $family rejection whose password is a word in the client message",
  async ({ family, password }) => {
    // Given: the configured password is also a word inside the client's own rejection text.
    const fake = fakeProvider(() => rejected(family));
    const connection = mariadbConnection({ password }, family);
    // When
    const outcomes = await run(check(fake.provider, { plan: withDatabase(service(connection)) }));
    const app = outcomes.find((outcome) => outcome.login === "app");
    // Then: redaction rewrote the evidence, not the verdict.
    expect(app).toMatchObject({ state: "rejected" });
    expect(app?.detail ?? "").not.toContain(password);
    expect(selectDatabaseCredentialWarnings(outcomes)).toMatchObject([
      { code: "LANDO_DATABASE_CREDENTIALS_REJECTED", context: { family, login: "app" } },
    ]);
  },
);

test("logs a failed warning publish at warning level without failing the operation", async () => {
  // Given: the warning sink itself is broken.
  const logs: Array<{ readonly level: string; readonly message: string }> = [];
  const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
    logs.push({ level: String(logLevel), message: String(message) });
  });
  const fake = fakeProvider(() => rejected("mariadb"));
  const brokenWarnings = {
    ...makeCommandWarnings(false),
    add: () => Effect.die("warning sink unavailable"),
  };
  // When
  const completed = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* (yield* EnvironmentValueResolver).openSession();
      yield* publishDatabaseCredentialWarningsSafely({
        provider: fake.provider,
        plan: withDatabase(service(mariadbConnection())),
        services: [{ name: "db", state: "ready" }],
        session,
      });
      return "completed";
    }).pipe(
      Effect.scoped,
      Effect.provideService(CommandWarnings, brokenWarnings),
      Effect.provide(baseLayer()),
      Effect.provideService(References.CurrentLoggers, new Set([logger])),
    ),
  );
  // Then: the start is unaffected and the swallow left a warning-level record.
  expect(completed).toBe("completed");
  expect(logs.map((entry) => entry.level.toLowerCase())).toContain("warn");
  expect(logs.map((entry) => entry.message).join("\n")).toContain(
    "Database credential warnings could not be published",
  );
});

test("a SQL Server readiness failure tail gains credential remediation without replacing its reason", async () => {
  // Given: SQL Server's startup launcher exits after repeated 18456 logins.
  const provider = {
    ...TestRuntimeProvider,
    logs: () =>
      Stream.fromIterable([
        {
          service: ServiceName.make("db"),
          stream: "stderr" as const,
          line: "2026-11-15 12:14:27.98 Logon       Error: 18456, Severity: 14, State: 8.",
        },
        {
          service: ServiceName.make("db"),
          stream: "stderr" as const,
          line: "2026-11-15 12:14:27.98 Logon       Login failed for user 'sa'. Reason: Password did not match that for the login provided. [CLIENT: 127.0.0.1]",
        },
      ]),
  };
  const database = service({
    ...mariadbConnection({}, "mssql"),
    creds: { user: "sa", password: "app", database: "appdb", rootPassword: "secret" },
  });
  // When
  const error = await Effect.runPromise(
    Effect.flip(
      failReadiness(
        { provider, plan: withDatabase(database), service: database.name },
        {
          reason: "not-running",
          runtime: {
            app: plan.id,
            service: database.name,
            providerId: ProviderId.make("lando"),
            status: "exited",
            exitCode: 1,
            publications: { status: "missing" },
          },
        },
      ),
    ),
  );
  // Then
  expect(error).toMatchObject({ _tag: "ServiceNotReadyError", reason: "not-running" });
  expect(error.remediation).toContain("Restore the previous creds values");
  expect(error.remediation).toContain("guides/services/mssql");
});

test("classifies the raw log tail before redaction removes a password-shaped signal", async () => {
  // Given: the configured SQL Server password is a word in the rejection text, so redaction
  // rewrites `Login failed for user` and would erase the signal classification needs.
  const redaction = makeRedactionService();
  await Effect.runPromise(redaction.registerValues(["Login"]));
  const provider = {
    ...TestRuntimeProvider,
    logs: () =>
      Stream.fromIterable([
        {
          service: ServiceName.make("db"),
          stream: "stderr" as const,
          line: "Login failed for user 'sa'. Reason: Password did not match that for the login provided.",
        },
      ]),
  };
  const database = service({
    ...mariadbConnection({}, "mssql"),
    creds: { user: "sa", password: "Login", database: "appdb" },
  });
  // When
  const error = await Effect.runPromise(
    Effect.flip(
      failReadiness(
        { provider, plan: withDatabase(database), service: database.name },
        {
          reason: "not-running",
          runtime: {
            app: plan.id,
            service: database.name,
            providerId: ProviderId.make("lando"),
            status: "exited",
            exitCode: 1,
            publications: { status: "missing" },
          },
        },
      ),
    ).pipe(Effect.provideService(RedactionService, redaction)),
  );
  // Then: the verdict comes from the raw bytes, while only the redacted tail is retained.
  expect(error.remediation).toContain("Restore the previous creds values");
  expect(error.remediation).toContain("guides/services/mssql");
  expect(error.logTail?.lines.join("\n")).not.toContain("Login");
});

test("an unobserved exit code adds no credential remediation to a readiness failure", async () => {
  // Given: the same login rejection, but the runtime never reported an exit status.
  const provider = {
    ...TestRuntimeProvider,
    logs: () =>
      Stream.fromIterable([
        {
          service: ServiceName.make("db"),
          stream: "stderr" as const,
          line: "2026-11-15 12:14:27.98 Logon       Login failed for user 'sa'. Reason: Password did not match that for the login provided. [CLIENT: 127.0.0.1]",
        },
      ]),
  };
  const database = service({
    ...mariadbConnection({}, "mssql"),
    creds: { user: "sa", password: "app", database: "appdb", rootPassword: "secret" },
  });
  // When
  const error = await Effect.runPromise(
    Effect.flip(
      failReadiness(
        { provider, plan: withDatabase(database), service: database.name },
        {
          reason: "not-running",
          runtime: {
            app: plan.id,
            service: database.name,
            providerId: ProviderId.make("lando"),
            status: "exited",
            publications: { status: "missing" },
          },
        },
      ),
    ),
  );
  // Then: without an exit status the tail is not classified as a credential rejection.
  expect(error.remediation).not.toContain("Restore the previous creds values");
  expect(error.remediation).toContain("lando logs");
});

test("checks distinct services concurrently", async () => {
  // Given: the first service cannot complete until the second has started.
  const gate = Effect.runSync(Deferred.make<void>());
  let calls = 0;
  const provider = {
    execStream: (_target: unknown, _spec: CommandSpec) => {
      calls++;
      const wait =
        calls === 1
          ? Stream.drain(Stream.fromEffect(Deferred.await(gate)))
          : Stream.drain(Stream.fromEffect(Deferred.succeed(gate, undefined)));
      return Stream.concat(wait, Stream.make({ exitCode: 0 }));
    },
  };
  const connection: DatabaseConnection = {
    family: "postgres",
    port: PortNumber.make(5432),
    creds: { user: "lando", password: "original", database: "appdb" },
  };
  const first: ServicePlan = { ...service(connection), name: ServiceName.make("first") };
  const second: ServicePlan = { ...service(connection), name: ServiceName.make("second") };
  const plan = { ...withDatabase(first), services: { first, second } };
  // When
  const outcomes = await run(
    check(provider, {
      plan,
      services: [
        { name: "first", state: "ready" },
        { name: "second", state: "ready" },
      ],
    }),
  );
  // Then: both ran; a serial loop would never release the gate.
  expect(outcomes.map((outcome) => outcome.service).sort()).toEqual(["first", "second"]);
  expect(calls).toBe(2);
});

test("an app-wide budget marks every unfinished login unverified, never rejected", async () => {
  // Given: a client that never finishes and a budget below the per-check timeout.
  const provider = { execStream: () => Stream.never };
  // When
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        check(provider, {
          plan: withDatabase(service(mariadbConnection())),
          budgetMs: 100,
        }),
      );
      yield* TestClock.adjust("200 millis");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(baseLayer()), Effect.provide(TestClock.layer())),
  );
  // Then: the expiry is stated per login instead of discarding the whole observation.
  expect(outcomes.map((outcome) => [outcome.login, outcome.state])).toEqual([
    ["app", "unverified"],
    ["root", "unverified"],
  ]);
  expect(outcomes[0]?.detail).toContain("budget expired");
  expect(selectDatabaseCredentialWarnings(outcomes)).toEqual([]);
});

test("an expiring app-wide budget keeps a rejection another login already proved", async () => {
  // Given: the app login is rejected at once while the administrator login hangs.
  const provider = {
    execStream: (_target: unknown, spec: CommandSpec) =>
      spec.env?.MYSQL_PWD === "rootpass" ? Stream.never : Stream.fromIterable(rejected("mariadb")),
  };
  // When
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        check(provider, {
          plan: withDatabase(service(mariadbConnection())),
          budgetMs: 100,
        }),
      );
      yield* TestClock.adjust("200 millis");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(baseLayer()), Effect.provide(TestClock.layer())),
  );
  // Then: the proven rejection survives, and only the unfinished login is unverified.
  expect(outcomes.find((outcome) => outcome.login === "app")).toMatchObject({ state: "rejected" });
  expect(outcomes.find((outcome) => outcome.login === "root")).toMatchObject({
    state: "unverified",
    detail: expect.stringContaining("budget expired"),
  });
  expect(selectDatabaseCredentialWarnings(outcomes)).toMatchObject([
    { code: "LANDO_DATABASE_CREDENTIALS_REJECTED", context: { login: "app" } },
  ]);
});
