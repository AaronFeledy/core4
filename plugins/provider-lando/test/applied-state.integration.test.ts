import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { makePluginStateStore as makePluginStateStoreWithAccess } from "@lando/engine/plugins/context-state";
import { ownerOnlyFileAccess } from "./private-file-access.ts";
const makePluginStateStore = (
  store: Parameters<typeof makePluginStateStoreWithAccess>[0],
  root: Parameters<typeof makePluginStateStoreWithAccess>[1],
) => makePluginStateStoreWithAccess(store, root, ownerOnlyFileAccess);
import {
  appliedPlanPath,
  listAppliedPlans,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeStateStore as makeStateStoreUsing } from "@lando/state-store/service";
const makeStateStore = () => makeStateStoreUsing({ privateFileAccess: ownerOnlyFileAccess });
import { inspectAppliedFileSync } from "../src/applied-file-sync.ts";
import { inspectAppliedPlan } from "../src/applied-state.ts";

const providerId = ProviderId.make("lando");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "applied-state.integration.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "web" ? ["node", "server.js"] : ["postgres"],
  environment: {},
  mounts: [],
  storage:
    name === "database"
      ? [
          {
            store: "applied_state_db",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
  endpoints:
    name === "web"
      ? [
          {
            _tag: "published",
            port: 3000,
            protocol: "http",
            name: "http",
            publication: { bindAddress: "127.0.0.1", hostPort: 3000 },
          },
        ]
      : [{ _tag: "internal", port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn:
    name === "web"
      ? [{ service: ServiceName.make("database"), condition: "service_started", required: true }]
      : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const database = servicePlan("database");
const plan: AppPlan = {
  id: AppId.make("applied-state"),
  name: "applied-state",
  slug: "applied-state",
  root: AbsolutePath.make("/tmp/lando-applied-state-app"),
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [],
  stores: [{ name: "applied_state_db", scope: "app", kind: "data" }],
  fileSync: [],
  metadata,
  extensions: {},
};

const proxyUrl = "http://proxy-user:proxy-password@proxy.internal:8443";
const proxyPlan: AppPlan = {
  ...plan,
  services: {
    ...plan.services,
    [web.name]: {
      ...web,
      environment: { HTTPS_PROXY: proxyUrl },
    },
  },
};

const withStateDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-applied-state-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("provider-lando applied state persistence", () => {
  test("appliedPlanPath places each app in the applied-plans namespace", () => {
    expect(appliedPlanPath("/tmp/plugin-state/", plan.id)).toBe(
      "/tmp/plugin-state/applied-plans/applied-state.json",
    );
    expect(appliedPlanPath("/tmp/plugin-state", plan.id)).toBe(
      "/tmp/plugin-state/applied-plans/applied-state.json",
    );
  });

  test("credential-bearing proxy env round-trips across plugin state instances", async () => {
    await withStateDir(async (stateDir) => {
      const stateA = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const stateB = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));

      const written = await Effect.runPromise(persistAppliedPlan(stateA, proxyPlan));
      expect(written).toBe(appliedPlanPath(stateDir, proxyPlan.id));

      const raw = JSON.parse(await readFile(written, "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.data).toBeDefined();

      const loaded = await Effect.runPromise(loadAppliedPlan(stateB, proxyPlan.id));
      expect(loaded?.services[web.name]?.environment.HTTPS_PROXY).toBe(proxyUrl);
    });
  });

  test("persistAppliedPlan replaces broader permissions with owner-only mode on POSIX", async () => {
    if (process.platform === "win32") return;

    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const path = appliedPlanPath(stateDir, plan.id);
      await Effect.runPromise(persistAppliedPlan(state, plan));
      await chmod(path, 0o644);

      await Effect.runPromise(persistAppliedPlan(state, proxyPlan));

      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  test("strict inspection separates missing, readable, and damaged applied receipts", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      expect(await Effect.runPromise(inspectAppliedPlan(state, plan.id))).toEqual({ status: "missing" });
      await Effect.runPromise(persistAppliedPlan(state, plan));
      expect(await Effect.runPromise(inspectAppliedPlan(state, plan.id))).toMatchObject({
        status: "readable",
        plan: { id: plan.id },
      });
      const path = appliedPlanPath(stateDir, plan.id);
      await writeFile(path, "not valid json");
      expect(await Effect.runPromise(inspectAppliedPlan(state, plan.id))).toEqual({ status: "unreadable" });
      await writeFile(path, JSON.stringify({ version: 99, data: {} }));
      expect(await Effect.runPromise(inspectAppliedPlan(state, plan.id))).toEqual({ status: "unreadable" });
      expect(await Effect.runPromise(inspectAppliedPlan(state, plan.id))).toEqual({ status: "unreadable" });
    });
  });
  test("file-sync fallback inspection checks applied state and owned Podman volumes", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const volumes = (entries: ReadonlyArray<unknown>) => ({
        request: () => Effect.succeed({ status: 200, body: JSON.stringify({ Volumes: entries }) }),
      });
      const emptyApi = volumes([]);
      expect(await Effect.runPromise(inspectAppliedFileSync(state, emptyApi, plan))).toEqual({
        status: "missing",
      });
      expect(
        await Effect.runPromise(
          inspectAppliedFileSync(state, volumes([{ Name: "applied-state-database-data", Labels: {} }]), plan),
        ),
      ).toEqual({ status: "missing" });
      expect(
        await Effect.runPromise(
          inspectAppliedFileSync(state, volumes([{ Name: "applied-state-old-app-mount", Labels: {} }]), plan),
        ),
      ).toEqual({ status: "unknown" });
      const ownedVolume = {
        Name: "applied-state-web-app-mount",
        Labels: {
          "dev.lando.app": String(plan.id),
          "dev.lando.sync.kind": "volume",
        },
      };
      expect(await Effect.runPromise(inspectAppliedFileSync(state, volumes([ownedVolume]), plan))).toEqual({
        status: "unknown",
      });
      await Effect.runPromise(persistAppliedPlan(state, plan));
      expect(await Effect.runPromise(inspectAppliedFileSync(state, emptyApi, plan))).toEqual({
        status: "ordinary",
      });
      expect(await Effect.runPromise(inspectAppliedFileSync(state, volumes([ownedVolume]), plan))).toEqual({
        status: "unknown",
      });
      const expectedNameWithoutOwner = { Name: "applied-state-web-app-mount", Labels: {} };
      expect(
        await Effect.runPromise(inspectAppliedFileSync(state, volumes([expectedNameWithoutOwner]), plan)),
      ).toEqual({ status: "unknown" });
      await writeFile(appliedPlanPath(stateDir, plan.id), "not valid json");
      expect(await Effect.runPromise(inspectAppliedFileSync(state, emptyApi, plan))).toEqual({
        status: "unknown",
      });
    });
  });
  test("file-sync inspection fails closed on foreign names, API errors, and malformed responses", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const planned: AppPlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: {
            ...web,
            appMount: {
              source: plan.root,
              target: PortablePath.make("/app"),
              readOnly: false,
              realization: "accelerated",
              excludes: [],
              includes: [],
            },
          },
        },
        fileSync: [
          {
            engineId: "mutagen",
            session: {
              app: { kind: "user", id: plan.id, root: plan.root },
              service: web.name,
              mountKey: "app-mount",
              source: plan.root,
              target: {
                _tag: "volume",
                name: "applied-state-web-app-mount",
                path: PortablePath.make("/app"),
              },
              mode: "two-way-safe",
              excludes: [],
            },
          },
        ],
      };
      const foreign = { Name: "applied-state-web-app-mount", Labels: { "dev.lando.app": "other" } };
      const foreignApi = {
        request: () => Effect.succeed({ status: 200, body: JSON.stringify({ Volumes: [foreign] }) }),
      };
      expect(await Effect.runPromise(inspectAppliedFileSync(state, foreignApi, planned))).toEqual({
        status: "unknown",
      });
      const failedApi = {
        request: () =>
          Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "listVolumes",
              message: "offline",
            }),
          ),
      };
      expect(await Effect.runPromise(inspectAppliedFileSync(state, failedApi, planned))).toEqual({
        status: "unknown",
      });
      const malformedApi = { request: () => Effect.succeed({ status: 200, body: "{}" }) };
      expect(await Effect.runPromise(inspectAppliedFileSync(state, malformedApi, planned))).toEqual({
        status: "unknown",
      });
      await Effect.runPromise(persistAppliedPlan(state, planned));
      const emptyApi = {
        request: () => Effect.succeed({ status: 200, body: JSON.stringify({ Volumes: [] }) }),
      };
      expect(await Effect.runPromise(inspectAppliedFileSync(state, emptyApi, plan))).toMatchObject({
        status: "accelerated",
        engineId: planned.fileSync[0]?.engineId,
        sessions: [planned.fileSync[0]?.session],
      });
      await Effect.runPromise(persistAppliedPlan(state, { ...planned, fileSync: [] }));
      expect(await Effect.runPromise(inspectAppliedFileSync(state, emptyApi, plan))).toEqual({
        status: "unknown",
      });
    });
  });
  test("loadAppliedPlan returns undefined when the file is missing", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const loaded = await Effect.runPromise(loadAppliedPlan(state, AppId.make("missing-app")));
      expect(loaded).toBeUndefined();
    });
  });

  test("loadAppliedPlan returns undefined when the version header does not match", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const path = appliedPlanPath(stateDir, plan.id);
      await Effect.runPromise(persistAppliedPlan(state, plan));
      const original = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...original, version: 99 }));

      const loaded = await Effect.runPromise(loadAppliedPlan(state, plan.id));
      expect(loaded).toBeUndefined();
    });
  });

  test("loadAppliedPlan returns undefined when the file contents are corrupt", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const path = appliedPlanPath(stateDir, plan.id);
      await Effect.runPromise(persistAppliedPlan(state, plan));
      await writeFile(path, "not valid json");

      const loaded = await Effect.runPromise(loadAppliedPlan(state, plan.id));
      expect(loaded).toBeUndefined();
    });
  });

  test("removeAppliedPlan deletes the file and is a no-op when already missing", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      await Effect.runPromise(persistAppliedPlan(state, plan));
      await Effect.runPromise(removeAppliedPlan(state, plan.id));
      expect(await Effect.runPromise(loadAppliedPlan(state, plan.id))).toBeUndefined();

      await Effect.runPromise(removeAppliedPlan(state, plan.id));
    });
  });

  test("listAppliedPlans returns empty when the namespace directory is missing", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      expect(await Effect.runPromise(listAppliedPlans(state, stateDir))).toEqual([]);
    });
  });

  test("listAppliedPlans fails when the applied-state namespace cannot be read", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      await writeFile(join(stateDir, "applied-plans"), "not a directory");

      const result = await Effect.runPromiseExit(listAppliedPlans(state, stateDir));

      expect(result._tag).toBe("Failure");
      expect(String(result)).toContain("ProviderUnavailableError");
    });
  });

  test("listAppliedPlans enumerates persisted plans including the global app", async () => {
    await withStateDir(async (stateDir) => {
      const state = makePluginStateStore(makeStateStore(), AbsolutePath.make(stateDir));
      const globalPlan: AppPlan = { ...plan, id: AppId.make("global"), name: "global", slug: "global" };
      await Effect.runPromise(persistAppliedPlan(state, plan));
      await Effect.runPromise(persistAppliedPlan(state, globalPlan));

      const listed = await Effect.runPromise(listAppliedPlans(state, stateDir));
      const ids = listed.map((item) => String(item.id)).sort();
      expect(ids).toEqual(["applied-state", "global"]);
    });
  });
});
