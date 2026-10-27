import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect, Exit } from "effect";
import { makePreparedWindowsMutagenAppClient } from "../src/windows-app-client.ts";

const root = AbsolutePath.make("C:\\workspace\\app");
const app = { kind: "user", id: AppId.make("windows-mounts"), root } as const;
const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "windows-app-client", runtime: 4 } as const;
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  mounts: [
    {
      type: "bind",
      source: "C:\\config",
      target: PortablePath.make("/config"),
      readOnly: true,
      realization: "passthrough",
    },
    {
      type: "bind",
      source: root,
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "mount-deadbeef",
    },
  ],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const session = {
  app,
  service: service.name,
  mountKey: "mount-deadbeef",
  source: root,
  target: { _tag: "volume", name: "windows-mounts-web-mount-deadbeef", path: PortablePath.make("/app") },
  mode: "two-way-safe",
  excludes: [".git"],
} as const;
const plan: AppPlan = {
  id: app.id,
  name: "windows-mounts",
  slug: "windows-mounts",
  root,
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [{ engineId: "mutagen", session }],
  metadata,
  extensions: {},
};
const endpoint = {
  containerId: "verified-helper",
  volumeName: session.target.name,
  path: "/sync",
  permissions: { owner: "1000", group: "1000", defaultFileMode: "0644", defaultDirectoryMode: "0755" },
};

const options = {
  plan,
  preparedTargets: { targets: [{ session, endpoint }] },
  binDir: "C:\\lando\\bin",
  dataDir: "C:\\lando\\mutagen",
  hostPlatform: "win32",
  prepareDockerCli: () => Effect.succeed("C:\\lando\\docker.exe"),
  runner: { run: () => Effect.die("No subprocess should run while binding targets") },
  stateStore: {
    open: () => Effect.die("No bucket should open while binding targets"),
    withLock: <A, E, R>(_key: string, body: Effect.Effect<A, E, R>) => body,
  },
};

test("binds a complete Windows target set using the accelerated bind identity, not its list index", async () => {
  const result = await Effect.runPromise(makePreparedWindowsMutagenAppClient(options));
  expect(typeof result.create).toBe("function");
});

test("rejects an accelerated bind without mountKey before preparing the Docker CLI", async () => {
  let prepared = false;
  const missingKey: ServicePlan = {
    ...service,
    mounts: service.mounts.map((mount) => {
      if (mount.type !== "bind") return mount;
      const { mountKey: _key, ...withoutKey } = mount;
      return withoutKey;
    }),
  };
  const result = await Effect.runPromiseExit(
    makePreparedWindowsMutagenAppClient({
      ...options,
      plan: { ...plan, services: { [service.name]: missingKey } },
      prepareDockerCli: () =>
        Effect.sync(() => {
          prepared = true;
          return "C:\\lando\\docker.exe";
        }),
    }),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(prepared).toBe(false);
});

test("retains the prepared endpoint permission checks", async () => {
  const result = await Effect.runPromiseExit(
    makePreparedWindowsMutagenAppClient({
      ...options,
      preparedTargets: {
        targets: [
          {
            session,
            endpoint: { ...endpoint, permissions: { ...endpoint.permissions, owner: "not-a-uid" } },
          },
        ],
      },
    }),
  );
  expect(Exit.isFailure(result)).toBe(true);
});
