import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import {
  appliedPlanPath,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";

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
});
