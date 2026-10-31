import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { runProbe } from "@lando/sdk/probe";
import {
  InfoAppResult,
  type LandofileShape,
  type ServiceConnection,
  StartAppResult,
} from "@lando/sdk/schema";
import { Duration, Effect, Option, Schema } from "effect";
import { acquireTempAppRoot } from "./live-app-scope.ts";

const startEnvelope = Schema.Struct({ ok: Schema.Literal(true), result: StartAppResult });
const startFrame = Schema.Struct({ _tag: Schema.Literal("result"), envelope: startEnvelope });
const infoEnvelope = Schema.Struct({ ok: Schema.Literal(true), result: InfoAppResult });
const stdoutFrame = Schema.Struct({ _tag: Schema.Literal("stdout"), chunk: Schema.String });

export const listenerCli = (args: {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
}) =>
  Effect.tryPromise({
    try: async (signal) => {
      const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
      if (binary === undefined) throw new Error("Compiled CLI prerequisite missing");
      const child = Bun.spawn([binary, "--format=json", ...args.argv], {
        cwd: args.root,
        env: args.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal,
        timeout: 240_000,
        killSignal: "SIGKILL",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${args.argv.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
      return stdout;
    },
    catch: (cause) => cause,
  });

export const acquireListenerApp = Effect.fnUntraced(function* (socketPath: string) {
  const directory = yield* acquireTempAppRoot("lando-listener-");
  const root = join(directory, "app");
  yield* Effect.promise(() => mkdir(root));
  const name = `listener-${crypto.randomUUID().slice(0, 12)}`;
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "BUN_BE_BUN" && !key.startsWith("LANDO_CONFIG__"),
      ),
    ),
    LANDO_USER_CONF_ROOT: join(directory, "config"),
    LANDO_USER_DATA_ROOT: join(directory, "data"),
    LANDO_USER_CACHE_ROOT: join(directory, "cache"),
    LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "system-plugins"),
    LANDO_PROVIDER: "podman",
    DOCKER_HOST: `unix://${socketPath}`,
    LANDO_TELEMETRY_ENABLED: "false",
    LANDO_CONFIG__default_provider_id: "podman",
  };
  const cli = (argv: readonly string[]) => listenerCli({ root, env, argv });
  return {
    root,
    name,
    cli,
    start: Effect.fnUntraced(function* (config: Pick<typeof LandofileShape.Encoded, "services">) {
      yield* Effect.promise(() =>
        Bun.write(
          join(root, ".lando.yml"),
          emitLandofileYaml({
            name,
            runtime: 4,
            provider: "podman",
            router: { enabled: false },
            ...config,
          }),
        ),
      );
      yield* cli(["app:cache:refresh"]);
      // Register before starting: a partially failed apply also owns resources.
      yield* Effect.addFinalizer(() =>
        cli(["destroy", "--volumes", "--yes"]).pipe(Effect.timeout("90 seconds"), Effect.orDie),
      );
      const output = yield* cli(["start"]);
      const json: unknown = JSON.parse(output.trim().split("\n").at(-1) ?? "");
      const frame = Schema.decodeUnknownOption(startFrame)(json);
      return Option.isSome(frame)
        ? frame.value.envelope.result
        : Schema.decodeUnknownSync(startEnvelope)(json).result;
    }),
    info: Effect.fnUntraced(function* () {
      const output = yield* cli(["info"]);
      return Schema.decodeUnknownSync(Schema.fromJsonString(infoEnvelope))(output).result;
    }),
    exec: Effect.fnUntraced(function* (service: string, command: readonly string[]) {
      const output = yield* cli(["exec", service, "--", ...command]);
      return output
        .trim()
        .split("\n")
        .flatMap((line) => {
          const frame = Schema.decodeUnknownOption(Schema.fromJsonString(stdoutFrame))(line);
          return Option.isSome(frame) ? [frame.value.chunk] : [];
        })
        .join("");
    }),
  };
});
export type ListenerApp = Effect.Success<ReturnType<typeof acquireListenerApp>>;

export const publicationFor = (connections: readonly ServiceConnection[], port: number) => {
  const connection = connections.find((item) => item.source === "publication" && item.endpoint.port === port);
  if (connection === undefined || connection.binding !== "assigned")
    throw new Error(`Missing observed publication for ${port}`);
  expect(connection.host).toBe("localhost");
  expect(connection.state).toBe("active");
  expect(connection.port).toBeGreaterThan(0);
  return connection;
};

export const probeListener = (attempt: Effect.Effect<void, unknown>) =>
  runProbe(
    {
      id: "listener-protocol",
      policy: { maxAttempts: 30, delay: Duration.millis(500), timeout: Duration.seconds(30) },
    },
    attempt,
  ).pipe(
    Effect.flatMap((result) =>
      result.outcome === "green"
        ? Effect.void
        : Effect.fail(new Error(`Protocol probe exhausted: ${String(result.lastError)}`)),
    ),
  );

export const listenerHttp = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await httpJsonFetch(url, { redirect: "manual", timeoutMs: 5000 });
      return { status: response.status, body: new TextDecoder().decode(response.bytes) };
    },
    catch: (cause) => cause,
  }).pipe(Effect.timeout("5 seconds"));
