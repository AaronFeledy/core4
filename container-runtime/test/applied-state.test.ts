import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import {
  APPLIED_STATE_VERSION,
  appliedPlanPath,
  appliedPlansDir,
  makeAppliedPlanStore,
  migrateAppliedPlan,
  migrateAppliedPlansRecord,
} from "@lando/container-runtime/applied-state";
import type { StateStoreError } from "@lando/sdk/errors";
import type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, AppPlan, MountPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { legacyPlan, service } from "./fixtures/environment-values.ts";

interface OpenCall {
  readonly key: string;
  readonly namespace?: string;
  readonly version: number;
  readonly codec: "json" | "binary" | object | undefined;
  readonly mode: number | undefined;
  readonly lock: "none" | "advisory" | undefined;
  readonly onCorrupt: "discard" | "quarantine" | "fail" | undefined;
  readonly onVersionMismatch: unknown;
  readonly hasDefault: boolean;
}

const recordingStateStore = (calls: OpenCall[]): PluginStateStore => ({
  open: (spec) => {
    calls.push({
      key: spec.key,
      ...(spec.namespace === undefined ? {} : { namespace: spec.namespace }),
      version: spec.version,
      codec: spec.codec,
      mode: spec.mode,
      lock: spec.lock,
      onCorrupt: spec.onCorrupt,
      onVersionMismatch: spec.onVersionMismatch,
      hasDefault: spec.default !== undefined,
    });
    return Effect.die("recorded open");
  },
  withLock: (_key, body) => body,
});

const currentService = {
  name: ServiceName.make("web"),
  type: "web",
  provider: ProviderId.make("docker"),
  primary: true,
  artifact: { kind: "ref" as const, ref: "nginx:1.27-alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-10-23T00:00:00Z"),
    source: "test",
    runtime: 4 as const,
  },
  extensions: {},
};

const v1ServiceBase = {
  name: "web",
  type: "web",
  provider: "docker",
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
  environment: {},
  mounts: [] as unknown[],
  storage: [] as unknown[],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: "2026-10-23T00:00:00.000Z",
    source: "test",
    runtime: 4,
  },
  extensions: {},
};

const v1PlanBase = {
  id: "values",
  name: "values",
  slug: "values",
  root: "/tmp/lando-values",
  provider: "docker",
  services: { web: v1ServiceBase },
  networks: [],
  routes: [],
  stores: [],
  fileSync: [],
  metadata: v1ServiceBase.metadata,
  extensions: {},
};

describe("applied plan state layouts", () => {
  test.each(["per-app", "record"] as const)(
    "%s layout reads historical identity without inventing execution authority",
    async (layout) => {
      // Given a current-shape plan with secret markers only on the wire
      const current = {
        ...legacyPlan(),
        services: {
          [service.name]: {
            ...currentService,
            name: service.name,
            environment: { TOKEN: "${secret:TOKEN}" },
          },
        },
      };
      const encoded = {
        ...Schema.encodeSync(AppPlan)(current),
        networks: [{ name: "lando-values", shared: false, driver: "bridge" }],
        services: {
          [service.name]: {
            ...Schema.encodeSync(AppPlan)(current).services[service.name],
            environmentSecrets: { TOKEN: "DRAFT" },
          },
        },
      };
      const raw = JSON.parse(JSON.stringify(layout === "per-app" ? encoded : { [current.id]: encoded }));
      const state: PluginStateStore = {
        open: (spec) =>
          Effect.succeed({
            path: AbsolutePath.make("/tmp/lando-values/applied.json"),
            get: Schema.decodeUnknownEffect(spec.schema)(raw).pipe(Effect.orDie),
            exists: Effect.succeed(true),
            set: () => Effect.die("read-only fixture"),
            update: () => Effect.die("read-only fixture"),
            modify: () => Effect.die("read-only fixture"),
            remove: Effect.die("read-only fixture"),
          }),
        withLock: (_key, body) => body,
      };
      const store =
        layout === "per-app"
          ? makeAppliedPlanStore({ providerId: "docker", layout })
          : makeAppliedPlanStore({ providerId: "podman", layout });
      // When
      const observed = await Effect.runPromise(store.loadAppliedPlan(state, current.id));
      // Then
      expect(observed?.id).toBe(current.id);
      expect(observed?.root).toBe(current.root);
      expect(observed?.services[service.name]?.environment).toEqual({ TOKEN: "${secret:TOKEN}" });
      expect(observed).not.toHaveProperty("valueModel");
      expect(observed).not.toHaveProperty("networks");
      expect(observed?.services[service.name]).not.toHaveProperty("environmentSecrets");
    },
  );

  test("per-app layout preserves the namespaced file format at version 2", async () => {
    const calls: OpenCall[] = [];
    const store = makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });
    const appId = AppId.make("example");

    await Effect.runPromiseExit(store.loadAppliedPlan(recordingStateStore(calls), appId));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: "example.json",
      namespace: "applied-plans",
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "discard",
      hasDefault: false,
    });
    expect(calls[0]?.version).toBe(2);
    expect(typeof calls[0]?.onVersionMismatch).toBe("function");
    expect(appliedPlansDir("/tmp/plugin-state/")).toBe("/tmp/plugin-state/applied-plans");
    expect(appliedPlanPath("/tmp/plugin-state", appId)).toBe("/tmp/plugin-state/applied-plans/example.json");
  });

  test("record layout preserves the single-file collection format at version 2", async () => {
    const calls: OpenCall[] = [];
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    await Effect.runPromiseExit(store.listAppliedPlans(recordingStateStore(calls)));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: "applied-plans.json",
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "discard",
      hasDefault: true,
    });
    expect(calls[0]?.version).toBe(2);
    expect(typeof calls[0]?.onVersionMismatch).toBe("function");
  });
});

