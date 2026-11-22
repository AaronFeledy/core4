import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { runProbe } from "@lando/sdk/probe";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  CommandResultEnvelope,
  InfoAppResult,
  SSH_AGENT_SOCKET_NAME,
} from "@lando/sdk/schema";
import { Duration, Effect, Schema } from "effect";

const socket = resolveLiveProviderSocket();
const binary = resolve(process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"));
const Info = Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), result: InfoAppResult }));
const Acquisition = Schema.fromJsonString(Schema.Struct({ httpsPort: Schema.Int }));
const Inspect = Schema.fromJsonString(
  Schema.Struct({
    Config: Schema.Struct({ Env: Schema.Array(Schema.String) }),
    Mounts: Schema.Array(
      Schema.Struct({
        Type: Schema.String,
        Name: Schema.optionalKey(Schema.String),
        Destination: Schema.String,
      }),
    ),
  }),
);

async function allocateRoot(endpoint: string, side: "a" | "b") {
  const directory = await mkdtemp(join(tmpdir(), `ldr-${side}-`));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANDO_"))),
    ...tempPodmanRootEnv(directory, endpoint),
    LANDO_SCENARIO_E2E_BINARY: binary,
    LANDO_TELEMETRY_ENABLED: "false",
    HOME: join(directory, "home"),
    CAROOT: join(directory, "ca"),
  };
  const owned = { directory, endpoint, command: [binary] as const, env };
  let verifiedPurged = false;
  return {
    owned,
    scenario: { guideId: "shared-engine-roots", scenarioId: side, render: false, e2eEnv: env },
    verifiedPurge: () => {
      verifiedPurged = true;
    },
    async [Symbol.asyncDispose]() {
      if (verifiedPurged) {
        await rm(directory, { recursive: true, force: true });
      } else {
        const result = await retireTempRoots(owned);
        expect(
          [...result.retained, ...result.failed],
          JSON.stringify({ directory, endpoint, ...result }),
        ).toEqual([]);
      }
    },
  };
}

const cli = Effect.fnUntraced(function* (
  scenario: ScenarioContext,
  args: readonly string[],
  timeoutMs = 120_000,
) {
  const result = yield* scenario.runCli([...args, "--format=json"], { timeoutMs });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  return result.stdout;
});

const infoUrl = Effect.fnUntraced(function* (scenario: ScenarioContext) {
  const { result } = Schema.decodeUnknownSync(Info)(yield* cli(scenario, ["info"]));
  const url = result.services
    .find(({ service }) => service === "web")
    ?.connections.find(
      (connection) =>
        connection.source === "route" && connection.binding === "assigned" && connection.protocol === "https",
    )?.url;
  if (url === undefined) throw new Error("lando info published no assigned HTTPS URL for web");
  return new URL(url);
});

const start = Effect.fnUntraced(function* (
  scenario: ScenarioContext,
  root: Awaited<ReturnType<typeof allocateRoot>>,
) {
  const name = `shared-${crypto.randomUUID().slice(0, 12)}`;
  const hostname = `${name}.lndo.site`;
  const body = `served-by-${name}`;
  yield* Effect.tryPromise(async () => {
    await mkdir(join(root.owned.env.HOME, ".ssh"), { recursive: true, mode: 0o700 });
    await chmod(scenario.testDir, 0o755);
    await Bun.write(join(scenario.testDir, "index.html"), body);
    await Bun.write(
      join(scenario.testDir, ".lando.yml"),
      [
        `name: ${name}`,
        "runtime: 4",
        "provider: podman",
        "sshAgent:",
        "  sidecar: true",
        "services:",
        "  web:",
        "    type: nginx",
        "    webroot: .",
        "    routes:",
        `      - hostname: ${hostname}`,
        "        scheme: https",
        "",
      ].join("\n"),
    );
  });
  yield* cli(scenario, TEMP_PODMAN_ROOT_SETUP_ARGS);
  yield* cli(scenario, ["start"], 300_000);
  const url = yield* infoUrl(scenario);
  const acquisitionFile = join(
    root.owned.env.LANDO_USER_DATA_ROOT,
    "global/proxy-traefik/dynamic/.lando-port-acquisition.json",
  );
  const { httpsPort } = Schema.decodeUnknownSync(Acquisition)(
    yield* Effect.tryPromise(() => Bun.file(acquisitionFile).text()),
  );
  expect(url.hostname).toBe(hostname);
  expect(Number(url.port || "443")).toBe(httpsPort);
  return { body, url, httpsPort };
});

const assertServed = Effect.fnUntraced(function* (
  fetchRoute: Effect.Effect<{ readonly status: number; readonly body: string }, unknown>,
  body: string,
) {
  const proof = yield* runProbe(
    {
      id: "nginx body through HTTPS",
      policy: { timeout: Duration.seconds(20), delay: Duration.millis(250), maxAttempts: 20 },
    },
    fetchRoute.pipe(
      Effect.flatMap((response) =>
        response.status === 200 && response.body === body
          ? Effect.void
          : Effect.fail(
              new Error(
                `Expected HTTP 200 with ${body}; got ${response.status}: ${response.body.slice(0, 120)}`,
              ),
            ),
      ),
    ),
  );
  expect(proof.outcome, String(proof.lastError ?? body)).toBe("green");
});

