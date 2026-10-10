import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { makePluginStateStore as makePluginStateStoreWithAccess } from "@lando/engine/plugins/context-state";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionSpec,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import { makeStateStore as makeStateStoreUsing } from "@lando/state-store/service";

import { persistAppliedPlan } from "@lando/provider-lando";
import { inspectAppliedFileSync, verifiedFileSyncSessions } from "../src/applied-file-sync.ts";

import { ownerOnlyFileAccess } from "./private-file-access.ts";

const makePluginStateStore = (
  store: Parameters<typeof makePluginStateStoreWithAccess>[0],
  root: Parameters<typeof makePluginStateStoreWithAccess>[1],
) => makePluginStateStoreWithAccess(store, root, ownerOnlyFileAccess);
const makeStateStore = () => makeStateStoreUsing({ privateFileAccess: ownerOnlyFileAccess });

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "applied-file-sync.test",
  runtime: 4 as const,
};

const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const acceleratedPlan = (root: AbsolutePath, sessionRoot: AbsolutePath): AppPlan => {
  const id = AppId.make("applied-sync");
  const session: FileSyncSessionSpec = {
    app: { kind: "user", id, root: sessionRoot },
    service: web.name,
    mountKey: "app-mount",
    source: sessionRoot,
    target: {
      _tag: "volume",
      name: fileSyncVolumeName("applied-sync", web.name, "app-mount"),
      path: PortablePath.make("/app"),
    },
    mode: "two-way-safe",
    excludes: [],
  };
  return {
    id,
    name: "applied-sync",
    slug: "applied-sync",
    root,
    provider: providerId,
    services: {
      [web.name]: {
        ...web,
        appMount: {
          source: sessionRoot,
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "accelerated",
          excludes: [],
          includes: [],
        },
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [{ engineId: "mutagen", session }],
    metadata,
    extensions: {},
  };
};

describe("verifiedFileSyncSessions", () => {
  test("accepts a session recorded under a realpath-equivalent legacy root", async () => {
    const canonical = AbsolutePath.make(await realpath(await mkdtemp(join(tmpdir(), "lando-applied-sync-"))));
    const legacy = AbsolutePath.make(`${canonical}-short`);
    await symlink(canonical, legacy);
    try {
      const prior = acceleratedPlan(canonical, legacy);
      const sessions = verifiedFileSyncSessions(prior);
      expect(sessions).toEqual(prior.fileSync.map(({ session }) => session));
    } finally {
      await rm(legacy, { force: true });
      await rm(canonical, { recursive: true, force: true });
    }
  });

  test("inspects a persisted legacy applied plan as accelerated, not unknown", async () => {
    const canonical = AbsolutePath.make(await realpath(await mkdtemp(join(tmpdir(), "lando-applied-sync-"))));
    const legacy = AbsolutePath.make(`${canonical}-short`);
    await symlink(canonical, legacy);
    const stateDir = await mkdtemp(join(tmpdir(), "lando-applied-sync-state-"));
    const prior = acceleratedPlan(canonical, legacy);
    const current = acceleratedPlan(canonical, canonical);
    try {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      await Effect.runPromise(persistAppliedPlan(state, prior));
      const emptyApi = {
        request: () => Effect.succeed({ status: 200, body: JSON.stringify({ Volumes: [] }) }),
      };
      expect(await Effect.runPromise(inspectAppliedFileSync(state, emptyApi, current))).toEqual({
        status: "accelerated",
        engineId: "mutagen",
        sessions: prior.fileSync.map(({ session }) => session),
      });
    } finally {
      await rm(legacy, { force: true });
      await rm(canonical, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
