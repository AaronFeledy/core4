import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { type ScenarioContext, ScenarioContextFactory } from "@lando/core/testing";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import {
  TEMP_PODMAN_ROOT_SETUP_ARGS,
  bindTempRootObservation,
  retireTempRoots,
  tempPodmanRootEnv,
} from "@lando/engine/testing/temp-root-retirement";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const socket = resolveLiveProviderSocket();
const binary = resolve(process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"));

const scrubbedEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANDO_")));

/**
 * A second API endpoint on the same storage that claims another host name in libpod `info`, so
 * Lando identifies it as a different engine without touching the daemon. Hijacked and streamed
 * requests pass through raw; only the versioned libpod info response is rewritten, never compat
 * `/info`, which Podman reports by store name and root directory.
 */
async function startIdentityProxy(target: string, hostname: string) {
  const directory = await mkdtemp(join(tmpdir(), "ldr-identity-proxy-"));
  const socketPath = join(directory, "podman.sock");
  const forward = (client: Socket, first: Buffer) => {
    const upstream = connect(target);
    upstream.once("connect", () => {
      if (first.byteLength > 0) upstream.write(first);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  };
  const isInfo = (value: unknown): value is { readonly host: Readonly<Record<string, unknown>> } =>
    typeof value === "object" &&
    value !== null &&
    "host" in value &&
    typeof value.host === "object" &&
    value.host !== null;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.once("data", (first: Buffer) => {
      client.pause();
      const version = /^GET (\/v[0-9.]+)?\/libpod\/info\b/u.exec(first.toString("latin1"))?.[1];
      if (version === undefined) {
        forward(client, first);
        return;
      }
      const information = httpRequest(
        { socketPath: target, path: `${version}/libpod/info`, method: "GET" },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body = raw;
            try {
              const parsed: unknown = JSON.parse(raw);
              if (isInfo(parsed)) body = JSON.stringify({ ...parsed, host: { ...parsed.host, hostname } });
            } catch {
              body = raw;
            }
            client.write(
              `HTTP/1.1 ${response.statusCode ?? 200} ${response.statusMessage ?? "OK"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: keep-alive\r\n\r\n${body}`,
            );
            // A keep-alive client may reuse this connection for its next request.
            forward(client, Buffer.alloc(0));
          });
        },
      );
      information.once("error", () => client.destroy());
      information.end();
    });
  });
  await new Promise<void>((ready, fail) => {
    server.once("error", fail);
    server.listen(socketPath, ready);
  });
  return {
    socketPath,
    async close() {
      for (const client of sockets) client.destroy();
      await new Promise<void>((closed) => server.close(() => closed()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function allocateWorkspace(realSocket: string) {
  const directory = await mkdtemp(join(tmpdir(), "ldr-engine-identity-"));
  const endpoint = join(directory, "engine.sock");
  await symlink(realSocket, endpoint);
  const env = {
    ...scrubbedEnv(),
    ...tempPodmanRootEnv(directory, endpoint),
    LANDO_SCENARIO_E2E_BINARY: binary,
    LANDO_TELEMETRY_ENABLED: "false",
    HOME: join(directory, "home"),
    CAROOT: join(directory, "ca"),
  };
  const owned = { directory, endpoint, command: [binary] as const, env };
  // Root observation and retirement must reach the real daemon whatever the alias points at.
  const real = {
    ...owned,
    endpoint: realSocket,
    env: { ...env, LANDO_TEST_PODMAN_SOCKET: realSocket, DOCKER_HOST: `unix://${realSocket}` },
  };
  return {
    endpoint,
    real,
    // A per-run endpoint override points the same roots at another engine.
    proxyEnv: (proxySocket: string) => ({
      LANDO_TEST_PODMAN_SOCKET: proxySocket,
      DOCKER_HOST: `unix://${proxySocket}`,
    }),
    scenario: (id: string) => ({
      guideId: "engine-identity-live",
      scenarioId: id,
      render: false,
      e2eEnv: env,
    }),
    async [Symbol.asyncDispose]() {
      const result = await retireTempRoots(real);
      expect([...result.retained, ...result.failed], JSON.stringify({ directory, ...result })).toEqual([]);
    },
  };
}

const app = (name: string) =>
  [
    `name: ${name}`,
    "runtime: 4",
    "provider: podman",
    "router:",
    "  enabled: false",
    "services:",
    "  web:",
    "    type: compose",
    "    image: docker.io/library/alpine:3.20",
    "    user: root",
    "    home: false",
    "    appMount: false",
    "    command:",
    "      - sh",
    "      - -c",
    "      - \"trap 'exit 0' TERM; sleep infinity & wait\"",
    "    storage:",
    `      - store: ${name}-data`,
    "        target: /data",
    "",
  ].join("\n");

/** A live-streaming command ends in one `result` frame; other commands print the envelope alone. */
const envelopeFrom = (stdout: string) => {
  const last =
    stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1) ?? "";
  const parsed: unknown = JSON.parse(last);
  const frame =
    typeof parsed === "object" &&
    parsed !== null &&
    "_tag" in parsed &&
    parsed._tag === "result" &&
    "envelope" in parsed
      ? parsed.envelope
      : parsed;
  return Schema.decodeUnknownSync(CommandResultEnvelope)(frame);
};

const run = (
  scenario: ScenarioContext,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const result = yield* scenario.runCli([...args, "--format=json"], {
      timeoutMs: 300_000,
      ...(env === undefined ? {} : { env }),
    });
    try {
      return { result, envelope: envelopeFrom(result.stdout) };
    } catch (cause) {
      throw new Error(
        `${args.join(" ")} exited ${result.exitCode}: stdout=${JSON.stringify(result.stdout.slice(-600))} stderr=${JSON.stringify(result.stderr.slice(0, 600))}`,
        { cause },
      );
    }
  });

const accepted = (
  scenario: ScenarioContext,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const { result, envelope } = yield* run(scenario, args, env);
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    return envelope;
  });

const refused = (
  scenario: ScenarioContext,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const { result, envelope } = yield* run(scenario, args, env);
    expect(result.exitCode, JSON.stringify(result)).not.toBe(0);
    if (envelope.ok) throw new Error(`Expected ${args.join(" ")} to refuse: ${result.stdout}`);
    if (envelope.error === undefined) throw new Error(`Expected a tagged error from ${args.join(" ")}`);
    return envelope.error;
  });

