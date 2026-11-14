import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as LandoHttpClient from "@lando/http-client";
import { AbsolutePath, PortNumber } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { TRAEFIK_IMAGE, TRAEFIK_STATIC_FLAGS } from "../src/global-services/traefik.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { dynamicConfigDir } from "../src/proxy-paths.ts";
import type { TraefikProxyDependencies } from "../src/proxy-types.ts";
import { writeSecretAtomic } from "../src/secret-file.ts";
import pem from "./router-certificate-fixtures.json";

const Container = Schema.fromJsonString(
  Schema.Struct({
    State: Schema.Struct({ Running: Schema.Boolean }),
    NetworkSettings: Schema.Struct({
      Ports: Schema.Record(
        Schema.String,
        Schema.Array(
          Schema.Struct({
            HostIp: Schema.String,
            HostPort: Schema.String,
          }),
        ),
      ),
    }),
  }),
);

export const liveTraefikFixture = Effect.fnUntraced(function* (socket: string) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lando-traefik-certificates-"))),
    (root) =>
      Effect.promise(async () => {
        await rm(root, { recursive: true, force: true });
      }),
  );
  const paths = { platform: "linux" as const, globalAppRoot: root };
  const fs = yield* FileSystem.pipe(Effect.provide(BunFileSystem.layer));
  yield* fs.mkdir(dynamicConfigDir(paths));
  const api = makePodmanApiClient(socket, {
    providerId: "lando",
    remediation: "Check the explicit live test socket.",
    env: {},
  });
  const request = api.request;
  if (request === undefined) throw new TypeError("Missing container request API");
  yield* api.ping;
  const checked = (input: EngineHttpRequest, status: number) =>
    request(input).pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(status))));
  const image = `docker.io/library/${TRAEFIK_IMAGE}`;
  const present = yield* request({ method: "GET", path: `/images/${encodeURIComponent(image)}/json` });
  if (present.status === 404) {
    if (api.stream === undefined) throw new TypeError("Missing image pull API");
    yield* Stream.runDrain(
      api.stream({ method: "POST", path: `/images/create?fromImage=${encodeURIComponent(image)}` }),
    );
  } else expect(present.status).toBe(200);
  const name = `lando-traefik-certificates-${crypto.randomUUID()}`;
  yield* Effect.acquireRelease(
    checked(
      {
        method: "POST",
        path: `/containers/create?name=${name}`,
        body: {
          Image: image,
          Cmd: [...TRAEFIK_STATIC_FLAGS],
          ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
          HostConfig: {
            Binds: [`${dynamicConfigDir(paths)}:/etc/traefik/dynamic:ro`],
            PortBindings: {
              "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
              "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
            },
          },
        },
      },
      201,
    ),
    () =>
      checked({ method: "DELETE", path: `/containers/${name}?force=true&v=true` }, 204).pipe(Effect.orDie),
  );
  yield* checked({ method: "POST", path: `/containers/${name}/start` }, 204);
  const inspect = () =>
    checked({ method: "GET", path: `/containers/${name}/json` }, 200).pipe(
      Effect.flatMap((response) => Schema.decodeUnknownEffect(Container)(response.body)),
    );
  const running = yield* inspect();
  expect(running.State.Running).toBe(true);
  const hostPort = (port: string) => {
    const binding = running.NetworkSettings.Ports[`${port}/tcp`]?.[0];
    if (binding === undefined) throw new TypeError(`Missing live ${port} publication`);
    expect(binding.HostIp).toBe("127.0.0.1");
    return PortNumber.make(Number(binding.HostPort));
  };
  const httpPort = hostPort("80");
  const httpsPort = hostPort("443");
  const access = yield* PrivateFileAccessService;
  const stateStore = makePluginStateStore(
    makeStateStore({ privateFileAccess: access }),
    AbsolutePath.make(join(root, "state")),
    access,
  );
  const http = yield* HttpClient.HttpClient;
  const counts = { writes: 0, issues: 0, roots: 0, requests: 0 };
  const authority = { root: pem.rootA, pair: pem.current };
  const dependencies: TraefikProxyDependencies = {
    paths,
    stateStore,
    httpClient: HttpClient.mapRequest(http, (request) => {
      counts.requests++;
      return request;
    }),
    fileSystem: {
      ...fs,
      writeAtomic: (path, content) =>
        Effect.sync(() => {
          counts.writes++;
        }).pipe(Effect.andThen(fs.writeAtomic(path, content))),
      writeSecretAtomic: (path, content) =>
        Effect.sync(() => {
          counts.writes++;
        }).pipe(Effect.andThen(Effect.tryPromise(() => writeSecretAtomic(path, content)))),
    },
    certificateAuthority: {
      id: "fixture-ca",
      setup: () => Effect.die("Host CA setup is forbidden"),
      root: Effect.sync(() => {
        counts.roots++;
        return { certificate: authority.root, trusted: false };
      }),
      issueCert: () =>
        Effect.sync(() => {
          counts.issues++;
          return {
            certificate: authority.pair.certificate,
            privateKey: Redacted.make(authority.pair.privateKey),
            root: { certificate: authority.root, trusted: false },
          };
        }),
    },
    globalApp: {
      ensureRunning: () =>
        inspect().pipe(
          Effect.map((container) => {
            expect(container.State.Running).toBe(true);
            return [{ name: "traefik", state: "running" as const }];
          }),
        ),
      ownedPublishPorts: (_service, ports) =>
        inspect().pipe(
          Effect.map((container) => {
            if (!container.State.Running) return [];
            const owned = Object.values(container.NetworkSettings.Ports)
              .flat()
              .filter((binding) => binding.HostIp === "127.0.0.1")
              .map((binding) => Number(binding.HostPort));
            return ports.filter((port) => owned.includes(port));
          }),
        ),
    },
  };
  return {
    counts,
    authority,
    httpsPort,
    makeService: () => makeTraefikRouterService(dependencies),
    config: { defaultDomain: "test.lndo.site", router: { httpPort, httpsPort, bindAddress: "127.0.0.1" } },
  };
});

export const liveTraefikLayers = Layer.mergeAll(
  PrivateFileAccessService.layer,
  LandoHttpClient.layerWith({ env: {} }),
);
