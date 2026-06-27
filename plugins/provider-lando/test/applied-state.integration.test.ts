import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

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
      ? [{ port: 3000, protocol: "http", name: "http" }]
      : [{ port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "web" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
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

const withStateDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-applied-state-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("provider-lando applied state persistence", () => {
  test("appliedPlanPath places per-app plan under provider-lando/apps/<appId>.json", () => {
    expect(appliedPlanPath("/tmp/state-dir/", plan.id)).toBe(
      "/tmp/state-dir/provider-lando/apps/applied-state.json",
    );
    expect(appliedPlanPath("/tmp/state-dir", plan.id)).toBe(
      "/tmp/state-dir/provider-lando/apps/applied-state.json",
    );
  });

  test("persistAppliedPlan writes a versioned envelope and loadAppliedPlan round-trips", async () => {
    await withStateDir(async (stateDir) => {
      const written = await Effect.runPromise(persistAppliedPlan(stateDir, plan));
      expect(written).toBe(appliedPlanPath(stateDir, plan.id));

      const raw = JSON.parse(await readFile(written, "utf8"));
      expect(raw).toMatchObject({ version: 1, providerId: "lando" });
      expect(raw.plan).toBeDefined();

      const loaded = await Effect.runPromise(loadAppliedPlan(stateDir, plan.id));
      expect(loaded).not.toBeUndefined();
      expect(loaded?.id).toBe(plan.id);
      expect(loaded?.slug).toBe(plan.slug);
      expect(Object.keys(loaded?.services ?? {}).sort()).toEqual(["database", "web"]);
      expect(loaded?.stores).toEqual([{ name: "applied_state_db", scope: "app", kind: "data" }]);
    });
  });

  test("loadAppliedPlan returns undefined when the file is missing", async () => {
    await withStateDir(async (stateDir) => {
      const loaded = await Effect.runPromise(loadAppliedPlan(stateDir, AppId.make("missing-app")));
      expect(loaded).toBeUndefined();
    });
  });

  test("loadAppliedPlan returns undefined when the version header does not match", async () => {
    await withStateDir(async (stateDir) => {
      const path = appliedPlanPath(stateDir, plan.id);
      await Effect.runPromise(persistAppliedPlan(stateDir, plan));
      const original = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...original, version: 99 }));

      const loaded = await Effect.runPromise(loadAppliedPlan(stateDir, plan.id));
      expect(loaded).toBeUndefined();
    });
  });

  test("loadAppliedPlan returns undefined when the file contents are corrupt", async () => {
    await withStateDir(async (stateDir) => {
      const path = appliedPlanPath(stateDir, plan.id);
      await Effect.runPromise(persistAppliedPlan(stateDir, plan));
      await writeFile(path, "not valid json");

      const loaded = await Effect.runPromise(loadAppliedPlan(stateDir, plan.id));
      expect(loaded).toBeUndefined();
    });
  });

  test("removeAppliedPlan deletes the file and is a no-op when already missing", async () => {
    await withStateDir(async (stateDir) => {
      await Effect.runPromise(persistAppliedPlan(stateDir, plan));
      await Effect.runPromise(removeAppliedPlan(stateDir, plan.id));
      expect(await Effect.runPromise(loadAppliedPlan(stateDir, plan.id))).toBeUndefined();

      await Effect.runPromise(removeAppliedPlan(stateDir, plan.id));
    });
  });
});
