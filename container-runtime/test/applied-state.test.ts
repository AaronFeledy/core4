import { describe, expect, test } from "bun:test";
import {
  APPLIED_STATE_VERSION,
  appliedPlanPath,
  appliedPlansDir,
  makeAppliedPlanStore,
  migrateAppliedPlan,
} from "@lando/container-runtime/applied-state";
import type { StateStoreError } from "@lando/sdk/errors";
import type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  AppliedAppPlan,
  MountPlan,
  ProviderId,
  ServiceName,
  planAppIdentity,
} from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";
import { AppliedPlan, AppliedPlans } from "../src/applied-state-codec.ts";
import {
  migrateAppliedPlanWithCoordinate,
  migrateAppliedPlansRecordWithCoordinate,
} from "../src/applied-state-migrate.ts";
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
  test("reads a v11 service plan without inventing a planned port", () => {
    const encoded = Schema.encodeSync(AppPlan)(legacyPlan());
    const service = Object.values(encoded.services)[0];
    if (service === undefined) throw new Error("The historical plan fixture must contain a service.");
    const migrated = migrateAppliedPlan(encoded, 11)?.services[ServiceName.make(service.name)];
    expect(migrated).toBeDefined();
    expect(migrated?.plannedPort).toBeUndefined();
  });
  test("v10 historical events cannot block recovery of the realized plan", () => {
    const plan = legacyPlan();
    const raw = {
      ...Schema.encodeSync(AppPlan)(plan),
      events: {
        "pre-stop": [
          { step: { cmd: "true", env: { "": "old" } }, source: "project", sourceIndex: 0, status: "active" },
        ],
      },
    };
    const migrated = migrateAppliedPlan(raw, 10);
    expect(migrated).toMatchObject({ id: plan.id, services: plan.services });
    expect(migrated).not.toHaveProperty("events");
  });
  test("reads v8 application listener authority without inventing keep-alive intent", () => {
    const encoded = Schema.encodeSync(AppPlan)(legacyPlan());
    const service = Object.values(encoded.services)[0];
    if (service === undefined) throw new Error("The historical plan fixture must contain a service.");
    const listenerAuthority = {
      owner: "application",
      daemon: "Node.js",
      port: 3000,
      variables: ["PORT"],
    } as const;
    const raw = { ...encoded, services: { [service.name]: { ...service, listenerAuthority } } };
    expect(migrateAppliedPlan(raw, 8)?.services[ServiceName.make(service.name)]?.listenerAuthority).toEqual(
      listenerAuthority,
    );
  });
  for (const layout of ["per-app", "record"] as const) {
    test.each([true, false, undefined, "off"])(
      `${layout} migrates v2 init %s without changing ownership`,
      async (init) => {
        // Given
        const plan = { ...legacyPlan(), services: { [currentService.name]: currentService } };
        const encoded = Schema.encodeSync(AppPlan)(plan);
        const legacy = {
          ...encoded,
          services: {
            web: {
              ...encoded.services[currentService.name],
              extensions: { compose: { restart: "no", ...(init === undefined ? {} : { init }) } },
            },
          },
        };
        const raw: unknown = JSON.parse(
          JSON.stringify(layout === "per-app" ? legacy : { [plan.id]: legacy }),
        );
        const before = JSON.stringify(raw);
        const state: PluginStateStore = {
          open: (spec) =>
            Effect.succeed({
              path: AbsolutePath.make("/tmp/applied-init.json"),
              get: Effect.sync(() => {
                if (typeof spec.onVersionMismatch !== "function") throw new Error("missing migrator");
                return spec.onVersionMismatch(raw, 2);
              }),
              exists: Effect.succeed(true),
              set: () => Effect.die("unexpected write"),
              update: () => Effect.die("unexpected update"),
              mutate: () => Effect.die("this fixture does not support mutate"),
              transition: () => Effect.die("this fixture does not support transition"),
              modify: () => Effect.die("unexpected modify"),
              remove: Effect.die("unexpected delete"),
            }),
          withLock: (_key, body) => body,
        };
        const store =
          layout === "per-app"
            ? makeAppliedPlanStore({ providerId: "docker", layout })
            : makeAppliedPlanStore({ providerId: "podman", layout });
        // When
        const observed = await Effect.runPromise(store.loadAppliedPlanStrict(state, plan.id));
        // Then
        expect(observed?.services[currentService.name]?.init).toBe(init === "off" ? false : init);
        expect(observed?.services[currentService.name]?.extensions.compose).toEqual({ restart: "no" });
        if (observed === undefined) throw new Error("missing migrated plan");
        expect(planAppIdentity(observed)).toEqual(planAppIdentity(plan));
        expect(JSON.stringify(raw)).toBe(before);
      },
    );

    test(`${layout} refuses malformed historical init without modifying the source`, () => {
      // Given
      const raw = {
        ...v1PlanBase,
        services: { web: { ...v1ServiceBase, extensions: { compose: { init: "maybe" } } } },
      };
      const before = JSON.stringify(raw);
      // When
      const result =
        layout === "per-app"
          ? migrateAppliedPlanWithCoordinate(raw, 2)
          : migrateAppliedPlansRecordWithCoordinate({ values: raw }, 2);
      // Then
      expect(result).toBeTypeOf("string");
      expect(JSON.stringify(raw)).toBe(before);
    });
  }

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
            mutate: () => Effect.die("this fixture does not support mutate"),
            transition: () => Effect.die("this fixture does not support transition"),
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
      const observed = await Effect.runPromise(store.loadAppliedPlanStrict(state, current.id));
      // Then
      expect(observed?.id).toBe(current.id);
      expect(observed?.root).toBe(current.root);
      expect(observed?.services[service.name]?.environment).toEqual({ TOKEN: "${secret:TOKEN}" });
      expect(observed).not.toHaveProperty("valueModel");
      expect(observed).not.toHaveProperty("networks");
      expect(observed?.services[service.name]).not.toHaveProperty("environmentSecrets");
    },
  );

  test("per-app layout preserves the namespaced file format at the current version", async () => {
    const calls: OpenCall[] = [];
    const store = makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });
    const appId = AppId.make("example");

    await Effect.runPromiseExit(store.loadAppliedPlanStrict(recordingStateStore(calls), appId));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: "example.json",
      namespace: "applied-plans",
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "fail",
      hasDefault: false,
    });
    expect(calls[0]?.version).toBe(APPLIED_STATE_VERSION);
    expect(typeof calls[0]?.onVersionMismatch).toBe("function");
    expect(appliedPlansDir("/tmp/plugin-state/")).toBe("/tmp/plugin-state/applied-plans");
    expect(appliedPlanPath("/tmp/plugin-state", appId)).toBe("/tmp/plugin-state/applied-plans/example.json");
  });

  test("record layout preserves the single-file collection format at the current version", async () => {
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
      onCorrupt: "fail",
      hasDefault: false,
    });
    expect(calls[0]?.version).toBe(APPLIED_STATE_VERSION);
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

  test("record migration refuses the whole record when one plan cannot convert", () => {
    const migrated = migrateAppliedPlansRecordWithCoordinate(
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
    expect(migrated).toBeTypeOf("string");
    const values = migrateAppliedPlansRecordWithCoordinate({ values: v1PlanBase }, 1);
    expect(typeof values === "string" ? values : values.values?.id).toBe(AppId.make("values"));
  });

  test("moves legacy Compose config grants into read-only bind mounts", () => {
    const legacy = (grants: unknown) => ({
      ...v1PlanBase,
      extensions: { compose: { configs: { phpini: { file: "./php.ini" } } } },
      services: { web: { ...v1ServiceBase, extensions: { compose: { configs: grants } } } },
    });
    const migrated = migrateAppliedPlan(
      legacy([
        { source: "phpini", target: "/etc/php.ini", mode: "0444" },
        { source: "phpini", target: "/etc/b.ini" },
      ]),
      1,
    );
    const web = migrated?.services[ServiceName.make("web")];
    expect(Schema.encodeSync(Schema.Array(MountPlan))(web?.mounts ?? [])).toEqual([
      {
        type: "bind",
        source: "/tmp/lando-values/php.ini",
        target: "/etc/b.ini",
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: "/tmp/lando-values/php.ini",
        target: "/etc/php.ini",
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
        fileMode: 0o444,
      },
    ]);
    expect(migrateAppliedPlan(legacy([{ source: "missing", target: "/etc/x.ini" }]), 1)).toBeNull();
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

  test.each(["per-app", "record"] as const)("reads legitimate v11 %s writer bytes", (layout) => {
    const historicalWriterValue = Schema.encodeSync(AppPlan)(record);
    const bytes = JSON.stringify(
      layout === "per-app" ? historicalWriterValue : { [plan.id]: historicalWriterValue },
    );
    const raw: unknown = JSON.parse(bytes);
    const decoded =
      layout === "per-app"
        ? Schema.decodeUnknownSync(AppliedPlan)(raw)
        : Schema.decodeUnknownSync(AppliedPlans)(raw)[plan.id];
    expect(APPLIED_STATE_VERSION).toBe(12);
    expect(decoded).toEqual(Schema.decodeUnknownSync(AppliedAppPlan)(historicalWriterValue));
    expect(decoded).toEqual(record);
  });
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
        mutate: () => Effect.die("this fixture does not support mutate"),
        transition: () => Effect.die("this fixture does not support transition"),
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

  test.each(["per-app", "record"] as const)(
    "%s persistence retains committed digests when removing events without an injected sanitizer",
    async (layout) => {
      const written: unknown[] = [];
      const annotated = {
        ...plan,
        services: {
          [service.name]: {
            ...currentService,
            name: service.name,
            environment: { API_TOKEN: "private-token" },
          },
        },
        committedLiteralDigests: ["a".repeat(64), "b".repeat(64)],
      };
      const store =
        layout === "per-app"
          ? makeAppliedPlanStore({ providerId: "lando", layout: "per-app" })
          : makeAppliedPlanStore({ providerId: "lando", layout: "record" });
      await Effect.runPromise(store.persistAppliedPlan(writingStateStore(written), annotated));
      const { events: _events, ...expected } = annotated;
      expect(written).toEqual([layout === "per-app" ? expected : { [plan.id]: expected }]);
    },
  );

  test("the record layout persists the plan without its Landofile events", async () => {
    const written: unknown[] = [];
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    await Effect.runPromise(store.persistAppliedPlan(writingStateStore(written), plan));

    expect(written).toEqual([{ [plan.id]: record }]);
  });
});

test("reads a historical both route and absent backend TLS intent", () => {
  // Given: applied state written before per-scheme plans and managed backend TLS.
  const encoded = Schema.encodeSync(AppPlan)(legacyPlan());
  const historical = {
    ...encoded,
    routes: [
      {
        priority: 2,
        hostname: "web.lndo.site",
        scheme: "both",
        service: "web",
        backend: { service: "web", protocol: "http", port: 80 },
      },
    ],
    services: {
      web: {
        ...encoded.services.web,
        routes: [{ index: 0 }],
      },
    },
  };
  // When
  const decoded = Schema.decodeUnknownSync(AppPlan)(historical);
  // Then: the old shape stays readable and gains no invented TLS listener.
  expect(decoded.routes[0]).toMatchObject({ scheme: "both", backend: { port: 80 } });
  expect(decoded.routes[0]?.backend.tls).toBeUndefined();
  expect(decoded.services[ServiceName.make("web")]?.routes).toEqual([{ index: 0 }]);
});