const startApp = (scenario: ScenarioContext, name: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => Bun.write(join(scenario.testDir, ".lando.yml"), app(name)));
    yield* accepted(scenario, TEMP_PODMAN_ROOT_SETUP_ARGS);
    yield* accepted(scenario, ["start"]);
  });

const ids = (snapshot: Effect.Success<Effect.Success<ReturnType<typeof bindTempRootObservation>>>) => ({
  containers: snapshot.container.map(({ id }) => id).sort(),
  networks: snapshot.network.map(({ id }) => id).sort(),
  volumes: snapshot.volume.map(({ id }) => id).sort(),
});

const realApi = (endpoint: string) => {
  const api = makePodmanApiClient(endpoint, {
    providerId: "podman",
    env: {},
    remediation: "Check the live Podman endpoint.",
  });
  if (api.request === undefined) throw new Error("Podman API transport is unavailable");
  return api.request;
};

test.skipIf(socket === undefined && process.env.LANDO_GUIDE_E2E !== "1")(
  "start, info, and destroy refuse a record from another engine before touching it",
  async () => {
    if (socket === undefined)
      throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
    if (Bun.which(binary) === null)
      throw new Error(`Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY; missing ${binary}.`);
    await using workspace = await allocateWorkspace(socket.socketPath);
    const proxy = await startIdentityProxy(socket.socketPath, "other-engine");
    try {
      await Effect.runPromise(
        ScenarioContextFactory.e2e(workspace.scenario("refuse"), (scenario) =>
          Effect.gen(function* () {
            yield* startApp(scenario, `ldr-refuse-${crypto.randomUUID().slice(0, 8)}`);
            const read = yield* bindTempRootObservation(workspace.real);
            const before = yield* read;

            for (const args of [["start"], ["info"], ["destroy", "--yes"]]) {
              const error = yield* refused(scenario, args, workspace.proxyEnv(proxy.socketPath));
              expect(error._tag).toBe("AppPlacementError");
              expect(error.message).toContain(workspace.endpoint);
              expect(error.message).toContain(proxy.socketPath);
            }

            const readAfter = yield* bindTempRootObservation(workspace.real);
            const after = yield* readAfter;
            expect(ids(after)).toEqual(ids(before));
            yield* accepted(scenario, ["info"]);
          }),
        ),
      );
    } finally {
      await proxy.close();
    }
  },
  1_250_000,
);

test.skipIf(socket === undefined && process.env.LANDO_GUIDE_E2E !== "1")(
  "a symlinked endpoint alias runs info and stops the app",
  async () => {
    if (socket === undefined)
      throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
    await using workspace = await allocateWorkspace(socket.socketPath);
    await Effect.runPromise(
      ScenarioContextFactory.e2e(workspace.scenario("alias"), (scenario) =>
        Effect.gen(function* () {
          const name = `ldr-alias-${crypto.randomUUID().slice(0, 8)}`;
          yield* startApp(scenario, name);
          const read = yield* bindTempRootObservation(workspace.real);
          const before = yield* read;
          const info = yield* accepted(scenario, ["info"]);
          expect(info.ok).toBe(true);
          yield* accepted(scenario, ["stop"]);
          // A stop keeps the containers; the alias is one engine, so the same containers remain.
          const readAfter = yield* bindTempRootObservation(workspace.real);
          const after = yield* readAfter;
          expect(after.container.map(({ id }) => id)).toEqual(before.container.map(({ id }) => id));
          yield* accepted(scenario, ["start"]);
        }),
      ),
    );
  },
  1_250_000,
);

