import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";
import { makePluginStateStore } from "../../../core/src/plugins/context-state.ts";
import {
  listAppliedPlans,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "../src/applied-state.ts";

const providerId = ProviderId.make("podman");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-29T00:00:00Z"),
  source: "provider-podman applied-state test",
  runtime: 4 as const,
};
const proxyUrl = "http://proxy-user:proxy-password@proxy.internal:8443";

const planFor = (id: string, proxy?: string): AppPlan => {
  const appId = AppId.make(id);
  return {
    id: appId,
    name: id,
    slug: id,
    root: AbsolutePath.make(`/tmp/${id}`),
    provider: providerId,
    services: {
      [serviceName]: {
        name: serviceName,
        type: "node",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref", ref: "node:22-alpine" },
        command: ["node", "server.js"],
        environment: proxy === undefined ? {} : { HTTPS_PROXY: proxy },
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const withStateRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-provider-podman-applied-state-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const stateFor = (root: string) => makePluginStateStore(makeStateStore(), AbsolutePath.make(root));

describe("provider-podman applied state", () => {
  test("credential-bearing proxy env round-trips across fresh stores", async () => {
    await withStateRoot(async (root) => {
      const plan = planFor("proxy-app", proxyUrl);

      const path = await Effect.runPromise(persistAppliedPlan(stateFor(root), plan));
      const loaded = await Effect.runPromise(loadAppliedPlan(stateFor(root), plan.id));

      expect(path).toBe(join(root, "applied-plans.json"));
      expect(loaded?.services[serviceName]?.environment.HTTPS_PROXY).toBe(proxyUrl);
    });
  });

  test("replacement corrects broader permissions to owner-only mode on POSIX", async () => {
    if (process.platform === "win32") return;

    await withStateRoot(async (root) => {
      const state = stateFor(root);
      const plan = planFor("mode-app");
      const path = await Effect.runPromise(persistAppliedPlan(state, plan));
      await chmod(path, 0o644);

      await Effect.runPromise(persistAppliedPlan(state, planFor("mode-app", proxyUrl)));

      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  test("one collection preserves multiple apps and removes only the selected app", async () => {
    await withStateRoot(async (root) => {
      const state = stateFor(root);
      const first = planFor("first-app");
      const second = planFor("second-app");
      await Effect.runPromise(persistAppliedPlan(state, first));
      await Effect.runPromise(persistAppliedPlan(state, second));

      await Effect.runPromise(removeAppliedPlan(state, first.id));

      const plans = await Effect.runPromise(listAppliedPlans(state));
      expect(plans.map((plan) => plan.id)).toEqual([second.id]);
      expect(await Effect.runPromise(loadAppliedPlan(state, first.id))).toBeUndefined();
    });
  });

  test("corrupt collection contents behave as a cache miss", async () => {
    await withStateRoot(async (root) => {
      const state = stateFor(root);
      const plan = planFor("corrupt-app");
      const path = await Effect.runPromise(persistAppliedPlan(state, plan));
      await writeFile(path, "not valid json");

      const loaded = await Effect.runPromise(loadAppliedPlan(state, plan.id));

      expect(loaded).toBeUndefined();
      expect(await Effect.runPromise(listAppliedPlans(state))).toEqual([]);
    });
  });

  test("unknown collection versions behave as a cache miss", async () => {
    await withStateRoot(async (root) => {
      const state = stateFor(root);
      const plan = planFor("version-app");
      const path = await Effect.runPromise(persistAppliedPlan(state, plan));
      const envelope = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...envelope, version: 99 }));

      const loaded = await Effect.runPromise(loadAppliedPlan(state, plan.id));

      expect(loaded).toBeUndefined();
      expect(await Effect.runPromise(listAppliedPlans(state))).toEqual([]);
    });
  });
});
