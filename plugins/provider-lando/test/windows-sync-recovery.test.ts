import { describe, expect, test } from "bun:test";
import type { EngineHttpRequest, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
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
import { quiesceRetainedWindowsSyncWriters } from "../src/windows-sync-recovery.ts";

const root = AbsolutePath.make("C:\\Users\\me\\demo");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "recovery.test.ts",
  runtime: 4 as const,
};
const service = (name: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  appMount: {
    source: root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    excludes: [],
    includes: [],
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});
const plan = (): AppPlan => ({
  id: AppId.make("demo-id"),
  name: "demo",
  slug: "demo",
  root,
  provider: ProviderId.make("lando"),
  services: { [ServiceName.make("web")]: service("web") },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
  fileSync: [
    {
      engineId: "mutagen",
      session: {
        app: { kind: "user", id: AppId.make("demo-id"), root },
        service: ServiceName.make("web"),
        mountKey: "app-mount",
        source: root,
        target: { _tag: "volume", name: "demo-web-app-mount", path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [],
      },
    },
  ],
});
type Container = {
  Id: string;
  Config: { Labels: Record<string, string> | null };
  Mounts: { Type: string; Name?: string }[];
};
const volume = "demo-web-app-mount";
const helper: Container = {
  Id: "helper-id",
  Config: { Labels: null },
  Mounts: [{ Type: "volume", Name: volume }],
};
const writer = (id = "writer-id"): Container => ({
  Id: id,
  Config: { Labels: { [APP_LABEL]: "demo-id", [APP_ROOT_LABEL]: root, [SERVICE_LABEL]: "web" } },
  Mounts: [{ Type: "volume", Name: volume }],
});
const targets = [{ containerId: helper.Id, volumeName: volume }];

const fake = (initial: Container[]) => {
  const containers = new Map(initial.map((entry) => [entry.Id, structuredClone(entry)]));
  const calls: EngineHttpRequest[] = [];
  const controls: {
    failDelete?: string;
    failInspect?: string;
    afterDelete?: () => void;
    malformedList?: boolean;
  } = {};
  const response = (status: number, body: unknown = {}): EngineHttpResponse => ({
    status,
    body: JSON.stringify(body),
  });
  const api = {
    request: (input: EngineHttpRequest) =>
      Effect.sync(() => {
        calls.push(input);
        if (input.method === "GET" && input.path === "/containers/json?all=true")
          return response(200, controls.malformedList ? {} : [...containers.keys()].map((Id) => ({ Id })));
        const match = /^\/containers\/([^/?]+)(.*)$/u.exec(input.path);
        const id = decodeURIComponent(match?.[1] ?? "");
        if (input.method === "GET") {
          if (controls.failInspect === id) return response(500);
          return containers.has(id) ? response(200, containers.get(id)) : response(404);
        }
        if (input.method === "POST") return response(containers.has(id) ? 204 : 404);
        if (input.method === "DELETE") {
          if (controls.failDelete === id) return response(500);
          containers.delete(id);
          controls.afterDelete?.();
          return response(204);
        }
        return response(500);
      }),
  };
  return {
    api,
    containers,
    calls,
    controls,
    mutations: () => calls.filter(({ method }) => method !== "GET"),
  };
};

describe("retained Windows sync writer quiescence", () => {
  test("removes exact app writer IDs and leaves helpers and unrelated containers intact", async () => {
    const unrelated = writer("unrelated-id");
    unrelated.Config.Labels = null;
    unrelated.Mounts = [];
    const runtime = fake([helper, writer(), unrelated]);
    await Effect.runPromise(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets));
    expect([...runtime.containers.keys()]).toEqual(["helper-id", "unrelated-id"]);
    expect(runtime.mutations().map(({ path }) => path)).toEqual([
      "/containers/writer-id/stop",
      "/containers/writer-id?force=true",
    ]);
  });

  for (const kind of ["foreign-root", "foreign-app", "unplanned-service", "unlabeled"] as const) {
    test(`rejects ${kind} volume users before removing any valid writer`, async () => {
      const foreign = writer("foreign-id");
      const labels = foreign.Config.Labels ?? {};
      foreign.Config.Labels = labels;
      if (kind === "foreign-root") labels[APP_ROOT_LABEL] = "C:\\other";
      if (kind === "foreign-app") labels[APP_LABEL] = "other";
      if (kind === "unplanned-service") labels[SERVICE_LABEL] = "unknown";
      if (kind === "unlabeled") foreign.Config.Labels = null;
      const runtime = fake([helper, writer(), foreign]);
      const result = await Effect.runPromiseExit(
        quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(runtime.mutations()).toEqual([]);
    });
  }

  test("partial preparation with an owned volume but no helper can quiesce its writers", async () => {
    const runtime = fake([writer()]);
    await Effect.runPromise(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), [{ volumeName: volume }]));
    expect(runtime.containers.size).toBe(0);
  });

  test("an absent target does not exempt a foreign user of its planned volume", async () => {
    const foreign = writer();
    foreign.Config.Labels = null;
    const runtime = fake([foreign]);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), []))),
    ).toBe(true);
    expect(runtime.mutations()).toEqual([]);
  });

  test("missing volume names fail closed before removing writers", async () => {
    const foreign = writer("foreign-id");
    foreign.Config.Labels = null;
    foreign.Mounts = [{ Type: "volume" }];
    const runtime = fake([helper, writer(), foreign]);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets)),
      ),
    ).toBe(true);
    expect(runtime.mutations()).toEqual([]);
  });

  test("a helper identity cannot exempt an unrelated volume mount", async () => {
    const changed = structuredClone(helper);
    changed.Mounts = [{ Type: "volume", Name: "other" }];
    const runtime = fake([changed, writer()]);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets)),
      ),
    ).toBe(true);
    expect(runtime.mutations()).toEqual([]);
  });

  test("malformed inventory and failed inspection stop before mutation", async () => {
    for (const mode of ["list", "inspect"]) {
      const runtime = fake([helper, writer()]);
      if (mode === "list") runtime.controls.malformedList = true;
      else runtime.controls.failInspect = "writer-id";
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets)),
        ),
      ).toBe(true);
      expect(runtime.mutations()).toEqual([]);
    }
  });

  test("failed exact deletion preserves helpers and can be retried", async () => {
    const runtime = fake([helper, writer()]);
    runtime.controls.failDelete = "writer-id";
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets)),
      ),
    ).toBe(true);
    expect(runtime.containers.has("helper-id")).toBe(true);
    runtime.controls.failDelete = "";
    await Effect.runPromise(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets));
    expect([...runtime.containers.keys()]).toEqual(["helper-id"]);
  });

  test("a replacement writer after removal fails closed without deleting the replacement", async () => {
    const runtime = fake([helper, writer()]);
    runtime.controls.afterDelete = () => {
      runtime.containers.set("replacement-id", writer("replacement-id"));
    };
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), targets)),
      ),
    ).toBe(true);
    expect(runtime.containers.has("replacement-id")).toBe(true);
    expect(runtime.mutations().some(({ path }) => path.includes("replacement-id"))).toBe(false);
  });

  test("rejects incomplete plans and ambiguous target identities without API calls", async () => {
    const runtime = fake([helper, writer()]);
    for (const supplied of [targets.concat(targets), [{ volumeName: "foreign" }]]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(quiesceRetainedWindowsSyncWriters(runtime.api, plan(), supplied)),
        ),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          quiesceRetainedWindowsSyncWriters(runtime.api, { ...plan(), fileSync: [] }, targets),
        ),
      ),
    ).toBe(true);
    expect(runtime.calls).toEqual([]);
  });
});