type Snapshot = Effect.Success<Effect.Success<ReturnType<typeof bindTempRootObservation>>>;
const ids = (snapshot: Snapshot) => ({
  containers: snapshot.container.map(({ id }) => id).sort(),
  networks: snapshot.network.map(({ id }) => id).sort(),
  volumes: snapshot.volume.map(({ id }) => id).sort(),
  images: snapshot.image.map(({ id }) => id).sort(),
});

const assertAgent = Effect.fnUntraced(function* (snapshot: Snapshot, endpoint: string, routerName: string) {
  const named = (name: string) =>
    snapshot.container.find(({ names }) => names.some((native) => native.replace(/^\//u, "") === name));
  const web = snapshot.container.find(({ names }) => names.some((name) => name.endsWith("--web")));
  const agent = named(routerName.replace(/--traefik$/u, "--ssh-agent"));
  if (web === undefined || agent === undefined)
    throw new Error(`Missing web or SSH sidecar for ${routerName}`);
  const api = makePodmanApiClient(endpoint, {
    providerId: "podman",
    env: {},
    remediation: "Check the shared live endpoint.",
  });
  const request = api.request;
  if (request === undefined) throw new Error("Podman inspect transport is unavailable");
  const inspect = (id: string) =>
    request({ method: "GET", path: `/containers/${encodeURIComponent(id)}/json` }).pipe(
      Effect.timeout("15 seconds"),
      Effect.map(({ status, body }) => {
        expect(status).toBe(200);
        return Schema.decodeUnknownSync(Inspect)(body);
      }),
    );
  const observed = yield* Effect.all({ web: inspect(web.id), agent: inspect(agent.id) });
  const dir = AGENT_SOCKET_CONTAINER_DIR.ssh;
  const agentVolume = observed.agent.Mounts.find(
    (mount) => mount.Type === "volume" && mount.Destination === "/run/lando/ssh-agent",
  )?.Name;
  if (agentVolume === undefined) throw new Error(`No named SSH agent volume for ${routerName}`);
  expect(observed.web.Config.Env).toContain(`SSH_AUTH_SOCK=${dir}/${SSH_AGENT_SOCKET_NAME}`);
  expect(observed.web.Mounts).toContainEqual({ Type: "volume", Name: agentVolume, Destination: dir });
  expect(ids(snapshot).volumes).toContain(agentVolume);
  return agentVolume;
});

test.skipIf(socket === undefined && process.env.LANDO_GUIDE_E2E !== "1")(
  "purging one of two routed data roots on a shared Podman endpoint leaves the peer intact",
  async () => {
    if (socket === undefined)
      throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
    if (Bun.which(binary) === null)
      throw new Error(`Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY; missing ${binary}.`);
    const endpoint = socket.socketPath;
    await using a = await allocateRoot(endpoint, "a");
    await using b = await allocateRoot(endpoint, "b");
    await Effect.runPromise(
      ScenarioContextFactory.e2e(a.scenario, (first) =>
        ScenarioContextFactory.e2e(b.scenario, (second) =>
          Effect.gen(function* () {
            const appA = yield* start(first, a);
            const appB = yield* start(second, b);
            const readA = yield* bindTempRootObservation(a.owned);
            const readB = yield* bindTempRootObservation(b.owned);
            const beforeA = yield* readA;
            const beforeB = yield* readB;
            const routerName = (snapshot: Snapshot) =>
              snapshot.container
                .flatMap(({ names }) => names)
                .map((name) => name.replace(/^\//u, ""))
                .find((name) => name.endsWith("--traefik")) ?? "";
            const routerA = routerName(beforeA);
            const routerB = routerName(beforeB);
            expect(routerA).toMatch(/^lando-global-[0-9a-f]{16}--traefik$/u);
            expect(routerB).toMatch(/^lando-global-[0-9a-f]{16}--traefik$/u);
            expect(routerA).not.toBe(routerB);
            expect(appA.httpsPort).not.toBe(appB.httpsPort);
            const requestA = first.fetch({ url: appA.url.href });
            yield* assertServed(requestA, appA.body);
            yield* assertServed(second.fetch({ url: appB.url.href }), appB.body);
            const volumeA = yield* assertAgent(beforeA, endpoint, routerA);
            const volumeB = yield* assertAgent(beforeB, endpoint, routerB);
            expect(volumeA).not.toBe(volumeB);
            expect(beforeB.network).not.toEqual([]);
            expect(beforeB.image).not.toEqual([]);

            const purge = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope))(
              yield* cli(second, ["uninstall", "--purge", "--yes"]),
            );
            expect(purge.ok).toBe(true);
            expect(ids(yield* readB)).toEqual({ containers: [], networks: [], volumes: [], images: [] });
            b.verifiedPurge();
            expect(ids(yield* readA)).toEqual(ids(beforeA));
            expect((yield* infoUrl(first)).href).toBe(appA.url.href);
            yield* assertServed(requestA, appA.body);
          }),
        ),
      ),
    );
  },
  1_250_000,
);
