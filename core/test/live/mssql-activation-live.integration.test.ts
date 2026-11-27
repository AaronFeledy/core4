import { expect, test } from "bun:test";
import { join } from "node:path";
import { APP_LABEL, SERVICE_LABEL, VOLUME_INSTANCE_LABEL } from "@lando/container-runtime/labels";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { parseContainerEventPayloads } from "@lando/container-runtime/podman/container-events";
import { type ScenarioContext, ScenarioContextFactory } from "@lando/core/testing";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { runProbeDetailed } from "@lando/sdk/probe";
import { Clock, Duration, Effect, Schema } from "effect";
import { decodeResultFrameEnvelope } from "./convergence-cli.ts";

const socket = resolveLiveProviderSocket();
const live = test.skipIf(
  process.platform !== "linux" ||
    process.arch !== "x64" ||
    (socket === undefined && process.env.LANDO_GUIDE_E2E !== "1"),
);
const timeoutMs = 180_000;
const database = "kept_retry_probe";
const image = "docker.io/library/alpine:3.21";

const readPodman = (endpoint: string) => {
  const { request } = makePodmanApiClient(endpoint, {
    providerId: "podman",
    env: {},
    remediation: "Check the live Podman socket.",
  });
  if (request === undefined) throw new Error("Podman request transport is unavailable.");
  return (path: `/${string}`) =>
    request({ method: "GET", path }).pipe(
      Effect.timeout("15 seconds"),
      Effect.map(({ status, body }) => {
        expect(status, path).toBe(200);
        return body;
      }),
    );
};