describe("applied plan v1 -> v2 mount migration", () => {
  test("converts appMount, storage, and tmpfs into one ordered mounts list", () => {
    const raw = {
      ...v1PlanBase,
      services: {
        web: {
          ...v1ServiceBase,
          appMount: {
            source: "/tmp/lando-values",
            target: "/app",
            readOnly: false,
            realization: "accelerated",
            excludes: ["node_modules", "vendor"],
            includes: ["vendor/acme"],
          },
          mounts: [
            { type: "tmpfs", target: "/scratch", readOnly: false },
            {
              type: "bind",
              source: "/host/cache",
              target: "/cache",
              readOnly: true,
              realization: "passthrough",
              createHostPath: true,
              excludes: ["generated"],
              includes: ["generated/source"],
            },
            { type: "volume", source: "raw_vol", target: "/data/raw", readOnly: false },
          ],
          storage: [
            {
              store: "db_data",
              target: "/var/lib/db",
              readOnly: false,
              subpath: "pg",
            },
          ],
        },
      },
      stores: [
        { name: "db_data", scope: "app", kind: "data" },
        { name: "raw_vol", scope: "service", kind: "data" },
      ],
    };

    const migrated = migrateAppliedPlan(raw, 1);
    expect(migrated).not.toBeNull();
    const mounts = migrated?.services[ServiceName.make("web")]?.mounts ?? [];
    expect(mounts.map((mount) => String(mount.target))).toEqual([
      "/app",
      "/cache",
      "/scratch",
      "/data/raw",
      "/var/lib/db",
    ]);
    expect(mounts[0]).toMatchObject({
      type: "bind",
      role: "app",
      realization: "accelerated",
      mountKey: "app-mount",
      excludes: ["node_modules", "vendor"],
      includes: ["vendor/acme"],
      source: "/tmp/lando-values",
      readOnly: false,
    });
    expect(mounts[1]).toMatchObject({
      type: "bind",
      source: "/host/cache",
      realization: "passthrough",
      createHostPath: true,
      excludes: ["generated"],
      includes: ["generated/source"],
      readOnly: true,
    });
    expect(mounts[1]).not.toHaveProperty("mountKey");
    expect(mounts[1]).not.toHaveProperty("role");
    expect(mounts[2]).toMatchObject({ type: "tmpfs", target: "/scratch", readOnly: false });
    expect(mounts[3]).toMatchObject({ type: "volume", store: "raw_vol", target: "/data/raw" });
    expect(mounts[4]).toMatchObject({
      type: "volume",
      store: "db_data",
      target: "/var/lib/db",
      subpath: "pg",
    });
    expect(migrated?.services[ServiceName.make("web")]).not.toHaveProperty("appMount");
    expect(migrated?.services[ServiceName.make("web")]).not.toHaveProperty("storage");
  });

  test("passthrough appMount does not receive a mountKey", () => {
    const raw = {
      ...v1PlanBase,
      services: {
        web: {
          ...v1ServiceBase,
          appMount: {
            source: "/tmp/lando-values",
            target: "/app",
            readOnly: false,
            realization: "passthrough",
            excludes: [],
            includes: [],
          },
        },
      },
    };
    const migrated = migrateAppliedPlan(raw, 1);
    const app = migrated?.services[ServiceName.make("web")]?.mounts[0];
    expect(app).toMatchObject({ type: "bind", role: "app", realization: "passthrough" });
    expect(app).not.toHaveProperty("mountKey");
  });

  test("fail-closes accelerated non-app binds instead of inventing index mountKeys", () => {
    const raw = {
      ...v1PlanBase,
      services: {
        web: {
          ...v1ServiceBase,
          mounts: [
            {
              type: "bind",
              source: "/host/extra",
              target: "/extra",
              readOnly: false,
              realization: "accelerated",
            },
          ],
        },
      },
    };
    expect(migrateAppliedPlan(raw, 1)).toBeNull();
  });

  test("fail-closes unknown versions and unconvertible shapes", () => {
    expect(migrateAppliedPlan(v1PlanBase, 99)).toBeNull();
    expect(migrateAppliedPlan(null, 1)).toBeNull();
    expect(migrateAppliedPlan({ ...v1PlanBase, services: "nope" }, 1)).toBeNull();
    expect(
      migrateAppliedPlan(
        {
          ...v1PlanBase,
          services: {
            web: {
              ...v1ServiceBase,
              mounts: [{ type: "volume", target: "/x", readOnly: false }],
            },
          },
        },
        1,
      ),
    ).toBeNull();
    expect(
      migrateAppliedPlan(
        {
          ...v1PlanBase,
          services: {
            web: {
              ...v1ServiceBase,
              storage: [" /app/vendor "],
            },
          },
        },
        1,
      ),
    ).toBeNull();
  });

  test("record migration keeps convertible plans when one plan cannot convert", () => {
    const migrated = migrateAppliedPlansRecord(
      {
        values: v1PlanBase,
        bad: {
          ...v1PlanBase,
          id: "bad",
          services: {
            web: {
              ...v1ServiceBase,
              mounts: [
                { type: "bind", source: "/x", target: "/x", readOnly: false, realization: "accelerated" },
              ],
            },
          },
        },
      },
      1,
    );
    expect(Object.keys(migrated ?? {})).toEqual(["values"]);
    expect(migrated?.values?.id).toBe(AppId.make("values"));
  });

  test("moves legacy Compose tmpfs knobs into tmpfs mounts", () => {
    const migrated = migrateAppliedPlan(
      {
        ...v1PlanBase,
        services: {
          web: {
            ...v1ServiceBase,
            extensions: {
              compose: {
                restart: "always",
                tmpfs: ["/run:size=64m,ro", { target: "/cache", size: 1024, mode: 1023 }],
              },
            },
          },
        },
      },
      1,
    );
    const web = migrated?.services[ServiceName.make("web")];
    expect(web?.extensions).toEqual({ compose: { restart: "always" } });
    expect(Schema.encodeSync(Schema.Array(MountPlan))(web?.mounts ?? [])).toEqual([
      { type: "tmpfs", target: "/cache", readOnly: false, options: "size=1024,mode=1777" },
      { type: "tmpfs", target: "/run", readOnly: true, options: "size=64m" },
    ]);
  });
});

