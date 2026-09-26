import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { AppliedOrphanGroup } from "@lando/sdk/services";
import {
  AppPlanner,
  EventService,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";

import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { sshAgentSessionPaths } from "../../src/subsystems/ssh-agent/session.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("orphan-relay");

const withTempRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-orphan-relay-")));
  await Bun.write(join(root, ".lando.yml"), "name: orphan-relay\n");
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const orphanGroup = (root: string): AppliedOrphanGroup => ({
  providerId,
  appId,
  services: [
    {
      app: appId,
      appRoot: AbsolutePath.make(root),
      service: ServiceName.make("web"),
      providerId,
      status: "running",
      containerId: "container-web",
    },
  ],
  volumes: [],
});

const layerFor = (root: string) => {
  const paths = makeLandoPaths({
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
    userConfRoot: join(root, "conf"),
    platform: "linux",
    env: {},
  });
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    removeObservedService: () => Effect.succeed({ kind: "removed" as const }),
    removeVolume: () => Effect.void,
  };
  return {
    paths,
    layer: Layer.mergeAll(
      PrivateFileAccessLive,
      Layer.succeed(StateStore, makeTestStateStore().service),
      Layer.succeed(PathsService, paths),
      Layer.succeed(LandofileService, {
        discover: Effect.die("desired config must not load during orphan teardown"),
      }),
      Layer.succeed(AppPlanner, { plan: () => Effect.die("desired planning must not run") }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(provider),
        resolveAppliedPlan: () => Effect.succeed<AppPlan | undefined>(undefined),
        resolveTeardownEvidence: () =>
          Effect.succeed({ kind: "orphans" as const, groups: [orphanGroup(root)] }),
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
  };
};

const markerPaths = (root: string) => {
  const { paths } = layerFor(root);
  const app = { id: appId, root: AbsolutePath.make(root) };
  const roots = { ...paths.roots, platform: paths.platform };
  return {
    ssh: join(sshAgentSessionPaths(app, roots, "ssh").stateDir, "marker"),
    gpg: join(sshAgentSessionPaths(app, roots, "gpg").stateDir, "marker"),
  };
};

const writeMarkers = async (root: string): Promise<void> => {
  const markers = markerPaths(root);
  await mkdir(join(markers.ssh, ".."), { recursive: true });
  await mkdir(join(markers.gpg, ".."), { recursive: true });
  await writeFile(markers.ssh, "ssh-relay");
  await writeFile(markers.gpg, "gpg-relay");
};

test("orphan stop removes ssh and gpg agent relay state", async () => {
  await withTempRoot(async (root) => {
    // Given
    const harness = layerFor(root);
    await writeMarkers(root);
    const markers = markerPaths(root);

    // When
    await Effect.runPromise(withResolvedCwd(root, stopApp()).pipe(Effect.provide(harness.layer)));

    // Then
    expect(await Bun.file(markers.ssh).exists()).toBe(false);
    expect(await Bun.file(markers.gpg).exists()).toBe(false);
  });
});

test("orphan destroy removes ssh and gpg agent relay state", async () => {
  await withTempRoot(async (root) => {
    // Given
    const harness = layerFor(root);
    await writeMarkers(root);
    const markers = markerPaths(root);

    // When
    await Effect.runPromise(withResolvedCwd(root, destroyApp()).pipe(Effect.provide(harness.layer)));

    // Then
    expect(await Bun.file(markers.ssh).exists()).toBe(false);
    expect(await Bun.file(markers.gpg).exists()).toBe(false);
  });
});