const ContainerList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.NonEmptyString,
      Labels: Schema.Struct({ [SERVICE_LABEL]: Schema.String }),
    }),
  ),
);
const ContainerMounts = Schema.fromJsonString(
  Schema.Struct({
    Mounts: Schema.Array(
      Schema.Struct({
        Type: Schema.String,
        Destination: Schema.String,
        Name: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);
const Volume = Schema.fromJsonString(
  Schema.Struct({
    Name: Schema.NonEmptyString,
    CreatedAt: Schema.NonEmptyString,
    Labels: Schema.Struct({ [VOLUME_INSTANCE_LABEL]: Schema.NonEmptyString }),
  }),
);
const ContainerEvent = Schema.Struct({
  Action: Schema.Literals(["create", "start"]),
  Actor: Schema.Struct({
    Attributes: Schema.Record(Schema.String, Schema.String),
  }),
});

const runningDatabase = Effect.fnUntraced(function* (read: ReturnType<typeof readPodman>, name: string) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${APP_LABEL}=${name}`] }));
  const containers = Schema.decodeUnknownSync(ContainerList)(
    yield* read(`/containers/json?filters=${filters}`),
  );
  const databases = containers.filter(({ Labels }) => Labels[SERVICE_LABEL] === "db");
  const [db] = databases;
  if (databases.length !== 1 || db === undefined)
    throw new Error(`Expected one running database for ${name}.`);
  const { Mounts } = Schema.decodeUnknownSync(ContainerMounts)(yield* read(`/containers/${db.Id}/json`));
  const mount = Mounts.find(({ Type, Destination }) => Type === "volume" && Destination === "/var/opt/mssql");
  if (!mount?.Name) throw new Error(`No named SQL Server data mount on ${db.Id}.`);
  const volume = Schema.decodeUnknownSync(Volume)(yield* read(`/volumes/${encodeURIComponent(mount.Name)}`));
  return { id: db.Id, volume };
});

const lifecycleEvents = Effect.fnUntraced(function* (
  read: ReturnType<typeof readPodman>,
  name: string,
  since: number,
) {
  const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["create", "start"] }));
  const raw = yield* read(`/libpod/events?since=${since}&stream=false&filters=${filters}`);
  return parseContainerEventPayloads(raw)
    .map((payload) => Schema.decodeUnknownSync(ContainerEvent)(payload))
    .filter(({ Actor }) => Actor.Attributes[APP_LABEL] === name)
    .map(({ Action, Actor }) => ({ action: Action, service: Actor.Attributes[SERVICE_LABEL] }));
});

type LifecycleEvents = Effect.Success<ReturnType<typeof lifecycleEvents>>;
const actionsFor = (events: LifecycleEvents, service: string) =>
  events.filter((event) => event.service === service).map(({ action }) => action);

const withApp = (
  scenarioId: string,
  body: (
    context: ScenarioContext,
    app: { readonly name: string; readonly read: ReturnType<typeof readPodman> },
  ) => Effect.Effect<void, unknown>,
) => {
  if (socket === undefined) throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required.");
  const name = `mssql-activation-${crypto.randomUUID().slice(0, 12)}`;
  const read = readPodman(socket.socketPath);
  return Effect.runPromise(
    ScenarioContextFactory.e2e({ guideId: "mssql-activation-live", scenarioId, render: false }, (context) =>
      Effect.gen(function* () {
        yield* context.deferCleanup(
          [
            context
              .runCli(["destroy", "--yes", "--volumes", "--format=json"], { timeoutMs })
              .pipe(Effect.map((result) => expect(result.exitCode, JSON.stringify(result)).toBe(0))),
          ],
          true,
        );
        yield* body(context, { name, read });
      }),
    ),
  );
};

const writeLandofile = (
  context: ScenarioContext,
  name: string,
  settings: { readonly jobExit: 41 | 0 } | { readonly database: "master" | typeof database },
) => {
  const compose = { type: "compose", image, appMount: false };
  const landofile = emitLandofileYaml({
    name,
    services: {
      db: {
        type: "mssql",
        creds: {
          database: "database" in settings ? settings.database : database,
          rootPassword: "MssqlFixPass1!",
        },
      },
      ...("jobExit" in settings && {
        job: {
          ...compose,
          depends_on: { db: { condition: "service_started" } },
          command: ["/bin/sh", "-c", `exit ${settings.jobExit}`],
        },
      }),
      client: {
        ...compose,
        primary: true,
        depends_on:
          "jobExit" in settings
            ? { job: { condition: "service_completed_successfully" } }
            : { db: { condition: "service_healthy" } },
        command: ["sleep", "infinity"],
      },
    },
  });
  return Effect.tryPromise(() => Bun.write(join(context.testDir, ".lando.yml"), landofile));
};

const start = (context: ScenarioContext) => context.runCli(["start", "--format=json"], { timeoutMs });
const sqlcmd = "/opt/mssql-tools18/bin/sqlcmd -S localhost,1433 -U sa -C -b -r1 -l 2 -t 5 -h -1".split(" ");
const query = (context: ScenarioContext, target: string, sql: string) =>
  context.runCli(["exec", "db", "--", ...sqlcmd, "-d", target, "-Q", `SET NOCOUNT ON; ${sql}`], {
    timeoutMs: 12_000,
  });

live(
  "retry initializes the configured SQL Server database on the retained container and volume",
  () =>
    withApp("kept-retry", (context, { name, read }) =>
      Effect.gen(function* () {
        yield* writeLandofile(context, name, { jobExit: 41 });
        const failed = yield* start(context);
        expect(failed.exitCode, failed.stderr).toBe(1);
        expect(decodeResultFrameEnvelope(failed.stdout)).toMatchObject({
          ok: false,
          error: { _tag: "ServiceStartError", details: { dependencyExit: { service: "job", exitCode: 41 } } },
        });
        const before = yield* runningDatabase(read, name);
        const absent = yield* runProbeDetailed(
          {
            id: "retained SQL Server answers on master",
            policy: { timeout: Duration.seconds(60), delay: Duration.seconds(1), maxAttempts: 12 },
            classify: ({ exitCode }) => (exitCode === 0 ? "green" : "red"),
          },
          query(context, "master", `SELECT CASE WHEN DB_ID(N'${database}') IS NULL THEN 0 ELSE 1 END;`),
        );
        expect(absent.result.outcome, absent.last?.value.stderr).toBe("green");
        expect(absent.last?.value.stdout.trim()).toBe("0");

        yield* writeLandofile(context, name, { jobExit: 0 });
        const retry = yield* start(context);
        expect(retry.exitCode, retry.stderr).toBe(0);
        expect(decodeResultFrameEnvelope(retry.stdout).ok).toBe(true);
        expect(yield* runningDatabase(read, name)).toEqual(before);
        const login = yield* query(context, database, "SELECT DB_NAME();");
        expect(login.exitCode, login.stderr).toBe(0);
        expect(login.stdout.trim()).toBe(database);
      }),
    ),
  2 * timeoutMs + 270_000,
);

live(
  "a required SQL Server credential refusal prevents both client create and start",
  () =>
    withApp("required-gate", (context, { name, read }) =>
      Effect.gen(function* () {
        yield* writeLandofile(context, name, { database: "master" });
        const since = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const refused = yield* start(context);
        const envelope = decodeResultFrameEnvelope(refused.stdout);
        expect(envelope).toMatchObject({
          ok: false,
          error: {
            _tag: "ServiceStartError",
            operation: "database-credential-convergence",
            service: "client",
            details: { dependency: "db", reason: "preflight" },
          },
        });
        expect(refused.exitCode, refused.stderr).toBe(1);
        const events = yield* lifecycleEvents(read, name, since);
        expect(actionsFor(events, "db"), JSON.stringify(envelope)).toEqual(["create", "start"]);
        expect(actionsFor(events, "client")).toEqual([]);

        yield* writeLandofile(context, name, { database });
        const retry = yield* start(context);
        expect(retry.exitCode, retry.stderr).toBe(0);
        const admitted = yield* lifecycleEvents(read, name, since);
        expect(actionsFor(admitted, "client")).toEqual(["create", "start"]);
      }),
    ),
  3 * timeoutMs + 30_000,
);