describe("applied plan records", () => {
  const plan: AppPlan = {
    id: AppId.make("hooked"),
    name: "hooked",
    slug: "hooked",
    root: AbsolutePath.make("/tmp/hooked"),
    provider: ProviderId.make("lando"),
    services: {
      [service.name]: {
        ...currentService,
        name: service.name,
        serviceTypeId: "derived-web",
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    events: { "pre-stop": [{ step: "echo bye", source: "project", sourceIndex: 0, status: "active" }] },
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"), source: ".lando.yml", runtime: 4 },
    extensions: {},
  };
  const { events: _events, ...record } = plan;
  const writingStateStore = (written: unknown[]): PluginStateStore => ({
    open: <A, I>(_spec: PluginStateBucketSpec<A, I>): Effect.Effect<StateBucket<A>, StateStoreError> =>
      Effect.succeed({
        path: AbsolutePath.make("/tmp/plugin-state/applied-plans.json"),
        get: Effect.succeed(null),
        set: (value: A) =>
          Effect.sync(() => {
            written.push(value);
          }),
        update: () => Effect.die("not used"),
        modify: <B>(f: (cur: A | null) => readonly [B, A]) =>
          Effect.sync(() => {
            const [result, next] = f(null);
            written.push(next);
            return result;
          }),
        remove: Effect.void,
        exists: Effect.succeed(false),
      }),
    withLock: (_key, body) => body,
  });

  test.each(["per-app", "record"] as const)(
    "%s direct persistence applies the injected private annotation projection",
    async (layout) => {
      const written: unknown[] = [];
      const annotated = {
        ...plan,
        extensions: { retainedTooling: { task: "cleanup" }, eventSites: ["stale"] },
      };
      const store =
        layout === "per-app"
          ? makeAppliedPlanStore({ providerId: "lando", layout })
          : makeAppliedPlanStore({ providerId: "podman", layout });
      await Effect.runPromise(
        store.persistAppliedPlan(writingStateStore(written), annotated).pipe(
          Effect.provideService(AppPlanSanitizer, {
            sanitizeForPersistence: (input) => {
              const { eventSites: _sites, ...extensions } = input.extensions;
              return { ...input, extensions };
            },
          }),
        ),
      );
      const expected = { ...record, extensions: { retainedTooling: { task: "cleanup" } } };
      expect(written).toEqual([layout === "per-app" ? expected : { [plan.id]: expected }]);
    },
  );

  test("the per-app layout persists the plan without its Landofile events", async () => {
    const written: unknown[] = [];
    const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });

    await Effect.runPromise(store.persistAppliedPlan(writingStateStore(written), plan));

    expect(written).toEqual([record]);
  });

  test("the record layout persists the plan without its Landofile events", async () => {
    const written: unknown[] = [];
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    await Effect.runPromise(store.persistAppliedPlan(writingStateStore(written), plan));

    expect(written).toEqual([{ [plan.id]: record }]);
  });
});
