import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { databaseAdminSeedPath, makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { FailureRoleAnnotation, mergeFailure } from "@lando/sdk/command-result";
import { ProviderInternalError, StateStoreError } from "@lando/sdk/errors";
import { type AppPlan, PortNumber, PortablePath, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import {
  type CommandSpec,
  EnvironmentValueResolver,
  PathsService,
  type RuntimeProviderShape,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { applyActivation } from "../../src/lifecycle/activation-apply.ts";
import { makeActivationCredentialWorker } from "../../src/lifecycle/activation-credentials.ts";
import { HostMountPoints } from "../../src/lifecycle/host-mount-points.ts";
import { prepareServiceCertificates } from "../../src/lifecycle/service-certificates.ts";
import { withPlanVolumeCoordination } from "../../src/lifecycle/volume-coordination.ts";
import { prepareProvider } from "../../src/providers/prepared.ts";
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
    readonly built?: boolean;
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
      ref: options.built ? "local/custom-database:fixture" : catalog.image,
      ...(options.built ? { origin: "build" as const } : {}),
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
  const physical = {
    nativeName: store,
    ownerRoot: target.root,
    generation: "fixture-generation",
    coordinationKey: "fixture-volume-key",
    origin: "created" as const,
  };
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
    observeBoundVolume: () =>
      Effect.sync(() => {
        calls.volume++;
        return {
          ref: { app: target.id, store },
          identity: physical,
        };
      }),
    observeVolume: () => Effect.die("Unbound volume observation is not a credential capability"),
    locateVolume: () =>
      Effect.succeed({
        nativeName: store,
        coordinationKey: physical.coordinationKey,
        identity: physical,
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
  const stateStore = makeTestStateStore().service;
  const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>, suppliedStore = stateStore) =>
    effect.pipe(
      Effect.provideService(PathsService, paths),
      Effect.provideService(RedactionService, options.redaction ?? makeRedactionService()),
      Effect.provideService(StateStore, suppliedStore),
      Effect.provideService(CommandWarnings, warnings),
      (effect) =>
        options.privateFileAccess ? Effect.provide(effect, PrivateFileAccessService.layer) : effect,
    );
  const makeWorker = (
    previousPlan: AppPlan | undefined,
    execStream = provider.execStream,
    desiredPlan?: AppPlan,
  ) =>
    makeActivationCredentialWorker({
      plan: target,
      previousPlan,
      desiredPlan,
      provider: { ...provider, execStream },
      session: {
        resolveEnvironment: (env) =>
          Effect.succeed(
            Object.fromEntries(
              Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
          ),
      },
    });
  const run = (
    action: "kept" | "started" | "created" | "replaced",
    execStream = provider.execStream,
    fresh = false,
    previousPassword?: string | null,
  ) => {
    const previousPlan =
      previousPassword === null
        ? undefined
        : previousPassword === undefined || db.connection === undefined
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
            };
    return Effect.runPromise(
      withServices(
        makeWorker(previousPlan, execStream).pipe(
          Effect.flatMap(
            (worker) =>
              worker?.finish({
                changed: action !== "kept",
                services: { [db.name]: { action } },
                ...(fresh
                  ? {
                      createdVolumes: [
                        { nativeName: store, ownerRoot: target.root, generation: "fixture-generation" },
                      ],
                    }
                  : {}),
              }) ?? Effect.succeed([]),
          ),
        ),
      ),
    );
  };
  const gated = (
    options: {
      readonly containerId?: string;
      readonly coordinationKey?: string;
      readonly desiredPlan?: AppPlan;
      readonly previousPlan?: AppPlan;
      readonly store?: StateStoreShape;
      readonly execStream?: RuntimeProviderShape["execStream"];
    } = {},
  ) =>
    withServices(
      Effect.gen(function* () {
        const worker = yield* makeWorker(options.previousPlan, options.execStream, options.desiredPlan);
        if (worker === undefined) throw new TypeError("Expected the activation credential worker");
        const attempts = yield* withPlanVolumeCoordination({
          plan: target,
          provider:
            options.coordinationKey === undefined
              ? provider
              : {
                  ...provider,
                  locateVolume: () =>
                    Effect.succeed({ nativeName: store, coordinationKey: options.coordinationKey ?? "" }),
                },
          stateStore,
          body: () =>
            Effect.forEach(["client-one", "client-two"], (name) =>
              worker.continueHealthyDependency({
                consumer: ServiceName.make(name),
                dependency: db.name,
                containerId: options.containerId ?? "native-db",
                createdVolumes: [],
              }),
            ),
        });
        const changes = yield* worker.finish({
          changed: false,
          services: { [db.name]: { action: "kept" } },
        });
        return { attempts, changes };
      }),
      options.store,
    );
  const runGated = (options?: Parameters<typeof gated>[0]) => Effect.runPromise(gated(options));
  return { run, runGated, gated, calls, warnings, db, target, provider, withServices, stateStore };
};

test("initializes a kept standalone catalog database after an unrecorded failed first apply", async () => {
  const { run, calls } = activation("postgres");
  await run("kept", undefined, false, null);
  expect(calls.exec).toBe(1);
});

test.each(["continuation", "exec", "volume-binding", "paths", "redaction"] as const)(
  "refuses unsafe database-gated apply without %s",
  async (missing) => {
    const fixture = activation("postgres");
    const client = ServiceName.make("client");
    const target: AppPlan = {
      ...fixture.target,
      services: {
        ...fixture.target.services,
        [client]: {
          ...web,
          name: client,
          dependsOn: [{ service: fixture.db.name, condition: "service_healthy", required: true }],
        },
      },
    };
    const { observeBoundVolume, healthyDependencyContinuation, ...unbound } = fixture.provider;
    let applied = false;
    const provider = await Effect.runPromise(
      prepareProvider({
        ...unbound,
        ...(missing === "continuation" || healthyDependencyContinuation === undefined
          ? {}
          : { healthyDependencyContinuation }),
        ...(missing === "volume-binding" || observeBoundVolume === undefined ? {} : { observeBoundVolume }),
        capabilities: { ...fixture.provider.capabilities, serviceExec: missing !== "exec" },
        apply: () =>
          Effect.sync(() => {
            applied = true;
            return { changed: true };
          }),
      }),
    );
    const { certificates } = await Effect.runPromise(prepareServiceCertificates(target));
    const checked = Effect.result(
      applyActivation({
        plan: target,
        provider,
        certificates,
        reconcile: false,
        environment: { resolveEnvironment: () => Effect.succeed({}) },
      }),
    ).pipe(
      Effect.provide(HostMountPoints.layer),
      Effect.provideService(StateStore, fixture.stateStore),
      Effect.provideService(EnvironmentValueResolver, {
        openSession: () => Effect.die("unexpected session"),
      }),
    );
    const withPaths =
      missing === "paths" ? checked : checked.pipe(Effect.provideService(PathsService, makeLandoPaths()));
    const outcome = await Effect.runPromise(
      missing === "redaction"
        ? withPaths
        : withPaths.pipe(Effect.provideService(RedactionService, makeRedactionService())),
    );
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderCapabilityError" } });
    expect(applied).toBe(false);
  },
);

test("proves a kept database once for two consumers on a cold retry with no applied plan", async () => {
  const { runGated, calls } = activation("postgres");
  expect(await runGated()).toEqual({ attempts: [undefined, undefined], changes: [] });
  expect(calls).toEqual({ inspect: 1, volume: 1, exec: 1 });
});

test.each([false, true])(
  "retained storage does not suggest explicit repair after administrator authorization fails (recorded: %s)",
  async (recorded) => {
    const { runGated, target } = activation("mssql");
    const { attempts } = await runGated({
      ...(recorded ? { previousPlan: target } : {}),
      execStream: () =>
        Stream.make({ kind: "stdout", chunk: new TextEncoder().encode("0\n0\n") }, { exitCode: 0 }),
    });
    expect(attempts[0]).toMatchObject({
      _tag: "ServiceStartError",
      details: { reason: "insufficient-privilege" },
    });
    expect(attempts[0]?.remediation).not.toContain("db:creds:apply");
  },
);

test("does no inline credential I/O for an author-owned database", async () => {
  const { runGated, calls } = activation("postgres", { authorOwned: true });
  expect(await runGated()).toEqual({ attempts: [undefined, undefined], changes: [] });
  expect(calls).toEqual({ inspect: 0, volume: 0, exec: 0 });
});

test.each(["desired", "retained"] as const)(
  "selected convergence does not touch storage shared by a %s sibling",
  async (view) => {
    const { target, db, runGated, calls } = activation("postgres");
    const sibling = ServiceName.make("sibling");
    const shared = {
      ...target,
      services: { ...target.services, [sibling]: { ...web, name: sibling, mounts: db.mounts } },
    };
    const unmounted = {
      ...target,
      services: { ...target.services, [sibling]: { ...web, name: sibling, mounts: [] } },
    };
    expect(
      await runGated({
        desiredPlan: view === "desired" ? shared : unmounted,
        previousPlan: view === "retained" ? shared : unmounted,
      }),
    ).toEqual({ attempts: [undefined, undefined], changes: [] });
    expect(calls).toEqual({ inspect: 0, volume: 0, exec: 0 });
  },
);

test.each(["standalone", "optional", "required"] as const)(
  "an unproven custom database build stays read-only for %s activation",
  async (edge) => {
    const fixture = activation("postgres", { built: true });
    const client = ServiceName.make("client");
    const target: AppPlan =
      edge === "standalone"
        ? fixture.target
        : {
            ...fixture.target,
            services: {
              ...fixture.target.services,
              [client]: {
                ...web,
                name: client,
                dependsOn: [
                  { service: fixture.db.name, condition: "service_healthy", required: edge === "required" },
                ],
              },
            },
          };
    const commands: CommandSpec[] = [];
    const result = await Effect.runPromise(
      fixture.withServices(
        Effect.gen(function* () {
          const provider = yield* prepareProvider({
            ...fixture.provider,
            execStream: (_target, command) => {
              commands.push(command);
              return Stream.make(
                { kind: "stderr", chunk: new TextEncoder().encode('FATAL: database "appdb" does not exist') },
                { exitCode: 2 },
              );
            },
            apply: (_plan, options) =>
              Effect.gen(function* () {
                if (edge !== "standalone") {
                  if (options.continueHealthyDependency === undefined)
                    return yield* Effect.die("Expected a healthy dependency continuation");
                  const refusal = yield* options.continueHealthyDependency({
                    consumer: client,
                    dependency: fixture.db.name,
                    containerId: "native-db",
                    createdVolumes: [],
                  });
                  if (refusal !== undefined && edge === "required") return yield* refusal;
                }
                return {
                  changed: true,
                  services: { [fixture.db.name]: { action: edge === "standalone" ? "started" : "kept" } },
                };
              }),
          });
          const { certificates } = yield* prepareServiceCertificates(target);
          return yield* Effect.result(
            applyActivation({
              plan: target,
              previousPlan: target,
              provider,
              certificates,
              reconcile: false,
              environment: { resolveEnvironment: () => Effect.succeed({ PGPASSWORD: "FixturePassword1!" }) },
            }),
          );
        }).pipe(
          Effect.provide(HostMountPoints.layer),
          Effect.provideService(EnvironmentValueResolver, {
            openSession: () => Effect.die("unexpected session"),
          }),
        ),
      ),
    );
    const warnings = await Effect.runPromise(fixture.warnings.list);
    expect(fixture.calls).toEqual({ inspect: 0, volume: 0, exec: 0 });
    if (edge === "required") {
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ServiceStartError", service: client, details: { reason: "unsupported-target" } },
      });
      expect(commands).toEqual([]);
      expect(warnings).toEqual([]);
    } else {
      expect(result).toMatchObject({ _tag: "Success", success: { changed: true } });
      expect(
        commands.map(({ command, stdin, stdinStream }) => [
          command.some((arg) => arg.includes("psql ") && arg.endsWith('"SELECT 1"')),
          command.at(-1),
          stdin,
          stdinStream,
        ]),
      ).toEqual([[true, "appdb", undefined, undefined]]);
      expect(warnings).toMatchObject([
        { code: "LANDO_DATABASE_MISSING", context: { service: fixture.db.name, login: "app" } },
      ]);
    }
  },
);

test.each([false, true])(
  "the activation deadline joins catalog provenance cleanup (defect: %s)",
  async (cleanupDefect) => {
    const fixture = activation("postgres", { built: true });
    const canary = "sensitive deadline cleanup payload";
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const store: StateStoreShape = {
          ...fixture.stateStore,
          open: (spec) =>
            spec.key === "artifact-build-results.bin"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Deferred.succeed(cleaning, undefined).pipe(
                      Effect.andThen(Deferred.await(finish)),
                      Effect.andThen(cleanupDefect ? Effect.die(canary) : Effect.void),
                    ),
                  ),
                )
              : fixture.stateStore.open(spec),
        };
        const attempt = yield* Effect.forkChild(fixture.gated({ store }));
        yield* Deferred.await(started);
        yield* TestClock.adjust("12 seconds");
        yield* Deferred.await(cleaning);
        const pending = attempt.pollUnsafe() === undefined;
        yield* Deferred.succeed(finish, undefined);
        const settled = yield* Fiber.await(attempt);
        expect(pending).toBe(true);
        if (cleanupDefect) {
          if (Exit.isSuccess(settled)) throw new TypeError("Deadline discarded the cleanup failure");
          expect(
            settled.cause.reasons.map((reason) => ({
              tag: reason._tag,
              role: Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
            })),
          ).toEqual([{ tag: "Die", role: "cleanup" }]);
          expect(Cause.pretty(settled.cause)).not.toContain(canary);
        } else {
          if (Exit.isFailure(settled)) throw new TypeError("Deadline unexpectedly failed");
          expect(settled.value.attempts[0]).toMatchObject({
            _tag: "ServiceStartError",
            details: { reason: "timeout" },
          });
        }
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

test("preserves and sanitizes mixed database exec failure causes instead of returning a gate verdict", async () => {
  const { gated } = activation("postgres");
  const canary = "sensitive provider payload";
  const error = new ProviderInternalError({
    providerId: plan.provider,
    operation: "exec",
    message: canary,
    remediation: canary,
  });
  const exit = await Effect.runPromiseExit(
    gated({
      execStream: () => Stream.failCause(mergeFailure(Cause.fail(error), Cause.die(canary), "cleanup")),
    }),
  );
  if (Exit.isSuccess(exit)) throw new TypeError("Expected the exceptional cause");
  expect(
    exit.cause.reasons.map((reason) => ({
      tag: reason._tag,
      role: Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
    })),
  ).toEqual([
    { tag: "Fail", role: undefined },
    { tag: "Die", role: "cleanup" },
  ]);
  expect(Cause.pretty(exit.cause)).not.toContain(canary);
});

test.each(["Die", "Interrupt"] as const)(
  "propagates provenance cleanup %s with sanitized state failure reasons",
  async (tag) => {
    const { gated, stateStore } = activation("postgres", { built: true });
    const canary = "sensitive provenance payload";
    const read = new StateStoreError({ reason: "io", operation: canary, remediation: canary });
    const exit = await Effect.runPromiseExit(
      gated({
        store: {
          ...stateStore,
          open: () =>
            Effect.failCause(
              mergeFailure(
                Cause.fail(read),
                tag === "Die" ? Cause.die(canary) : Cause.interrupt(42),
                "cleanup",
              ),
            ),
        },
      }),
    );
    if (Exit.isSuccess(exit)) throw new TypeError("Expected provenance cleanup failure");
    expect(
      exit.cause.reasons.map((reason) => ({
        tag: reason._tag,
        role: Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
      })),
    ).toEqual([
      { tag: "Fail", role: undefined },
      { tag, role: tag === "Die" ? "cleanup" : undefined },
    ]);
    expect(Cause.pretty(exit.cause)).not.toContain(canary);
  },
);

test.each([
  {
    containerId: "swapped-db",
  },
  {
    coordinationKey: "other-held-volume",
  },
])("refuses inline credential exec on mismatched admission %o", async (options) => {
  const { runGated, calls, warnings, db } = activation("postgres");
  const { attempts } = await runGated(options);
  expect(attempts).toMatchObject([
    {
      _tag: "ServiceStartError",
      service: "client-one",
      details: { dependency: db.name, reason: "target-changed" },
    },
    {
      _tag: "ServiceStartError",
      service: "client-two",
      details: { dependency: db.name, reason: "target-changed" },
    },
  ]);
  for (const attempt of attempts) expect(attempt?.remediation).not.toContain("db:creds:apply");
  expect(calls.exec).toBe(0);
  expect((await Effect.runPromise(warnings.list)).map(({ code }) => code)).toEqual([
    "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
  ]);
});

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
    writeResponse?: ReturnType<RuntimeProviderShape["execStream"]>;
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
          if (state.writeResponse !== undefined) return state.writeResponse;
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

test("activation expiry after dispatch reports an uncertain database write", async () => {
  const { gated } = activation("mssql");
  await Effect.runPromise(
    Effect.gen(function* () {
      const preflight = yield* Deferred.make<void>();
      const wrote = yield* Deferred.make<void>();
      const state = {
        databaseExists: false,
        writeResponse: Stream.unwrap(Deferred.succeed(wrote, undefined).pipe(Effect.as(Stream.never))),
      };
      const exec = mssqlExec(state);
      let delayed = 0;
      const attempt = yield* Effect.forkChild(
        gated({
          execStream: (target, command) => {
            if (delayed++ >= 2) return exec(target, command);
            return Stream.unwrap(
              Deferred.succeed(preflight, undefined).pipe(
                Effect.andThen(Effect.sleep("10 seconds")),
                Effect.as(exec(target, command)),
              ),
            );
          },
        }),
      );
      yield* Deferred.await(preflight);
      yield* TestClock.adjust("20 seconds");
      yield* Deferred.await(wrote);
      yield* TestClock.adjust("12 seconds");
      const { attempts } = yield* Fiber.join(attempt);
      expect(state.databaseExists).toBe(true);
      expect(attempts[0]).toMatchObject({
        _tag: "ServiceStartError",
        details: { reason: "timeout-after-mutation" },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

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