test.skipIf(socket === undefined && process.env.LANDO_GUIDE_E2E !== "1")(
  "poweroff skips an app recorded on another engine and completes",
  async () => {
    if (socket === undefined)
      throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
    await using workspace = await allocateWorkspace(socket.socketPath);
    const proxy = await startIdentityProxy(socket.socketPath, "other-engine");
    try {
      await Effect.runPromise(
        ScenarioContextFactory.e2e(workspace.scenario("poweroff"), (scenario) =>
          Effect.gen(function* () {
            const name = `ldr-poweroff-${crypto.randomUUID().slice(0, 8)}`;
            yield* startApp(scenario, name);
            const read = yield* bindTempRootObservation(workspace.real);
            const before = yield* read;
            const envelope = yield* accepted(scenario, ["poweroff"], workspace.proxyEnv(proxy.socketPath));
            const result = Schema.decodeUnknownSync(
              Schema.Struct({
                apps: Schema.Array(
                  Schema.Struct({
                    appId: Schema.String,
                    outcome: Schema.String,
                    reason: Schema.optionalKey(Schema.String),
                  }),
                ),
              }),
            )(envelope.result);
            const ours = result.apps.find((entry) => entry.appId === name);
            expect(ours).toMatchObject({ outcome: "skipped" });
            expect(ours?.reason).toContain(workspace.endpoint);
            expect(ours?.reason).toContain(proxy.socketPath);
            expect(ids(yield* yield* bindTempRootObservation(workspace.real))).toEqual(ids(before));
          }),
        ),
      );
    } finally {
      await proxy.close();
    }
  },
  1_250_000,
);

test.skipIf(socket === undefined && process.env.LANDO_GUIDE_E2E !== "1")(
  "an explicit provider destroy drops the record and a start on the real engine works again",
  async () => {
    if (socket === undefined)
      throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
    await using workspace = await allocateWorkspace(socket.socketPath);
    const proxy = await startIdentityProxy(socket.socketPath, "other-engine");
    try {
      await Effect.runPromise(
        ScenarioContextFactory.e2e(workspace.scenario("explicit"), (scenario) =>
          Effect.gen(function* () {
            yield* startApp(scenario, `ldr-explicit-${crypto.randomUUID().slice(0, 8)}`);
            yield* accepted(
              scenario,
              ["destroy", "--provider=podman", "--yes"],
              workspace.proxyEnv(proxy.socketPath),
            );
            yield* accepted(scenario, ["start"]);
          }),
        ),
      );
    } finally {
      await proxy.close();
    }
  },
  1_250_000,
);

test.skipIf(socket === undefined && process.env.LANDO_GUIDE_E2E !== "1")(
  "a start that recreates a recorded data volume warns instead of upgrading its data",
  async () => {
    if (socket === undefined)
      throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
    await using workspace = await allocateWorkspace(socket.socketPath);
    await Effect.runPromise(
      ScenarioContextFactory.e2e(workspace.scenario("recreated"), (scenario) =>
        Effect.gen(function* () {
          const name = `ldr-recreated-${crypto.randomUUID().slice(0, 8)}`;
          yield* startApp(scenario, name);
          const read = yield* bindTempRootObservation(workspace.real);
          const before = yield* read;
          const request = realApi(socket.socketPath);
          for (const container of before.container) {
            const removed = yield* request({
              method: "DELETE",
              path: `/containers/${encodeURIComponent(container.id)}?force=true`,
            }).pipe(Effect.timeout("30 seconds"), Effect.orDie);
            expect(removed.status).toBeGreaterThanOrEqual(200);
            expect(removed.status).toBeLessThan(300);
          }
          const volume = before.volume.find(({ id }) => id.includes(`${name}-data`));
          if (volume === undefined) throw new Error(`No ${name}-data volume in ${JSON.stringify(before)}`);
          const removedVolume = yield* request({
            method: "DELETE",
            path: `/volumes/${encodeURIComponent(volume.id)}?force=true`,
          }).pipe(Effect.timeout("30 seconds"), Effect.orDie);
          expect(removedVolume.status).toBeGreaterThanOrEqual(200);
          expect(removedVolume.status).toBeLessThan(300);

          const envelope = yield* accepted(scenario, ["start"]);
          const recreated = envelope.warnings.filter(
            (warning) => warning.code === "LANDO_DATA_VOLUME_RECREATED",
          );
          expect(recreated).toHaveLength(1);
          expect(recreated[0]).toMatchObject({
            context: { app: name, service: "web", volume: volume.id, target: "/data" },
          });
          expect(recreated[0]?.message).toContain("recreated without its previous contents");
          const result = Schema.decodeUnknownSync(
            Schema.Struct({ dataVersionChanges: Schema.optionalKey(Schema.Unknown) }),
          )(envelope.result);
          expect(result.dataVersionChanges).toBeUndefined();
        }),
      ),
    );
  },
  1_250_000,
);
